/**
 * MicrostructureEngine — Detect market inefficiencies
 *
 * PRIMARY EDGE: Exploit market delay (not prediction)
 *
 * Signals:
 * 1. BTC moves fast but Polymarket price lags → entry signal
 * 2. Order book imbalance (more sellers than buyers) → fade extremes
 * 3. Thin liquidity zone (< $500 depth) → higher slippage risk
 * 4. Aggressive buyer/seller (large single orders) → momentum confirmation
 *
 * Philosophy: Trade the inefficiency, not the direction
 */

class MicrostructureEngine {
  constructor(settings = {}) {
    this.settings = settings;
    // Price history for latency detection
    this.btcPriceHistory = [];
    this.polyPriceHistory = [];
    this.maxHistory = 60; // Keep last 60 observations (~1 min)
  }

  /**
   * Update price histories
   * @param {number} btcPrice - BTC spot price
   * @param {number} polyPrice - Polymarket YES price
   */
  update(btcPrice, polyPrice) {
    if (!btcPrice || !polyPrice) return;

    this.btcPriceHistory.push({
      price: btcPrice,
      ts: Date.now()
    });
    this.polyPriceHistory.push({
      price: polyPrice,
      ts: Date.now()
    });

    // Keep only last N observations
    if (this.btcPriceHistory.length > this.maxHistory) {
      this.btcPriceHistory.shift();
    }
    if (this.polyPriceHistory.length > this.maxHistory) {
      this.polyPriceHistory.shift();
    }
  }

  /**
   * Detect latency: BTC moved fast but Poly is stale
   *
   * Returns score -1 to +1:
   * +1 = BTC up significantly but Poly price lags (BUY signal)
   * -1 = BTC down significantly but Poly price lags (SELL signal)
   *  0 = No clear latency signal
   *
   * @param {number} minMovement - Min BTC move to trigger (e.g., 0.0005 = 0.05%)
   * @returns {number} Latency signal score
   */
  detectLatency(minMovement = 0.0005) {
    if (this.btcPriceHistory.length < 3) return 0;

    // Get recent BTC price change (last 30s window)
    const btcNow = this.btcPriceHistory[this.btcPriceHistory.length - 1].price;
    const btc30sAgo = this.btcPriceHistory[Math.max(0, this.btcPriceHistory.length - 6)].price;
    const btcDelta = (btcNow - btc30sAgo) / btc30sAgo;

    // Get Poly price change in same period
    const polyNow = this.polyPriceHistory[this.polyPriceHistory.length - 1].price;
    const poly30sAgo = this.polyPriceHistory[Math.max(0, this.polyPriceHistory.length - 6)].price;
    const polyDelta = (polyNow - poly30sAgo) / poly30sAgo;

    // If BTC moved significantly but Poly didn't follow → latency signal
    if (Math.abs(btcDelta) > minMovement && Math.abs(polyDelta) < minMovement / 2) {
      return Math.sign(btcDelta) * 0.7; // Strong latency signal
    }

    if (Math.abs(btcDelta) > minMovement && Math.sign(btcDelta) !== Math.sign(polyDelta)) {
      return Math.sign(btcDelta) * 0.4; // Moderate divergence
    }

    return 0;
  }

  /**
   * Order book imbalance detection
   *
   * Returns score -1 to +1:
   * +1 = Many sellers (oversold, mean revert UP)
   * -1 = Many buyers (overbought, mean revert DOWN)
   *  0 = Balanced
   *
   * @param {number} bidSize - Total bid volume (depth)
   * @param {number} askSize - Total ask volume (depth)
   * @returns {number} Imbalance score
   */
  detectImbalance(bidSize, askSize) {
    if (!bidSize || !askSize || bidSize + askSize === 0) return 0;

    // Imbalance ratio
    const imbalance = (bidSize - askSize) / (bidSize + askSize);

    // Scale to -1 to +1 and negate for mean reversion:
    // More bids (positive imbalance) → overbought → mean revert DOWN → score negative
    // More asks (negative imbalance) → oversold  → mean revert UP   → score positive
    return Math.max(-1, Math.min(1, -imbalance * 2));
  }

  /**
   * Thin liquidity detection
   *
   * @param {number} totalDepth - Total market depth (dollars)
   * @returns {object}
   *   - isThin: boolean
   *   - severity: 0–1 (0=plenty, 1=critically thin)
   */
  detectThinLiquidity(totalDepth) {
    const DEEP = 5000;   // Comfortable depth
    const THIN = 500;    // Risky zone
    const CRITICAL = 100; // Don't trade

    let severity = 0;
    let isThin = false;

    if (totalDepth < CRITICAL) {
      severity = 1.0;
      isThin = true;
    } else if (totalDepth < THIN) {
      severity = 0.8;
      isThin = true;
    } else if (totalDepth < DEEP) {
      severity = (DEEP - totalDepth) / (DEEP - THIN) * 0.3;
      isThin = true;
    }

    return { isThin, severity };
  }

  /**
   * Aggressive buyer/seller detection
   *
   * Large single order = potential momentum signal
   *
   * @param {number} largestBid - Largest single bid order
   * @param {number} largestAsk - Largest single ask order
   * @param {number} avgOrderSize - Average order size
   *
   * @returns {number} Score -1 to +1
   *   +1 = Aggressive buyer (large bids) → momentum UP
   *   -1 = Aggressive seller (large asks) → momentum DOWN
   *    0 = No dominant aggressor
   */
  detectAggression(largestBid, largestAsk, avgOrderSize = 1) {
    if (!largestBid || !largestAsk) return 0;

    const bidRatio = largestBid / avgOrderSize;
    const askRatio = largestAsk / avgOrderSize;

    // If one side has much larger orders → signal
    if (bidRatio > 3 && bidRatio > askRatio * 1.5) {
      return Math.min(1, bidRatio / 10); // Aggressive buyers
    }
    if (askRatio > 3 && askRatio > bidRatio * 1.5) {
      return -Math.min(1, askRatio / 10); // Aggressive sellers
    }

    return 0;
  }

  /**
   * COMPOSITE MICROSTRUCTURE SIGNAL
   *
   * Combines all signals into one score:
   * +1 = Strong BUY signal (latency UP + imbalance favors up + aggression up)
   * -1 = Strong SELL signal
   *  0 = No clear signal / conflicting signals
   *
   * @param {object} params
   *   - btcPrice, polyPrice
   *   - bidSize, askSize
   *   - largestBid, largestAsk
   *   - totalDepth
   *   - avgOrderSize
   *
   * @returns {object}
   *   - signal: -1 to +1 (direction + strength)
   *   - components: {latency, imbalance, aggression}
   *   - confidence: 0–1 (how strong is this signal)
   */
  composite(params) {
    const {
      btcPrice, polyPrice,
      bidSize = 0, askSize = 0,
      largestBid = 0, largestAsk = 0,
      totalDepth = 1000,
      avgOrderSize = 1
    } = params;

    // Update price history
    if (btcPrice && polyPrice) {
      this.update(btcPrice, polyPrice);
    }

    // Individual signals
    const latency = this.detectLatency(0.0005);
    const imbalance = this.detectImbalance(bidSize, askSize);
    const aggression = this.detectAggression(largestBid, largestAsk, avgOrderSize);
    const { isThin, severity } = this.detectThinLiquidity(totalDepth);

    // Weighted composite (give more weight to latency and imbalance)
    let signal = (
      latency * 0.4 +
      imbalance * 0.4 +
      aggression * 0.2
    );

    // Discount signal if liquidity is too thin (less reliable)
    if (isThin) {
      signal *= (1 - severity * 0.5);
    }

    // Confidence = how consistent are the signals
    const signalConsistency = 1 - (
      Math.abs(Math.sign(latency) - Math.sign(imbalance)) / 2 +
      Math.abs(Math.sign(latency) - Math.sign(aggression)) / 2
    );

    const confidence = Math.abs(signal) * signalConsistency;

    return {
      signal: parseFloat(signal.toFixed(2)),
      components: {
        latency: parseFloat(latency.toFixed(2)),
        imbalance: parseFloat(imbalance.toFixed(2)),
        aggression: parseFloat(aggression.toFixed(2))
      },
      confidence: parseFloat(Math.min(1, confidence).toFixed(2)),
      thin_liquidity: isThin,
      liquidity_severity: parseFloat(severity.toFixed(2))
    };
  }
}

module.exports = { MicrostructureEngine };
