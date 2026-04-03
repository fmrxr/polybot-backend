const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

const ALLOWED_COPY_TARGET_FIELDS = ['label', 'multiplier', 'max_trade_size', 'is_active', 'min_whale_score'];

// --- Add Copy Target ---
router.post('/targets', authMiddleware, async (req, res) => {
  try {
    const { wallet_address, label, multiplier, max_trade_size, min_whale_score } = req.body;

    if (!wallet_address) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    const result = await pool.query(`
      INSERT INTO copy_targets (user_id, wallet_address, label, multiplier, max_trade_size, min_whale_score)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      req.userId,
      wallet_address,
      label || null,
      multiplier || 1.0,
      max_trade_size || 100.0,
      min_whale_score || 0.5
    ]);

    res.status(201).json({ target: result.rows[0] });
  } catch (err) {
    console.error('[Copy] Add target error:', err.message);
    res.status(500).json({ error: 'Failed to add copy target' });
  }
});

// --- Get Copy Targets ---
router.get('/targets', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM copy_targets WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json({ targets: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch copy targets' });
  }
});

// --- Update Copy Target (with field whitelist) ---
router.patch('/targets/:id', authMiddleware, async (req, res) => {
  try {
    const targetId = req.params.id;

    // Whitelist: only allow known fields
    const updates = {};
    for (const [key, value] of Object.entries(req.body)) {
      if (ALLOWED_COPY_TARGET_FIELDS.includes(key)) {
        updates[key] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Build parameterized SET clause
    const keys = Object.keys(updates);
    const values = Object.values(updates);
    const setClauses = keys.map((key, i) => `${key} = $${i + 3}`);

    const result = await pool.query(
      `UPDATE copy_targets SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
      [targetId, req.userId, ...values]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Copy target not found' });
    }

    res.json({ target: result.rows[0] });
  } catch (err) {
    console.error('[Copy] Update target error:', err.message);
    res.status(500).json({ error: 'Failed to update copy target' });
  }
});

// --- Delete Copy Target ---
router.delete('/targets/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM copy_targets WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Copy target not found' });
    }

    res.json({ message: 'Copy target deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete copy target' });
  }
});

// --- Start Copy Bot ---
router.post('/start', authMiddleware, async (req, res) => {
  try {
    const botManager = req.app.locals.botManager;

    if (botManager.isCopyRunning(req.userId)) {
      return res.status(400).json({ error: 'Copy bot already running' });
    }

    const settings = await pool.query('SELECT * FROM bot_settings WHERE user_id = $1', [req.userId]);
    if (settings.rows.length === 0) {
      return res.status(404).json({ error: 'Settings not found' });
    }

    await botManager.startCopyBot(req.userId, settings.rows[0]);
    await pool.query('UPDATE bot_settings SET copy_bot_active = true WHERE user_id = $1', [req.userId]);

    res.json({ message: 'Copy bot started' });
  } catch (err) {
    console.error('[Copy] Start error:', err.message);
    res.status(500).json({ error: `Failed to start copy bot: ${err.message}` });
  }
});

// --- Stop Copy Bot ---
router.post('/stop', authMiddleware, async (req, res) => {
  try {
    const botManager = req.app.locals.botManager;

    await botManager.stopCopyBot(req.userId);
    await pool.query('UPDATE bot_settings SET copy_bot_active = false WHERE user_id = $1', [req.userId]);

    res.json({ message: 'Copy bot stopped' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop copy bot' });
  }
});

// --- Copy Trade Stats ---
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM trades WHERE user_id = $1 AND trade_type = $2',
      [req.userId, 'copy']
    );

    const pnlResult = await pool.query(
      'SELECT COALESCE(SUM(pnl), 0) as total_pnl FROM trades WHERE user_id = $1 AND trade_type = $2 AND status = $3',
      [req.userId, 'copy', 'closed']
    );

    res.json({
      totalCopyTrades: parseInt(countResult.rows[0].count),
      totalPnl: parseFloat(pnlResult.rows[0].total_pnl)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch copy stats' });
  }
});

module.exports = router;
