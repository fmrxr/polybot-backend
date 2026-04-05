# Polybot — Full Data & Calculation Pipeline

## Overview

This document traces every data point from raw feed to executed trade, including all formulas, thresholds, and fallbacks.

---

## Stage 1 — Data Ingestion

### 1a. Binance WebSocket (BTC real-time)

- **Feed**: `wss://stream.binance.com:9443/ws/btcusdt@trade@bookTicker`
- **Fields consumed**:
  - `price` — last trade price (BTC/USDT spot)
  - `depth5` — top 5 bid/ask levels
- **Derived in `BinanceFeed.js`**:
  - `obImbalance = (bidVol - askVol) / (bidVol + askVol)` → range −1 to +1
  - `volatility` — rolling std dev of recent BTC price returns
  - `drift` — rolling mean of recent BTC price returns
  - `windowDelta` — BTC % change since current 5-min window opened

### 1b. Polymarket CLOB (order books)

- **Endpoint**: `https://clob.polymarket.com/book?token_id=<id>`
- **Fields consumed**:
  - `bids[]` / `asks[]` — price-size pairs
- **Derived in `PolymarketFeed.js`**:
  - `bestBid`, `bestAsk`, `mid = (bestBid + bestAsk) / 2`
  - `spread = (bestAsk - bestBid) / bestAsk`
  - `depth` — total USDC value in top N levels

### 1c. Gamma API (market prices)

- **Endpoint**: `https://gamma-api.polymarket.com/markets?slug=<slug>`
- **Fields consumed**:
  - `outcomePrices` — JSON array: `["0.495","0.505"]` → index 0 = YES, index 1 = NO
  - `clobTokenIds` — JSON array of token IDs (always parse if `typeof === 'string'`)
  - `endDate` — market resolution timestamp
- **When used**: primary price source for BTC 5-min markets (CLOB books are always boundary-only: bid=0.01, ask=0.99, spread=98%)

### 1d. Chainlink (BTC/USD price oracle)

- **Feed**: Polygon network contract
- **Interval**: 30 000 ms
- **Used for**: cross-validation of Binance price; not used in signal calculation

---

## Stage 2 — Market Discovery

Every bot tick, `PolymarketFeed.js` resolves the current active 5-min BTC market:

1. Compute current 5-min epoch: `epochSec = Math.floor(Date.now()/1000 / 300) * 300`
2. Try slug: `btc-updown-5m-<epochSec>`
3. Also try `epochSec ± 300` (adjacent windows in case of clock skew)
4. Fallback: Gamma `end_date_min/max` query for markets ending in the next 10 min
5. **Never use** `clobClient.getMarkets()` — returns only historical 2023 data

Result: `{ conditionId, yesTokenId, noTokenId, endDate, timeToResolutionSec }`

---

## Stage 3 — Price Resolution Waterfall

For every signal evaluation, the YES token price is resolved in this order:

```
1. CLOB order book mid  →  if spread < 90%
2. Gamma outcomePrices  →  outcomePrices[0] (YES)  ← almost always used for BTC 5-min
3. getLastTradePrice()  →  most recent CLOB fill price
4. signal.entryPrice    →  Gamma price stored at signal time (execution fallback)
5. pending.referencePrice → Gamma price stored at order placement time (fill-check fallback)
```

**Why CLOB fails**: BTC 5-min markets have boundary-only resting liquidity (bid=0.01, ask=0.99). This is not missing data — it's structural. Gamma `outcomePrices` is the actual market-implied probability.

---

## Stage 4 — Pre-Signal Filters

Before evaluating gates, two fast-exit filters run in `BotInstance._tick()`:

### Chase filter
```
if (timeToResolutionSec < snipe_before_close_sec) → skip (too late to enter)
```
Default `snipe_before_close_sec = 10`.

### EV trend filter
```
if (evTrend === 'WORSENING' && consecutive > 3) → skip
```
Prevents entering when market is moving against the signal direction.

---

## Stage 5 — Gate 1: Microstructure Confidence

**Engine**: `MicrostructureEngine.js`  
**Input**: `polyPrice` (Gamma yes price, 0–1), `btcPrice`, `obImbalance`

Computes a `composite` confidence score (0–1) from:
- BTC order book imbalance
- Token price momentum vs BTC momentum alignment
- Latency between BTC move and token price reaction (lag = edge signal)

**Gate 1 pass condition**:
```
composite >= gate1_threshold   (default: 0.20)
```

If fails → signal logged as `SKIP: gate1`.

---

## Stage 6 — Gate 2: Expected Value Floor

**Engine**: `GBMSignalEngine.js` → `evaluate()`

### 6a. BTC momentum score

```
btcDelta = (currentBtcPrice - windowOpenBtcPrice) / windowOpenBtcPrice × 100
```
- Window opens at start of 5-min BTC interval
- `windowDeltaScore = sign(btcDelta) × min(abs(btcDelta)/0.05, 3)`

### 6b. Technical indicator scores (each ±1 to ±2 points)

| Indicator | Method | Weight |
|-----------|--------|--------|
| EMA cross | ema9 vs ema21 | ±1–2 |
| RSI | 14-period, overbought/sold thresholds | ±1–2 |
| Tick trend | recent 5-tick price direction | ±1 |
| OB imbalance | Binance depth5 skew | ±0.5–1.5 |
| GBM divergence | model prob vs estimated market prob | ±1–2 |

Total raw score = sum of all indicator scores.

### 6c. Confidence

```
confidence = min(abs(score) / 10.0, 1.0)
```

### 6d. Model probability

```
modelProb = 0.5 + (confidence × 0.4)   → range 0.50–0.90
```

### 6e. Market probability

```
marketProb = yesPrice   (from Gamma outcomePrices[0])
```

### 6f. Edge

```
edge = modelProb - marketProb
```

If `edge <= min_edge` (default 0.05) → skip: no-trade zone.

### 6g. EV calculation

```
b = (1 / marketProb) - 1       ← net payout multiplier
EV = modelProb × b - (1 - modelProb)
   = (modelProb × (1 - marketProb) - (1 - modelProb) × marketProb) / marketProb
```

Simplified: `EV = (modelProb - marketProb) / marketProb`

Then cost-adjusted:
```
cost = spread × 0.25            ← 25% of spread as entry slippage cost
EVreal = EV - cost
```

**Gate 2 pass condition**:
```
EVreal >= gate2_ev_floor        (default: 2.10% for new windows, 3.00% inside window)
```

---

## Stage 7 — Gate 3: BTC Momentum Direction Confirmation

```
if (gate3_enabled) {
  if (sign(btcDelta) !== sign(signal.direction)) → skip: gate3
}
```

- `signal.direction = 'YES'` means "BTC will close above open"
- Gate 3 requires BTC to currently be moving in the same direction as the signal
- `btcDelta < 0.02%` is considered "flat" — gate 3 passes (no clear counter-signal)

---

## Stage 8 — Kelly Position Sizing

```
b = (1 / entryPrice) - 1        ← where entryPrice = direction==='YES' ? yesPrice : (1-yesPrice)
kelly = (modelProb × b - (1 - modelProb)) / b
size = min(max(0, kelly) × kelly_cap × max_trade_size, max_trade_size)
```

Hard cap: `$5 per trade` regardless of Kelly or balance.  
Kelly cap: `25%` of computed Kelly fraction.

---

## Stage 9 — Order Lifecycle (Execution)

### 9a. Entry price determination

```
ask = CLOB order book ask price
entryPrice = ask + 0.25 × spread    ← slippage simulation for paper
```

For live orders: CLOB limit order placed at `ask` price.

### 9b. Spread filter (hard exit before order)

```
if (spread > 0.15) → skip: boundary book
```

For BTC 5-min markets this is `spread = 0.98` → always skipped at this check.  
**Exception**: Gamma fallback path bypasses spread filter since Gamma IS the real price.

### 9c. Paper order placement

Stored as `pendingOrders` Map:
```
{
  tokenId, direction, entryPrice, size, dollarAmount,
  referencePrice,   ← Gamma price at placement time (fill-check fallback)
  placedAt, timeoutAt
}
```

`timeoutAt = Date.now() + order_timeout_sec × 1000` (default 30s)

### 9d. Fill simulation (`_checkPaperFill`)

```
currentPrice = getLastTradePrice(tokenId)
             ?? pending.referencePrice       ← fallback when 404

distanceFactor = max(0, 1 - abs(currentPrice - entryPrice) / 0.05)
timeFactor     = min(0.2, elapsed_ms / order_timeout_ms × 0.2)
atMarket       = abs(currentPrice - entryPrice) < 0.01 ? 0.2 : 0

fillProb = min(0.95, distanceFactor × 0.55 + timeFactor + atMarket)
```

Random draw: `if (Math.random() < fillProb)` → filled.

On fill: trade recorded to DB, `openTrades` Map updated.

---

## Stage 10 — Trade Recording

DB insert to `trades` table:

| Column | Value |
|--------|-------|
| `token_id` | CLOB token ID |
| `direction` | YES / NO |
| `entry_price` | actual fill price |
| `trade_size` | dollar amount |
| `token_qty` | `dollarAmount / entryPrice` |
| `confidence` | Gate 2 confidence score |
| `result` | NULL (pending), WIN, LOSS, CLOSED |
| `pnl` | final P&L in USDC |
| `close_reason` | TP / SL / EXPIRED / MANUAL |

---

## Stage 11 — Position Management (`_manageOpenPositions`)

Every tick, for each open trade:

### 11a. Live price

```
currentTokenPrice = getLiveTokenPrice(tokenId)   ← CLOB midpoint
                 ?? trade.entryPrice              ← fallback
```

### 11b. Live P&L

```
pnl = tokenQty × (currentTokenPrice - entryPrice) - (tradeSize × 0.02)
```

Fee: 2% of trade size.

### 11c. Take-profit (dynamic)

```
TP = tradeSize × (0.20 + confidence × 0.20)   → 20%–40% of trade size
```

### 11d. Stop-loss (dynamic)

```
SL = tradeSize × -(0.08 - confidence × 0.04)  → -8% to -4% of trade size
```

### 11e. Expiry

If `timeToResolutionSec <= 0` → close at market (resolution price).

---

## Stage 12 — Risk Controls

| Control | Value | Where enforced |
|---------|-------|---------------|
| Hard trade cap | $5 | `_executeTrade` |
| Kelly cap | 25% | GBMSignalEngine |
| Max daily loss | configurable | `BotInstance._tick` |
| Min EV floor | 2.10% | Gate 2 |
| Min edge | 5% | Gate 2 pre-check |
| Spread filter | >15% = skip | `_executeTrade` |
| Snipe window | `< snipe_before_close_sec` = skip | `_tick` |
| No-trade zone | `edge <= min_edge` = skip | GBMSignalEngine |

---

## Stage 13 — Signal Recording

Every Gate 2 evaluation is written to the `signals` table:

```
{
  condition_id, direction, btc_delta, model_prob, yes_price,
  ev_real, ev_floor, fill_prob, depth, time_to_resolution_sec,
  gate2_passed, gate3_passed, skipped, skip_reason,
  confidence, edge
}
```

This powers the Lab analytics tab (skip breakdown, EV distribution, signal quality over time).

---

## Summary Table

| Stage | Component | Input | Output |
|-------|-----------|-------|--------|
| 1a | BinanceFeed | WS stream | btcPrice, obImbalance, volatility |
| 1b | PolymarketFeed | CLOB API | bestBid/Ask, spread, depth |
| 1c | Gamma API | REST | yesPrice, tokenIds, endDate |
| 2 | Market discovery | epoch time | conditionId, tokenIds, timeToRes |
| 3 | Price waterfall | CLOB / Gamma | resolved yesPrice |
| 4 | Pre-filters | timeToRes, evTrend | pass/skip |
| 5 | Gate 1 | polyPrice, obImbalance | confidence ≥ threshold |
| 6 | Gate 2 | btcDelta, indicators, yesPrice | EVreal ≥ floor |
| 7 | Gate 3 | btcDelta, direction | direction aligned |
| 8 | Kelly | modelProb, entryPrice | dollarAmount ≤ $5 |
| 9 | Order lifecycle | entryPrice, size | pending order → fill |
| 10 | Trade recording | fill data | DB row |
| 11 | Position mgmt | currentPrice, pnl | TP/SL/EXPIRY close |
| 12 | Risk controls | various | hard stops |
| 13 | Signal recording | all gate data | signals DB row |
