const WebSocket = require('ws');

/**
 * Real-time Polymarket price feed via CLOB WebSocket.
 * Subscribes to token price updates and maintains a live cache.
 *
 * Polymarket WS: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * Subscribe msg: { type: "market", assets_ids: ["tokenId1", "tokenId2", ...] }
 * Price update:  { asset_id, price, size, side, timestamp, ... }
 */
class PolymarketPriceFeed {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.reconnectDelay = 2000;
    this._reconnectTimer = null;
    this._pingTimer = null;

    // Live price cache: tokenId -> { price, timestamp, side }
    this._prices = new Map();
    // Subscribed token IDs
    this._subscribedTokens = new Set();
  }

  /**
   * Connect to Polymarket WebSocket.
   * Resolves when connected (does not wait for first message).
   */
  connect() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('PolymarketPriceFeed: connection timeout (10s)'));
      }, 10000);

      if (this.ws) {
        this.ws.removeAllListeners();
        try { this.ws.terminate(); } catch (_) {}
        this.ws = null;
      }

      this.ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.reconnectDelay = 2000;
        console.log('[PolymarketPriceFeed] Connected');

        // Re-subscribe to any tokens that were previously subscribed
        if (this._subscribedTokens.size > 0) {
          this._sendSubscribe([...this._subscribedTokens]);
        }

        // Keepalive ping every 30s — Polymarket closes idle connections
        this._pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, 30000);

        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msgs = JSON.parse(data);
          // Polymarket sends arrays of events
          const events = Array.isArray(msgs) ? msgs : [msgs];
          for (const event of events) {
            this._handleEvent(event);
          }
        } catch (_) {}
      });

      this.ws.on('close', () => {
        clearTimeout(timeout);
        this.isConnected = false;
        clearInterval(this._pingTimer);
        console.log('[PolymarketPriceFeed] Disconnected — reconnecting...');
        this._scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[PolymarketPriceFeed] WS error:', err.message);
        // close event will fire after error, triggering reconnect
      });
    });
  }

  disconnect() {
    clearInterval(this._pingTimer);
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.terminate(); } catch (_) {}
      this.ws = null;
    }
    this.isConnected = false;
    console.log('[PolymarketPriceFeed] Disconnected');
  }

  /**
   * Subscribe to real-time price updates for a list of token IDs.
   * Safe to call multiple times — deduplicates internally.
   */
  subscribe(tokenIds) {
    const newIds = tokenIds.filter(id => id && !this._subscribedTokens.has(id));
    if (newIds.length === 0) return;
    for (const id of newIds) this._subscribedTokens.add(id);
    if (this.isConnected) {
      this._sendSubscribe(newIds);
    }
    // If not connected, tokens will be subscribed on reconnect (see open handler)
  }

  /**
   * Unsubscribe tokens no longer needed (e.g. expired markets).
   */
  unsubscribe(tokenIds) {
    for (const id of tokenIds) this._subscribedTokens.delete(id);
    // No explicit unsub message in Polymarket WS — just stop tracking
    for (const id of tokenIds) this._prices.delete(id);
  }

  /**
   * Get the latest live price for a token.
   * Returns null if no update received yet.
   */
  getPrice(tokenId) {
    return this._prices.get(tokenId) || null;
  }

  /**
   * Get live YES price for a market given YES tokenId.
   * Returns null if no update received.
   */
  getYesPrice(yesTokenId) {
    const entry = this._prices.get(yesTokenId);
    return entry ? entry.price : null;
  }

  _sendSubscribe(tokenIds) {
    if (!tokenIds.length) return;
    const msg = JSON.stringify({ type: 'market', assets_ids: tokenIds });
    try {
      this.ws.send(msg);
      console.log(`[PolymarketPriceFeed] Subscribed to ${tokenIds.length} token(s)`);
    } catch (e) {
      console.error('[PolymarketPriceFeed] Subscribe send failed:', e.message);
    }
  }

  _handleEvent(event) {
    // Price update events have asset_id + price fields
    if (!event || !event.asset_id) return;
    const price = parseFloat(event.price);
    if (isNaN(price) || price < 0 || price > 1) return;
    const prev = this._prices.get(event.asset_id);
    this._prices.set(event.asset_id, {
      price,
      side: event.side,
      size: parseFloat(event.size) || 0,
      timestamp: Date.now(), // always use local receive time — WS events are real-time
    });
    // Log significant price moves (>1¢)
    if (prev && Math.abs(price - prev.price) > 0.01) {
      console.log(`[PolymarketPriceFeed] ${event.asset_id.slice(0,12)}... ${prev.price.toFixed(3)} → ${price.toFixed(3)}`);
    }
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (e) {
        console.error('[PolymarketPriceFeed] Reconnect failed:', e.message);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        this._scheduleReconnect();
      }
    }, this.reconnectDelay);
  }
}

module.exports = PolymarketPriceFeed;
