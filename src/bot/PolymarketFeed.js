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

// ethers v6 Wallet signer — required by CLOB SDK v5 (raw private key string is rejected)
// The CLOB SDK v5 detects ethers signers via `_signTypedData` (ethers v5 API).
// ethers v6 renamed this to `signTypedData`, so the SDK falls through to the viem
// walletClient branch and fails with "wallet client is missing account address".
// Fix: wrap ethers v6 Wallet and expose `_signTypedData` as an alias.
let _ethers = null;
async function getEthersSigner(privateKey) {
  if (!_ethers) _ethers = require('ethers');
  const wallet = new _ethers.Wallet(privateKey);
  // Polyfill ethers v5 API so CLOB SDK v5 detects this as an ethers TypedDataSigner
  if (typeof wallet._signTypedData !== 'function' && typeof wallet.signTypedData === 'function') {
    wallet._signTypedData = (domain, types, value) => wallet.signTypedData(domain, types, value);
  }
  return wallet;
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
        // SDK v5 requires an ethers.js Wallet signer — raw private key string is rejected
        // with "unsupported signer type". Wrap the key in an ethers v6 Wallet first.
        const signer = await getEthersSigner(this.privateKey);

        // Step 1: Create a temporary L1-only client to derive API key credentials.
        // createAndPostOrder requires L2 (HMAC) auth using API key creds, in addition
        // to the wallet signer. Derive them from the private key via the CLOB API.
        const l1Client = new ClobClient(
          'https://clob.polymarket.com',
          137,
          signer,
          undefined,         // no creds yet
          0,                 // signatureType: 0 = EOA
          this.walletAddress
        );

        let creds;
        try {
          creds = await l1Client.deriveApiKey();
          console.log('[PolymarketFeed] API key derived successfully');
        } catch (e) {
          console.warn('[PolymarketFeed] deriveApiKey failed, trying createApiKey:', e.message);
          try {
            creds = await l1Client.createApiKey();
            console.log('[PolymarketFeed] API key created successfully');
          } catch (e2) {
            console.error('[PolymarketFeed] Could not get API key credentials:', e2.message);
            throw new Error(`Failed to obtain CLOB API credentials: ${e2.message}`);
          }
        }

        // Step 2: Create the fully-authenticated client with both signer + API key creds.
        this.clobClient = new ClobClient(
          'https://clob.polymarket.com',
          137,
          signer,
          creds,             // { key, secret, passphrase } — required for L2 (order placement)
          0,                 // signatureType: 0 = EOA (ECDSA EIP-712)
          this.walletAddress // funderAddress (wallet that funds the orders)
        );
        console.log('[PolymarketFeed] CLOB client initialized (authenticated EOA + API key)');
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
      this.marketCacheTTL = 15000; // 15s — re-check frequently so new windows are picked up fast
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

    // ── Strategy 0 + 1 combined: collect ALL active BTC markets ─────────────────
    // S0: slug-based lookup for exactly-aligned 5-min windows
    // S1: end_date_min/max sweep for all markets ending in next 30 min
    // Both run always — S0 alone misses markets with non-slug-aligned windows
    // (e.g. 1:30-1:45, 1:35-1:40 that exist alongside the boundary-only slug market)
    const seenIds = new Set();
    const collected = [];

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
            if (norm) {
              const id = norm.id || norm.conditionId;
              if (id && !seenIds.has(id)) { seenIds.add(id); collected.push(norm); }
            }
          }
        } else if (res.status !== 404) {
          console.warn(`[PolymarketFeed] Slug ${slug} HTTP ${res.status}`);
        }
      } catch (e) {
        console.warn(`[PolymarketFeed] Slug ${slug} failed: ${e.message}`);
      }
    }

    // ── Strategy 1: end_date_min/max — 30-min window to catch all active markets ─
    const endMin = new Date(nowUTC).toISOString();
    const endMax = new Date(nowUTC + 30 * 60 * 1000).toISOString();
    try {
      const url = `https://gamma-api.polymarket.com/markets?end_date_min=${endMin}&end_date_max=${endMax}&active=true&closed=false&limit=100`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const markets = await res.json();
        if (Array.isArray(markets) && markets.length > 0) {
          // Accept: true 5-min BTC markets (btc-updown-5m-* slug) OR short-window BTC
          // up/down markets (≤15 min duration) in their last 5 min before expiry.
          // Reject: hourly/daily markets — wrong timeframe, no edge.
          const btc = markets.filter(m => {
            const q = (m.question || '').toLowerCase();
            const slug = (m.slug || '').toLowerCase();
            const isBtcUpDown = (q.includes('bitcoin') || q.includes('btc')) && q.includes('up or down');
            if (!isBtcUpDown) return false;
            // True 5-min slug: always accept
            if (slug.startsWith('btc-updown-5m-')) return true;
            // Non-slug BTC up/down: must verify it's a short-window market.
            // Compute actual duration from startDate/endDate if available.
            const endMs = _endMs(m);
            if (!endMs || endMs <= nowUTC) return false;
            const secsRemaining = (endMs - nowUTC) / 1000;
            // Check duration: only accept if market is ≤15 min total (900s).
            // Use startDate if available; otherwise infer from question time range.
            const startRaw = m.startDate || m.start_date_iso || m.startDateIso;
            if (startRaw && !/^\d{4}-\d{2}-\d{2}$/.test(String(startRaw).trim())) {
              const startMs = new Date(String(startRaw).includes('Z') || String(startRaw).includes('+') ? startRaw : startRaw + 'Z').getTime();
              const durationSec = (endMs - startMs) / 1000;
              if (durationSec > 900) return false; // reject hourly/daily markets
            } else {
              // No reliable start date — check question for time-range pattern (e.g. "4:45PM-5:00PM")
              // If question only has a single time (e.g. "4PM ET") it's likely hourly — reject.
              const hasTimeRange = /\d{1,2}:\d{2}(am|pm).{0,5}\d{1,2}:\d{2}(am|pm)/i.test(m.question || '');
              if (!hasTimeRange) return false;
            }
            // Short-window market: only trade in the last 5 min
            return secsRemaining <= 300;
          });
          console.log(`[PolymarketFeed] S1 found ${btc.length} BTC market(s) in next 30 min (5-min or last-5-min-of-longer)`);
          for (const m of btc) {
            const norm = _normalise(m);
            if (norm) {
              const id = norm.id || norm.conditionId;
              if (id && !seenIds.has(id)) { seenIds.add(id); collected.push(norm); }
              continue;
            }
            // _normalise rejected it — build directly from Gamma data
            const endMs = _endMs(m);
            if (!endMs || endMs <= nowUTC) continue;
            const tokens = m.tokens || [];
            let clobIds = m.clobTokenIds || m.clob_token_ids;
            if (typeof clobIds === 'string') { try { clobIds = JSON.parse(clobIds); } catch(e) { clobIds = []; } }
            if (!clobIds || !clobIds.length) clobIds = tokens.map(t => t.token_id || t.tokenId).filter(Boolean);
            const direct = {
              ...m,
              id: m.id || m.conditionId || m.condition_id,
              question: m.question || m.title || '',
              tokens,
              clobTokenIds: clobIds || [],
              end_date_iso: new Date(endMs).toISOString(),
              start_date_iso: new Date(endMs - 300000).toISOString(),
            };
            const id = direct.id;
            if (id && !seenIds.has(id)) { seenIds.add(id); collected.push(direct); }
          }
        }
      } else {
        console.warn(`[PolymarketFeed] S1 end_date HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn('[PolymarketFeed] S1 failed:', e.message);
    }

    if (collected.length > 0) {
      console.log(`[PolymarketFeed] Discovery complete: ${collected.length} BTC market(s) — ${collected.map(m=>(m.question||'').slice(20,45)).join(' | ')}`);
    }
    return collected;
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

  /**
   * Fetch the last traded price for a token from the CLOB.
   * This is the REAL execution price for 5-min BTC markets — the order book
   * shows boundary orders (0.01/0.99) but trades happen at the last traded price (~0.505).
   * Returns price as 0–1 float, or null if unavailable/invalid.
   */
  async getLastTradePrice(tokenId) {
    try {
      const res = await fetch(
        `https://clob.polymarket.com/lastTradePrice?token_id=${tokenId}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!res.ok) {
        console.warn(`[PolymarketFeed] lastTradePrice HTTP ${res.status} for ${tokenId?.slice(0,12)}...`);
        return null;
      }
      let data;
      try { data = await res.json(); } catch (_) {
        console.warn(`[PolymarketFeed] lastTradePrice non-JSON response for ${tokenId?.slice(0,12)}...`);
        return null;
      }
      const p = parseFloat(data?.price);
      if (!isFinite(p) || p < 0 || p > 1) {
        console.warn(`[PolymarketFeed] lastTradePrice invalid: ${data?.price} for ${tokenId?.slice(0,12)}...`);
        return null;
      }
      return p;
    } catch (err) {
      console.warn(`[PolymarketFeed] getLastTradePrice failed for ${tokenId?.slice(0,12)}...: ${err.message}`);
      return null;
    }
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
   * Place a GTC limit order at the last traded price.
   *
   * Polymarket 5-min BTC markets always show a 98% book spread (boundary orders at
   * 0.01/0.99). Real fills happen at the lastTradePrice (~0.505). Submitting a limit
   * order at lastTradePrice + 0.01 (buy) rests on the book at fair value and gets
   * filled by counter-parties — exactly how the UI works.
   *
   * A FOK "market order" at 0.99 would fill at 0.99 (terrible).
   * A FOK at 0.55 would return FOK_ORDER_NOT_FILLED_ERROR (nothing between 0.55-0.99).
   * GTC at lastTradePrice is the correct approach.
   *
   * @param {string} tokenId    - Conditional token ID
   * @param {string} side       - 'BUY' or 'SELL'
   * @param {number} dollarSize - Dollar amount to spend
   * @param {number} fairPrice  - lastTradePrice (0–1) fetched before calling this
   */
  async placeOrder(tokenId, side, dollarSize, fairPrice) {
    if (!this.clobClient) throw new Error('CLOB client not initialized for trading');

    await getClobClient();
    const Side = _Side;
    const OrderType = _OrderType;

    // Snap price to 0.01 tick (Polymarket standard tick size for most markets).
    // Add 1 tick for buys (improves fill probability vs sitting exactly at last trade).
    // Subtract 1 tick for sells.
    const TICK = 0.01;
    let limitPrice;
    if (side === 'SELL') {
      limitPrice = Math.max(0.01, parseFloat((Math.floor(fairPrice / TICK) * TICK).toFixed(2)));
    } else {
      limitPrice = Math.min(0.99, parseFloat((Math.ceil(fairPrice / TICK) * TICK + TICK).toFixed(2)));
    }

    // size = token quantity (CLOB limit orders use token qty, not dollar amount)
    const tokenSize = parseFloat((dollarSize / limitPrice).toFixed(2));
    if (!isFinite(tokenSize) || tokenSize <= 0) {
      throw new Error(`Invalid token size: dollarSize=${dollarSize} limitPrice=${limitPrice} → tokenSize=${tokenSize}`);
    }

    const sideEnum = side === 'SELL' ? Side.SELL : Side.BUY;

    console.log(`[PolymarketFeed] Placing GTC limit: ${side} ${tokenSize} tokens @ ${limitPrice} (fairPrice=${fairPrice}, ~$${dollarSize}) token=${tokenId?.slice(0,12)}...`);

    try {
      const resp = await this.clobClient.createAndPostOrder(
        { tokenID: tokenId, side: sideEnum, price: limitPrice, size: tokenSize },
        { tickSize: '0.01', negRisk: false },
        OrderType.GTC
      );
      console.log(`[PolymarketFeed] Order placed: orderId=${resp?.orderID ?? resp?.order_id} status=${resp?.status}`);
      return { ...resp, price: limitPrice };
    } catch (err) {
      console.error(`[PolymarketFeed] placeOrder failed:`, err.message);
      throw err;
    }
  }

  /**
   * Cancel a resting GTC limit order.
   * Returns true if the cancel request was accepted, false on error.
   */
  async cancelOrder(orderId) {
    try {
      if (!this.clobClient) throw new Error('CLOB client not initialized');
      await this.clobClient.cancelOrder({ orderID: orderId });
      console.log(`[PolymarketFeed] Order ${orderId} cancelled`);
      return true;
    } catch (err) {
      console.error(`[PolymarketFeed] cancelOrder failed for ${orderId}: ${err.message}`);
      return false;
    }
  }

  /**
   * Poll the status of a placed order.
   * Returns { status, sizeMatched, sizeTotal, isFilled, isPartial } or null on error.
   * status values: 'LIVE' (resting), 'MATCHED' (fully filled), 'CANCELLED'
   */
  async getOrderStatus(orderId) {
    try {
      if (!this.clobClient) throw new Error('CLOB client not initialized');
      const order = await this.clobClient.getOrder(orderId);
      if (!order) return null;
      const sizeMatched = parseFloat(order.size_matched ?? order.sizeMatched ?? 0);
      const sizeTotal   = parseFloat(order.size ?? order.original_size ?? 0);
      return {
        status:     order.status || 'UNKNOWN',
        sizeMatched,
        sizeTotal,
        isFilled:  order.status === 'MATCHED',
        isPartial: sizeMatched > 0 && sizeMatched < sizeTotal
      };
    } catch (err) {
      console.error(`[PolymarketFeed] getOrderStatus failed for ${orderId}: ${err.message}`);
      return null;
    }
  }
}

module.exports = PolymarketFeed;
