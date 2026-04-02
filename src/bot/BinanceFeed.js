const WebSocket = require('ws');

class BinanceFeed {
  constructor() {
    this.ws = null;
    this.price = null;
    this.bestBid = null;
    this.bestAsk = null;
    this.bidQty = null;
    this.askQty = null;
    this.volume24h = null;
    this.reconnectDelay = 1000;
    this.isConnecting = false;
    this.priceHistory = [];
    this.maxHistoryLength = 120; // 2 minutes of 1s ticks
  }

  connect() {
    if (this.isConnecting) {
      return Promise.reject(new Error('BinanceFeed already connecting'));
    }
    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.isConnecting = false;
        reject(new Error('BinanceFeed WebSocket connection timeout (10s)'));
      }, 10000);

      // Clean up any existing connection
      if (this.ws) {
        this.ws.removeAllListeners();
        try { this.ws.terminate(); } catch (e) {}
        this.ws = null;
      }

      this.ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.isConnecting = false;
        this.reconnectDelay = 1000; // Reset backoff
        console.log('[BinanceFeed] Connected to Binance WebSocket');
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data);
          this.price = parseFloat(parsed.c);
          this.bestBid = parseFloat(parsed.b);
          this.bestAsk = parseFloat(parsed.a);
          this.bidQty = parseFloat(parsed.B);
          this.askQty = parseFloat(parsed.A);
          this.volume24h = parseFloat(parsed.v);

          // Track price history
          this.priceHistory.push({
            price: this.price,
            timestamp: Date.now()
          });
          if (this.priceHistory.length > this.maxHistoryLength) {
            this.priceHistory.shift();
          }
        } catch (e) {
          // Ignore parse errors on non-ticker messages
        }
      });

      this.ws.on('close', (code, reason) => {
        this.isConnecting = false;
        console.log(`[BinanceFeed] Disconnected (code: ${code}). Reconnecting in ${this.reconnectDelay}ms...`);

        // Clean up listeners before reconnecting
        if (this.ws) {
          this.ws.removeAllListeners();
        }

        setTimeout(() => {
          this.connect().catch(err => {
            console.error('[BinanceFeed] Reconnect failed:', err.message);
          });
        }, this.reconnectDelay);

        // Exponential backoff, max 30s
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        this.isConnecting = false;
        console.error('[BinanceFeed] WebSocket error:', err.message);
        // Don't reject if already resolved (error during established connection)
        reject(err);
      });
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.terminate(); } catch (e) {}
      this.ws = null;
    }
    this.isConnecting = false;
    console.log('[BinanceFeed] Disconnected');
  }

  getPrice() {
    return this.price;
  }

  getOrderBookImbalance() {
    if (!this.bidQty || !this.askQty) return 0;
    return (this.bidQty - this.askQty) / (this.bidQty + this.askQty);
  }

  getPriceHistory() {
    return this.priceHistory;
  }

  // Get price from N seconds ago
  getPriceSecondsAgo(seconds) {
    const targetTime = Date.now() - (seconds * 1000);
    for (let i = this.priceHistory.length - 1; i >= 0; i--) {
      if (this.priceHistory[i].timestamp <= targetTime) {
        return this.priceHistory[i].price;
      }
    }
    return this.priceHistory.length > 0 ? this.priceHistory[0].price : null;
  }

  // Calculate window delta score (% change over window)
  getWindowDeltaScore(windowSeconds = 30) {
    const currentPrice = this.price;
    const pastPrice = this.getPriceSecondsAgo(windowSeconds);
    if (!currentPrice || !pastPrice || pastPrice === 0) return 0;
    return ((currentPrice - pastPrice) / pastPrice) * 100;
  }
}

module.exports = BinanceFeed;
