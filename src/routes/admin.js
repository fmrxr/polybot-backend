const express = require('express');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { pool } = require('../models/db');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// Helper to log admin actions
async function logAdminAction(adminId, action, targetUserId = null, details = null) {
  try {
    await pool.query(
      'INSERT INTO admin_logs (admin_id, action, target_user_id, details) VALUES ($1, $2, $3, $4)',
      [adminId, action, targetUserId, details]
    );
  } catch (e) {
    console.error('Admin log error:', e.message);
  }
}

// GET /api/admin/analytics — Platform-wide stats
router.get('/analytics', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(DISTINCT u.id) as total_users,
        COUNT(DISTINCT CASE WHEN bs.is_active THEN bs.user_id END) as active_bots,
        COUNT(DISTINCT t.user_id) as active_traders,
        COUNT(t.id) as total_trades,
        COALESCE(SUM(t.pnl), 0) as total_pnl,
        COALESCE(SUM(t.pnl) FILTER (WHERE t.created_at >= NOW() - INTERVAL '24h'), 0) as pnl_24h,
        COUNT(t.id) FILTER (WHERE t.created_at >= NOW() - INTERVAL '24h') as trades_24h,
        COUNT(t.id) FILTER (WHERE t.result='WIN')::float / NULLIF(COUNT(t.id) FILTER (WHERE t.result IS NOT NULL), 0) * 100 as platform_win_rate
      FROM users u
      LEFT JOIN bot_settings bs ON bs.user_id = u.id
      LEFT JOIN trades t ON t.user_id = u.id
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/users — List all users with stats
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id, u.email, u.is_admin, u.created_at,
        bs.is_active, bs.paper_trading, bs.polymarket_wallet_address, bs.max_trade_size,
        COUNT(t.id) as trade_count,
        COUNT(t.id) FILTER (WHERE t.result='WIN') as wins,
        COUNT(t.id) FILTER (WHERE t.result='LOSS') as losses,
        COALESCE(SUM(t.pnl), 0) as total_pnl,
        CASE
          WHEN COUNT(t.id) FILTER (WHERE t.result IS NOT NULL) > 0
          THEN COUNT(t.id) FILTER (WHERE t.result='WIN')::float / COUNT(t.id) FILTER (WHERE t.result IS NOT NULL) * 100
          ELSE 0
        END as win_rate
      FROM users u
      LEFT JOIN bot_settings bs ON bs.user_id = u.id
      LEFT JOIN trades t ON t.user_id = u.id
      GROUP BY u.id, bs.id
      ORDER BY u.created_at DESC
    `);
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Users list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/users/:id — Single user detail
router.get('/users/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id, u.email, u.is_admin, u.created_at,
        bs.is_active, bs.paper_trading, bs.polymarket_wallet_address, bs.max_trade_size, bs.max_daily_loss, bs.kelly_cap,
        COUNT(t.id) as trade_count,
        COALESCE(SUM(t.pnl), 0) as total_pnl
      FROM users u
      LEFT JOIN bot_settings bs ON bs.user_id = u.id
      LEFT JOIN trades t ON t.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id, bs.is_active, bs.paper_trading, bs.polymarket_wallet_address, bs.max_trade_size, bs.max_daily_loss, bs.kelly_cap
    `, [req.params.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/users/:id/toggle-bot — Start/stop any user's bot
router.post('/users/:id/toggle-bot', async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const settings = await pool.query('SELECT is_active FROM bot_settings WHERE user_id = $1', [targetId]);

    if (!settings.rows[0]) return res.status(404).json({ error: 'Bot settings not found' });

    const newActive = !settings.rows[0].is_active;
    await pool.query('UPDATE bot_settings SET is_active = $1 WHERE user_id = $2', [newActive, targetId]);

    const botManager = global.botManager;
    if (newActive && botManager) {
      try {
        const botSettings = await pool.query(
          `SELECT bs.*, u.email AS user_email FROM bot_settings bs JOIN users u ON u.id = bs.user_id WHERE bs.user_id = $1`,
          [targetId]
        );
        await botManager.startBot(targetId, botSettings.rows[0]);
      } catch (e) {
        console.error('Bot start error:', e.message);
      }
    } else if (!newActive && botManager) {
      await botManager.stopBot(targetId);
    }

    await logAdminAction(req.userId, newActive ? 'BOT_START' : 'BOT_STOP', targetId);
    res.json({ success: true, is_active: newActive });
  } catch (err) {
    console.error('Toggle bot error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/users/:id/role — Set user role
router.post('/users/:id/role', async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const { role } = req.body;
    const allowed = ['user', 'admin', 'viewer'];
    if (!allowed.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const isAdmin = role === 'admin';
    await pool.query('UPDATE users SET role = $1, is_admin = $2 WHERE id = $3', [role, isAdmin, targetId]);
    await logAdminAction(req.userId, 'SET_ROLE', targetId, { role });
    res.json({ success: true, role });
  } catch (err) {
    console.error('Set role error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/trades — Trades for the requesting user only (paginated)
router.get('/trades', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const userId = req.userId;

    const [trades, count] = await Promise.all([
      pool.query(`
        SELECT t.*, u.email
        FROM trades t
        JOIN users u ON t.user_id = u.id
        WHERE t.user_id = $3
        ORDER BY t.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset, userId]),
      pool.query('SELECT COUNT(*) as count FROM trades WHERE user_id = $1', [userId])
    ]);

    const total = parseInt(count.rows[0].count);
    res.json({
      trades: trades.rows,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/logs — Admin action log
router.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const result = await pool.query(`
      SELECT al.*, u.email as admin_email, tu.email as target_email
      FROM admin_logs al
      LEFT JOIN users u ON al.admin_user_id = u.id
      LEFT JOIN users tu ON al.target_user_id = tu.id
      ORDER BY al.created_at DESC
      LIMIT $1
    `, [limit]);
    res.json({ logs: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
