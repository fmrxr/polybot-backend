/**
 * GBM Signal Engine
 * Replicates the market-anchored GBM probability model from the proof report.
 * Computes risk-neutral probability and expected value for UP/DOWN Polymarket markets.
 */

class GBMSignalEngine {
  constructor(settings) {
    this.settings = settings;
    this.consecutiveSignals = [];
    this.REQUIRED_CONFIRMATIONS = 3;
  }

  /**
   * Compute GBM probability that BTC will be above/below the beat price at resolution.
   * Uses Black-Scholes-inspired closed-form for binary outcome.
   */
  computeGBMProbability({ currentPrice, beatPrice, volatility, drift, timeToResolutionSec }) {
    const T = timeToResolutionSec / (365 * 24 * 3600); // convert to years
    if (T <= 0) return 0.5;

    const sigma = volatility;
    const mu = drift - 0.5 * sigma * sigma;
    const logRatio = Math.log(beatPrice / currentPrice);

    // d1 for probability that S_T > beatPrice
    const d1 = (mu * T - logRatio) / (sigma * Math.sqrt(T));
    const probUp = this._normalCDF(d1);
    return Math.max(0.01, Math.min(0.99, probUp));
  }

  /**
   * Blend model probability with Polymarket's market price (Bayesian anchor).
   * Heavy anchor (0.6 weight) to market — market has crowd wisdom.
   */
  marketAnchoredProb(modelProb, marketProb) {
    const MARKET_WEIGHT = 0.60;
    return MARKET_WEIGHT * marketProb + (1 - MARKET_WEIGHT) * modelProb;
  }

  /**
   * Apply drift adjustments: momentum, order book imbalance, mean reversion.
   * Dampened for 5-min noise as per original bot design.
   */
  adjustedDrift({ rawDrift, momentum, obImbalance, currentPrice, vwap }) {
    const MOMENTUM_WEIGHT = 0.3;
    const OB_WEIGHT = 0.2;
    const MR_WEIGHT = 0.15;
    const DAMPENING = 0.4; // Dampen for 5-min noise

    const mrSignal = (vwap - currentPrice) / currentPrice; // mean reversion pull

    const adjustedDrift = rawDrift
      + MOMENTUM_WEIGHT * momentum
      + OB_WEIGHT * obImbalance
      + MR_WEIGHT * mrSignal;

    return adjustedDrift * DAMPENING;
  }

  /**
   * Polymarket fee formula: fee = price * 0.25 * (price * (1 - price))^2
   */
  calculateFee(price, size) {
    const feePct = price * 0.25 * Math.pow(price * (1 - price), 2);
    return feePct * size;
  }

  /**
   * Fee-adjusted Expected Value.
   * EV = prob * (1/price - 1) * (1 - fee_pct) - (1 - prob)
   */
  calculateEV(prob, entryPrice, size = 1) {
    const feePct = entryPrice * 0.25 * Math.pow(entryPrice * (1 - entryPrice), 2);
    const payout = (1 / entryPrice) - 1;
    const ev = prob * payout * (1 - feePct) - (1 - prob);
    return ev;
  }

  /**
   * Kelly criterion position sizing, capped at user-configured max.
   * f = (p * b - q) / b where b = net odds
   */
  kellySize(prob, entryPrice, maxTradeSize, kellyCap) {
    const b = (1 / entryPrice) - 1; // net odds
    const q = 1 - prob;
    const kelly = (prob * b - q) / b;
    const cappedKelly = Math.max(0, Math.min(kelly * kellyCap, 1));
    return Math.min(cappedKelly * maxTradeSize, maxTradeSize);
  }

  /**
   * Main signal evaluation. Returns signal or null.
   * Requires multi-confirmation and all filters.
   */
  evaluate({
    currentPrice,
    beatPrice,
    marketProbUp,     // Polymarket's displayed probability for UP
    entryPriceUp,     // Ask price for UP on Polymarket
    entryPriceDown,   // Ask price for DOWN on Polymarket
    spread,
    volatility,
    drift,
    momentum,
    obImbalance,
    vwap,
    timeToResolutionSec,
    distanceToBeat
  }) {
    const { min_ev_threshold, min_prob_diff, market_prob_min, market_prob_max,
            direction_filter, max_trade_size, kelly_cap } = this.settings;

    // Filter 1: Distance filter ($30-$100 from beat price)
    if (distanceToBeat < 30 || distanceToBeat > 100) return null;

    // Filter 2: Market probability zone (uncertainty zone)
    if (marketProbUp < market_prob_min || marketProbUp > market_prob_max) return null;

    // Filter 3: Spread filter (reject illiquid markets)
    if (spread > 0.15) return null;

    // Compute adjusted drift
    const adjDrift = this.adjustedDrift({ rawDrift: drift, momentum, obImbalance, currentPrice, vwap });

    // GBM probability for UP
    const modelProbUp = this.computeGBMProbability({
      currentPrice, beatPrice, volatility,
      drift: adjDrift, timeToResolutionSec
    });

    // Market-anchored probability
    const anchoredProbUp = this.marketAnchoredProb(modelProbUp, marketProbUp);
    const anchoredProbDown = 1 - anchoredProbUp;

    // Determine signal direction
    let direction = null;
    let entryPrice = null;
    let finalProb = null;

    if (direction_filter !== 'DOWN') {
      const evUp = this.calculateEV(anchoredProbUp, entryPriceUp);
      const probDiffUp = anchoredProbUp - entryPriceUp;
      if (evUp >= min_ev_threshold && probDiffUp >= min_prob_diff) {
        direction = 'UP';
        entryPrice = entryPriceUp;
        finalProb = anchoredProbUp;
      }
    }

    if (!direction && direction_filter !== 'UP') {
      const evDown = this.calculateEV(anchoredProbDown, entryPriceDown);
      const probDiffDown = anchoredProbDown - entryPriceDown;
      if (evDown >= min_ev_threshold && probDiffDown >= min_prob_diff) {
        direction = 'DOWN';
        entryPrice = entryPriceDown;
        finalProb = anchoredProbDown;
      }
    }

    if (!direction) {
      this.consecutiveSignals = [];
      return null;
    }

    // Multi-signal confirmation: require 3 consecutive agreeing evaluations
    this.consecutiveSignals.push(direction);
    if (this.consecutiveSignals.length > this.REQUIRED_CONFIRMATIONS) {
      this.consecutiveSignals.shift();
    }

    if (this.consecutiveSignals.length < this.REQUIRED_CONFIRMATIONS) return null;
    if (!this.consecutiveSignals.every(s => s === direction)) {
      return null;
    }

    // Reset after confirmed signal
    this.consecutiveSignals = [];

    const ev = this.calculateEV(finalProb, entryPrice);
    const size = this.kellySize(finalProb, entryPrice, max_trade_size, kelly_cap);

    if (size < 0.50) return null; // Skip tiny positions

    return {
      direction,
      entry_price: entryPrice,
      model_prob: modelProbUp,
      market_prob: marketProbUp,
      anchored_prob: finalProb,
      expected_value: ev,
      size,
      fee: this.calculateFee(entryPrice, size)
    };
  }

  // Standard normal CDF approximation (Abramowitz & Stegun)
  _normalCDF(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
  }
}

module.exports = { GBMSignalEngine };
