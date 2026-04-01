/**
 * EVEngine — Cost-Aware Expected Value with Microstructure Gate
 *
 * 🎯 CORE LOGIC (in this order):
 *
 * 1. Detect microstructure edge
 *    → MUST have: BTC moves fast AND Polymarket lags
 *    → If false → SKIP (no real edge)
 *
 * 2. Compute EV_raw (fee already included!)
 *    → probability * (1 - price) * (1 - fee) + (1-prob) * (-price) * (1-fee)
 *
 * 3. Compute trading costs (spread + slippage)
 *    → All values in probability space (0–1)
 *    → Spread: (ask - bid) / mid
 *    → Slippage: 0.5–3% (dynamic based on vol/depth)
 *
 * 4. Calculate EV_adj = EV_raw - (spread + slippage)
 *
 * 5. Check threshold: if EV_adj < 3% → SKIP
 *
 * ⚠️ DON'T subtract fee twice (already in EV_raw)
 * ✓ DO use microstructure edge as primary gate
 * ✓ DO print debug logs for tuning
 */

class EVEngine {
  constructor(settings = {}) {
    this.settings = settings;
    this.feeRate = 0.02; // Polymarket fee: 2%
    this.minEVThreshold = 0.03; // Minimum acceptable EV_adj (3%)
    this.baseSlippage = 0.005; // Base slippage (0.5%)
    this.maxSlippage = 0.03; // Max slippage (3%) in extreme conditions
  }

  /**
   * Calculate EV for YES outcome
   * @param {number} priceYes - Current YES price (0–1)
   * @param {number} modelProb - Model probability of YES (0–1)
   * @returns {number} Raw EV before costs
   */
  evYes(priceYes, modelProb) {
    // If we're right: win (1 - priceYes), pay fee
    // If we're wrong: lose priceYes, pay fee
    const winPayoff = (1 - priceYes) * (1 - this.feeRate);
    const lossPayoff = -priceYes * (1 - this.feeRate);
    return modelProb * winPayoff + (1 - modelProb) * lossPayoff;
  }

  /**
   * Calculate EV for NO outcome
   * @param {number} priceNo - Current NO price (0–1)
   * @param {number} modelProb - Model probability of NO (0–1)
   * @returns {number} Raw EV before costs
   */
  evNo(priceNo, modelProb) {
    const noProb = 1 - modelProb;
    const winPayoff = (1 - priceNo) * (1 - this.feeRate);
    const lossPayoff = -priceNo * (1 - this.feeRate);
    return noProb * winPayoff + modelProb * lossPayoff;
  }

  /**
   * Estimate spread cost (PROBABILITY SPACE)
   * Cost = (ask - bid) / mid
   *
   * @param {number} bid - Bid price (0–1)
   * @param {number} ask - Ask price (0–1)
   * @returns {number} Spread cost in probability space (0–1)
   */
  estimateSpreadCost(bid, ask) {
    if (!bid || !ask || bid >= ask) return 0.0001; // ~0.01% minimum
    const mid = (bid + ask) / 2;
    // Full spread cost (we cross the spread to enter)
    return (ask - bid) / mid;
  }

  /**
   * Estimate slippage cost (PROBABILITY SPACE)
   *
   * Returns dynamic slippage based on:
   * - Order size relative to market depth
   * - Volatility
   * - BTC price movement
   *
   * @param {object} params
   *   - orderSize: Trade size in dollars
   *   - marketDepth: Available depth in dollars
   *   - volatility: Price volatility (0.01 = normal)
   *   - btcDelta: Recent BTC price move %
   *
   * @returns {number} Slippage cost in probability space (0–1)
   */
  estimateSlippageCost(params) {
    const {
      orderSize = 20,
      marketDepth = 1000,
      volatility = 0.01,
      btcDelta = 0.0
    } = params;

    // Base slippage
    let slippage = this.baseSlippage;

    // Scale with order size / depth ratio
    const depthRatio = Math.min(orderSize / marketDepth, 1.0);
    slippage += depthRatio * 0.01; // Up to 1% additional

    // Scale with volatility
    const volMultiplier = Math.max(0.5, Math.min(2.0, volatility / 0.01));
    slippage *= volMultiplier;

    // Scale with BTC movement (faster moves = harder to fill)
    if (Math.abs(btcDelta) > 0.001) {
      slippage += Math.abs(btcDelta) * 2; // 0.1% BTC move → 0.2% more slippage
    }

    // Cap slippage at maximum
    return Math.min(slippage, this.maxSlippage);
  }

  /**
   * Get adaptive BTC delta threshold based on volatility
   *
   * Low vol (0.005) → 20 bps (0.0002)
   * Normal vol (0.01) → 50 bps (0.0005)
   * High vol (0.05) → 100 bps (0.001)
   *
   * @param {number} volatility - Market volatility
   * @returns {number} Required BTC delta to trigger microstructure signal
   */
  getAdaptiveBTCThreshold(volatility = 0.01) {
    const low_vol_threshold = 0.0002;  // 20 bps
    const high_vol_threshold = 0.001;  // 100 bps
    const normal_vol = 0.01;

    const ratio = Math.min(volatility / normal_vol, 2.0);
    const threshold = low_vol_threshold + (high_vol_threshold - low_vol_threshold) * ratio;
    return threshold;
  }

  /**
   * COST-ADJUSTED EV (Primary decision metric)
   *
   * ALL VALUES IN PROBABILITY SPACE (0–1)
   *
   * EV_adj = EV_raw - (spread + slippage)
   *
   * @param {object} params
   *   - priceYes: YES token price (0–1)
   *   - bid: Order book bid (0–1)
   *   - ask: Order book ask (0–1)
   *   - modelProb: Model probability (0–1)
   *   - direction: 'UP' or 'DOWN'
   *   - orderSize: Trade size (dollars)
   *   - marketDepth: Available depth (dollars)
   *   - volatility: Price volatility (0.01 = normal)
   *   - btcDelta: Recent BTC move (%)
   *   - hasMarketLag: Is there a BTC/Poly divergence?
   *
   * @returns {object}
   *   - ev_raw: Raw EV (probability space)
   *   - fee_cost: Fee (probability space)
   *   - spread_cost: Spread cost (probability space)
   *   - slippage_cost: Slippage (probability space)
   *   - total_cost: Sum of all costs
   *   - ev_adjusted: EV after costs (DECISION METRIC)
   *   - threshold: Minimum EV_adj to trade
   *   - recommended: 'TRADE' | 'SKIP'
   *   - reason: Detailed explanation
   *   - debug: Log for analysis
   */
  computeAdjustedEV({
    priceYes,
    bid,
    ask,
    modelProb,
    direction,
    orderSize = 20,
    marketDepth = 1000,
    volatility = 0.01,
    btcDelta = 0.0,
    hasMarketLag = false
  }) {
    // Sanity checks
    if (!priceYes || modelProb < 0 || modelProb > 1) {
      return {
        ev_raw: 0,
        fee_cost: 0,
        spread_cost: 0,
        slippage_cost: 0,
        total_cost: 0,
        ev_adjusted: -1,
        threshold: this.minEVThreshold,
        recommended: 'SKIP',
        reason: 'Invalid inputs',
        debug: { error: 'sanity check failed' }
      };
    }

    const priceNo = 1 - priceYes;

    // ═══════════════════════════════════════════════════════════════
    // 1. COMPUTE RAW EV (fee already included!)
    // ═══════════════════════════════════════════════════════════════
    const ev_raw = direction === 'UP'
      ? this.evYes(priceYes, modelProb)
      : this.evNo(priceNo, 1 - modelProb);

    // ═══════════════════════════════════════════════════════════════
    // 2. ESTIMATE TRADING COSTS (NOT including fee—already in EV)
    // ═══════════════════════════════════════════════════════════════
    const spread_cost = this.estimateSpreadCost(bid, ask);
    const slippage_cost = this.estimateSlippageCost({
      orderSize,
      marketDepth,
      volatility,
      btcDelta
    });

    const total_cost = spread_cost + slippage_cost;

    // ═══════════════════════════════════════════════════════════════
    // 3. COMPUTE ADJUSTED EV
    // ═══════════════════════════════════════════════════════════════
    const ev_adjusted = ev_raw - total_cost;

    // ═══════════════════════════════════════════════════════════════
    // 4. HARD FILTER: Microstructure edge (PRIMARY GATE)
    // ═══════════════════════════════════════════════════════════════
    let hardFilterReason = null;

    // 🔴 CRITICAL: Must have BOTH BTC fast move AND market lag to trade
    // This is the real edge — not directional prediction, but latency exploitation
    const btcThreshold = this.getAdaptiveBTCThreshold(volatility);
    const btcFastMove = Math.abs(btcDelta) > btcThreshold;
    const hasEdge = btcFastMove && hasMarketLag;

    if (!hasEdge) {
      hardFilterReason = `No microstructure edge: btc_move=${(btcDelta*100).toFixed(3)}% (need ${(btcThreshold*100).toFixed(3)}%), market_lag=${hasMarketLag}`;
    }

    // Also filter if spread too wide
    if (!hardFilterReason && spread_cost > 0.01) {
      hardFilterReason = 'Spread too wide (' + (spread_cost * 100).toFixed(2) + '%)';
    }

    // ═══════════════════════════════════════════════════════════════
    // 5. MAKE DECISION
    // ═══════════════════════════════════════════════════════════════
    let recommended = 'SKIP';
    let reason = '';

    if (hardFilterReason) {
      reason = `HARD FILTER: ${hardFilterReason}`;
      recommended = 'SKIP';
    } else if (ev_adjusted <= 0) {
      reason = `EV_adj ${(ev_adjusted * 100).toFixed(1)}% ≤ 0% (negative expectation)`;
      recommended = 'SKIP';
    } else if (ev_adjusted < this.minEVThreshold) {
      reason = `EV_adj ${(ev_adjusted * 100).toFixed(1)}% < threshold ${(this.minEVThreshold * 100).toFixed(1)}% (too low)`;
      recommended = 'SKIP';
    } else {
      reason = `EV_adj ${(ev_adjusted * 100).toFixed(1)}% > threshold ${(this.minEVThreshold * 100).toFixed(1)}% ✓ TRADE`;
      recommended = 'TRADE';
    }

    // ═══════════════════════════════════════════════════════════════
    // 6. DEBUG LOGS (for tuning)
    // ═══════════════════════════════════════════════════════════════
    const debug = {
      // Microstructure
      btc_delta_bps: Math.round(btcDelta * 10000),
      market_lag: hasMarketLag ? 'YES' : 'NO',
      microstructure_edge: hasEdge ? 'YES ✓' : 'NO ✗',
      // EV breakdown
      direction,
      price_yes: parseFloat(priceYes.toFixed(4)),
      model_prob: parseFloat(modelProb.toFixed(4)),
      ev_raw_pct: parseFloat((ev_raw * 100).toFixed(2)) + '%',
      spread_cost_pct: parseFloat((spread_cost * 100).toFixed(2)) + '%',
      slippage_cost_pct: parseFloat((slippage_cost * 100).toFixed(2)) + '%',
      total_cost_pct: parseFloat((total_cost * 100).toFixed(2)) + '%',
      ev_adjusted_pct: parseFloat((ev_adjusted * 100).toFixed(2)) + '%',
      threshold_pct: parseFloat((this.minEVThreshold * 100).toFixed(2)) + '%'
    };

    return {
      ev_raw: parseFloat(ev_raw.toFixed(4)),
      spread_cost: parseFloat(spread_cost.toFixed(4)),
      slippage_cost: parseFloat(slippage_cost.toFixed(4)),
      total_cost: parseFloat(total_cost.toFixed(4)),
      ev_adjusted: parseFloat(ev_adjusted.toFixed(4)),
      threshold: this.minEVThreshold,
      recommended,
      reason,
      debug,
      microstructure_edge: hasEdge
    };
  }

  /**
   * DYNAMIC EV THRESHOLD
   *
   * Adjusts minimum acceptable EV_adj based on:
   * - Volatility (high vol = need more edge)
   * - Recent win rate (losing = be conservative)
   * - Execution latency (slow execution = more risk)
   *
   * @param {object} params
   *   - volatility: Price volatility (0.01 = normal)
   *   - recentWinRate: Last 10 trades win rate (0–1)
   *   - avgSlippage: Average slippage observed (%)
   *
   * @returns {number} Minimum acceptable EV_adj (probability space)
   */
  dynamicThreshold({
    volatility = 0.01,
    recentWinRate = 0.5,
    avgSlippage = 0.1
  }) {
    let threshold = this.minEVThreshold; // Start at 3%

    // Increase if high volatility (less predictable)
    if (volatility > 0.02) {
      threshold += (volatility - 0.01) * 0.5; // Up to +0.5% per 1% vol increase
    }

    // Increase if recent slippage high (harder to execute)
    if (avgSlippage > 0.15) {
      threshold += 0.02; // Add 2% if average slippage > 0.15%
    }

    // Increase if losing streak (more defensive)
    if (recentWinRate < 0.45) {
      threshold *= 1.5; // 50% higher threshold if < 45% win rate
    } else if (recentWinRate < 0.50) {
      threshold *= 1.2; // 20% higher if < 50% win rate
    }

    return parseFloat(threshold.toFixed(4));
  }

  /**
   * Full trade recommendation with context
   *
   * @returns {object} Final recommendation + debug info
   */
  recommend(params) {
    const ev = this.computeAdjustedEV(params);

    // Note: computeAdjustedEV already includes minEVThreshold logic
    // This method adds dynamic threshold adjustment
    const dynamicThresh = this.dynamicThreshold({
      volatility: params.volatility,
      recentWinRate: params.recentWinRate,
      avgSlippage: params.avgSlippage
    });

    // Use stricter of the two thresholds
    const finalThreshold = Math.max(ev.threshold, dynamicThresh);
    const finalRecommended = ev.ev_adjusted > finalThreshold ? 'TRADE' : 'SKIP';

    const debugMsg = ev.ev_adjusted > finalThreshold
      ? `EV_adj ${(ev.ev_adjusted * 100).toFixed(1)}% > threshold ${(finalThreshold * 100).toFixed(1)}%`
      : `EV_adj ${(ev.ev_adjusted * 100).toFixed(1)}% ≤ threshold ${(finalThreshold * 100).toFixed(1)}%`;

    return {
      ...ev,
      threshold_dynamic: dynamicThresh,
      threshold_final: finalThreshold,
      recommended: finalRecommended,
      reason_final: `${ev.reason} [dynamic_threshold=${(dynamicThresh * 100).toFixed(1)}%]`,
      debug_msg: debugMsg
    };
  }
}

module.exports = { EVEngine };
