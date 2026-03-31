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

  async fetchActiveBTCMarkets() {
    try {
      // Try multiple endpoints — 5-min markets may be under events or specific tag slugs
      const endpoints = [
        `${POLYMARKET_GAMMA_API}/markets?active=true&closed=false&tag_slug=btc-usd-5-minute&limit=50`,
        `${POLYMARKET_GAMMA_API}/markets?active=true&closed=false&tag_slug=crypto-btc-intraday&limit=50`,
        `${POLYMARKET_GAMMA_API}/events?active=true&closed=false&tag_slug=crypto&limit=50`,
        `${POLYMARKET_GAMMA_API}/markets?active=true&closed=false&limit=100`,
      ];

      let allMarkets = [];

      for (const url of endpoints) {
        try {
          const response = await axios.get(url, { timeout: 8000 });
          const data = response.data;
          // Handle both array and {markets:[]} response shapes
          let items = Array.isArray(data) ? data : (data.markets || data.events || data.data || []);
          // If events, extract nested markets
          if (items[0]?.markets) {
            items = items.flatMap(e => e.markets || []);
          }
          console.log(`[PolymarketFeed] ${url.split('?')[1]}: ${items.length} items`);
          if (items.length > 0) {
            console.log('[PolymarketFeed] Sample:', items.slice(0,3).map(m => m.question||m.title||'?').join(' | '));
            allMarkets = allMarkets.concat(items);
            if (items.length > 5) break; // Found a good source, stop
          }
        } catch(e) {
          console.log(`[PolymarketFeed] Endpoint failed: ${e.message}`);
        }
      }

      // Deduplicate by conditionId
      const seen = new Set();
      allMarkets = allMarkets.filter(m => {
        const id = m.conditionId || m.condition_id || m.id;
        if (seen.has(id)) return false;
        seen.add(id); return true;
      });

      // Filter for short-term BTC price markets
      const btcShortTerm = allMarkets.filter(m => {
        const q = (m.question || m.title || m.slug || '').toLowerCase();
        const hasBTC = q.includes('btc') || q.includes('bitcoin');
        const isShortTerm = q.includes('higher') || q.includes('lower') || q.includes('above') ||
                            q.includes('below') || q.includes('up') || q.includes('down') ||
                            q.includes('5-min') || q.includes('minute') || q.includes('hour') ||
                            q.includes('pm') || q.includes('am') || q.includes('today');
        // Also check resolution time — short-term = resolves within 24h
        const endDate = m.endDateIso || m.end_date_iso || m.endDate || m.end_date;
        const timeToRes = endDate ? (new Date(endDate).getTime() - Date.now()) / 1000 : Infinity;
        return hasBTC && (isShortTerm || timeToRes < 86400);
      });

      this.activeMarkets = btcShortTerm.length > 0 ? btcShortTerm : allMarkets.filter(m => {
        const endDate = m.endDateIso || m.end_date_iso || m.endDate || m.end_date;
        const timeToRes = endDate ? (new Date(endDate).getTime() - Date.now()) / 1000 : Infinity;
        const q = (m.question || m.title || '').toLowerCase();
        return (q.includes('btc') || q.includes('bitcoin')) && timeToRes < 86400;
      });

      console.log(`[PolymarketFeed] Final active markets: ${this.activeMarkets.length}`);
      this.activeMarkets.slice(0,5).forEach(m => {
        const end = m.endDateIso || m.end_date_iso || m.endDate || m.end_date || '?';
        const secs = end !== '?' ? Math.round((new Date(end).getTime() - Date.now()) / 1000) : '?';
        console.log(`  -> "${(m.question||m.title||'?').substring(0,60)}" | ${secs}s`);
      });

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
