const { pool } = require('../models/db');
const { EventEmitter } = require('events');
const GBMSignalEngine = require('./GBMSignalEngine');
const BinanceFeed = require('./BinanceFeed');
const ChainlinkFeed = require('./ChainlinkFeed');
const PolymarketFeed = require('./PolymarketFeed');
const EVEngine = require('./EVEngine');
const { decrypt } = require('../services/encryption');
const axios = require('axios');

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

    // Pending orders — placed but not yet confirmed filled or cancelled
    // Map<orderId, { orderId, isPaper, tokenId, side, limitPrice, referencePrice,
    //                dollarSize, direction, market, signal, placedAt, lastCheckedPrice }>
    this._pendingOrders = new Map();

    // Logs
    this.decisionLog = [];
    this.maxLogEntries = 100;

    // Real-time streaming (SSE) — emits 'state' events every 200ms while running
    this.streamEmitter = new EventEmitter();
    this.streamEmitter.setMaxListeners(50); // allow many concurrent SSE clients
    this.streamInterval  = null;
    this._obFetchInterval = null; // 1s async loop that fetches YES/NO order books
    this._lastOrderBooks = {}; // tokenId -> { midPrice, spread, bidDepth, askDepth }
    // Last computed microstructure + EV data for broadcasting
    this._lastStreamState = {};
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
      const intervalMs = (this.settings.snipe_timer_seconds || 8) * 1000;
      this.loopInterval = setInterval(() => this._mainLoop(), intervalMs);

      // Real-time streaming loop — 200ms interval, non-blocking, for SSE clients
      this.streamInterval   = setInterval(() => this._broadcastState(), 200);
      // Order book fetcher — 1s async loop, populates YES/NO prices for stream
      this._obFetchInterval = setInterval(() => this._fetchActiveOrderBooks(), 1000);

      this._log('INFO', `✅ Bot started. Interval: ${intervalMs / 1000}s, Paper: ${this.settings.paper_trading}`);

      await pool.query('UPDATE bot_settings SET is_active = true WHERE user_id = $1', [this.userId]);

    } catch (err) {
      this._log('ERROR', `Failed to start bot: ${err.message}`);
      await this.stop();
      throw err;
    }
  }

  async stop(preserveActive = false) {
    this._log('INFO', 'Stopping bot...');
    this.isRunning = false;

    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
    if (this.streamInterval) {
      clearInterval(this.streamInterval);
      this.streamInterval = null;
    }
    if (this._obFetchInterval) {
      clearInterval(this._obFetchInterval);
      this._obFetchInterval = null;
    }

    if (this.binance) this.binance.disconnect();
    if (this.chainlink) this.chainlink.stop();

    // preserveActive=true on graceful shutdown so auto-restart works after deploy
    if (!preserveActive) {
      try {
        await pool.query('UPDATE bot_settings SET is_active = false WHERE user_id = $1', [this.userId]);
      } catch (err) {
        console.error(`[Bot ${this.userId}] DB update failed on stop:`, err.message);
      }
    }

    this._log('INFO', '🛑 Bot stopped');
  }

  async _mainLoop() {
    if (!this.isRunning) return;

    try {
      // --- Risk checks ---
      // Drawdown + daily loss cooldowns disabled for testing
      // const canTrade = await this._checkDrawdownCircuitBreaker();
      // if (!canTrade) return;
      // const dailyLimitHit = await this._checkDailyLossLimit();
      // if (dailyLimitHit) return;

      // --- Monitor pending orders (fill / cancel / adverse-selection) ---
      await this._monitorPendingOrders();

      // --- Manage open positions (EV-based exits + flips) ---
      await this._manageOpenPositions();

      // --- Evaluate new signals ---
      const signal = await this.signalEngine.evaluate();
      await this._logSignal(signal);

      if (signal.verdict !== 'TRADE') return;

      // --- Directional exposure check ---
      const overexposed = await this._checkDirectionalExposure(signal.direction);
      if (overexposed) return;

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

      // Minimum hold time — don't flip a position < 2 minutes old.
      // BTC oscillates ±0.03% naturally every 30s; without this, flips fire on noise.
      const holdTimeMin = (Date.now() - new Date(existingTrade.created_at).getTime()) / 60000;
      if (holdTimeMin < 2.0) {
        this._log('INFO', `⏳ Flip suppressed — position ${holdTimeMin.toFixed(1)}min old (min 2min to reduce noise flips)`);
        return false;
      }

      // EV-driven flip evaluation with hysteresis (prevents whipsaw)
      const flipThreshold = this._getFlipThreshold();
      const currentEV = currentDirection === 'YES' ? newSignal.evYes : newSignal.evNo;
      const oppositeEV = newSignal.evAdj;

      // Hysteresis: require 6% EV gain (up from 3%) — round-trip cost is ~1.4% so need real edge
      // BTC 30s oscillation creates 3-4% EV swings; 6% threshold filters out noise flips
      const FLIP_HYSTERESIS = 6.0;
      const evGain = oppositeEV - currentEV;

      this._log('INFO', `🔄 Flip evaluation: ${currentDirection} EV=${currentEV.toFixed(2)}%, ${newSignal.direction} EV=${oppositeEV.toFixed(2)}%, gain=${evGain.toFixed(2)}%, threshold=${flipThreshold.toFixed(2)}%`);

      // BTC confirmation: only flip if BTC momentum supports the new direction
      // emaEdge = btcDelta (30s window); prevents flipping against momentum
      const btcDelta = newSignal.emaEdge || 0;
      const btcSupportsFip = newSignal.direction === 'YES' ? btcDelta > 0 : btcDelta < 0;
      if (!btcSupportsFip) {
        this._log('INFO', `⛔ Flip rejected — BTC direction (${btcDelta.toFixed(3)}%) contradicts ${newSignal.direction}`);
        return false;
      }

      // Flip condition: opposite side has significantly better EV
      // Don't require currentEV < 0 — flip when edge clearly reversed
      if (evGain > flipThreshold && evGain > FLIP_HYSTERESIS) {
        this._log('INFO', `✅ EV-driven flip: ${currentDirection} → ${newSignal.direction} (EV gain: +${evGain.toFixed(2)}%)`);

        // Close existing position at live price — fall back to last cached book price, not entry
        const livePrice = await this.polymarket.getLiveTokenPrice(existingTrade.token_id)
          ?? this._lastOrderBooks[existingTrade.token_id]?.midPrice
          ?? parseFloat(existingTrade.entry_price);
        await this._closePosition(existingTrade, livePrice, 'EV_FLIP');

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
   * Directional exposure: prevent over-concentration in one direction
   * Max net directional position = 30% of balance
   */
  async _checkDirectionalExposure(newDirection) {
    try {
      const result = await pool.query(
        "SELECT direction, SUM(trade_size) as total FROM trades WHERE user_id=$1 AND status='open' GROUP BY direction",
        [this.userId]
      );
      const balance = this.settings.paper_trading ? this.paperBalance : await this._getLiveBalance();
      const maxNet = balance * 0.30;

      let yesExposure = 0, noExposure = 0;
      for (const row of result.rows) {
        if (row.direction === 'YES') yesExposure = parseFloat(row.total);
        else noExposure = parseFloat(row.total);
      }

      const netExposure = Math.abs(yesExposure - noExposure);
      const dominantDir = yesExposure >= noExposure ? 'YES' : 'NO';

      if (netExposure >= maxNet && newDirection === dominantDir) {
        this._log('WARN', `Directional exposure limit: net ${dominantDir} $${netExposure.toFixed(2)} >= $${maxNet.toFixed(2)} — skipping`);
        return true; // overexposed
      }
      return false;
    } catch (err) {
      return false; // don't block on error
    }
  }

  /**
   * Dynamic flip threshold — increases if flipping too rapidly
   * This is secondary to EV logic, not the primary guard
   */
  _getFlipThreshold() {
    this._cleanOldFlips();
    const recentFlipCount = this.recentFlips.length;

    // Base threshold: 5% EV differential required (was 2% — BTC oscillation creates 3-4% noise swings)
    // Escalation: +1% per recent flip (last 10 minutes)
    const baseThreshold = 5.0;
    const escalation = recentFlipCount * 1.0;

    return baseThreshold + escalation;
  }

  _cleanOldFlips() {
    const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
    this.recentFlips = this.recentFlips.filter(t => t > tenMinutesAgo);
  }

  // ==========================================
  // TRADE EXECUTION — ORDER LIFECYCLE
  //
  // Flow: signal → _executeTrade → _pendingOrders map
  //               → _monitorPendingOrders (every tick)
  //               → fill confirmed → _recordFilledTrade → trades DB
  //
  // Paper and live use the same code path. The only difference is:
  //   live: sends createAndPostOrder to Polymarket CLOB + polls getOrderStatus
  //   paper: synthesises a fill by checking whether market moved to our limit
  //
  // This ensures paper P&L is realistic — orders can and do go unfilled.
  // ==========================================

  async _executeTrade(signal) {
    const { direction, tokenId, market, confidence, evAdj, modelProb, marketId, fillProb } = signal;
    const TICK = 0.01;
    const ORDER_TIMEOUT_MS = 10000; // cancel if still resting after 10s

    // ── 1. Token ID safety check ──────────────────────────────────────────────
    if (!tokenId || tokenId === 'undefined' || tokenId === 'null') {
      this._log('WARN', `[SKIP] No valid tokenId for ${direction} trade — marketId=${marketId}`);
      return;
    }

    // ── 2. Prevent duplicate pending orders for the same token ───────────────
    const alreadyPending = [...this._pendingOrders.values()].some(o => o.tokenId === tokenId);
    if (alreadyPending) {
      this._log('INFO', `[SKIP] Pending order already exists for token ${tokenId?.slice(0,12)}... — skipping duplicate`);
      return;
    }

    // ── 3. Fetch lastTradePrice with freshness guarantee ─────────────────────
    // Fetched live — AbortSignal.timeout(4000) in getLastTradePrice ensures we
    // never use a stale cached value. If 404 (new market window, no trades yet),
    // fall back to Gamma outcomePrices which the signal engine already fetched.
    const priceFetchedAt = Date.now();
    let lastTradePrice = await this.polymarket.getLastTradePrice(tokenId);
    if (!lastTradePrice) {
      // Gamma fallback: new 5-min windows return 404 until the first trade clears.
      // signal.yesPrice is already sourced from Gamma outcomePrices[0/1].
      const gammaPrice = direction === 'YES'
        ? signal.yesPrice
        : (signal.yesPrice != null ? parseFloat((1 - signal.yesPrice).toFixed(4)) : null);
      if (gammaPrice && gammaPrice > 0.02 && gammaPrice < 0.98) {
        this._log('INFO', `[INFO] lastTradePrice 404 — using Gamma price ${gammaPrice.toFixed(4)} for ${tokenId?.slice(0,12)}...`);
        lastTradePrice = gammaPrice;
      } else {
        this._log('WARN', `[SKIP] No price source for ${tokenId?.slice(0,12)}... — lastTrade=404, Gamma unavailable`);
        return;
      }
    }

    // ── 4. Stale price guard ──────────────────────────────────────────────────
    // If the fetch itself took too long (network slow), the price may no longer
    // reflect the current market. Reject if the fetch took > 5s.
    const fetchLatencyMs = Date.now() - priceFetchedAt;
    if (fetchLatencyMs > 5000) {
      this._log('WARN', `[SKIP] Price fetch took ${fetchLatencyMs}ms — too slow, price may be stale`);
      return;
    }

    // ── 5. Tradeable range check ──────────────────────────────────────────────
    if (lastTradePrice <= 0.02 || lastTradePrice >= 0.98) {
      this._log('WARN', `[SKIP] lastTradePrice=${lastTradePrice.toFixed(4)} near resolution boundary`);
      return;
    }

    // ── 6. Kelly position sizing at lastTradePrice ────────────────────────────
    // Use lastTradePrice as the execution price for Kelly (not signal.entryPrice).
    // modelProb comes from GBM signal engine — for NO trades, flip to P(NO resolves).
    const mProb = direction === 'NO'
      ? Math.min(0.99, Math.max(0.01, 1 - (modelProb || lastTradePrice)))
      : Math.min(0.99, Math.max(0.01, modelProb || lastTradePrice));
    const b = (1 / lastTradePrice) - 1;
    let kellyFraction = b > 0 ? Math.max(0, (mProb * b - (1 - mProb)) / b) : 0;

    const kellyCap = parseFloat(this.settings.kelly_cap) || 0.25;
    kellyFraction = Math.min(kellyFraction, kellyCap);
    kellyFraction *= (fillProb || 1.0); // scale by expected fill probability from signal

    if (kellyFraction <= 0) {
      this._log('WARN', `[SKIP] Kelly=0 at lastTrade=${lastTradePrice.toFixed(4)}`);
      return;
    }

    const MAX_TRADE_DOLLARS = 5.00;
    const balance = this.settings.paper_trading ? this.paperBalance : await this._getLiveBalance();
    if (!balance || isNaN(balance) || balance <= 0) {
      this._log('WARN', `Invalid balance=${balance} — skipping`);
      return;
    }

    const tradeSize = Math.min(parseFloat((balance * kellyFraction).toFixed(2)), MAX_TRADE_DOLLARS);
    if (tradeSize < 1) {
      this._log('WARN', `[SKIP] Trade size $${tradeSize.toFixed(2)} < $1 minimum`);
      return;
    }
    if (this.settings.paper_trading && this.paperBalance < tradeSize) {
      this._log('WARN', `Insufficient paper balance $${this.paperBalance.toFixed(2)} < $${tradeSize.toFixed(2)}`);
      return;
    }

    // Limit price: 1 tick above lastTradePrice for buys (improves fill probability).
    // Snapped to tick grid. This is also the price we use for slippage tracking.
    const limitPrice = Math.min(0.99, parseFloat((Math.ceil(lastTradePrice / TICK) * TICK + TICK).toFixed(2)));

    this._log('INFO', `📊 ${direction} "${market.question?.slice(0,40)}" — ref=${lastTradePrice.toFixed(4)} limit=${limitPrice.toFixed(2)} size=$${tradeSize.toFixed(2)} kelly=${(kellyFraction*100).toFixed(1)}% EV=${evAdj.toFixed(2)}%`);

    // ── 7. Place order and add to pending map ─────────────────────────────────
    const pendingBase = {
      tokenId, side: 'BUY', limitPrice,
      referencePrice: lastTradePrice, // price when order was created — used for adverse-selection check
      dollarSize: tradeSize,
      direction, market, signal,
      placedAt: Date.now(),
      lastCheckedPrice: lastTradePrice
    };

    if (this.settings.paper_trading) {
      // Paper: create a synthetic order ID — no API call needed
      const paperId = `paper_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      this._pendingOrders.set(paperId, { ...pendingBase, orderId: paperId, isPaper: true });
      this._log('INFO', `📋 [PAPER] Order resting: ${direction} limit=${limitPrice.toFixed(2)} $${tradeSize.toFixed(2)} — fill check in next tick(s)`);

    } else {
      // Live: send to Polymarket CLOB
      try {
        const order = await this.polymarket.placeOrder(tokenId, 'BUY', tradeSize, lastTradePrice);
        const orderId = order?.orderID || order?.order_id || order?.id;
        if (!orderId) {
          this._log('WARN', `[LIVE] Order placed but no orderId returned — cannot monitor fill`);
          return;
        }
        this._pendingOrders.set(orderId, { ...pendingBase, orderId, isPaper: false, limitPrice: order.price || limitPrice });
        this._log('INFO', `🔥 [LIVE] Order ${orderId} resting at ${(order.price || limitPrice).toFixed(2)} — monitoring fill`);
      } catch (err) {
        this._log('ERROR', `[LIVE] placeOrder failed: ${err.message}`);
      }
    }
  }

  // ==========================================
  // ORDER MONITORING — fill, cancel, adverse selection
  // Called every main loop tick, before signal evaluation.
  // ==========================================

  async _monitorPendingOrders() {
    if (this._pendingOrders.size === 0) return;

    const ORDER_TIMEOUT_MS = (parseInt(this.settings.order_timeout_sec) || 10) * 1000;
    const TICK = 0.01;
    const ADVERSE_TICKS = parseInt(this.settings.adverse_ticks) || 2;

    for (const [orderId, pending] of this._pendingOrders) {
      const age = Date.now() - pending.placedAt;

      // ── Timeout: cancel if resting too long ──────────────────────────────
      if (age > ORDER_TIMEOUT_MS) {
        if (!pending.isPaper) {
          try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
        }
        this._log('WARN', `⏱️ Order ${orderId.slice(0,12)}... timed out after ${(age/1000).toFixed(1)}s — unfilled, discarded`);
        this._pendingOrders.delete(orderId);
        continue;
      }

      if (pending.isPaper) {
        await this._checkPaperFill(orderId, pending, TICK, ADVERSE_TICKS);
      } else {
        await this._checkLiveFill(orderId, pending, TICK, ADVERSE_TICKS);
      }
    }
  }

  // Paper fill simulation — stochastic model based on distance + time
  async _checkPaperFill(orderId, pending, TICK, ADVERSE_TICKS) {
    const currentPrice = await this.polymarket.getLastTradePrice(pending.tokenId);
    if (!currentPrice) return; // can't check — wait for next tick

    pending.lastCheckedPrice = currentPrice;

    // Adverse selection: market moved 2+ ticks against our BUY limit.
    // Example: limit=0.52, market dropped to 0.49 → we'd be buying above market.
    // This reflects real-world scenario where informed sellers push price down.
    if (currentPrice < pending.limitPrice - ADVERSE_TICKS * TICK) {
      this._log('WARN', `🚫 [PAPER] Adverse selection: limit=${pending.limitPrice.toFixed(2)} but market=${currentPrice.toFixed(3)} (-${((pending.limitPrice - currentPrice)/TICK).toFixed(0)} ticks) — cancelling`);
      this._pendingOrders.delete(orderId);
      return;
    }

    // Fill probability model:
    //   dist=0 ticks → high base fill prob (0.75)
    //   dist=1 tick  → moderate (0.50)
    //   dist=2 ticks → low (0.20)
    //   dist=3+ ticks → very low (0.05)
    // Time factor adds up to +0.3 over 8 seconds (orders rest longer = more fill chances)
    const timeSincePlaced = Date.now() - pending.placedAt;
    const dist = Math.abs(pending.limitPrice - currentPrice);
    const distanceFactor = Math.max(0.05, 1 - dist / (3 * TICK));   // 0.05 at 3+ ticks
    const timeFactor = Math.min(0.3, timeSincePlaced / 8000 * 0.3); // ramps to 0.3 over 8s
    const atMarket = currentPrice >= pending.limitPrice - TICK ? 0.15 : 0; // bonus if at/near limit
    const fillProb = Math.min(0.95, distanceFactor * 0.55 + timeFactor + atMarket);

    this._log('INFO', `📊 [PAPER] Fill check: limit=${pending.limitPrice.toFixed(2)} market=${currentPrice.toFixed(3)} dist=${(dist/TICK).toFixed(1)}ticks prob=${(fillProb*100).toFixed(0)}% age=${(timeSincePlaced/1000).toFixed(1)}s`);

    if (Math.random() < fillProb) {
      // Filled at our limit price (maker fill — we set the price)
      // Slight improvement on lastTradePrice if market moved in our favour
      const fillPrice = parseFloat(Math.min(pending.limitPrice, currentPrice + TICK).toFixed(2));
      this._log('INFO', `✅ [PAPER] Filled: ${pending.direction} @ ${fillPrice.toFixed(4)} (market=${currentPrice.toFixed(3)})`);
      await this._recordFilledTrade(pending, fillPrice, pending.dollarSize);
      this._pendingOrders.delete(orderId);
    }
  }

  // Live fill check — poll order status + adverse selection cancel
  async _checkLiveFill(orderId, pending, TICK, ADVERSE_TICKS) {
    try {
      const status = await this.polymarket.getOrderStatus(orderId);
      if (!status) return;

      if (status.isFilled) {
        const fillDollars = status.sizeMatched * pending.limitPrice;
        this._log('INFO', `✅ [LIVE] Order ${orderId.slice(0,12)} MATCHED @ ${pending.limitPrice.toFixed(4)} — $${fillDollars.toFixed(2)}`);
        await this._recordFilledTrade(pending, pending.limitPrice, fillDollars);
        this._pendingOrders.delete(orderId);
        return;
      }

      if (status.status === 'CANCELLED') {
        this._log('WARN', `🚫 [LIVE] Order ${orderId.slice(0,12)} was cancelled externally`);
        this._pendingOrders.delete(orderId);
        return;
      }

      if (status.isPartial) {
        // Partial fill — accept what we got, cancel the rest
        const fillDollars = status.sizeMatched * pending.limitPrice;
        this._log('INFO', `📊 [LIVE] Partial fill ${orderId.slice(0,12)}: ${status.sizeMatched.toFixed(2)}/${status.sizeTotal.toFixed(2)} tokens = $${fillDollars.toFixed(2)}`);
        try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
        await this._recordFilledTrade(pending, pending.limitPrice, fillDollars);
        this._pendingOrders.delete(orderId);
        return;
      }

      // Still LIVE (resting) — check for adverse selection
      const currentPrice = await this.polymarket.getLastTradePrice(pending.tokenId);
      if (currentPrice && currentPrice < pending.limitPrice - ADVERSE_TICKS * TICK) {
        this._log('WARN', `🚫 [LIVE] Adverse selection: limit=${pending.limitPrice.toFixed(2)} market=${currentPrice.toFixed(3)} — cancelling order ${orderId.slice(0,12)}`);
        try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
        this._pendingOrders.delete(orderId);
      }

    } catch (err) {
      this._log('WARN', `Order status check failed ${orderId.slice(0,12)}: ${err.message}`);
    }
  }

  // Write confirmed fill to DB and update balance
  async _recordFilledTrade(pending, fillPrice, fillDollars) {
    const { direction, market, signal, tokenId } = pending;
    const { confidence, evAdj } = signal;
    const marketId = market?.id || market?.condition_id;

    if (pending.isPaper) {
      this.paperBalance -= fillDollars;
      await pool.query('UPDATE bot_settings SET paper_balance=$1 WHERE user_id=$2', [this.paperBalance, this.userId]);
    }

    await pool.query(`
      INSERT INTO trades (user_id, market_id, market_question, token_id, direction, entry_price, trade_size, size, status, trade_type, signal_confidence, ev_adj, gate1_score, gate2_score, gate3_score)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'open', 'signal', $8, $9, $10, $11, $12)
    `, [
      this.userId, marketId, market?.question, tokenId, direction,
      fillPrice, fillDollars, confidence, evAdj,
      signal.log?.gates?.gate1?.confidence || 0,
      signal.log?.gates?.gate2?.bestEV || 0,
      signal.log?.gates?.gate3?.emaEdge || 0
    ]);

    this._recordSlippage(pending.referencePrice, fillPrice);

    const slipTicks = Math.abs(fillPrice - pending.referencePrice) / 0.01;
    this._log('INFO', `📝 Trade recorded: ${direction} fill=${fillPrice.toFixed(4)} ref=${pending.referencePrice.toFixed(4)} slip=${slipTicks.toFixed(1)} ticks size=$${fillDollars.toFixed(2)} balance=$${(pending.isPaper ? this.paperBalance : 0).toFixed(2)}`);
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
        // Close legacy trades that pre-date the token_id column — can't manage them
        if (!trade.token_id) {
          this._log('WARN', `Closing legacy trade ${trade.id} — no token_id`);
          await this._closePosition(trade, parseFloat(trade.entry_price), 'LEGACY_NO_TOKEN_ID');
          continue;
        }

        const tradeAgeMin = (Date.now() - new Date(trade.created_at).getTime()) / 60000;

        // CLOB returns null when book is boundary-only (spread > 90%) — use Gamma fallback
        let livePrice = await this.polymarket.getLiveTokenPrice(trade.token_id);
        if (!livePrice && trade.market_id) {
          livePrice = await this.polymarket.getLivePriceFromGamma(trade.market_id, trade.token_id);
          if (livePrice) this._log('INFO', `📡 Gamma price fallback: token=${trade.token_id?.slice(0,8)}... price=${livePrice.toFixed(3)}`);
        }

        if (!livePrice) {
          consecutivePriceFailures++;

          // 5-min market expired: close > 6 min after entry (1 min buffer past expiry)
          if (tradeAgeMin > 6) {
            // Query Gamma API for definitive market outcome — order books go empty at resolution
            // so the cached midPrice (still 0.50 from market start) is unreliable
            const resolvedAt = await this._getResolutionPrice(trade.market_id, trade.token_id)
              ?? parseFloat(trade.entry_price); // break-even if API unavailable

            this._log('INFO', `⏱️ Market expired — trade #${trade.id} age=${tradeAgeMin.toFixed(1)}min, resolvedAt=${resolvedAt.toFixed(3)}`);
            await this._closePosition(trade, resolvedAt, 'MARKET_RESOLVED');
            consecutivePriceFailures = 0;
            continue;
          }

          this._log('WARN', `Price fetch failed for token ${trade.token_id} (age=${tradeAgeMin.toFixed(1)}min)`);
          if (consecutivePriceFailures >= MAX_PRICE_FAILURES) {
            this._log('CRITICAL', `🛑 ${MAX_PRICE_FAILURES} consecutive price failures — emergency close`);
            await this._closePosition(trade, parseFloat(trade.entry_price), 'EMERGENCY_PRICE_FEED_DOWN');
            consecutivePriceFailures = 0;
          }
          continue;
        }

        consecutivePriceFailures = 0;

        // Near-resolution detection: token price approaching 0 or 1 = market settling
        // BTC 5-min markets rarely reach 0.92 before expiry — also close at 4.5 min
        // to catch trades where the book stays active but we want to lock in gains
        if (livePrice >= 0.92 || livePrice <= 0.08) {
          const resolvedAt = livePrice >= 0.92 ? 0.99 : 0.01;
          this._log('INFO', `🏁 Near-resolution detected: price=${livePrice.toFixed(3)} — closing trade #${trade.id} at ${resolvedAt}`);
          await this._closePosition(trade, resolvedAt, 'MARKET_RESOLVED');
          this.evEngine.clearMarket(trade.market_id);
          continue;
        }

        // Time-based close at 4.5 min: market is about to expire — get resolution from Gamma API now
        // while the market may still appear live (before CLOB books drain)
        if (tradeAgeMin >= 4.5) {
          const resolvedAt = await this._getResolutionPrice(trade.market_id, trade.token_id);
          if (resolvedAt !== null) {
            this._log('INFO', `⏳ Pre-expiry close: trade #${trade.id} age=${tradeAgeMin.toFixed(1)}min resolvedAt=${resolvedAt.toFixed(3)}`);
            await this._closePosition(trade, resolvedAt, 'MARKET_RESOLVED');
            this.evEngine.clearMarket(trade.market_id);
            continue;
          }
        }

        consecutivePriceFailures = 0;

        const entryPrice = parseFloat(trade.entry_price);
        const marketId = trade.market_id;

        // --- EV-based exit ---
        // Recompute model probability using same logic as signal engine
        const btcPrice = this.binance.getLastKnownPrice();
        if (!btcPrice) continue;

        const btcDelta = this.binance.getWindowDeltaScore(30);
        const latency = this.signalEngine?.microEngine?.detectLatency() || 0;
        const exitLagEdge = latency > 0.3 ? 0.05 : 0;
        // FIX: btcDelta is already in % — multiply by 0.5 not 0.05 (was 10x too small)
        const exitBtcEdge = Math.min(Math.abs(btcDelta) * 0.5, 0.15);
        const exitTotalEdge = exitBtcEdge + exitLagEdge;
        const exitBullish = btcDelta > 0;
        const currentModelProb = Math.min(0.99, Math.max(0.01,
          exitBullish ? livePrice + exitTotalEdge : livePrice - exitTotalEdge
        ));
        const clampedProb = currentModelProb;

        const currentEV = this.evEngine.calculateAdjustedEV(
          clampedProb, livePrice,
          trade.direction,
          { spread: 0.01, estimatedSlippage: 0.005, fees: 0.002 }
        );

        // Record EV for trend tracking + flip evaluation
        this.evEngine.recordEV(marketId, currentEV, trade.direction);

        this._log('INFO', `📍 Holding ${trade.direction} on "${trade.market_question?.slice(0,40)}" — EV=${currentEV.toFixed(2)}% price=${livePrice.toFixed(3)}`);

        // EXIT CONDITION 1: Hard stop-loss — price moved sharply against us
        // Token price is always the token we bought (YES token for YES, NO token for NO).
        // PnL direction is always (currentPrice - entryPrice) — same formula for both sides.
        const pnlPct = ((livePrice - entryPrice) / entryPrice) * 100;

        if (pnlPct <= -20) {
          this._log('WARN', `🛑 Hard stop-loss: PnL ${pnlPct.toFixed(1)}% — closing`);
          await this._closePosition(trade, livePrice, 'HARD_STOP_LOSS');
          this.evEngine.clearMarket(marketId);
          continue;
        }

        // EXIT CONDITION 2: Edge fully gone — EV deeply negative AND no flip candidate
        // We hold through mild negative EV (market noise) but exit if structurally wrong
        if (currentEV < -8) {
          this._log('WARN', `📉 Edge gone: EV=${currentEV.toFixed(2)}% — closing`);
          await this._closePosition(trade, livePrice, 'NEGATIVE_EV_EXIT');
          this.evEngine.clearMarket(marketId);
          continue;
        }

        // Otherwise: HOLD to resolution — let the binary market expire naturally.
      }
    } catch (err) {
      this._log('ERROR', `Position management error: ${err.message}`);
    }
  }

  async _closePosition(trade, exitPrice, reason) {
    try {
      const entryPrice = parseFloat(trade.entry_price);
      // trade_size is the authoritative column; fall back to legacy 'size' column
      const tradeSize = parseFloat(trade.trade_size ?? trade.size);
      const effectiveExit = parseFloat(exitPrice) || entryPrice;

      // Guard: if any value is NaN the PnL calc produces garbage — mark as broken close
      if (!isFinite(entryPrice) || !isFinite(tradeSize) || tradeSize <= 0 || !isFinite(effectiveExit)) {
        this._log('WARN', `Trade ${trade.id} has invalid data (entry=${entryPrice}, size=${tradeSize}, exit=${effectiveExit}) — closing as BREAK_EVEN`);
        await pool.query(
          `UPDATE trades SET status='closed', exit_price=$1, pnl=0, close_reason=$2, result='LOSS', closed_at=NOW() WHERE id=$3`,
          [entryPrice || 0, reason + '_DATA_ERROR', trade.id]
        );
        return;
      }

      // Binary market PnL: we always buy the token (YES or NO) at entryPrice.
      // token_id stores the exact token bought, getLiveTokenPrice returns that token's price.
      // So the formula is always (exit - entry) * shares, regardless of direction.
      const pnl = (effectiveExit - entryPrice) * tradeSize / entryPrice;

      if (!isFinite(pnl) || isNaN(pnl)) {
        this._log('ERROR', `Invalid PnL=${pnl} (entry=${entryPrice}, exit=${effectiveExit}, size=${tradeSize}) — skipping close`);
        return;
      }

      const result = pnl >= 0 ? 'WIN' : 'LOSS';
      await pool.query(`
        UPDATE trades SET status = 'closed', exit_price = $1, pnl = $2, close_reason = $3, result = $4, closed_at = NOW()
        WHERE id = $5
      `, [effectiveExit, pnl, reason, result, trade.id]);

      if (this.settings.paper_trading) {
        this.paperBalance = Math.max(0, this.paperBalance + tradeSize + pnl);
        await pool.query('UPDATE bot_settings SET paper_balance = $1 WHERE user_id = $2', [this.paperBalance, this.userId]);
      }

      this._log('INFO', `✅ Closed #${trade.id} ${trade.direction} [${reason}] entry=${entryPrice.toFixed(3)} exit=${effectiveExit.toFixed(3)} size=$${tradeSize.toFixed(2)} PnL=$${pnl.toFixed(2)} (${((pnl/tradeSize)*100).toFixed(1)}%)`);
    } catch (err) {
      this._log('ERROR', `Close position failed: ${err.message}`);
    }
  }

  /**
   * Query Gamma API for the definitive market resolution price for a token.
   * Returns 0.99 (token won) or 0.01 (token lost), or null if market not yet resolved.
   * Polymarket CLOB books drain to empty at resolution — can't rely on cached order book prices.
   */
  async _getResolutionPrice(marketId, tokenId) {
    try {
      const r = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, { timeout: 5000 });
      const m = r.data;
      if (!m || (!m.closed && !m.resolved)) return null;

      // outcomePrices: '["1","0"]' = YES won, '["0","1"]' = NO won
      let outcomePrices = m.outcomePrices;
      if (typeof outcomePrices === 'string') {
        try { outcomePrices = JSON.parse(outcomePrices); } catch (_) { return null; }
      }
      if (!Array.isArray(outcomePrices) || outcomePrices.length < 2) return null;

      // clobTokenIds[0] = YES token, [1] = NO token
      let clobIds = m.clobTokenIds;
      if (typeof clobIds === 'string') {
        try { clobIds = JSON.parse(clobIds); } catch (_) { return null; }
      }

      const yesPrice0 = parseFloat(outcomePrices[0]);
      // Only trust a clear winner: 1.0 = YES won, 0.0 = NO won
      // Avoid 0.5/0.5 which means UMA hasn't resolved yet (challenge period)
      if (yesPrice0 >= 0.9) {
        // YES won
        const isYesToken = clobIds?.[0] === tokenId;
        const isNoToken  = clobIds?.[1] === tokenId;
        if (isYesToken) return 0.99;
        if (isNoToken)  return 0.01;
      } else if (yesPrice0 <= 0.1) {
        // NO won
        const isYesToken = clobIds?.[0] === tokenId;
        const isNoToken  = clobIds?.[1] === tokenId;
        if (isYesToken) return 0.01;
        if (isNoToken)  return 0.99;
      }
      return null; // ambiguous or not yet resolved
    } catch (err) {
      this._log('WARN', `Gamma resolution lookup failed for ${marketId}: ${err.message}`);
      return null;
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
    // Cache balance for 60s — no need to hit RPC on every 10s tick
    if (this._balanceCache && (Date.now() - this._balanceCache.ts) < 60000) {
      return this._balanceCache.value;
    }
    try {
      if (this.settings.polymarket_wallet_address) {
        const { ethers } = require('ethers');
        // staticNetwork skips ethers v6 background network-detection retries (stops log spam)
        const POLYGON = ethers.Network.from(137);
        const rpcs = [
          process.env.POLYGON_RPC_URL,
          'https://polygon-bor-rpc.publicnode.com',
          'https://1rpc.io/matic',
        ].filter(Boolean);
        const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
        for (const rpc of rpcs) {
          try {
            const provider = new ethers.JsonRpcProvider(rpc, POLYGON, { staticNetwork: POLYGON });
            const usdc = new ethers.Contract('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', ERC20_ABI, provider);
            const raw = await Promise.race([
              usdc.balanceOf(this.settings.polymarket_wallet_address),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
            ]);
            const balance = parseFloat(ethers.formatUnits(raw, 6));
            this._balanceCache = { value: balance, ts: Date.now() };
            return balance;
          } catch (e) { continue; }
        }
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

  // ==========================================
  // REAL-TIME STATE BROADCAST (SSE)
  // ==========================================

  /**
   * Async 1s loop — fetches YES/NO order books for active markets.
   * Results stored in _lastOrderBooks so _broadcastState() can include them
   * without awaiting (keeps the 200ms broadcast synchronous).
   */
  async _fetchActiveOrderBooks() {
    if (!this.isRunning || !this.polymarket) return;
    try {
      // Refresh markets list every 30s so token prices stay current after market rotation
      const cacheAge = this.polymarket.lastMarketFetch ? Date.now() - this.polymarket.lastMarketFetch : Infinity;
      if (cacheAge > 25000) {
        await this.polymarket.fetchActiveBTCMarkets();
      }
      const markets = this.polymarket.marketsCache || [];
      for (const m of markets) {
        let clobIds = m.clobTokenIds || [];
        if (typeof clobIds === 'string') { try { clobIds = JSON.parse(clobIds); } catch (_) { clobIds = []; } }
        const yesId = m.tokens?.[0]?.token_id || clobIds[0];
        const noId  = m.tokens?.[1]?.token_id || clobIds[1];
        if (yesId) {
          const book = await this.polymarket.getOrderBook(yesId);
          if (book) this._lastOrderBooks[yesId] = book;
        }
        if (noId && noId !== yesId) {
          const book = await this.polymarket.getOrderBook(noId);
          if (book) this._lastOrderBooks[noId] = book;
        }
      }
    } catch (_) {}
  }

  /**
   * Builds and emits a lightweight state snapshot every 200ms.
   * SSE clients in bot.js subscribe to streamEmitter 'state' events.
   * Does NOT block the main loop — synchronous reads only.
   */
  _broadcastState() {
    if (!this.isRunning) return;
    try {
      const btcPrice  = this.binance?.getPrice() || null;
      const btcDelta  = btcPrice ? this.binance.getWindowDeltaScore(30) : null;
      const btcImbal  = btcPrice ? this.binance.getOrderBookImbalance() : null;

      // Markets from polymarket cache + last fetched order books (no awaits)
      const markets = (this.polymarket?.marketsCache || []).map(m => {
        let clobIds = m.clobTokenIds || [];
        if (typeof clobIds === 'string') { try { clobIds = JSON.parse(clobIds); } catch (_) { clobIds = []; } }
        const yesId  = m.tokens?.[0]?.token_id || clobIds[0];
        const noId   = m.tokens?.[1]?.token_id || clobIds[1];
        const yesBook = yesId ? this._lastOrderBooks[yesId] : null;
        const noBook  = noId  ? this._lastOrderBooks[noId]  : null;
        // yesBid/yesAsk are the actual Polymarket order book prices (match what UI shows)
        // yesPrice (mid) is used internally for Kelly; display uses ask (buy price)
        return {
          id:        m.id || m.condition_id,
          question:  m.question,
          endIso:    m.end_date_iso,
          startIso:  m.start_date_iso,
          yesPrice:  yesBook?.midPrice  ?? null,
          noPrice:   noBook?.midPrice   ?? null,
          yesBid:    yesBook?.bestBid   ?? null,
          yesAsk:    yesBook?.bestAsk   ?? null,
          noBid:     noBook?.bestBid    ?? null,
          noAsk:     noBook?.bestAsk    ?? null,
          spread:    yesBook?.spread    ?? null,
          bidDepth:  yesBook?.bidDepth  ?? null,
          askDepth:  yesBook?.askDepth  ?? null,
        };
      });

      // EV stats per market from signal engine
      const evStats = {};
      for (const mkt of markets) {
        if (!mkt.id) continue;
        const stats = this.evEngine.getEVStats(mkt.id);
        if (stats.currentEV !== null) evStats[mkt.id] = stats;
      }

      const state = {
        ts:          Date.now(),
        btcPrice,
        btcDelta,
        btcImbalance: btcImbal,
        markets,
        evStats,
        paperBalance: this.paperBalance,
        peakBalance:  this.peakBalance,
        isRunning:    this.isRunning,
        flipCount:    this.recentFlips.length,
        drawdownActive: !!(this.drawdownCooldownUntil && Date.now() < this.drawdownCooldownUntil),
      };

      this._lastStreamState = state;
      this.streamEmitter.emit('state', state);
    } catch (err) {
      // Never crash main bot from broadcast errors
    }
  }

  getStatus() {
    // Summarise pending orders for dashboard display
    const pendingOrders = [...this._pendingOrders.values()].map(p => ({
      orderId: p.orderId.slice(0, 16),
      direction: p.direction,
      limitPrice: p.limitPrice,
      referencePrice: p.referencePrice,
      dollarSize: p.dollarSize,
      isPaper: p.isPaper,
      ageMs: Date.now() - p.placedAt,
      lastCheckedPrice: p.lastCheckedPrice
    }));

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
      recentLogs: this.decisionLog.slice(-20),
      lastStreamState: this._lastStreamState,
      pendingOrders,
    };
  }
}

module.exports = BotInstance;
