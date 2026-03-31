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

  async fetchActiveBTCMarkets() {
    try {
      const now = Date.now();

      // Query 1: tag-based search for crypto intraday markets
      const queries = [
        { tag_slug: 'crypto', limit: 100, active: true, closed: false },
        { tag_slug: 'btc-usd', limit: 100, active: true, closed: false },
        { search: 'will btc', limit: 50, active: true, closed: false },
        { search: 'bitcoin higher', limit: 50, active: true, closed: false },
        { search: 'bitcoin lower', limit: 50, active: true, closed: false },
      ];

      let allMarkets = [];

      for (const params of queries) {
        try {
          const response = await axios.get(`${POLYMARKET_GAMMA_API}/markets`, { params, timeout: 8000 });
          const items = Array.isArray(response.data) ? response.data
            : (response.data?.markets || response.data?.data || []);

          // Only keep markets with future end dates
          const future = items.filter(m => {
            const end = m.endDate || m.endDateIso || m.end_date_iso;
            return end && new Date(end).getTime() > now;
          });

          console.log(`[PolymarketFeed] Query ${JSON.stringify(params).substring(0,60)}: ${items.length} total, ${future.length} future`);
          if (future.length > 0) {
            future.slice(0,3).forEach(m => {
              const end = m.endDate || m.endDateIso;
              const secs = Math.round((new Date(end) - now) / 1000);
              console.log(`  [${secs}s] "${(m.question||m.title||'?').substring(0,70)}"`);
            });
            allMarkets = allMarkets.concat(future);
          }
        } catch(e) {
          console.log(`[PolymarketFeed] Query failed: ${e.message}`);
        }
      }

      // Deduplicate
      const seen = new Set();
      allMarkets = allMarkets.filter(m => {
        const id = m.conditionId || m.id;
        if (!id || seen.has(id)) return false;
        seen.add(id); return true;
      });

      console.log(`[PolymarketFeed] Total future markets: ${allMarkets.length}`);

      // Filter: BTC + resolves within 4 hours
      const btcMarkets = allMarkets.filter(m => {
        const q = (m.question || m.title || m.slug || '').toLowerCase();
        const end = m.endDate || m.endDateIso;
        const secsToRes = end ? (new Date(end).getTime() - now) / 1000 : Infinity;
        return (q.includes('btc') || q.includes('bitcoin')) && secsToRes < 14400;
      });

      console.log(`[PolymarketFeed] BTC markets <4h: ${btcMarkets.length}`);
      btcMarkets.slice(0,5).forEach(m => {
        const end = m.endDate || m.endDateIso;
        const secs = Math.round((new Date(end) - now) / 1000);
        console.log(`  [${secs}s] "${(m.question||'?').substring(0,70)}" tokens:${(m.tokens||m.clobTokenIds||[]).length}`);
      });

      this.activeMarkets = btcMarkets;
      return this.activeMarkets;

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
