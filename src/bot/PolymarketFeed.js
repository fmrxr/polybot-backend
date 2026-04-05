// ClobClient is ESM-only — must be loaded with dynamic import()
let _ClobClient = null;
let _Side = null;
let _OrderType = null;
async function getClobClient() {
  if (!_ClobClient) {
    const mod = await import('@polymarket/clob-client');
    _ClobClient = mod.ClobClient;
    _Side = mod.Side;           // Side.BUY = 0, Side.SELL = 1
    _OrderType = mod.OrderType; // OrderType.GTC, OrderType.FOK, etc.
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
        // SDK v5.8.1 constructor: (host, chainId, signer, creds, signatureType, funderAddress, ...)
        // v4 had (host, chainId, privateKey, undefined, walletAddress) — walletAddress was 5th.
        // v5 moved walletAddress to 6th (funderAddress); 5th is now signatureType (0=EOA).
        this.clobClient = new ClobClient(
          'https://clob.polymarket.com',
          137,
          this.privateKey,   // signer (private key)
          undefined,         // creds (API key — not used with EOA signing)
          0,                 // signatureType: 0 = EOA (ECDSA EIP-712)
          this.walletAddress // funderAddress (wallet that funds the orders)
        );
        console.log('[PolymarketFeed] CLOB client initialized (authenticated EOA)');
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
    // CLOB getMarkets() only returns historical markets (2023) — skip entirely.
    // 5-min BTC markets are found via slug lookup in _fetchGammaShortWindow.
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
      // Gamma list uses endDate (full ISO) and endDateIso (date-only "2026-04-03" — useless).
      // Must check endDate BEFORE endDateIso to avoid parsing date-only as midnight UTC.
      const raw = m.end_date_iso || m.endDate || m.endDateIso;
      if (!raw) return 0;
      const s = typeof raw === 'string' ? raw : String(raw);
      // Skip if date-only string (no time component) — would resolve to midnight UTC
      if (/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return 0;
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
          const btc = markets.filter(m => /btc|bitcoin/i.test((m.question || m.slug || '').trim()));
          if (btc.length > 0) {
            console.log(`[PolymarketFeed] S1 found ${btc.length} BTC market(s)`);
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

    // Parse end date — Gamma uses endDate (full ISO) + endDateIso (date-only, useless for time).
    // Must check endDate BEFORE endDateIso. CLOB uses end_date_iso (snake_case).
    const _ts = (v) => {
      if (!v) return 0;
      if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
      const s = String(v).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 0; // date-only → skip
      return new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z').getTime();
    };
    const rawEnd = m.end_date_iso || m.endDate || m.endDateIso || m.resolution_time || m.end_time;
    if (!rawEnd) return null;
    const endMs = _ts(rawEnd);
    if (isNaN(endMs)) return null;
    const endSec = Math.floor(endMs / 1000);

    // Must still be open
    if (endSec <= nowSec) return null;
    // Must end within 2 hours (wide enough for "next window" pre-loading)
    if ((endSec - nowSec) > 7200) return null;

    // Parse start date
    // For Gamma markets (skipDurationCheck=true): Gamma's startDate = market CREATION time (can be
    // days before the 5-min window), NOT the window start. Force startSec = endSec - 300.
    // For CLOB markets: use the actual start field if valid and within a 10-min window.
    let startSec;
    if (skipDurationCheck) {
      startSec = endSec - 300; // Always 5-min window for slug/Gamma results
    } else {
      const rawStart = m.start_date_iso || m.startDate || m.startDateIso || m.start_time;
      startSec = rawStart ? Math.floor(_ts(rawStart) / 1000) : endSec - 300;
      if (!startSec || isNaN(startSec)) startSec = endSec - 300;
    }

    const durationSec = endSec - startSec;
    if (!skipDurationCheck && (durationSec <= 0 || durationSec > 600)) return null;

    // Normalise token IDs
    const tokens = m.tokens || [];
    let clobIds = m.clobTokenIds || m.clob_token_ids || tokens.map(t => t.token_id);
    if (typeof clobIds === 'string') {
      try { clobIds = JSON.parse(clobIds); } catch (e) { clobIds = []; }
    }

    return {
      ...m,
      id: m.id || m.conditionId || m.condition_id,
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

  /** Get live token price from CLOB order book.
   * Returns null if the book has only boundary orders (bid=0.01/ask=0.99)
   * so callers can fall back to Gamma API outcomePrices. */
  async getLiveTokenPrice(tokenId) {
    try {
      const book = await this.getOrderBook(tokenId);
      if (!book || book.midPrice == null) return null;
      // Boundary-only books (spread > 90%) yield a meaningless midPrice of 0.5.
      // Return null so the caller uses a better source (Gamma outcomePrices).
      const spread = book.spread ?? (book.bestAsk - book.bestBid);
      if (spread != null && spread > 0.90) return null;
      return book.midPrice;
    } catch (err) {
      console.error(`[PolymarketFeed] getLiveTokenPrice failed for ${tokenId}:`, err.message);
      return null;
    }
  }

  /** Fetch current YES token price from Gamma API outcomePrices.
   * Use when CLOB book is boundary-only. clobTokenIds[0] = YES token. */
  async getLivePriceFromGamma(marketId, tokenId) {
    try {
      const r = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`,
        { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return null;
      const m = await r.json();
      let op = m.outcomePrices;
      if (typeof op === 'string') { try { op = JSON.parse(op); } catch(_) { return null; } }
      if (!Array.isArray(op) || op.length < 2) return null;
      // Match tokenId to clobTokenIds to find which index is ours
      let clobIds = m.clobTokenIds;
      if (typeof clobIds === 'string') { try { clobIds = JSON.parse(clobIds); } catch(_) { clobIds = []; } }
      const idx = clobIds?.indexOf(tokenId);
      const price = idx >= 0 ? parseFloat(op[idx]) : parseFloat(op[0]);
      return (!isNaN(price) && price > 0.02 && price < 0.98) ? price : null;
    } catch (_) { return null; }
  }

  /** Fetch USDC balance for a wallet */
  static async fetchBalance(privateKey, walletAddress) {
    try {
      const ClobClient = await getClobClient();
      const client = new ClobClient('https://clob.polymarket.com', 137, privateKey, undefined, 0, walletAddress);
      const result = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      const usdc = parseFloat(result?.balance ?? result?.usdc_balance ?? result ?? '0');
      return { usdc, wallet: walletAddress };
    } catch (err) {
      console.error('[PolymarketFeed] fetchBalance failed:', err.message);
      return { usdc: 0, wallet: walletAddress };
    }
  }

  /**
   * Place a limit order on Polymarket CLOB.
   * @param {string} tokenId   - Conditional token ID (YES or NO token)
   * @param {string} side      - 'BUY' or 'SELL'
   * @param {number} dollarSize - Dollar amount to spend (e.g. $1.00)
   * @param {number} price     - Limit price in token probability scale (0–1)
   *
   * SDK v5.8.1 notes:
   *   - Method renamed: createAndPlaceOrder → createAndPostOrder
   *   - Field renamed:  tokenId           → tokenID (capital ID)
   *   - size is in TOKENS not dollars: tokenSize = dollarSize / price
   *     e.g. $1 at price 0.50 → 2 tokens; at price 0.99 → ~1.01 tokens
   */
  async placeOrder(tokenId, side, dollarSize, price) {
    if (!this.clobClient) throw new Error('CLOB client not initialized for trading');

    // Ensure SDK enums are loaded
    await getClobClient();
    const Side = _Side;
    const OrderType = _OrderType;

    // Convert dollar amount to token quantity (what the CLOB expects for limit orders)
    const tokenSize = parseFloat((dollarSize / price).toFixed(2));
    if (!isFinite(tokenSize) || tokenSize <= 0) {
      throw new Error(`Invalid token size: dollarSize=${dollarSize} price=${price} → tokenSize=${tokenSize}`);
    }

    // Map string side to SDK enum (Side.BUY=0, Side.SELL=1)
    const sideEnum = side === 'SELL' ? Side.SELL : Side.BUY;

    console.log(`[PolymarketFeed] Placing order: ${side} ${tokenSize} tokens @ ${price} (~$${dollarSize}) for token ${tokenId?.slice(0,12)}...`);

    try {
      // createAndPostOrder replaces old createAndPlaceOrder
      // Uses GTC (Good Till Cancelled) by default
      const resp = await this.clobClient.createAndPostOrder(
        { tokenID: tokenId, side: sideEnum, price, size: tokenSize },
        undefined,         // options
        OrderType.GTC,     // order type
        false              // deferExec
      );
      console.log(`[PolymarketFeed] Order placed successfully: orderId=${resp?.orderID ?? resp?.order_id ?? JSON.stringify(resp)?.slice(0,80)}`);
      return resp;
    } catch (err) {
      console.error(`[PolymarketFeed] placeOrder failed:`, err.message);
      throw err;
    }
  }
}

module.exports = PolymarketFeed;
