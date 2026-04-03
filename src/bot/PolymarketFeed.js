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
   * 5-min BTC markets ONLY live in the Polymarket CLOB — Gamma does not list them.
   * Strategy:
   *   1. CLOB SDK paginated (primary) — up to 20 pages × 100 = 2000 markets scanned
   *      Cache TTL raised to 5min once found (windows are predictable)
   *   2. Gamma Markets API (fallback) — may find longer-term BTC markets
   *
   * Returns normalised array: { id, question, tokens, clobTokenIds, end_date_iso, ... }
   */
  async fetchActiveBTCMarkets() {
    const now = Date.now();
    if (this.marketsCache.length > 0 && this.lastMarketFetch &&
        (now - this.lastMarketFetch) < this.marketCacheTTL) {
      return this.marketsCache;
    }

    // 1. Gamma Events API (5-min BTC events show up here, question may just say "Up/Down")
    const fromEvents = await this._fetchViaEventsAPI();
    if (fromEvents.length > 0) {
      this.marketsCache = fromEvents;
      this.lastMarketFetch = now;
      this.marketCacheTTL = 30000;
      console.log(`[PolymarketFeed] Events: found ${fromEvents.length} BTC market(s)`);
      fromEvents.forEach(m => console.log(`  → "${m.question?.slice(0, 70)}"`));
      return this.marketsCache;
    }

    // 2. CLOB SDK — accepting_orders, sampling, crypto-tag
    const fromCLOB = await this._fetchViaCLOB();
    if (fromCLOB.length > 0) {
      this.marketsCache = fromCLOB;
      this.lastMarketFetch = now;
      this.marketCacheTTL = 30000;
      console.log(`[PolymarketFeed] CLOB: found ${fromCLOB.length} active BTC market(s)`);
      fromCLOB.forEach(m => console.log(`  → "${m.question?.slice(0, 70)}"`));
      return this.marketsCache;
    }

    // 3. Short-window scan — find ANY Gamma market ending in next 30 min (no keyword filter)
    const fromShort = await this._fetchShortWindowMarkets();
    if (fromShort.length > 0) {
      this.marketsCache = fromShort;
      this.lastMarketFetch = now;
      this.marketCacheTTL = 30000;
      console.log(`[PolymarketFeed] Short-window: found ${fromShort.length} BTC market(s)`);
      fromShort.forEach(m => console.log(`  → "${m.question?.slice(0, 70)}"`));
      return this.marketsCache;
    }

    // 4. Gamma Markets keyword fallback
    const fromMarkets = await this._fetchViaMarketsAPI();
    if (fromMarkets.length > 0) {
      this.marketsCache = fromMarkets;
      this.lastMarketFetch = now;
      this.marketCacheTTL = 30000;
      console.log(`[PolymarketFeed] Gamma Markets: found ${fromMarkets.length} BTC market(s)`);
      return this.marketsCache;
    }

    // Log diagnostic once per minute
    if (!this._lastDiagLog || (now - this._lastDiagLog) > 60000) {
      this._lastDiagLog = now;
      this._logDiagnostic().catch(() => {});
    }

    this.marketCacheTTL = 10000; // retry quickly when no market found
    console.log('[PolymarketFeed] No active BTC markets found — waiting for next window');
    this.lastMarketFetch = now;
    this.marketsCache = [];
    return [];
  }

  /**
   * Short-window scan: fetch ALL Gamma markets sorted by soonest end_date.
   * No BTC keyword filter — logs everything ending in 2h so we can identify
   * what the 5-min BTC market is actually named. Returns BTC-matching ones.
   */
  async _fetchShortWindowMarkets() {
    try {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      const res = await fetch(
        'https://gamma-api.polymarket.com/markets?active=true&closed=false&order=end_date&ascending=true&limit=50',
        { signal: AbortSignal.timeout(6000) }
      );
      if (!res.ok) return [];
      const markets = await res.json();
      if (!Array.isArray(markets)) return [];

      // Find markets ending within 2h
      const soon = markets.filter(m => {
        const rawEnd = m.end_date_iso || m.endDateIso || m.endDate;
        const endMs = rawEnd ? new Date(rawEnd).getTime() : 0;
        return endMs > now && (endMs - now) < 7200000;
      });

      // Log ALL short-window markets (no keyword filter) — reveals the market's real name
      if ((now - (this._lastShortLog||0)) > 120000) {
        this._lastShortLog = now;
        if (soon.length > 0) {
          console.log(`[PolymarketFeed] ALL markets ending <2h (${soon.length} total):`);
          soon.slice(0, 10).forEach(m => {
            const rawEnd = m.end_date_iso || m.endDateIso || m.endDate;
            const endMs = new Date(rawEnd).getTime();
            const minsLeft = ((endMs - now) / 60000).toFixed(1);
            const tags = (m.tags||[]).map(t=>t.slug||t.label||'').join(',');
            console.log(`  "${(m.question||'').slice(0,55)}" | ${minsLeft}min | tags:${tags||'none'}`);
          });
        } else {
          console.log('[PolymarketFeed] Short-window: 0 Gamma markets ending within 2h');
        }
      }

      // Return any that have BTC context (broad keyword check including tags/slug)
      return soon
        .filter(m => {
          const q = (m.question || m.title || m.slug || '').toLowerCase();
          const tags = (m.tags || []).map(t => (t.slug||t.label||'').toLowerCase()).join(' ');
          const combined = q + ' ' + tags;
          return combined.includes('btc') || combined.includes('bitcoin') || combined.includes('crypto');
        })
        .map(m => this._normaliseMarket(m, nowSec, false, true))
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  /** Gamma Events endpoint — finds BTC events with embedded short-window markets */
  async _fetchViaEventsAPI() {
    try {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      const found = [];

      // Two passes with different param sets — avoid order=end_date which causes 422
      const paramSets = [
        { active: 'true', closed: 'false', tag_slug: 'crypto', limit: '50' },
        { active: 'true', closed: 'false', limit: '100' },
      ];

      for (const params of paramSets) {
        const url = 'https://gamma-api.polymarket.com/events?' + new URLSearchParams(params);
        let res;
        try {
          res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        } catch (e) { continue; }
        if (!res.ok) continue;
        const events = await res.json();
        if (!Array.isArray(events)) continue;

        for (const event of events) {
          const title = (event.title || event.question || event.slug || '').toLowerCase();
          const isBTCEvent = title.includes('btc') || title.includes('bitcoin') || title.includes('crypto');
          if (!isBTCEvent) continue;

          for (const m of (event.markets || [])) {
            // Markets inside BTC/crypto event skip keyword check — question may just say "Up"/"Down"
            const normalised = this._normaliseMarket(m, nowSec, true, true);
            if (normalised) found.push(normalised);
          }
        }

        if (found.length > 0) break; // stop at first successful pass
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

        // Log BTC markets we saw but filtered — shows their actual end dates
        const btcAll = markets.filter(m => {
          const q = (m.question||m.title||'').toLowerCase();
          return q.includes('btc') || q.includes('bitcoin');
        });
        if (btcAll.length > 0) {
          console.log(`[PolymarketFeed] Gamma Markets API: ${btcAll.length} BTC market(s), none within 2h:`);
          btcAll.slice(0, 5).forEach(m => {
            const rawEnd = m.end_date_iso || m.endDateIso || m.endDate;
            const endMs = rawEnd ? (typeof rawEnd === 'number' ? (rawEnd > 1e12 ? rawEnd : rawEnd * 1000) : new Date(rawEnd).getTime()) : 0;
            const minsLeft = endMs ? ((endMs - now) / 60000).toFixed(0) : '?';
            console.log(`  → "${(m.question||'').slice(0,60)}" ends in ${minsLeft} min`);
          });
        }
      }
      return [];
    } catch (err) {
      console.warn('[PolymarketFeed] Markets API failed:', err.message);
      return [];
    }
  }

  /**
   * CLOB market discovery — primary strategy for 5-min BTC markets.
   *
   * Strategy A: REST API with accepting_orders=true — only returns markets
   *   currently open for trading (avoids the 20k historical market problem).
   * Strategy B: getSamplingMarkets() SDK method — active sampling markets.
   * Strategy C: Gamma slug search — bitcoin-up-or-down events sorted by end_date.
   */
  async _fetchViaCLOB() {
    if (!this.clobClient) return [];
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);

    // Strategy A: REST accepting_orders=true — only live, tradeable markets
    try {
      let aoMarkets = [];
      let aoCursor;
      for (let p = 0; p < 5; p++) {
        const qs = 'accepting_orders=true&limit=500' + (aoCursor ? `&next_cursor=${aoCursor}` : '');
        const res = await fetch(`https://clob.polymarket.com/markets?${qs}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) break;
        const data = await res.json();
        const page = Array.isArray(data) ? data : (data?.data || data?.markets || []);
        aoMarkets = aoMarkets.concat(page);
        const next = data?.next_cursor;
        if (!next || next === 'LTE=' || page.length === 0) break;
        aoCursor = next;
      }
      const btc = aoMarkets.filter(m => {
        const q = (m.question || '').toLowerCase();
        return q.includes('btc') || q.includes('bitcoin');
      });
      console.log(`[PolymarketFeed] CLOB accepting_orders: ${aoMarkets.length} live, ${btc.length} BTC`);
      // skipDurationCheck=true: start_time may be market creation, not window start
      const results = btc.map(m => this._normaliseMarket(m, nowSec, false, true)).filter(Boolean);
      if (results.length > 0) return results;
      // Diagnose BTC markets that passed accepting_orders but got filtered (max 3, once per 2 min)
      if (btc.length > 0 && (now - (this._lastBtcFilterLog||0)) > 120000) {
        this._lastBtcFilterLog = now;
        btc.slice(0, 3).forEach(m => {
          const rawEnd = m.end_date_iso || m.endDateIso || m.end_time || m.resolution_time;
          const endMs = rawEnd ? new Date(rawEnd).getTime() : 0;
          const minsLeft = endMs ? ((endMs - now) / 60000).toFixed(1) : '?';
          const rawStart = m.start_date_iso || m.startDateIso || m.start_time;
          const startMs = rawStart ? new Date(rawStart).getTime() : 0;
          const durMin = (startMs && endMs) ? ((endMs - startMs) / 60000).toFixed(0) : '?';
          console.log(`  [BTC filtered] "${(m.question||'').slice(0,50)}" ends in ${minsLeft}min, dur=${durMin}min`);
        });
      }
    } catch (e) {
      console.warn('[PolymarketFeed] CLOB accepting_orders failed:', e.message);
    }

    // Strategy B: getSamplingMarkets() — SDK sampling markets
    try {
      let cursor;
      const allSampling = [];
      for (let i = 0; i < 5; i++) {
        const resp = cursor
          ? await this.clobClient.getSamplingMarkets(cursor)
          : await this.clobClient.getSamplingMarkets();
        const page = Array.isArray(resp) ? resp : (resp?.data || resp?.markets || []);
        allSampling.push(...page);
        const next = resp?.next_cursor;
        if (!next || next === 'LTE=' || page.length === 0) break;
        cursor = next;
      }
      const btc = allSampling.filter(m => {
        const q = (m.question || '').toLowerCase();
        return q.includes('btc') || q.includes('bitcoin');
      });
      const results = btc.map(m => this._normaliseMarket(m, nowSec)).filter(Boolean);
      console.log(`[PolymarketFeed] CLOB sampling: ${allSampling.length} markets, ${btc.length} BTC, ${results.length} active`);
      if (results.length > 0) return results;
    } catch (e) {
      console.warn('[PolymarketFeed] CLOB getSamplingMarkets failed:', e.message);
    }

    // Strategy C: Gamma events with crypto/bitcoin tag sorted by soonest end
    try {
      const url = 'https://gamma-api.polymarket.com/events?' + new URLSearchParams({
        active: 'true', closed: 'false', tag_slug: 'crypto',
        order: 'end_date', ascending: 'true', limit: '50',
      });
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const events = await res.json();
        if (Array.isArray(events)) {
          const found = [];
          for (const ev of events) {
            const t = (ev.title || ev.question || ev.slug || '').toLowerCase();
            if (!t.includes('btc') && !t.includes('bitcoin')) continue;
            for (const m of (ev.markets || [])) {
              const norm = this._normaliseMarket(m, nowSec, true);
              if (norm) found.push(norm);
            }
          }
          if (found.length > 0) {
            console.log(`[PolymarketFeed] Gamma crypto tag: ${found.length} BTC market(s) found`);
            return found;
          }
        }
      }
    } catch (e) {
      // silent
    }

    return [];
  }

  /**
   * One-per-minute diagnostic: fetches raw events/markets and logs what's
   * actually available, without filtering — so Railway logs reveal whether
   * no BTC markets exist or our filters are too strict.
   */
  async _logDiagnostic() {
    try {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      console.log(`[PolymarketFeed] DIAGNOSTIC — ${new Date(now).toISOString()}`);

      // Check Events API
      const evRes = await fetch('https://gamma-api.polymarket.com/events?' + new URLSearchParams({
        active: 'true', closed: 'false', order: 'end_date', ascending: 'true', limit: '20'
      }), { signal: AbortSignal.timeout(5000) });
      if (evRes.ok) {
        const events = await evRes.json();
        const btcEvents = (Array.isArray(events) ? events : []).filter(e => {
          const t = (e.title || e.question || e.slug || '').toLowerCase();
          return t.includes('btc') || t.includes('bitcoin');
        });
        if (btcEvents.length > 0) {
          console.log(`[PolymarketFeed] DIAG Events API: ${btcEvents.length} BTC event(s):`);
          btcEvents.forEach(e => {
            const mCount = (e.markets || []).length;
            const firstEnd = e.markets?.[0]?.endDate || e.markets?.[0]?.endDateIso || '?';
            const minsLeft = firstEnd !== '?' ? ((new Date(firstEnd).getTime() - now) / 60000).toFixed(1) : '?';
            console.log(`  → "${(e.title||e.slug||'').slice(0,60)}" — ${mCount} market(s), first ends in ${minsLeft} min`);
          });
        } else {
          console.log(`[PolymarketFeed] DIAG Events API: 0 BTC events in top-20 by end_date`);
          if (Array.isArray(events) && events.length > 0) {
            // Show what IS at the top
            const top = events.slice(0, 3).map(e => `"${(e.title||e.slug||'?').slice(0,40)}"`).join(', ');
            console.log(`[PolymarketFeed] DIAG Top-3 events: ${top}`);
          }
        }
      } else {
        console.log(`[PolymarketFeed] DIAG Events API: HTTP ${evRes.status}`);
      }

      // Check Markets API for any BTC market regardless of end date
      const mkRes = await fetch('https://gamma-api.polymarket.com/markets?' + new URLSearchParams({
        active: 'true', closed: 'false', order: 'end_date', ascending: 'true', limit: '100'
      }), { signal: AbortSignal.timeout(6000) });
      if (mkRes.ok) {
        const markets = await mkRes.json();
        const btcAll = (Array.isArray(markets) ? markets : []).filter(m => {
          const q = (m.question||m.title||'').toLowerCase();
          return q.includes('btc') || q.includes('bitcoin');
        });
        console.log(`[PolymarketFeed] DIAG Markets API: ${btcAll.length} BTC market(s) (any end date):`);
        btcAll.slice(0, 5).forEach(m => {
          const rawEnd = m.end_date_iso || m.endDateIso || m.endDate;
          const endMs = rawEnd ? (typeof rawEnd === 'number' ? (rawEnd > 1e12 ? rawEnd : rawEnd * 1000) : new Date(rawEnd).getTime()) : 0;
          const minsLeft = endMs ? ((endMs - now) / 60000).toFixed(1) : '?';
          console.log(`  → "${(m.question||'').slice(0,60)}" ends in ${minsLeft} min`);
        });
      }
    } catch (err) {
      console.log(`[PolymarketFeed] DIAG failed: ${err.message}`);
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
