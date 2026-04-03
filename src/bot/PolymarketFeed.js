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
      // Short cache — 5-min windows open frequently, new ones start mid-cycle
      const CACHE_TTL = 10000; // 10s — fast enough to catch new windows early
      if (this.marketsCache.length > 0 && this.lastMarketFetch &&
          (Date.now() - this.lastMarketFetch) < CACHE_TTL) {
        return this.marketsCache;
      }

      if (!this.clobClient) throw new Error('CLOB client not initialized');

      const now = Date.now();
      const nowSec = Math.floor(now / 1000);

      // Fetch active markets from CLOB — returns all currently tradeable markets
      const response = await this.clobClient.getMarkets();
      const allMarkets = Array.isArray(response) ? response
        : (response?.data || response?.markets || []);

      // Filter: active + BTC/Bitcoin question + resolves within 30 minutes
      // Duration ~300s identifies 5-min markets; window must still be open
      const btc5m = allMarkets.filter(m => {
        if (!m.active) return false;
        const q = (m.question || '').toLowerCase();
        if (!q.includes('btc') && !q.includes('bitcoin')) return false;

        const endSec = m.end_date_iso
          ? Math.floor(new Date(m.end_date_iso).getTime() / 1000)
          : (m.resolution_time || m.end_time || 0);

        const startSec = m.start_date_iso
          ? Math.floor(new Date(m.start_date_iso).getTime() / 1000)
          : (m.start_time || 0);

        if (!endSec) return false;

        const minsUntilEnd = (endSec - nowSec) / 60;
        if (minsUntilEnd <= 0 || minsUntilEnd > 30) return false;

        // Prefer 5-min markets but accept any short-term BTC market
        const durationSec = endSec - startSec;
        return durationSec > 0 && durationSec <= 600; // ≤10 minute window
      });

      // Normalise to expected shape: { id, question, tokens:[{token_id},...], clobTokenIds }
      const normalised = btc5m.map(m => {
        const tokens = m.tokens || [];
        const clobIds = m.clobTokenIds || m.clob_token_ids || tokens.map(t => t.token_id);
        return { ...m, tokens, clobTokenIds: clobIds };
      });

      this.marketsCache = normalised;
      this.lastMarketFetch = now;

      if (normalised.length > 0) {
        console.log(`[PolymarketFeed] Found ${normalised.length} active 5-min BTC market(s)`);
        normalised.forEach(m => {
          console.log(`  → "${m.question?.slice(0, 70)}"`);
        });
      } else {
        console.log('[PolymarketFeed] No 5-min BTC markets open right now — waiting for next window');
      }

      return this.marketsCache;
    } catch (err) {
      console.error('[PolymarketFeed] fetchActiveBTCMarkets failed:', err.message);
      // Fallback to Gamma API if CLOB client fails
      return this._fetchBTCMarketsGammaFallback();
    }
  }

  async _fetchBTCMarketsGammaFallback() {
    try {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      const response = await fetch('https://gamma-api.polymarket.com/markets?' + new URLSearchParams({
        closed: 'false', active: 'true', limit: '200'
      }));
      if (!response.ok) return this.marketsCache;
      const markets = await response.json();

      const btc5m = markets.filter(m => {
        const q = (m.question || '').toLowerCase();
        if (!q.includes('btc') && !q.includes('bitcoin') && !q.includes('up or down')) return false;
        const raw = m.endDate || m.endDateIso;
        if (!raw) return false;
        const endMs = typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : new Date(raw).getTime();
        if (isNaN(endMs)) return false;
        const mins = (endMs - now) / 60000;
        return mins > 0 && mins <= 30;
      });

      // Normalise clobTokenIds (may be JSON string or array)
      btc5m.forEach(m => {
        if (typeof m.clobTokenIds === 'string') {
          try { m.clobTokenIds = JSON.parse(m.clobTokenIds); } catch(e) { m.clobTokenIds = []; }
        }
      });

      if (btc5m.length > 0) {
        this.marketsCache = btc5m;
        this.lastMarketFetch = now;
        console.log(`[PolymarketFeed] Gamma fallback: ${btc5m.length} BTC market(s) within 30min`);
      }
      return this.marketsCache;
    } catch (err) {
      console.error('[PolymarketFeed] Gamma fallback failed:', err.message);
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
