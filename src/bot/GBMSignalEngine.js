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
        return { verdict: 'SKIP', log };
      }

      this.updateEMA(btcPrice);

      // --- Fetch active markets ---
      const markets = await this.polymarket.fetchActiveBTCMarkets();
      if (!markets || markets.length === 0) {
        log.reason = 'No active BTC markets found';
        return { verdict: 'SKIP', log };
      }

      // --- Evaluate each market ---
      for (const market of markets) {
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
        // ==========================================
        const orderBook = await this.polymarket.getOrderBook(yesTokenId);

        // DIAGNOSTIC: log actual order book prices to prove live data is being fetched
        console.log(`[OrderBook] ${market.question?.slice(0,40)} | bid=${orderBook?.bestBid} ask=${orderBook?.bestAsk} mid=${orderBook?.midPrice} depth=${orderBook?.totalDepth?.toFixed(0)}`);

        if (!orderBook || orderBook.bestBid === null || orderBook.bestAsk === null) {
          console.warn(`[GBMSignalEngine] No valid order book for token ${yesTokenId} — bid/ask null, skipping`);
          continue;
        }

        // Skip markets with no real price discovery — bid=0.01/ask=0.99 is boundary liquidity, not a real price
        const bookSpread = orderBook.spread ?? (orderBook.bestAsk - orderBook.bestBid);
        if (bookSpread > 0.10) {
          console.log(`[GBMSignalEngine] SKIP — spread ${(bookSpread * 100).toFixed(0)}% too wide (no real price discovery)`);
          continue;
        }

        const yesPrice = orderBook.midPrice;
        const spread = orderBook.spread || 0;

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

        if (lagAgeSeconds > maxLagAge) {
          log.gates.freshness = { lagAge: lagAgeSeconds, max: maxLagAge, passed: false };
          continue;
        }

        // ==========================================
        // PRE-FILTER B: No-Chase Rule
        // If price moved significantly since we first spotted opportunity, skip
        // ==========================================
        const chaseThreshold = (this.settings.chase_threshold || 8) / 100; // Convert to decimal

        if (this.lastSignalPrices[marketId]) {
          const prevPrice = this.lastSignalPrices[marketId].price;
          const priceMove = Math.abs(yesPrice - prevPrice);
          if (priceMove > chaseThreshold) {
            log.gates.chase = { priceMove, threshold: chaseThreshold, passed: false };
            continue;
          }
        }

        // Record current price for future chase detection
        this.lastSignalPrices[marketId] = { price: yesPrice, timestamp: Date.now() };

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
        const btcDelta = this.binance.getWindowDeltaScore(30); // % change over 30s

        // Skip flat-BTC windows — no directional signal means EV ≈ -cost only
        if (Math.abs(btcDelta) < 0.02) {
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

        let modelProb;
        if (bullish) {
          modelProb = Math.min(0.99, Math.max(0.01, yesPrice + totalEdge));
        } else if (bearish) {
          modelProb = Math.max(0.01, Math.min(0.99, yesPrice - totalEdge));
        } else {
          modelProb = yesPrice; // flat BTC → no edge → EV ≈ 0 → filtered by Gate 2
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
          passed: true  // informational only — Gate 2 EV is the real filter
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

        // DEPTH FLOOR: avoid dead order books (< 100 USDC total depth)
        const totalDepth = orderBook.totalDepth || 0;
        if (totalDepth < 100) {
          log.reason = `Thin book: depth=${totalDepth.toFixed(0)} USDC < 100 min`;
          continue;
        }

        // Fill probability for Kelly sizing (does NOT gate the trade — only sizes it)
        const fillProb = Math.min(1.0, totalDepth / 500);

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
          log.reason = `Low fill probability: ${(fillProb*100).toFixed(0)}% (depth=${totalDepth.toFixed(0)})`;
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
        // ==========================================
        this.evEngine.recordEV(marketId, evReal, evAnalysis.bestDirection);

        if (this.evEngine.isEVDecaying(marketId)) {
          log.gates.evTrend = { status: 'DECAYING', passed: false };
          continue;
        }

        // Also require positive EV velocity (EV must be rising, not just above floor)
        const evVelocity = this.evEngine.getEVVelocity(marketId);
        if (evVelocity < 0) {
          log.gates.evTrend = { status: 'FALLING', velocity: evVelocity, passed: false };
          continue;
        }

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
          const minDelta = parseFloat(this.settings.min_edge) || 0.015;

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

        log.verdict = 'TRADE';
        log.reason = `EV-driven signal: ${direction} @ EV ${evAnalysis.bestEV.toFixed(2)}%, micro=${micro.confidence.toFixed(3)}, modelProb=${modelProb.toFixed(3)}`;

        return {
          verdict: 'TRADE',
          market: market,
          marketId: marketId,
          direction: direction,        // 'YES' or 'NO'
          confidence: micro.confidence,
          evRaw: direction === 'YES' ? evAnalysis.evYes + (costs.spread + costs.estimatedSlippage + costs.fees) * 100 : evAnalysis.evNo + (costs.spread + costs.estimatedSlippage + costs.fees) * 100,
          evAdj: evAnalysis.bestEV,
          evYes: evAnalysis.evYes,
          evNo: evAnalysis.evNo,
          emaEdge: emaEdge,
          modelProb: modelProb,
          entryPrice: entryPrice,
          fillProb: fillProb,
          tokenId: tokenId,
          orderBook: orderBook,
          microstructure: micro,
          costs: costs,
          log: log
        };
      }

      // No market passed — log summary of what happened
      const gateNames = Object.keys(log.gates);
      const failedAt = gateNames.find(k => log.gates[k]?.passed === false) || 'all_markets_skipped';
      log.verdict = 'SKIP';
      log.reason = 'No market passed all gates';
      log.skipDetail = failedAt;
      console.log(`[GBMSignalEngine] SKIP — ${failedAt}`, JSON.stringify(log.gates).slice(0, 200));
      return { verdict: 'SKIP', log };

    } catch (err) {
      console.error('[GBMSignalEngine] evaluate error:', err.message);
      log.verdict = 'ERROR';
      log.reason = `Evaluation error: ${err.message}`;
      return { verdict: 'ERROR', log };
    }
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
