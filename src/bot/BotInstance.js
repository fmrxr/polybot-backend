/**
 * BotInstance — Clock-based snipe timing from PolymarketBot.md
 *
 * Key timing insight:
 * - Each 5-min window has a deterministic close time (Unix epoch % 300 == 0)
 * - Bot sleeps until T-10s before window close, then enters polling loop
 * - At T-10s, BTC direction is largely locked in — minimal reversal risk
 * - Loop polls every 2s, fires on confidence OR at T-5s hard deadline
 */

const { GBMSignalEngine } = require('./GBMSignalEngine');
const { BinanceFeed } = require('./BinanceFeed');
const { PolymarketFeed } = require('./PolymarketFeed');
const { ChainlinkFeed } = require('./ChainlinkFeed');
const { decrypt } = require('../services/encryption');
const { pool } = require('../models/db');

const SNIPE_BEFORE_CLOSE_SEC = 10;  // Enter snipe loop T-10s before close
const HARD_DEADLINE_SEC = 5;         // Always trade by T-5s
const POLL_INTERVAL_MS = 2000;       // Poll every 2s in snipe window
const MARKET_REFRESH_MS = 30000;     // Refresh market list every 30s
const RESOLUTION_CHECK_MS = 30000;   // Check resolutions every 30s

class BotInstance {
  constructor(userId, settings) {
    this.userId = userId;
    this.settings = settings;
    // Friendly label for logs: "alice" from "alice@gmail.com", fallback to user ID
    this.userLabel = settings.user_email
      ? settings.user_email.split('@')[0]
      : String(userId);
    this.paperTrading = settings.paper_trading !== false;
    this.paperBalance = parseFloat(settings.paper_balance) || 10000;
    this.binance = new BinanceFeed();
    this.chainlink = new ChainlinkFeed();
    this.polymarket = null;
    this.engine = null;
    this.mainTimer = null;
    this.marketRefreshTimer = null;
    this.resolutionTimer = null;
    this.isRunning = false;
    this.openTrades = new Map();
    this.lastWindowTs = null;
    this.lastMarketData = null;
    this.lastMarketRefreshAt = 0;
    this.inSnipeLoop = false;

    // Flip tracking: recent direction changes per window for EV-gap requirement
    this.recentFlips = [];   // [{ ts: epochMs, direction, ev }]

    // Performance stats timer
    this.statsTimer = null;
  }

  async start() {
    // Decrypt private key with explicit error handling
    let privateKey;
    try {
      privateKey = decrypt(this.settings.encrypted_private_key);
    } catch(e) {
      throw new Error(`Failed to decrypt private key — check ENCRYPTION_KEY env var: ${e.message}`);
    }

    // Decrypt user's Polymarket API key if provided
    let userApiKey = null;
    if (this.settings.encrypted_polymarket_api_key) {
      try {
        userApiKey = decrypt(this.settings.encrypted_polymarket_api_key);
      } catch(e) {
        this._log('WARN', `Failed to decrypt user's Polymarket API key: ${e.message}`);
        // Continue without user API key — fall back to backend key
      }
    }

    // Get user's Polymarket wallet address (proxy wallet for GNOSIS_SAFE auth)
    const funderAddress = this.settings.polymarket_wallet_address;
    if (!funderAddress) {
      this._log('WARN', 'No Polymarket wallet address configured — trades may fail');
    } else {
      this._log('INFO', `Using Polymarket wallet: ${funderAddress}`);
    }

    this.polymarket = new PolymarketFeed(privateKey, userApiKey, funderAddress);
    this._snipeSec = parseInt(this.settings.snipe_before_close_sec) ?? 10;
    this.engine = new GBMSignalEngine({
      kelly_cap: parseFloat(this.settings.kelly_cap),
      max_trade_size: parseFloat(this.settings.max_trade_size),
      min_ev_threshold: parseFloat(this.settings.min_ev_threshold),
      min_prob_diff: parseFloat(this.settings.min_prob_diff),
      min_edge: parseFloat(this.settings.min_edge) || 0.05,
      max_spread_pct: parseFloat(this.settings.max_spread_pct) || 0.10,
      direction_filter: this.settings.direction_filter,
      market_prob_min: parseFloat(this.settings.market_prob_min),
      market_prob_max: parseFloat(this.settings.market_prob_max)
    });
    this.engine.onDecision = (d) => this._recordDecision(d);

    await this.binance.connect();

    // Chainlink is non-critical — failures are tolerated
    try {
      await this.chainlink.init();
    } catch(e) {
      this._log('WARN', `Chainlink feed unavailable: ${e.message} — window delta will use Binance price`);
    }

    // Initialize Polymarket CLOB client with API credentials
    await this.polymarket.init();

    await this.polymarket.fetchActiveBTCMarkets();

    // Restore open trades from database (fixes orphaned trades on restart)
    await this._reloadOpenTrades();

    // Initialize paper balance if not done yet
    if (this.paperTrading && !this.settings.paper_balance_initialized) {
      await pool.query(
        'UPDATE bot_settings SET paper_balance = $1, paper_balance_initialized = true WHERE user_id = $2',
        [10000, this.userId]
      );
      this.paperBalance = 10000;
      this._log('INFO', 'Paper trading account initialized with $10,000');
    }

    this.isRunning = true;
    const mode = this.paperTrading ? '📄 PAPER TRADING' : '💰 LIVE TRADING';
    const balanceStr = this.paperTrading ? ` | Balance: $${this.paperBalance.toFixed(2)}` : '';
    this._log('INFO', `Bot started [${mode}] for user ${this.userId}${balanceStr}`);

    // Seed performance stats immediately so adaptive thresholds start from real data
    await this._updatePerformanceStats();

    // Main loop: check timing every second
    this.mainTimer = setInterval(() => this._tick(), 1000);
    this.marketRefreshTimer = setInterval(() => {
      this.polymarket.fetchActiveBTCMarkets()
        .catch(e => this._log('WARN', `Market refresh failed: ${e.message}`));
    }, MARKET_REFRESH_MS);
    this.resolutionTimer = setInterval(() => this._checkResolutions(), RESOLUTION_CHECK_MS);
    // Position management: check for early exits every 10s
    this.positionMgmtTimer = setInterval(() => this._manageOpenPositions(), 10000);
    // Refresh win rate + avg slippage every 5 minutes for adaptive EV thresholds
    this.statsTimer = setInterval(() => this._updatePerformanceStats(), 5 * 60 * 1000);
  }

  async _tick() {
    if (!this.isRunning || this.inSnipeLoop) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = nowSec - (nowSec % 300);
    const windowClose = windowTs + 300;
    const secsToClose = windowClose - nowSec;

    // Update market data snapshot — include Chainlink data for frontend display
    const btcData = this.binance.getMarketData();
    const chainlinkData = this.chainlink.getPriceData();
    if (btcData.price) {
      this.lastMarketData = {
        price: btcData.price,
        vwap: btcData.vwap,
        volatility: btcData.volatility,
        momentum: btcData.momentum,
        ob_imbalance: btcData.obImbalance,
        // Use Chainlink price if available, otherwise fallback to Binance price
        chainlink_price: chainlinkData?.price || btcData.price,
        chainlink_age: chainlinkData?.ageSeconds || 0,
        updated_at: new Date().toISOString()
      };
    }

    // Log countdown every 30s so user can see bot is alive
    if (secsToClose % 30 === 0) {
      this._log('INFO', `Window closes in ${secsToClose}s | BTC: $${btcData.price?.toFixed(0) || '?'} | Markets: ${this.polymarket.activeMarkets.length}`);
    }

    if (this.polymarket.activeMarkets.length === 0 && secsToClose <= 60 && nowSec - this.lastMarketRefreshAt >= 10) {
      this.lastMarketRefreshAt = nowSec;
      this.polymarket.fetchActiveBTCMarkets()
        .catch(e => this._log('WARN', `Urgent market refresh failed: ${e.message}`));
    }

    // Enter snipe loop at T-snipeSec
    if (secsToClose <= this._snipeSec && windowTs !== this.lastWindowTs) {
      await this._snipeWindow(windowTs, windowClose, btcData);
    }
  }

  async _snipeWindow(windowTs, windowClose, initialBtcData) {
    this.inSnipeLoop = true;

    try {
      // Daily loss limit check
      const dailyResult = await pool.query(
        `SELECT COALESCE(SUM(pnl), 0) as daily_pnl FROM trades WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
        [this.userId]
      );
      if (parseFloat(dailyResult.rows[0].daily_pnl) <= -Math.abs(this.settings.max_daily_loss)) {
        this._log('WARN', `Daily loss limit reached. Skipping window.`);
        this.lastWindowTs = windowTs;
        return;
      }

      if (!this.polymarket.activeMarkets.length) {
        await this.polymarket.fetchActiveBTCMarkets();
      }

      this.polymarket.activeMarkets.sort((a, b) => (a.windowTs || Infinity) - (b.windowTs || Infinity));

      const getMarketWindowTs = (m) => {
        if (typeof m.windowTs === 'number') return m.windowTs;
        const end = m.endDate || m.endDateIso;
        if (!end) return null;
        const marketClose = Math.floor(new Date(end).getTime() / 1000);
        return marketClose - 300;
      };

      const findWindowMarket = () => this.polymarket.activeMarkets.find(m => {
        const marketWindowTs = getMarketWindowTs(m);
        return marketWindowTs !== null && Math.abs(marketWindowTs - windowTs) <= 5;
      });

      let market = findWindowMarket() || this.polymarket.activeMarkets[0];
      let marketRetryCount = 0;

      while (!market) {
        const nowSec = Math.floor(Date.now() / 1000);
        const secsLeft = windowClose - nowSec;
        if (secsLeft <= 0) break;

        if (marketRetryCount === 0 || marketRetryCount % 2 === 0) {
          this._log('WARN', `No market found yet for window ${windowTs}. Retrying...`);
        }

        await this.polymarket.fetchActiveBTCMarkets();
        market = findWindowMarket() || this.polymarket.activeMarkets[0];
        marketRetryCount += 1;

        if (!market) await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }

      if (!market) {
        this._log('WARN', `T-${SNIPE_BEFORE_CLOSE_SEC}s: No market found for window ${windowTs}`);
        this.lastWindowTs = windowTs;
        return;
      }

      let tokens = [];
      if (Array.isArray(market.tokens)) {
        tokens = market.tokens;
      } else if (market.tokens && typeof market.tokens === 'object') {
        tokens = Object.values(market.tokens).filter(Boolean);
      }

      if (tokens.length === 0 && market.clobTokenIds && typeof this.polymarket._extractClobTokenIds === 'function') {
        const tokenIds = this.polymarket._extractClobTokenIds(market.clobTokenIds);
        tokens = tokenIds.map((id, i) => ({ token_id: id, outcome: i === 0 ? 'Yes' : 'No' }));
      }

      if (tokens.length < 2) {
        this._log('WARN', `Market has no tokens: ${market.question}`);
        this.lastWindowTs = windowTs;
        return;
      }

      this._log('INFO', `🎯 Entering snipe loop | Market: "${(market.question||'?').substring(0,50)}"`);

      // ── SNIPE LOOP: poll every 2s until T-5s hard deadline ──────────────
      let bestSignal = null;
      let bestScore = 0;

      while (true) {
        const nowSec = Math.floor(Date.now() / 1000);
        const secsLeft = windowClose - nowSec;

        if (secsLeft <= 0) break;

        const btcData = this.binance.getMarketData();
        if (!btcData.price) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }

        // Pass both Binance and Chainlink prices to the signal engine
        const chainlinkData = this.chainlink.getPriceData();

        // Phase A: Get order book data from market object for EV gates
        const bid = market.bestBid || null;
        const ask = market.bestAsk || null;
        const bidDepth = market.bidDepth || null;
        const askDepth = market.askDepth || null;
        const totalDepth = market.totalDepth || null;

        const signal = this.engine.evaluate({
          currentPrice: btcData.price,
          binancePrice: btcData.price,
          chainlinkPrice: chainlinkData?.price || null,
          priceHistory: btcData.priceHistory || [],
          volumeHistory: btcData.volumeHistory || [],
          timeToResolutionSec: secsLeft,
          obImbalance: btcData.obImbalance || 0,
          drift: btcData.drift || 0,
          volatility: btcData.volatility || 0,
          bid,
          ask,
          bidDepth,
          askDepth,
          totalDepth
        });

        if (signal) {
          if (Math.abs(signal.score) > Math.abs(bestScore)) {
            bestSignal = signal;
            bestScore = signal.score;
          }

          this._log('INFO', `Snipe check | Score: ${signal.score.toFixed(1)} | Conf: ${(signal.confidence*100).toFixed(0)}% | ${signal.direction} | ${secsLeft}s left`);
          await this._executeTrade(signal, market, tokens, windowTs);
          this.lastWindowTs = windowTs;
          return;
        }

        // Hard deadline: T-5s — use best REAL signal seen, never the fallback
        if (secsLeft <= HARD_DEADLINE_SEC) {
          if (bestSignal) {
            this._log('INFO', `⏰ T-5s deadline — using best real signal: ${bestSignal.direction} (score: ${bestSignal.score?.toFixed(1) || '?'})`);
            await this._executeTrade(bestSignal, market, tokens, windowTs);
          } else {
            this._log('INFO', `⏰ T-5s deadline — no qualified signal this window, skipping`);
          }
          this.lastWindowTs = windowTs;
          return;
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }

      this.lastWindowTs = windowTs;

    } catch(err) {
      this._log('ERROR', `Snipe loop error: ${err.message}`);
      this.lastWindowTs = windowTs;
    } finally {
      this.inSnipeLoop = false;
    }
  }

  _fallbackSignal(btcData) {
    if (!this.engine.windowOpenPrice || !btcData.price) return null;

    // Require minimum window movement — don't coin-flip on neutral price
    const windowPct = Math.abs((btcData.price - this.engine.windowOpenPrice) / this.engine.windowOpenPrice * 100);
    if (windowPct < 0.05) {
      this._log('WARN', `Fallback skipped: price movement ${windowPct.toFixed(4)}% below 0.05% minimum`);
      return null;
    }

    const direction = btcData.price >= this.engine.windowOpenPrice ? 'UP' : 'DOWN';
    const MIN_SHARES = 5; // Polymarket minimum
    const entryPrice = 0.50; // Fallback entry price estimate
    const minSize = MIN_SHARES * entryPrice; // Minimum size in dollars
    const size = Math.max(minSize, Math.min(parseFloat(this.settings.max_trade_size) * 0.25, parseFloat(this.settings.max_trade_size)));
    return {
      direction,
      entry_price: 0.50,
      model_prob: 0.5,
      market_prob: 0.5,
      anchored_prob: 0.5,
      expected_value: 0,
      size,
      fee: 0,
      confidence: 0.1,
      score: direction === 'UP' ? 0.1 : -0.1
    };
  }

  async _reloadOpenTrades() {
    try {
      const result = await pool.query(
        `SELECT id, condition_id, direction, entry_price, size, paper, order_id, window_ts, token_id
         FROM trades WHERE user_id=$1 AND result IS NULL AND resolved_at IS NULL`,
        [this.userId]
      );
      for (const row of result.rows) {
        this.openTrades.set(row.id, {
          conditionId: row.condition_id,
          direction: row.direction,
          entryPrice: parseFloat(row.entry_price),
          size: parseFloat(row.size),
          paper: row.paper,
          orderId: row.order_id,
          windowTs: row.window_ts,
          tokenId: row.token_id
        });
      }
      if (result.rows.length > 0) {
        this._log('INFO', `Reloaded ${result.rows.length} open trade(s) from database`);
      }
    } catch(e) {
      this._log('ERROR', `Failed to reload open trades: ${e.message}`);
    }
  }

  async _executeTrade(signal, market, tokens, windowTs) {
    const MIN_SHARES = 5; // Polymarket CLOB minimum: 5 shares per order

    // ── EV-DRIVEN FLIP GUARD ─────────────────────────────────────────────────
    // If the last trade was in the opposite direction, require a meaningful EV
    // advantage before flipping. Prevents noise-driven YES→NO→YES churn.
    // This is NOT a time cooldown — a genuinely superior EV always overrides.
    const nowMs = Date.now();
    const FLIP_WINDOW_MS = 5 * 60 * 1000;
    this.recentFlips = this.recentFlips.filter(f => nowMs - f.ts < FLIP_WINDOW_MS);

    if (this.recentFlips.length > 0) {
      const lastFlip = this.recentFlips[this.recentFlips.length - 1];
      const isFlip = lastFlip.direction !== signal.direction;
      if (isFlip) {
        // Count how many flips in the window — more flips = require higher EV gap
        const flipCount = this.recentFlips.filter((f, i) =>
          i > 0 && f.direction !== this.recentFlips[i-1].direction
        ).length;
        // Base flip threshold: 1.5%, +1% per additional flip (max 5%)
        const flipEVGap = Math.min(0.015 + flipCount * 0.01, 0.05);
        const lastEV = lastFlip.ev || 0;
        const evGain = (signal.ev_adjusted || signal.expected_value || 0) - Math.max(lastEV, 0);
        if (evGain < flipEVGap) {
          this._log('WARN', `⚡ Flip blocked: ${lastFlip.direction}→${signal.direction} requires +${(flipEVGap*100).toFixed(1)}% EV gain, have +${(evGain*100).toFixed(1)}%`);
          return;
        }
        this._log('INFO', `✅ Flip approved: EV gain +${(evGain*100).toFixed(1)}% > required +${(flipEVGap*100).toFixed(1)}% (${flipCount} prior flips)`);
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // Calculate shares from size (size is in dollars, entry_price is per share)
    const entryPrice = parseFloat(signal.entry_price) || 0.50;
    const shares = signal.size / entryPrice;

    // Enforce minimum share size
    if (shares < MIN_SHARES) {
      this._log('WARN', `Order ${shares.toFixed(2)} shares below minimum ${MIN_SHARES} — skipping`);
      return;
    }

    const mode = this.paperTrading ? '[PAPER]' : '[LIVE]';
    const [upToken, downToken] = tokens;
    const tokenId = signal.direction === 'UP'
      ? (upToken?.token_id || upToken)
      : (downToken?.token_id || downToken);

    if (!tokenId) {
      this._log('ERROR', `No token ID for ${signal.direction}. Tokens: ${JSON.stringify(tokens).substring(0,100)}`);
      return;
    }

    this._log('INFO',
      `${mode} 🔥 TRADE | ${signal.direction} | Entry: ~$${signal.entry_price.toFixed(3)} | Conf: ${(signal.confidence*100).toFixed(0)}% | Size: $${signal.size.toFixed(2)}`
    );

    // Improvement 12: Combined strategy — require whale convergence when enabled
    if (this.settings.require_whale_convergence) {
      const whaleDir = await this._recentWhaleActivity(market.conditionId);
      if (whaleDir && whaleDir !== signal.direction) {
        this._log('WARN', `Convergence fail: GBM=${signal.direction} Whale=${whaleDir} — SKIP`);
        return;
      }
      if (whaleDir === signal.direction) {
        signal.size = Math.min(signal.size * 1.25, parseFloat(this.settings.max_trade_size));
        this._log('INFO', `Convergence: GBM+Whale agree on ${signal.direction} — boosted size to $${signal.size.toFixed(2)}`);
      }
    }

    // Check paper trading balance
    if (this.paperTrading && this.paperBalance < signal.size) {
      this._log('WARN', `Insufficient paper balance: $${this.paperBalance.toFixed(2)} < $${signal.size.toFixed(2)} — SKIP`);
      return;
    }

    if (this.paperTrading) {
      try {
        const evAtEntry = signal.ev_adjusted || signal.expected_value || 0;
        const result = await pool.query(
          `INSERT INTO trades (user_id, condition_id, direction, entry_price, size, model_prob, market_prob, expected_value, fee, paper, order_status, window_ts, token_id, ev_at_entry, ev_peak, lag_age_sec, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,'SIMULATED',$10,$11,$12,$12,$13,NOW()) RETURNING id`,
          [this.userId, market.conditionId, signal.direction, signal.entry_price, signal.size,
           signal.model_prob, signal.market_prob, signal.expected_value, signal.fee, windowTs, tokenId,
           evAtEntry, signal.lag_age_sec || 0]
        );
        const tradeId = result.rows[0].id;
        this.openTrades.set(tradeId, {
          conditionId: market.conditionId, direction: signal.direction,
          tokenId, entryPrice: signal.entry_price, size: signal.size,
          paper: true, windowTs, confidence: signal.confidence, evAtEntry, evPeak: evAtEntry
        });
        // Deduct trade size from paper balance atomically
        const balRes = await pool.query(
          'UPDATE bot_settings SET paper_balance = paper_balance - $1 WHERE user_id = $2 RETURNING paper_balance',
          [signal.size, this.userId]
        );
        this.paperBalance = parseFloat(balRes.rows[0]?.paper_balance ?? this.paperBalance - signal.size);
        this._log('INFO', `[PAPER] ✅ Trade #${tradeId} recorded | EV ${(evAtEntry*100).toFixed(1)}% | Balance: $${this.paperBalance.toFixed(2)}`);
        this.recentFlips.push({ ts: Date.now(), direction: signal.direction, ev: evAtEntry });
      } catch(e) {
        this._log('ERROR', `[PAPER] Failed to record trade: ${e.message}`);
      }
      return;
    }

    // Live trading
    try {
      const orderResult = await this.polymarket.placeOrder({
        tokenId, side: 'BUY',
        price: signal.entry_price, size: signal.size,
        conditionId: market.conditionId
      });
      const orderId = orderResult?.orderID || orderResult?.id || null;
      this._log('INFO', `[LIVE] Order submitted: ${orderId || 'no-id'}`);

      await new Promise(r => setTimeout(r, 5000));

      let orderStatus = 'UNVERIFIED', confirmedSize = signal.size, confirmedPrice = signal.entry_price;
      if (orderId) {
        try {
          const verified = await this.polymarket.getOrderStatus(orderId);
          orderStatus = verified.status;
          confirmedSize = parseFloat(verified.size_matched) || signal.size;
          confirmedPrice = parseFloat(verified.price) || parseFloat(verified.avg_price) || signal.entry_price;
          if (orderStatus === 'CANCELLED' || orderStatus === 'UNMATCHED') {
            this._log('WARN', `[LIVE] Order NOT filled (${orderStatus})`);
            return;
          }
        } catch(e) { this._log('WARN', `Could not verify order: ${e.message}`); }
      }

      // Slippage = |fill price - expected price| (in token probability space, 0-1)
      const slippage = Math.abs(confirmedPrice - signal.entry_price);
      if (slippage > 0.01) {
        this._log('WARN', `[LIVE] Slippage ${(slippage*100).toFixed(2)}% (expected ${signal.entry_price.toFixed(3)}, filled ${confirmedPrice.toFixed(3)})`);
      }

      const evAtEntry = signal.ev_adjusted || signal.expected_value || 0;
      const result = await pool.query(
        `INSERT INTO trades (user_id, condition_id, direction, entry_price, size, model_prob, market_prob, expected_value, fee, paper, order_id, order_status, window_ts, token_id, slippage, ev_at_entry, ev_peak, lag_age_sec, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,$12,$13,$14,$15,$15,$16,NOW()) RETURNING id`,
        [this.userId, market.conditionId, signal.direction, confirmedPrice, confirmedSize,
         signal.model_prob, signal.market_prob, signal.expected_value, signal.fee, orderId, orderStatus, windowTs, tokenId,
         slippage, evAtEntry, signal.lag_age_sec || 0]
      );
      const tradeId = result.rows[0].id;
      this.openTrades.set(tradeId, {
        conditionId: market.conditionId, direction: signal.direction,
        tokenId, entryPrice: confirmedPrice, size: confirmedSize,
        paper: false, orderId, windowTs, confidence: signal.confidence, evAtEntry, evPeak: evAtEntry
      });
      this.recentFlips.push({ ts: Date.now(), direction: signal.direction, ev: evAtEntry });
      this._log('INFO', `[LIVE] ✅ Trade #${tradeId} | ${signal.direction} $${confirmedSize.toFixed(2)} | ${orderStatus} | EV ${(evAtEntry*100).toFixed(1)}% | slippage ${(slippage*100).toFixed(2)}%`);
    } catch(err) {
      this._log('ERROR', `[LIVE] Trade failed: ${err.message}`);
    }
  }

  async _recentWhaleActivity(conditionId) {
    try {
      // Check if any copy target has traded this conditionId in the last 5 minutes
      const result = await pool.query(
        `SELECT direction, COUNT(*) as count
         FROM trades
         WHERE copy_source IS NOT NULL AND condition_id=$1
         AND created_at >= NOW() - INTERVAL '5 minutes'
         GROUP BY direction`,
        [conditionId]
      );
      if (!result.rows.length) return null;
      const up = result.rows.find(r => r.direction === 'UP');
      const down = result.rows.find(r => r.direction === 'DOWN');
      const upCount = up ? parseInt(up.count) : 0;
      const downCount = down ? parseInt(down.count) : 0;
      return upCount >= downCount ? 'UP' : 'DOWN';
    } catch (e) {
      return null; // Non-critical
    }
  }

  async _manageOpenPositions() {
    // Check open trades for early exit conditions (TP/SL)
    // Exit at +20–40% profit (based on confidence) or -4 to -8% loss (based on confidence)
    for (const [tradeId, trade] of this.openTrades.entries()) {
      try {
        if (!trade || !trade.conditionId) continue;

        const result = await pool.query(
          'SELECT id, entry_price, size, result FROM trades WHERE id=$1',
          [tradeId]
        );

        if (!result.rows[0] || result.rows[0].result) {
          this.openTrades.delete(tradeId);
          continue;
        }

        const dbTrade = result.rows[0];
        const entryPrice = parseFloat(dbTrade.entry_price);
        const tradeSize = parseFloat(dbTrade.size);

        // Fetch live token price from Polymarket orderbook
        let currentTokenPrice = null;
        if (trade.tokenId) {
          currentTokenPrice = await this.polymarket.getLiveTokenPrice(trade.tokenId);
        }
        // Fallback: no movement
        if (!currentTokenPrice) currentTokenPrice = entryPrice;

        // Correct P&L: shares * (currentPrice - entryPrice) - fees
        const shares = tradeSize / entryPrice;
        const unrealizedPnL = shares * (currentTokenPrice - entryPrice) - (tradeSize * 0.02);

        // Update EV peak (track highest EV seen for this trade for decay exit)
        // Approximate current EV from token price movement relative to entry
        const currentEV = trade.evAtEntry != null
          ? trade.evAtEntry + (currentTokenPrice - entryPrice) * 0.8
          : null;
        if (currentEV !== null && currentEV > (trade.evPeak || 0)) {
          trade.evPeak = currentEV;
          await pool.query('UPDATE trades SET ev_peak=$1 WHERE id=$2', [trade.evPeak, tradeId]);
        }

        // Dynamic thresholds: scale with confidence and time remaining
        const nowSec = Math.floor(Date.now() / 1000);
        const windowClose = (trade.windowTs || 0) + 300;
        const secsRemaining = Math.max(0, windowClose - nowSec);
        const timeDecay = 1 + (1 - secsRemaining / 300) * 0.5; // Tighten SL as expiry approaches

        const confidence = trade.confidence || 0.5;
        // Higher confidence = wider TP, tighter SL
        const tpPct = 0.20 + (confidence * 0.20);  // 20-40% based on confidence
        const slPct = -(0.08 - confidence * 0.04);  // -8% to -4% based on confidence

        const profitThreshold = tradeSize * tpPct;
        const lossThreshold = tradeSize * slPct * timeDecay;

        let shouldExit = false;
        let exitReason = null;

        if (unrealizedPnL >= profitThreshold) {
          shouldExit = true;
          exitReason = 'auto_closed_profit';
          this._log('INFO', `🎯 TAKE PROFIT | Trade #${tradeId} | +$${unrealizedPnL.toFixed(2)} (${(unrealizedPnL/tradeSize*100).toFixed(1)}%) | TokenPrice: ${currentTokenPrice.toFixed(3)}`);
        } else if (unrealizedPnL <= lossThreshold) {
          shouldExit = true;
          exitReason = 'auto_closed_loss';
          this._log('WARN', `🛑 STOP LOSS | Trade #${tradeId} | $${unrealizedPnL.toFixed(2)} (${(unrealizedPnL/tradeSize*100).toFixed(1)}%) | TokenPrice: ${currentTokenPrice.toFixed(3)}`);
        }

        // EV-DECAY EXIT: if current EV has fallen to <50% of peak AND we're in profit
        // Locks in gains before the edge evaporates entirely
        if (!shouldExit && trade.evPeak != null && currentEV !== null) {
          const evDecayRatio = trade.evPeak > 0 ? currentEV / trade.evPeak : 1;
          if (evDecayRatio < 0.50 && unrealizedPnL > 0) {
            shouldExit = true;
            exitReason = 'ev_decay_profit';
            this._log('INFO', `📉 EV DECAY EXIT | Trade #${tradeId} | EV dropped to ${(evDecayRatio*100).toFixed(0)}% of peak | P&L +$${unrealizedPnL.toFixed(2)}`);
          }
        }

        if (shouldExit) {
          const exitResult = unrealizedPnL > 0 ? 'WIN' : 'LOSS';
          await pool.query(
            `UPDATE trades SET result=$1, pnl=$2, resolved_at=NOW(), order_status=$3, exit_reason=$4 WHERE id=$5`,
            [exitResult, unrealizedPnL, exitReason, exitReason, tradeId]
          );
          // Add back trade size + P&L to paper balance
          if (trade.paper) {
            this.paperBalance += tradeSize + unrealizedPnL;
            await pool.query('UPDATE bot_settings SET paper_balance = $1 WHERE user_id = $2',
              [this.paperBalance, this.userId]);
            this._log('INFO', `[PAPER] Balance updated: $${this.paperBalance.toFixed(2)}`);
          }
          this.openTrades.delete(tradeId);
        }
      } catch(e) {
        this._log('WARN', `Position management error for trade ${tradeId}: ${e.message}`);
      }
    }
  }

  async _checkResolutions() {
    for (const [tradeId, trade] of this.openTrades.entries()) {
      try {
        const windowClose = (trade.windowTs || 0) + 300;
        const nowSec = Math.floor(Date.now() / 1000);

        if (nowSec < windowClose + 10) continue; // Wait at least 10s after close

        const resolution = await this.polymarket.checkResolution(trade.conditionId);
        if (!resolution.resolved) continue;

        const upWon = parseFloat((resolution.outcome || [])[0]) === 1;
        const win = (trade.direction === 'UP' && upWon) || (trade.direction === 'DOWN' && !upWon);

        // Correct P&L: shares = size / entryPrice, profit = shares - size (when win, each share pays $1)
        // Polymarket fee: ~2% on winnings
        const FEE_RATE = 0.02;
        const shares = trade.size / trade.entryPrice;
        const pnl = win ? (shares - trade.size) * (1 - FEE_RATE) : -trade.size;

        await pool.query('UPDATE trades SET result=$1, pnl=$2, resolved_at=NOW() WHERE id=$3',
          [win ? 'WIN' : 'LOSS', pnl, tradeId]);

        const mode = trade.paper ? '[PAPER]' : '[LIVE]';
        this._log('INFO', `${mode} Trade #${tradeId} → ${win ? '✅ WIN' : '❌ LOSS'} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);

        // Add back trade size + P&L to paper balance atomically
        if (trade.paper) {
          const returnAmt = trade.size + pnl;
          const balRes2 = await pool.query(
            'UPDATE bot_settings SET paper_balance = paper_balance + $1 WHERE user_id = $2 RETURNING paper_balance',
            [returnAmt, this.userId]
          );
          this.paperBalance = parseFloat(balRes2.rows[0]?.paper_balance ?? this.paperBalance + returnAmt);
          this._log('INFO', `[PAPER] Balance updated: $${this.paperBalance.toFixed(2)}`);
        }
        this.openTrades.delete(tradeId);
      } catch(err) {
        this._log('ERROR', `Resolution check failed trade #${tradeId}: ${err.message}`);
      }
    }
  }

  async _recordDecision(decision) {
    try {
      await pool.query(
        `INSERT INTO bot_decisions (user_id, verdict, direction, reason, data) VALUES ($1,$2,$3,$4,$5)`,
        [this.userId, decision.verdict, decision.direction || null, decision.reason, JSON.stringify(decision)]
      );
      await pool.query(
        `DELETE FROM bot_decisions WHERE user_id=$1 AND id NOT IN (SELECT id FROM (SELECT id FROM bot_decisions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200) AS recent)`,
        [this.userId]
      );
    } catch(e) {
      console.error(`[Bot:${this.userId}] Decision record failed:`, e.message);
    }
  }

  async _updatePerformanceStats() {
    try {
      const result = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE result IS NOT NULL) as total,
          COUNT(*) FILTER (WHERE result = 'WIN') as wins,
          COALESCE(AVG(ABS(slippage)) FILTER (WHERE slippage IS NOT NULL AND slippage > 0), 0.005) as avg_slippage
        FROM trades
        WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'
      `, [this.userId]);
      const row = result.rows[0];
      const total = parseInt(row.total) || 0;
      const wins = parseInt(row.wins) || 0;
      const winRate = total >= 5 ? wins / total : 0.5; // Need ≥5 trades to trust the rate
      const avgSlippage = parseFloat(row.avg_slippage) || 0.005;
      if (this.engine) {
        this.engine.updatePerformanceStats(winRate, avgSlippage);
      }
      if (total >= 5) {
        this._log('INFO', `📊 Stats updated: win rate ${(winRate*100).toFixed(1)}% (${wins}/${total}) | avg slippage ${(avgSlippage*100).toFixed(3)}%`);
      }
    } catch(e) {
      // Non-critical — keep using last known values
    }
  }

  async _log(level, message) {
    console.log(`[Bot:${this.userLabel}][${level}] ${message}`);
    try {
      await pool.query('INSERT INTO bot_logs (user_id, level, message) VALUES ($1,$2,$3)', [this.userId, level, message]);
      await pool.query(`DELETE FROM bot_logs WHERE user_id=$1 AND id NOT IN (SELECT id FROM (SELECT id FROM bot_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1000) AS recent)`, [this.userId]);
    } catch(e) {}
  }

  getStatus() {
    return {
      is_running: this.isRunning,
      paper_trading: this.paperTrading,
      paper_balance: this.paperBalance,
      open_trades: this.openTrades.size,
      in_snipe_loop: this.inSnipeLoop,
      last_window_ts: this.lastWindowTs,
      market_data: this.lastMarketData
    };
  }

  async stop() {
    this.isRunning = false;
    clearInterval(this.mainTimer);
    clearInterval(this.marketRefreshTimer);
    clearInterval(this.resolutionTimer);
    clearInterval(this.positionMgmtTimer);
    clearInterval(this.statsTimer);
    this.binance.disconnect();
    this.chainlink.stop();
    if (this.polymarket) this.polymarket.disconnect();
    this._log('INFO', 'Bot stopped');
  }
}

module.exports = { BotInstance };
