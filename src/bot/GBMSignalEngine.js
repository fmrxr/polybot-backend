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

        // never Fall back to Gamma API outcomePrices if both CLOB books have no real spread.
        // Gamma returns outcomePrices as JSON string: '["0.487","0.513"]'
        // outcomePrices[0] = YES/Up price, outcomePrices[1] = NO/Down price
        // This is the real market-implied probability, not CLOB boundary orders.
        if (rawYesPrice == null) {
          let op = market.outcomePrices;
          if (typeof op === 'string') { try { op = JSON.parse(op); } catch(_) { op = null; } }
          console.log(`[Gamma] outcomePrices=${JSON.stringify(op)}`);
          const gammaYes = op ? parseFloat(op[0]) : NaN;
          const gammaNo  = op ? parseFloat(op[1]) : NaN;
          if (!isNaN(gammaYes) && gammaYes > 0.05 && gammaYes < 0.95) {
            rawYesPrice = gammaYes;
            priceSource = 'gamma';
            console.log(`[GBMSignalEngine] Both CLOB books boundary-only — Gamma outcomePrices: yesPrice=${rawYesPrice.toFixed(3)}`);
          } else if (!isNaN(gammaNo) && gammaNo > 0.05 && gammaNo < 0.95) {
            rawYesPrice = 1 - gammaNo;
            priceSource = 'gamma';
            console.log(`[GBMSignalEngine] Both CLOB books boundary-only — Gamma NO price: noPrice=${gammaNo.toFixed(3)} yesPrice=${rawYesPrice.toFixed(3)}`);
          }
        }

        if (rawYesPrice == null || !orderBook) {
          console.log(`[GBMSignalEngine] SKIP — no real price from any source (CLOB both boundary, Gamma also 0.5)`);
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

        // When priceSource='gamma', both CLOB books were boundary-only (spread≥90%).
        // orderBook.spread is null in that case, making the || chain collapse to 0
        // and bypassing the boundary-book guard below. Force spread=1 so the guard
        // fires and we don't produce TRADE verdicts with no real CLOB liquidity.
        const rawSpread = orderBook.spread ?? (yesBook?.spread) ?? null;
        const spread = priceSource === 'gamma' ? 1.0 : (rawSpread ?? 0);

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

        // Skip flat-BTC windows — no directional signal means EV ≈ -cost only.
        // Exception: if Gamma price is already meaningfully off 0.5 (|yesPrice - 0.5| > 0.01),
        // the market has priced a directional move we may still have edge on.
        // Threshold lowered 0.02 → 0.01: yesPrice=0.485 is 1.5% off fair value — real edge.
        const gammaPriceSignificant = Math.abs(yesPrice - 0.5) > 0.01;
        if (Math.abs(btcDelta) < 0.02 && !gammaPriceSignificant) {
          log.gates.btcFlat = { btcDelta, yesPrice, passed: false };
          continue;
        }

        // Map to probability edge: 0.1% BTC move → 0.05 (5%), cap 0.15
        const btcEdge = Math.min(Math.abs(btcDelta) * 0.5, 0.15);
        const microEdge = micro.confidence * 0.10; // up to 10% from order book

        // lagBonus is NOT added to modelProb — it's an execution signal, not a probability estimate
        // Lag means faster execution priority, not higher probability
        const hasLag = micro.hasMarketLag;

        const totalEdge = btcEdge + microEdge;

        const bullish = btcDelta > 0.015;  // require ≥0.015% 30s move (~$13 on $90k BTC)
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

        // Window timing — compute before depth/EV checks so we can skip late windows
        const marketEndSec = market.end_date_iso
          ? new Date(market.end_date_iso).getTime() / 1000
          : (market.resolution_time || market.end_time || 0);
        const marketStartSec = market.start_date_iso
          ? new Date(market.start_date_iso).getTime() / 1000
          : (market.start_time || marketEndSec - 300);
        const nowSec = Date.now() / 1000;
        const elapsed = nowSec - marketStartSec;
        const remaining = marketEndSec - nowSec;

        // LATE WINDOW SKIP: last 60s = garbage liquidity + price already baked in
        if (remaining < 60) {
          log.reason = `Window expiring in ${Math.round(remaining)}s — skipping`;
          continue;
        }

        // BOUNDARY BOOK GUARD: bid=0.01/ask=0.99 books have enormous totalDepth
        // (50000+ USDC in ghost resting orders) but zero real liquidity. Spread is
        // the correct signal — a 90%+ spread means no real market participants.
        // fillProb must be 0 here regardless of depth.
        if (spread >= 0.90) {
          log.reason = `Boundary book: spread=${(spread*100).toFixed(0)}% — no real liquidity`;
          continue;
        }

        // DEPTH FLOOR: avoid thin real books (< 100 USDC total depth)
        const totalDepth = orderBook.totalDepth || 0;
        if (totalDepth < 100) {
          log.reason = `Thin book: depth=${totalDepth.toFixed(0)} USDC < 100 min`;
          continue;
        }

        // Fill probability: spread-adjusted depth score.
        // totalDepth on a tight (1-2%) book of 500 USDC = 100% fill confidence.
        // Same depth on a 50% spread book = much lower — wide spread means
        // resting orders are far from mid and won't fill a passive limit.
        const spreadPenalty = Math.max(0, 1 - spread * 5); // 10% spread → 0.5, 20% → 0
        const fillProb = Math.min(1.0, (totalDepth / 500) * spreadPenalty);

        // Evaluate BOTH sides — check EV directly against floor (no fillProb penalty)
        const evAnalysis = this.evEngine.evaluateBothSides(modelProb, yesPrice, costs);
        const evReal = evAnalysis.bestEV;

        let evFloor = parseFloat(this.settings.gate2_ev_floor) || 1.5;

        // Early window (< 60s in): largest mispricings, lower threshold
        if (elapsed < 60) evFloor *= 0.7;

        // Lag detected: high-priority execution, ease floor slightly
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
        const EV_VELOCITY_FLOOR = -1.0; // must drop >1% per tick to count as falling
        if (this.evEngine.isEVDecaying(marketId) && evVelocity < EV_VELOCITY_FLOOR) {
          log.gates.evTrend = { status: 'DECAYING', velocity: evVelocity, passed: false };
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
          const minDelta = parseFloat(this.settings.gate3_min_delta) || 0.05;

          log.gates.gate3 = {
            btcDelta,
            minDelta,
            direction,
            passed: false
          };

          // Direction alignment: YES needs BTC rising, NO needs BTC falling
          if (direction === 'YES' && !isBullish) {
            log.gates.gate3.passed = false;
            continue;
          }
          if (direction === 'NO' && isBullish) {
            log.gates.gate3.passed = false;
            continue;
          }

          // Strength check: btcDelta must meet minimum threshold
          if (Math.abs(btcDelta) < minDelta) {
            log.gates.gate3.passed = false;
            continue;
          }

          log.gates.gate3.passed = true;
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

        // Signal quality confidence — replaces pure microstructure score.
        // Must reflect actual outcome predictors, not just order book health.
        const momentumScore   = Math.min(Math.abs(btcDelta) / 0.10, 1.0);          // normalize to 0.10%
        const evScore         = Math.min(Math.max(0, evAnalysis.bestEV) / 15.0, 1.0); // normalize to 15% EV
        const convictionScore = Math.abs(modelProb - 0.5) * 2;                     // 0→1
        const timeScore       = Math.min(remaining / 240, 1.0);                    // full score ≥4 min left
        const microScore      = micro.confidence || 0;
        const signalConfidence = parseFloat((
          momentumScore   * 0.45 +
          evScore         * 0.30 +
          convictionScore * 0.15 +
          timeScore       * 0.05 +
          microScore      * 0.05
        ).toFixed(3));

        // Confidence gate — skip if signal quality is too low (noise, not edge)
        if (signalConfidence < 0.20) {
          console.log(`[GBMSignalEngine] SKIP — low signal quality: confidence=${signalConfidence.toFixed(3)}`);
          continue;
        }

        log.verdict = 'TRADE';
        log.reason = `EV-driven signal: ${direction} @ EV ${evAnalysis.bestEV.toFixed(2)}%, confidence=${signalConfidence.toFixed(3)}, modelProb=${modelProb.toFixed(3)}`;

        return {
          verdict: 'TRADE',
          market: market,
          marketId: marketId,
          direction: direction,        // 'YES' or 'NO'
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
      log.reason = 'No market passed all gates';
      log.skipDetail = failedAt;
      const lastMarketId = lastMarket ? (lastMarket.id || lastMarket.condition_id) : null;
      console.log(`[GBMSignalEngine] SKIP — ${failedAt}`, JSON.stringify(log.gates).slice(0, 200));
      return { verdict: 'SKIP', log, marketId: lastMarketId, market: lastMarket, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };

    } catch (err) {
      console.error('[GBMSignalEngine] evaluate error:', err.message);
      log.verdict = 'ERROR';
      log.reason = `Evaluation error: ${err.message}`;
      return { verdict: 'ERROR', log, marketId: null, market: null, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };
    }
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
