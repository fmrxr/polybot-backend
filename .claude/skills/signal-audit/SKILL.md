---
name: signal-audit
description: Diagnose why the bot is skipping trades — query bot_decisions, group by gate_failed, identify root cause
user-invocable: true
---

You are diagnosing why the Polymarket trading bot is not executing trades.

## Steps

1. Call GET /api/bot/gate-stats (use fetch or read the route handler in src/routes/bot.js to understand the data)
2. Read the last 30 rows from src/bot/GBMSignalEngine.js evaluate() logs by checking the bot_decisions table structure
3. Analyze the gate failure distribution:
   - gate_failed = 1 → Microstructure confidence < 45% (most likely: polyPrice is BTC price, not token price 0-1)
   - gate_failed = 1.5 → No market lag detected (micro confidence OK but hasMarketLag = false)
   - gate_failed = 2 → EV_adj below 3% threshold (model_prob too close to market_prob)
   - gate_failed = 2.5 → Hard floor rejection (borderline EV)
   - gate_failed = 3 → EMA misaligned with gate direction

## Report Format

```
=== SIGNAL AUDIT ===
Skip rate (24h): X%
Gate failure breakdown:
  Gate 1 (micro confidence): X% of skips
  Gate 1.5 (no market lag): X%
  Gate 2 (EV too low): X%
  Gate 3 (EMA misaligned): X%

Most likely root cause: [explain]
Recommended fix: [specific code change]
```

## Common Root Causes

- **polyPrice = BTC price in microEngine.composite()** → latency.btcDelta ≈ latency.polyDelta → confidence always ~0 → 100% gate 1 failures
- **bid/ask not fetched from market** → tokenMid defaults to 0.50 → modelProb - marketProb = 0 → gate 2 always fails
- **obImbalance always 0** → direction forced from tokenMid, EMA can't confirm → gate 3 fails ~50%
