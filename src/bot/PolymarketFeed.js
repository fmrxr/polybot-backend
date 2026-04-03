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
   * Fetch active 5-min BTC markets via Gamma API (per docs).
   * Strategy:
   *   1. GET /tags  → discover crypto tag ID
   *   2. GET /events?active=true&closed=false&tag_id=X&order=end_date&ascending=true
   *   3. Paginate with offset, find markets ending within 2 hours
   *   4. Fallback: same without tag filter
   */
  async fetchActiveBTCMarkets() {
    const now = Date.now();
    if (this.marketsCache.length > 0 && this.lastMarketFetch &&
        (now - this.lastMarketFetch) < this.marketCacheTTL) {
      return this.marketsCache;
    }

    const nowSec = Math.floor(now / 1000);

    // Discover crypto tag ID once and cache it
    if (this._cryptoTagId === undefined) {
      this._cryptoTagId = await this._discoverTagId();
    }

    const markets = await this._fetchByEvents(nowSec);

    if (markets.length > 0) {
      this.marketsCache = markets;
      this.lastMarketFetch = now;
      this.marketCacheTTL = 30000;
      console.log(`[PolymarketFeed] Found ${markets.length} active BTC market(s):`);
      markets.forEach(m => console.log(`  → "${m.question?.slice(0, 70)}"`));
      return markets;
    }

    this.marketCacheTTL = 10000;
    this.lastMarketFetch = now;
    this.marketsCache = [];
    console.log('[PolymarketFeed] No active BTC markets found');
    return [];
  }

  /**
   * Discover the crypto tag ID via GET /tags (per docs).
   * Cached on this instance — only fetched once per bot lifecycle.
   */
  async _discoverTagId() {
    try {
      const res = await fetch('https://gamma-api.polymarket.com/tags', { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const tags = await res.json();
      if (!Array.isArray(tags)) return null;

      // Log all tags once so we can see what's available
      console.log(`[PolymarketFeed] /tags: ${tags.map(t => `${t.slug||t.label}(${t.id})`).join(', ')}`);

      // Find crypto tag — prefer exact match, then partial
      const crypto = tags.find(t => (t.slug || t.label || '').toLowerCase() === 'crypto')
        || tags.find(t => (t.slug || t.label || '').toLowerCase().includes('crypto'));
      if (crypto) {
        console.log(`[PolymarketFeed] Using tag: "${crypto.slug||crypto.label}" id=${crypto.id}`);
        return crypto.id;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Fetch active events from Gamma API per docs.
   * Uses: GET /events?active=true&closed=false&tag_id=X&order=end_date&ascending=true
   * Paginates with offset. Finds markets ending within 2h.
   * Logs ALL short-window markets (no keyword filter) to reveal true names.
   */
  async _fetchByEvents(nowSec) {
    const now = nowSec * 1000;
    const found = [];

    // Per docs: tag_id filtered first, then all active events
    const paramSets = [];
    if (this._cryptoTagId) {
      paramSets.push({
        active: 'true', closed: 'false',
        tag_id: String(this._cryptoTagId),
        order: 'end_date', ascending: 'true', limit: '100',
      });
    }
    paramSets.push({ active: 'true', closed: 'false', order: 'end_date', ascending: 'true', limit: '100' });

    for (const baseParams of paramSets) {
      // Paginate up to 500 events using offset per docs
      for (let offset = 0; offset < 500; offset += 100) {
        const params = offset > 0 ? { ...baseParams, offset: String(offset) } : baseParams;
        const url = 'https://gamma-api.polymarket.com/events?' + new URLSearchParams(params);

        let res;
        try { res = await fetch(url, { signal: AbortSignal.timeout(8000) }); } catch (e) { break; }
        if (!res.ok) {
          console.warn(`[PolymarketFeed] GET /events HTTP ${res.status} params=${JSON.stringify(params)}`);
          break;
        }
        const events = await res.json();
        if (!Array.isArray(events) || events.length === 0) break;

        const shortWindow = [];
        for (const ev of events) {
          for (const m of (ev.markets || [])) {
            const rawEnd = m.end_date_iso || m.endDateIso || m.endDate || m.end_time;
            const endMs = rawEnd ? new Date(rawEnd).getTime() : 0;
            if (!endMs || endMs <= now) continue;
            const minsLeft = (endMs - now) / 60000;
            if (minsLeft > 120) continue;
            shortWindow.push({ m, ev, minsLeft });
          }
        }

        // Log ALL short-window markets (no filter) — reveals the real market name
        if (shortWindow.length > 0 && (now - (this._lastShortLog||0)) > 60000) {
          this._lastShortLog = now;
          console.log(`[PolymarketFeed] Markets ending <2h (offset=${offset}):`);
          shortWindow.slice(0, 10).forEach(({ m, ev, minsLeft }) => {
            const tag = ev.tags?.[0]?.slug || '?';
            console.log(`  "${(m.question||ev.title||'').slice(0,60)}" | ${minsLeft.toFixed(1)}min | tag:${tag}`);
          });
        }

        // Filter BTC — question OR parent event title must contain btc/bitcoin
        for (const { m, ev } of shortWindow) {
          const combined = (m.question + ' ' + ev.title + ' ' + (ev.slug||'')).toLowerCase();
          if (combined.includes('btc') || combined.includes('bitcoin')) {
            const norm = this._normaliseMarket(m, nowSec, true, true);
            if (norm && !found.find(x => x.id === norm.id)) found.push(norm);
          }
        }

        if (found.length > 0) return found;
        if (events.length < 100) break; // last page
      }
      if (found.length > 0) break;
    }
    return found;
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
