const { pool } = require('../models/db');
const GBMSignalEngine = require('./GBMSignalEngine');
const BinanceFeed = require('./BinanceFeed');
const ChainlinkFeed = require('./ChainlinkFeed');
const PolymarketFeed = require('./PolymarketFeed');
const EVEngine = require('./EVEngine');
const { decrypt } = require('../services/encryption');

class BotInstance {
  constructor(userId, settings) {
    this.userId = userId;
    this.settings = settings;
    this.isRunning = false;
    this.loopInterval = null;

    // Data feeds
    this.binance = new BinanceFeed();
    this.chainlink = new ChainlinkFeed();
    this.polymarket = null;
    this.signalEngine = null;
    this.evEngine = new EVEngine();

    // Paper trading
    this.paperBalance = parseFloat(settings.paper_balance) || 1000;

    // Risk management
    this.peakBalance = this.settings.paper_trading ? this.paperBalance : null;
    this.drawdownCooldownUntil = null;

    // Flip tracking (EV-driven, not cooldown-driven)
    this.recentFlips = []; // timestamps of recent flips
    this.flipEVEscalation = 0; // increases required EV differential after rapid flips

    // Slippage tracking
    this.slippageHistory = []; // { expected, actual, difference, timestamp }

    // Logs
    this.decisionLog = [];
    this.maxLogEntries = 100;
  }

  async start() {
    if (this.isRunning) {
      this._log('WARN', 'Bot already running');
      return;
    }

    try {
      this._log('INFO', `Starting bot for user ${this.userId}...`);

      // Initialize Polymarket feed
      let privateKey = null;
      if (this.settings.encrypted_private_key) {
        privateKey = decrypt(this.settings.encrypted_private_key);
      }
      this.polymarket = new PolymarketFeed(privateKey, this.settings.polymarket_wallet_address);
      await this.polymarket.initialize();

      // Connect data feeds
      await this.binance.connect();
      await this.chainlink.start(30000);

      // Wait for initial price
      await this._waitForPrice(15000);

      // Initialize signal engine
      this.signalEngine = new GBMSignalEngine(
        this.polymarket,
        this.binance,
        this.chainlink,
        this.settings
      );

      this.isRunning = true;

      // Main loop — NOT high-frequency, appropriate for prediction market strategy
      const intervalMs = (this.settings.snipe_timer_seconds || 10) * 1000;
      this.loopInterval = setInterval(() => this._mainLoop(), intervalMs);

      this._log('INFO', `✅ Bot started. Interval: ${intervalMs / 1000}s, Paper: ${this.settings.paper_trading}`);

      await pool.query('UPDATE bot_settings SET is_active = true WHERE user_id = $1', [this.userId]);

    } catch (err) {
      this._log('ERROR', `Failed to start bot: ${err.message}`);
      await this.stop();
      throw err;
    }
  }

  async stop() {
    this._log('INFO', 'Stopping bot...');
    this.isRunning = false;

    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }

    if (this.binance) this.binance.disconnect();
    if (this.chainlink) this.chainlink.stop();

    try {
      await pool.query('UPDATE bot_settings SET is_active = false WHERE user_id = $1', [this.userId]);
    } catch (err) {
      console.error(`[Bot ${this.userId}] DB update failed on stop:`, err.message);
    }

    this._log('INFO', '🛑 Bot stopped');
  }

  async _mainLoop() {
    if (!this.isRunning) return;

    try {
      // --- Risk checks ---
      const canTrade = await this._checkDrawdownCircuitBreaker();
      if (!canTrade) return;

      const dailyLimitHit = await this._checkDailyLossLimit();
      if (dailyLimitHit) return;

      // --- Manage open positions (EV-based exits + flips) ---
      await this._manageOpenPositions();

      // --- Evaluate new signals ---
      const signal = await this.signalEngine.evaluate();
      await this._logSignal(signal);

      if (signal.verdict !== 'TRADE') return;

      // --- Check if we should flip an existing position ---
      const flipped = await this._checkForFlip(signal);
      if (flipped) return; // Flip handled, don't open new position

      // --- Open new position ---
      await this._executeTrade(signal);

    } catch (err) {
      this._log('ERROR', `Main loop error: ${err.message}`);
    }
  }

  // ==========================================
  // EV-DRIVEN FLIP LOGIC
  // ==========================================

  async _checkForFlip(newSignal) {
    try {
      // Find open position in the same market
      const result = await pool.query(
        "SELECT * FROM trades WHERE user_id = $1 AND status = $2 AND market_id = $3",
        [this.userId, 'open', newSignal.marketId]
      );

      if (result.rows.length === 0) return false; // No existing position

      const existingTrade = result.rows[0];
      const currentDirection = existingTrade.direction;

      // If signal says same direction, no flip needed
      if (newSignal.direction === currentDirection) return false;

      // EV-driven flip evaluation
      const flipThreshold = this._getFlipThreshold();
      const currentEV = currentDirection === 'YES' ? newSignal.evYes : newSignal.evNo;
      const oppositeEV = newSignal.evAdj; // Best EV (which is the opposite direction)

      const evGain = oppositeEV - currentEV;

      this._log('INFO', `🔄 Flip evaluation: ${currentDirection} EV=${currentEV.toFixed(2)}%, ${newSignal.direction} EV=${oppositeEV.toFixed(2)}%, gain=${evGain.toFixed(2)}%, threshold=${flipThreshold.toFixed(2)}%`);

      // Flip condition: current position EV < 0 AND opposite is better by threshold
      if (currentEV < 0 && evGain > flipThreshold) {
        this._log('INFO', `✅ EV-driven flip: ${currentDirection} → ${newSignal.direction} (EV gain: +${evGain.toFixed(2)}%)`);

        // Close existing position
        const livePrice = await this.polymarket.getLiveTokenPrice(existingTrade.token_id);
        await this._closePosition(existingTrade, livePrice || parseFloat(existingTrade.entry_price), 'EV_FLIP');

        // Record flip
        this.recentFlips.push(Date.now());
        this._cleanOldFlips();

        // Open opposite position
        await this._executeTrade(newSignal);
        return true;
      }

      return false;

    } catch (err) {
      this._log('ERROR', `Flip check error: ${err.message}`);
      return false;
    }
  }

  /**
   * Dynamic flip threshold — increases if flipping too rapidly
   * This is secondary to EV logic, not the primary guard
   */
  _getFlipThreshold() {
    this._cleanOldFlips();
    const recentFlipCount = this.recentFlips.length;

    // Base threshold: 2% EV differential required
    // Escalation: +1% per recent flip (last 10 minutes)
    const baseThreshold = 2.0;
    const escalation = recentFlipCount * 1.0;

    return baseThreshold + escalation;
  }

  _cleanOldFlips() {
    const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
    this.recentFlips = this.recentFlips.filter(t => t > tenMinutesAgo);
  }

  // ==========================================
  // TRADE EXECUTION
  // ==========================================

  async _executeTrade(signal) {
    const { direction, entryPrice, tokenId, market, confidence, evAdj, modelProb, marketId } = signal;

    // --- Kelly Criterion with MODEL probability ---
    const mProb = modelProb || Math.min(0.99, Math.max(0.01, entryPrice + 0.03));
    const b = (1 / entryPrice) - 1;
    let kellyFraction = b > 0 ? Math.max(0, (mProb * b - (1 - mProb)) / b) : 0;

    // Apply Kelly cap
    const kellyCap = parseFloat(this.settings.kelly_cap) || 0.10;
    kellyFraction = Math.min(kellyFraction, kellyCap);

    if (kellyFraction <= 0) {
      this._log('WARN', `Kelly fraction is 0 (modelProb=${mProb.toFixed(3)}, entry=${entryPrice.toFixed(3)}). No edge.`);
      return;
    }

    // Calculate trade size
    const balance = this.settings.paper_trading ? this.paperBalance : await this._getLiveBalance();
    const tradeSize = Math.max(1, parseFloat((balance * kellyFraction).toFixed(2)));

    // --- Paper balance check ---
    if (this.settings.paper_trading && this.paperBalance < tradeSize) {
      this._log('WARN', `Insufficient paper balance: $${this.paperBalance.toFixed(2)} < $${tradeSize.toFixed(2)}`);
      return;
    }

    this._log('INFO', `📊 Signal: ${direction} on "${market.question}"`);
    this._log('INFO', `   Entry: ${entryPrice.toFixed(4)}, Size: $${tradeSize.toFixed(2)}, Kelly: ${(kellyFraction * 100).toFixed(1)}%, EV_adj: ${evAdj.toFixed(2)}%, Model: ${mProb.toFixed(3)}`);

    // --- Execute ---
    const expectedPrice = entryPrice;

    if (this.settings.paper_trading) {
      this.paperBalance -= tradeSize;
      await pool.query('UPDATE bot_settings SET paper_balance = $1 WHERE user_id = $2', [this.paperBalance, this.userId]);

      await pool.query(`
        INSERT INTO trades (user_id, market_id, market_question, token_id, direction, entry_price, trade_size, status, trade_type, signal_confidence, ev_adj, gate1_score, gate2_score, gate3_score)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', 'signal', $8, $9, $10, $11, $12)
      `, [
        this.userId, marketId, market.question, tokenId, direction,
        entryPrice, tradeSize, confidence, evAdj,
        signal.log?.gates?.gate1?.confidence || 0,
        signal.log?.gates?.gate2?.bestEV || 0,
        signal.log?.gates?.gate3?.emaEdge || 0
      ]);

      // Track slippage (paper = no slippage, but record for consistency)
      this._recordSlippage(expectedPrice, entryPrice);

      this._log('INFO', `📝 Paper trade recorded. Balance: $${this.paperBalance.toFixed(2)}`);

    } else {
      try {
        const order = await this.polymarket.placeOrder(tokenId, 'BUY', tradeSize, entryPrice);
        const actualFillPrice = order?.averagePrice || entryPrice;

        await pool.query(`
          INSERT INTO trades (user_id, market_id, market_question, token_id, direction, entry_price, trade_size, status, trade_type, signal_confidence, ev_adj, gate1_score, gate2_score, gate3_score)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', 'signal', $8, $9, $10, $11, $12)
        `, [
          this.userId, marketId, market.question, tokenId, direction,
          actualFillPrice, tradeSize, confidence, evAdj,
          signal.log?.gates?.gate1?.confidence || 0,
          signal.log?.gates?.gate2?.bestEV || 0,
          signal.log?.gates?.gate3?.emaEdge || 0
        ]);

        // Track slippage
        this._recordSlippage(expectedPrice, actualFillPrice);

        this._log('INFO', `🔥 LIVE trade executed. Slippage: ${((actualFillPrice - expectedPrice) * 100).toFixed(3)}%`);
      } catch (err) {
        this._log('ERROR', `Live trade failed: ${err.message}`);
        return;
      }
    }
  }

  // ==========================================
  // POSITION MANAGEMENT — EV-BASED EXITS
  // ==========================================

  async _manageOpenPositions() {
    try {
      const result = await pool.query(
        "SELECT * FROM trades WHERE user_id = $1 AND status = $2",
        [this.userId, 'open']
      );

      if (result.rows.length === 0) return;

      let consecutivePriceFailures = 0;
      const MAX_PRICE_FAILURES = 5;

      for (const trade of result.rows) {
        // Skip legacy trades that pre-date the token_id column — can't fetch price without it
        if (!trade.token_id) {
          this._log('WARN', `Skipping trade ${trade.id} — no token_id (pre-migration row)`);
          continue;
        }

        const livePrice = await this.polymarket.getLiveTokenPrice(trade.token_id);

        if (!livePrice) {
          consecutivePriceFailures++;
          this._log('WARN', `Price fetch failed for ${trade.token_id} (${consecutivePriceFailures}/${MAX_PRICE_FAILURES})`);

          if (consecutivePriceFailures >= MAX_PRICE_FAILURES) {
            this._log('CRITICAL', `🛑 Emergency close: ${MAX_PRICE_FAILURES} consecutive price failures`);
            await this._closePosition(trade, parseFloat(trade.entry_price), 'EMERGENCY_PRICE_FEED_DOWN');
          }
          continue;
        }

        consecutivePriceFailures = 0;

        const entryPrice = parseFloat(trade.entry_price);
        const marketId = trade.market_id;

        // --- EV-based exit ---
        // Recalculate current EV for this position
        const btcPrice = this.binance.getPrice();
        if (!btcPrice) continue;

        const micro = this.signalEngine?.microEngine;
        const currentModelProb = livePrice + (micro?.detectLatency() || 0) * 0.05;
        const clampedProb = Math.min(0.99, Math.max(0.01, currentModelProb));

        const currentEV = this.evEngine.calculateAdjustedEV(
          clampedProb, livePrice,
          trade.direction,
          { spread: 0.01, estimatedSlippage: 0.005, fees: 0.002 }
        );

        // Record EV for trend tracking
        this.evEngine.recordEV(marketId, currentEV, trade.direction);

        // EXIT CONDITION 1: EV decayed to < 50% of peak
        if (this.evEngine.shouldExitOnEVDecay(marketId, currentEV, 0.5)) {
          const peakEV = this.evEngine.evPeaks[marketId]?.ev || 0;
          this._log('INFO', `🎯 EV-based exit: current EV ${currentEV.toFixed(2)}% < 50% of peak ${peakEV.toFixed(2)}%`);
          await this._closePosition(trade, livePrice, 'EV_DECAY_EXIT');
          this.evEngine.clearMarket(marketId);
          continue;
        }

        // EXIT CONDITION 2: Hard stop-loss (safety net, not primary)
        const pnlPct = trade.direction === 'YES'
          ? ((livePrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - livePrice) / entryPrice) * 100;

        if (pnlPct <= -15) { // 15% hard stop as safety net
          this._log('WARN', `🛑 Hard stop-loss: PnL ${pnlPct.toFixed(1)}%`);
          await this._closePosition(trade, livePrice, 'HARD_STOP_LOSS');
          this.evEngine.clearMarket(marketId);
          continue;
        }

        // EXIT CONDITION 3: Position EV is deeply negative (no flip available)
        if (currentEV < -5) {
          this._log('WARN', `📉 Negative EV exit: ${currentEV.toFixed(2)}% — edge is gone`);
          await this._closePosition(trade, livePrice, 'NEGATIVE_EV_EXIT');
          this.evEngine.clearMarket(marketId);
          continue;
        }
      }
    } catch (err) {
      this._log('ERROR', `Position management error: ${err.message}`);
    }
  }

  async _closePosition(trade, exitPrice, reason) {
    try {
      const entryPrice = parseFloat(trade.entry_price);
      const tradeSize = parseFloat(trade.trade_size);
      const effectiveExit = exitPrice || entryPrice;

      const pnl = trade.direction === 'YES'
        ? (effectiveExit - entryPrice) * tradeSize / entryPrice
        : (entryPrice - effectiveExit) * tradeSize / entryPrice;

      const result = pnl > 0 ? 'WIN' : 'LOSS';
      await pool.query(`
        UPDATE trades SET status = 'closed', exit_price = $1, pnl = $2, close_reason = $3, result = $4, closed_at = NOW()
        WHERE id = $5
      `, [effectiveExit, pnl, reason, result, trade.id]);

      if (this.settings.paper_trading) {
        this.paperBalance += tradeSize + pnl;
        await pool.query('UPDATE bot_settings SET paper_balance = $1 WHERE user_id = $2', [this.paperBalance, this.userId]);
      }

      this._log('INFO', `Position ${trade.id} closed: ${reason}, PnL: $${pnl.toFixed(2)} (${((pnl / tradeSize) * 100).toFixed(1)}%)`);
    } catch (err) {
      this._log('ERROR', `Close position failed: ${err.message}`);
    }
  }

  // ==========================================
  // SLIPPAGE TRACKING
  // ==========================================

  _recordSlippage(expectedPrice, actualPrice) {
    const slippage = {
      expected: expectedPrice,
      actual: actualPrice,
      difference: actualPrice - expectedPrice,
      pct: ((actualPrice - expectedPrice) / expectedPrice) * 100,
      timestamp: Date.now()
    };

    this.slippageHistory.push(slippage);

    // Keep last 100 entries
    if (this.slippageHistory.length > 100) {
      this.slippageHistory.shift();
    }
  }

  getAverageSlippage() {
    if (this.slippageHistory.length === 0) return 0;
    const sum = this.slippageHistory.reduce((acc, s) => acc + Math.abs(s.pct), 0);
    return sum / this.slippageHistory.length;
  }

  // ==========================================
  // RISK MANAGEMENT
  // ==========================================

  async _checkDrawdownCircuitBreaker() {
    if (this.drawdownCooldownUntil && Date.now() < this.drawdownCooldownUntil) {
      const remaining = Math.ceil((this.drawdownCooldownUntil - Date.now()) / 60000);
      this._log('WARN', `Drawdown cooldown: ${remaining}min remaining`);
      return false;
    }

    if (this.drawdownCooldownUntil && Date.now() >= this.drawdownCooldownUntil) {
      this.drawdownCooldownUntil = null;
      this._log('INFO', 'Drawdown cooldown expired. Resuming.');
    }

    const currentBalance = this.settings.paper_trading ? this.paperBalance : await this._getLiveBalance();

    if (this.peakBalance === null || currentBalance > this.peakBalance) {
      this.peakBalance = currentBalance;
    }

    if (this.peakBalance > 0) {
      const drawdownPct = ((this.peakBalance - currentBalance) / this.peakBalance) * 100;
      const maxDrawdownPct = parseFloat(this.settings.max_drawdown_pct) || 15;

      if (drawdownPct >= maxDrawdownPct) {
        this._log('CRITICAL', `🛑 DRAWDOWN BREAKER: ${drawdownPct.toFixed(1)}% >= ${maxDrawdownPct}%. 1hr cooldown.`);
        this.drawdownCooldownUntil = Date.now() + (60 * 60 * 1000);
        return false;
      }
    }

    return true;
  }

  async _checkDailyLossLimit() {
    try {
      const maxDailyLoss = parseFloat(this.settings.max_daily_loss) || 50;
      const result = await pool.query(`
        SELECT COALESCE(SUM(pnl), 0) AS daily_pnl
        FROM trades WHERE user_id = $1 AND status = $2 AND closed_at > NOW() - INTERVAL '24 hours'
      `, [this.userId, 'closed']);

      const dailyPnl = parseFloat(result.rows[0].daily_pnl);

      if (dailyPnl <= -Math.abs(maxDailyLoss)) {
        this._log('WARN', `Daily loss limit: $${dailyPnl.toFixed(2)} <= -$${maxDailyLoss.toFixed(2)}`);
        return true;
      }
      return false;
    } catch (err) {
      this._log('ERROR', `Daily loss check failed: ${err.message}`);
      return false;
    }
  }

  async _getLiveBalance() {
    try {
      if (this.settings.encrypted_private_key && this.settings.polymarket_wallet_address) {
        const pk = decrypt(this.settings.encrypted_private_key);
        const data = await PolymarketFeed.fetchBalance(pk, this.settings.polymarket_wallet_address);
        return data.usdc || 0;
      }
    } catch (err) {
      this._log('ERROR', `Live balance fetch failed: ${err.message}`);
    }
    return 0;
  }

  // ==========================================
  // HELPERS
  // ==========================================

  async _waitForPrice(timeoutMs) {
    const start = Date.now();
    while (!this.binance.getPrice()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timed out waiting for BTC price');
      }
      await new Promise(r => setTimeout(r, 500));
    }
    this._log('INFO', `BTC price: $${this.binance.getPrice().toLocaleString()}`);
  }

  _log(level, message) {
    const entry = { timestamp: new Date().toISOString(), level, message, userId: this.userId };
    console.log(`[Bot ${this.userId}] [${level}] ${message}`);
    this.decisionLog.push(entry);
    if (this.decisionLog.length > this.maxLogEntries) this.decisionLog.shift();
  }

  async _logSignal(signal) {
    try {
      if (!signal?.log) return;
      // Derive gate_failed code from which gate blocked execution
      let gateFailed = null;
      const gates = signal.log?.gates || {};
      if (signal.verdict === 'SKIP') {
        if (gates.freshness && !gates.freshness.passed)  gateFailed = 0.2;
        else if (gates.chase && !gates.chase.passed)     gateFailed = 0.3;
        else if (gates.evTrend && !gates.evTrend.passed) gateFailed = 0.4;
        else if (gates.gate1 && !gates.gate1.passed)     gateFailed = 1;
        else if (gates.gate2 && !gates.gate2.passed)     gateFailed = 2;
        else if (gates.gate3 && !gates.gate3.passed)     gateFailed = 3;
      }

      await pool.query(`
        INSERT INTO signals (user_id, market_id, market_question, verdict, reason, direction, confidence, ev_raw, ev_adj, ema_edge, gate1_passed, gate2_passed, gate3_passed, gate_failed, lag_age_sec, spread_pct)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `, [
        this.userId,
        signal.market?.id || signal.marketId || null,
        signal.market?.question || null,
        signal.verdict,
        signal.log?.reason || '',
        signal.direction || null,
        signal.confidence || null,
        signal.evRaw || null,
        signal.evAdj || null,
        signal.emaEdge || null,
        gates.gate1?.passed || false,
        gates.gate2?.passed || false,
        gates.gate3?.passed || false,
        gateFailed,
        gates.freshness?.lagAge || null,
        signal.orderBook?.spread || null
      ]);
    } catch (err) {
      // Don't crash on signal logging failure
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      userId: this.userId,
      paperTrading: this.settings.paper_trading,
      paperBalance: this.paperBalance,
      peakBalance: this.peakBalance,
      btcPrice: this.binance?.getPrice() || null,
      chainlinkPrice: this.chainlink?.getPrice() || null,
      flipCount: this.recentFlips.length,
      avgSlippage: this.getAverageSlippage(),
      drawdownCooldownUntil: this.drawdownCooldownUntil,
      recentLogs: this.decisionLog.slice(-20)
    };
  }
}

module.exports = BotInstance;
