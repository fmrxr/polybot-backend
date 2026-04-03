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

  async fetchActiveBTCMarkets() {
    const nowUTC = Date.now();
    if (this.marketsCache.length > 0 && this.lastMarketFetch &&
        (nowUTC - this.lastMarketFetch) < this.marketCacheTTL) {
      return this.marketsCache;
    }

    // Primary: CLOB getMarkets — filter by time remaining (290–610s = 5-min window)
    const fromCLOB = await this._getActiveBTCMarkets();
    if (fromCLOB.length > 0) {
      this.marketsCache = fromCLOB;
      this.lastMarketFetch = nowUTC;
      this.marketCacheTTL = 30000;
      return fromCLOB;
    }

    // Fallback: Gamma /markets sorted by end_date ascending (no 422 on /markets endpoint)
    const fromGamma = await this._fetchGammaShortWindow();
    if (fromGamma.length > 0) {
      this.marketsCache = fromGamma;
      this.lastMarketFetch = nowUTC;
      this.marketCacheTTL = 30000;
      return fromGamma;
    }

    this.marketCacheTTL = 10000;
    this.lastMarketFetch = nowUTC;
    this.marketsCache = [];
    console.log('[PolymarketFeed] No active BTC markets found');
    return [];
  }

  /**
   * CLOB getMarkets — paginate and filter by time remaining.
   * Filter: markets closing in the next 0–610 seconds (current + next 5-min window).
   * Case-insensitive BTC keyword. Diagnostic logs everything short-window found.
   */
  async _getActiveBTCMarkets() {
    if (!this.clobClient) return [];
    const nowUTC = Date.now();
    const minDuration = 0;   // include markets already in-progress
    const maxDuration = 610; // up to ~10 min remaining
    let cursor;

    for (let page = 0; page < 50; page++) {
      let response;
      try {
        response = cursor
          ? await this.clobClient.getMarkets(cursor)
          : await this.clobClient.getMarkets();
      } catch (e) {
        console.warn(`[PolymarketFeed] CLOB page ${page + 1} error: ${e.message}`);
        break;
      }

      // Handle both raw array and {data, next_cursor} formats
      const rawMarkets = Array.isArray(response) ? response : (response?.data || []);

      // Compute time remaining for each market
      const withDuration = rawMarkets.map(m => {
        const endUTC = m.end_time ? new Date(m.end_time).getTime()
          : (m.end_date_iso || m.endDateIso) ? new Date(m.end_date_iso || m.endDateIso).getTime() : 0;
        const durationSec = Math.max(0, (endUTC - nowUTC) / 1000);
        return { ...m, durationSec, endUTC };
      });

      // Short-window markets on this page (any question)
      const shortWindow = withDuration.filter(
        m => m.durationSec > minDuration && m.durationSec <= maxDuration
      );

      if (shortWindow.length > 0) {
        console.log(`[PolymarketFeed] CLOB page ${page + 1} — short-window markets:`);
        shortWindow.forEach(m =>
          console.log(`  "${(m.question||'').slice(0, 60)}" | ${m.durationSec.toFixed(0)}s remaining`)
        );

        const btcMarkets = shortWindow.filter(m => /btc|bitcoin/i.test(m.question || ''));
        if (btcMarkets.length > 0) {
          console.log(`[PolymarketFeed] Found ${btcMarkets.length} BTC 5-min market(s) via CLOB`);
          const nowSec = Math.floor(nowUTC / 1000);
          return btcMarkets.map(m => this._normaliseMarket(m, nowSec, false, true)).filter(Boolean);
        }
      }

      const nextCursor = response?.next_cursor;
      if (!nextCursor || nextCursor === 'LTE=' || rawMarkets.length === 0) break;
      cursor = nextCursor;
    }
    return [];
  }

  /**
   * Gamma /markets endpoint with end_date sort — works (no 422 unlike /events).
   * Logs ALL markets ending within 10 min regardless of keyword.
   */
  async _fetchGammaShortWindow() {
    try {
      const nowUTC = Date.now();
      const nowSec = Math.floor(nowUTC / 1000);
      const res = await fetch(
        'https://gamma-api.polymarket.com/markets?active=true&closed=false&order=end_date&ascending=true&limit=100',
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) {
        console.warn(`[PolymarketFeed] Gamma /markets HTTP ${res.status}`);
        return [];
      }
      const markets = await res.json();
      if (!Array.isArray(markets)) return [];

      // Log ALL markets ending within 10 min (no keyword filter)
      const tenMin = markets.filter(m => {
        const rawEnd = m.end_date_iso || m.endDateIso || m.endDate;
        const endMs = rawEnd ? new Date(rawEnd).getTime() : 0;
        return endMs > nowUTC && (endMs - nowUTC) < 600000;
      });
      if (tenMin.length > 0 && (nowUTC - (this._lastGammaLog||0)) > 60000) {
        this._lastGammaLog = nowUTC;
        console.log(`[PolymarketFeed] Gamma markets ending <10min:`);
        tenMin.forEach(m => {
          const endMs = new Date(m.end_date_iso || m.endDateIso || m.endDate).getTime();
          console.log(`  "${(m.question||'').slice(0,60)}" | ${((endMs-nowUTC)/1000).toFixed(0)}s`);
        });
      }

      // BTC markets ending within 2h
      const btc = markets.filter(m => {
        const rawEnd = m.end_date_iso || m.endDateIso || m.endDate;
        const endMs = rawEnd ? new Date(rawEnd).getTime() : 0;
        if (!endMs || endMs <= nowUTC || (endMs - nowUTC) > 7200000) return false;
        return /btc|bitcoin/i.test(m.question || m.title || '');
      });
      return btc.map(m => this._normaliseMarket(m, nowSec, false, true)).filter(Boolean);
    } catch (e) {
      console.warn('[PolymarketFeed] Gamma short-window failed:', e.message);
      return [];
    }
  }

  /**
   * Normalise a raw market object from any API into a consistent shape.
   * Returns null if the market doesn't match our 5-min BTC criteria.
   * @param {boolean} isBTCParent - skip BTC keyword check when parent event is known-BTC
   * @param {boolean} skipDurationCheck - skip duration filter (for accepting_orders=true results)
   */
  _normaliseMarket(m, nowSec, isBTCParent = false, skipDurationCheck = false) {
    if (!isBTCParent) {
      const q = (m.question || m.title || '').toLowerCase();
      const isBTC = q.includes('btc') || q.includes('bitcoin');
      if (!isBTC) return null;
    }

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
    // Must end within 2 hours (wide enough for "next window" pre-loading)
    if ((endSec - nowSec) > 7200) return null;

    // Parse start date
    const rawStart = m.start_date_iso || m.startDateIso || m.startDate || m.start_time;
    let startSec = rawStart
      ? Math.floor((typeof rawStart === 'number'
        ? (rawStart > 1e12 ? rawStart : rawStart * 1000)
        : new Date(rawStart).getTime()) / 1000)
      : endSec - 300;
    if (!startSec || isNaN(startSec)) startSec = endSec - 300;

    const durationSec = endSec - startSec;
    // Must be a short window (≤ 10 min) — skip for CLOB accepting_orders results
    // (start_time may be market creation date, not window start)
    if (!skipDurationCheck && (durationSec <= 0 || durationSec > 600)) return null;

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
