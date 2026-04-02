const { ClobClient } = require('@polymarket/clob-client');

class PolymarketFeed {
  constructor(privateKey, walletAddress) {
    this.privateKey = privateKey;
    this.walletAddress = walletAddress;
    this.clobClient = null;
    this.marketsCache = [];
    this.lastMarketFetch = null;
    this.marketCacheTTL = 60000; // 1 minute
  }

  async initialize() {
    try {
      if (this.privateKey && this.walletAddress) {
        this.clobClient = new ClobClient(
          'https://clob.polymarket.com',
          137, // Polygon chain ID
          this.privateKey,
          undefined,
          this.walletAddress
        );
        console.log('[PolymarketFeed] CLOB client initialized (authenticated)');
      } else {
        this.clobClient = new ClobClient('https://clob.polymarket.com', 137);
        console.log('[PolymarketFeed] CLOB client initialized (read-only)');
      }
    } catch (err) {
      console.error('[PolymarketFeed] Failed to initialize CLOB client:', err.message);
      throw err;
    }
  }

  async fetchActiveBTCMarkets() {
    try {
      // Check cache
      if (this.marketsCache.length > 0 && this.lastMarketFetch &&
          (Date.now() - this.lastMarketFetch) < this.marketCacheTTL) {
        return this.marketsCache;
      }

      const response = await fetch('https://gamma-api.polymarket.com/markets?' + new URLSearchParams({
        closed: 'false',
        active: 'true',
        limit: '50',
        order: 'volume24hr',
        ascending: 'false',
      }));

      if (!response.ok) {
        throw new Error(`Gamma API returned ${response.status}`);
      }

      const markets = await response.json();

      // Filter for BTC-related markets
      const btcMarkets = markets.filter(m => {
        const q = (m.question || '').toLowerCase();
        return q.includes('btc') || q.includes('bitcoin');
      });

      this.marketsCache = btcMarkets;
      this.lastMarketFetch = Date.now();

      console.log(`[PolymarketFeed] Fetched ${btcMarkets.length} active BTC markets`);
      return btcMarkets;
    } catch (err) {
      console.error('[PolymarketFeed] fetchActiveBTCMarkets failed:', err.message);
      return this.marketsCache; // Return stale cache on error
    }
  }

  /**
   * Fetch REAL order book data from Polymarket CLOB
   * Returns: { bestBid, bestAsk, bidDepth, askDepth, largestBid, largestAsk, totalDepth }
   * All prices are 0-1 (token probability prices)
   */
  async getOrderBook(tokenId) {
    if (!this.clobClient) {
      console.error('[PolymarketFeed] CLOB client not initialized');
      return null;
    }

    try {
      const book = await this.clobClient.getOrderBook(tokenId);
      const bids = book.bids || [];
      const asks = book.asks || [];

      if (bids.length === 0 && asks.length === 0) {
        console.warn(`[PolymarketFeed] Empty order book for token ${tokenId}`);
        return null;
      }

      const bidDepth = bids.reduce((sum, b) => sum + parseFloat(b.size), 0);
      const askDepth = asks.reduce((sum, a) => sum + parseFloat(a.size), 0);
      const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : null;
      const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : null;
      const largestBid = bids.length > 0 ? Math.max(...bids.map(b => parseFloat(b.size))) : 0;
      const largestAsk = asks.length > 0 ? Math.max(...asks.map(a => parseFloat(a.size))) : 0;
      const totalDepth = bidDepth + askDepth;

      return {
        bestBid,
        bestAsk,
        bidDepth,
        askDepth,
        largestBid,
        largestAsk,
        totalDepth,
        bidCount: bids.length,
        askCount: asks.length,
        spread: bestAsk && bestBid ? bestAsk - bestBid : null,
        midPrice: bestAsk && bestBid ? (bestAsk + bestBid) / 2 : null
      };
    } catch (err) {
      console.error(`[PolymarketFeed] getOrderBook failed for ${tokenId}:`, err.message);
      return null;
    }
  }

  /**
   * Get live token price (mid-price from order book)
   */
  async getLiveTokenPrice(tokenId) {
    try {
      const book = await this.getOrderBook(tokenId);
      if (!book || !book.midPrice) return null;
      return book.midPrice;
    } catch (err) {
      console.error(`[PolymarketFeed] getLiveTokenPrice failed for ${tokenId}:`, err.message);
      return null;
    }
  }

  /**
   * Fetch balance for a wallet
   */
  static async fetchBalance(privateKey, walletAddress) {
    try {
      const client = new ClobClient(
        'https://clob.polymarket.com',
        137,
        privateKey,
        undefined,
        walletAddress
      );
      // Fetch USDC balance on Polygon
      const balance = await client.getBalance();
      return {
        usdc: parseFloat(balance || '0'),
        wallet: walletAddress
      };
    } catch (err) {
      console.error('[PolymarketFeed] fetchBalance failed:', err.message);
      return { usdc: 0, wallet: walletAddress };
    }
  }

  /**
   * Place a market order on Polymarket
   */
  async placeOrder(tokenId, side, size, price) {
    if (!this.clobClient) {
      throw new Error('CLOB client not initialized for trading');
    }

    try {
      const order = await this.clobClient.createAndPlaceOrder({
        tokenId: tokenId,
        side: side, // 'BUY' or 'SELL'
        size: size,
        price: price,
      });
      console.log(`[PolymarketFeed] Order placed: ${side} ${size} @ ${price} for token ${tokenId}`);
      return order;
    } catch (err) {
      console.error(`[PolymarketFeed] placeOrder failed:`, err.message);
      throw err;
    }
  }
}

module.exports = PolymarketFeed;
