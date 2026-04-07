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
    // Use email prefix as label (e.g. "mereeffet" from "mereeffet@gmail.com")
    this.userLabel = settings.email ? settings.email.split('@')[0] : `user${userId}`;
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
    this.streamInterval   = null;
    this._obFetchInterval = null; // 1s async loop that fetches YES/NO order books
    this._skipEvalInterval = null; // 2min loop that evaluates resolved skipped_signals
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

      // Start a new trading session — closes lingering open trades, records initial balance
      await this._startSession();

      // Main loop — NOT high-frequency, appropriate for prediction market strategy
      const intervalMs = (this.settings.snipe_timer_seconds || 8) * 1000;
      this.loopInterval = setInterval(() => this._mainLoop(), intervalMs);

      // Real-time streaming loop — 200ms interval, non-blocking, for SSE clients
      this.streamInterval   = setInterval(() => this._broadcastState(), 200);
      // Order book fetcher — 1s async loop, populates YES/NO prices for stream
      this._obFetchInterval = setInterval(() => this._fetchActiveOrderBooks(), 1000);
      // Skip evaluator — every 2 min, resolve any pending skipped_signals
      this._skipEvalInterval = setInterval(() => this._evaluateSkippedSignals(), 120000);

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

    // Save session summary before teardown
    await this._endSession();

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
    if (this._skipEvalInterval) {
      clearInterval(this._skipEvalInterval);
      this._skipEvalInterval = null;
    }

    if (this.binance) this.binance.disconnect();
    if (this.chainlink) this.chainlink.stop();

    // preserveActive=true on graceful shutdown so auto-restart works after deploy
    if (!preserveActive) {
      try {
        await pool.query('UPDATE bot_settings SET is_active = false WHERE user_id = $1', [this.userId]);
      } catch (err) {
        console.error(`[${this.userLabel}] DB update failed on stop:`, err.message);
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

      // --- Evaluate signal FIRST — establishes the single authoritative price for this tick ---
      // Position management and order monitoring consume signal.yesPrice rather than making
      // independent price calls. This eliminates split-brain pricing (0.505 vs 0.700).
      const signal = await this.signalEngine.evaluate();
      await this._logSignal(signal);

      // Staleness guard: if evaluate() threw (caught internally) and returned a stale
      // signal, or if the timestamp is too old, skip position management this tick.
      // Without this, a slow evaluate() could pass a 30s-old price to stop-loss logic.
      const SIGNAL_MAX_AGE_MS = 10000;
      if (!signal?.timestamp || Date.now() - signal.timestamp > SIGNAL_MAX_AGE_MS) {
        this._log('WARN', `[_mainLoop] Signal stale (age=${signal?.timestamp ? Date.now() - signal.timestamp : 'no ts'}ms) — skipping position management`);
        return;
      }

      // --- Monitor pending orders (fill / cancel / adverse-selection) ---
      await this._monitorPendingOrders();

      // --- Manage open positions (EV-based exits + flips) — uses signal.yesPrice ---
      await this._manageOpenPositions(signal);

      // Only proceed to execution on a real TRADE signal
      if (signal.verdict !== 'TRADE') return;

      // --- Directional exposure check ---
      const overexposed = await this._checkDirectionalExposure(signal.direction);
      if (overexposed) return;

      // EV_FLIP: only allowed when existing position is losing (pnlPct < 0).
      // Profitable positions hold to resolution — flipping a winner burns fees needlessly.
      const flipped = await this._checkForFlip(signal);
      if (flipped) return;

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
        // Rate-limit this log to once per minute per trade — it fires every tick otherwise
        const suppressKey = `flipSuppress_${existingTrade.id}`;
        const lastLog = this._flipSuppressLogAt?.[suppressKey] || 0;
        if (Date.now() - lastLog > 60000) {
          this._log('INFO', `⏳ Flip suppressed — position ${holdTimeMin.toFixed(1)}min old (min 2min to reduce noise flips)`);
          if (!this._flipSuppressLogAt) this._flipSuppressLogAt = {};
          this._flipSuppressLogAt[suppressKey] = Date.now();
        }
        return false;
      }

      // Only flip when the existing position is currently losing.
      // A winning position should hold to resolution — flipping burns fees unnecessarily.
      const cachedForFlip = this.signalEngine?._priceCache?.get(existingTrade.market_id);
      if (cachedForFlip?.smoothedPrice != null) {
        const cachedYes = cachedForFlip.smoothedPrice;
        const currentTokenPrice = existingTrade.direction === 'NO' ? 1 - cachedYes : cachedYes;
        const entryP = parseFloat(existingTrade.entry_price);
        const pnlPct = entryP > 0 ? (currentTokenPrice - entryP) / entryP * 100 : 0;
        if (pnlPct >= 0) {
          this._log('INFO', `⏳ Flip skipped — position is profitable (PnL=${pnlPct.toFixed(1)}%), holding to resolution`);
          return false;
        }
        this._log('INFO', `🔻 Position losing (PnL=${pnlPct.toFixed(1)}%) — evaluating flip`);
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

        // Close at the old trade's market price — NOT the new signal's market price.
        // newSignal is for the new market; existingTrade.market_id may differ.
        // Use _priceCache for the old market, fall back to new signal price only if same market.
        let flipLivePriceYes = null;
        if (newSignal.marketId === existingTrade.market_id && newSignal.yesPrice != null) {
          flipLivePriceYes = newSignal.yesPrice;
        } else {
          const cached = this.signalEngine?._priceCache?.get(existingTrade.market_id);
          flipLivePriceYes = cached?.smoothedPrice ?? null;
        }
        const flipTokenPrice = existingTrade.direction === 'NO'
          ? (flipLivePriceYes != null ? 1 - flipLivePriceYes : null)
          : flipLivePriceYes;
        const livePrice = flipTokenPrice ?? parseFloat(existingTrade.entry_price);
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

    // Base threshold from settings (default 5% — BTC oscillation creates 3-4% noise swings)
    // Escalation: +1% per recent flip (last 10 minutes) to suppress whipsaw
    const baseThreshold = parseFloat(this.settings.flip_threshold) || 5.0;
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
    const { direction, tokenId, market, evAdj, modelProb, marketId, fillProb } = signal;
    const TICK = 0.01;

    // Diagnostic: log signal state at execution time
    const ob = signal.orderBook;
    const obDesc = signal.priceSource === 'gamma'
      ? `gamma=${signal.yesPrice?.toFixed(3)} (boundary book — GTC limit execution)`
      : `bestBid=${ob?.bestBid} bestAsk=${ob?.bestAsk} mid=${ob?.midPrice}`;
    console.log(`[_executeTrade] direction=${direction} src=${signal.priceSource} ${obDesc}`);

    // ── 1. Token ID safety check ──────────────────────────────────────────────
    if (!tokenId || tokenId === 'undefined' || tokenId === 'null') {
      this._log('WARN', `[SKIP] No valid tokenId for ${direction} trade — marketId=${marketId}`);
      return;
    }

    // ── 2. Prevent duplicate pending orders for the same token OR same market ──
    const alreadyPending = [...this._pendingOrders.values()].some(
      o => o.tokenId === tokenId || (marketId && o.signal?.marketId === marketId)
    );
    if (alreadyPending) {
      this._log('INFO', `[SKIP] Pending order already exists for token ${tokenId?.slice(0,12)}... — skipping duplicate`);
      return;
    }

    // ── 2b. Prevent multiple open positions in the same market ───────────────
    // Check both DB (open trades) AND in-memory pending orders to catch races
    // where two fills arrive before the second DB insert has committed.
    if (marketId) {
      const hasPendingForMarket = [...this._pendingOrders.values()].some(
        o => o.signal?.marketId === marketId
      );
      if (hasPendingForMarket) {
        this._log('INFO', `[SKIP] Pending order already exists for market ${marketId?.slice(0,12)} — skipping`);
        return;
      }
      const existing = await pool.query(
        "SELECT id FROM trades WHERE user_id=$1 AND status='open' AND market_id=$2",
        [this.userId, marketId]
      );
      if (existing.rows.length > 0) {
        this._log('INFO', `[SKIP] Already have ${existing.rows.length} open position(s) in market ${marketId?.slice(0,12)} — skipping`);
        return;
      }
    }

    // ── 3. Price from signal engine (single source of truth) ────────────────
    // signal.yesPrice is the smoothed, sanity-checked price from GBMSignalEngine.
    // We never call getLastTradePrice() or Gamma here — that was the source of the
    // split-brain pricing bug (0.505 vs 0.700) and fake stop-losses from Gamma jumps.
    const signalYesPrice = signal.yesPrice; // EMA-smoothed — used for Kelly sizing
    if (!signalYesPrice || signalYesPrice <= 0.02 || signalYesPrice >= 0.98) {
      this._log('WARN', `[SKIP] Invalid signal.yesPrice=${signalYesPrice} — skipping`);
      return;
    }
    // rawYesPrice = current Gamma price, unsmoothed — used for limit price calculation.
    // EMA can lag 5-10 ticks on fast-moving markets, causing stale limit prices.
    // Execution must be anchored to NOW, not the smoothed signal price.
    const rawYesPrice = signal.rawPrice ?? signalYesPrice;
    // For Kelly: smoothed price (stable sizing)
    const lastTradePrice = direction === 'NO' ? (1 - signalYesPrice) : signalYesPrice;
    // For limit price: raw/current price (accurate execution)
    const execYesPrice = direction === 'NO' ? (1 - rawYesPrice) : rawYesPrice;

    // ── 5. Tradeable range check (already covered above, kept for clarity) ───
    // (range check included in the guard above)

    // ── 6. Kelly position sizing ──────────────────────────────────────────────
    const mProb = direction === 'NO'
      ? Math.min(0.99, Math.max(0.01, 1 - (modelProb || lastTradePrice)))
      : Math.min(0.99, Math.max(0.01, modelProb || lastTradePrice));
    const b = (1 / lastTradePrice) - 1;
    let kellyFraction = b > 0 ? Math.max(0, (mProb * b - (1 - mProb)) / b) : 0;

    // Adaptive mode: recompute kelly cap from recent trade statistics
    let kellyCap = parseFloat(this.settings.kelly_cap) || 0.10;
    if (this.settings.kelly_mode === 'adaptive') {
      const adaptiveKelly = await this._computeAdaptiveKelly();
      if (adaptiveKelly !== null) {
        kellyCap = adaptiveKelly;
        this._log('INFO', `[Kelly] Adaptive mode: cap=${(kellyCap*100).toFixed(1)}% (from trade stats)`);
      }
    }
    kellyFraction = Math.min(kellyFraction, kellyCap);
    kellyFraction *= (fillProb || 1.0); // scale by expected fill probability from signal

    if (kellyFraction <= 0) {
      this._log('WARN', `[SKIP] Kelly=0 at lastTrade=${lastTradePrice.toFixed(4)}`);
      return;
    }

    const maxTradeDollars = Math.max(1, parseFloat(this.settings.max_trade_size) || 5.00);
    const balance = this.settings.paper_trading ? this.paperBalance : await this._getLiveBalance();
    if (!balance || isNaN(balance) || balance <= 0) {
      this._log('WARN', `Invalid balance=${balance} — skipping`);
      return;
    }

    const tradeSize = Math.min(parseFloat((balance * kellyFraction).toFixed(2)), maxTradeDollars);
    if (tradeSize < 1) {
      this._log('WARN', `[SKIP] Trade size $${tradeSize.toFixed(2)} < $1 minimum`);
      return;
    }
    if (this.settings.paper_trading && this.paperBalance < tradeSize) {
      this._log('WARN', `Insufficient paper balance $${this.paperBalance.toFixed(2)} < $${tradeSize.toFixed(2)}`);
      return;
    }

    // Limit price determination:
    // Priority 1: real CLOB book (spread < 0.90) → use bestAsk (directly fillable)
    // Priority 2: Gamma outcomePrices (boundary-book markets, priceSource='gamma') →
    //             limit = gammaPrice + 1 tick. GTC orders at this price are how real
    //             fills happen on BTC 5-min markets. Paper simulates via Gamma polling.
    let limitPrice = null;

    if (direction === 'NO' && signal.noTokenId) {
      try {
        const noOb = await this.polymarket.getOrderBook(signal.noTokenId);
        const noSpread = noOb?.bestAsk != null && noOb?.bestBid != null ? noOb.bestAsk - noOb.bestBid : 1;
        if (noOb?.bestAsk != null && noSpread < 0.90) {
          limitPrice = parseFloat(Math.max(0.01, noOb.bestAsk).toFixed(2));
        }
      } catch (_) {}
    } else if (direction === 'YES') {
      const yesSpread = ob?.bestAsk != null && ob?.bestBid != null ? ob.bestAsk - ob.bestBid : 1;
      if (ob?.bestAsk != null && yesSpread < 0.90) {
        limitPrice = parseFloat(Math.max(0.01, ob.bestAsk).toFixed(2));
      }
    }

    // Gamma fallback for boundary-book markets — use raw/current price, not EMA
    if (limitPrice == null && signal.priceSource === 'gamma') {
      limitPrice = parseFloat(Math.min(0.98, Math.max(0.02, execYesPrice + TICK)).toFixed(2));
      this._log('INFO', `[gamma] Limit order at Gamma+1tick: ${limitPrice.toFixed(2)} (raw=${rawYesPrice.toFixed(3)} ema=${signalYesPrice.toFixed(3)})`);
    }

    if (limitPrice == null) {
      this._log('WARN', `[SKIP] no_real_liquidity for ${direction} — no CLOB book and no Gamma price`);
      return;
    }

    this._log('INFO', `📊 ${direction} "${market.question?.slice(0,40)}" — ref=${lastTradePrice.toFixed(4)} limit=${limitPrice.toFixed(2)} size=$${tradeSize.toFixed(2)} kelly=${(kellyFraction*100).toFixed(1)}% EV=${evAdj.toFixed(2)}%`);

    // ── 7. Place order and add to pending map ─────────────────────────────────
    const placedAt = Date.now();
    const pendingBase = {
      tokenId, side: 'BUY', limitPrice,
      referencePrice: execYesPrice, // raw price at order creation — for slippage and adverse-selection
      dollarSize: tradeSize,
      direction, market, signal,
      placedAt,
      orderPlacedAt: new Date(placedAt).toISOString(),
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

    const CONFIGURED_TIMEOUT_MS = (parseInt(this.settings.order_timeout_sec) || 60) * 1000;
    const TICK = 0.01;
    const ADVERSE_TICKS = parseInt(this.settings.adverse_ticks) || 8;

    for (const [orderId, pending] of this._pendingOrders) {
      const age = Date.now() - pending.placedAt;

      // ── Timeout: cancel based on market time remaining, not wall clock alone ──
      // On 5-min binary markets, CLOB liquidity is thin for the first 2-3 minutes
      // then builds as expiry approaches. A 10s timeout cancels before any real
      // liquidity appears. Instead: hold up to the configured timeout OR until
      // the market has < 30s remaining (no time to fill before resolution).
      //
      // Effective timeout = min(configuredTimeout, timeUntilMarketExpiry - 30s)
      // This means: on a fresh 5-min market, hold up to 60s (or configured value).
      // With <30s left, cancel immediately if still unfilled — won't resolve in time.
      const marketRemainingSec = this._getMarketRemaining(pending.market?.id || pending.market?.condition_id);
      const marketExpiryBufferMs = 30 * 1000; // cancel 30s before expiry regardless
      const effectiveTimeoutMs = marketRemainingSec != null
        ? Math.min(CONFIGURED_TIMEOUT_MS, Math.max(0, marketRemainingSec * 1000 - marketExpiryBufferMs))
        : CONFIGURED_TIMEOUT_MS;

      if (age > effectiveTimeoutMs) {
        if (!pending.isPaper) {
          try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
        }
        const reason = marketRemainingSec != null && marketRemainingSec < 35
          ? `market expires in ${Math.round(marketRemainingSec)}s`
          : `timeout after ${(age/1000).toFixed(0)}s`;
        this._log('WARN', `⏱️ Order ${orderId.slice(0,12)}... cancelled — ${reason}`);
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

  // Paper fill simulation — checks whether the market price has crossed our limit.
  //
  // Fill logic: a passive buy limit fills when the market offer comes down to our price.
  // For YES: filled when signal.yesPrice <= limitPrice (market offered at our bid)
  // For NO:  filled when signal.noPrice  <= limitPrice
  //
  // Using signal.yesPrice (from the current tick's evaluate() call) ensures the
  // fill simulation reflects the same price that every other component sees.
  async _checkPaperFill(orderId, pending, TICK, ADVERSE_TICKS) {
    const isGamma = pending.signal?.priceSource === 'gamma';

    if (isGamma) {
      // ── Gamma-sourced order: BTC 5-min boundary-book market ──────────────────
      // Fill simulation: poll Gamma outcomePrices as the live market price.
      // A resting GTC limit at gammaPrice+1tick fills when a counterparty crosses it.
      // Simulate: fill if Gamma price stays within ±2 ticks of our limit for ≥2 ticks.
      // Cancel: if price moves > ADVERSE_TICKS away OR market expires.
      const marketId = pending.signal?.marketId;
      const gp = await this.polymarket.getLivePriceFromGamma(marketId, pending.tokenId);
      if (gp == null) return; // no price yet — wait

      const gammaToken = pending.direction === 'NO' ? 1 - gp : gp;
      const ticksFromLimit = (gammaToken - pending.limitPrice) / TICK;

      // Adverse: price moved strongly against our limit
      if (ticksFromLimit > ADVERSE_TICKS) {
        const ageSec = ((Date.now() - pending.placedAt) / 1000).toFixed(1);
        this._log('WARN', `🚫 [PAPER/SIM] Missed trade — adverse move: limit=${pending.limitPrice.toFixed(2)} gamma=${gammaToken.toFixed(3)} (+${ticksFromLimit.toFixed(1)} ticks) age=${ageSec}s`);
        this._pendingOrders.delete(orderId);
        return;
      }

      // Fill condition: price at or below our limit
      const atPrice = gammaToken <= pending.limitPrice;
      if (atPrice) {
        pending.fillConfirmTicks = (pending.fillConfirmTicks || 0) + 1;
      } else {
        pending.fillConfirmTicks = 0;
      }

      this._log('INFO', `📊 [PAPER/SIM] Fill check: limit=${pending.limitPrice.toFixed(2)} gamma=${gammaToken.toFixed(3)} ticks=${ticksFromLimit.toFixed(1)} confirmTicks=${pending.fillConfirmTicks}/2`);

      if (pending.fillConfirmTicks >= 2) {
        const fillPrice = parseFloat(pending.limitPrice.toFixed(2));
        const timeToFillSec = parseFloat(((Date.now() - pending.placedAt) / 1000).toFixed(2));
        const slippageTicks = parseFloat(((fillPrice - pending.referencePrice) / TICK).toFixed(2));
        this._log('INFO', `✅ [PAPER/SIM] Filled: ${pending.direction} @ ${fillPrice.toFixed(4)} gamma=${gammaToken.toFixed(3)} ttf=${timeToFillSec}s slip=${slippageTicks > 0 ? '+' : ''}${slippageTicks} ticks`);
        await this._recordFilledTrade(pending, fillPrice, pending.dollarSize, {
          executionType: 'SIMULATED',
          timeToFillSec,
          fillSlippageTicks: slippageTicks
        });
        this._pendingOrders.delete(orderId);
      }
      return;
    }

    // ── Real CLOB book path ───────────────────────────────────────────────────
    let ob;
    try {
      ob = await this.polymarket.getOrderBook(pending.tokenId);
    } catch (_) {}

    if (!ob) return;

    const spread = ob.bestAsk != null && ob.bestBid != null ? ob.bestAsk - ob.bestBid : 1;
    if (spread >= 0.90) {
      // Book became boundary-only — cancel (can't simulate a real fill)
      this._log('WARN', `🚫 [PAPER] Cancel ${orderId.slice(0,12)} — book became boundary-only (spread=${(spread*100).toFixed(0)}%)`);
      this._pendingOrders.delete(orderId);
      return;
    }

    const bestAsk = ob.bestAsk;
    if (bestAsk == null || bestAsk <= 0) return;

    if (bestAsk > pending.limitPrice + ADVERSE_TICKS * TICK) {
      this._log('WARN', `🚫 [PAPER] Adverse selection: limit=${pending.limitPrice.toFixed(2)} bestAsk=${bestAsk.toFixed(3)} (+${((bestAsk - pending.limitPrice)/TICK).toFixed(0)} ticks) — cancelling`);
      this._pendingOrders.delete(orderId);
      return;
    }

    const atPrice = bestAsk <= pending.limitPrice;
    if (atPrice) {
      pending.fillConfirmTicks = (pending.fillConfirmTicks || 0) + 1;
    } else {
      pending.fillConfirmTicks = 0;
    }

    this._log('INFO', `📊 [PAPER] Fill check: limit=${pending.limitPrice.toFixed(2)} bestAsk=${bestAsk.toFixed(3)} spread=${(spread*100).toFixed(0)}% confirmTicks=${pending.fillConfirmTicks}/2`);

    if (pending.fillConfirmTicks >= 2) {
      const fillPrice = parseFloat(pending.limitPrice.toFixed(2));
      const timeToFillSec = parseFloat(((Date.now() - pending.placedAt) / 1000).toFixed(2));
      const slippageTicks = parseFloat(((fillPrice - pending.referencePrice) / TICK).toFixed(2));
      this._log('INFO', `✅ [PAPER] Filled: ${pending.direction} @ ${fillPrice.toFixed(4)} bestAsk=${bestAsk.toFixed(3)} ttf=${timeToFillSec}s slip=${slippageTicks > 0 ? '+' : ''}${slippageTicks} ticks`);
      await this._recordFilledTrade(pending, fillPrice, pending.dollarSize, {
        executionType: 'SIMULATED',
        timeToFillSec,
        fillSlippageTicks: slippageTicks
      });
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
        const timeToFillSec = parseFloat(((Date.now() - pending.placedAt) / 1000).toFixed(2));
        this._log('INFO', `✅ [LIVE] Order ${orderId.slice(0,12)} MATCHED @ ${pending.limitPrice.toFixed(4)} — $${fillDollars.toFixed(2)} ttf=${timeToFillSec}s`);
        await this._recordFilledTrade(pending, pending.limitPrice, fillDollars, { executionType: 'LIVE', timeToFillSec });
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
        const timeToFillSec = parseFloat(((Date.now() - pending.placedAt) / 1000).toFixed(2));
        this._log('INFO', `📊 [LIVE] Partial fill ${orderId.slice(0,12)}: ${status.sizeMatched.toFixed(2)}/${status.sizeTotal.toFixed(2)} tokens = $${fillDollars.toFixed(2)} ttf=${timeToFillSec}s`);
        try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
        await this._recordFilledTrade(pending, pending.limitPrice, fillDollars, { executionType: 'LIVE', timeToFillSec });
        this._pendingOrders.delete(orderId);
        return;
      }

      // Still LIVE (resting) — check for adverse selection using CLOB mid (no Gamma)
      const liveBook = await this.polymarket.getOrderBook(pending.tokenId);
      const currentPrice = liveBook?.midPrice ?? null;
      if (currentPrice && currentPrice > pending.limitPrice + ADVERSE_TICKS * TICK) {
        this._log('WARN', `🚫 [LIVE] Adverse selection: limit=${pending.limitPrice.toFixed(2)} market=${currentPrice.toFixed(3)} (+${((currentPrice - pending.limitPrice)/TICK).toFixed(0)} ticks) — cancelling order ${orderId.slice(0,12)}`);
        try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
        this._pendingOrders.delete(orderId);
      }

    } catch (err) {
      this._log('WARN', `Order status check failed ${orderId.slice(0,12)}: ${err.message}`);
    }
  }

  // Write confirmed fill to DB and update balance.
  // execInfo: { executionType, timeToFillSec, fillSlippageTicks } — optional, paper only
  async _recordFilledTrade(pending, fillPrice, fillDollars, execInfo = {}) {
    const { direction, market, signal, tokenId } = pending;
    const { confidence, evAdj } = signal;
    const marketId = market?.id || market?.condition_id;

    const executionType = execInfo.executionType || (pending.isPaper ? 'SIMULATED' : 'LIVE');
    const timeToFillSec = execInfo.timeToFillSec ?? null;
    const fillSlippageTicks = execInfo.fillSlippageTicks ?? null;

    if (pending.isPaper) {
      this.paperBalance -= fillDollars;
      await pool.query('UPDATE bot_settings SET paper_balance=$1 WHERE user_id=$2', [this.paperBalance, this.userId]);
    }

    await pool.query(`
      INSERT INTO trades (
        user_id, session_id, market_id, market_question, token_id, direction,
        entry_price, trade_size, size, status, trade_type,
        signal_confidence, ev_adj, gate1_score, gate2_score, gate3_score, scenario,
        execution_type, order_placed_at, time_to_fill_sec, fill_slippage_ticks
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'open','signal',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    `, [
      this.userId, this.sessionId || null, marketId, market?.question, tokenId, direction,
      fillPrice, fillDollars, confidence, evAdj,
      signal.log?.gates?.gate1?.confidence || 0,
      signal.log?.gates?.gate2?.bestEV || 0,
      signal.log?.gates?.gate3?.emaEdge || 0,
      signal.log?.scenario || null,
      executionType,
      pending.orderPlacedAt || null,
      timeToFillSec,
      fillSlippageTicks
    ]);

    this._recordSlippage(pending.referencePrice, fillPrice);

    const slipTicks = fillSlippageTicks ?? (Math.abs(fillPrice - pending.referencePrice) / 0.01);
    this._log('INFO', `📝 [${executionType}] Trade recorded: ${direction} fill=${fillPrice.toFixed(4)} ref=${pending.referencePrice.toFixed(4)} slip=${slipTicks.toFixed(1)}t ttf=${timeToFillSec != null ? timeToFillSec+'s' : 'n/a'} size=$${fillDollars.toFixed(2)} balance=$${(pending.isPaper ? this.paperBalance : 0).toFixed(2)}`);
  }

  // ==========================================
  // POSITION MANAGEMENT — EV-BASED EXITS
  // ==========================================

  async _manageOpenPositions(signal) {
    try {
      const result = await pool.query(
        "SELECT * FROM trades WHERE user_id = $1 AND status = $2",
        [this.userId, 'open']
      );

      if (result.rows.length === 0) return;

      for (const trade of result.rows) {
        // Close legacy trades that pre-date the token_id column — can't manage them
        if (!trade.token_id) {
          this._log('WARN', `Closing legacy trade ${trade.id} — no token_id`);
          await this._closePosition(trade, parseFloat(trade.entry_price), 'LEGACY_NO_TOKEN_ID');
          continue;
        }

        const tradeAgeMin = (Date.now() - new Date(trade.created_at).getTime()) / 60000;

        // ── Single source of truth: signal.yesPrice / signal.rawPrice ──────────
        // signal is evaluated once per tick at the top of _mainLoop.
        //
        // livePrice (smoothed) → all decisions: EV, gates, stop-loss trigger
        // rawLivePrice (unsmoothed) → PnL marking only (more reactive to real moves)
        //
        // For YES trades: token price = yesPrice
        // For NO trades:  token price = noPrice (= 1 - yesPrice)
        let livePrice = null;
        let rawLivePrice = null;
        // Only use signal prices if this signal is for THIS trade's market.
        // Signal is evaluated per-market; using a different market's price gives wrong PnL.
        const signalIsForThisMarket = signal?.marketId != null && signal.marketId === trade.market_id;
        if (signalIsForThisMarket && signal.yesPrice != null) {
          livePrice    = trade.direction === 'NO' ? signal.noPrice          : signal.yesPrice;
          rawLivePrice = trade.direction === 'NO' ? 1 - (signal.rawPrice ?? signal.yesPrice)
                                                  : (signal.rawPrice ?? signal.yesPrice);

          // Desync guard: log if smoothed price jumped >10% relative vs last tick.
          if (trade._cachedLivePrice != null) {
            const relDivergence = Math.abs(trade._cachedLivePrice - livePrice) / trade._cachedLivePrice;
            if (relDivergence > 0.10) {
              this._log('WARN', `⚠️ Desync on trade #${trade.id}: prev=${trade._cachedLivePrice.toFixed(3)} signal=${livePrice.toFixed(3)} divergence=${(relDivergence*100).toFixed(1)}% src=${signal.priceSource}`);
            }
          }
          trade._cachedLivePrice = livePrice;
        }

        // Fallback 1: signal engine price cache — updated every tick for all active markets.
        if (!livePrice && this.signalEngine?._priceCache?.has(trade.market_id)) {
          const cached = this.signalEngine._priceCache.get(trade.market_id);
          if (cached?.smoothedPrice != null) {
            const cachedYes = cached.smoothedPrice;
            livePrice    = trade.direction === 'NO' ? (1 - cachedYes) : cachedYes;
            rawLivePrice = livePrice;
            trade._cachedLivePrice = livePrice;
          }
        }

        // Fallback 2: Gamma API direct fetch — for markets not in current signal window.
        if (!livePrice && trade.market_id) {
          try {
            const gp = await this.polymarket.getLivePriceFromGamma(trade.market_id, trade.token_id);
            if (gp != null) {
              livePrice    = gp;
              rawLivePrice = gp;
              trade._cachedLivePrice = livePrice;
            }
          } catch (_) {}
        }

        // Fallback 3: last known price from cache — prevents src=null on ticks where
        // Gamma API is slow or market just left discovery window.
        if (!livePrice && trade._cachedLivePrice != null) {
          livePrice    = trade._cachedLivePrice;
          rawLivePrice = livePrice;
        }

        if (!livePrice) {
          // No price from signal this tick (signal returned SKIP with yesPrice=null).
          // Check for expired market before giving up.
          if (tradeAgeMin >= 5.5) {
            const resolvedAt = await this._getResolutionPrice(trade.market_id, trade.token_id);
            if (resolvedAt !== null) {
              // Gamma confirmed resolution outcome (clear 1.0 or 0.0)
              this._log('INFO', `⏱️ Market expired — trade #${trade.id} age=${tradeAgeMin.toFixed(1)}min, resolvedAt=${resolvedAt.toFixed(3)}`);
              await this._closePosition(trade, resolvedAt, 'MARKET_RESOLVED');
              this.evEngine.clearMarket(trade.market_id);
              this.signalEngine.clearMarket(trade.market_id);
            } else {
              // Gamma ambiguous (UMA challenge period / outcomePrices=[0.5,0.5]).
              // Fall back to last cached live price rather than entry price (which gives $0 P&L).
              // Wait up to 7min for resolution to finalise before forcing close.
              const fallback = trade._cachedLivePrice ?? null;
              if (tradeAgeMin >= 7.0) {
                const closePrice = fallback ?? parseFloat(trade.entry_price);
                this._log('WARN', `⏱️ Force-closing trade #${trade.id} at ${closePrice.toFixed(3)} (Gamma unresolved at ${tradeAgeMin.toFixed(1)}min, fallback=${fallback != null ? 'cached' : 'entry'})`);
                await this._closePosition(trade, closePrice, 'MARKET_RESOLVED_TIMEOUT');
                this.evEngine.clearMarket(trade.market_id);
                this.signalEngine.clearMarket(trade.market_id);
              } else {
                this._log('WARN', `⏳ Waiting for Gamma resolution on trade #${trade.id} (age=${tradeAgeMin.toFixed(1)}min)`);
              }
            }
          } else {
            this._log('WARN', `No price in signal for trade #${trade.id} (age=${tradeAgeMin.toFixed(1)}min) — holding`);
          }
          continue;
        }

        // Near-resolution detection: token price approaching 0 or 1 = market settling
        if (livePrice >= 0.92 || livePrice <= 0.08) {
          const resolvedAt = livePrice >= 0.92 ? 1.0 : 0.0;
          this._log('INFO', `🏁 Near-resolution detected: price=${livePrice.toFixed(3)} — closing trade #${trade.id} at ${resolvedAt}`);
          await this._closePosition(trade, resolvedAt, 'MARKET_RESOLVED');
          this.evEngine.clearMarket(trade.market_id);
          this.signalEngine.clearMarket(trade.market_id);
          continue;
        }

        // Time-based close at 4.5 min
        if (tradeAgeMin >= 4.5) {
          const resolvedAt = await this._getResolutionPrice(trade.market_id, trade.token_id);
          if (resolvedAt !== null) {
            this._log('INFO', `⏳ Pre-expiry close: trade #${trade.id} age=${tradeAgeMin.toFixed(1)}min resolvedAt=${resolvedAt.toFixed(3)}`);
            await this._closePosition(trade, resolvedAt, 'MARKET_RESOLVED');
            this.evEngine.clearMarket(trade.market_id);
            this.signalEngine.clearMarket(trade.market_id);
            continue;
          }
        }

        const entryPrice = parseFloat(trade.entry_price);
        const marketId = trade.market_id;

        // --- EV-based exit (uses same livePrice from signal) ---
        const btcDelta = this.binance.getWindowDeltaScore(30);
        const latency = this.signalEngine?.microEngine?.detectLatency() || 0;
        const exitLagEdge = latency > 0.3 ? 0.05 : 0;
        const exitBtcEdge = Math.min(Math.abs(btcDelta) * 0.5, 0.15);
        const exitTotalEdge = exitBtcEdge + exitLagEdge;
        const exitBullish = btcDelta > 0;
        const currentModelProb = Math.min(0.99, Math.max(0.01,
          exitBullish ? livePrice + exitTotalEdge : livePrice - exitTotalEdge
        ));

        const currentEV = this.evEngine.calculateAdjustedEV(
          currentModelProb, livePrice,
          trade.direction,
          { spread: 0.01, estimatedSlippage: 0.005, fees: 0.002 }
        );

        this.evEngine.recordEV(marketId, currentEV, trade.direction);

        // PnL uses rawLivePrice (unsmoothed) — the smoothed price lags real moves
        // and would understate losses near resolution. Decisions still use livePrice.
        const pnlPct = (((rawLivePrice ?? livePrice) - entryPrice) / entryPrice) * 100;
        this._log('INFO', `📍 Holding ${trade.direction} on "${trade.market_question?.slice(0,40)}" — EV=${currentEV.toFixed(2)}% smoothed=${livePrice.toFixed(3)} raw=${(rawLivePrice ?? livePrice).toFixed(3)} PnL=${pnlPct.toFixed(1)}% src=${signal.priceSource}`);

        // EXIT CONDITION 1: Time-gated stop-loss
        // pnlPct = (currentTokenPrice - entryPrice) / entryPrice * 100
        // This is a relative price move on the token (0–1 scale), NOT % of bankroll.
        // Example: entry=0.50, current=0.425 → pnlPct = -15%
        //
        // Binary markets naturally swing ±10–20% mid-window. Only stop-loss when:
        //   (a) < 30s remaining — market is nearly resolved, no time to recover
        //   (b) token price dropped > 15% relative — position is structurally wrong
        //
        // The previous -20% threshold was fine as a relative token threshold but
        // with <30s gate it's already too late at -20%. -15% relative with <30s
        // remaining is the appropriate cut: still generous enough to avoid noise
        // closes, tight enough to salvage value before resolution.
        const marketEndSec = trade.market_id
          ? await this._getMarketRemaining(trade.market_id)
          : 300;
        if (marketEndSec < 30 && pnlPct <= -15) {
          // Near resolution: fetch actual Gamma resolution price instead of stale cache.
          // DB showed HARD_STOP_LOSS exits at 0.315/0.155 — stale boundary-book prices,
          // not real resolution values. Use Gamma to get 0.0 or 1.0 if market has settled.
          const resolvedPrice = await this._getResolutionPrice(trade.market_id, trade.token_id);
          const stopPrice = resolvedPrice ?? livePrice;
          this._log('WARN', `🛑 Time-gated stop-loss: PnL ${pnlPct.toFixed(1)}% with ${Math.round(marketEndSec)}s remaining — closing at ${stopPrice.toFixed(3)} (${resolvedPrice != null ? 'resolved' : 'live'})`);
          await this._closePosition(trade, stopPrice, 'HARD_STOP_LOSS');
          this.evEngine.clearMarket(marketId);
          this.signalEngine.clearMarket(marketId);
          continue;
        }

        // EXIT CONDITION 2: DISABLED — NEGATIVE_EV_EXIT
        // DB analysis: 29 exits, 22 at zero P&L (price unchanged on boundary books),
        // avg hold 180s cutting trades that would have resolved naturally at 556s.
        // Binary markets resolve in ≤5 min — hold to resolution captures real edge.
        // EV oscillates on boundary books — a -8% dip is noise, not structural.
        if (false && currentEV < -8) {
          this._log('WARN', `📉 Edge gone: EV=${currentEV.toFixed(2)}% — closing`);
          await this._closePosition(trade, livePrice, 'NEGATIVE_EV_EXIT');
          this.evEngine.clearMarket(marketId);
          this.signalEngine.clearMarket(marketId);
          continue;
        }

        // Otherwise: HOLD to resolution — let the binary market expire naturally.
      }
    } catch (err) {
      this._log('ERROR', `Position management error: ${err.message}`);
    }
  }

  // Returns seconds remaining for a market, or 300 if unknown.
  async _getMarketRemaining(marketId) {
    try {
      const markets = this.polymarket?.marketsCache || [];
      const m = markets.find(x => (x.id || x.condition_id) === marketId);
      if (m?.end_date_iso) {
        return Math.max(0, new Date(m.end_date_iso).getTime() / 1000 - Date.now() / 1000);
      }
    } catch (_) {}
    return 300; // assume plenty of time if unknown
  }

  async _closePosition(trade, exitPrice, reason) {
    try {
      const entryPrice = parseFloat(trade.entry_price);
      // trade_size is the authoritative column; fall back to legacy 'size' column
      const tradeSize = parseFloat(trade.trade_size ?? trade.size);
      // Do NOT use || fallback — exitPrice=0.0 (NO-win) is falsy and would fall back
      // to entryPrice, producing $0 P&L on every NO winner. Use null-coalescing only.
      const effectiveExit = exitPrice != null && isFinite(parseFloat(exitPrice))
        ? parseFloat(exitPrice)
        : entryPrice;

      // Guard: if any value is NaN the PnL calc produces garbage — mark as broken close
      if (!isFinite(entryPrice) || !isFinite(tradeSize) || tradeSize <= 0 || !isFinite(effectiveExit)) {
        this._log('WARN', `Trade ${trade.id} has invalid data (entry=${entryPrice}, size=${tradeSize}, exit=${effectiveExit}) — closing as BREAK_EVEN`);
        await pool.query(
          `UPDATE trades SET status='closed', exit_price=$1, pnl=0, close_reason=$2, result='LOSS', closed_at=NOW() WHERE id=$3`,
          [entryPrice || 0, reason + '_DATA_ERROR', trade.id]
        );
        return;
      }

      // Binary market PnL: we spent tradeSize dollars to buy (tradeSize/entryPrice) shares.
      // At exit each share is worth exitPrice (1.0=win, 0.0=loss, or intermediate for EV exits).
      // Gross PnL = proceeds - cost = (shares * exitPrice) - tradeSize
      // Polymarket fee: 2% on gross winnings only (not applied to losses).
      const POLYMARKET_FEE_RATE = 0.02;
      const shares = tradeSize / entryPrice;
      const grossPnl = shares * effectiveExit - tradeSize;
      const fee = Math.max(0, grossPnl) * POLYMARKET_FEE_RATE;
      const pnl = grossPnl - fee;

      if (!isFinite(pnl) || isNaN(pnl)) {
        this._log('ERROR', `Invalid PnL=${pnl} (entry=${entryPrice}, exit=${effectiveExit}, size=${tradeSize}) — skipping close`);
        return;
      }

      // PnL reconciliation log — always emit so every close is auditable
      this._log('INFO', `📊 PnL reconcile #${trade.id}: entry=${entryPrice.toFixed(4)} exit=${effectiveExit.toFixed(4)} shares=${shares.toFixed(2)} gross=$${grossPnl.toFixed(4)} fee=$${fee.toFixed(4)} net=$${pnl.toFixed(4)} reason=${reason}`);

      const result = pnl >= 0 ? 'WIN' : 'LOSS';
      await pool.query(`
        UPDATE trades SET status = 'closed', exit_price = $1, pnl = $2, close_reason = $3, result = $4, closed_at = NOW()
        WHERE id = $5
      `, [effectiveExit, pnl, reason, result, trade.id]);

      if (this.settings.paper_trading) {
        this.paperBalance = Math.max(0, this.paperBalance + tradeSize + pnl);
        await pool.query('UPDATE bot_settings SET paper_balance = $1 WHERE user_id = $2', [this.paperBalance, this.userId]);
      }

      this._log('INFO', `✅ Closed #${trade.id} ${trade.direction} [${reason}] entry=${entryPrice.toFixed(3)} exit=${effectiveExit.toFixed(3)} size=$${tradeSize.toFixed(2)} gross=$${grossPnl.toFixed(2)} fee=$${fee.toFixed(2)} net=$${pnl.toFixed(2)} (${((pnl/tradeSize)*100).toFixed(1)}%)`);
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
        // YES won — YES token resolves to 1.0, NO token to 0.0
        const isYesToken = clobIds?.[0] === tokenId;
        const isNoToken  = clobIds?.[1] === tokenId;
        if (isYesToken) return 1.0;
        if (isNoToken)  return 0.0;
      } else if (yesPrice0 <= 0.1) {
        // NO won — NO token resolves to 1.0, YES token to 0.0
        const isYesToken = clobIds?.[0] === tokenId;
        const isNoToken  = clobIds?.[1] === tokenId;
        if (isYesToken) return 0.0;
        if (isNoToken)  return 1.0;
      }
      return null; // ambiguous or not yet resolved
    } catch (err) {
      this._log('WARN', `Gamma resolution lookup failed for ${marketId}: ${err.message}`);
      return null;
    }
  }

  // ==========================================
  // SKIP ANALYSIS — RESOLUTION EVALUATOR
  // ==========================================

  /**
   * Runs every 2 minutes. Finds skipped_signals that haven't been evaluated yet,
   * queries Gamma for resolution, and fills in would_win / sim_pnl.
   * Only evaluates markets that are old enough to have resolved (> 6 min since skip).
   */
  async _evaluateSkippedSignals() {
    try {
      const pending = await pool.query(`
        SELECT id, market_id, direction, entry_price, ev_adj
        FROM skipped_signals
        WHERE user_id = $1
          AND evaluated_at IS NULL
          AND direction IS NOT NULL
          AND entry_price IS NOT NULL
          AND created_at < NOW() - INTERVAL '6 minutes'
        LIMIT 20
      `, [this.userId]);

      if (pending.rowCount === 0) return;

      for (const row of pending.rows) {
        try {
          const r = await axios.get(`https://gamma-api.polymarket.com/markets/${row.market_id}`, { timeout: 4000 });
          const m = r.data;
          if (!m || (!m.closed && !m.resolved)) {
            // Not resolved yet — skip for now, will retry next cycle
            continue;
          }

          let outcomePrices = m.outcomePrices;
          if (typeof outcomePrices === 'string') {
            try { outcomePrices = JSON.parse(outcomePrices); } catch (_) { continue; }
          }
          if (!Array.isArray(outcomePrices) || outcomePrices.length < 2) continue;

          const yesResolved = parseFloat(outcomePrices[0]); // 1=YES won, 0=YES lost
          const resolvedPrice = row.direction === 'YES' ? yesResolved : (1 - yesResolved);
          // resolvedPrice: ~1 = token won, ~0 = token lost

          const entryPrice = parseFloat(row.entry_price);
          const tradeSize = 10; // simulate a standard $10 trade
          const shares = tradeSize / entryPrice;
          const grossPnl = shares * resolvedPrice - tradeSize;
          const fee = Math.max(0, grossPnl) * 0.02;
          const simPnl = grossPnl - fee;
          const wouldWin = simPnl > 0;

          await pool.query(`
            UPDATE skipped_signals
            SET resolved_price=$1, would_win=$2, sim_pnl=$3, evaluated_at=NOW()
            WHERE id=$4
          `, [resolvedPrice, wouldWin, parseFloat(simPnl.toFixed(4)), row.id]);
        } catch (_) {
          // Network error for this market — mark as evaluated with nulls so we don't retry forever
          await pool.query(`UPDATE skipped_signals SET evaluated_at=NOW() WHERE id=$1`, [row.id]).catch(() => {});
        }
      }
    } catch (err) {
      // Non-critical background job — log but never throw
      this._log('WARN', `[SkipEval] Error: ${err.message}`);
    }
  }

  // ==========================================
  // TRADING SESSION LIFECYCLE
  // ==========================================

  async _startSession() {
    try {
      // 1. Close any lingering open trades from a previous session.
      // Try to resolve each one at its actual market resolution price before falling back
      // to entry_price (which produces fake $0.00 P&L and distorts stats).
      const lingering = await pool.query(
        "SELECT id, market_id, token_id, entry_price, trade_size, direction FROM trades WHERE user_id=$1 AND status='open'",
        [this.userId]
      );
      if (lingering.rowCount > 0) {
        this._log('INFO', `🔄 Session reset: resolving ${lingering.rowCount} lingering trade(s) from previous session`);
        for (const t of lingering.rows) {
          let resolvedPrice = null;
          try {
            resolvedPrice = await this._getResolutionPrice(t.market_id, t.token_id);
          } catch (_) {}
          const exitPrice = resolvedPrice ?? parseFloat(t.entry_price);
          const tradeSize = parseFloat(t.trade_size);
          const entryPrice = parseFloat(t.entry_price);
          const pnl = isFinite(exitPrice) && isFinite(entryPrice) && entryPrice > 0
            ? (tradeSize / entryPrice) * exitPrice - tradeSize
            : 0;
          // SESSION_RESET_UNKNOWN = market still live at restart, exit=entry, pnl=0 → not a real loss
          // Don't assign WIN/LOSS — null keeps it out of win rate stats
          const result = resolvedPrice != null ? (pnl > 0 ? 'WIN' : 'LOSS') : null;
          const reason = resolvedPrice != null ? 'SESSION_RESET_RESOLVED' : 'SESSION_RESET_UNKNOWN';
          await pool.query(
            `UPDATE trades SET status='closed', close_reason=$1, exit_price=$2, pnl=$3, result=$4, closed_at=NOW() WHERE id=$5`,
            [reason, exitPrice, pnl, result, t.id]
          );
          this._log('INFO', `  └─ #${t.id} ${t.direction} entry=${entryPrice.toFixed(3)} exit=${exitPrice.toFixed(3)} pnl=$${pnl.toFixed(2)} [${reason}]`);
        }
      }

      // 2. Clear in-memory state
      this._pendingOrders.clear();

      // 3. Determine initial balance
      const isPaper = this.settings.paper_trading !== false;
      let initialBalance = isPaper
        ? (this.paperBalance || parseFloat(this.settings.paper_balance) || 1000)
        : (await this._getLiveBalance() || 0);

      // 4. Create session record
      const result = await pool.query(
        `INSERT INTO trading_sessions (user_id, paper_trading, initial_balance) VALUES ($1, $2, $3) RETURNING id`,
        [this.userId, isPaper, initialBalance]
      );
      this.sessionId = result.rows[0].id;
      this._log('INFO', `🟢 Session #${this.sessionId} started — ${isPaper ? 'PAPER' : 'LIVE'} — balance: $${initialBalance.toFixed(2)}`);
    } catch (err) {
      this._log('WARN', `Session start failed: ${err.message} — trades will have null session_id`);
      this.sessionId = null;
    }
  }

  async _endSession() {
    if (!this.sessionId) return;
    try {
      const stats = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='closed') AS total_trades,
          COUNT(*) FILTER (WHERE status='closed' AND pnl > 0) AS wins,
          COUNT(*) FILTER (WHERE status='closed' AND pnl <= 0) AS losses,
          COALESCE(SUM(pnl) FILTER (WHERE status='closed'), 0) AS total_pnl
        FROM trades WHERE user_id=$1 AND session_id=$2
      `, [this.userId, this.sessionId]);

      const s = stats.rows[0];
      const total = parseInt(s.total_trades) || 0;
      const wins = parseInt(s.wins) || 0;
      const winRate = total > 0 ? parseFloat((wins / total * 100).toFixed(2)) : 0;

      const isPaper = this.settings.paper_trading !== false;
      const finalBalance = isPaper
        ? this.paperBalance
        : (await this._getLiveBalance().catch(() => null));

      await pool.query(`
        UPDATE trading_sessions
        SET ended_at=NOW(), final_balance=$1, total_trades=$2, wins=$3, losses=$4, total_pnl=$5, win_rate=$6
        WHERE id=$7
      `, [finalBalance, total, wins, parseInt(s.losses) || 0, parseFloat(s.total_pnl), winRate, this.sessionId]);

      this._log('INFO', `🔴 Session #${this.sessionId} ended — ${total} trades, PnL: $${parseFloat(s.total_pnl).toFixed(2)}, Win rate: ${winRate}%`);
      this.sessionId = null;
    } catch (err) {
      this._log('WARN', `Session end save failed: ${err.message}`);
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
  // ADAPTIVE KELLY
  // ==========================================

  // Compute optimal kelly fraction from last N closed trades.
  // Uses half-Kelly with a 25% hard cap for safety.
  // Returns null if insufficient trade history (< 10 trades).
  async _computeAdaptiveKelly() {
    try {
      const result = await pool.query(`
        SELECT pnl, result, trade_size
        FROM trades
        WHERE user_id = $1 AND result IN ('WIN', 'LOSS') AND pnl IS NOT NULL AND trade_size IS NOT NULL
        ORDER BY closed_at DESC LIMIT 50
      `, [this.userId]);

      const trades = result.rows;
      if (trades.length < 10) return null; // not enough data

      const wins = trades.filter(t => t.result === 'WIN');
      const losses = trades.filter(t => t.result === 'LOSS');
      const winRate = wins.length / trades.length;

      const avgWin = wins.length > 0
        ? wins.reduce((s, t) => s + Math.abs(parseFloat(t.pnl)) / parseFloat(t.trade_size), 0) / wins.length
        : 0;
      const avgLoss = losses.length > 0
        ? losses.reduce((s, t) => s + Math.abs(parseFloat(t.pnl)) / parseFloat(t.trade_size), 0) / losses.length
        : 1;

      if (avgLoss === 0 || avgWin === 0) return null;

      // Full Kelly: W/L - (1-W) where W=winRate, b=avgWin/avgLoss
      const b = avgWin / avgLoss;
      const fullKelly = (winRate * b - (1 - winRate)) / b;

      if (fullKelly <= 0) return 0.05; // losing strategy → minimum sizing

      // Half-Kelly for safety, capped at 25%
      const halfKelly = Math.min(fullKelly * 0.5, 0.25);
      // Floor at 5% — always allocate something if kelly is positive
      return Math.max(halfKelly, 0.05);
    } catch (err) {
      this._log('WARN', `Adaptive kelly computation failed: ${err.message}`);
      return null;
    }
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
    console.log(`[${this.userLabel}] [${level}] ${message}`);
    this.decisionLog.push(entry);
    if (this.decisionLog.length > this.maxLogEntries) this.decisionLog.shift();
  }

  async _logSignal(signal) {
    if (!signal?.log) return;
    if (!this.userId) {
      console.error('[SignalLog ERROR] Missing userId — cannot persist signal');
      return;
    }
    // Write all signals including summary SKIPs — the decision stream needs live data.

    try {
      const gates = signal.log?.gates || {};

      // Gate failure code mapping — includes all known pre-filters and gates
      let gateFailed = null;
      if (signal.verdict === 'SKIP') {
        if (gates.btcFlat        && !gates.btcFlat.passed)        gateFailed = 0.1;
        else if (gates.freshness     && !gates.freshness.passed)      gateFailed = 0.2;
        else if (gates.chase         && !gates.chase.passed)          gateFailed = 0.3;
        else if (gates.evTrend       && !gates.evTrend.passed)        gateFailed = 0.4;
        else if (gates.scenarioFilter && !gates.scenarioFilter.passed) gateFailed = 0.6;
        else if (gates.boundaryBook  && !gates.boundaryBook.passed)   gateFailed = 0.7;
        else if (gates.gate1         && !gates.gate1.passed)          gateFailed = 1;
        else if (gates.gate2         && !gates.gate2.passed)          gateFailed = 2;
        else if (gates.gate3         && !gates.gate3.passed)          gateFailed = 3;
      }

      const evAdjLogged  = signal.evAdj     ?? gates.gate2?.evReal ?? null;
      const spreadLogged = signal.orderBook?.spread ?? gates.gate2?.spread ?? null;
      const lagLogged    = gates.freshness?.lagAge != null ? Math.round(gates.freshness.lagAge) : null;

      console.log('[SignalLog ATTEMPT]', {
        verdict: signal.verdict,
        marketId: signal.marketId || null,
        gateFailed,
        evAdj: evAdjLogged,
        lag: lagLogged,
        spread: spreadLogged
      });

      const marketId = signal.market?.id || signal.marketId || null;
      const marketQuestion = signal.market?.question || null;

      await pool.query(`
        INSERT INTO signals (user_id, market_id, market_question, verdict, reason, direction, confidence, ev_raw, ev_adj, ema_edge, gate1_passed, gate2_passed, gate3_passed, gate_failed, lag_age_sec, spread_pct, scenario)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `, [
        this.userId,
        marketId,
        marketQuestion,
        signal.verdict,
        signal.log?.reason || '',
        signal.direction || null,
        signal.confidence || null,
        signal.evRaw     || null,
        evAdjLogged,
        signal.emaEdge   || null,
        gates.gate1?.passed ?? false,
        gates.gate2?.passed ?? false,
        gates.gate3?.passed ?? false,
        gateFailed,
        lagLogged,
        spreadLogged,
        signal.log?.scenario || null
      ]);

      // Store skipped signals with enough context for post-hoc analysis.
      // Only record when we have a market + direction + entry price — otherwise there's
      // nothing to evaluate against resolution.
      if (signal.verdict === 'SKIP' && marketId && signal.log?.yesPrice != null) {
        const skipReason = signal.log?.skipDetail || (gateFailed != null ? `gate_${gateFailed}` : 'unknown');
        const direction = gates.gate2?.bestDirection || signal.direction || null;
        const entryPrice = direction === 'NO'
          ? (1 - signal.log.yesPrice)
          : signal.log.yesPrice;

        // Only record once per market per skip-reason per 30s window to avoid flooding
        pool.query(`
          INSERT INTO skipped_signals
            (user_id, market_id, market_question, skip_reason, skip_detail, direction, entry_price,
             ev_adj, confidence, btc_delta, remaining_sec, scenario)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
          WHERE NOT EXISTS (
            SELECT 1 FROM skipped_signals
            WHERE user_id=$1 AND market_id=$2 AND skip_reason=$4
              AND created_at > NOW() - INTERVAL '30 seconds'
          )
        `, [
          this.userId,
          marketId,
          marketQuestion,
          skipReason,
          signal.log?.reason?.slice(0, 200) || null,
          direction,
          entryPrice,
          evAdjLogged,
          signal.confidence || gates.gate1?.confidence || null,
          signal.log?.btcDelta != null ? parseFloat(signal.log.btcDelta.toFixed(5)) : null,
          gates.timeGate?.remaining != null ? Math.round(gates.timeGate.remaining) : null,
          signal.log?.scenario || null
        ]).catch(() => {}); // fire-and-forget, never block main flow
      }
    } catch (err) {
      console.error('[SignalLog ERROR]', {
        message: err.message,
        stack: err.stack,
        signal: { verdict: signal?.verdict, marketId: signal?.marketId, hasLog: !!signal?.log }
      });
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

        // Gamma outcomePrices — real market consensus even when CLOB is boundary-only
        let op = m.outcomePrices;
        if (typeof op === 'string') { try { op = JSON.parse(op); } catch (_) { op = null; } }
        const gammaYes = op ? parseFloat(op[0]) : null;
        const gammaNo  = op ? parseFloat(op[1]) : null;

        const clobSpread = yesBook?.spread ?? null;
        const isBoundary = clobSpread == null || clobSpread >= 0.90;

        // yesBid/yesAsk are the actual Polymarket order book prices (match what UI shows)
        // If CLOB is boundary-only, fall back to Gamma price for display
        return {
          id:         m.id || m.condition_id,
          question:   m.question,
          endIso:     m.end_date_iso,
          startIso:   m.start_date_iso,
          yesPrice:   isBoundary ? (gammaYes ?? yesBook?.midPrice ?? null) : (yesBook?.midPrice ?? null),
          noPrice:    isBoundary ? (gammaNo  ?? noBook?.midPrice  ?? null) : (noBook?.midPrice  ?? null),
          yesBid:     yesBook?.bestBid   ?? null,
          yesAsk:     yesBook?.bestAsk   ?? null,
          noBid:      noBook?.bestBid    ?? null,
          noAsk:      noBook?.bestAsk    ?? null,
          spread:     clobSpread,
          bidDepth:   yesBook?.bidDepth  ?? null,
          askDepth:   yesBook?.askDepth  ?? null,
          isBoundary,
          gammaYes,
          gammaNo,
        };
      });

      // Sort markets: most interesting first (furthest from 0.5 = most resolved/active)
      markets.sort((a, b) => {
        const aPrice = a.yesPrice ?? 0.5;
        const bPrice = b.yesPrice ?? 0.5;
        return Math.abs(bPrice - 0.5) - Math.abs(aPrice - 0.5);
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
