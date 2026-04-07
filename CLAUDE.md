# Polybot — Claude Code Project Context

## What This Is
Live algorithmic trading bot for Polymarket BTC 5-minute binary markets.
Node.js + Express backend, PostgreSQL (Render), single-page HTML frontend.
EV-driven prediction market strategy — NOT scalping or latency arbitrage.

## Architecture
- `src/bot/GBMSignalEngine.js` — multi-gate signal evaluation (scenario → micro → EV → evTrend → Gate 3)
- `src/bot/BotInstance.js` — main loop, trade execution, position management, session lifecycle
- `src/bot/MicrostructureEngine.js` — latency detection (BTC vs Polymarket token price lag)
- `src/bot/EVEngine.js` — cost-adjusted EV calculation + EV trend velocity tracking
- `src/bot/PolymarketFeed.js` — CLOB order placement, market discovery, live price fetching
- `src/bot/BinanceFeed.js` — BTC tick data, order book imbalance, volatility
- `src/routes/` — REST API (user, trades, bot control, claude analysis, copy trading)
- `public/index.html` — entire frontend (single file, ~3000 lines)
- `public/market-feed.js` — standalone browser script for live Polymarket price display

## Critical Price Scale Rule
**BTC price (~$70k) and Polymarket token price (0.0–1.0) are COMPLETELY DIFFERENT.**
- `microEngine.composite({ polyPrice })` → must receive token mid-price (0–1)
- `marketProb` in Kelly formula → must be 0–1
- `(1/marketProb)-1` → produces ~1x payout; if BTC price used, this is ~-1 (nonsense)

## Price Discovery — Single Source of Truth
BTC 5-min markets have **boundary-only CLOB books** (bid=0.01/ask=0.99) — the CLOB mid is always 0.5 and useless. Real price comes from Gamma API only.

**Price waterfall in GBMSignalEngine:**
1. CLOB YES book midPrice (only if spread ≤ 10%)
2. CLOB NO book midPrice derived to YES (only if spread ≤ 10%)
3. **Fresh Gamma `/markets/:id` call per tick** — `getLivePriceFromGamma()` — NOT cached `market.outcomePrices`
4. Fallback: cached `market.outcomePrices` if live fetch fails

**Why fresh fetch matters:** `market.outcomePrices` is cached from discovery (up to 30s stale). A market can move from 0.50 → 0.78 between discovery fetches. Always use the live fetch.

**`_priceCache` (signal engine):** `Map<marketId, { smoothedPrice, priceSource, timestamp }>` — updated every tick for ALL evaluated markets (not just the traded one). Used by:
- `_manageOpenPositions` (Fallback 1 for current token price)
- `_broadcastState` (SSE live price for UI Current/P&L display)

**`_broadcastState` SSE price:** reads `signalEngine._priceCache` (fresh) → falls back to `m.outcomePrices` (stale). Never use `m.outcomePrices` directly for display.

## Execution Layer Rules
- Entry price = **real order book ASK** at execution time — never Gamma mid or signal.entryPrice
- Boundary books (spread ≥ 90%): execute via GTC limit at `gammaPrice + 0.01` — this is how Polymarket UI fills
- Spread filter: skip any trade where `spread > 15%` (non-boundary real books only)
- Paper trading simulates real cost: `entry = ask + 25% of spread` as slippage
- Trade size cap: **`max_trade_size` from `bot_settings` (user-configurable)** — no hardcoded cap
- Kelly cap: **`kelly_cap` from `bot_settings` (user-configurable, default 10%)**
- Token size for CLOB limit orders: `tokenSize = dollarAmount / price` (not dollar amount directly)
- `CLOB /lastTradePrice` endpoint returns **HTTP 404** for all BTC 5-min markets — do not rely on it for live pricing, only for resolution detection

## Signal Engine Gate Pipeline
Gates run in order; first failure = SKIP:
1. **Freshness** — BTC tick age ≤ `stale_lag_seconds`
2. **No-Chase** — price moved < `chase_threshold` since last tick
3. **Scenario filter** — `RANGE_CHOP` blocked unless Gamma displacement ≥ `range_chop_gamma_override` (default 0.5%); `NEWS_SPIKE` always blocked
4. **btcFlat** — `|btcDelta| ≥ min_btc_delta` (default 0.005%) OR Gamma price significantly off 0.5
5. **Time gate** — market must be open (elapsed ≥ 0) and in last 300s
6. **Boundary book guard** — `spread < 0.90` (Gamma-sourced markets use synthetic spread=0.02, always pass)
7. **Depth floor** — book depth ≥ 100 USDC
8. **Gate 2 (EV)** — primary signal: `evAdj ≥ gate2_ev_floor` (adjusted by scenario multipliers)
9. **evTrend** — skip if EV is actively collapsing: `isEVDecaying && velocity < -ev_decay_ratio`
10. **Gate 3 (direction)** — BTC direction must match signal direction (skipped if `|btcDelta| < gate3_min_delta`)
11. **Confidence** — `signalConfidence ≥ 0.15`

**Scenario classification** (from `btcDelta` + price history):
- `MOMENTUM_BREAKOUT` — strong sustained move, ease EV floor ×0.80
- `LAG_EDGE` — Polymarket lagging BTC, ease floor ×0.65
- `VOLATILITY_EXPANSION` — widening volatility, ease floor ×0.90
- `FAKE_BREAKOUT` — reversal after spike, tighten floor ×1.50
- `RANGE_CHOP` — flat market, blocked unless Gamma displaced
- `MEAN_REVERSION` — counter-trend, reduce confidence ×0.85

## Position Management
- **Single source of truth for live price:** signal.yesPrice (smoothed) for decisions; signal.rawPrice for PnL marking
- When signal is for a different market than the open position: use `_priceCache` (Fallback 1), then `getLivePriceFromGamma` (Fallback 2), then `_cachedLivePrice` (Fallback 3)
- `livePriceSrc` in Holding logs shows which source was used: `signal`, `cache(gamma)`, `gamma_direct`, `cached_last`
- **EV-driven flip:** closes losing position and opens opposite when EV gain > `flip_threshold` (default 5%). Dynamic: +1% escalation per recent flip in last 10 min to suppress whipsaw. Hard hysteresis floor: 6% (`FLIP_HYSTERESIS` constant)
- **Flip guard:** only flip when PnL < 0 — never flip a winning position. Also requires BTC momentum to support new direction
- Near-resolved filter: skip markets where `rawYesPrice ≥ 0.88 || rawYesPrice ≤ 0.12`
- **One signal per tick:** the signal engine returns the first market that passes all gates and stops. Only one new position can open per tick — simultaneous multi-market entry is structurally impossible
- **Directional exposure cap:** `_checkDirectionalExposure()` called each tick before execution — blocks new positions if net directional exposure ≥ 30% of balance in the same direction
- **Lag detection (MicrostructureEngine):** compares 30s BTC % change vs 30s Polymarket token % change. `lagScore = |btcDelta - polyDelta| / |btcDelta|`. `hasMarketLag = latencyScore > 0.3`. When lag detected AND elapsed < 60s, EV floor eases ×0.80

## Session Lifecycle
- Each bot start creates a new `trading_sessions` row
- On restart: open trades from previous session are checked — **re-adopted** if market still live, closed with real P&L if resolved
- `_getResolutionPrice`: tries Gamma outcomePrices first → CLOB lastTradePrice fallback → force-close at 15 min if still ambiguous
- UMA challenge period: after market expiry, Gamma returns `["0.5","0.5"]` for 3–15 min — CLOB lastTradePrice fallback handles this
- **Duplicate position dedup:** on session start, if multiple open positions exist for same market, keep oldest (`MIN(id)`), close extras with `close_reason='DUPLICATE_DEDUP'`

## Re-entrance Guard
`_loopRunning` boolean prevents overlapping tick executions. With 4+ markets × API calls, a tick can take 15–20s — longer than the 10s interval. Without the guard, two ticks run in parallel and both enter the same market.

## Polymarket CLOB SDK v5.8.1 — Breaking Changes
The SDK changed significantly between v4 and v5. Always use v5 patterns:

```js
// Constructor (v4 had walletAddress as 5th param — now signatureType)
new ClobClient(host, 137, privateKey, undefined, 0, walletAddress)
//                                               ^ signatureType=0 (EOA)
//                                                  ^ funderAddress

// Order placement (v4: createAndPlaceOrder — removed in v5)
await clobClient.createAndPostOrder(
  { tokenID: tokenId, side: Side.BUY, price, size: dollarAmount / price },
  undefined, OrderType.GTC, false
)
// Note: tokenID (capital ID), Side enum from import, size = token qty not dollars
```

## Known Bug History
- `pnl.toFixed()` crashes → Postgres DECIMAL returns as JS string, always `parseFloat()` first
- Zero-edge forced trades → T-5s fallback was calling `_fallbackSignal()` unconditionally, removed
- $6.33M phantom P&L → old corrupted test trades, filtered by `WHERE ABS(pnl) < 100000`
- Win rate 0% → TP/SL exits wrote `result='CLOSED'`, stats only counted `result='WIN'`
- `createAndPlaceOrder is not a function` → SDK v5 renamed to `createAndPostOrder`; also walletAddress was passed as 5th constructor arg (now signatureType) breaking auth entirely
- Phantom $90k P&L → entry used Gamma mid (~0.505), resolved at 0.99 = fake win; fix: real ASK price + user-configured `max_trade_size` cap
- Paper balance reset not sticking → `UPDATE bot_settings` updates DB but running bot keeps in-memory value; `reset-paper-balance` route now also sets `bot.paperBalance` directly
- All P&L showing $0.00 → `SESSION_RESET_UNKNOWN` was closing all open trades at entry price on every restart; fix: re-adopt still-live trades instead of closing them
- Duplicate trades per market → `_mainLoop` had no re-entrance guard; fix: `_loopRunning` boolean
- `MARKET_RESOLVED_TIMEOUT` at entry price → Gamma returns `["0.5","0.5"]` during UMA challenge period; fix: CLOB lastTradePrice fallback + extend timeout to 15 min
- `lastTradePrice` filter blocking settlement prices → filter `p <= 0.01 || p >= 0.99` blocked 0.0/1.0; fix: `p < 0 || p > 1`
- Current/P&L showing `…` forever → `_broadcastState` used stale `m.outcomePrices`; fix: read from `signalEngine._priceCache`
- Stale price (0.50 while real market is 0.78) → `outcomePrices` cached from discovery (30s stale); fix: `getLivePriceFromGamma()` fresh call per tick
- Admin Start/Stop button silently doing nothing → `global.botManager` never set; fix: `req.app.locals.botManager`

## Market Discovery (Gamma slug-based)
- S0: slug lookup `btc-updown-5m-<epochSec>` for current + ±1 window (300s boundary)
- S1: Gamma `end_date_min/max` query for all markets ending in next 30 min
- Accepts: true 5-min BTC markets (slug `btc-updown-5m-*`) + short-window (≤15 min) BTC markets in last 5 min
- Rejects: hourly/daily markets — wrong timeframe
- CLOB `getMarkets()` only returns historical 2023 data — disabled, returns `[]`
- `clobTokenIds` from Gamma API is a JSON string — always `JSON.parse()` if `typeof === 'string'`
- Token `outcome` field is often `undefined` in Gamma responses — IDs come from `clobTokenIds`

## Paper vs Live Mode
- Controlled by `bot_settings.paper_trading` (boolean, default true)
- `BotInstance.paperBalance` is set at construction from DB — requires **restart** to pick up a DB-only balance change
- Paper balance reset via settings button syncs both DB and in-memory (`bot.paperBalance = newValue`)
- NEVER call `polymarket.placeOrder()` when `this.paperTrading === true`
- Paper fill simulation: resting GTC limit order fills when Gamma price moves through limit price for 2 consecutive ticks

## Deployment
- Backend: Render (auto-deploys on push to `main` branch of `github.com/fmrxr/polybot-backend`)
- Database: Render PostgreSQL (connection via `DATABASE_URL` env var)
- No test suite — manual testing via dashboard

## Data Reset (when needed)
```sql
TRUNCATE TABLE trades, signals, bot_decisions, bot_logs, copy_trades,
               claude_analyses, admin_logs, whale_performance, copy_target_state
RESTART IDENTITY CASCADE;
UPDATE bot_settings SET paper_balance = 1000.00;
```
Then restart both bots from dashboard to sync in-memory balances.

## MCP Servers (this project)
- `postgres`: query live DB for trade/decision analysis (requires DATABASE_URL in env)
- `github`: PR/issue/CI management (requires GITHUB_TOKEN in env)

## Skills
- `/signal-audit` — diagnose gate failures in bot_decisions
- `/deploy` — conventional commit + push workflow
