---
name: signal-audit
description: Diagnose why the Polymarket bot is not executing trades. Use this skill whenever the user asks why trades aren't firing, wants to understand gate failures, asks about skip rate, wants a strategy analysis, or says "study the decision stream". Queries the live Railway PostgreSQL database directly and produces a full root-cause diagnosis with specific fix recommendations.
user-invocable: true
---

# Signal Audit

Diagnose why the bot is skipping trades by querying the live DB and analysing gate failure patterns.

## Step 1 — Get the DB connection

The DB URL is in one of these places (try in order):
1. `DATABASE_URL` env var
2. User provides it in the conversation (Railway public URL format: `postgresql://postgres:PASSWORD@HOST.proxy.rlwy.net:PORT/railway`)

If neither is available, ask the user for the Railway public DB URL before proceeding.

## Step 2 — Run all six queries

Run these in parallel via the `postgres` MCP server (or `psql` if MCP unavailable):

**Q1 — Gate stats, last hour:**
```sql
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE verdict='TRADE') AS trades,
  COUNT(*) FILTER (WHERE verdict='SKIP') AS skips,
  ROUND(COUNT(*) FILTER (WHERE verdict='SKIP')::numeric / NULLIF(COUNT(*),0) * 100, 1) AS skip_rate,
  ROUND(AVG(ev_adj) FILTER (WHERE ev_adj IS NOT NULL), 3) AS avg_ev_adj,
  ROUND(AVG(confidence) FILTER (WHERE confidence IS NOT NULL), 3) AS avg_confidence,
  COUNT(*) FILTER (WHERE gate1_passed=false) AS fail_gate1,
  COUNT(*) FILTER (WHERE gate2_passed=false AND gate1_passed=true) AS fail_gate2,
  COUNT(*) FILTER (WHERE gate3_passed=false AND gate2_passed=true) AS fail_gate3
FROM signals
WHERE created_at > NOW() - INTERVAL '1 hour';
```

**Q2 — Gate failure codes:**
```sql
SELECT gate_failed, COUNT(*) as count
FROM signals
WHERE created_at > NOW() - INTERVAL '1 hour' AND gate_failed IS NOT NULL
GROUP BY gate_failed ORDER BY count DESC;
```

**Q3 — EV distribution:**
```sql
SELECT
  COUNT(*) FILTER (WHERE ev_adj < 0) AS neg_ev,
  COUNT(*) FILTER (WHERE ev_adj BETWEEN 0 AND 1) AS ev_0_1,
  COUNT(*) FILTER (WHERE ev_adj BETWEEN 1 AND 3) AS ev_1_3,
  COUNT(*) FILTER (WHERE ev_adj BETWEEN 3 AND 5) AS ev_3_5,
  COUNT(*) FILTER (WHERE ev_adj > 5) AS ev_gt5,
  MAX(ev_adj) AS max_ev,
  ROUND(AVG(ev_adj) FILTER (WHERE ev_adj IS NOT NULL), 3) AS avg_ev
FROM signals
WHERE created_at > NOW() - INTERVAL '1 hour';
```

**Q4 — Skip reasons:**
```sql
SELECT reason, COUNT(*) as count
FROM signals
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY reason ORDER BY count DESC LIMIT 10;
```

**Q5 — Sample last 15 signals:**
```sql
SELECT verdict, direction, reason,
  ROUND(ev_adj::numeric, 3) AS ev_adj,
  ROUND(confidence::numeric, 3) AS conf,
  gate1_passed, gate2_passed, gate3_passed, gate_failed, created_at
FROM signals
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC LIMIT 15;
```

**Q6 — Today's trades:**
```sql
SELECT id, direction, entry_price, trade_size, pnl, result, status,
  close_reason, created_at, closed_at
FROM trades
WHERE created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC LIMIT 20;
```

## Step 3 — Diagnose

Cross-reference the data against these known failure patterns:

| Pattern | Indicator | Root cause |
|---|---|---|
| 95%+ skip rate, ev_adj = -0.70 always | Q3: neg_ev = 0 but avg_ev ≈ -0.7 | BTC flat — `btcDelta < 0.02%` means modelProb = yesPrice, EV = pure cost (-0.7%). Not a bug. |
| Gate2 = 90%+ of skips, ev_adj NULL | Q2: gate_failed=2 dominates | EV below floor — either BTC flat or gate2_ev_floor set too high |
| TRADE signals in DB but 0 trades executed | Q1: trades=0 despite TRADEs in Q4 | Kelly = 0 — `entryPrice` or `modelProb` wrong direction → check BotInstance.js Kelly formula |
| Gate3 = 30%+ of skips | Q2: gate_failed=3 | btcDelta direction misaligned with EV direction — normal when BTC reverses mid-window |
| Gate1 = majority of skips | Q2: gate_failed=1 | `polyPrice` receiving BTC price (~$90k) instead of token mid (0–1) |
| ev_adj all NULL despite activity | Q5: ev_adj null on all rows | Signal logging broken — `signals` INSERT missing ev_adj field |
| EV > 3% generated but no trades, no Kelly warn | Q4: TRADE reasons exist, Q6 empty | Missing balance, paper_trading toggle changed without restart, or `_executeTrade` throws silently |

## Step 4 — Report

```
=== SIGNAL AUDIT ===
Period: last 1 hour
Total signals: X  |  TRADEs: X  |  SKIPs: X  |  Skip rate: X%

Gate failure breakdown:
  Gate 2 (EV too low):          X  (X% of skips)
  Gate 3 (momentum misaligned): X
  Gate 1 (micro confidence):    X
  EV Trend (decaying):          X

EV summary: avg=X%  max=X%  (X% are negative)
Today's trades: X executed

Root cause: [one clear sentence]

Evidence:
  - [specific data point from queries]
  - [specific data point]

Recommendation:
  - [specific setting change or code fix with file:line reference]
  - [if BTC flat: "This is market conditions, not a bug — wait for volatility"]
```

Keep the report concise. If BTC was simply flat (ev_adj = -0.70% universally), say so clearly — don't suggest code fixes for a market condition problem.
