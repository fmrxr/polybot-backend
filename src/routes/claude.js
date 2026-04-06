const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
const { decrypt } = require('../services/encryption');

// --- Test Claude API Key (uses stored key, not raw body) ---
router.post('/test', authMiddleware, async (req, res) => {
  try {
    const settings = await pool.query(
      'SELECT claude_api_key_encrypted, claude_model FROM bot_settings WHERE user_id = $1',
      [req.userId]
    );

    if (!settings.rows[0]?.claude_api_key_encrypted) {
      return res.status(400).json({ error: 'Claude API key not configured. Save it in settings first.' });
    }

    const apiKey = decrypt(settings.rows[0].claude_api_key_encrypted);
    const model = settings.rows[0].claude_model || 'claude-sonnet-4-6';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }]
      })
    });

    if (response.ok) {
      res.json({ success: true, message: 'Claude API key is valid and working' });
    } else {
      const errData = await response.json().catch(() => ({}));
      res.status(400).json({
        success: false,
        error: errData.error?.message || `API returned status ${response.status}`
      });
    }
  } catch (err) {
    console.error('[Claude] Test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Run Analysis ---
router.post('/analyze', authMiddleware, async (req, res) => {
  try {
    const settings = await pool.query(
      'SELECT claude_api_key_encrypted, claude_model FROM bot_settings WHERE user_id = $1',
      [req.userId]
    );

    if (!settings.rows[0]?.claude_api_key_encrypted) {
      return res.status(400).json({ error: 'Claude API key not configured' });
    }

    const apiKey = decrypt(settings.rows[0].claude_api_key_encrypted);
    const model = settings.rows[0].claude_model || 'claude-sonnet-4-6';

    // Fetch recent trade data for analysis
    const trades = await pool.query(`
      SELECT direction, entry_price, exit_price, pnl, trade_size, signal_confidence, ev_adj, 
             gate1_score, gate2_score, gate3_score, close_reason, status, created_at, closed_at
      FROM trades 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT 50
    `, [req.userId]);

    const signals = await pool.query(`
      SELECT verdict, reason, direction, confidence, ev_raw, ev_adj, ema_edge,
             gate1_passed, gate2_passed, gate3_passed, created_at
      FROM signals 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT 100
    `, [req.userId]);

    const botSettings = await pool.query(
      'SELECT gate1_threshold, gate2_ev_floor, gate3_enabled, gate3_min_edge, kelly_cap, max_daily_loss, max_drawdown_pct FROM bot_settings WHERE user_id = $1',
      [req.userId]
    );

    const prompt = `You are a quantitative trading analyst reviewing a Polymarket trading bot's performance. Analyze the following data and provide actionable recommendations.

## Current Bot Settings
${JSON.stringify(botSettings.rows[0] || {}, null, 2)}

## Recent Trades (last 50)
${JSON.stringify(trades.rows, null, 2)}

## Recent Signals (last 100)
${JSON.stringify(signals.rows, null, 2)}

## Your Analysis Should Include:
1. **Performance Summary**: Win rate, avg PnL, Sharpe-like ratio
2. **Gate Analysis**: Which gates are filtering well vs too aggressively?
3. **Signal Quality**: Are high-confidence signals actually performing better?
4. **Risk Assessment**: Is the Kelly sizing appropriate? Drawdown concerns?
5. **Specific Recommendations**: Concrete parameter changes with reasoning
6. **Red Flags**: Any patterns that suggest the strategy is broken

Be specific with numbers. If you recommend changing a threshold, state the exact value and why.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(400).json({ error: errData.error?.message || 'Claude API request failed' });
    }

    const result = await response.json();
    const analysis = result.content?.[0]?.text || 'No analysis generated';

    // Compute total PnL from trades for history record
    const totalPnl = trades.rows.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);

    // Persist analysis to claude_analyses table
    await pool.query(
      `INSERT INTO claude_analyses (user_id, analysis, feedback, trade_count, signal_count, total_pnl)
       VALUES ($1, $2, $2, $3, $4, $5)`,
      [req.userId, analysis, trades.rows.length, signals.rows.length, totalPnl]
    );

    // Update last analysis timestamp
    await pool.query(
      'UPDATE bot_settings SET claude_last_analysis = NOW() WHERE user_id = $1',
      [req.userId]
    );

    res.json({
      success: true,
      analysis,
      tradesAnalyzed: trades.rows.length,
      signalsAnalyzed: signals.rows.length,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('[Claude] Analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/claude/latest-feedback — return most recent stored analysis
router.get('/latest-feedback', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT analysis, created_at FROM claude_analyses
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.userId]
    );
    if (!result.rows.length) return res.json({ analysis: null });
    res.json({ analysis: result.rows[0].analysis, timestamp: result.rows[0].created_at });
  } catch (err) {
    res.json({ analysis: null });
  }
});

// GET /api/claude/history — return list of past analyses
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const result = await pool.query(
      `SELECT id, analysis AS feedback, trade_count, signal_count, total_pnl, created_at
       FROM claude_analyses WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.userId, limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

module.exports = router;
