const WebSocket = require('ws');
const axios = require('axios');
const { ethers } = require('ethers');

const POLYMARKET_CLOB_API = 'https://clob.polymarket.com';
const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';

class PolymarketFeed {
  constructor(privateKey, userApiKey = null) {
    this.privateKey = privateKey;
    this.userApiKey = userApiKey;  // Per-user Polymarket API key (optional, overrides backend key)
    this.wallet = new ethers.Wallet(privateKey);
    this.address = this.wallet.address;
    this.ws = null;
    this.markets = new Map();
    this.orderBooks = new Map();
    this.activeMarkets = [];
    this.isConnected = false;
  }

  /**
   * Build the current market slug based on coin + period + current time window.
   * Polymarket 5-min markets follow the slug pattern:
   * "will-btc-be-higher-at-HH-MM-am-pm-et-on-month-day-year"
   * We discover by fetching the slug-based endpoint.
   */
  _getCurrentPeriodSlug(periodMinutes) {
    // Round current time up to the next period boundary
    const now = new Date();
    const ms = now.getTime();
    const periodMs = periodMinutes * 60 * 1000;
    const nextPeriod = new Date(Math.ceil(ms / periodMs) * periodMs);
    return nextPeriod;
  }

  /**
   * Calculate current 5-min window timestamp (Unix epoch rounded down to 300s boundary)
   * Polymarket slugs are deterministic: btc-updown-5m-{window_ts}
   */
  getCurrentWindowTs() {
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec - (nowSec % 300);
  }

  _extractClobTokenIds(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
      } catch (_) {}
      return value
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
    }
    if (typeof value === 'object') {
      if ('yes' in value || 'Yes' in value || 'no' in value || 'No' in value) {
        return [value.yes || value.Yes, value.no || value.No].filter(Boolean);
      }
      if ('0' in value || '1' in value) {
        return [value[0], value[1]].filter(Boolean);
      }
      return Object.values(value).filter(Boolean);
    }
    return [];
  }

  _getMarketWindowTs(market, event = {}) {
    const slug = String(market.slug || market.market_slug || event.slug || '').toLowerCase();
    const match = slug.match(/btc-updown-5m-(\d+)/);
    if (match) return parseInt(match[1], 10);

    const end = market.endDate || market.endDateIso || event.endDate;
    if (end) {
      const endSec = Math.floor(new Date(end).getTime() / 1000);
      if (!Number.isNaN(endSec)) return endSec - 300;
    }

    return null;
  }

  _normalizeMarketTokens(market, event = {}) {
    if (market.tokens && !Array.isArray(market.tokens)) {
      if (typeof market.tokens === 'string') {
        try {
          market.tokens = JSON.parse(market.tokens);
        } catch (_) {
          market.tokens = market.tokens.split(',').map(v => v.trim()).filter(Boolean);
        }
      } else if (typeof market.tokens === 'object') {
        market.tokens = Object.values(market.tokens).filter(Boolean);
      }
    }

    if (market.tokens && Array.isArray(market.tokens) && market.tokens.length > 0) return market;

    if (event.markets?.length === 1 && event.tokens && Array.isArray(event.tokens) && event.tokens.length > 0) {
      market.tokens = event.tokens;
      return market;
    }

    const tokenIds = this._extractClobTokenIds(market.clobTokenIds);
    if (tokenIds.length > 0) {
      market.tokens = tokenIds.map((id, i) => ({ token_id: id, outcome: i === 0 ? 'Yes' : 'No' }));
    }

    if (!market.windowTs) {
      const windowTs = this._getMarketWindowTs(market, event);
      if (windowTs) market.windowTs = windowTs;
    }

    return market;
  }

  _getAuthHeaders() {
    // Use per-user API key if provided, otherwise fall back to backend/env key
    const apiKey = this.userApiKey ||
                   process.env.POLYMARKET_API_KEY ||
                   process.env.POLY_API_KEY ||
                   process.env.POLY_CLOB_API_KEY ||
                   process.env.POLYMARKET_CLOB_API_KEY;
    if (!apiKey) {
      console.warn('[PolymarketFeed] No API key configured (user or backend)');
      return {};
    }
    return {
      'x-api-key': apiKey,
      'Authorization': `Bearer ${apiKey}`
    };
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Fetch the current AND next BTC 5-min market by constructing the slug directly.
   * No searching required — slug is clock-based.
   */
  async fetchActiveBTCMarkets() {
    try {
      const windowTs = this.getCurrentWindowTs();
      const offsets = [0, -300, 300, -600, 600, -900, 900];
      const slugs = [...new Set(offsets.map(offset => `btc-updown-5m-${windowTs + offset}`))];
      const found = [];
      const maxAttempts = 5;

      for (let attempt = 1; attempt <= maxAttempts && found.length === 0; attempt++) {
        if (attempt > 1) {
          console.log(`[PolymarketFeed] Retrying slug search (${attempt}/${maxAttempts})...`);
          await this._delay(2500);
        }

        for (const slug of slugs) {
          try {
            const response = await axios.get(`${POLYMARKET_GAMMA_API}/events`, {
              params: { slug },
              timeout: 8000,
              headers: this._getAuthHeaders()
            });

            const events = Array.isArray(response.data) ? response.data : [response.data];

            for (const event of events) {
              if (!event || !event.markets) continue;
              for (const market of event.markets) {
                this._normalizeMarketTokens(market, event);
                const end = market.endDate || market.endDateIso || event.endDate;
                const secsToRes = end ? (new Date(end).getTime() - Date.now()) / 1000 : -1;
                if (secsToRes > 10) {
                  if (!market.tokens || market.tokens.length === 0) {
                    this._normalizeMarketTokens(market, event);
                  }
                  const clobIds = this._extractClobTokenIds(market.clobTokenIds);
                  console.log(`[PolymarketFeed] ✅ Found market via slug ${slug}: "${market.question}" | ${Math.round(secsToRes)}s | tokens: ${(market.tokens||[]).length} | clobTokenIds: ${clobIds.length}`);
                  found.push(market);
                }
              }
            }
          } catch (e) {
            console.log(`[PolymarketFeed] Slug ${slug} not found: ${e.message}`);
          }
        }

        if (found.length === 0 && attempt < maxAttempts) {
          console.log('[PolymarketFeed] No markets found yet; waiting before retrying...');
        }
      }

      if (found.length === 0) {
        console.log('[PolymarketFeed] Slug approach found nothing — trying direct search...');
        try {
          const response = await axios.get(`${POLYMARKET_GAMMA_API}/markets`, {
            params: { active: true, closed: false, limit: 300, search: 'btc-updown-5m' },
            timeout: 8000,
            headers: this._getAuthHeaders()
          });
          const markets = Array.isArray(response.data) ? response.data : (response.data?.markets || []);
          const now = Date.now();
          for (const m of markets) {
            const end = m.endDate || m.endDateIso;
            const secsToRes = end ? (new Date(end).getTime() - now) / 1000 : -1;
            const slug = String(m.slug || m.market_slug || '').toLowerCase();
            const q = String(m.question || m.title || '').toLowerCase();
            if (secsToRes > 10 && secsToRes < 7200 && (slug.startsWith('btc-updown-5m-') || q.includes('btc') || q.includes('bitcoin'))) {
              this._normalizeMarketTokens(m);
              console.log(`[PolymarketFeed] Fallback found: "${m.question || m.title || '?'}" | ${Math.round(secsToRes)}s`);
              found.push(m);
            }
          }
        } catch (e) {
          console.error('[PolymarketFeed] Fallback search failed:', e.message);
        }
      }

      found.sort((a, b) => (a.windowTs || Infinity) - (b.windowTs || Infinity));
      this.activeMarkets = found;
      console.log(`[PolymarketFeed] Active markets: ${found.length}`);
      return found;

    } catch (err) {
      console.error('[PolymarketFeed] fetchActiveBTCMarkets error:', err.message);
      return [];
    }
  }

  async getOrderBook(tokenId) {
    try {
      const response = await axios.get(`${POLYMARKET_CLOB_API}/book`, {
        params: { token_id: tokenId },
        timeout: 5000
      });
      const book = response.data;
      const bestBid = book.bids?.[0]?.price ? parseFloat(book.bids[0].price) : 0;
      const bestAsk = book.asks?.[0]?.price ? parseFloat(book.asks[0].price) : 1;
      return { bids: book.bids, asks: book.asks, bestBid, bestAsk, spread: bestAsk - bestBid };
    } catch (err) {
      return null;
    }
  }

  async getMarketPrice(tokenId) {
    const book = await this.getOrderBook(tokenId);
    if (!book) return null;
    return (book.bestBid + book.bestAsk) / 2;
  }

  async placeOrder({ tokenId, side, price, size, conditionId }) {
    try {
      const nonce = Date.now();
      const orderData = {
        token_id: tokenId,
        price: price.toFixed(4),
        size: size.toFixed(2),
        side: side,
        type: 'FOK',
        expiration: 0,
        nonce: nonce
      };

      // Sign the order as a plain message (Polymarket expects wallet-signed orders)
      const messageToSign = JSON.stringify(orderData);
      const signature = await this.wallet.signMessage(messageToSign);

      const response = await axios.post(`${POLYMARKET_CLOB_API}/order`, {
        ...orderData,
        maker_address: this.address,
        signature
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });
      return response.data;
    } catch (err) {
      console.error('[PolymarketFeed] Order failed:', err.response?.data || err.message);
      throw new Error(err.response?.data?.error || 'Order placement failed');
    }
  }

  async getOrderStatus(orderId) {
    try {
      const response = await axios.get(`${POLYMARKET_CLOB_API}/order/${orderId}`, {
        timeout: 5000
      });
      const o = response.data;
      return {
        status: o.status || 'UNKNOWN',
        size_matched: o.size_matched || o.filled_size || 0,
        size_remaining: o.size_remaining || 0
      };
    } catch (err) {
      throw new Error(`Order status check failed: ${err.message}`);
    }
  }

  async checkResolution(conditionId) {
    try {
      const response = await axios.get(`${POLYMARKET_GAMMA_API}/markets/${conditionId}`, {
        timeout: 5000,
        headers: this._getAuthHeaders()
      });
      const market = response.data;
      return { resolved: market.closed || market.resolved, outcome: market.outcomePrices };
    } catch (err) {
      return { resolved: false };
    }
  }

  async getChainlinkPrice() {
    try {
      const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
      const aggregatorABI = ['function latestAnswer() view returns (int256)'];
      const aggregator = new ethers.Contract('0xc907E116054Ad103354f2D350FD2514433D57F6f', aggregatorABI, provider);
      const price = await aggregator.latestAnswer();
      return parseFloat(ethers.formatUnits(price, 8));
    } catch (err) {
      console.error('[PolymarketFeed] Chainlink price error:', err.message);
      return null;
    }
  }

  disconnect() {
    if (this.ws) { this.ws.removeAllListeners(); this.ws.close(); }
  }
}

module.exports = { PolymarketFeed };
