# Polybot — Claude Code Project Context

## What This Is
Live algorithmic trading bot for Polymarket BTC 5-minute binary markets.
Node.js + Express backend, PostgreSQL (Railway), single-page HTML frontend.
EV-driven prediction market strategy — NOT scalping or latency arbitrage.

## Architecture
- `src/bot/GBMSignalEngine.js` — three-gate signal evaluation (micro + EV + EMA confirmation)
- `src/bot/BotInstance.js` — snipe loop, trade execution (real ASK price), TP/SL management
- `src/bot/MicrostructureEngine.js` — latency detection (BTC vs Polymarket token price lag)
- `src/bot/EVEngine.js` — cost-adjusted EV calculation
- `src/bot/PolymarketFeed.js` — CLOB order placement, market discovery, balance
- `src/bot/BinanceFeed.js` — BTC tick data, order book imbalance, volatility
- `src/routes/` — REST API (user, trades, bot control, claude analysis, copy trading)
- `public/index.html` — entire frontend (single file, ~2500 lines)
- `public/market-feed.js` — standalone browser script for live Polymarket price display

## Critical Price Scale Rule
**BTC price (~$90k) and Polymarket token price (0.0–1.0) are COMPLETELY DIFFERENT.**
- `microEngine.composite({ polyPrice })` → must receive token mid-price (0–1)
- `marketProb` in Kelly formula → must be 0–1
- `(1/marketProb)-1` → produces ~1x payout; if BTC price used, this is ~-1 (nonsense)

## Execution Layer Rules
- Entry price = **real order book ASK** at execution time — never Gamma mid or signal.entryPrice
- Spread filter: skip any trade where `spread > 15%` (boundary-only books = bid=0.01/ask=0.99)
- Paper trading simulates real cost: `entry = ask + 25% of spread` as slippage
- Hard trade size cap: **$5 max per trade** regardless of Kelly or balance
- Kelly cap: **25%** (but $5 hard cap means it only matters at very low balances)
- Token size for CLOB limit orders: `tokenSize = dollarAmount / price` (not dollar amount directly)

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
- Phantom $90k P&L on $1000 balance → entry used Gamma mid (~0.505), resolved at 0.99 = fake win; Kelly then sized next trade at full inflated balance → fix: real ASK + $5 hard cap
- Paper balance reset not sticking → `UPDATE bot_settings` updates DB but running bot keeps in-memory value; `reset-paper-balance` route now also sets `bot.paperBalance` directly

## Paper vs Live Mode
- Controlled by `bot_settings.paper_trading` (boolean, default true)
- `BotInstance.paperBalance` is set at construction from DB — requires **restart** to pick up a DB-only balance change
- Paper balance reset via settings button syncs both DB and in-memory (`bot.paperBalance = 10000`)
- NEVER call `polymarket.placeOrder()` when `this.paperTrading === true`

## Market Discovery (Gamma slug-based)
- Primary: slug lookup `btc-updown-5m-<epochSec>` for current + ±1 window (300s boundary)
- Fallback: Gamma `end_date_min/max` query for markets ending in next 10 min
- CLOB `getMarkets()` only returns historical 2023 data — disabled, returns `[]`
- `clobTokenIds` from Gamma API is a JSON string — always `JSON.parse()` if `typeof === 'string'`
- Token `outcome` field is often `undefined` in Gamma responses — IDs come from `clobTokenIds`, not `tokens[].outcome`

## Deployment
- Backend: Railway (auto-deploys on push to `main` branch of `github.com/fmrxr/polybot-backend`)
- Database: Railway PostgreSQL (connection via `DATABASE_URL` env var)
- Public DB URL: `gondola.proxy.rlwy.net:42802` (internal: `postgres.railway.internal:5432`)
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
