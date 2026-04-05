---
name: frontend-auditor
description: Audit the frontend (public/index.html) for hardcoded data, unwired UI elements, disconnected settings fields, and stale/fake data streams. Use this skill whenever the user asks to "check hardcoded data", "audit the frontend", "verify data wiring", "check if the UI reflects real data", or mentions that a dashboard value looks wrong or is always the same. Also invoke proactively after any backend change that adds new settings, routes, or data fields — the frontend likely needs wiring updates.
---

# Frontend Data Wiring Auditor

You are auditing a live trading bot frontend for correctness. The goal is to find every place where the UI shows fake, stale, or disconnected data and replace it with real API-backed values. This is a **high-stakes system** — incorrect P&L, wrong thresholds, or missing trade data causes bad trading decisions.

## What to Audit

Run all six categories below. For each finding, note the **file**, **line number**, **element ID or selector**, **current value**, **expected source**, and **severity** (HIGH / MEDIUM / LOW).

---

### Category 1: Static Hardcoded Literals in UI

Find every hardcoded number, string, or label that should come from an API, setting, or live data stream.

**What to look for:**
- Numbers baked into `textContent`, `innerHTML`, or `value` attributes that represent thresholds, probabilities, dollar amounts, counts, or percentages
- Labels like "Gate 3: EMA Confirm" where the actual engine uses different logic
- Default placeholder values never overwritten by JS (e.g., `—`, `0`, `0.02%` that stay static)
- `innerText = "1000"` or similar JS assignments that never get updated from the API

**How to find them:**
- Read `public/index.html` and search for numeric literals inside `<span>`, `<td>`, `<div>` elements that have no corresponding `id` attribute (unaddressable = unupdatable)
- Search JS in the same file for `textContent =` or `innerHTML =` assignments with literal values instead of variable references
- Cross-check every Settings panel field: for each `<input>` or `<select>`, verify there is a corresponding `loadSettings...` call that populates it from the API response

---

### Category 2: Live Data Validation

Compare what the frontend displays against what the backend API actually returns.

**What to check:**

| Frontend element | Expected API source | How to verify |
|---|---|---|
| Bot status (running/stopped) | `GET /api/bot/status` → `.isRunning` | Check the JS handler |
| Paper balance | `GET /api/bot/status` → `.paperBalance` | Should update every poll cycle |
| Open positions count | `GET /api/bot/status` → `.openPositions` | Check for off-by-one or stale state |
| Live P&L per trade | `GET /api/bot/status` → `openTrades[].live_pnl` | Must NOT use midPrice (always 0.5) |
| Pending orders panel | `GET /api/bot/status` → `.pendingOrders` | Panel should hide when array is empty |
| Signal feed | `GET /api/signals` | Should include gate1/2/3 scores |
| Trade history | `GET /api/trades` | Must show `close_reason`, `result`, `exit_price` |

For each: find the JS function that fetches and renders, verify the field path matches the actual API JSON, and confirm the element ID exists in the HTML.

---

### Category 3: Settings Fields Cross-Check

Every field in `bot_settings` DB table must have a corresponding:
1. Input element in the Settings tab with a valid `id`
2. A `loadSettings()` read that populates it
3. A `saveSettings()` write that sends it back to `PUT /api/bot/settings`

**Known bot_settings columns to verify are all wired:**
```
paper_trading, paper_balance, is_active,
gate1_threshold, gate2_ev_floor, gate3_enabled, gate3_min_edge,
kelly_cap, max_daily_loss, max_drawdown_pct,
snipe_timer_seconds, stale_lag_seconds, chase_threshold,
whale_convergence, min_edge, snipe_before_close_sec,
order_timeout_sec, adverse_ticks,
max_trade_size, min_ev_threshold, min_prob_diff,
direction_filter, market_prob_min, market_prob_max,
claude_auto_analysis, claude_model
```

Report any column that exists in `src/models/db.js` ALTER TABLE block but has no input element, or has an input element but is never sent in `saveSettings()`.

---

### Category 4: UI/UX Structural Checks

- **Missing element IDs**: Any `<span>`, `<div>`, or `<td>` that displays dynamic data but has no `id` attribute — it cannot be updated by JS
- **Overlapping/hidden elements**: Panels or cards that are `display:none` by default with no JS code that ever shows them (dead UI)
- **Broken event listeners**: Buttons with `onclick` handlers that reference undefined functions
- **Form validation gaps**: Numeric inputs with no `min`/`max` that could accept nonsense values (negative trade size, probability > 1, etc.)
- **Missing loading states**: Data sections that render blank on slow API responses with no spinner or skeleton
- **Tab state persistence**: Settings that reset to defaults when switching tabs (settings must be saved, not just held in memory)

---

### Category 5: Trading-Specific Data Integrity

These are high-severity for a trading system:

- **P&L calculation**: Verify the formula matches backend — `(livePrice - entryPrice) * tokenQty - fees`. If the frontend is computing its own P&L, it may diverge from DB.
- **Price scale confusion**: Any place displaying a token price (0–1 range) must not accidentally display BTC price (~$90k), and vice versa.
- **Fill probability display**: If the UI shows fill probability, it must come from `_checkPaperFill` logic, not be hardcoded or estimated differently.
- **Boundary book detection**: Markets with `spread > 90%` (bid=0.01/ask=0.99) should be flagged in the UI, not shown as normal fills.
- **Signal direction vs trade direction**: The signal may say "UP" but the trade table might show "BUY" — verify these are consistent labels or clearly mapped.
- **Gate labels vs actual gates**: Gate 1 = micro/confidence, Gate 2 = EV floor, Gate 3 = BTC momentum. Any mislabeling causes user confusion about why trades are skipped.

---

### Category 6: Stale / Disconnected Data Streams

- **Polling intervals**: Identify all `setInterval` calls and their ms values. Flag any that poll less frequently than every 30s for real-time data (open positions, bot status).
- **No-op poll cycles**: A poll function that fetches data but only updates some fields (leaving others stale from last call).
- **Error state hiding**: `catch` blocks that swallow errors and leave the UI showing old data without any error indicator.
- **Race conditions**: Multiple setIntervals updating the same DOM element — last-write-wins can cause flicker or incorrect values.
- **WebSocket vs polling**: If the system has a WebSocket feed, check that the frontend actually connects and falls back to polling on disconnect.

---

## How to Run the Audit

1. Read `public/index.html` in full
2. Read `src/routes/bot.js`, `src/routes/trades.js`, `src/routes/user.js` to understand actual API response shapes
3. Read `src/models/db.js` to get the full column list for `bot_settings` and `trades`
4. For each category above, systematically scan — use Grep to find patterns:
   - `Grep 'textContent\s*=' public/index.html` — JS literal assignments
   - `Grep 'id="[a-z]' public/index.html` — all element IDs (then verify each is populated)
   - `Grep 'settings\.' public/index.html` — settings field references in JS
   - `Grep 'saveSettings\|loadSettings' public/index.html` — find the save/load functions

5. Build a findings list grouped by category and severity
6. Generate a concise **Audit Report** (see format below)
7. For HIGH severity issues: propose and apply fixes inline
8. For MEDIUM/LOW: list them with suggested fixes for user review

---

## Audit Report Format

```
## Frontend Data Wiring Audit Report
Generated: <date>

### Summary
- HIGH: N issues
- MEDIUM: N issues  
- LOW: N issues

### HIGH Severity

#### [H1] <issue title>
- Location: public/index.html line NNN — element #elementId
- Current: <what it shows now>
- Expected: <what it should show, from which API field>
- Fix: <exact code change>

...

### MEDIUM Severity
[same format]

### LOW Severity
[same format]

### Settings Wiring Coverage
| Setting | DB Column | Input ID | In loadSettings? | In saveSettings? |
|---------|-----------|----------|-----------------|-----------------|
| ... | ... | ... | ✅ | ❌ |

### Polling Audit
| Interval | Function | Fields Updated | Gap (fields fetched but not rendered) |
|----------|----------|----------------|--------------------------------------|
```

---

## Auto-Fix Protocol

For HIGH severity issues that are mechanical fixes (add an ID, wire a field, fix a field path):
- Apply the fix directly using Edit tool
- Note what was changed in the report

For issues requiring design judgment (restructuring a section, changing polling architecture):
- Describe the fix clearly and ask the user before applying
