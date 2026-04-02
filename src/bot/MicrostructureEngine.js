class MicrostructureEngine {
  constructor() {
    this.btcPriceHistory = [];
    this.polyPriceHistory = [];
    this.maxHistory = 120;
  }

  /**
   * Record price samples for lag detection
   * btcPrice: BTC/USD (e.g., 83000)
   * polyPrice: Polymarket token price (0-1)
   */
  recordPrices(btcPrice, polyPrice) {
    const now = Date.now();
    this.btcPriceHistory.push({ price: btcPrice, timestamp: now });
    this.polyPriceHistory.push({ price: polyPrice, timestamp: now });
    if (this.btcPriceHistory.length > this.maxHistory) this.btcPriceHistory.shift();
    if (this.polyPriceHistory.length > this.maxHistory) this.polyPriceHistory.shift();
  }

  /**
   * Detect lag between BTC movement and Polymarket reaction
   * Returns 0-1 score (higher = more lag = more opportunity)
   */
  detectLatency() {
    if (this.btcPriceHistory.length < 30 || this.polyPriceHistory.length < 30) return 0;

    const btcNow = this.btcPriceHistory[this.btcPriceHistory.length - 1].price;
    const polyNow = this.polyPriceHistory[this.polyPriceHistory.length - 1].price;
    const btc30sAgo = this._getPriceAtOffset(this.btcPriceHistory, 30);
    const poly30sAgo = this._getPriceAtOffset(this.polyPriceHistory, 30);

    if (!btc30sAgo || !poly30sAgo || btc30sAgo === 0 || poly30sAgo === 0) return 0;

    // Compare percentage changes across different scales
    const btcDelta = (btcNow - btc30sAgo) / btc30sAgo;
    const polyDelta = (polyNow - poly30sAgo) / poly30sAgo;

    // If BTC moved but Poly hasn't caught up → lag detected → opportunity
    const lagScore = Math.abs(btcDelta) > 0.001
      ? Math.abs(btcDelta - polyDelta) / Math.max(Math.abs(btcDelta), 0.001)
      : 0;

    return Math.min(lagScore, 1.0);
  }

  _getPriceAtOffset(history, secondsAgo) {
    const targetTime = Date.now() - (secondsAgo * 1000);
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].timestamp <= targetTime) return history[i].price;
    }
    return history.length > 0 ? history[0].price : null;
  }

  /**
   * Composite microstructure analysis
   * 
   * PURPOSE: Measures "how much should we trust the current signal?"
   * This is NOT a trade gate — it informs the model probability.
   * Higher confidence → we believe our edge estimate more → stronger position.
   * 
   * Inputs should use real Polymarket order book data.
   */
  composite(data) {
    const {
      btcPrice, polyPrice,
      bidSize, askSize,
      largestBid, largestAsk,
      totalDepth, avgOrderSize
    } = data;

    // 1. Order book imbalance (-1 to +1)
    const totalSize = bidSize + askSize;
    const imbalance = totalSize > 0 ? (bidSize - askSize) / totalSize : 0;

    // 2. Whale detection
    const whaleThreshold = avgOrderSize > 0 ? avgOrderSize * 5 : 100;
    const bidWhale = largestBid > whaleThreshold ? 1 : 0;
    const askWhale = largestAsk > whaleThreshold ? 1 : 0;
    const whaleSignal = bidWhale - askWhale;

    // 3. Depth score — deeper book = more reliable pricing
    const depthScore = Math.min(totalDepth / 10000, 1.0);

    // 4. Latency score — lag between BTC and Polymarket
    const latencyScore = this.detectLatency();

    // Composite confidence (0-1)
    // This tells us how much to trust the signal, NOT whether to trade
    const confidence =
      Math.abs(imbalance) * 0.25 +
      Math.abs(whaleSignal) * 0.20 +
      depthScore * 0.20 +
      latencyScore * 0.35; // Lag is the biggest opportunity signal

    return {
      confidence: Math.min(confidence, 1.0),
      imbalance,
      whaleSignal,
      depthScore,
      latencyScore,
      totalDepth,
      hasMarketLag: latencyScore > 0.3,
      direction: imbalance > 0 ? 'BULLISH' : imbalance < 0 ? 'BEARISH' : 'NEUTRAL'
    };
  }
}

module.exports = MicrostructureEngine;
