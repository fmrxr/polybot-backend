// ClobClient is ESM-only — must be loaded with dynamic import()
let _ClobClient = null;
async function getClobClient() {
  if (!_ClobClient) {
    const mod = await import('@polymarket/clob-client');
    _ClobClient = mod.ClobClient;
  }
  return _ClobClient;
}

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
      const ClobClient = await getClobClient();
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
      // Short cache for 5-min markets — new windows open every 5 minutes
      const CACHE_TTL = 30000; // 30 seconds
      if (this.marketsCache.length > 0 && this.lastMarketFetch &&
          (Date.now() - this.lastMarketFetch) < CACHE_TTL) {
        return this.marketsCache;
      }

      // Fetch a broad set and filter client-side by end date
      const response = await fetch('https://gamma-api.polymarket.com/markets?' + new URLSearchParams({
        closed: 'false',
        active: 'true',
        limit: '200',
      }));

      if (!response.ok) {
        throw new Error(`Gamma API returned ${response.status}`);
      }

      const markets = await response.json();
      const now = Date.now();

      // Filter: BTC/Bitcoin question + resolves within next 30 minutes
      const btcShortTerm = markets.filter(m => {
        const q = (m.question || '').toLowerCase();
        if (!q.includes('btc') && !q.includes('bitcoin')) return false;

        // endDateIso / end_date_iso / endDate — try all variants
        const raw = m.endDateIso || m.end_date_iso || m.endDate;
        if (!raw) return false;

        // Handle both ISO string and Unix timestamp (seconds or ms)
        let endMs;
        if (typeof raw === 'number') {
          endMs = raw > 1e12 ? raw : raw * 1000; // seconds vs ms
        } else {
          endMs = new Date(raw).getTime();
        }

        if (isNaN(endMs)) return false;

        const minutesUntilEnd = (endMs - now) / 60000;
        return minutesUntilEnd > 0 && minutesUntilEnd <= 30;
      });

      if (btcShortTerm.length > 0) {
        this.marketsCache = btcShortTerm;
        this.lastMarketFetch = Date.now();
        console.log(`[PolymarketFeed] Found ${btcShortTerm.length} BTC markets resolving within 30min`);
        btcShortTerm.forEach(m => {
          const raw = m.endDateIso || m.end_date_iso || m.endDate;
          const mins = ((new Date(raw).getTime() - now) / 60000).toFixed(1);
          console.log(`  → "${m.question?.slice(0, 60)}" — resolves in ${mins}min`);
        });
      } else {
        // No 5-min window open right now — clear cache so we retry next tick
        this.marketsCache = [];
        this.lastMarketFetch = Date.now();
        console.log('[PolymarketFeed] No BTC markets resolving within 30min — waiting for next window');
      }

      return this.marketsCache;
    } catch (err) {
      console.error('[PolymarketFeed] fetchActiveBTCMarkets failed:', err.message);
      return this.marketsCache;
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
      const ClobClient = await getClobClient();
      const client = new ClobClient(
        'https://clob.polymarket.com',
        137,
        privateKey,
        undefined,
        walletAddress
      );
      // Fetch USDC balance on Polygon
      const result = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      const usdc = parseFloat(result?.balance ?? result?.usdc_balance ?? result ?? '0');
      return { usdc, wallet: walletAddress };
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
