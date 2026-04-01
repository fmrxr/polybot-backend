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

    // Get recent trades for analysis
    const tradesResult = await pool.query(`
      SELECT
        direction, entry_price, size, model_prob, market_prob,
        expected_value, result, pnl, created_at
      FROM trades
      WHERE user_id = $1 AND result IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 100
    `, [req.userId]);

    const trades = tradesResult.rows;

    if (trades.length === 0) {
      return res.status(400).json({ error: 'No completed trades to analyze' });
    }

    // Calculate statistics
    const winTrades = trades.filter(t => t.result === 'WIN').length;
    const lossTrades = trades.filter(t => t.result === 'LOSS').length;
    const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const avgPnL = totalPnL / trades.length;
    const winRate = (winTrades / trades.length * 100).toFixed(1);

    // Build prompt for Claude
    const analysisPrompt = `You are an expert trading strategy analyst. I've executed ${trades.length} trades with the following results:

Trade Statistics:
- Win Rate: ${winRate}%
- Total Wins: ${winTrades}
- Total Losses: ${lossTrades}
- Total P&L: $${totalPnL.toFixed(2)}
- Average P&L per trade: $${avgPnL.toFixed(2)}
- Average Entry Probability: ${(trades.reduce((sum, t) => sum + t.model_prob, 0) / trades.length * 100).toFixed(1)}%

Recent Trade Details:
${trades.slice(0, 10).map((t, i) => `
Trade ${i + 1}: ${t.direction} @ $${parseFloat(t.entry_price).toFixed(3)}
- Result: ${t.result} (P&L: $${t.pnl.toFixed(2)})
- Model Prob: ${(t.model_prob * 100).toFixed(1)}% | Market: ${(t.market_prob * 100).toFixed(1)}%
- Expected Value: ${(t.expected_value * 100).toFixed(2)}%
`).join('\n')}

Based on this data, please provide:
1. Key findings about the trading performance
2. Patterns you notice (positive or negative)
3. Specific recommendations to improve edge quality
4. Risk management observations
5. Next steps for optimization

Focus on actionable insights for Phase A real edge testing.`;

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
        max_tokens: 1024,
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
      JSON.stringify({ trades_count: trades.length, win_rate: winRate, total_pnl: totalPnL }),
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
