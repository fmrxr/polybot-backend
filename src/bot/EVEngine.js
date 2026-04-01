/**
 * EVEngine — Cost-Aware Expected Value Calculator
 *
 * CRITICAL: All EV calculations MUST account for:
 * - Trading fees (Polymarket ~2%)
 * - Spread (bid/ask gap)
 * - Slippage (fill price worse than expected)
 *
 * 🚨 RULE: If EV_adj <= 0 → DO NOT TRADE
 *
 * This module replaces naive EV with cost-aware filtering
 */

class EVEngine {
  constructor(settings = {}) {
    this.settings = settings;
    this.feeRate = 0.02; // Polymarket standard fee ~2%
    this.minSpread = 0.0005; // Minimum spread to estimate (0.05%)
    this.slippageEstimate = 0.005; // Typical slippage (0.5%)
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
   * Estimate spread from bid/ask
   * @param {number} bid - Bid price
   * @param {number} ask - Ask price
   * @returns {number} Spread as fraction
   */
  estimateSpread(bid, ask) {
    if (!bid || !ask || bid >= ask) return this.minSpread;
    return Math.max((ask - bid) / ((ask + bid) / 2), this.minSpread);
  }

  /**
   * Estimate slippage cost
   * @param {number} orderSize - Size in dollars
   * @param {number} marketDepth - Total depth available (dollars)
   * @param {number} volatility - Market volatility
   * @returns {number} Estimated slippage as %
   */
  estimateSlippage(orderSize, marketDepth = 1000, volatility = 0.01) {
    if (marketDepth <= 0) return this.slippageEstimate;

    // Larger orders relative to depth = more slippage
    const depthRatio = orderSize / marketDepth;
    // Higher volatility = more slippage
    const volMultiplier = 1 + (volatility / 0.02); // 0.02 = normal vol

    return this.slippageEstimate * depthRatio * volMultiplier;
  }

  /**
   * COST-ADJUSTED EV (Primary decision metric)
   *
   * Returns: EV_adj = EV_raw - (spread_cost + slippage_cost)
   *
   * @param {object} params
   *   - priceYes: YES token price
   *   - priceNo: NO token price (= 1 - priceYes)
   *   - bid: Order book bid
   *   - ask: Order book ask
   *   - modelProb: Model probability
   *   - direction: 'UP' or 'DOWN'
   *   - orderSize: Size in dollars
   *   - marketDepth: Available depth (dollars)
   *   - volatility: Market volatility
   *
   * @returns {object}
   *   - ev_raw: Raw EV before costs
   *   - spread_cost: Spread cost (%)
   *   - slippage_cost: Slippage estimate (%)
   *   - ev_adjusted: Final EV_adj (after all costs)
   *   - recommended: 'TRADE' | 'SKIP'
   *   - reason: Why trade/skip
   */
  computeAdjustedEV({
    priceYes,
    priceNo,
    bid,
    ask,
    modelProb,
    direction,
    orderSize,
    marketDepth = 1000,
    volatility = 0.01
  }) {
    // Sanity checks
    if (!priceYes || modelProb < 0 || modelProb > 1 || orderSize <= 0) {
      return {
        ev_raw: 0,
        spread_cost: 0,
        slippage_cost: 0,
        ev_adjusted: -999,
        recommended: 'SKIP',
        reason: 'Invalid inputs'
      };
    }

    // Compute raw EV based on direction
    const ev_raw = direction === 'UP'
      ? this.evYes(priceYes, modelProb)
      : this.evNo(priceNo, 1 - modelProb);

    // Estimate costs
    const spread_cost = this.estimateSpread(bid, ask);
    const slippage_cost = this.estimateSlippage(orderSize, marketDepth, volatility);
    const total_cost = (spread_cost + slippage_cost) * orderSize; // In dollars

    // Cost-adjusted EV
    const ev_adjusted = ev_raw - total_cost;

    // Decision logic
    const recommended = ev_adjusted > 0 ? 'TRADE' : 'SKIP';
    const reason = ev_adjusted <= 0
      ? `EV_adj ${ev_adjusted.toFixed(4)} ≤ 0 (raw=${ev_raw.toFixed(4)}, costs=${total_cost.toFixed(4)})`
      : `EV_adj ${ev_adjusted.toFixed(4)} > 0 (raw=${ev_raw.toFixed(4)}, costs=${total_cost.toFixed(4)})`;

    return {
      ev_raw: parseFloat(ev_raw.toFixed(4)),
      spread_cost: parseFloat(spread_cost.toFixed(4)),
      slippage_cost: parseFloat(slippage_cost.toFixed(4)),
      total_cost: parseFloat(total_cost.toFixed(4)),
      ev_adjusted: parseFloat(ev_adjusted.toFixed(4)),
      recommended,
      reason
    };
  }

  /**
   * DYNAMIC EV THRESHOLD
   *
   * Minimum acceptable EV_adj based on market conditions
   * EV_threshold = base_threshold + k*volatility + latency_penalty
   *
   * @param {object} params
   *   - volatility: Market volatility
   *   - latency: Execution latency (ms)
   *   - recentWinrate: Win rate last 10 trades (0–1)
   *
   * @returns {number} Minimum acceptable EV_adj
   */
  dynamicThreshold({ volatility = 0.01, latency = 100, recentWinrate = 0.5 }) {
    // Base threshold
    let threshold = 0.01; // 1 cent minimum

    // Increase in volatile markets (less stable signals)
    threshold += Math.max(0, (volatility - 0.01) * 2);

    // Increase with latency (slower execution = bigger slippage risk)
    threshold += Math.max(0, (latency - 50) / 1000);

    // Increase if recent performance drops (more conservative)
    if (recentWinrate < 0.45) {
      threshold *= 1.5; // 50% higher threshold if losing
    }

    return threshold;
  }

  /**
   * Trade recommendation with full context
   *
   * @returns {object} Final recommendation
   */
  recommend(params) {
    const ev = this.computeAdjustedEV(params);
    const threshold = this.dynamicThreshold({
      volatility: params.volatility,
      latency: params.latency,
      recentWinrate: params.recentWinrate
    });

    const recommended = ev.ev_adjusted > threshold ? 'TRADE' : 'SKIP';
    const reason = ev.ev_adjusted <= threshold
      ? `EV_adj ${ev.ev_adjusted.toFixed(4)} ≤ threshold ${threshold.toFixed(4)}`
      : `EV_adj ${ev.ev_adjusted.toFixed(4)} > threshold ${threshold.toFixed(4)}`;

    return {
      ...ev,
      recommended,
      reason,
      threshold: parseFloat(threshold.toFixed(4))
    };
  }
}

module.exports = { EVEngine };
