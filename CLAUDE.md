# Polybot — Claude Code Project Context

## What This Is
Live algorithmic trading bot for Polymarket BTC 5-minute binary markets.
Node.js + Express backend, PostgreSQL (Railway), single-page HTML frontend.

## Architecture
- `src/bot/GBMSignalEngine.js` — three-gate signal evaluation (micro + EV + EMA confirmation)
- `src/bot/BotInstance.js` — snipe loop, trade execution, TP/SL management
- `src/bot/MicrostructureEngine.js` — latency detection (BTC vs Polymarket token price lag)
- `src/bot/EVEngine.js` — cost-adjusted EV calculation
- `src/bot/PolymarketFeed.js` — CLOB order placement, market discovery, balance
- `src/bot/BinanceFeed.js` — BTC tick data, order book imbalance, volatility
- `src/routes/` — REST API (user, trades, bot control, claude analysis, copy trading)
- `public/index.html` — entire frontend (single file, ~2500 lines)

## Critical Price Scale Rule
**BTC price (~$90k) and Polymarket token price (0.0–1.0) are COMPLETELY DIFFERENT.**
- `microEngine.composite({ polyPrice })` → must receive token mid-price (0–1)
- `marketProb` in Kelly formula → must be 0–1
- `(1/marketProb)-1` → produces ~1x payout; if BTC price used, this is ~-1 (nonsense)

## Known Bug History
- `pnl.toFixed()` crashes → Postgres DECIMAL returns as JS string, always `parseFloat()` first
- Zero-edge forced trades → T-5s fallback was calling `_fallbackSignal()` unconditionally, removed
- $6.33M phantom P&L → old corrupted test trades, filtered by `WHERE ABS(pnl) < 100000`
- Win rate 0% → TP/SL exits wrote `result='CLOSED'`, stats only counted `result='WIN'`

## Paper vs Live Mode
- Controlled by `bot_settings.paper_trading` (boolean, default true)
- `BotInstance.paperTrading` is set at construction from settings — requires **restart** to change mode
- NEVER call `polymarket.placeOrder()` when `this.paperTrading === true`

## Deployment
- Backend: Railway (auto-deploys on push to `main` branch of `github.com/fmrxr/polybot-backend`)
- Database: Railway PostgreSQL (connection via `DATABASE_URL` env var)
- No test suite — manual testing via dashboard

## MCP Servers (this project)
- `postgres`: query live DB for trade/decision analysis (requires DATABASE_URL in env)
- `github`: PR/issue/CI management (requires GITHUB_TOKEN in env)

## Skills
- `/signal-audit` — diagnose gate failures in bot_decisions
- `/deploy` — conventional commit + push workflow
