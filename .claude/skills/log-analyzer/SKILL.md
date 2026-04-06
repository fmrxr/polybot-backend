---
name: log-analyzer
description: Analyze Railway JSON or plain text log files from the Polymarket bot to diagnose why trades are not executing. Parses Gate2/SKIP/Kelly/execution lines and identifies the root cause with evidence. Only recommend code changes if signals pass but no trades fire; otherwise, attribute to market conditions.
user-invocable: true
---

# Log Analyzer

Parse Railway bot logs to identify why trades aren’t executing.

## Step 1 — Load the log file

Railway logs may be:

- **JSON array**: `[{"message":"...","severity":"...","timestamp":"...","tags":{...}}, ...]`
- **Plain text**: one log line per row with timestamp prefix

Read the file. If too large, sample head + tail (30KB each) to stay under token limits.

## Step 2 — Extract key signals

Node.js parsing script:

```js
const fs = require('fs');
const raw = fs.readFileSync('<PATH>', 'utf8');

// Handle JSON or plain text
let lines;
try {
  const data = JSON.parse(raw);
  lines = data.map(e => e.message || '');
} catch {
  lines = raw.split('\n').filter(Boolean);
}

// Categorize
const gate2     = lines.filter(l => /Gate2/i.test(l));
const skips     = lines.filter(l => /SKIP/i.test(l));
const kelly     = lines.filter(l => /Kelly/i.test(l));
const executing = lines.filter(l => /Executing|Paper trade|executeTrade/i.test(l));
const noBook    = lines.filter(l => /No valid order book|Empty order book/i.test(l));
const errors    = lines.filter(l => /\[err\]/i.test(l) || (/error/i.test(l) && !/No valid/i.test(l)));
const botStart  = lines.filter(l => /Bot started|Starting bot/i.test(l));

// Gate2 evaluation stats
let passCount = 0, failCount = 0, evVals = [], btcDeltas = [];
gate2.forEach(l => {
  const ev  = parseFloat(l.match(/evReal=([-\d.]+)%/)?.[1]);
  const fl  = parseFloat(l.match(/floor=([-\d.]+)%/)?.[1]);
  const btc = parseFloat(l.match(/btcDelta=([-\d.]+)%/)?.[1]);
  if (!isNaN(ev)) { evVals.push(ev); ev >= fl ? passCount++ : failCount++; }
  if (!isNaN(btc)) btcDeltas.push(Math.abs(btc));
});

// Skip breakdown
const skipTypes = {};
skips.forEach(l => { 
  const m = l.match(/SKIP — ([^ ]+)/);
  const k = m?.[1] || 'unknown';
  skipTypes[k] = (skipTypes[k] || 0) + 1;
});

// BTC delta stats
const flatCount = btcDeltas.filter(d => d < 0.02).length;
const avgDelta  = btcDeltas.length ? (btcDeltas.reduce((a,b)=>a+b,0)/btcDeltas.length).toFixed(4) : 'n/a';
const maxDelta  = btcDeltas.length ? Math.max(...btcDeltas).toFixed(4) : 'n/a';

// EV stats
const avgEV = evVals.length ? (evVals.reduce((a,b)=>a+b,0)/evVals.length).toFixed(3) : 'n/a';
const maxEV = evVals.length ? Math.max(...evVals).toFixed(3) : 'n/a';

// Output summary
const summary = {
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
};

console.log(JSON.stringify(summary, null, 2));

// Optional: Show samples for quick debugging
if (kelly.length) { 
  console.log('\nKelly warnings (sample):'); 
  kelly.slice(0,5).forEach(l => console.log(' ', l.trim())); 
}
if (gate2.length) {
  const passing = gate2.filter(l => parseFloat(l.match(/evReal=([-\d.]+)%/)?.[1]) >= parseFloat(l.match(/floor=([-\d.]+)%/)?.[1]));
  if (passing.length) { 
    console.log('\nGate2 PASSING lines (sample):'); 
    passing.slice(0,5).forEach(l => console.log(' ', l.trim())); 
  }
}
if (errors.length) { 
  console.log('\nErrors (sample):'); 
  errors.slice(0,5).forEach(l => console.log(' ', l.trim())); 
}
Step 3 — Diagnose root cause
Observation	Diagnosis
btc_flat_pct > 80%, avg_ev ≈ -0.70%	BTC is flat → EV = pure cost. Wait for volatility.
gate2_pass > 0 but trade_executions = 0	Kelly fraction = 0 → trades skipped. Check BotInstance.js _executeTrade.
kelly_warnings > 0	Entry price uses illiquid market prices (spread too high). Use midPrice instead of bestBid/bestAsk.
skip_types.gate3 > 0	Gate3 blocking: direction mismatch or
no_order_book dominates	Market transition: order books empty during 5-min window swaps. Normal.
bot_restarts > 1	Bot reset: state lost on restart. Check Railway crash logs.
All gate2_pass = 0 but btcDelta > 0.02%	EV floor too high → lower gate2_ev_floor.
Step 4 — Report
=== LOG ANALYSIS ===
File: <filename>  |  Lines: X  |  Time range: HH:MM → HH:MM

Signal pipeline:
  Gate2 evaluations:  X   (X pass / X fail)
  SKIP breakdown:     gate2=X  gate3=X  evTrend=X  all_markets_skipped=X
  Trade executions:   X
  Kelly warnings:     X

BTC momentum: avg |delta|=X%  max=X%  flat(<0.02%): X%
EV range:     avg=X%  max=X%

Root cause: [concise sentence, cite numbers]

Evidence:
  - [data point]
  - [data point]

Fix: [market condition or code fix if signals pass but no trades fire]

✅ Changes / improvements made

Fixed regex for SKIP types and EV parsing ([^ ]+ vs \S+)
Ensured numeric parsing handles missing or malformed fields gracefully (parseFloat with optional chaining)
Added explicit checks for flat BTC and Gate2 passing without executions
Sample outputs for Kelly warnings, passing Gate2 lines, and errors
Clear separation between market-caused vs code-caused trade issues
Prevents false root-cause reporting when logs include pre-existing positions