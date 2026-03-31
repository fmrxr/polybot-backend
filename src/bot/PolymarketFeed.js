const WebSocket = require('ws');
const axios = require('axios');
const { ethers } = require('ethers');

const POLYMARKET_CLOB_API = 'https://clob.polymarket.com';
const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';

class PolymarketFeed {
  constructor(privateKey) {
    this.privateKey = privateKey;
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

  /**
   * Fetch the current AND next BTC 5-min market by constructing the slug directly.
   * No searching required — slug is clock-based.
   */
  async fetchActiveBTCMarkets() {
    try {
      const windowTs = this.getCurrentWindowTs();
      const slugs = [
        `btc-updown-5m-${windowTs}`,           // Current window
        `btc-updown-5m-${windowTs + 300}`,      // Next window
        `btc-updown-5m-${windowTs - 300}`,      // Previous (may still be open)
      ];

      const found = [];

      for (const slug of slugs) {
        try {
          const response = await axios.get(`${POLYMARKET_GAMMA_API}/events`, {
            params: { slug },
            timeout: 8000
          });

          const events = Array.isArray(response.data) ? response.data : [response.data];

          for (const event of events) {
            if (!event || !event.markets) continue;
            for (const market of event.markets) {
              const end = market.endDate || market.endDateIso || event.endDate;
              const secsToRes = end ? (new Date(end).getTime() - Date.now()) / 1000 : -1;
              if (secsToRes > 10) {
                // Tokens may be at event level or market level — merge them in
                if (!market.tokens || market.tokens.length === 0) {
                  if (event.markets.length === 1 && event.tokens) {
                    market.tokens = event.tokens;
                  } else if (market.outcomePrices && market.clobTokenIds) {
                    // Build token objects from clobTokenIds
                    market.tokens = market.clobTokenIds.map((id, i) => ({ token_id: id, outcome: i === 0 ? 'Yes' : 'No' }));
                  } else {
                    // Log full market structure so we can see what fields exist
                    console.log(`[PolymarketFeed] Market fields: ${Object.keys(market).join(', ')}`);
                    console.log(`[PolymarketFeed] Event fields: ${Object.keys(event).join(', ')}`);
                    if (event.markets[0]) console.log(`[PolymarketFeed] First market keys: ${Object.keys(event.markets[0]).join(', ')}`);
                  }
                }
                console.log(`[PolymarketFeed] ✅ Found market via slug ${slug}: "${market.question}" | ${Math.round(secsToRes)}s | tokens: ${(market.tokens||market.clobTokenIds||[]).length} | clobTokenIds: ${(market.clobTokenIds||[]).length}`);
                found.push(market);
              }
            }
          }
        } catch(e) {
          console.log(`[PolymarketFeed] Slug ${slug} not found: ${e.message}`);
        }
      }

      // Fallback: if slug approach fails, try direct market search
      if (found.length === 0) {
        console.log('[PolymarketFeed] Slug approach found nothing — trying direct search...');
        try {
          const response = await axios.get(`${POLYMARKET_GAMMA_API}/markets`, {
            params: { active: true, closed: false, limit: 100, search: 'btc' },
            timeout: 8000
          });
          const markets = Array.isArray(response.data) ? response.data : (response.data?.markets || []);
          const now = Date.now();
          for (const m of markets) {
            const end = m.endDate || m.endDateIso;
            const secsToRes = end ? (new Date(end).getTime() - now) / 1000 : -1;
            if (secsToRes > 10 && secsToRes < 7200) {
              const q = (m.question || m.title || '').toLowerCase();
              if (q.includes('btc') || q.includes('bitcoin')) {
                console.log(`[PolymarketFeed] Fallback found: "${m.question}" | ${Math.round(secsToRes)}s`);
                found.push(m);
              }
            }
          }
        } catch(e) {
          console.error('[PolymarketFeed] Fallback search failed:', e.message);
        }
      }

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
      const orderHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(orderData)));
      const signature = await this.wallet.signMessage(ethers.getBytes(orderHash));
      const response = await axios.post(`${POLYMARKET_CLOB_API}/order`, {
        ...orderData, maker_address: this.address, signature
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
      return response.data;
    } catch (err) {
      console.error('[PolymarketFeed] Order failed:', err.response?.data || err.message);
      throw new Error(err.response?.data?.error || 'Order placement failed');
    }
  }

  async getOrderStatus(orderId) {
    try {
      const response = await axios.get(`${POLYMARKET_CLOB_API}/order/${orderId}`, { timeout: 5000 });
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
      const response = await axios.get(`${POLYMARKET_GAMMA_API}/markets/${conditionId}`, { timeout: 5000 });
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
