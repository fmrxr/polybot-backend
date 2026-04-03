class EVEngine {
  constructor() {
    // EV history per market for trend detection
    this.evHistory = {};      // marketId -> [{ev, direction, timestamp}]
    this.evPeaks = {};        // marketId -> { ev, direction, timestamp }
    this.maxHistory = 50;
  }

  /**
   * Calculate Expected Value for a position
   * @param {number} modelProb - Model's estimated probability of YES (0-1)
   * @param {number} marketPrice - Current market price / token price (0-1)
   * @param {string} direction - 'YES' or 'NO'
   * @returns {number} EV as a percentage
   */
  calculateRawEV(modelProb, marketPrice, direction) {
    if (!modelProb || !marketPrice || marketPrice <= 0 || marketPrice >= 1) return 0;
    if (modelProb <= 0 || modelProb >= 1) return 0;

    if (direction === 'YES') {
      // Buy YES at marketPrice
      // Win (prob = modelProb): payout 1, profit = 1 - marketPrice
      // Lose (prob = 1 - modelProb): payout 0, loss = marketPrice
      const ev = (modelProb * (1 - marketPrice)) - ((1 - modelProb) * marketPrice);
      return ev * 100; // as percentage
    } else {
      // Buy NO at (1 - marketPrice)
      // Win (prob = 1 - modelProb): payout 1, profit = marketPrice
      // Lose (prob = modelProb): payout 0, loss = (1 - marketPrice)
      const noPrice = 1 - marketPrice;
      const noProb = 1 - modelProb;
      const ev = (noProb * marketPrice) - (modelProb * noPrice);
      return ev * 100;
    }
  }

  /**
   * Calculate adjusted EV (raw - costs)
   * Spread is a COST COMPONENT, not a gate
   */
  calculateAdjustedEV(modelProb, marketPrice, direction, costs = {}) {
    const rawEV = this.calculateRawEV(modelProb, marketPrice, direction);
    const spreadCost = (costs.spread || 0) * 100;
    const slippageCost = (costs.estimatedSlippage || 0.005) * 100;
    const feeCost = (costs.fees || 0.002) * 100;

    return rawEV - spreadCost - slippageCost - feeCost;
  }

  /**
   * Determine optimal direction by comparing YES vs NO EV
   * Returns the direction with higher adjusted EV
   */
  evaluateBothSides(modelProb, yesPrice, costs = {}) {
    const evYes = this.calculateAdjustedEV(modelProb, yesPrice, 'YES', costs);
    const evNo = this.calculateAdjustedEV(modelProb, yesPrice, 'NO', costs);

    return {
      evYes,
      evNo,
      bestDirection: evYes >= evNo ? 'YES' : 'NO',
      bestEV: Math.max(evYes, evNo),
      evDifferential: Math.abs(evYes - evNo)
    };
  }

  /**
   * EV-driven flip evaluation
   * Should we flip from currentDirection to the opposite?
   * 
   * Flip IF:
   *   1. Current position EV < 0 (we're losing edge)
   *   2. Opposite position EV > current EV + threshold
   */
  evaluateFlip(modelProb, yesPrice, currentDirection, costs = {}, flipThreshold = 2.0) {
    const currentEV = this.calculateAdjustedEV(modelProb, yesPrice, currentDirection, costs);
    const oppositeDirection = currentDirection === 'YES' ? 'NO' : 'YES';
    const oppositeEV = this.calculateAdjustedEV(modelProb, yesPrice, oppositeDirection, costs);

    const shouldFlip = currentEV < 0 && oppositeEV > (currentEV + flipThreshold);

    return {
      currentEV,
      oppositeEV,
      currentDirection,
      oppositeDirection,
      shouldFlip,
      evGain: oppositeEV - currentEV,
      reason: shouldFlip
        ? `Flip ${currentDirection} → ${oppositeDirection}: current EV ${currentEV.toFixed(2)}% < 0, opposite EV ${oppositeEV.toFixed(2)}% (gain: +${(oppositeEV - currentEV).toFixed(2)}%)`
        : `Hold ${currentDirection}: EV ${currentEV.toFixed(2)}%, opposite ${oppositeEV.toFixed(2)}%`
    };
  }

  /**
   * Track EV over time for trend detection
   */
  recordEV(marketId, ev, direction) {
    if (!this.evHistory[marketId]) {
      this.evHistory[marketId] = [];
    }

    const entry = { ev, direction, timestamp: Date.now() };
    this.evHistory[marketId].push(entry);

    // Track peak EV
    if (!this.evPeaks[marketId] || ev > this.evPeaks[marketId].ev) {
      this.evPeaks[marketId] = entry;
    }

    // Trim history
    if (this.evHistory[marketId].length > this.maxHistory) {
      this.evHistory[marketId].shift();
    }
  }

  /**
   * EV Trend Filter: velocity + acceleration aware
   * Returns true if we should SKIP
   */
  isEVDecaying(marketId) {
    const history = this.evHistory[marketId];
    if (!history || history.length < 3) return false;

    const recent = history.slice(-3);

    // Velocity: rate of change between consecutive readings
    const v1 = recent[1].ev - recent[0].ev;
    const v2 = recent[2].ev - recent[1].ev;

    // Skip if EV is declining AND still decelerating (negative velocity + negative acceleration)
    const velocity = v2;
    const acceleration = v2 - v1;

    return velocity < 0 && acceleration <= 0;
  }

  /**
   * EV velocity — positive means EV is rising
   */
  getEVVelocity(marketId) {
    const history = this.evHistory[marketId];
    if (!history || history.length < 2) return 0;
    const last = history.slice(-2);
    return last[1].ev - last[0].ev;
  }

  /**
   * EV-Based Exit Signal: Should we take profit?
   * Exit if current EV has decayed to less than 50% of peak EV
   */
  shouldExitOnEVDecay(marketId, currentEV, decayRatio = 0.5) {
    const peak = this.evPeaks[marketId];
    if (!peak || peak.ev <= 0) return false;

    return currentEV < (peak.ev * decayRatio);
  }

  /**
   * Get EV stats for a market
   */
  getEVStats(marketId) {
    const history = this.evHistory[marketId] || [];
    const peak = this.evPeaks[marketId] || null;

    return {
      historyLength: history.length,
      currentEV: history.length > 0 ? history[history.length - 1].ev : null,
      peakEV: peak ? peak.ev : null,
      isDecaying: this.isEVDecaying(marketId),
      trend: this._calculateTrend(history)
    };
  }

  _calculateTrend(history) {
    if (history.length < 2) return 'INSUFFICIENT_DATA';
    const recent = history.slice(-5);
    let ups = 0, downs = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].ev > recent[i - 1].ev) ups++;
      else downs++;
    }
    if (ups > downs) return 'RISING';
    if (downs > ups) return 'FALLING';
    return 'FLAT';
  }

  /**
   * Clear history for a market (on position close)
   */
  clearMarket(marketId) {
    delete this.evHistory[marketId];
    delete this.evPeaks[marketId];
  }
}

module.exports = EVEngine;
