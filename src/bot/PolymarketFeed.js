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
      const response = await axios.get(`${POLYMARKET_GAMMA_API}/markets`, {
        params: { active: true, closed: false, tag: 'crypto', search: 'BTC', limit: 50 },
        timeout: 10000
      });
      const markets = response.data?.markets || response.data || [];
      // Log all markets found for debugging
      console.log('[PolymarketFeed] Total markets from API:', markets.length);
      if (markets.length > 0) {
        console.log('[PolymarketFeed] Sample questions:',
          markets.slice(0, 5).map(m => m.question || m.title || '?').join(' | '));
      }

      // Broad filter: any market mentioning BTC/Bitcoin price movement
      const filtered = markets.filter(m => {
        const q = (m.question || m.title || m.slug || '').toLowerCase();
        const hasBTC = q.includes('btc') || q.includes('bitcoin');
        const hasMovement = q.includes('higher') || q.includes('lower') || q.includes('above') ||
                            q.includes('below') || q.includes('up') || q.includes('down') ||
                            q.includes('over') || q.includes('under') || q.includes('exceed') ||
                            q.includes('5-min') || q.includes('5 min') || q.includes('minute');
        return hasBTC && hasMovement;
      });

      // If filtered is empty, take ALL BTC markets as fallback
      this.activeMarkets = filtered.length > 0 ? filtered : markets.filter(m => {
        const q = (m.question || m.title || m.slug || '').toLowerCase();
        return q.includes('btc') || q.includes('bitcoin');
      });

      console.log('[PolymarketFeed] Active BTC markets found:', this.activeMarkets.length);
      if (this.activeMarkets.length > 0) {
        console.log('[PolymarketFeed] Markets:', this.activeMarkets.slice(0,3).map(m => m.question||m.title).join(' | '));
      }
      return this.activeMarkets;
    } catch (err) {
      console.error('[PolymarketFeed] Failed to fetch markets:', err.message);
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
