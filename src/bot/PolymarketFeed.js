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
    this.markets = new Map(); // conditionId -> market data
    this.orderBooks = new Map(); // conditionId -> { bids, asks, spread }
    this.activeMarkets = []; // Currently open BTC 5-min markets
    this.isConnected = false;
  }

  /**
   * Fetch active BTC Up/Down 5-minute markets from Polymarket
   */
  async fetchActiveBTCMarkets() {
    try {
      const response = await axios.get(`${POLYMARKET_GAMMA_API}/markets`, {
        params: {
          active: true,
          closed: false,
          tag: 'crypto',
          search: 'BTC',
          limit: 50
        },
        timeout: 10000
      });

      const markets = response.data?.markets || response.data || [];
      // Filter for 5-minute BTC up/down markets
      const btcMarkets = markets.filter(m => {
        const q = (m.question || '').toLowerCase();
        return q.includes('btc') && (q.includes('5-minute') || q.includes('5 minute')) &&
               (q.includes('up') || q.includes('down') || q.includes('higher') || q.includes('lower'));
      });

      this.activeMarkets = btcMarkets;
      return btcMarkets;
    } catch (err) {
      console.error('[PolymarketFeed] Failed to fetch markets:', err.message);
      return [];
    }
  }

  /**
   * Get order book for a specific market token
   */
  async getOrderBook(tokenId) {
    try {
      const response = await axios.get(`${POLYMARKET_CLOB_API}/book`, {
        params: { token_id: tokenId },
        timeout: 5000
      });

      const book = response.data;
      const bestBid = book.bids?.[0]?.price ? parseFloat(book.bids[0].price) : 0;
      const bestAsk = book.asks?.[0]?.price ? parseFloat(book.asks[0].price) : 1;
      const spread = bestAsk - bestBid;

      return { bids: book.bids, asks: book.asks, bestBid, bestAsk, spread };
    } catch (err) {
      return null;
    }
  }

  /**
   * Get the midpoint price for a market (used as "market probability")
   */
  async getMarketPrice(tokenId) {
    const book = await this.getOrderBook(tokenId);
    if (!book) return null;
    return (book.bestBid + book.bestAsk) / 2;
  }

  /**
   * Place a market order on Polymarket CLOB
   * Returns the trade result or throws on failure
   */
  async placeOrder({ tokenId, side, price, size, conditionId }) {
    try {
      // Sign the order with the user's private key
      const nonce = Date.now();
      const orderData = {
        token_id: tokenId,
        price: price.toFixed(4),
        size: size.toFixed(2),
        side: side, // 'BUY'
        type: 'FOK', // Fill or Kill for binary markets
        expiration: 0,
        nonce: nonce
      };

      // Create order hash for signing
      const orderHash = ethers.keccak256(
        ethers.toUtf8Bytes(JSON.stringify(orderData))
      );
      const signature = await this.wallet.signMessage(ethers.getBytes(orderHash));

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

  /**
   * Check if a market has resolved and get the result
   */
  async checkResolution(conditionId) {
    try {
      const response = await axios.get(`${POLYMARKET_GAMMA_API}/markets/${conditionId}`, {
        timeout: 5000
      });
      const market = response.data;
      return {
        resolved: market.closed || market.resolved,
        outcome: market.outcomePrices // e.g. [1, 0] for YES winning
      };
    } catch (err) {
      return { resolved: false };
    }
  }

  /**
   * Get Chainlink BTC price (resolution oracle)
   * Uses public Polygon RPC to read Chainlink aggregator
   */
  async getChainlinkPrice() {
    try {
      const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
      // Chainlink BTC/USD on Polygon
      const aggregatorABI = ['function latestAnswer() view returns (int256)'];
      const aggregator = new ethers.Contract(
        '0xc907E116054Ad103354f2D350FD2514433D57F6f',
        aggregatorABI,
        provider
      );
      const price = await aggregator.latestAnswer();
      return parseFloat(ethers.formatUnits(price, 8)); // 8 decimals
    } catch (err) {
      console.error('[PolymarketFeed] Chainlink price error:', err.message);
      return null;
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }
  }
}

module.exports = { PolymarketFeed };
