# Phase A: EVEngine + MicrostructureEngine Integration

## 🎯 Objective
Transform GBMSignalEngine from signal spam → quality gates

## Structure (FINAL)
```
Microstructure Edge Gate
    ↓ (if false → SKIP)
EV Calculation (EVEngine)
    ↓ (if EV_adj < 3% → SKIP)
Filter & Confirm
    ↓ (only high-quality signals pass)
Execution (ExecutionEngine)
```

## NOT THIS ❌
```
RSI + Momentum + EMA spam
    ↓
EV check (too late, damage done)
    ↓
Execute anyway
```

---

## ⚠️ PRE-REFACTOR CHECKLIST (CRITICAL)

### 1. Dry-Run Mode (NO EXECUTION)
Add feature flag to BotInstance:
```javascript
const DRY_RUN_NEW_STRATEGY = true; // Log only, no trades
```

In evaluate():
```javascript
if (DRY_RUN_NEW_STRATEGY) {
  // Log gates but don't return decision
  log.micro_confidence = microSignal.confidence;
  log.ev_raw = ev_raw;
  log.ev_adjusted = ev_adjusted;
  log.recommended = evResult.recommended;
  this._emit(log);
  // Fall back to old logic for actual trading
  return oldLogic();
}
```

**Goal**: Run ~50–100 signals, collect logs, verify:
- ✅ Skip rate is 70-80%
- ✅ EV_adj distribution is sensible
- ✅ Microstructure triggers on real latency

### 2. Safe Fallback (Very Important)
Wrap refactored code in try/catch:
```javascript
try {
  // New pipeline with 3 gates
  const microSignal = this.microEngine.composite(...);
  const evResult = this.evEngine.computeAdjustedEV(...);
  // ... gates ...
  return newSignal;
} catch(e) {
  this._log('ERROR', `New strategy failed: ${e.message}. Using fallback.`);
  // Fall back to old logic
  return this._oldEvaluate(params);
}
```

### 3. Feature Flag (Instant Switchback)
Add to GBMSignalEngine constructor:
```javascript
this.USE_NEW_STRATEGY = false; // Start false, flip after dry-run
```

In evaluate():
```javascript
if (!this.USE_NEW_STRATEGY) {
  return this._evaluateOld(params); // Old logic unchanged
}

// New strategy
try {
  // ... 3 gates ...
} catch(e) {
  // Fallback + alert
}
```

### 4. Integration Order (One Gate At A Time)
**Do NOT refactor everything at once:**

**Day 1:** Microstructure gate only
- Add MicrostructureEngine
- Log micro.confidence
- Reject if < 0.45
- Keep old EV logic

**Day 2:** Add EV gate
- Inject EVEngine
- Log ev_adjusted
- Reject if < 3%
- Microstructure already working

**Day 3:** Reduce old signals
- Lower RSI weight
- Make EMA confirmation only
- Combine with new gates

**Day 4:** Connect execution
- Only pass TRADE signals to ExecutionEngine
- Rest use old execution

### 5. Expectations (Mindset)
First 1-2 days: Weird behavior (expected)
- Signals may be sparse
- Distribution may look odd
- Win rate may be random (need 50+ samples)

First 50 trades: Inconsistent (normal)
- Too few to judge
- Could be lucky or unlucky
- Keep logging, don't tune

After 100+ trades: Signal stabilizes (real data)
- Win rate becomes predictable
- EV distribution becomes clear
- NOW you can tune thresholds

**👉 DON'T TUNE EARLY. Wait for 100+ trades.**

### 6. Log Checklist Before Going Live
Run dry-run, then check:
- ✅ Skip rate 70-80%
- ✅ EV_adj mostly < 0.03 (being filtered)
- ✅ Rare TRADE signals (1-5% rate)
- ✅ Microstructure confidence distribution makes sense
- ✅ No crashes or NaN values
- ✅ Fallback working if you manually trigger error

**Only then**: Flip `USE_NEW_STRATEGY = true` and execute

---

## Step 1: Inject EVEngine into GBMSignalEngine

### File: `src/bot/GBMSignalEngine.js`

**Add imports** (line 5):
```javascript
const { EVEngine } = require('./EVEngine');
const { MicrostructureEngine } = require('./MicrostructureEngine');
```

**Constructor** (~line 20):
```javascript
constructor(settings) {
  this.settings = settings;
  this.onDecision = null;
  // ... existing ...
  
  // NEW: Add engines
  this.evEngine = new EVEngine();
  this.microEngine = new MicrostructureEngine();
}
```

---

## Step 2: Rewrite evaluate() Decision Logic

### OLD LOGIC (~line 230-260)
```javascript
// Check confidence threshold
if (confidence < minConfidence) {
  log.verdict = 'SKIP';
  return null;
}

// Check Kelly sizing
const size = ...
```

### NEW LOGIC: Three Gates

**Gate 1: Microstructure Edge (PRIMARY)**
```javascript
// STEP 1: Detect microstructure edge FIRST
const microSignal = this.microEngine.composite({
  btcPrice: currentPrice,
  polyPrice: market.midPrice,
  bidSize: market.bidDepth,
  askSize: market.askDepth,
  largestBid: market.bestBid,
  largestAsk: market.bestAsk,
  totalDepth: market.totalDepth,
  volatility
});

log.microstructure_signal = microSignal.signal;
log.microstructure_confidence = microSignal.confidence;
log.thin_liquidity = microSignal.thin_liquidity;

// HARD GATE: No microstructure edge → SKIP
// ⚠️ START STRICT: 0.45 threshold (can loosen to 0.3–0.4 later if too few trades)
const microThreshold = 0.45;

// NaN safety check (critical for debugging threshold behavior)
if (!microSignal?.confidence || 
    isNaN(microSignal.confidence) || 
    microSignal.confidence < microThreshold) {
  
  // Log threshold details (very useful for tuning later)
  log.verdict = 'SKIP';
  log.micro_confidence = microSignal?.confidence ?? null;
  log.micro_threshold = microThreshold;
  log.reason = `Weak microstructure edge (confidence ${(microSignal?.confidence ?? 0).toFixed(2)} < ${microThreshold})`;
  
  this._emit(log);
  return null;
}
```

**Gate 2: EV Check (COST-AWARE)**
```javascript
// STEP 2: Calculate cost-aware EV
const btcDelta = currentPrice > (priceHistory[priceHistory.length-6] || currentPrice)
  ? (currentPrice - (priceHistory[priceHistory.length-6] || currentPrice)) / (priceHistory[priceHistory.length-6] || currentPrice)
  : 0;

const evResult = this.evEngine.computeAdjustedEV({
  priceYes: market.lastPrice,
  bid: market.bestBid,
  ask: market.bestAsk,
  modelProb: confidence,
  direction: signal.direction || 'UP',
  orderSize: signal.size || 20,
  marketDepth: market.totalDepth || 1000,
  volatility,
  btcDelta,
  hasMarketLag: microSignal.confidence > 0.5 // Confidence = implied lag
});

log.ev_raw = evResult.ev_raw;
log.ev_adjusted = evResult.ev_adjusted;
log.ev_threshold = evResult.threshold;
log.spread_cost = evResult.spread_cost;
log.slippage_cost = evResult.slippage_cost;

// HARD GATE: EV_adj <= 3% → SKIP
if (evResult.recommended === 'SKIP') {
  log.verdict = 'SKIP';
  log.reason = evResult.reason;
  this._emit(log);
  return null;
}
```

**Gate 3: Signal Confirmation (WEAK)**
```javascript
// STEP 3: RSI/EMA/Momentum only as CONFIRMATION
// They don't decide, they just confirm
let confirmationScore = 0;

if (emaScore > 0 && Math.sign(emaScore) === Math.sign(score)) {
  confirmationScore += 0.2; // Weak weight
}
if (Math.abs(rsiScore) > 1 && Math.sign(rsiScore) === Math.sign(score)) {
  confirmationScore += 0.2;
}

// Need at least one confirmation
if (confirmationScore < 0.2) {
  log.verdict = 'WAIT';
  log.reason = `Signals conflict: EV ok but no confirmation`;
  this._emit(log);
  return null;
}
```

---

## Step 3: Kill Old Decision Logic

**Remove or reduce weight of**:
- ❌ `if (confidence < minConfidence)` ← EV handles this now
- ❌ `const minAbsScore = 3.0; if (Math.abs(score) < 3)` ← Microstructure handles this
- ✓ Keep RSI/EMA but only as confirmation

**What to KEEP**:
- Price history for momentum detection
- Volatility calculation
- Window delta (still useful)

---

## Step 4: Update Signal Return Object

Old:
```javascript
return {
  direction,
  entry_price,
  size,
  confidence,
  expected_value: ev
};
```

New:
```javascript
return {
  direction,
  entry_price: evResult.ev_adjusted * max_trade_size,
  size,
  confidence,
  // EV data
  ev_raw: evResult.ev_raw,
  ev_adjusted: evResult.ev_adjusted,
  ev_threshold: evResult.threshold,
  // Microstructure data
  microstructure_signal: microSignal.signal,
  microstructure_confidence: microSignal.confidence,
  // Execution hints
  spread_cost: evResult.spread_cost,
  slippage_cost: evResult.slippage_cost
};
```

---

## Step 5: Execution Gate (BotInstance)

In `BotInstance._executeTrade()`:

```javascript
// Gate: Only execute if micro edge is real
// ⚠️ Must match GBMSignalEngine threshold (0.45 or adjusted)
const microThreshold = 0.45;
if (!signal?.microstructure_confidence || 
    isNaN(signal.microstructure_confidence) || 
    signal.microstructure_confidence < microThreshold) {
  this._log('WARN', `Skipping: Weak microstructure edge (confidence ${(signal?.microstructure_confidence ?? 0).toFixed(2)} < ${microThreshold})`);
  return;
}

// Gate: Only execute if EV positive
if (!signal.ev_adjusted || signal.ev_adjusted <= 0.03) {
  this._log('WARN', `Skipping: EV_adj ${signal.ev_adjusted.toFixed(3)} below threshold`);
  return;
}

// Safe to execute
const execEngine = new ExecutionEngine();
const ladderOrders = execEngine.ladderEntry({
  direction: signal.direction,
  totalSize: signal.size,
  midPrice: market.midPrice,
  spread: market.bestAsk - market.bestBid
});

// ... place orders ...
```

---

## Metrics to Watch

After integration, **target** (with 0.45 micro threshold):
- ✅ Skip rate: 80-90% (very tight)
- ✅ Win rate: 70%+ (high quality)
- ✅ Trades/day: 3-5 (low frequency)
- ✅ Slippage: <0.1% (with limit orders)
- ✅ Avg P&L per trade: +$10-20

**Red flags** (indicates gates too loose):
- ❌ More than 10 trades/day = TIGHTEN (overtrading)
  - EV: 3% → 3.5%+
  - Micro confidence: 0.45 → 0.50+
- ❌ Win rate < 60% = TIGHTEN microstructure threshold (low quality)
  - Micro confidence: 0.45 → 0.50
- ❌ Slippage > 0.2% = TIGHTEN execution (order size too big or depth too thin)
  - Reduce ladder entry size
  - Increase order timeout

**Tuning guide** (DISCIPLINE: one change per 24h, measure 100+ trades):

If too few trades (< 2/day) - gates too tight:
1. Reduce microstructure threshold: 0.45 → 0.40
2. Reduce EV threshold: 3% → 2.5%
3. Increase BTC delta sensitivity: lower adaptive threshold min (20 bps → 15 bps)

If overtrading (> 10/day) - gates too loose:
1. Increase microstructure threshold: 0.45 → 0.50
2. Increase EV threshold: 3% → 3.5%
3. Decrease BTC delta sensitivity: higher adaptive threshold max (100 bps → 150 bps)

**Always measure before and after each change**

---

## Testing Checklist

### Unit Tests
- [ ] EVEngine.computeAdjustedEV returns SKIP when no microstructure edge
- [ ] EVEngine.computeAdjustedEV returns SKIP when EV_adj < 3%
- [ ] MicrostructureEngine.composite() returns confidence score
- [ ] MicrostructureEngine detects BTC lag correctly

### Integration Tests
- [ ] GBMSignalEngine with EVEngine: SKIP rate = 70%+
- [ ] GBMSignalEngine with MicrostructureEngine: latency signals detected
- [ ] Combined: Only trades when BOTH microstructure + EV positive
- [ ] BotInstance respects execution gates: no trades without edges

### Live Testing (Paper)
- [ ] Day 1: Monitor skip rate (should jump to 70%+)
- [ ] Day 2: Monitor win rate (should improve)
- [ ] Day 3: Check slippage with ladder orders
- [ ] Day 4: Request Claude feedback on patterns

---

## Files to Modify

1. **src/bot/GBMSignalEngine.js** ← PRIMARY
   - Import EVEngine + MicrostructureEngine
   - Rewrite evaluate() gates
   - Update signal return object

2. **src/bot/BotInstance.js** ← SECONDARY
   - Add execution gates before _executeTrade()
   - Pass signal metadata to ExecutionEngine

3. **src/bot/EVEngine.js** ← READY (no changes needed)
4. **src/bot/MicrostructureEngine.js** ← READY (no changes needed)

---

## Success Criteria

✅ **Phase A is complete when:**
1. EVEngine + MicrostructureEngine integrated into GBMSignalEngine
2. Skip rate jumps to 70%+ in first 24 hours
3. Win rate improves (58%+)
4. Trades reduced to <10 per day
5. No regression in execution (slippage < 0.2%)

**Outcome**: Bot transforms from:
- "Signal spam, hope some are right" 
→ "Latency exploitation with cost-aware filtering"

---

## ⚠️ Critical Discipline Rules

**DURING INTEGRATION:**
1. ❌ DO NOT add signals without gates
2. ❌ DO NOT relax thresholds "just to get more trades"
3. ✅ DO stick with 0.45 microstructure threshold for 24+ hours first
4. ✅ DO measure skip rate (should be 80%+)
5. ✅ DO measure win rate (should improve)

**IF TEMPTED TO LOOSEN:**
- Wait 100+ trades before tuning
- Change ONE parameter at a time
- Measure for 24+ hours before next change
- Document the reason (e.g., "win rate dropped to 58%, lowering threshold")

**THE DISCIPLINE PART:**
- The design is now solid (EVEngine + Micro + Gates)
- The outcome depends on sticking to the discipline
- Every signal you pass through that doesn't meet gates = expected value destruction
- Tight > loose, always

---

## 📊 Reading the Logs (Day 1 Integration)

After 24 hours of paper trading, check **Signal Decisions** log for:

### Good patterns (what you want):
```
SKIP | micro_confidence: 0.35 | micro_threshold: 0.45 ✓ Correct rejection
SKIP | ev_adjusted: 0.01 (2.5%) | threshold: 0.03 (3%) ✓ Cost barrier working
TRADE | micro_confidence: 0.52 | ev_adjusted: 0.045 ✓ High quality pass
```

### Bad patterns (tighten thresholds):
```
TRADE | micro_confidence: 0.25 | threshold: 0.45 ❌ Got through somehow
TRADE | ev_adjusted: 0.01 | threshold: 0.03 ❌ Below threshold
```

### Target distribution (with 0.45 threshold):
- 80-90% SKIP (too loose micro or low EV)
- 10-20% WAIT (micro ok, need confirmation)
- 1-5% TRADE (high quality, passed all gates)

### Metrics to log (already in code):
```
log.micro_confidence = ?       ← How strong is the latency signal?
log.micro_threshold = 0.45    ← What's the gate?
log.ev_adjusted = ?           ← After costs?
log.reason = "..."            ← Why SKIP/TRADE?
```

If you see:
- ❌ >5% TRADE rate = micro threshold too loose → increase to 0.50
- ✅ 1-3% TRADE rate = micro threshold just right
- ❌ 0% TRADE rate for 6+ hours = threshold too tight → loosen to 0.40

**This gate alone will cut 50–70% of bad trades.**

---

## 🚨 Troubleshooting During Integration

| Problem | Check | Fix |
|---------|-------|-----|
| Bot crashes | Error logs | Fallback working? Feature flag = false |
| No signals (0% TRADE) | micro.confidence values | Threshold too tight? Drop to 0.40 |
| Too many signals (>5% TRADE) | micro + EV logs | Threshold too loose? Raise to 0.50 |
| EV_adj doesn't improve win rate | Sample size | Wait for 100+ trades |
| Slippage jumps | Order size + depth ratio | Reduce ladder entry size |
| Weird distribution | NaN in logs | Add null checks, fix MicrostructureEngine |

**Golden rule:** If unsure, flip feature flag to old logic and run diagnostic.

---

## 🎯 Success Criteria

**Phase A refactoring is DONE when:**
1. ✅ Dry-run shows 70-80% skip rate
2. ✅ EV_adj filtering working (mostly < 0.03)
3. ✅ Microstructure gate shows clean triggers
4. ✅ No crashes or NaN errors
5. ✅ Fallback tested and working
6. ✅ Feature flag switches instantly
7. ✅ Live with new strategy shows improved metrics after 100+ trades

**Outcome:**
- Bot is now microstructure-first, cost-aware
- Trades only on latency + positive EV
- Skip rate 70-80% (tight filtering)
- Win rate 65%+ (high quality)
- Trades/day 3-5 (low frequency, high precision)

This is the inflection point. From here, it's just discipline.

