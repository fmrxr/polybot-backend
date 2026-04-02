const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const authMiddleware = require('../middleware/auth');

// --- Start Signal Bot ---
router.post('/start', authMiddleware, async (req, res) => {
  try {
    const botManager = req.app.locals.botManager;

    if (botManager.isRunning(req.userId)) {
      return res.status(400).json({ error: 'Bot is already running' });
    }

    const settings = await pool.query('SELECT * FROM bot_settings WHERE user_id = $1', [req.userId]);
    if (settings.rows.length === 0) {
      return res.status(404).json({ error: 'Bot settings not found' });
    }

    await botManager.startBot(req.userId, settings.rows[0]);

    res.json({ message: 'Bot started successfully', status: 'running' });
  } catch (err) {
    console.error(`[Bot Route] Start error for user ${req.userId}:`, err.message);
    res.status(500).json({ error: `Failed to start bot: ${err.message}` });
  }
});

// --- Stop Signal Bot ---
router.post('/stop', authMiddleware, async (req, res) => {
  try {
    const botManager = req.app.locals.botManager;

    if (!botManager.isRunning(req.userId)) {
      return res.status(400).json({ error: 'Bot is not running' });
    }

    await botManager.stopBot(req.userId);

    res.json({ message: 'Bot stopped successfully', status: 'stopped' });
  } catch (err) {
    console.error(`[Bot Route] Stop error for user ${req.userId}:`, err.message);
    res.status(500).json({ error: `Failed to stop bot: ${err.message}` });
  }
});

// --- Bot Status ---
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const botManager = req.app.locals.botManager;
    const status = botManager.getBotStatus(req.userId);

    // Get trade stats
    const tradeStats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'open') AS open_trades,
        COUNT(*) FILTER (WHERE status = 'closed') AS closed_trades,
        COALESCE(SUM(pnl) FILTER (WHERE status = 'closed'), 0) AS total_pnl,
        COALESCE(SUM(pnl) FILTER (WHERE status = 'closed' AND closed_at > NOW() - INTERVAL '24 hours'), 0) AS daily_pnl,
        COUNT(*) FILTER (WHERE status = 'closed' AND pnl > 0) AS wins,
        COUNT(*) FILTER (WHERE status = 'closed' AND pnl <= 0) AS losses
      FROM trades 
      WHERE user_id = $1 AND trade_type = $2
    `, [req.userId, 'signal']);

    const stats = tradeStats.rows[0];

    res.json({
      botRunning: status?.isRunning || false,
      paperTrading: status?.paperTrading ?? true,
      paperBalance: status?.paperBalance || null,
      btcPrice: status?.btcPrice || null,
      peakBalance: status?.peakBalance || null,
      drawdownCooldownUntil: status?.drawdownCooldownUntil || null,
      trades: {
        open: parseInt(stats.open_trades),
        closed: parseInt(stats.closed_trades),
        totalPnl: parseFloat(stats.total_pnl),
        dailyPnl: parseFloat(stats.daily_pnl),
        wins: parseInt(stats.wins),
        losses: parseInt(stats.losses),
        winRate: parseInt(stats.closed_trades) > 0
          ? (parseInt(stats.wins) / parseInt(stats.closed_trades) * 100).toFixed(1)
          : '0.0'
      },
      recentLogs: status?.recentLogs || []
    });
  } catch (err) {
    console.error(`[Bot Route] Status error for user ${req.userId}:`, err.message);
    res.status(500).json({ error: 'Failed to get bot status' });
  }
});

// --- Get Trades ---
router.get('/trades', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const result = await pool.query(
      'SELECT * FROM trades WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [req.userId, limit, offset]
    );

    res.json({ trades: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trades' });
  }
});

// --- Get Signals ---
router.get('/signals', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const result = await pool.query(
      'SELECT * FROM signals WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [req.userId, limit]
    );

    res.json({ signals: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

module.exports = router;
