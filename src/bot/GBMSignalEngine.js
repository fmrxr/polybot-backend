const EVEngine = require('./EVEngine');
const MicrostructureEngine = require('./MicrostructureEngine');

class GBMSignalEngine {
  constructor(polymarket, binance, chainlink, settings) {
    this.polymarket = polymarket;
    this.binance = binance;
    this.chainlink = chainlink;
    this.settings = settings;
    this.evEngine = new EVEngine();
    this.microEngine = new MicrostructureEngine();

    // EMA for BTC trend (used as confirmation, not primary signal)
    this.emaShort = null;
    this.emaLong = null;
    this.emaAlpha = 0.1;

    // Track signal timestamps for freshness
    this.lastSignalPrices = {}; // marketId -> { price, timestamp }

    // Single-source-of-truth price cache: Map<marketId, { smoothedPrice, priceSource, timestamp }>
    // Keyed ONLY by marketId. Cleared explicitly in clearMarket() — never reset per tick.
    this._priceCache = new Map();
  }

  // Adaptive EMA alpha based on seconds remaining in the 5-min window.
  // Higher alpha = faster reaction. Near expiry, price moves decisively toward 0/1
  // and we need to track it without lag.
  //   >120s: smooth aggressively (noise suppression is the priority)
  //   60–120s: moderate (balance noise vs signal)
  //   <60s: fast (resolution spike must propagate immediately)
  _adaptiveAlpha(remaining) {
    if (remaining == null || remaining > 120) return 0.25;
    if (remaining > 60) return 0.40;
    return 0.65;
  }

  // Smooth price using adaptive alpha. rawPrice is always stored separately so
  // callers can use it for PnL marking without smoothing-induced distortion.
  _smoothPrice(marketId, rawPrice, remaining) {
    // In the final 60s bypass EMA entirely — resolution price moves are real and
    // α=0.25 introduces ~12s lag that causes missed TP/SL exits near expiry.
    if (remaining != null && remaining <= 60) return rawPrice;
    const last = this._priceCache.get(marketId)?.smoothedPrice;
    if (!last) return rawPrice;
    const alpha = this._adaptiveAlpha(remaining);
    return (1 - alpha) * last + alpha * rawPrice;
  }

  // Sanity filter: reject implausible single-tick spikes from CLOB mid-price only.
  // Gamma outcomePrices are NOT filtered — a 10–15%+ Gamma jump is real market
  // consensus (news broke) and is the most valuable update we can receive.
  // CLOB mid threshold: 25% — anything larger is a data artifact, not a real move.
  _sanityCheck(marketId, rawPrice, priceSource) {
    if (priceSource === 'gamma') return rawPrice;
    const last = this._priceCache.get(marketId)?.smoothedPrice;
    if (!last) return rawPrice;
    return Math.abs(rawPrice - last) > 0.25 ? last : rawPrice;
  }

  updateEMA(price) {
    if (!price) return;
    if (this.emaShort === null) {
      this.emaShort = price;
      this.emaLong = price;
    } else {
      this.emaShort = this.emaAlpha * price + (1 - this.emaAlpha) * this.emaShort;
      this.emaLong = (this.emaAlpha / 2) * price + (1 - this.emaAlpha / 2) * this.emaLong;
    }
  }

  /**
   * Main evaluation pipeline
   * 
   * Architecture:
   *   Pre-filters → Model Probability → EV (primary signal) → Confirmation → Trade
   * 
   * This is NOT a scalping bot. It trades on:
   *   - EV as primary signal
   *   - Market inefficiency (lag vs model)
   *   - Dynamic position flipping (YES ↔ NO)
   *   - Short-term probabilistic resolution
   */
  async evaluate() {
    const log = {
      timestamp: new Date().toISOString(),
      gates: {},
      verdict: 'SKIP',
      reason: ''
    };

    try {
      // --- Get current BTC data ---
      // Use last known price so a brief WebSocket drop doesn't block signal evaluation
      const btcPrice = this.binance.getLastKnownPrice();
      const chainlinkPrice = this.chainlink.getPrice();

      if (!btcPrice) {
        log.reason = 'No BTC price available from Binance';
        return { verdict: 'SKIP', log, marketId: null, market: null, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };
      }

      this.updateEMA(btcPrice);

      // --- Fetch active markets ---
      const markets = await this.polymarket.fetchActiveBTCMarkets();
      if (!markets || markets.length === 0) {
        log.reason = 'No active BTC markets found';
        return { verdict: 'SKIP', log, marketId: null, market: null, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };
      }

      // --- Evaluate each market ---
      let lastMarket = null; // track last market seen so SKIP returns can include market context
      for (const market of markets) {
        lastMarket = market;
        const marketId = market.id || market.condition_id;
        log.reason = ''; // reset per-market so stale reasons don't bleed across iterations

        // Gamma API returns clobTokenIds as a JSON string "[\"id1\",\"id2\"]" — must parse it
        // CLOB API returns tokens[].token_id — support both
        let clobIds = market.clobTokenIds;
        if (typeof clobIds === 'string') { try { clobIds = JSON.parse(clobIds); } catch(e) { clobIds = []; } }
        const yesTokenId = market.tokens?.[0]?.token_id || clobIds?.[0];
        const noTokenId  = market.tokens?.[1]?.token_id || clobIds?.[1];

        if (!yesTokenId) {
          console.warn(`[GBMSignalEngine] Market ${marketId} has no token IDs — skipping`);
          continue;
        }

        // ==========================================
        // STEP 1: GET REAL MARKET DATA
        // Price discovery — 3-source waterfall:
        //   1. YES token CLOB order book (most direct)
        //   2. NO token CLOB order book  (token order may be inverted in API)
        //   3. Gamma API tokens[i].price (actual market price from last trade)
        // bid=0.01/ask=0.99 = boundary/resting liquidity only — not a real price.
        // ==========================================

        // Bug 1 fix: Gamma tokens[] objects don't carry .outcome or .price fields.
        // Use outcomePrices[] array for diagnostic prices, default outcomes to YES/NO.
        let op0 = market.outcomePrices;
        if (typeof op0 === 'string') { try { op0 = JSON.parse(op0); } catch(_) { op0 = null; } }
        const t0Price = op0 ? parseFloat(op0[0]) : undefined;
        const t1Price = op0 ? parseFloat(op0[1]) : undefined;
        console.log(`[Tokens] [0] outcome="YES" id=${yesTokenId?.slice(0,12)}... price=${t0Price} | [1] outcome="NO" id=${noTokenId?.slice(0,12)}... price=${t1Price}`);

        const yesBook = await this.polymarket.getOrderBook(yesTokenId);
        const yesSpread = yesBook?.spread ?? (yesBook ? yesBook.bestAsk - yesBook.bestBid : 1);
        console.log(`[OrderBook:YES] bid=${yesBook?.bestBid} ask=${yesBook?.bestAsk} mid=${yesBook?.midPrice} spread=${(yesSpread*100).toFixed(0)}% depth=${yesBook?.totalDepth?.toFixed(0)}`);

        let orderBook = yesBook;
        let rawYesPrice = (yesBook?.midPrice != null && yesSpread <= 0.10) ? yesBook.midPrice : null;
        let priceSource = rawYesPrice != null ? 'clob' : null;

        // Try NO token book if YES is boundary-only (bid=0.01/ask=0.99)
        if (rawYesPrice == null && noTokenId) {
          const noBook = await this.polymarket.getOrderBook(noTokenId);
          const noSpread = noBook?.spread ?? (noBook ? noBook.bestAsk - noBook.bestBid : 1);
          console.log(`[OrderBook:NO]  bid=${noBook?.bestBid} ask=${noBook?.bestAsk} mid=${noBook?.midPrice} spread=${(noSpread*100).toFixed(0)}% depth=${noBook?.totalDepth?.toFixed(0)}`);
          if (noBook?.midPrice != null && noSpread <= 0.10) {
            rawYesPrice = 1 - noBook.midPrice; // YES price derived from NO mid
            orderBook = noBook;
            priceSource = 'clob';
            console.log(`[GBMSignalEngine] YES book boundary-only — using NO book: noMid=${noBook.midPrice.toFixed(3)} yesPrice=${rawYesPrice.toFixed(3)}`);
          }
        }

        // SOURCE 3: Gamma live price — fresh per-tick fetch, NOT cached market.outcomePrices.
        // market.outcomePrices is stale (fetched up to 30s ago). During active trading,
        // the real market price can move significantly (e.g. 0.50 → 0.78) between fetches.
        // getLivePriceFromGamma() does a fresh Gamma /markets/:id call each tick.
        // BTC 5-min markets structurally show boundary CLOB books (bid=0.01/ask=0.99).
        // Execution uses a GTC limit order placed at Gamma price ± 1 tick — this is how
        // real fills happen on these markets (same as the Polymarket UI).
        // Synthetic spread=0.02 so the boundary gate below passes for these markets.
        if (rawYesPrice == null) {
          const gammaYes = await this.polymarket.getLivePriceFromGamma(marketId, yesTokenId);
          if (gammaYes != null && isFinite(gammaYes) && gammaYes > 0.01 && gammaYes < 0.99) {
            rawYesPrice = gammaYes;
            priceSource = 'gamma';
            orderBook = { midPrice: gammaYes, bestAsk: gammaYes + 0.01, bestBid: gammaYes - 0.01, spread: 0.02, totalDepth: yesBook?.totalDepth || 0 };
            console.log(`[GBMSignalEngine] Gamma source (live): yesPrice=${gammaYes.toFixed(3)}`);
          } else {
            // Fallback: use cached outcomePrices if fresh fetch fails or returns ambiguous 0.5
            let op = market.outcomePrices;
            if (typeof op === 'string') { try { op = JSON.parse(op); } catch(_) { op = null; } }
            const cachedYes = op ? parseFloat(op[0]) : null;
            if (cachedYes != null && isFinite(cachedYes) && cachedYes > 0.01 && cachedYes < 0.99) {
              rawYesPrice = cachedYes;
              priceSource = 'gamma';
              orderBook = { midPrice: cachedYes, bestAsk: cachedYes + 0.01, bestBid: cachedYes - 0.01, spread: 0.02, totalDepth: yesBook?.totalDepth || 0 };
              console.log(`[GBMSignalEngine] Gamma source (cached): yesPrice=${cachedYes.toFixed(3)} outcomePrices=${JSON.stringify(op)}`);
            }
          }
        }

        if (rawYesPrice == null || !orderBook) {
          let op = market.outcomePrices;
          if (typeof op === 'string') { try { op = JSON.parse(op); } catch(_) { op = null; } }
          console.log(`[Gamma] outcomePrices=${JSON.stringify(op)} — no usable price from any source, skipping market`);
          continue;
        }

        // Reject near-resolved CLOB prices: token already settling to 0 or 1.
        // Kelly/EV math degrades badly above 0.88 — no tradeable edge remains.
        // Also filters markets that are resolving imminently but CLOB still active.
        if (rawYesPrice >= 0.88 || rawYesPrice <= 0.12) {
          console.log(`[GBMSignalEngine] SKIP — near-resolved CLOB price: yesPrice=${rawYesPrice.toFixed(3)} (outside 0.12–0.88 tradeable range)`);
          continue;
        }

        // Rough seconds-remaining estimate — used for adaptive smoothing alpha.
        // Full remaining calc happens later in the gate pipeline; this is only
        // needed to pick the right alpha before we proceed.
        const roughRemaining = market.end_date_iso
          ? new Date(market.end_date_iso).getTime() / 1000 - Date.now() / 1000
          : 300;

        // Sanity filter: CLOB mid only (Gamma passes through unfiltered).
        const sanitizedPrice = this._sanityCheck(marketId, rawYesPrice, priceSource);
        if (sanitizedPrice !== rawYesPrice) {
          console.log(`[GBMSignalEngine] Sanity filter (CLOB): rawPrice=${rawYesPrice.toFixed(3)} jumped >25% vs last=${this._priceCache.get(marketId)?.smoothedPrice?.toFixed(3)} — using last`);
        }

        // Adaptive EMA: faster near expiry so resolution spikes propagate without lag.
        const yesPrice = this._smoothPrice(marketId, sanitizedPrice, roughRemaining);

        // Commit smoothed price to cache (keyed by marketId, never tokenId).
        // rawYesPrice is preserved separately so _manageOpenPositions can use it
        // for PnL marking without smoothing-induced distortion.
        this._priceCache.set(marketId, { smoothedPrice: yesPrice, priceSource, timestamp: Date.now() });
        const alpha = this._adaptiveAlpha(roughRemaining);
        console.log(`[GBMSignalEngine] price: raw=${rawYesPrice.toFixed(3)} sanity=${sanitizedPrice.toFixed(3)} smoothed=${yesPrice.toFixed(3)} alpha=${alpha} src=${priceSource} remaining=${Math.round(roughRemaining)}s`);

        // Real spread from order book. Gamma-sourced markets carry the actual boundary spread
        // (~0.98) and will be blocked by the boundary book gate below.
        const rawSpread = orderBook.spread ?? (yesBook?.spread) ?? null;
        const spread = rawSpread ?? 0;

        // ==========================================
        // PRE-FILTER A: Signal Freshness
        // Check how old the last Binance tick is (WebSocket-based, not on-chain)
        // Chainlink on-chain BTC/USD updates every 5-30 min — too slow for a 20s threshold
        // ==========================================
        const lastTick = this.binance.priceHistory.length > 0
          ? this.binance.priceHistory[this.binance.priceHistory.length - 1].timestamp
          : 0;
        const lagAgeSeconds = lastTick > 0 ? (Date.now() - lastTick) / 1000 : 999;
        const maxLagAge = this.settings.stale_lag_seconds || 20;

        // Always record lagAge so avg_lag_age computes for ALL signals, not just stale ones
        log.gates.freshness = { lagAge: lagAgeSeconds, max: maxLagAge, passed: lagAgeSeconds <= maxLagAge };

        if (lagAgeSeconds > maxLagAge) {
          log.reason = `Stale BTC data: lag=${lagAgeSeconds.toFixed(1)}s > max=${maxLagAge}s`;
          continue;
        }

        // ==========================================
        // PRE-FILTER B: No-Chase Rule
        // If price moved significantly since we first spotted opportunity, skip
        // ==========================================
        const chaseThreshold = (this.settings.chase_threshold || 8) / 100; // Convert to decimal

        // Bug 2 fix: always update reference price BEFORE the chase check.
        // Old code only updated on pass, so a first-tick skip froze the reference price
        // and caused priceMove to stay identical every tick (permanent freeze).
        const prevSignal = this.lastSignalPrices[marketId];
        this.lastSignalPrices[marketId] = { price: yesPrice, timestamp: Date.now() };

        if (prevSignal) {
          const prevPrice = prevSignal.price;
          const priceMove = Math.abs(yesPrice - prevPrice);
          if (priceMove > chaseThreshold) {
            log.gates.chase = { priceMove, threshold: chaseThreshold, passed: false };
            log.reason = `Chase filter: price moved ${(priceMove*100).toFixed(1)}% > threshold ${(chaseThreshold*100).toFixed(1)}%`;
            continue;
          }
        }

        // ==========================================
        // STEP 2: MODEL PROBABILITY
        // Derive from microstructure + BTC trend
        // ==========================================

        // Record prices for latency detection
        this.microEngine.recordPrices(btcPrice, yesPrice);

        const micro = this.microEngine.composite({
          btcPrice: btcPrice,
          polyPrice: yesPrice,
          bidSize: orderBook.bidDepth,
          askSize: orderBook.askDepth,
          largestBid: orderBook.largestBid,
          largestAsk: orderBook.largestAsk,
          totalDepth: orderBook.totalDepth,
          avgOrderSize: orderBook.totalDepth > 0 ? orderBook.totalDepth / (orderBook.bidCount + orderBook.askCount) : 20,
          bestBid: orderBook.bestBid,
          bestAsk: orderBook.bestAsk
        });

        // ==========================================
        // MODEL PROBABILITY (p_model)
        // Our estimate of P(YES resolves) — anchored to yesPrice + directional edge
        // Sources of edge:
        //   1. BTC directional momentum (scales with % move)
        //   2. Microstructure confidence (order book imbalance / whale / depth)
        //   3. Lag bonus when Polymarket visibly lags BTC
        // ==========================================
        const btcDelta = this.binance.getWindowDeltaScore(60); // % change over 60s (wider window catches moves that quieted in last 30s)
        log.btcDelta = btcDelta;
        log.yesPrice = yesPrice;

        // ==========================================
        // SCENARIO CLASSIFICATION
        // Classify BTC market regime from priceHistory before any gate runs.
        // Used to: block No-Edge zones, boost Lag/Momentum scenarios, detect fake breakouts.
        // ==========================================
        const scenario = this._classifyScenario(btcDelta);
        log.scenario = scenario.type;

        // Scenario 3: Range Chop — NO TRADE (unless Gamma already priced a big move)
        // Scenario 10: News Spike — chaotic, no structure
        // Exception: if Gamma displacement ≥ 5% from 0.5, the market has priced a
        // directional outcome based on earlier BTC move. Gamma IS the signal — skip
        // RANGE_CHOP only. NEWS_SPIKE remains blocked (chaotic fills, no structure).
        // Threshold configurable via settings.range_chop_gamma_override (default 0.04 = 4%).
        // 5% was too strict — markets at 0.545 (4.5% disp) were blocked despite real edge.
        // Default 0.005 (0.5%): any Gamma price ≠ 0.500 carries real edge even in flat BTC.
        // 0.04 was too strict — boundary books always show yesPrice ≈ 0.505 and got blocked constantly.
        const chopOverrideThreshold = parseFloat(this.settings?.range_chop_gamma_override) || 0.005;
        const gammaDisplacementPct = Math.abs(yesPrice - 0.5);
        const gammaOverridesChop = scenario.type === 'RANGE_CHOP' && gammaDisplacementPct >= chopOverrideThreshold;
        if (scenario.noTrade && !gammaOverridesChop) {
          log.gates.scenarioFilter = { type: scenario.type, passed: false };
          log.reason = `Scenario blocked: ${scenario.type}`;
          continue;
        }
        if (gammaOverridesChop) {
          log.scenario = 'RANGE_CHOP_GAMMA_OVERRIDE';
          log.gates.scenarioFilter = { type: scenario.type, passed: true, note: `Gamma disp=${gammaDisplacementPct.toFixed(3)} ≥ ${chopOverrideThreshold}` };
        }

        // Skip flat-BTC windows — no directional signal means EV ≈ -cost only.
        // Exception: if Gamma price is already meaningfully off 0.5 (|yesPrice - 0.5| > 0.01),
        // the market has priced a directional move we may still have edge on.
        const gammaPriceSignificant = Math.abs(yesPrice - 0.5) > 0.01;
        const minBtcDelta = parseFloat(this.settings?.min_btc_delta) || 0.005;
        if (Math.abs(btcDelta) < minBtcDelta && !gammaPriceSignificant) {
          log.gates.btcFlat = { btcDelta, minBtcDelta, yesPrice, passed: false };
          log.reason = `BTC flat: |delta|=${Math.abs(btcDelta).toFixed(3)}% < ${minBtcDelta}% and Gamma near 0.5`;
          continue;
        }

        // Map to probability edge: 0.1% BTC move → 0.05 (5%), cap 0.15
        const btcEdge = Math.min(Math.abs(btcDelta) * 0.5, 0.15);
        const microEdge = micro.confidence * 0.10; // up to 10% from order book

        // lagBonus is NOT added to modelProb — it's an execution signal, not a probability estimate
        const hasLag = micro.hasMarketLag;

        const totalEdge = btcEdge + microEdge;

        const bullish = btcDelta > 0.015;
        const bearish = btcDelta < -0.015;

        // When BTC is flat but Gamma has already priced a directional move (yesPrice ≠ 0.5),
        // treat the Gamma displacement as the directional signal.
        // yesPrice=0.485 → market expects NO outcome → bearish signal even with flat BTC.
        // yesPrice=0.515 → market expects YES outcome → bullish signal.
        // This preserves EV when BTC momentarily pauses after already having moved.
        const gammaDisplacement = yesPrice - 0.5; // + = market priced YES, - = priced NO
        const gammaBullish = !bullish && !bearish && gammaDisplacement > 0.01;
        const gammaBearish = !bullish && !bearish && gammaDisplacement < -0.01;

        let modelProb;
        if (bullish || gammaBullish) {
          modelProb = Math.min(0.99, Math.max(0.01, yesPrice + totalEdge));
        } else if (bearish || gammaBearish) {
          modelProb = Math.max(0.01, Math.min(0.99, yesPrice - totalEdge));
        } else {
          modelProb = yesPrice; // flat BTC + flat Gamma → no edge → EV ≈ 0 → filtered by Gate 2
        }

        // ==========================================
        // GATE 1: MICROSTRUCTURE CONFIDENCE (informational — not a hard block)
        // Low confidence just means smaller edge, not a skip
        // Hard block would make Gate 1 impossible on thin books (confidence rarely reaches 0.45)
        // ==========================================
        const gate1Threshold = parseFloat(this.settings.gate1_threshold) || 0.45;

        log.gates.gate1 = {
          confidence: micro.confidence,
          threshold: gate1Threshold,
          hasLag: micro.hasMarketLag,
          passed: micro.confidence >= gate1Threshold  // informational only — Gate 2 EV is the real filter, no hard block here
        };

        // ==========================================
        // GATE 2: EV ANALYSIS (PRIMARY SIGNAL)
        // Spread is a COST COMPONENT, not a gate
        // ==========================================
        const costs = {
          spread: 0, // limit orders at mid — not crossing the spread, real cost is slippage + fees only
          estimatedSlippage: 0.005,
          fees: 0.002
        };

        // Window timing — compute before depth/EV checks so we can skip mid-window
        const marketEndSec = market.end_date_iso
          ? new Date(market.end_date_iso).getTime() / 1000
          : (market.resolution_time || market.end_time || 0);
        const marketStartSec = market.start_date_iso
          ? new Date(market.start_date_iso).getTime() / 1000
          : (market.start_time || marketEndSec - 300);
        const nowSec = Date.now() / 1000;
        const elapsed = nowSec - marketStartSec;
        const remaining = marketEndSec - nowSec;

        // TIME GATE: trade ONLY in the opening window OR the closing window.
        // Opening window: elapsed ≤ earlyWindowSec — fresh mispricing, widest spread.
        // Closing window: remaining ≤ lateWindowSec — resolution momentum, price locked in.
        // Middle period: skip — market is efficiently priced, no structural edge.
        //
        // For 5-min markets (300s): lateWindowSec=600 always covers the full window → always pass.
        // For 15-min+ markets: skip the middle unless in the first earlyWindowSec.
        // Configurable via settings.early_window_sec / late_window_sec (defaults: 100 / 600).
        // Skip pre-open markets (market hasn't started yet — elapsed < 0)
        if (elapsed < 0) {
          log.reason = `Pre-open: market starts in ${Math.round(-elapsed)}s — skip`;
          continue;
        }

        // Skip expired markets
        if (remaining <= 0) {
          log.reason = `Expired: market ended ${Math.round(-remaining)}s ago — skip`;
          continue;
        }

        // TIME GATE: only trade in the last 300s (5 min) of any market.
        // 5-min markets → always in window. 15-min+ → only last 5 min.
        const TRADE_WINDOW_SEC = 300;
        if (remaining > TRADE_WINDOW_SEC) {
          log.gates.timeGate = { remaining: Math.round(remaining), window: TRADE_WINDOW_SEC, passed: false };
          log.reason = `Outside trade window: ${Math.round(remaining)}s remaining > ${TRADE_WINDOW_SEC}s — wait for last 5 min`;
          continue;
        }
        log.gates.timeGate = { remaining: Math.round(remaining), window: TRADE_WINDOW_SEC, passed: true };

        // BOUNDARY BOOK GUARD: bid=0.01/ask=0.99 means no real liquidity at fair value.
        // Entry price must be near bestAsk — on a boundary book, bestAsk=0.99 is a ghost
        // resting order, NOT a fillable price. Never trade when spread >= 0.90.
        // Gamma may be used for signal generation only, never for execution or PnL.
        const isBoundaryBook = spread >= 0.90;
        if (isBoundaryBook) {
          log.gates.boundaryBook = { spread, passed: false };
          log.reason = `no_liquidity_boundary_book (spread=${(spread*100).toFixed(0)}%) — bestAsk=0.99 is a ghost order, not a real price`;
          continue;
        }
        log.gates.boundaryBook = { spread, passed: true };

        // DEPTH FLOOR: avoid thin real books (< 100 USDC total depth)
        const totalDepth = orderBook.totalDepth || 0;
        if (totalDepth < 100) {
          log.reason = `Thin book: depth=${totalDepth.toFixed(0)} USDC < 100 min`;
          continue;
        }

        // Fill probability: spread-adjusted depth score for real CLOB books only.
        const spreadPenalty = Math.max(0, 1 - spread * 5); // 10% spread → 0.5, 20% → 0
        const fillProb = Math.min(1.0, (totalDepth / 500) * spreadPenalty);

        // Evaluate BOTH sides — check EV directly against floor (no fillProb penalty)
        const evAnalysis = this.evEngine.evaluateBothSides(modelProb, yesPrice, costs);
        const evReal = evAnalysis.bestEV;

        let evFloor = parseFloat(this.settings.gate2_ev_floor) || 0.5;

        // Scenario 9: Cross-Market Lag — strongest edge, ease floor significantly
        if (scenario.type === 'LAG_EDGE') evFloor *= 0.65;

        // Scenario 1: Momentum Breakout — confirmed continuation, ease floor
        else if (scenario.type === 'MOMENTUM_BREAKOUT') evFloor *= 0.80;

        // Scenario 4: Volatility Expansion — trade with direction but require more conviction
        else if (scenario.type === 'VOLATILITY_EXPANSION') evFloor *= 0.90;

        // Scenario 2: Fake Breakout — price already reversed, tighten floor (only trade if EV is very clear)
        else if (scenario.type === 'FAKE_BREAKOUT') evFloor *= 1.50;

        // Lag detected (microstructure): high-priority execution, ease floor slightly
        if (hasLag && elapsed < 60) evFloor *= 0.8;

        // Separate fill quality gate: don't enter if book is too thin to fill reliably
        if (fillProb < 0.25) {
          log.reason = `Low fill probability: ${(fillProb*100).toFixed(0)}% (depth=${totalDepth.toFixed(0)} spread=${(spread*100).toFixed(0)}%)`;
          continue;
        }

        log.gates.gate2 = {
          evYes: evAnalysis.evYes,
          evNo: evAnalysis.evNo,
          bestDirection: evAnalysis.bestDirection,
          bestEV: evAnalysis.bestEV,
          evReal,
          fillProb,
          evFloor,
          spread,
          modelProb,
          elapsed: Math.round(elapsed),
          remaining: Math.round(remaining),
          passed: evReal >= evFloor
        };

        console.log(`[GBMSignalEngine] Gate2: btcDelta=${btcDelta.toFixed(3)}% modelProb=${modelProb.toFixed(3)} yesPrice=${yesPrice.toFixed(3)} EV=${evAnalysis.bestEV.toFixed(2)}% fillProb=${(fillProb*100).toFixed(0)}% floor=${evFloor.toFixed(2)}% depth=${totalDepth.toFixed(0)} remaining=${Math.round(remaining)}s`);

        if (evReal < evFloor) {
          log.gates.gate2.passed = false;
          log.reason = `EV ${evReal.toFixed(2)}% below floor ${evFloor.toFixed(2)}%`;
          continue;
        }

        log.gates.gate2.passed = true;

        // ==========================================
        // EV TREND FILTER: velocity + acceleration
        // Bug 4 fix: recordEV() must come AFTER the decay/velocity checks.
        // Old code recorded the current tick first, so isEVDecaying() compared
        // current tick against itself — a single observation always appears flat
        // or decaying, blocking valid signals on the first pass.
        // ==========================================
        // EV trend filter: only block if EV is actively collapsing, not just ticking down.
        // Two conditions must BOTH be true to skip:
        //   1. isEVDecaying: velocity<0 AND acceleration<=0 (sustained deceleration)
        //   2. evVelocity drop exceeds absolute floor of 1.0% — prevents blocking a
        //      22%→21.9% move (noise) while still catching 10%→5%→2% collapse.
        const evVelocity = this.evEngine.getEVVelocity(marketId);
        // evTrend filter: only block on sustained, rapid EV collapse.
        // Raised default floor to 8.0 — BTC 5-min markets oscillate ±3-5% per tick
        // (boundary books + Gamma lag). A 3% drop is noise, not a collapse signal.
        // Only block when EV is both decaying AND drops >8% in a single tick.
        const evDecayRatio = parseFloat(this.settings?.ev_decay_ratio) || 8.0;
        const EV_VELOCITY_FLOOR = -1.0 * evDecayRatio;
        if (this.evEngine.isEVDecaying(marketId) && evVelocity < EV_VELOCITY_FLOOR) {
          log.gates.evTrend = { status: 'DECAYING', velocity: evVelocity.toFixed(2), floor: EV_VELOCITY_FLOOR, passed: false };
          log.reason = `EV collapsing: velocity=${evVelocity.toFixed(2)} < floor=${EV_VELOCITY_FLOOR}`;
          continue;
        }

        // Record EV now that checks passed — informs the NEXT tick's trend check
        this.evEngine.recordEV(marketId, evReal, evAnalysis.bestDirection);

        // ==========================================
        // GATE 3: BTC MOMENTUM DIRECTION CONFIRMATION (optional)
        // Uses btcDelta (30s window) — same signal driving EV, no lag.
        // Replaces slow EMA which had ~11min half-life and always conflicted
        // with short-term momentum signals on 5-min binary markets.
        // ==========================================
        const direction = evAnalysis.bestDirection;
        let emaEdge = btcDelta; // kept as emaEdge for return object compatibility

        if (this.settings.gate3_enabled !== false) {
          // btcDelta > 0 = BTC rising (bullish), < 0 = falling (bearish)
          const isBullish = btcDelta > 0;
          const minDelta = parseFloat(this.settings.gate3_min_delta) || 0.01;

          log.gates.gate3 = {
            btcDelta,
            minDelta,
            direction,
            passed: false
          };

          // When BTC signal is weak (|btcDelta| < minDelta), direction is unreliable —
          // skip the direction check and let EV gate decide. Gamma displacement already
          // priced a directional move in this case; blocking it here is over-filtering.
          const btcSignalWeak = Math.abs(btcDelta) < minDelta;

          if (!btcSignalWeak) {
            // Direction alignment: YES needs BTC rising, NO needs BTC falling
            if (direction === 'YES' && !isBullish) {
              log.gates.gate3 = { btcDelta, minDelta, direction, passed: false, reason: 'direction_mismatch' };
              log.reason = `Gate3 direction mismatch: signal=YES but BTC falling (delta=${btcDelta.toFixed(3)}%)`;
              continue;
            }
            if (direction === 'NO' && isBullish) {
              log.gates.gate3 = { btcDelta, minDelta, direction, passed: false, reason: 'direction_mismatch' };
              log.reason = `Gate3 direction mismatch: signal=NO but BTC rising (delta=${btcDelta.toFixed(3)}%)`;
              continue;
            }
          }

          log.gates.gate3.passed = true;
          log.gates.gate3.note = btcSignalWeak ? 'weak_btc_skipped_direction_check' : 'direction_confirmed';
        }

        // ==========================================
        // ALL GATES PASSED — GENERATE SIGNAL
        // ==========================================
        // entryPrice = token mid price (0–1) — used for Kelly market probability.
        // For YES: mid of YES token. For NO: 1 - YES mid (= NO token mid).
        // Do NOT use bestAsk/bestBid here — wide spreads on illiquid markets
        // make b=(1/entry)-1 collapse to ~0 and kill Kelly even on valid signals.
        const entryPrice = direction === 'YES' ? yesPrice : (1 - yesPrice);
        const tokenId = direction === 'YES' ? yesTokenId : (noTokenId || yesTokenId);

        // Signal quality confidence — reflects actual outcome predictors.
        const momentumScore   = Math.min(Math.abs(btcDelta) / 0.10, 1.0);
        const evScore         = Math.min(Math.max(0, evAnalysis.bestEV) / 15.0, 1.0);
        const convictionScore = Math.abs(modelProb - 0.5) * 2;
        const timeScore       = Math.min(remaining / 240, 1.0);
        const microScore      = micro.confidence || 0;
        let rawConfidence =
          momentumScore   * 0.45 +
          evScore         * 0.30 +
          convictionScore * 0.15 +
          timeScore       * 0.05 +
          microScore      * 0.05;

        // Scenario confidence adjustments
        if (scenario.type === 'LAG_EDGE')           rawConfidence = Math.min(1.0, rawConfidence * 1.20); // +20% on best edge
        if (scenario.type === 'MOMENTUM_BREAKOUT')  rawConfidence = Math.min(1.0, rawConfidence * 1.10); // +10%
        if (scenario.type === 'FAKE_BREAKOUT')      rawConfidence *= 0.70; // -30% on unreliable setup
        if (scenario.type === 'MEAN_REVERSION')     rawConfidence *= 0.85; // -15% on counter-trend

        const signalConfidence = parseFloat(rawConfidence.toFixed(3));

        // Confidence gate — skip if signal quality is too low (noise, not edge).
        // Threshold lowered to 0.15 (was 0.20) — weak but valid signals now pass.
        if (signalConfidence < 0.15) {
          log.gates.confidence = { value: signalConfidence, threshold: 0.15, passed: false };
          log.reason = `Low confidence: ${signalConfidence.toFixed(3)} < 0.15 — insufficient signal quality`;
          continue;
        }

        log.verdict = 'TRADE';
        log.reason = `EV-driven signal: ${direction} @ EV ${evAnalysis.bestEV.toFixed(2)}%, confidence=${signalConfidence.toFixed(3)}, modelProb=${modelProb.toFixed(3)}`;

        return {
          verdict: 'TRADE',
          market: market,
          marketId: marketId,
          direction: direction,
          scenario: scenario.type,
          confidence: signalConfidence,
          evRaw: direction === 'YES' ? evAnalysis.evYes + (costs.spread + costs.estimatedSlippage + costs.fees) * 100 : evAnalysis.evNo + (costs.spread + costs.estimatedSlippage + costs.fees) * 100,
          evAdj: evAnalysis.bestEV,
          evYes: evAnalysis.evYes,
          evNo: evAnalysis.evNo,
          emaEdge: emaEdge,
          modelProb: modelProb,
          entryPrice: entryPrice,
          fillProb: fillProb,
          tokenId: tokenId,
          noTokenId: noTokenId || null,
          orderBook: orderBook,
          microstructure: micro,
          costs: costs,
          log: log,
          // Single-source-of-truth price fields — BotInstance must use ONLY these.
          // yesPrice: smoothed — used for all decisions (EV, entries, exits, gates)
          // rawPrice: unsmoothed — used ONLY for PnL marking (more reactive to real moves)
          yesPrice: yesPrice,
          rawPrice: rawYesPrice,
          noPrice: 1 - yesPrice,
          priceSource: priceSource,
          timestamp: Date.now()
        };
      }

      // No market passed — log summary of what happened
      const gateNames = Object.keys(log.gates);
      const failedAt = gateNames.find(k => log.gates[k]?.passed === false) || 'all_markets_skipped';
      log.verdict = 'SKIP';
      log.reason = log.reason || 'No market passed all gates';
      log.skipDetail = failedAt;
      const lastMarketId = lastMarket ? (lastMarket.id || lastMarket.condition_id) : null;

      // Rich skip log: show exactly what blocked the best candidate market
      const skipCtx = {
        gate: failedAt,
        reason: log.reason,
        btcDelta: log.btcDelta != null ? `${log.btcDelta.toFixed(3)}%` : null,
        yesPrice: log.yesPrice != null ? log.yesPrice.toFixed(3) : null,
        evAdj: log.gates?.gate2?.bestEV != null ? `${log.gates.gate2.bestEV.toFixed(2)}%` : null,
        evFloor: log.gates?.gate2?.evFloor != null ? `${log.gates.gate2.evFloor.toFixed(2)}%` : null,
        confidence: log.gates?.gate1?.confidence != null ? log.gates.gate1.confidence.toFixed(3) : null,
        remaining: log.gates?.timeGate?.remaining != null ? `${log.gates.timeGate.remaining}s` : null,
        scenario: log.scenario || null,
      };
      // Filter nulls for cleaner output
      const skipCtxClean = Object.fromEntries(Object.entries(skipCtx).filter(([,v]) => v != null));
      console.log(`[GBMSignalEngine] SKIP [${failedAt}]`, JSON.stringify(skipCtxClean));

      return { verdict: 'SKIP', log, marketId: lastMarketId, market: lastMarket, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };

    } catch (err) {
      console.error('[GBMSignalEngine] evaluate error:', err.message);
      log.verdict = 'ERROR';
      log.reason = `Evaluation error: ${err.message}`;
      return { verdict: 'ERROR', log, marketId: null, market: null, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };
    }
  }

  /**
   * Classify the current BTC market regime into one of 10 scenarios.
   * Uses priceHistory (120 ticks, ~2 min) to detect structure.
   *
   * Returns: { type, noTrade, description }
   *
   * Scenarios mapped:
   *   MOMENTUM_BREAKOUT   — Scenario 1: strong push, no wick rejection
   *   FAKE_BREAKOUT       — Scenario 2: broke level then instantly reversed
   *   RANGE_CHOP          — Scenario 3: price stuck, no momentum → NO TRADE
   *   VOLATILITY_EXPANSION— Scenario 4: tight consolidation → sudden breakout
   *   WHALE_ABSORPTION    — Scenario 5: price refusing to move despite pressure
   *   MEAN_REVERSION      — Scenario 6: overextension, momentum slowing
   *   LATE_ENTRY          — Scenario 7: move already happened → NO TRADE (handled by chase filter upstream)
   *   MOMENTUM_FADE       — Scenario 8: trend weakening, smaller candles
   *   LAG_EDGE            — Scenario 9: Binance leads, Polymarket lags → best edge
   *   NEWS_SPIKE          — Scenario 10: instant chaotic spike → NO TRADE
   *   NORMAL              — no special regime, standard gate pipeline applies
   */
  _classifyScenario(btcDelta) {
    const history = this.binance?.priceHistory;
    if (!history || history.length < 10) return { type: 'NORMAL', noTrade: false };

    const recent = history.slice(-30);  // last 30 ticks (~30s)
    const prices = recent.map(h => h.price);
    const latest = prices[prices.length - 1];

    // Volatility: std deviation of last 30 ticks
    const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
    const variance = prices.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    const relStdDev = stdDev / mean; // normalised

    // Max range over last 30 ticks
    const hi = Math.max(...prices);
    const lo = Math.min(...prices);
    const range = (hi - lo) / mean;

    // Wick ratio: |high - close| / total range — proxy for rejection wick
    const open30 = prices[0];
    const bodySize = Math.abs(latest - open30) / mean;
    const upperWick = hi > Math.max(latest, open30) ? (hi - Math.max(latest, open30)) / mean : 0;
    const lowerWick = lo < Math.min(latest, open30) ? (Math.min(latest, open30) - lo) / mean : 0;
    const wickRatio = bodySize > 0 ? Math.max(upperWick, lowerWick) / (bodySize + 0.0001) : 0;

    // Velocity trend: compare first half vs second half delta
    const half = Math.floor(prices.length / 2);
    const firstHalfDelta = (prices[half] - prices[0]) / prices[0] * 100;
    const secondHalfDelta = (prices[prices.length - 1] - prices[half]) / prices[half] * 100;
    const fadingMomentum = Math.abs(secondHalfDelta) < Math.abs(firstHalfDelta) * 0.5;

    // Lag scenario: microstructure detects Polymarket lagging Binance
    // Checked externally — passed as btcDelta being strong with freshness passing
    const absbtcDelta = Math.abs(btcDelta);

    // Scenario 10: NEWS SPIKE — instant large chaotic move
    // >0.15% in 30s AND large wicks (chaotic) OR very high volatility
    if (absbtcDelta > 0.15 && (wickRatio > 1.5 || relStdDev > 0.0015)) {
      return { type: 'NEWS_SPIKE', noTrade: true, description: `Chaotic spike: Δ${btcDelta.toFixed(3)}% wick=${wickRatio.toFixed(2)} vol=${relStdDev.toFixed(5)}` };
    }

    // Scenario 3: RANGE CHOP — very low range, no direction
    // <0.03% range in 30s AND btcDelta small
    if (range < 0.0003 && absbtcDelta < 0.02) {
      return { type: 'RANGE_CHOP', noTrade: true, description: `Range chop: range=${(range*100).toFixed(4)}% Δ=${btcDelta.toFixed(3)}%` };
    }

    // Scenario 2: FAKE BREAKOUT — broke out then reversed with rejection wick
    // Large initial move but now reversing, significant wick against direction
    const reversing = (btcDelta > 0 && secondHalfDelta < -0.01) ||
                      (btcDelta < 0 && secondHalfDelta > 0.01);
    if (reversing && wickRatio > 1.2 && absbtcDelta > 0.04) {
      return { type: 'FAKE_BREAKOUT', noTrade: false, description: `Fake breakout: reversal detected wick=${wickRatio.toFixed(2)} 2ndΔ=${secondHalfDelta.toFixed(3)}%` };
    }

    // Scenario 9: LAG EDGE — strong BTC move + microstructure lag (best edge)
    // Detected upstream by hasLag; here we just check BTC is strongly directional
    if (absbtcDelta > 0.05 && !fadingMomentum && wickRatio < 0.8) {
      return { type: 'LAG_EDGE', noTrade: false, description: `Lag edge candidate: Δ=${btcDelta.toFixed(3)}% clean momentum` };
    }

    // Scenario 1: MOMENTUM BREAKOUT — strong clean directional move, low wicks
    if (absbtcDelta > 0.03 && wickRatio < 0.6 && !fadingMomentum) {
      return { type: 'MOMENTUM_BREAKOUT', noTrade: false, description: `Momentum breakout: Δ=${btcDelta.toFixed(3)}% wick=${wickRatio.toFixed(2)}` };
    }

    // Scenario 4: VOLATILITY EXPANSION — was compressed, now expanding
    const prevRange = history.length >= 60
      ? (() => { const p = history.slice(-60, -30).map(h => h.price); return (Math.max(...p) - Math.min(...p)) / p[0]; })()
      : range;
    if (range > prevRange * 2.0 && absbtcDelta > 0.02) {
      return { type: 'VOLATILITY_EXPANSION', noTrade: false, description: `Vol expansion: range=${(range*100).toFixed(4)}% vs prev=${(prevRange*100).toFixed(4)}%` };
    }

    // Scenario 8: MOMENTUM FADE — trend losing strength
    if (fadingMomentum && absbtcDelta > 0.02) {
      return { type: 'MOMENTUM_FADE', noTrade: false, description: `Momentum fade: 1stΔ=${firstHalfDelta.toFixed(3)}% → 2ndΔ=${secondHalfDelta.toFixed(3)}%` };
    }

    // Scenario 6: MEAN REVERSION — overextended, wicks forming
    if (absbtcDelta > 0.08 && wickRatio > 0.9) {
      return { type: 'MEAN_REVERSION', noTrade: false, description: `Mean reversion setup: Δ=${btcDelta.toFixed(3)}% wick=${wickRatio.toFixed(2)}` };
    }

    // Scenario 5: WHALE ABSORPTION — price barely moving despite BTC pressure (handled by low btcDelta + micro)
    // Falls through to NORMAL — microstructure engine detects whale patterns separately

    return { type: 'NORMAL', noTrade: false };
  }

  /**
   * Bug 3: Clear per-market state when a market resolves/expires.
   * Prevents lastSignalPrices and EVEngine history from leaking into
   * the next window that reuses the same marketId.
   */
  clearMarket(marketId) {
    delete this.lastSignalPrices[marketId];
    this._priceCache.delete(marketId);
    this.evEngine.clearMarket(marketId);
  }

  /**
   * Estimate lag age between Chainlink and Binance
   * Returns seconds of estimated lag
   */
  _getLagAge(chainlinkPrice, binancePrice) {
    if (!chainlinkPrice || !binancePrice) return 0;

    // Price divergence as proxy for lag
    const divergence = Math.abs(chainlinkPrice - binancePrice) / binancePrice;

    // Rough estimate: 0.1% divergence ≈ 5-10 seconds of lag
    // This is a heuristic — real lag tracking would use timestamps
    if (this.chainlink.lastUpdate) {
      return (Date.now() - this.chainlink.lastUpdate.getTime()) / 1000;
    }

    return divergence > 0.005 ? 30 : 0; // >0.5% divergence = likely stale
  }
}

module.exports = GBMSignalEngine;
