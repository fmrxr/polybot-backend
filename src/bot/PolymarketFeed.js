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
   * 5-min windows: MIN_5MIN_DURATION (290s) to MAX_5MIN_DURATION (615s) remaining.
   */
  async _getActiveBTCMarkets() {
    if (!this.clobClient) return [];
    const nowUTC = Date.now();
    const MIN_5MIN_DURATION = 290;
    const MAX_5MIN_DURATION = 615;
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

      const rawMarkets = Array.isArray(response) ? response : (response?.data || []);

      // Page 1: log first market's raw keys (throttled to once per 5 min)
      if (page === 0 && rawMarkets.length > 0 && (nowUTC - (this._lastClobFieldLog||0)) > 300000) {
        this._lastClobFieldLog = nowUTC;
        const sample = rawMarkets[0];
        console.log(`[PolymarketFeed] CLOB market fields: ${Object.keys(sample).join(', ')}`);
        console.log(`[PolymarketFeed] CLOB sample end fields: end_time=${sample.end_time} end_date_iso=${sample.end_date_iso} game_end_time=${sample.game_end_time}`);
      }

      const withDuration = rawMarkets.map(m => {
        // Append 'Z' to force UTC interpretation (strings without TZ suffix are parsed as local time in some engines)
        let endUTC = m.end_date_iso ? new Date(m.end_date_iso + 'Z').getTime() : 0;
        // Fallback: game_start_time + 300s
        if ((!endUTC || endUTC < nowUTC) && m.game_start_time) {
          const startMs = new Date(m.game_start_time + 'Z').getTime();
          if (!isNaN(startMs)) endUTC = startMs + 300000;
        }
        const durationSec = endUTC > nowUTC ? (endUTC - nowUTC) / 1000 : 0;
        return { ...m, durationSec, endUTC };
      });

      const shortWindow = withDuration.filter(
        m => m.durationSec >= MIN_5MIN_DURATION && m.durationSec <= MAX_5MIN_DURATION
      );

      // Diagnostic: when nothing in the window, log closest markets (throttled)
      if (shortWindow.length === 0 && page === 0 && (nowUTC - (this._lastClobDiagLog||0)) > 120000) {
        this._lastClobDiagLog = nowUTC;
        const active = withDuration.filter(m => m.durationSec > 0).sort((a,b) => a.durationSec - b.durationSec);
        console.log(`[PolymarketFeed] CLOB page 1 — no markets in ${MIN_5MIN_DURATION}–${MAX_5MIN_DURATION}s window. Closest ${active.length > 0 ? active.length : 0} active:`);
        active.slice(0, 5).forEach(m =>
          console.log(`  "${(m.question||'').trim().slice(0,55)}" | ${m.durationSec.toFixed(0)}s remaining`)
        );
      }

      if (shortWindow.length > 0) {
        console.log(`[PolymarketFeed] CLOB page ${page + 1} short-window markets (${shortWindow.length}):`);
        shortWindow.forEach(m =>
          console.log(`  "${(m.question||'').trim().slice(0, 60)}" | ${m.durationSec.toFixed(0)}s`)
        );
        // Trim + lowercase for reliable BTC matching
        const btc = shortWindow.filter(m => /btc|bitcoin/i.test((m.question || '').trim()));
        if (btc.length > 0) {
          console.log(`[PolymarketFeed] CLOB: found ${btc.length} BTC 5-min market(s)`);
          const nowSec = Math.floor(nowUTC / 1000);
          return btc.map(m => this._normaliseMarket(m, nowSec, false, true)).filter(Boolean);
        }
      }

      const nextCursor = response?.next_cursor;
      if (!nextCursor || nextCursor === 'LTE=' || rawMarkets.length === 0) break;
      cursor = nextCursor;
    }
    return [];
  }

  /**
   * Gamma market discovery — no order= params (causes 422).
   * S0: slug lookup — btc-updown-5m-<epochSec> for current + adjacent windows
   * S1: end_date_min/max — directly query markets ending in next 10 min
   * S2: accepting_orders=true — markets currently open for trading
   * S3: paginated plain active scan — log everything ending <1h
   */
  async _fetchGammaShortWindow() {
    const nowUTC = Date.now();
    const nowSec = Math.floor(nowUTC / 1000);

    const _endMs = (m) => {
      const raw = m.end_date_iso || m.endDateIso || m.endDate;
      if (!raw) return 0;
      const s = typeof raw === 'string' ? raw : String(raw);
      return new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z').getTime();
    };

    const _normalise = (m) => this._normaliseMarket(m, nowSec, false, true);

    // ── Strategy 0: slug-based lookup (btc-updown-5m-<epochSec>) ──────────────
    // 5-min windows align to 300s boundaries. Try current, previous, and next.
    const windowBase = Math.floor(nowSec / 300) * 300;
    for (const t of [windowBase, windowBase + 300, windowBase - 300]) {
      const slug = `btc-updown-5m-${t}`;
      try {
        const res = await fetch(`https://gamma-api.polymarket.com/markets/slug/${slug}`,
          { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const m = await res.json();
          const endMs = _endMs(m);
          console.log(`[PolymarketFeed] Slug ${slug} → "${(m.question||'').trim().slice(0,55)}" | ends in ${endMs ? ((endMs-nowUTC)/1000).toFixed(0)+'s' : '?'}`);
          if (endMs > nowUTC) {
            const norm = _normalise(m);
            if (norm) { console.log('[PolymarketFeed] S0 slug match — found BTC 5-min market'); return [norm]; }
          }
        } else if (res.status !== 404) {
          console.warn(`[PolymarketFeed] Slug ${slug} HTTP ${res.status}`);
        }
      } catch (e) {
        console.warn(`[PolymarketFeed] Slug ${slug} failed: ${e.message}`);
      }
    }

    // ── Strategy 1: end_date_min/max ──────────────────────────────────────────
    const endMin = new Date(nowUTC).toISOString();
    const endMax = new Date(nowUTC + 10 * 60 * 1000).toISOString();
    try {
      const url = `https://gamma-api.polymarket.com/markets?end_date_min=${endMin}&end_date_max=${endMax}&active=true&closed=false&limit=100`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const markets = await res.json();
        if (Array.isArray(markets) && markets.length > 0) {
          console.log(`[PolymarketFeed] S1 end_date window → ${markets.length} market(s):`);
          markets.forEach(m => console.log(`  "${(m.question||'').trim().slice(0,60)}" | slug=${m.slug||'?'}`));
          const btc = markets.filter(m => /btc|bitcoin/i.test((m.question || m.slug || '').trim()));
          if (btc.length > 0) {
            console.log(`[PolymarketFeed] S1 found ${btc.length} BTC market(s) — raw fields: ${Object.keys(btc[0]).join(', ')}`);
            console.log(`[PolymarketFeed] S1 btc[0] dates: end_date_iso=${btc[0].end_date_iso} endDateIso=${btc[0].endDateIso} endDate=${btc[0].endDate}`);
            // Try _normaliseMarket first
            const normalised = btc.map(_normalise).filter(Boolean);
            if (normalised.length > 0) return normalised;
            // normalise returned empty — build directly from Gamma data (already validated by end_date_min/max)
            console.warn('[PolymarketFeed] S1: _normalise returned null for all — building directly');
            const direct = btc.map(m => {
              const endMs = _endMs(m);
              if (!endMs || endMs <= nowUTC) { console.warn(`[PolymarketFeed] S1 direct: endMs=${endMs} nowUTC=${nowUTC} — skipping`); return null; }
              const tokens = m.tokens || [];
              let clobIds = m.clobTokenIds || m.clob_token_ids;
              if (typeof clobIds === 'string') { try { clobIds = JSON.parse(clobIds); } catch(e) { clobIds = []; } }
              if (!clobIds || !clobIds.length) clobIds = tokens.map(t => t.token_id || t.tokenId).filter(Boolean);
              return {
                ...m,
                id: m.id || m.conditionId || m.condition_id,
                question: m.question || m.title || '',
                tokens,
                clobTokenIds: clobIds || [],
                end_date_iso: new Date(endMs).toISOString(),
                start_date_iso: new Date(endMs - 300000).toISOString(),
              };
            }).filter(Boolean);
            if (direct.length > 0) { console.log(`[PolymarketFeed] S1 direct builder: ${direct.length} market(s)`); return direct; }
          }
        }
      } else {
        console.warn(`[PolymarketFeed] S1 end_date HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn('[PolymarketFeed] S1 failed:', e.message);
    }

    // ── Strategy 2: accepting_orders=true ────────────────────────────────────
    try {
      const url = 'https://gamma-api.polymarket.com/markets?accepting_orders=true&active=true&closed=false&limit=200';
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const markets = await res.json();
        if (Array.isArray(markets) && markets.length > 0) {
          const btc = markets.filter(m => /btc|bitcoin/i.test((m.question || m.slug || '').trim()));
          if (btc.length > 0) {
            console.log(`[PolymarketFeed] S2 accepting_orders found ${btc.length} BTC market(s)`);
            const normalised = btc.map(_normalise).filter(Boolean);
            if (normalised.length > 0) return normalised;
            // Fall through — normalise failed, S3 will try
            console.warn('[PolymarketFeed] S2: _normalise returned null for all');
          }
          // Log slugs of anything short-lived so we can see the slug pattern
          const anyShort = markets.filter(m => { const ms = _endMs(m); return ms > nowUTC && (ms-nowUTC) < 3600000; });
          if (anyShort.length > 0) {
            console.log(`[PolymarketFeed] S2 <1h non-BTC (${anyShort.length}) — slugs for pattern:`);
            anyShort.slice(0,5).forEach(m => console.log(`  slug=${m.slug||'?'} | "${(m.question||'').trim().slice(0,50)}"`));
          }
        }
      } else {
        console.warn(`[PolymarketFeed] S2 accepting_orders HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn('[PolymarketFeed] S2 failed:', e.message);
    }

    // ── Strategy 3: paginate all active, look for BTC slug / <1h end ─────────
    for (let offset = 0; offset <= 1000; offset += 200) {
      try {
        const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&offset=${offset}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) break;
        const markets = await res.json();
        if (!Array.isArray(markets) || markets.length === 0) break;

        // Slug pattern match
        const bySlug = markets.filter(m => /btc.*(5m|5min|updown)/i.test(m.slug || ''));
        if (bySlug.length > 0) {
          console.log(`[PolymarketFeed] S3 slug pattern found (${bySlug.length}):`);
          bySlug.forEach(m => console.log(`  slug=${m.slug} | "${(m.question||'').trim().slice(0,50)}"`));
          return bySlug.map(_normalise).filter(Boolean);
        }

        const shortAll = markets.filter(m => {
          const ms = _endMs(m); return ms > nowUTC && (ms-nowUTC) < 3600000;
        });
        if (shortAll.length > 0) {
          console.log(`[PolymarketFeed] S3 offset=${offset} — ${shortAll.length} markets ending <1h:`);
          shortAll.forEach(m =>
            console.log(`  slug=${m.slug||'?'} | "${(m.question||'').trim().slice(0,50)}" | ${((_endMs(m)-nowUTC)/1000).toFixed(0)}s`)
          );
          const btc = shortAll.filter(m => /btc|bitcoin/i.test((m.question || m.slug || '').trim()));
          if (btc.length > 0) {
            console.log(`[PolymarketFeed] S3 found ${btc.length} BTC market(s)`);
            return btc.map(_normalise).filter(Boolean);
          }
        }
      } catch (e) {
        console.warn(`[PolymarketFeed] S3 offset=${offset} failed:`, e.message);
        break;
      }
    }
    return [];
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
    // Append 'Z' to string timestamps that lack a TZ suffix to force UTC interpretation
    const endMs = typeof rawEnd === 'number'
      ? (rawEnd > 1e12 ? rawEnd : rawEnd * 1000)
      : (() => { const s = String(rawEnd); return new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z').getTime(); })();
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
        : (() => { const s = String(rawStart); return new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z').getTime(); })()) / 1000)
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
