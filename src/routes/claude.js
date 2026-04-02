const express = require('express');
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
const { encrypt, decrypt } = require('../services/encryption');

const router = express.Router();
router.use(authMiddleware);

// POST /api/claude/analyze - Trigger Claude AI analysis
router.post('/analyze', async (req, res) => {
  try {
    // Get user's Claude settings
    const settingsResult = await pool.query(
      'SELECT claude_api_key, claude_model FROM bot_settings WHERE user_id = $1',
      [req.userId]
    );

    if (!settingsResult.rows.length || !settingsResult.rows[0].claude_api_key) {
      return res.status(400).json({ error: 'Claude API key not configured' });
    }

    const settings = settingsResult.rows[0];
    const apiKey = decrypt(settings.claude_api_key);
    const model = settings.claude_model || 'claude-opus-4-6';

    // Get recent trades for analysis — include slippage, EV data, lag age
    const tradesResult = await pool.query(`
      SELECT
        direction, entry_price, size, model_prob, market_prob,
        expected_value, result, pnl, exit_reason, slippage,
        ev_at_entry, ev_peak, lag_age_sec, created_at
      FROM trades
      WHERE user_id = $1 AND result IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 100
    `, [req.userId]);

    const trades = tradesResult.rows;

    if (trades.length === 0) {
      return res.status(400).json({ error: 'No completed trades to analyze' });
    }

    // Calculate statistics (pg returns DECIMAL as strings — parse to float)
    const winTrades = trades.filter(t => t.result === 'WIN').length;
    const lossTrades = trades.filter(t => t.result === 'LOSS').length;
    const totalPnL = trades.reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0);
    const avgPnL = totalPnL / trades.length;
    const winRate = (winTrades / trades.length * 100).toFixed(1);
    const avgEVAtEntry = trades.filter(t => t.ev_at_entry != null)
      .reduce((s, t) => s + parseFloat(t.ev_at_entry), 0) / Math.max(trades.filter(t => t.ev_at_entry != null).length, 1);
    const avgSlippage = trades.filter(t => t.slippage != null && parseFloat(t.slippage) > 0)
      .reduce((s, t) => s + parseFloat(t.slippage), 0) / Math.max(trades.filter(t => t.slippage != null && parseFloat(t.slippage) > 0).length, 1);
    const avgLagAge = trades.filter(t => t.lag_age_sec != null)
      .reduce((s, t) => s + parseFloat(t.lag_age_sec), 0) / Math.max(trades.filter(t => t.lag_age_sec != null).length, 1);

    // Exit reason breakdown
    const exitReasons = trades.reduce((acc, t) => {
      const r = t.exit_reason || 'resolved';
      acc[r] = (acc[r] || 0) + 1;
      return acc;
    }, {});

    // Build autonomous feedback agent prompt
    const strategyDescription = `
EV-driven prediction market strategy for Polymarket BTC 5-minute binary markets.
- Primary signal: EV_adjusted = EV_raw - spread_cost - slippage_cost
- Trades exploit market lag (BTC moves fast, Polymarket token price lags)
- Dynamic position flipping (YES ↔ NO) based on EV superiority of opposite side
- NOT a scalping bot — positions held for probability resolution, not price ticks
- Three-gate entry: (1) Microstructure lag detected, (2) EV_adj ≥ 3% after costs, (3) EMA direction confirmation
- Exits: TP at +20-40% of size, SL at -4 to -8%, EV-decay exit when EV falls to <50% of peak
`;

    const analysisPrompt = `You are an autonomous trading strategy feedback and optimization agent.

Your role is to analyze completed trades and continuously improve the strategy described below.

STRATEGY CONTEXT:
${strategyDescription}

OBJECTIVE: Evaluate decision quality (not just outcome). Identify edge validity vs execution error. Propose parameter updates. Optimize for long-term EV growth, NOT short-term win rate.

PERFORMANCE SUMMARY (last ${trades.length} trades):
- Win Rate: ${winRate}% (${winTrades}W / ${lossTrades}L)
- Total P&L: $${totalPnL.toFixed(2)} | Avg per trade: $${avgPnL.toFixed(2)}
- Avg EV at Entry: ${(avgEVAtEntry * 100).toFixed(2)}%
- Avg Slippage: ${(avgSlippage * 100).toFixed(3)}%
- Avg Lag Age at Entry: ${avgLagAge.toFixed(1)}s
- Exit breakdown: ${Object.entries(exitReasons).map(([k,v]) => `${k}:${v}`).join(', ')}

RECENT TRADE DETAILS (last 20):
${trades.slice(0, 20).map((t, i) => {
  const evEntry = t.ev_at_entry != null ? (parseFloat(t.ev_at_entry)*100).toFixed(1)+'%' : 'N/A';
  const evPeak = t.ev_peak != null ? (parseFloat(t.ev_peak)*100).toFixed(1)+'%' : 'N/A';
  const slip = t.slippage != null ? (parseFloat(t.slippage)*100).toFixed(2)+'%' : 'N/A';
  const lag = t.lag_age_sec != null ? parseFloat(t.lag_age_sec).toFixed(0)+'s' : 'N/A';
  return `Trade ${i+1}: ${t.direction} @ ${parseFloat(t.entry_price||0).toFixed(3)} | ${t.result} | P&L $${parseFloat(t.pnl||0).toFixed(2)} | EV_entry ${evEntry} | EV_peak ${evPeak} | slippage ${slip} | lag ${lag} | exit: ${t.exit_reason||'resolved'}`;
}).join('\n')}

ANALYSIS FRAMEWORK — evaluate each dimension:

1. EV QUALITY: Was EV genuinely positive after costs? Was EV increasing or decaying at entry? Were trades high-conviction or marginal (EV < 4%)?

2. TIMING & ENTRY: Was signal fresh (lag ≤ 15s)? Any late entries (chasing)? Distribution of lag ages?

3. EXECUTION: Slippage severity vs EV at entry. Did slippage materially reduce edge?

4. POSITION MANAGEMENT: Were exits optimal? EV-decay exits — too early or too late? Holding duration patterns?

5. FLIP LOGIC: Any patterns in direction flipping? EV-justified vs noise-driven flips? Overtrading signals?

6. FAILURE MODES: Identify exact loss scenarios. Chop / no clear direction? Fake EV spikes? Stale signals? Over-flipping?

PARAMETER UPDATE RULES:
- Never overfit to a single trade
- Require pattern confirmation (≥5 similar trades)
- Adjust incrementally (±0.005 to ±0.02 per update)
- Preserve core: EV-driven, lag-aware, flip-capable

OUTPUT FORMAT:

## 🧾 Trade Evaluation
**Decision Quality**: (Good / Neutral / Bad — overall batch)
**Key Issue**: (most critical problem found, if any)

## 📊 EV Analysis
(EV quality, entry timing, slippage impact)

## 🔁 Flip & Position Logic
(flip quality, exit quality, duration patterns)

## ⚠️ Failure Modes Detected
(specific loss scenarios from this data)

## ⚙️ Parameter Recommendations
| Parameter | Current | Suggested | Reason |
|-----------|---------|-----------|--------|
| EV_threshold | 3% | ? | ... |
| lag_max_sec | 20s | ? | ... |
| flip_ev_gap | 1.5% | ? | ... |
| exit_ev_decay | 50% | ? | ... |

## 🚫 Anti-Patterns (if detected)
(overtrading, chasing, EV miscalibration)

## 🔁 Rolling Memory Update
(1-2 lines summarizing this batch for longitudinal tracking)

## 📈 Score: /10 | Verdict: Deploy / Refine / Reject
**Core Weakness**: (1 line)
**Biggest Edge**: (1 line)
**Top Fix**: (1 actionable change)

Style: Ruthless, precise, no fluff. Optimize for real edge, not theoretical perfection. Do NOT suggest scalping, spread-gating, or latency penalties.`;

    // Call Claude API (using fetch since we can't import SDK in routes)
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: analysisPrompt
        }]
      })
    });

    if (!claudeResponse.ok) {
      const error = await claudeResponse.json();
      console.error('Claude API error:', error);
      return res.status(400).json({ error: 'Failed to get Claude analysis', details: error });
    }

    const claudeData = await claudeResponse.json();
    const feedback = claudeData.content[0].text;

    // Store feedback in bot_decisions table
    await pool.query(`
      INSERT INTO bot_decisions (user_id, verdict, direction, reason, data, claude_feedback, claude_feedback_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
    `, [
      req.userId,
      'ANALYSIS',
      'NEUTRAL',
      'Claude AI Analysis',
      JSON.stringify({ trades_count: trades.length, win_rate: winRate, total_pnl: totalPnL, avg_ev_at_entry: avgEVAtEntry, avg_slippage: avgSlippage, avg_lag_age: avgLagAge }),
      feedback
    ]);

    res.json({
      success: true,
      feedback: feedback,
      trade_count: trades.length,
      win_rate: winRate,
      total_pnl: totalPnL
    });

  } catch (err) {
    console.error('Claude analyze error:', err);
    res.status(500).json({ error: 'Failed to analyze trades', details: err.message });
  }
});

// GET /api/claude/latest-feedback - Get most recent Claude analysis
router.get('/latest-feedback', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT claude_feedback, claude_feedback_at, data, created_at
      FROM bot_decisions
      WHERE user_id = $1 AND claude_feedback IS NOT NULL
      ORDER BY claude_feedback_at DESC
      LIMIT 1
    `, [req.userId]);

    if (result.rows.length === 0) {
      return res.json(null);
    }

    const record = result.rows[0];
    res.json({
      feedback: record.claude_feedback,
      created_at: record.claude_feedback_at || record.created_at,
      data: record.data
    });
  } catch (err) {
    console.error('Get latest feedback error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/claude/history - Get past Claude analyses
router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    const result = await pool.query(`
      SELECT claude_feedback, claude_feedback_at, data, created_at
      FROM bot_decisions
      WHERE user_id = $1 AND claude_feedback IS NOT NULL
      ORDER BY claude_feedback_at DESC
      LIMIT $2
    `, [req.userId, limit]);

    const analyses = result.rows.map(row => ({
      feedback: row.claude_feedback,
      created_at: row.claude_feedback_at || row.created_at,
      data: row.data,
      trade_count: row.data?.trades_count || 0,
      win_rate: row.data?.win_rate || 0,
      total_pnl: row.data?.total_pnl || 0
    }));

    res.json(analyses);
  } catch (err) {
    console.error('Get history error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/claude/test - Test Claude API connection
router.post('/test', async (req, res) => {
  try {
    const { api_key } = req.body;

    if (!api_key) {
      return res.status(400).json({ error: 'API key required' });
    }

    // Test the API key with a simple request
    const testResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: 'Hi'
        }]
      })
    });

    if (!testResponse.ok) {
      const error = await testResponse.json();
      console.error('Claude test error:', error);
      return res.status(400).json({ error: 'Invalid API key', details: error });
    }

    res.json({ success: true, message: 'Claude API key is valid' });
  } catch (err) {
    console.error('Claude test error:', err);
    res.status(500).json({ error: 'Failed to test Claude connection', details: err.message });
  }
});

module.exports = router;
