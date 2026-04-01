const express = require('express');
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// POST /api/bot/start
router.post('/start', async (req, res) => {
  try {
    const settingsResult = await pool.query('SELECT * FROM bot_settings WHERE user_id = $1', [req.userId]);
    const settings = settingsResult.rows[0];

    if (!settings?.encrypted_private_key) {
      return res.status(400).json({ error: 'Private key not configured. Go to Settings first.' });
    }

    if (global.botManager.isRunning(req.userId)) {
      return res.status(409).json({ error: 'Bot is already running' });
    }

    const dailyResult = await pool.query(
      `SELECT COALESCE(SUM(pnl), 0) as daily_pnl FROM trades WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
      [req.userId]
    );
    if (parseFloat(dailyResult.rows[0].daily_pnl) <= -settings.max_daily_loss) {
      return res.status(400).json({ error: `Daily loss limit of $${settings.max_daily_loss} reached.` });
    }

    await global.botManager.startBot(req.userId, settings);
    await pool.query('UPDATE bot_settings SET is_active = true WHERE user_id = $1', [req.userId]);
    res.json({ success: true, message: 'Bot started successfully' });
  } catch (err) {
    console.error('Start bot error:', err);
    res.status(500).json({ error: err.message || 'Failed to start bot' });
  }
});

// POST /api/bot/stop
router.post('/stop', async (req, res) => {
  try {
    await global.botManager.stopBot(req.userId);
    await pool.query('UPDATE bot_settings SET is_active = false WHERE user_id = $1', [req.userId]);
    res.json({ success: true, message: 'Bot stopped' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop bot' });
  }
});

// GET /api/bot/status
router.get('/status', async (req, res) => {
  try {
    const isRunning = global.botManager.isRunning(req.userId);
    const status = global.botManager.getStatus(req.userId);

    const settingsResult = await pool.query(
      'SELECT is_active, max_daily_loss, paper_trading FROM bot_settings WHERE user_id = $1',
      [req.userId]
    );
    const settings = settingsResult.rows[0];

    const dailyResult = await pool.query(
      `SELECT COALESCE(SUM(pnl), 0) as daily_pnl FROM trades WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
      [req.userId]
    );

    res.json({
      is_running: isRunning,
      daily_pnl: parseFloat(dailyResult.rows[0].daily_pnl),
      max_daily_loss: settings?.max_daily_loss || 50,
      paper_trading: settings?.paper_trading !== false,
      ...status
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/bot/logs
router.get('/logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const result = await pool.query(
      'SELECT level, message, created_at FROM bot_logs WHERE user_id = $1 ORDER BY created_at ASC LIMIT $2',
      [req.userId, limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/bot/decisions
router.get('/decisions', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const result = await pool.query(
      `SELECT verdict, direction, reason, data, created_at FROM bot_decisions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.userId, limit]
    );
    res.json(result.rows);
  } catch (err) {
    // Table may not exist yet on first deploy — return empty instead of crashing
    res.json([]);
  }
});

module.exports = router;
