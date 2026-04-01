# PolyBot User Guide — Complete Operation Manual

## Table of Contents
1. [Getting Started](#getting-started)
2. [Dashboard Overview](#dashboard-overview)
3. [Signal Monitor](#signal-monitor)
4. [Trade History](#trade-history)
5. [Settings & Configuration](#settings--configuration)
6. [Paper Trading](#paper-trading)
7. [Live Trading](#live-trading)
8. [Understanding the Three-Gate Logic](#understanding-the-three-gate-logic)
9. [Metrics & Interpretation](#metrics--interpretation)
10. [Copy Trading](#copy-trading)
11. [FAQ & Troubleshooting](#faq--troubleshooting)

---

## Getting Started

### 1. Login / Registration

**First Time?**
1. Click **Sign Up** on the login page
2. Enter your email and create a password
3. You'll be taken to the dashboard

**Returning User?**
1. Enter your email and password
2. Click **Sign In**

### 2. Initial Setup

**Required:**
- [ ] Polymarket wallet address (for trading)
- [ ] Private key or API credentials (encrypted storage)
- [ ] Initial capital allocation

**Optional:**
- [ ] Chainlink RPC endpoint (for price feeds)
- [ ] Copy targets (if you want to mirror trades from other traders)

### 3. Connect Your Wallet

**In Settings tab → Wallet Settings:**
1. Enter your **Polymarket wallet address** (0x...)
2. Upload encrypted private key (or paste private key — will be encrypted before storage)
3. Click **Save**

The bot will:
- Derive L2 (Layer 2) API credentials automatically
- Connect to Polymarket CLOB (Central Limit Order Book)
- Start monitoring BTC markets

---

## Dashboard Overview

**Three Main Sections:**

### Top Status Bar
```
🟢 BOT: RUNNING | Paper Balance: $10,000 | Mode: PAPER TRADING | 
Last Trade: 5 min ago | Open Positions: 2
```

- **Status:** RUNNING (green), STOPPED (red), DRY-RUN (yellow)
- **Balance:** Current paper or live balance
- **Mode:** PAPER (practice) vs LIVE (real money)
- **Open Positions:** Number of active trades

### Start / Stop Button

**When Stopped:**
- Click **START BOT** to begin trading
- Bot will connect to Polymarket and Binance
- Will wait for next 5-minute window to begin

**When Running:**
- Click **STOP BOT** to halt trading
- Closes monitoring loop but keeps open positions
- Settings remain saved

### Navigation Tabs

1. **Dashboard** — Overview, recent trades, connection status
2. **Signal Monitor** — Real-time signals, gate-by-gate decisions
3. **Trade History** — All executed trades, P&L analysis
4. **Copy Targets** — Mirror trades from other traders
5. **Settings** — Configuration, risk management
6. **Admin** (if applicable) — System logs, debugging

---

## Signal Monitor

**This is where you see EVERYTHING the bot thinks in real-time.**

### Live Market Data Card

Shows current BTC prices from multiple sources:

```
┌─ Live Market Data ─────────────────────┐
│ BTC / Binance:      $93,420.50         │
│ BTC / Chainlink:    $93,418.20         │
│ Binance vs CL:      +$2.30 (+0.002%)   │
│ Volatility:         1.2%               │
│ OB Imbalance:       +0.15 (buying)     │
│ Open Trades:        2                  │
│ Paper Balance:      $9,850.30          │
└────────────────────────────────────────┘
```

**What It Means:**
- **Binance vs Chainlink spread:** If gap is large, prices are diverging (possible latency)
- **Volatility:** Market movement speed (high = risky, low = stable)
- **OB Imbalance:** Order book bias (-1 = sell pressure, +1 = buy pressure)

---

### Phase A Metrics Dashboard (Critical — Watch These)

Shows the three key metrics for **dry-run validation:**

```
┌─ Phase A Dry-Run Metrics ──────────────────────────────────┐
│                                                             │
│  Skip Rate         Avg EV_adj        Market Lag Freq       │
│  ██████████ 87%    ███████ 5.2%      ████ 15%             │
│  Target ≥85% ✓     Target 3-10% ✓    Target 10-20% ✓      │
│                                                             │
│  Gate Failure Breakdown:                                   │
│  G1: 12% | G1.5: 23% | G2: 8% | G2.5: 2% | G3: 3% | PASS: 52%
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Interpret These:**

| Metric | Target | Status | Meaning |
|--------|--------|--------|---------|
| **Skip Rate** | ≥85% | 🟢 87% | Bot filtering correctly (rejecting weak signals) |
| **Skip Rate** | <75% | 🔴 70% | Gates too loose; trading too much noise |
| **EV_adj Avg** | 3-10% | 🟢 5.2% | Good edge quality; solid cost-adjusted profit |
| **EV_adj Avg** | <3% | 🔴 1.8% | Bad filtering; executing marginal trades |
| **Market Lag** | 10-20% | 🟢 15% | Real latency being detected; edge working |
| **Market Lag** | <5% | 🔴 2% | No latency detected; not trading the real edge |

**Gate Breakdown:**
- **G1 (Microstructure confidence):** If high %, edge signals but confidence too low
- **G1.5 (Market lag):** Should be significant; if zero, latency signal broken
- **G2 (EV cost):** Should be low; high % means prices too wide/slippage too high
- **G2.5 (EV hard floor):** Should be low; high % means edge barely positive
- **G3 (EMA confirmation):** Should be lowest; weak filter, mostly passes
- **PASS:** All gates passed → trades executed

---

### Signal Decisions Card

**Real-time decision log.** Each row = one signal evaluation.

```
┌─ Signal Decisions ────────────────────────────────────────────────┐
│ TRADE  ⚙ 3-Gate ✓ | Micro: 65% ✓ Lag: Yes ✓ | EV: 6.2% ✓ EMA: ✓ │
│        BTC $93,420 | Open $93,408 | Δ +0.013% | Score: 4.2      │
│        14:32:45                                                   │
│                                                                   │
│ SKIP   Gate 1.5 ✗  | Micro: 52% ✗ Lag: No ✗ | Gap too narrow   │
│        BTC $93,418 | Open $93,408 | Δ +0.011% | Score: 2.1      │
│        14:31:03                                                   │
│                                                                   │
│ TRADE  ⚙ 3-Gate ✓ | Micro: 71% ✓ Lag: Yes ✓ | EV: 7.1% ✓ EMA: ✓ │
│        BTC $93,412 | Open $93,408 | Δ +0.004% | Score: 3.8      │
│        14:29:18                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

**Reading the Signal Log:**

**TRADE Verdict (Green)**
- ✅ All 3 gates passed
- Bot is **executing** this trade
- Shows: microstructure confidence, EV adjusted, EMA alignment

**SKIP Verdict (Red)**
- ❌ Failed at least one gate
- Bot **rejected** this signal
- Shows: which gate failed and why
  - "Gate 1: Confidence too low"
  - "Gate 1.5: No market lag"
  - "Gate 2: EV < 3%"
  - "Gate 2.5: EV_adj below hard floor"
  - "Gate 3: EMA misaligned"

**WAIT Verdict (Blue)**
- ⏳ Signal building but not yet ready
- Rare; usually means timing window passed

**Chips (Data Points):**
- **BTC:** Current Binance price
- **Open:** Window open price (5-min reference)
- **Δ:** Window % change (price move since window started)
- **Score:** Composite signal strength (higher = stronger)
- **RSI:** Relative Strength Index (0-100; extreme moves interesting)

---

## Trade History

**View all trades executed by the bot.**

### Live Trades (Last 24 Hours)

```
┌─ Trade Card ──────────────────────┐
│ ▲ UP | 14:32 (23 sec ago)         │
├───────────────────────────────────┤
│ Direction:      UP                │
│ Entry Price:    $0.652            │
│ Size:           $50.00            │
│ Market Prob:    65%               │
│ Micro Conf:     71%               │
│ EV Adjusted:    6.2%              │
│ Status:         ⏳ OPEN (12 sec)   │
└───────────────────────────────────┘
```

**Status Meanings:**
- **OPEN:** Trade still active, waiting for TP or SL
- **OPEN (23 sec):** Time since entry
- **WIN:** Trade closed at profit
- **LOSS:** Trade closed at loss

### Trade Details Table

Scrollable table with:

| Field | Meaning |
|-------|---------|
| **Time** | When trade entered |
| **Dir** | UP or DOWN direction |
| **Entry** | Token price at entry |
| **Size** | Trade size in dollars |
| **Market %** | Market probability (50-95%) |
| **Model %** | Bot's model probability |
| **Edge %** | modelProb - marketProb |
| **P&L** | Profit/loss (if closed) |
| **Status** | OPEN / WIN / LOSS |

**Click row to expand:**
- Full gate data (micro confidence, EV_adj, EMA score)
- Exit price and reason (TP/SL/timeout)
- Hold time
- Detailed risk analysis

### Pro Metrics (Summary Statistics)

Automatically calculated from trade history:

```
┌─ Win Rate ─┬─ Sharpe Ratio ─┬─ Max Drawdown ─┬─ Profit Factor ─┐
│    68%     │      1.8       │      8.2%      │       2.3:1     │
└────────────┴────────────────┴────────────────┴─────────────────┘

Avg Win:       $3.42
Avg Loss:      $1.85
Best Trade:    +$12.50
Worst Trade:   -$8.20
Current Streak: +5 (wins in a row)
```

**Interpret These:**

- **Win Rate >65%:** Good; beating market noise
- **Win Rate <50%:** Losing; check signal quality
- **Sharpe Ratio >1.5:** Good risk-adjusted returns
- **Max Drawdown <10%:** Acceptable risk
- **Profit Factor >1.5:** More wins than losses (in dollars)

---

## Settings & Configuration

**In the Settings tab, configure:**

### Strategy Settings

**Min Edge (%)**
- Default: 5%
- Controls: How much better your model prob must be than market
- Lower = more trades, higher risk
- Higher = fewer trades, only strong edges
- **Recommended for Phase A:** 3-5%

**Min EV Threshold (%)**
- Default: 5%
- Controls: Minimum acceptable edge after costs
- After fees + spread + slippage, edge must be ≥ this
- **For Phase A:** Will be overridden by EVEngine hard floor (3%)

**Snipe Before Close (seconds)**
- Default: 10
- Controls: How many seconds before 5-min window close the bot enters
- 10s = plenty of time to analyze
- 5s = rushed, risky
- **Recommended:** 10-15 seconds

**Require Whale Convergence**
- Default: OFF
- When ON: Only trade if copy targets are trading same direction
- Useful if you trust specific traders
- Can boost confidence by 25% if aligned

### Risk Management

**Kelly Cap (%)**
- Default: 10%
- Controls: Maximum position size per trade (% of capital)
- 10% = aggressive, full Kelly
- 5% = conservative, half Kelly
- **Recommended:** 5-10% (lower = safer)

**Max Trade Size ($)**
- Default: $100
- Controls: Hard ceiling on any single trade
- Prevents accidental overexposure
- **Set based on your bankroll**

**Paper Balance ($)**
- Default: $10,000
- Only matters if using PAPER TRADING mode
- Click **Reset to $10,000** to restart paper trading

**Paper Trading Mode**
- Toggle ON = practice with fake money
- Toggle OFF = real execution (⚠️ careful!)
- **CRITICAL: Always test in paper mode first**

---

## Paper Trading

**Risk-free practice mode.**

### How It Works

1. Toggle **Paper Trading: ON** in Settings
2. Start the bot
3. Bot executes trades on fake $10,000 balance
4. No real money is spent
5. Results are logged and tracked

### Workflow

**Phase A Dry-Run (First 100 Signals):**

1. Set **Paper Trading: ON**
2. Set **USE_NEW_STRATEGY: ON** (in code, already enabled)
3. **Start Bot**
4. Monitor Signal Monitor for ~100 signals (≈1-2 hours)
5. Check metrics:
   - Skip rate ≥ 85%? ✓
   - EV_adj 3-10%? ✓
   - Market lag triggering? ✓
6. If metrics look clean → flip to LIVE
7. If metrics are bad → adjust settings before going live

### Reading Paper Trade Results

**In Trade History:**
- All trades marked as **[PAPER]** in logs
- Balance updates shown: "Balance: $9,500.20"
- P&L tracked but no real money moves

---

## Live Trading

⚠️ **Only proceed after successful paper trading validation.**

### Enable Live Trading

1. In Settings: Toggle **Paper Trading: OFF**
2. Confirm you want to **enable real execution**
3. Set your wallet and private key (if not already done)
4. **Start Bot**

### Safety Mechanisms

**Built-in Protections:**
- Max drawdown: 10% (bot stops if exceeded)
- Daily trade limit: 10 trades/day (prevents overtrading)
- Minimum EV: 3% hard floor (no marginal trades)
- Stop-loss: Auto-closes losers (4-8% loss threshold)
- Take-profit: Auto-closes winners (20-40% gain target)

### Monitoring Live Trading

**While Running:**
1. Check Signal Monitor every 10-15 minutes
2. Watch for broken signals (zero market lag, high skip rate)
3. Monitor win rate (target >65%)
4. Check P&L (expect +$50-100/day at full scale)

**If Something Goes Wrong:**
1. Click **STOP BOT** immediately
2. Check logs for error messages
3. Verify settings are correct
4. Restart with caution

---

## Understanding the Three-Gate Logic

**The bot filters signals through THREE sequential gates:**

### Gate 1: Microstructure Edge Detection

**Question:** "Is there real latency between BTC and Polymarket?"

**Checks:**
- ✅ BTC moves fast (50+ bps in 30s)
- ✅ Polymarket lags behind
- ✅ Order book imbalanced (bid/ask depth unequal)

**PASS:** Microstructure confidence ≥ 45% AND market lag detected  
**FAIL:** Skip signal ("No market lag" or "Confidence too low")

**Why:** Without real latency, you're just trading noise. This ensures you only exploit actual market inefficiencies.

---

### Gate 2: EV Cost Adjustment

**Question:** "After accounting for fees + spread + slippage, is there still edge?"

**Checks:**
- Model probability (how confident are you?)
- Polymarket bid/ask spread (entry cost)
- Slippage estimate (how much price moves against you)
- Fees (2% flat on Polymarket)

**Calculation:**
```
EV_adjusted = EV_raw - (spread + slippage)

If EV_adjusted < 3% → SKIP
If EV_adjusted ≥ 3% → PASS
```

**PASS:** recommendation == 'TRADE' AND EV_adj ≥ 3%  
**FAIL:** Skip signal ("EV < 3%" or "Spread too wide")

**Why:** Many trades look good until you subtract execution costs. This hard floor (3%) ensures you only trade when edge survives real-world friction.

---

### Gate 3: Asymmetric Confirmation

**Question:** "Does the technical signal align with the direction?"

**Checks:**
- EMA 9 vs EMA 21 crossover
- RSI extremes (oversold/overbought)
- Momentum pressure

**Rules:**
- If direction == UP: need EMA_score > 0 (bullish pressure)
- If direction == DOWN: need EMA_score < 0 (bearish pressure)
- Neutral signals rejected (no fence-sitting)

**PASS:** EMA/RSI aligned with direction  
**FAIL:** Skip signal ("EMA misaligned")

**Why:** This weak confirmation ensures technical pressure backs up the latency signal. Prevents fighting the market.

---

## Metrics & Interpretation

### Skip Rate

**What:** % of signals rejected by gates

```
Skip Rate 87% means: 87 out of 100 signals were rejected
Only 13 trades executed
```

**Targets:**
- **85-92%:** Perfect (filtering noise, only trading edge)
- **75-84%:** Good (probably trading 15-25 signals)
- **<75%:** Too loose (executing weak signals)
- **>95%:** Too tight (starving for trades)

**If Too Low (<75%):**
- Increase min_edge (5% → 7%)
- Increase min_ev_threshold (3% → 4%)
- Increase micro confidence threshold (0.45 → 0.50)

**If Too High (>95%):**
- Decrease min_edge (5% → 3%)
- Decrease min_ev_threshold (3% → 2%)
- Decrease micro confidence threshold (0.45 → 0.40)

---

### Average EV_adj

**What:** Average adjusted EV across all traded signals

```
EV_adj Avg 5.2% means: On average, trades have 5.2% edge after costs
```

**Targets:**
- **3-10%:** Good (solid edge)
- **<3%:** Bad filtering (executing marginal trades)
- **>15%:** Unrealistic (check if calculation is wrong)

**If Too Low (<3%):**
- EV thresholds too loose
- Increase gate 2 threshold (3% → 4%)
- Increase overall confidence requirement

---

### Market Lag Detection Rate

**What:** % of signals where BTC/Polymarket latency was detected

```
Market Lag 15% means: In 15 out of 100 signals, real latency was present
```

**Targets:**
- **10-20%:** Good (edge present 1-2 signals per window)
- **<5%:** Broken (latency signal not detecting)
- **>30%:** Unusual (check if threshold too loose)

**If Too Low (<5%):**
- Latency detection broken
- Check Chainlink connection
- Verify Binance price feed working
- Increase BTC movement threshold (0.0002 → 0.00015)

---

### Win Rate

**What:** % of closed trades that were profitable

```
Win Rate 68% means: 68 out of 100 closed trades won
```

**Targets:**
- **>65%:** Excellent (beating signal quality)
- **50-65%:** Good (market quality)
- **<50%:** Bad (need to investigate)

**If Below 50%:**
1. Check if market conditions changed
2. Verify stop-loss isn't too tight (-8% is default)
3. Verify take-profit is reasonable (+20-40%)
4. Review Gate 2 and Gate 3 confidence levels

---

## Copy Trading

**Mirror trades from other successful traders.**

### Setup

1. **Find a trader:** Provide their Polymarket address
2. **Add as target:** In Copy tab → "Add Target"
3. **Set multiplier:** 0.5-2.0x your trade size
4. **Min confirmations:** 1 = copy immediately, 3 = wait for consensus

### How It Works

1. Monitor target trader's Polymarket activity
2. When they place a trade, detect it within 5 seconds
3. Copy same direction + amount × multiplier
4. Track their win rate vs yours

### Settings

**Min Confirmations**
- 1: Copy on first trade (risky, fast)
- 2: Wait for 2 traders doing same direction (consensus)
- 3: Wait for 3 traders (high confidence)

**Multiplier**
- 0.5x: Copy trades at half their size (cautious)
- 1.0x: Match exactly (synchronized)
- 2.0x: Double their size (aggressive)

---

## FAQ & Troubleshooting

### Q: Bot says "Connecting..." but stays stuck

**A: Wallet or keys issue**
1. Verify wallet address in Settings
2. Check private key is correct
3. Ensure wallet has Polygon-USDC balance (for trading)
4. Restart bot

### Q: No signals are showing up

**A: Likely not in snipe window**

1. Signals only trigger in last 10 seconds of 5-min windows
2. Bot sleeps between windows
3. Check "Time to Resolution" in Signal Monitor
4. If stuck on "WAIT", normal—waiting for window

### Q: Skip rate is 95%+ (too many rejections)

**A: Gates too strict**

Fix in Settings:
1. Lower Min Edge from 5% to 3%
2. Increase Micro Confidence threshold from 0.45 to 0.40
3. Restart bot
4. Re-run 10 signals and check skip rate

### Q: Skip rate is <70% (too many trades)

**A: Gates too loose**

Fix in Settings:
1. Raise Min Edge from 5% to 7%
2. Increase EV Threshold from 3% to 4%
3. Increase Micro Confidence from 0.45 to 0.50
4. Restart bot

### Q: Market lag never triggers

**A: Latency signal broken**

Check:
1. Is Binance price updating? (Should change every second)
2. Is Chainlink price updating? (Should change every 10-30 sec)
3. If Chainlink stuck, check RPC connection in Settings
4. If Binance stuck, bot may be disconnected

Recovery:
1. Stop bot
2. Restart bot
3. Monitor 10 signals
4. If still zero lag, increase BTC threshold (settings)

### Q: Live trades are losing money

**A: Signal quality degraded**

Diagnose:
1. Check Gate Breakdown—which gate is failing most?
2. Check EV_adj Avg—is it above 3%?
3. Check Win Rate—is it below 50%?

If Gate 2/2.5 failing: Spread widened (increase min_edge)  
If Gate 1/1.5 failing: Market changed (wait for new signal pattern)  
If Win Rate <50%: Market conditions may have changed (take a break)

### Q: "Error: Insufficient balance"

**A: Paper or live balance too low**

**Paper Mode:**
1. Go to Settings
2. Click "Reset to $10,000"
3. Restart bot

**Live Mode:**
1. Deposit more USDC to your wallet
2. Wait for confirmation
3. Restart bot

### Q: Bot stopped trading for no reason

**A: Likely hit one of these limits:**

Check logs:
1. Daily trade limit (max 10/day)
2. Max drawdown exceeded (10% loss)
3. Cooldown after bad streak (1 min pause)
4. User-triggered stop (check if button is red)

Recovery:
1. Wait for cool-down timer (shown in logs)
2. Or click START BOT again to reset

---

## Pro Tips

### Tip 1: Always Test in Paper First
Run 50-100 signals in paper mode before going live. Watch for:
- Skip rate staying at 85-90%
- EV_adj in 3-10% range
- Market lag triggering 10-20% of time

### Tip 2: Monitor Peak Hours
Bot works best when:
- BTC is volatile (1-3% daily moves)
- Polymarket is liquid (tight spreads)
- Market hours (higher activity)

Bot struggles when:
- Overnight (low volume, wide spreads)
- Flat markets (no latency to exploit)

### Tip 3: Adjust for Market Conditions
**High Volatility (>2%):**
- Increase min_edge (5% → 7%)
- Reduce max_trade_size (safety)

**Low Volatility (<0.5%):**
- Decrease min_edge (5% → 3%)
- Increase kelly_cap (more aggressive)

### Tip 4: Review Metrics Weekly
Run analysis every 100 trades:
- Win rate trend (up/down?)
- Avg EV_adj (stable?)
- Gate breakdown (which filter working?)
- Adjust if needed

### Tip 5: Check Chainlink Health
Gateway to accurate BTC prices. If stuck:
1. Go to Settings → Chainlink RPC
2. Test connection
3. If failing, use Binance price fallback (automatic)

---

## Support & Contact

**Issues?**

- Check this guide first (most answers here)
- Review logs in Admin tab (technical details)
- Check GitHub issues: github.com/fmrxr/polybot-backend/issues
- Start with paper trading (lower stakes)

---

**Last Updated:** Phase A Dry-Run Ready
**Strategy:** Three-Gate Cost-Aware Decision Logic
**Expected Performance:** 85%+ skip rate, 65%+ win rate, +$50-200/day at scale
