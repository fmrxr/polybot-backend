# PolyBot — BTC 5-Minute Trading Bot for Polymarket

A production-ready automated trading bot for Polymarket that executes BTC directional predictions on 5-minute windows. Features GBM signal engine, copy trading, stop-loss/take-profit management, and multi-user support with admin oversight.

**Live:** [magnificent-prosperity-production.up.railway.app](https://magnificent-prosperity-production.up.railway.app)

---

## 🎯 Features

### **GBM Signal Engine** (Predictive Trading)
- 7-weighted-indicator composite signal
- Window delta dominance (5–7x weight) — answers "is BTC up or down vs window open?"
- Micro momentum, acceleration, EMA 9/21, RSI 14, volume surge, tick trend
- Confidence threshold gating (configurable per user)
- Entry price estimation ($0.50–$0.92 based on signal strength)
- Kelly Criterion position sizing with configurable cap

### **Copy Trading** (Mirror Top Traders)
- Real-time polling of target wallets every 30 seconds
- Automatic trade mirroring with configurable multipliers (0.1x–5.0x)
- Slippage protection (5% max deviation)
- Per-trade size limits and 5-share minimum enforcement
- Paper + Live trading modes
- Full attribution tracking (see which trader was copied)

### **Stop-Loss & Take-Profit** (Risk Management)
- Automatic position exits every 10 seconds
- **Take-profit at +30%** — lock in gains early
- **Stop-loss at -5%** — cut losses quickly
- Exit reason tracking (auto_closed_profit, auto_closed_loss, resolved)
- Performance analytics by exit type

### **Admin Panel** (Platform Oversight)
- Real-time platform analytics (users, bots, P&L, win rates)
- User management dashboard with individual bot controls
- Trade monitoring across all users
- Audit log of admin actions
- Visible only to admin users (role-based access)

### **Per-User Settings**
- Polymarket wallet address configuration
- Private key encryption (AES-256-GCM)
- Paper vs. Live trading mode toggle
- Kelly cap, max daily loss, max trade size
- Signal thresholds (min confidence, min prob diff)
- Market probability filters (sweet spot targeting)
- Direction filter (UP/DOWN/BOTH)

---

## 🏗️ Architecture

### **System Overview**

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (SPA)                           │
│                  (public/index.html + CSS + JS)                  │
│  Dashboard│Signals│Trades│Copy Bot│Settings│Admin Panel          │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTP/REST
┌──────────────────────────────▼──────────────────────────────────┐
│                    Express.js Backend (Port 3001)               │
├──────────────────────────────────────────────────────────────────┤
│  Routes:  /api/auth   /api/bot   /api/trades   /api/user         │
│           /api/admin  /api/copy                                  │
├──────────────────────────────────────────────────────────────────┤
│  Global BotManager                                               │
│  ├── instances Map<userId, BotInstance>        [GBM Bots]        │
│  └── copyInstances Map<userId, CopyBotInstance> [Copy Bots]      │
└──────────┬────────────────────────────────────────────────────┬──┘
           │                                                    │
    ┌──────▼────────┐                                   ┌──────▼────────┐
    │  BotInstance  │                                   │ CopyBotInstance│
    ├───────────────┤                                   ├────────────────┤
    │ Snipe Loop    │                                   │ Poll Loop      │
    │ (10s before)  │                                   │ (every 30s)    │
    │               │                                   │                │
    │ 1. GBM Signal │                                   │ 1. Fetch       │
    │ 2. Execute    │                                   │ 2. Mirror      │
    │ 3. Manage     │                                   │ 3. Track       │
    │ 4. Resolve    │                                   │                │
    └──────┬────────┘                                   └────────────────┘
           │
    ┌──────▼─────────────────────────┐
    │  External Data Feeds            │
    ├─────────────────────────────────┤
    │ Binance WebSocket (BTC prices)  │
    │ Chainlink RPC (BTC oracle)      │
    │ Polymarket Gamma API (markets)  │
    │ Polymarket CLOB API (orders)    │
    └─────────────────────────────────┘

Database: PostgreSQL
├── users (auth)
├── bot_settings (per-user config)
├── trades (order history + P&L)
├── bot_decisions (signal log)
├── bot_logs (execution logs)
├── copy_targets (followed wallets)
├── copy_target_state (last-seen trade)
├── admin_logs (audit trail)
└── (auto-created indexes on frequently queried columns)
```

### **Trade Execution Flow**

#### **GBM Bot (Every 5-Minute Window)**
```
T-300s: New window opens
  ↓
T-10s: Bot enters snipe loop
  ├─→ Poll every 2s for 8 seconds
  │   ├─ GBMSignalEngine.evaluate()
  │   │   └─ 7 indicators → composite score
  │   ├─ Check daily P&L limit
  │   └─ If signal + limits OK → execute
  │
T-5s: Hard deadline
  ├─→ If no signal yet, use _fallbackSignal()
  │   └─ Requires 0.05% minimum window movement
  │
T-0s: Window closes
  ├─→ Market resolution begins
  ├─→ Orders settle on Polymarket
  │
T+30s-300s: Position management
  ├─→ _manageOpenPositions() runs every 10s
  │   ├─ Check unrealized P&L
  │   ├─ Exit if +30% gain (take profit)
  │   ├─ Exit if -5% loss (stop loss)
  │   └─ Update DB with exit reason
  │
T+30s-300s: Resolution check
  ├─→ _checkResolutions() runs every 30s
  │   ├─ Query Polymarket market outcome
  │   ├─ Calculate final P&L
  │   └─ Update DB with result (WIN/LOSS)
```

#### **Copy Bot (Continuous, Every 30 Seconds)**
```
While running:
  ├─→ For each active target wallet:
  │   ├─ GET https://clob.polymarket.com/data/trades?maker_address=0x...
  │   ├─ Filter trades newer than last_trade_ts
  │   │   
  │   ├─→ For each new trade:
  │   │   ├─ Fetch market details (conditionId → tokens)
  │   │   ├─ Determine direction (UP if YES token, DOWN if NO)
  │   │   ├─ Fetch live price: GET /price?token_id=...
  │   │   ├─ Slippage check (reject if >5% worse)
  │   │   ├─ Calculate size: multiplier × source_size (capped)
  │   │   ├─ Enforce 5-share minimum
  │   │   ├─ Place order or paper record
  │   │   └─ Log with copy_source attribution
  │   │
  │   └─ UPDATE copy_target_state with latest_trade_ts
```

---

## 📁 Repository Layout

```
polybot-backend/
├── src/
│   ├── index.js                     # Server entry point, BotManager init
│   ├── services/
│   │   └── encryption.js            # AES-256-GCM for private key storage
│   ├── models/
│   │   └── db.js                    # PostgreSQL schema + migrations
│   ├── middleware/
│   │   └── auth.js                  # JWT + admin role checks
│   ├── routes/
│   │   ├── auth.js                  # POST /register, /login
│   │   ├── bot.js                   # POST /start, /stop, GET /status
│   │   ├── trades.js                # GET /trades, /breakdown, /curve
│   │   ├── user.js                  # GET/PUT user settings
│   │   ├── admin.js                 # GET /users, /analytics, /toggle-bot
│   │   └── copy.js                  # POST /targets, /start, GET /status
│   └── bot/
│       ├── BotManager.js            # Global bot coordinator
│       ├── BotInstance.js           # GBM bot (snipe loop, resolutions)
│       ├── CopyBotInstance.js       # Copy bot (polling, mirroring)
│       ├── GBMSignalEngine.js       # 7-indicator signal composite
│       ├── BinanceFeed.js           # Binance WebSocket (BTC OHLCV)
│       ├── ChainlinkFeed.js         # Chainlink oracle price + age
│       └── PolymarketFeed.js        # Polymarket CLOB client
│
├── public/
│   └── index.html                   # SPA (inline CSS + JS)
│       ├── Auth pages (login/register)
│       ├── Dashboard (stats, controls, chart)
│       ├── Signal Monitor (7 indicators live)
│       ├── Trades (history, breakdown by direction/prob)
│       ├── Copy Bot (targets, copied trades)
│       ├── Settings (wallet, keys, thresholds)
│       └── Admin Panel (users, analytics, trades, audit log)
│
├── package.json                     # Dependencies
├── .env.example                     # Environment template
├── README.md                        # This file
└── .gitignore
```

### **Key Files Deep Dive**

| File | Purpose | Key Functions |
|------|---------|---|
| `BotInstance.js` | GBM bot core | `start()`, `_tick()`, `_snipeWindow()`, `_executeTrade()`, `_manageOpenPositions()`, `_checkResolutions()` |
| `CopyBotInstance.js` | Copy bot core | `start()`, `_pollTargets()`, `_mirrorTrade()`, `_fetchLivePrice()` |
| `GBMSignalEngine.js` | Signal logic | `evaluate()` (7 indicators), `_estimateTokenPrice()`, `_ema()`, `_rsi()` |
| `PolymarketFeed.js` | Polymarket API | `init()`, `placeOrder()`, `getOrderStatus()`, `checkResolution()`, `fetchActiveBTCMarkets()` |
| `db.js` | PostgreSQL schema | `initDB()`, `addDecisionsTable()`, `addCopyTradingSchema()` |
| `index.html` | Frontend SPA | All UI + JS logic, tab routing, API calls |

---

## 🚀 Installation & Setup

### **Prerequisites**
- Node.js 18+ (Nixpacks uses 18, but @polymarket/clob-client recommends 20+)
- PostgreSQL 12+
- npm or yarn

### **Local Development**

1. **Clone & install:**
   ```bash
   git clone https://github.com/fmrxr/polybot-backend.git
   cd polybot-backend
   npm install
   ```

2. **Create `.env` file:**
   ```bash
   cp .env.example .env
   ```

3. **Configure environment (see Configuration below)**

4. **Start local PostgreSQL** (Docker recommended):
   ```bash
   docker run --name polybot-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=polybot -p 5432:5432 -d postgres:15
   ```

5. **Run server:**
   ```bash
   npm start
   ```
   Server runs on `http://localhost:3001`

### **Production (Railway)**

1. **Create Railway project** at [railway.app](https://railway.app)

2. **Add PostgreSQL plugin** (Railway auto-generates `DATABASE_URL`)

3. **Set environment variables** in Railway dashboard:
   ```
   JWT_SECRET=<your-secret-32-chars>
   ENCRYPTION_KEY=<32-char-hex-key-for-aes256>
   NODE_ENV=production
   ```

4. **Deploy:**
   ```bash
   git push  # Pushes to Railway (configured via Railway CLI)
   ```

5. **Monitor logs:**
   ```bash
   railway logs
   ```

---

## ⚙️ Configuration

### **Environment Variables**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `JWT_SECRET` | ✅ | — | Secret for JWT signing (min 32 chars) |
| `ENCRYPTION_KEY` | ✅ | — | 32-char hex key for AES-256-GCM |
| `PORT` | ❌ | 3001 | Express server port |
| `NODE_ENV` | ❌ | development | Environment (development/production) |

### **User Settings (Per-User Config)**

Each user configures via `/api/user/settings`:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `polymarket_wallet_address` | string | — | Proxy wallet address (0x...) |
| `private_key` | string (encrypted) | — | Exported private key (0x...) |
| `kelly_cap` | decimal | 0.25 | Position size cap (0–1) |
| `max_daily_loss` | decimal | 50.0 | Daily loss limit ($) |
| `max_trade_size` | decimal | 20.0 | Max per-trade size ($) |
| `min_ev_threshold` | decimal | 0.12 | Confidence minimum (0–1) |
| `min_prob_diff` | decimal | 0.08 | Market edge required (%) |
| `direction_filter` | enum | 'BOTH' | Trade UP/DOWN/BOTH |
| `market_prob_min` | decimal | 0.40 | Min market probability |
| `market_prob_max` | decimal | 0.60 | Max market probability |
| `paper_trading` | boolean | true | Paper mode (true) or Live (false) |

---

## 📡 API Documentation

### **Authentication**

**POST `/api/auth/register`**
```json
{
  "email": "user@example.com",
  "password": "min8chars"
}
Response: { token, user: { id, email, is_admin } }
```

**POST `/api/auth/login`**
```json
{
  "email": "user@example.com",
  "password": "password"
}
Response: { token, user: { id, email, is_admin } }
```

All other endpoints require: `Authorization: Bearer <token>`

### **Bot Control**

**POST `/api/bot/start`** — Start GBM bot
```json
Response: { success: true }
```

**POST `/api/bot/stop`** — Stop GBM bot
```json
Response: { success: true }
```

**GET `/api/bot/status`** — Current bot status
```json
Response: {
  is_running: true,
  open_trades: 2,
  paper_trading: true,
  daily_pnl: 15.50,
  market_data: { price, vwap, volatility, ... }
}
```

**GET `/api/bot/logs?limit=50`** — Recent bot logs
```json
Response: { logs: [{ level, message, created_at }, ...] }
```

### **Trades**

**GET `/api/trades?page=1&limit=50`** — Paginated trade history
```json
Response: {
  trades: [{ id, direction, entry_price, size, result, pnl, ... }],
  total, page, pages
}
```

**GET `/api/trades/breakdown`** — Performance by direction & probability
```json
Response: {
  by_direction: [{ direction, trades, win_rate, pnl }, ...],
  by_prob: [{ prob_range, trades, win_rate, pnl }, ...],
  by_exit_reason: [{ exit_reason, count, avg_pnl }, ...]
}
```

**GET `/api/trades/curve`** — Cumulative P&L for chart
```json
Response: [{ id, created_at, pnl, cumulative_pnl }, ...]
```

### **User Settings**

**GET `/api/user/settings`** — Current user settings
```json
Response: {
  user_id, polymarket_wallet_address, kelly_cap, max_daily_loss, ...,
  has_private_key: true, has_polymarket_api_key: false
}
```

**PUT `/api/user/settings`** — Update settings
```json
{
  "polymarket_wallet_address": "0x...",
  "private_key": "0x...",
  "kelly_cap": 0.25,
  "paper_trading": true
}
Response: { success: true }
```

**GET `/api/user/dashboard`** — Dashboard stats
```json
Response: {
  polymarket_balance: 150.50,
  wallet_address: "0x...",
  total_pnl: 42.10,
  win_rate: 55.5,
  total_trades: 20,
  roi: 8.4,
  ...
}
```

### **Copy Trading**

**POST `/api/copy/targets`** — Add target wallet
```json
{
  "target_address": "0x...",
  "label": "Top Whale",
  "multiplier": 1.0,
  "max_trade_size": 20
}
Response: { id, target_address, label, ... }
```

**GET `/api/copy/targets`** — List targets
```json
Response: { targets: [{ id, target_address, label, multiplier, is_active }, ...] }
```

**PATCH `/api/copy/targets/:id`** — Update target
```json
{
  "multiplier": 0.5,
  "max_trade_size": 15,
  "is_active": true
}
```

**DELETE `/api/copy/targets/:id`** — Remove target
```json
Response: { success: true }
```

**POST `/api/copy/start`** — Start copy bot
**POST `/api/copy/stop`** — Stop copy bot
**GET `/api/copy/status`** — Copy bot status
**GET `/api/copy/trades?limit=20`** — Copied trades

### **Admin**

**GET `/api/admin/analytics`** — Platform stats
```json
Response: {
  total_users: 42,
  active_bots: 18,
  total_pnl: 1250.50,
  platform_win_rate: 52.3,
  trades_24h: 450,
  pnl_24h: 180.25
}
```

**GET `/api/admin/users`** — All users with stats
**GET `/api/admin/users/:id`** — Single user detail
**POST `/api/admin/users/:id/toggle-bot`** — Start/stop user's bot
**GET `/api/admin/trades?page=1&limit=50`** — All trades (paginated)
**GET `/api/admin/logs?limit=50`** — Admin audit log

---

## 🤖 Trading Strategies

### **GBM Signal Engine**

**7 Weighted Indicators:**
1. **Window Delta** (weight 5–7) — `(price - windowOpenPrice) / windowOpenPrice`
   - Dominant signal; uses Chainlink as ground truth
   - Tier thresholds: >0.10% → 7x, >0.02% → 5x, >0.005% → 3x, >0.001% → 1x

2. **Micro Momentum** (weight 2) — Direction consistency of last 3 prices
   - Uptrend (last > prev > prev2) → +2
   - Downtrend → -2
   - Weak trend → ±0.5

3. **Acceleration** (weight 1.5) — Is momentum building or fading?
   - Accelerating → ±1.5, decelerating → ±0.5

4. **EMA 9/21** (weight 1) — Short-term trend
   - EMA9 > EMA21 → +1, else → -1

5. **RSI 14** (weight 1–2) — Only extreme zones
   - RSI > 75 (overbought) → -2
   - RSI < 25 (oversold) → +2
   - Neutral (25–75) → 0

6. **Volume Surge** (weight 1) — Volume confirms direction
   - Recent avg > prior avg × 1.5 → ±1

7. **Tick Trend** (weight 2) — Real-time micro-trend
   - Last 10 ticks 60%+ consistent → ±2

**Signal Gating:**
- Minimum score: `|score| >= 3` (eliminates weak signals)
- Minimum confidence: configurable (default 0.30)
- Early window skip: first 60 seconds (let delta form)
- Fallback fallback: requires 0.05% minimum movement

**Position Sizing (Kelly Criterion):**
```
prob = entry_price (token price IS implied win %)
b = (1 / entry_price) - 1
kelly_fraction = max(0, (prob × b - (1-prob)) / b)
size = min(kelly_fraction × kelly_cap × max_trade_size, max_trade_size)
```

### **Copy Trading**

**Workflow:**
1. Poll target wallet via CLOB API every 30s
2. Detect new trades (newer than `last_trade_ts`)
3. Mirror with:
   - Same direction (UP/DOWN from token outcome)
   - Adjusted size: `target.multiplier × source_size` (capped at `max_trade_size`)
   - Slippage check: reject if live price >5% worse than target's entry
   - Min 5 shares enforcement
4. Record with `trade_type='copy'` and `copy_source=address`

**Best Practices:**
- Only copy wallets with >55% win rate (check Predictfolio)
- Use 0.5x–1.0x multiplier for risk management
- Monitor `/api/copy/trades` to see profitability

### **Stop-Loss / Take-Profit**

**Automatic Position Management:**
- Runs every 10 seconds (parallel to resolution checks)
- Calculates unrealized P&L: `shares × (market_price - entry_price) - (fees ~2%)`
- **Exit at +30%** → `take profit, exit_reason='auto_closed_profit'`
- **Exit at -5%** → `stop loss, exit_reason='auto_closed_loss'`
- Updates DB with exit reason for analytics

**Tuning:**
- More aggressive: `+15% profit / -2% stop`
- More conservative: `+50% profit / -10% stop`
- Edit in `BotInstance.js` line 494-495

---

## 🛡️ Admin Panel

**Accessible only to:** Users with `is_admin=true` (seeded: `mereeffet@gmail.com`)

**Sections:**

1. **Platform Analytics Card**
   - Total users, active bots, total P&L, 24h trades, platform win rate

2. **All Users Table**
   - Email, trade count, total P&L, win%, bot status, mode, wallet
   - Action: Start/Stop any user's bot (logs to audit trail)

3. **Platform Trades Table**
   - Last 50 trades from all users
   - Shows user attribution, direction, entry, size, result, P&L

4. **Audit Log Table**
   - Admin actions (BOT_START, BOT_STOP)
   - Admin email, target user, details, timestamp

---

## 🔐 Security

- **Private Keys:** Encrypted at rest with AES-256-GCM
- **API Keys:** Encrypted storage, never logged
- **Passwords:** Hashed with bcrypt (12 rounds)
- **JWT:** 7-day expiration, signed with `JWT_SECRET`
- **HTTPS:** Forced on Railway (not required for localhost)
- **CORS:** Whitelisted origins (Railway, Netlify, Vercel, localhost)
- **Admin Middleware:** Checks `is_admin` before sensitive operations

---

## 📊 Database Schema

### **users**
```sql
id, email (unique), password_hash, is_admin, created_at
```

### **bot_settings**
```sql
user_id (FK, unique), encrypted_private_key, encrypted_polymarket_api_key,
polymarket_wallet_address, kelly_cap, max_daily_loss, max_trade_size,
min_ev_threshold, min_prob_diff, direction_filter, market_prob_min,
market_prob_max, is_active, paper_trading, updated_at
```

### **trades**
```sql
id, user_id (FK), condition_id, direction, entry_price, size,
model_prob, market_prob, expected_value, result, pnl, fee,
paper, order_id, order_status, trade_type (gbm|copy), copy_source,
exit_reason (auto_closed_profit|auto_closed_loss|resolved),
window_ts, resolved_at, created_at
Indexes: user_id, created_at
```

### **bot_decisions**
```sql
id, user_id (FK), verdict, direction, reason, data (JSONB),
created_at
```

### **bot_logs**
```sql
id, user_id (FK), level, message, created_at
```

### **copy_targets**
```sql
id, user_id (FK), target_address (0x...), label, is_active,
multiplier, max_trade_size, created_at
Unique: (user_id, target_address)
```

### **copy_target_state**
```sql
target_address (PK), last_trade_ts, last_checked_at
```

### **admin_logs**
```sql
id, admin_id (FK), action, target_user_id, details, created_at
Index: created_at
```

---

## 🧪 Development

### **Running Tests** (Coming soon)
```bash
npm test
```

### **Code Structure**
- Backend uses callback-based async (async/await for async operations)
- Frontend is vanilla JS (no frameworks) for minimal dependencies
- Single HTML file SPA with inline CSS + JS
- Express middleware pattern for auth + admin checks

### **Logging**
- Server logs to console (stdout)
- Bot logs to `bot_logs` table + console
- Admin actions logged to `admin_logs` table

### **Git Workflow**
```bash
git checkout -b feature/xyz
# Make changes
git add .
git commit -m "Description..."
git push origin feature/xyz
# Create PR on GitHub
```

---

## 📈 Performance & Scalability

| Metric | Value | Notes |
|--------|-------|-------|
| Bot polling | Every 1–2s | GBM snipe loop |
| Copy polling | Every 30s | Copy target polling |
| Position mgmt | Every 10s | Exit check interval |
| Resolution check | Every 30s | Market outcome query |
| Max users per instance | Unlimited | Each bot runs independently |
| DB connection pool | 10 | Configurable in pg Pool |

---

## 🐛 Troubleshooting

### **Bot not trading**
- Check bot is started (`GET /api/bot/status`)
- Verify settings configured (`wallet_address`, `private_key`)
- Check signal logs (`GET /api/bot/logs`)
- Confirm live mode (`paper_trading=false`) or paper trades allowed

### **Orders failing**
- Verify wallet has USDC balance
- Check slippage (especially for copy trades)
- Confirm min 5 shares enforcement
- Review order logs in bot_logs table

### **Low win rate**
- Check GBM thresholds (default: score >= 3)
- Consider adjusting Kelly cap (more conservative: 0.15)
- Monitor exit strategies (take-profit too early?)
- Compare to market baseline

---

## 📝 License

MIT License — See LICENSE file for details

---

## 🙏 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-feature`
3. Commit changes: `git commit -am 'Add new feature'`
4. Push branch: `git push origin feature/new-feature`
5. Submit a pull request

---

## 📞 Support

- **Issues:** GitHub Issues
- **Questions:** GitHub Discussions (coming soon)
- **Email:** Support contact (TBD)

---

## 🚀 Roadmap

- [ ] Backtesting framework
- [ ] Performance dashboard with Sharpe ratio, Sortino ratio
- [ ] Machine learning signal ensemble
- [ ] Real arbitrage bot (YES + NO < 0.97)
- [ ] Multi-timeframe trading (1-min, 15-min windows)
- [ ] Risk parity across multiple markets
- [ ] WebSocket live order updates
- [ ] Email/Slack notifications on major events
- [ ] API rate limiting & authentication tokens

---

**Last Updated:** April 2026
**Maintained By:** PolyBot Team
