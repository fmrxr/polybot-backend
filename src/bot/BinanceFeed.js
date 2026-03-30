const WebSocket = require('ws');

class BinanceFeed {
  constructor() {
    this.ws = null;
    this.data = {
      price: null,
      vwap: null,
      volatility: null,
      momentum: null,
      obImbalance: null,
      drift: null,
      priceHistory: [],
      volumeHistory: []
    };
    this.reconnectDelay = 5000;
    this.isConnected = false;
  }

  connect() {
    return new Promise((resolve) => {
      // Combined stream: kline 1m + bookTicker for order flow
      this.ws = new WebSocket('wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1m/btcusdt@bookTicker/btcusdt@depth5@100ms');

      this.ws.on('open', () => {
        this.isConnected = true;
        console.log('[BinanceFeed] Connected');
        resolve();
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          this._handleMessage(msg);
        } catch (e) {}
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        console.log('[BinanceFeed] Disconnected, reconnecting...');
        setTimeout(() => this.connect(), this.reconnectDelay);
      });

      this.ws.on('error', (err) => {
        console.error('[BinanceFeed] Error:', err.message);
      });
    });
  }

  _handleMessage(msg) {
    if (!msg.data) return;
    const { stream, data } = msg;

    if (stream === 'btcusdt@kline_1m') {
      const k = data.k;
      const close = parseFloat(k.c);
      const open = parseFloat(k.o);
      const volume = parseFloat(k.v);
      const quoteVolume = parseFloat(k.q);

      this.data.price = close;

      // VWAP approximation from kline
      const typicalPrice = (parseFloat(k.h) + parseFloat(k.l) + close) / 3;
      this.data.priceHistory.push(typicalPrice);
      this.data.volumeHistory.push(volume);
      if (this.data.priceHistory.length > 30) {
        this.data.priceHistory.shift();
        this.data.volumeHistory.shift();
      }

      // VWAP
      const totalPV = this.data.priceHistory.reduce((s, p, i) => s + p * this.data.volumeHistory[i], 0);
      const totalV = this.data.volumeHistory.reduce((s, v) => s + v, 0);
      this.data.vwap = totalV > 0 ? totalPV / totalV : close;

      // Volatility: rolling std dev of returns (annualized to per-second for GBM)
      if (this.data.priceHistory.length >= 5) {
        const returns = [];
        for (let i = 1; i < this.data.priceHistory.length; i++) {
          returns.push(Math.log(this.data.priceHistory[i] / this.data.priceHistory[i - 1]));
        }
        const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
        const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
        const volPerMinute = Math.sqrt(variance);
        // Convert to per-second volatility for GBM (5min window)
        this.data.volatility = volPerMinute * Math.sqrt(60); // annualized per sqrt(second)
        this.data.drift = mean / 60; // per-second drift
      }

      // Momentum: rate of change over last 5 bars
      if (this.data.priceHistory.length >= 5) {
        const recent = this.data.priceHistory.slice(-5);
        this.data.momentum = (recent[recent.length - 1] - recent[0]) / recent[0];
      }
    }

    if (stream === 'btcusdt@depth5@100ms') {
      // Order book imbalance: (bid volume - ask volume) / (bid + ask)
      const bids = data.bids || [];
      const asks = data.asks || [];
      const bidVol = bids.reduce((s, b) => s + parseFloat(b[1]), 0);
      const askVol = asks.reduce((s, a) => s + parseFloat(a[1]), 0);
      const total = bidVol + askVol;
      this.data.obImbalance = total > 0 ? (bidVol - askVol) / total : 0;
    }
  }

  getMarketData() {
    return { ...this.data };
  }

  disconnect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }
  }
}

module.exports = { BinanceFeed };
