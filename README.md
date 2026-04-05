# AXIOM — Polymarket BTC Trading Bot

Algorithmic trading bot for Polymarket BTC 5-minute binary markets. Trades "Bitcoin Up or Down" windows using EV-driven signal analysis.

**Live:** [magnificent-prosperity-production.up.railway.app](https://magnificent-prosperity-production.up.railway.app)

**Stack:** Node.js + Express + PostgreSQL (Railway) + Polymarket CLOB SDK v5.8.1 + Binance WebSocket + Chainlink oracle

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        BotInstance.js                        │
│  Main loop (8s interval)                                     │
│  1. Manage open positions (EV-based exits + flips)           │
│  2. Run signal engine                                        │
│  3. Execute trade (real ASK price, $5 hard cap)              │
└──────────────────┬──────────────────────────────────────────┘
                   │
         ┌─────────▼──────────┐
         │  GBMSignalEngine   │   3-gate pipeline
         └─────────┬──────────┘
                   │
    ┌──────────────▼──────────────────────────────────┐
    │  PRE-FILTER A: Signal Freshness                  │
    │  Binance WebSocket last tick < 20s               │
    ├─────────────────────────────────────────────────┤
    │  PRE-FILTER B: No-Chase Rule                     │
    │  Price didn't move >8% since last check          │
    ├─────────────────────────────────────────────────┤
    │  GATE 1: Microstructure (informational)          │
    │  Order book imbalance + whale detection + lag    │
    │  Outputs confidence score → scales modelProb     │
    ├─────────────────────────────────────────────────┤
    │  GATE 2: EV Analysis (PRIMARY SIGNAL)            │
    │  modelProb = yesPrice + btcEdge + micro + lag    │
    │  EV_adj = raw EV - spread - slippage - fees      │
    │  Must exceed gate2_ev_floor (default 3%)         │
    ├─────────────────────────────────────────────────┤
    │  EV TREND FILTER: Is EV decaying?                │
    │  Skip if last 3 EV readings all declining        │
    ├─────────────────────────────────────────────────┤
    │  GATE 3: EMA Confirmation (optional)             │
    │  YES signal needs bullish EMA, NO needs bearish  │
    │  EMA edge must exceed gate3_min_edge (5%)        │
    └─────────────────────────────────────────────────┘
```

---

## Signal Engine — How Edge is Calculated

```
btcDelta  = BTC % change over last 30 seconds (Binance WebSocket)

btcEdge   = min(|btcDelta| * 0.5, 0.15)    0.1% move → 5% edge, cap 15%
microEdge = micro.confidence * 0.10        up to 10% from order book
lagBonus  = 0.05 if Polymarket lags BTC    +5% when latency detected
totalEdge = btcEdge + microEdge + lagBonus

if bullish (btcDelta > 0.05%):
  modelProb = min(0.99, yesPrice + totalEdge)
if bearish (btcDelta < -0.05%):
  modelProb = max(0.01, yesPrice - totalEdge)
else (flat):
  modelProb = yesPrice  →  EV ≈ 0  →  filtered by Gate 2

EV_YES = modelProb*(1-yesPrice) - (1-modelProb)*yesPrice    [× 100 = %]
EV_NO  = (1-modelProb)*yesPrice - modelProb*(1-yesPrice)    [× 100 = %]
EV_adj = max(EV_YES, EV_NO) - spread% - slippage% - fees%
```

**Minimum BTC move to generate a signal (50/50 market, typical microEdge ~2%):**

| BTC 30s move | EV_adj | Signal? |
|---|---|---|
| 0.05% | 1.8% | No (< 3% floor) |
| 0.10% | 4.3% | No |
| 0.15% | 6.8% | Yes |
| 0.20% | 9.3% | Yes |

---

## Execution Layer

Trades use **real order book prices at execution time** — never Gamma mid-prices or cached values.

```
1. Fetch live order book for the token
2. Check spread — skip if > 15% (boundary-only books have bid=0.01/ask=0.99)
3. Entry price = best ASK (what you actually pay to buy)
4. Paper trading adds 25% of spread as simulated slippage
5. Kelly sizing at real ask price, hard cap at $5/trade
6. Live trading: createAndPostOrder({ tokenID, Side.BUY, price, size=$/price })
```

---

## Kelly Criterion (Position Sizing)

```
modelProb = signal.modelProb      (NOT entryPrice — circular bug fixed)
b         = (1 / askPrice) - 1    payout odds at real execution price
kelly     = (modelProb*b - (1-modelProb)) / b
size      = min(kelly * balance, kelly_cap * balance, MAX_TRADE_DOLLARS)
```

---

## Market Discovery

5-min BTC markets use slug-based lookup — CLOB `getMarkets()` only returns historical 2023 data.

```
1. Slug lookup: btc-updown-5m-<epochSec> for current + previous + next 300s window
2. Fallback: Gamma end_date_min/max query (markets ending in next 10 min)
3. clobTokenIds parsed from JSON string → YES token at [0], NO token at [1]
```

---

## EV-Driven Position Management

Exits are NOT time-based. Positions close when:

1. **EV Decay** — current EV < 50% of peak EV for that market
2. **Hard Stop** — P&L < -20% of trade size (safety net)
3. **Deeply Negative EV** — EV < -8%
4. **Flip** — opposite direction EV gain > dynamic threshold (escalates with flip frequency, min 6% hysteresis)
5. **Market Expired** — trade age > 4.5 min → query Gamma for resolution price
6. **Near Resolution** — token price ≥ 0.92 or ≤ 0.08

---

## Risk Controls

| Control | Value | Description |
|---|---|---|
| Kelly Cap | 25% | Max fraction of balance per trade |
| Hard Trade Cap | $5 | Absolute max dollars per trade |
| Min Trade | $1 | Trades below $1 are skipped |
| Max Daily Loss | $70,000 | Halts trading for 24h if hit |
| Max Drawdown | 15% | 1-hour cooldown if peak-to-trough exceeds limit |
| Spread Filter | 15% | Skip trade if order book spread > 15% |
| Flip Hysteresis | 6% EV | Minimum EV gain required to flip direction |
| Flip Min Hold | 2 min | No flip until position is 2 minutes old |
| Paper Trading | true | Simulated trades — set false for live money |

---

## File Structure

```
src/
├── index.js                    Express server, trust proxy, auto-restart bots
├── bot/
│   ├── BotManager.js           Manages bot instances per user (Map)
│   ├── BotInstance.js          Main trading loop, Kelly sizing, EV exits, flips
│   ├── GBMSignalEngine.js      3-gate signal pipeline (pre-filters → G1 → G2 → G3)
│   ├── EVEngine.js             EV calc, trend tracking, flip evaluation
│   ├── MicrostructureEngine.js Order book imbalance, whale detection, lag score
│   ├── PolymarketFeed.js       CLOB client v5.8.1, market discovery, order book, execution
│   ├── BinanceFeed.js          BTC WebSocket price + history + delta score
│   ├── ChainlinkFeed.js        On-chain BTC/USD oracle (Ethereum, 30s poll)
│   └── CopyBotInstance.js      Copy trading — mirrors whale wallet trades
├── routes/
│   ├── auth.js                 JWT login / register / refresh token rotation
│   ├── bot.js                  Start/stop/status/trades/signals/gate-stats
│   ├── user.js                 Settings CRUD, balance, paper reset (syncs in-memory)
│   ├── claude.js               AI analysis trigger, history, latest-feedback
│   ├── copy.js                 Copy targets management
│   ├── trades.js               Trade history + stats (Sharpe, drawdown, etc.)
│   └── admin.js                Admin panel
├── middleware/
│   └── auth.js                 JWT authMiddleware (req.userId)
├── models/
│   └── db.js                   PostgreSQL pool + schema init + safe ALTER migrations
└── services/
    └── encryption.js           AES-256-GCM for private key / API key storage

public/
├── index.html                  Full frontend — AXIOM terminal (JetBrains Mono, amber/carbon)
│                               Embedded login overlay, no separate login.html needed
└── market-feed.js              Browser script — live Polymarket price feed
                                Auto-discovers 5-min BTC market slug, parallel CLOB price fetch,
                                getLivePrice() always fresh, executeTrade() aborts on stale price
```

---

## Database Schema

```sql
users               email, password_hash, role
bot_settings        all trading parameters, encrypted keys, balances, gate thresholds
trades              open/closed positions: token_id, entry/exit prices, PnL, gate scores
signals             every evaluate() call: verdict, gate pass/fail, EV, lag, spread
bot_decisions       signal engine decision log with full gate breakdown
bot_logs            per-bot INFO/WARN/ERROR log stream
copy_targets        whale wallets to mirror with per-target size multiplier
refresh_tokens      JWT refresh token rotation (7-day expiry)
claude_analyses     stored AI analysis history with trade_count and PnL snapshot
```

---

## Environment Variables (Railway)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | Link to Railway Postgres service (not copy-paste) |
| `JWT_SECRET` | Yes | 32+ char random string |
| `ENCRYPTION_KEY` | Yes | 32-byte hex for AES-256 |
| `NODE_ENV` | Yes | `production` |
| `FRONTEND_URL` | Yes | Exact frontend origin, no trailing slash |
| `DB_SSL_REJECT_UNAUTHORIZED` | No | Defaults `false` (Railway self-signed cert) |
| `POLYGON_RPC_URL` | No | Custom Polygon RPC for USDC balance |
| `ETH_RPC_URL` | No | Custom Ethereum RPC for Chainlink |

---

## Critical Rules

1. **Token price (0–1) ≠ BTC price (~$90k)** — Kelly, EV, MicrostructureEngine all work in 0–1 space
2. **Never call `placeOrder()` when `paperTrading === true`**
3. **Always `parseFloat()` PostgreSQL DECIMAL columns** — Postgres returns them as strings
4. **`bot.stop(preserveActive=true)` on graceful shutdown** — keeps `is_active=true` for auto-restart
5. **`clobTokenIds` from Gamma API is a JSON string** — always `JSON.parse()` if `typeof === 'string'`
6. **`btcDelta` is already in %** — multiply by `0.5` for edge (not `* 0.5 / 100`)
7. **Entry price = real ASK from order book** — never use Gamma mid or signal.entryPrice for execution
8. **CLOB SDK v5.8.1**: method is `createAndPostOrder`, field is `tokenID` (capital), size is token qty not dollars

---

## Known Bug History

| Bug | Root Cause | Fix |
|---|---|---|
| All signals SKIP (G1) | Chainlink oracle used for freshness check (updates every 5-30min) | Use Binance WebSocket last tick timestamp |
| All signals SKIP (token `[`) | `clobTokenIds` is JSON string, `string[0] = '['` | `JSON.parse()` before indexing |
| All signals SKIP (no markets) | CLOB `getMarkets()` only returns 2023 historical data | Gamma slug lookup `btc-updown-5m-<ts>` |
| Gate 3 always fails | `minEdge / 100` made threshold 0.05% instead of 5% | Compare `emaEdge < minEdge` directly |
| EV always near zero | `btcEdge = btcDelta * 0.05` — wrong scale | `btcEdge = btcDelta * 0.5` |
| Kelly = 0 always | `prob = entryPrice` → circular → no edge | Use `modelProb` from signal engine |
| $6.33M phantom PnL | Corrupted test trades | Filter `WHERE ABS(pnl) < 100000` |
| Win rate 0% | Exits wrote `result='CLOSED'`, stats counted `result='WIN'` | Standardised to `WIN`/`LOSS` |
| Emergency close storm | Old trades had no `token_id` → price fetch failed → loop | Auto-close legacy trades on startup |
| Login 500 error | `role` column missing from production DB | `ALTER TABLE users ADD COLUMN IF NOT EXISTS role` |
| `createAndPlaceOrder is not a function` | SDK v5 renamed method + walletAddress passed as signatureType (5th param) broke auth silently | Use `createAndPostOrder`; constructor: `(host, chainId, key, undefined, 0, walletAddress)` |
| Phantom $90k P&L on $1000 balance | Paper entry used Gamma mid (~0.505), resolved at 0.99 → fake win; Kelly then sized at inflated balance | Real ASK price at execution + $5 hard cap |
| Paper balance reset not sticking | `UPDATE bot_settings` updates DB but running bot holds old in-memory value | `reset-paper-balance` route now also sets `bot.paperBalance = 10000` directly |
| Tokens show `outcome="undefined"` | Gamma `/markets/slug/` response omits `outcome` field on token objects | Use `clobTokenIds[0/1]` for token IDs, not `tokens[].token_id` |
