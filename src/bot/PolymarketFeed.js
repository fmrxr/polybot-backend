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
    this.marketCacheTTL = 10000; // 10s
    // Track last known order book per token for high-frequency reads
    this.orderBookCache = {}; // tokenId -> { book, ts }
    this.orderBookCacheTTL = 500; // 500ms — sub-second freshness
  }

  async initialize() {
    try {
      const ClobClient = await getClobClient();
      if (this.privateKey && this.walletAddress) {
        this.clobClient = new ClobClient(
          'https://clob.polymarket.com',
          137,
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

  /**
   * Fetch active 5-min BTC markets.
   *
   * Strategy order (per Polymarket docs — events endpoint is most efficient):
   *   1. Gamma Events API: end_date ascending → filter BTC + short duration
   *   2. Gamma Markets API: same filter, direct market list
   *   3. CLOB getMarkets() paginated: last resort, up to 5 pages
   *
   * Returns normalised array: { id, question, tokens, clobTokenIds, end_date_iso, ... }
   */
  async fetchActiveBTCMarkets() {
    const now = Date.now();
    if (this.marketsCache.length > 0 && this.lastMarketFetch &&
        (now - this.lastMarketFetch) < this.marketCacheTTL) {
      return this.marketsCache;
    }

    // Strategy 1: Gamma Events API (most efficient — events contain their markets)
    const fromEvents = await this._fetchViaEventsAPI();
    if (fromEvents.length > 0) {
      this.marketsCache = fromEvents;
      this.lastMarketFetch = now;
      console.log(`[PolymarketFeed] Events API: found ${fromEvents.length} 5-min BTC market(s)`);
      fromEvents.forEach(m => console.log(`  → "${m.question?.slice(0, 70)}"`));
      return this.marketsCache;
    }

    // Strategy 2: Gamma Markets API directly
    const fromMarkets = await this._fetchViaMarketsAPI();
    if (fromMarkets.length > 0) {
      this.marketsCache = fromMarkets;
      this.lastMarketFetch = now;
      console.log(`[PolymarketFeed] Markets API: found ${fromMarkets.length} 5-min BTC market(s)`);
      return this.marketsCache;
    }

    // Strategy 3: CLOB paginated (last resort — slower, scans up to 500 markets)
    const fromCLOB = await this._fetchViaCLOB();
    if (fromCLOB.length > 0) {
      this.marketsCache = fromCLOB;
      this.lastMarketFetch = now;
      console.log(`[PolymarketFeed] CLOB paginated: found ${fromCLOB.length} 5-min BTC market(s)`);
      return this.marketsCache;
    }

    console.log('[PolymarketFeed] No 5-min BTC markets open right now — waiting for next window');
    // Update cache timestamp so we don't hammer the API every 10s when no market is open
    this.lastMarketFetch = now;
    this.marketsCache = [];
    return [];
  }

  /** Strategy 1: Gamma Events endpoint — returns events with embedded markets */
  async _fetchViaEventsAPI() {
    try {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);

      // Fetch events sorted by soonest end_date first — 5-min BTC events will be at top
      const url = 'https://gamma-api.polymarket.com/events?' + new URLSearchParams({
        active: 'true',
        closed: 'false',
        order: 'end_date',
        ascending: 'true',
        limit: '100',
      });

      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const events = await res.json();
      if (!Array.isArray(events)) return [];

      const found = [];

      for (const event of events) {
        // Each event has { slug, title, markets: [...] }
        const title = (event.title || event.question || '').toLowerCase();
        const isBTC = title.includes('btc') || title.includes('bitcoin');
        if (!isBTC) continue;

        const markets = event.markets || [];
        for (const m of markets) {
          const normalised = this._normaliseMarket(m, nowSec);
          if (normalised) found.push(normalised);
        }
      }

      return found;
    } catch (err) {
      console.warn('[PolymarketFeed] Events API failed:', err.message);
      return [];
    }
  }

  /** Strategy 2: Gamma Markets endpoint */
  async _fetchViaMarketsAPI() {
    try {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);

      // Two passes: end_date ascending (soonest first), then broader search
      for (const params of [
        { active: 'true', closed: 'false', order: 'end_date', ascending: 'true', limit: '200' },
        { active: 'true', closed: 'false', limit: '500' },
      ]) {
        const url = 'https://gamma-api.polymarket.com/markets?' + new URLSearchParams(params);
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) continue;
        const markets = await res.json();
        if (!Array.isArray(markets)) continue;

        const found = markets
          .map(m => this._normaliseMarket(m, nowSec))
          .filter(Boolean);

        if (found.length > 0) return found;
      }
      return [];
    } catch (err) {
      console.warn('[PolymarketFeed] Markets API failed:', err.message);
      return [];
    }
  }

  /** Strategy 3: CLOB getMarkets() with pagination (up to 5 pages × ~100 markets) */
  async _fetchViaCLOB() {
    if (!this.clobClient) return [];
    try {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      let allMarkets = [];
      let cursor;
      const MAX_PAGES = 5;

      for (let page = 0; page < MAX_PAGES; page++) {
        const response = cursor
          ? await this.clobClient.getMarkets(cursor)
          : await this.clobClient.getMarkets();

        const pageMarkets = Array.isArray(response) ? response
          : (response?.data || response?.markets || []);

        allMarkets = allMarkets.concat(pageMarkets);

        // Early exit if we already have enough BTC candidates
        const btcCount = allMarkets.filter(m => {
          const q = (m.question || '').toLowerCase();
          return q.includes('btc') || q.includes('bitcoin');
        }).length;
        if (btcCount >= 5) break;

        const nextCursor = response?.next_cursor;
        if (!nextCursor || nextCursor === 'LTE=' || pageMarkets.length === 0) break;
        cursor = nextCursor;
      }

      return allMarkets
        .map(m => this._normaliseMarket(m, nowSec))
        .filter(Boolean);
    } catch (err) {
      console.warn('[PolymarketFeed] CLOB paginated fetch failed:', err.message);
      return [];
    }
  }

  /**
   * Normalise a raw market object from any API into a consistent shape.
   * Returns null if the market doesn't match our 5-min BTC criteria.
   */
  _normaliseMarket(m, nowSec) {
    const q = (m.question || m.title || '').toLowerCase();
    const isBTC = q.includes('btc') || q.includes('bitcoin');
    if (!isBTC) return null;

    // Accept active, accepting_orders, or just not-closed markets
    if (m.archived) return null;

    // Parse end date — Gamma uses camelCase (endDate/endDateIso), CLOB uses snake_case
    const rawEnd = m.end_date_iso || m.endDateIso || m.endDate || m.resolution_time || m.end_time;
    if (!rawEnd) return null;
    const endMs = typeof rawEnd === 'number'
      ? (rawEnd > 1e12 ? rawEnd : rawEnd * 1000)
      : new Date(rawEnd).getTime();
    if (isNaN(endMs)) return null;
    const endSec = Math.floor(endMs / 1000);

    // Must still be open
    if (endSec <= nowSec) return null;
    // Within 30-minute window
    if ((endSec - nowSec) > 1800) return null;

    // Parse start date
    const rawStart = m.start_date_iso || m.startDateIso || m.startDate || m.start_time;
    let startSec = rawStart
      ? Math.floor((typeof rawStart === 'number'
        ? (rawStart > 1e12 ? rawStart : rawStart * 1000)
        : new Date(rawStart).getTime()) / 1000)
      : endSec - 300;
    if (!startSec || isNaN(startSec)) startSec = endSec - 300;

    const durationSec = endSec - startSec;
    // Must be a short window (≤ 10 min)
    if (durationSec <= 0 || durationSec > 600) return null;

    // Normalise token IDs
    const tokens = m.tokens || [];
    let clobIds = m.clobTokenIds || m.clob_token_ids || tokens.map(t => t.token_id);
    if (typeof clobIds === 'string') {
      try { clobIds = JSON.parse(clobIds); } catch (e) { clobIds = []; }
    }

    return {
      ...m,
      id: m.id || m.condition_id,
      question: m.question || m.title || '',
      tokens,
      clobTokenIds: clobIds,
      end_date_iso: new Date(endMs).toISOString(),
      start_date_iso: new Date(startSec * 1000).toISOString(),
    };
  }

  /**
   * Fetch REAL order book data from Polymarket CLOB with short-TTL cache.
   * Returns: { bestBid, bestAsk, bidDepth, askDepth, largestBid, largestAsk, totalDepth, spread, midPrice }
   * All prices are 0-1 (token probability scale)
   */
  async getOrderBook(tokenId) {
    if (!this.clobClient) {
      console.error('[PolymarketFeed] CLOB client not initialized');
      return null;
    }

    // Sub-second cache for high-frequency reads
    const cached = this.orderBookCache[tokenId];
    if (cached && (Date.now() - cached.ts) < this.orderBookCacheTTL) {
      return cached.book;
    }

    try {
      const book = await this.clobClient.getOrderBook(tokenId);
      const bids = book.bids || [];
      const asks = book.asks || [];

      if (bids.length === 0 && asks.length === 0) {
        console.warn(`[PolymarketFeed] Empty order book for token ${tokenId}`);
        return null;
      }

      const bidDepth  = bids.reduce((s, b) => s + parseFloat(b.size), 0);
      const askDepth  = asks.reduce((s, a) => s + parseFloat(a.size), 0);
      const bestBid   = bids.length > 0 ? parseFloat(bids[0].price) : null;
      const bestAsk   = asks.length > 0 ? parseFloat(asks[0].price) : null;
      const largestBid = bids.length > 0 ? Math.max(...bids.map(b => parseFloat(b.size))) : 0;
      const largestAsk = asks.length > 0 ? Math.max(...asks.map(a => parseFloat(a.size))) : 0;

      const result = {
        bestBid,
        bestAsk,
        bidDepth,
        askDepth,
        largestBid,
        largestAsk,
        totalDepth: bidDepth + askDepth,
        bidCount: bids.length,
        askCount: asks.length,
        spread: bestAsk && bestBid ? bestAsk - bestBid : null,
        midPrice: bestAsk && bestBid ? (bestAsk + bestBid) / 2 : null,
      };

      this.orderBookCache[tokenId] = { book: result, ts: Date.now() };
      return result;
    } catch (err) {
      console.error(`[PolymarketFeed] getOrderBook failed for ${tokenId}:`, err.message);
      return null;
    }
  }

  /** Get live token price (mid-price from order book) */
  async getLiveTokenPrice(tokenId) {
    try {
      const book = await this.getOrderBook(tokenId);
      return book?.midPrice ?? null;
    } catch (err) {
      console.error(`[PolymarketFeed] getLiveTokenPrice failed for ${tokenId}:`, err.message);
      return null;
    }
  }

  /** Fetch USDC balance for a wallet */
  static async fetchBalance(privateKey, walletAddress) {
    try {
      const ClobClient = await getClobClient();
      const client = new ClobClient('https://clob.polymarket.com', 137, privateKey, undefined, walletAddress);
      const result = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      const usdc = parseFloat(result?.balance ?? result?.usdc_balance ?? result ?? '0');
      return { usdc, wallet: walletAddress };
    } catch (err) {
      console.error('[PolymarketFeed] fetchBalance failed:', err.message);
      return { usdc: 0, wallet: walletAddress };
    }
  }

  /** Place a market/limit order on Polymarket CLOB */
  async placeOrder(tokenId, side, size, price) {
    if (!this.clobClient) throw new Error('CLOB client not initialized for trading');
    try {
      const order = await this.clobClient.createAndPlaceOrder({ tokenId, side, size, price });
      console.log(`[PolymarketFeed] Order placed: ${side} ${size} @ ${price} for token ${tokenId}`);
      return order;
    } catch (err) {
      console.error(`[PolymarketFeed] placeOrder failed:`, err.message);
      throw err;
    }
  }
}

module.exports = PolymarketFeed;
