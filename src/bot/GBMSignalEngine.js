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
      const btcPrice = this.binance.getPrice();
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

        if (!orderBook || orderBook.bestBid === null || orderBook.bestAsk === null) {
          console.warn(`[GBMSignalEngine] No valid order book for token ${yesTokenId} (market: ${market.question?.slice(0,50)})`);
          continue; // Can't evaluate without real data
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

        // Map to probability edge: 0.1% BTC move → 0.05 (5%), cap 0.15
        const btcEdge = Math.min(Math.abs(btcDelta) * 0.5, 0.15);
        const microEdge = micro.confidence * 0.10; // up to 10% from order book

        // lagBonus is NOT added to modelProb — it's an execution signal, not a probability estimate
        // Lag means faster execution priority, not higher probability
        const hasLag = micro.hasMarketLag;

        const totalEdge = btcEdge + microEdge;

        const bullish = btcDelta > 0.02;  // require ≥0.02% 30s move for a directional call (~$13 on $66k BTC)
        const bearish = btcDelta < -0.02;

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
          spread: Math.min(spread, 0.03), // cap at 3% — maker adverse selection only; full spread is not a cost for limit orders
          estimatedSlippage: 0.005,
          fees: 0.002
        };

        // Fill probability: thin books mean lower chance of getting filled at mid
        // P(fill) = min(1, totalDepth / 500) — 500 USDC depth = high confidence
        const fillProb = Math.min(1.0, (orderBook.totalDepth || 0) / 500);

        // Evaluate BOTH sides — pick the better one, then scale by fill probability
        const evAnalysis = this.evEngine.evaluateBothSides(modelProb, yesPrice, costs);
        const evReal = evAnalysis.bestEV * fillProb; // EV_real = EV_adj * P(fill)

        // Window timing: adjust threshold based on time within the 5-min window
        const marketEndSec = market.end_date_iso
          ? new Date(market.end_date_iso).getTime() / 1000
          : (market.resolution_time || market.end_time || 0);
        const marketStartSec = market.start_date_iso
          ? new Date(market.start_date_iso).getTime() / 1000
          : (market.start_time || marketEndSec - 300);
        const nowSec = Date.now() / 1000;
        const elapsed = nowSec - marketStartSec;
        const remaining = marketEndSec - nowSec;

        let evFloor = parseFloat(this.settings.gate2_ev_floor) || 3.0;

        // Early window (< 60s in): largest mispricings, lower threshold
        if (elapsed < 60) evFloor *= 0.7;
        // Late window (< 90s to expiry): decay risk, higher threshold
        else if (remaining < 90) evFloor *= 1.5;

        // If lag detected: treat as high-priority execution (don't raise floor further)
        if (hasLag && elapsed < 60) evFloor *= 0.8;

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

        console.log(`[GBMSignalEngine] Gate2: btcDelta=${btcDelta.toFixed(3)}% modelProb=${modelProb.toFixed(3)} yesPrice=${yesPrice.toFixed(3)} EV=${evAnalysis.bestEV.toFixed(2)}% fillProb=${fillProb.toFixed(2)} evReal=${evReal.toFixed(2)}% floor=${evFloor.toFixed(2)}% elapsed=${Math.round(elapsed)}s`);

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
        // GATE 3: EMA TREND CONFIRMATION (optional)
        // ==========================================
        const direction = evAnalysis.bestDirection;
        let emaEdge = 0;

        if (this.settings.gate3_enabled !== false) {
          emaEdge = this.emaShort && this.emaLong
            ? ((this.emaShort - this.emaLong) / this.emaLong) * 100
            : 0;

          const minEdge = parseFloat(this.settings.gate3_min_edge) || 5.0;
          const isBullish = emaEdge > 0;

          log.gates.gate3 = {
            emaEdge,
            minEdge,
            direction,
            passed: false
          };

          // Check alignment: YES direction needs bullish EMA, NO needs bearish
          if (direction === 'YES' && !isBullish) {
            log.gates.gate3.passed = false;
            continue;
          }
          if (direction === 'NO' && isBullish) {
            log.gates.gate3.passed = false;
            continue;
          }

          // Check strength — emaEdge is already in %, compare directly to minEdge %
          if (Math.abs(emaEdge) < minEdge) {
            log.gates.gate3.passed = false;
            continue;
          }

          log.gates.gate3.passed = true;
        }

        // ==========================================
        // ALL GATES PASSED — GENERATE SIGNAL
        // ==========================================
        const entryPrice = direction === 'YES' ? orderBook.bestAsk : (1 - orderBook.bestBid);
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
