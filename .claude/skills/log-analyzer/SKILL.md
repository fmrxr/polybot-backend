---
name: log-analyzer
description: Analyze Railway JSON log files from the Polymarket bot to diagnose why no trades are executing. Use this skill whenever the user opens or mentions a .json or .log file from Railway, asks to "read the logs", "check the new logs", "why aren't trades firing" with a log file present, or shares a logs file path. Parses Gate2/SKIP/Kelly/execution lines and identifies the root cause with evidence.
user-invocable: true
---

# Log Analyzer

Parse Railway bot logs and identify exactly why trades aren't executing.

## Step 1 — Load the log file

The log file is either:
- Referenced in the conversation (path from IDE file open)
- Passed as an argument (e.g. `/log-analyzer c:/Users/.../logs.json`)

Railway logs come in two formats:
- **JSON array**: `[{"message":"...","severity":"...","timestamp":"...","tags":{...}}, ...]`
- **Plain text**: one log line per row with timestamp prefix

Read the file. If it exceeds token limits, use `head -c 30000` (first 30KB) + `tail -c 30000` (last 30KB) to sample both ends.

## Step 2 — Extract key signals

Run a Node.js script to parse and count. Write it inline:

```js
const fs = require('fs');
const raw = fs.readFileSync('<PATH>', 'utf8');

// Handle both JSON array and plain text
let lines;
try {
  const data = JSON.parse(raw);
  lines = data.map(e => e.message || '');
} catch {
  lines = raw.split('\n').filter(Boolean);
}

const gate2     = lines.filter(l => l.includes('Gate2'));
const skips     = lines.filter(l => l.includes('[GBMSignalEngine] SKIP'));
const kelly     = lines.filter(l => l.includes('Kelly'));
const executing = lines.filter(l => l.includes('Executing') || l.includes('Paper trade') || l.includes('executeTrade'));
const noBook    = lines.filter(l => l.includes('No valid order book') || l.includes('Empty order book'));
const errors    = lines.filter(l => l.includes('[err]') || (l.toLowerCase().includes('error') && !l.includes('No valid')));
const botStart  = lines.filter(l => l.includes('Bot started') || l.includes('Starting bot'));

// Gate2 stats
let passCount = 0, failCount = 0, evVals = [], btcDeltas = [];
gate2.forEach(l => {
  const ev  = parseFloat(l.match(/evReal=([-\d.]+)%/)?.[1]);
  const fl  = parseFloat(l.match(/floor=([\d.]+)%/)?.[1]);
  const btc = parseFloat(l.match(/btcDelta=([-\d.]+)%/)?.[1]);
  if (!isNaN(ev)) { evVals.push(ev); if (ev >= fl) passCount++; else failCount++; }
  if (!isNaN(btc)) btcDeltas.push(Math.abs(btc));
});

// Skip breakdown
const skipTypes = {};
skips.forEach(l => { const m = l.match(/SKIP — (\S+)/); const k = m?.[1] || 'unknown'; skipTypes[k] = (skipTypes[k]||0)+1; });

// btcDelta stats
const flatCount = btcDeltas.filter(d => d < 0.02).length;
const avgDelta  = btcDeltas.length ? (btcDeltas.reduce((a,b)=>a+b,0)/btcDeltas.length).toFixed(4) : 'n/a';
const maxDelta  = btcDeltas.length ? Math.max(...btcDeltas).toFixed(4) : 'n/a';

// EV stats
const avgEV = evVals.length ? (evVals.reduce((a,b)=>a+b,0)/evVals.length).toFixed(3) : 'n/a';
const maxEV = evVals.length ? Math.max(...evVals).toFixed(3) : 'n/a';

console.log(JSON.stringify({
  total_lines: lines.length,
  gate2_evals: gate2.length,
  gate2_pass: passCount,
  gate2_fail: failCount,
  skips_total: skips.length,
  skip_types: skipTypes,
  kelly_warnings: kelly.length,
  trade_executions: executing.length,
  no_order_book: noBook.length,
  errors: errors.length,
  bot_restarts: botStart.length,
  btc_flat_pct: btcDeltas.length ? (flatCount/btcDeltas.length*100).toFixed(1)+'%' : 'n/a',
  avg_btc_delta: avgDelta + '%',
  max_btc_delta: maxDelta + '%',
  avg_ev: avgEV + '%',
  max_ev: maxEV + '%',
}, null, 2));

// Print Kelly warnings
if (kelly.length) { console.log('\nKelly warnings:'); kelly.slice(0,5).forEach(l => console.log(' ', l.trim())); }
// Print Gate2 passing lines
const passing = gate2.filter(l => { const ev=parseFloat(l.match(/evReal=([-\d.]+)%/)?.[1]); const fl=parseFloat(l.match(/floor=([\d.]+)%/)?.[1]); return ev>=fl; });
if (passing.length) { console.log('\nGate2 PASSING lines:'); passing.forEach(l => console.log(' ', l.trim())); }
// Print errors
if (errors.length) { console.log('\nErrors:'); errors.slice(0,5).forEach(l => console.log(' ', l.trim())); }
```

## Step 3 — Diagnose

Match the output against these patterns:

| Observation | Diagnosis |
|---|---|
| `btc_flat_pct` > 80%, `avg_ev` ≈ -0.70% | **BTC flat** — btcDelta < 0.02% → modelProb = yesPrice → EV = pure cost. Not a bug. Wait for volatility. |
| `gate2_pass` > 0 but `trade_executions` = 0 | **Kelly=0 killing executions** — `entryPrice` using bestBid/bestAsk instead of mid, OR `modelProb` not flipped for NO direction. Check BotInstance.js `_executeTrade`. |
| `kelly_warnings` > 0 with `entry=0.9xx` | **entryPrice = bestBid/bestAsk on illiquid market** — spread > 50%, fill price crushes b=(1/entry)-1 to ~0. Fix: use mid price in entryPrice. |
| `gate2_pass` = 0, `skip_types.gate3` > 5 | **Gate3 blocking** — EV direction conflicts with btcDelta direction (BTC reversed mid-window). Expected during choppy markets. |
| `no_order_book` dominates | **Market transition** — order books go empty for 10–30s when a new 5-min window opens. Expected behaviour. |
| `bot_restarts` > 1 | **Multiple restarts** — EMA/signal state is reset each time. Check Railway crash logs. |
| All `gate2_pass` = 0 and btcDelta varies | **EVFloor too high** — gate2_ev_floor setting above what BTC moves can produce. Lower the floor. |

## Step 4 — Report

```
=== LOG ANALYSIS ===
File: <filename>  |  Lines: X  |  Time range: HH:MM → HH:MM

Signal pipeline:
  Gate2 evaluations:  X   (X pass / X fail)
  SKIP breakdown:     gate2=X  gate3=X  evTrend=X  all_markets_skipped=X
  Trade executions:   X
  Kelly warnings:     X

BTC momentum: avg |delta|=X%  max=X%  flat(<0.02%): X%
EV range:     avg=X%  max=X%

Root cause: [one clear sentence — be specific, cite the numbers]

Evidence:
  - [data point]
  - [data point]

Fix: [if code bug: file:line + what to change | if market condition: "BTC was flat, wait for volatility"]
```

If the root cause is simply flat BTC, say so directly and don't suggest code changes. Only recommend code fixes when the data shows signals passing gates but trades not executing, or a structural EV = -0.70% that doesn't depend on btcDelta.
