const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { pool } = require('../models/db');

const router = express.Router();
router.use(authMiddleware);

// POST /api/copy/targets — add a copy target
router.post('/targets', async (req, res) => {
  const { target_address, label, multiplier, max_trade_size } = req.body;

  if (!target_address || !target_address.match(/^0x[0-9a-f]{40}$/i)) {
    return res.status(400).json({ error: 'Invalid Ethereum address' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO copy_targets (user_id, target_address, label, multiplier, max_trade_size)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(user_id, target_address) DO UPDATE SET label=EXCLUDED.label, multiplier=EXCLUDED.multiplier, max_trade_size=EXCLUDED.max_trade_size
       RETURNING *`,
      [req.userId, target_address.toLowerCase(), label || null, multiplier || 1.0, max_trade_size || 20.0]
    );
    res.status(201).json(result.rows[0]);
  } catch(err) {
    console.error('Add target error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/copy/targets — list user's copy targets
router.get('/targets', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, target_address, label, is_active, multiplier, max_trade_size, created_at
       FROM copy_targets WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ targets: result.rows });
  } catch(err) {
    console.error('List targets error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/copy/targets/:id — update a copy target
router.patch('/targets/:id', async (req, res) => {
  const { label, multiplier, max_trade_size, is_active } = req.body;
  const targetId = parseInt(req.params.id);

  try {
    const updates = [];
    const values = [req.userId, targetId];
    let paramIndex = 3;

    if (label !== undefined) {
      updates.push(`label=$${paramIndex++}`);
      values.push(label);
    }
    if (multiplier !== undefined) {
      updates.push(`multiplier=$${paramIndex++}`);
      values.push(Math.max(0.1, Math.min(10.0, multiplier)));
    }
    if (max_trade_size !== undefined) {
      updates.push(`max_trade_size=$${paramIndex++}`);
      values.push(max_trade_size);
    }
    if (is_active !== undefined) {
      updates.push(`is_active=$${paramIndex++}`);
      values.push(is_active);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const result = await pool.query(
      `UPDATE copy_targets SET ${updates.join(', ')} WHERE id=$1 AND user_id=$2 RETURNING *`,
      [targetId, ...values.slice(2)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Target not found' });
    }
    res.json(result.rows[0]);
  } catch(err) {
    console.error('Update target error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/copy/targets/:id — remove a copy target
router.delete('/targets/:id', async (req, res) => {
  const targetId = parseInt(req.params.id);

  try {
    const result = await pool.query(
      'DELETE FROM copy_targets WHERE id=$1 AND user_id=$2 RETURNING id',
      [targetId, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Target not found' });
    }
    res.json({ success: true });
  } catch(err) {
    console.error('Delete target error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/copy/start — start copy bot
router.post('/start', async (req, res) => {
  try {
    if (global.botManager.isCopyRunning(req.userId)) {
      return res.status(409).json({ error: 'Copy bot already running' });
    }

    // Load settings
    const settingsResult = await pool.query('SELECT * FROM bot_settings WHERE user_id=$1', [req.userId]);
    if (settingsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No bot settings found' });
    }

    const settings = settingsResult.rows[0];
    if (!settings.encrypted_private_key) {
      return res.status(400).json({ error: 'Private key not configured' });
    }

    await global.botManager.startCopyBot(req.userId, settings);
    res.json({ success: true, message: 'Copy bot started' });
  } catch(err) {
    console.error('Start copy bot error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// POST /api/copy/stop — stop copy bot
router.post('/stop', async (req, res) => {
  try {
    await global.botManager.stopCopyBot(req.userId);
    res.json({ success: true, message: 'Copy bot stopped' });
  } catch(err) {
    console.error('Stop copy bot error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/copy/status — copy bot status
router.get('/status', (req, res) => {
  const status = global.botManager.getCopyStatus(req.userId);
  res.json(status);
});

// GET /api/copy/trades — get user's copied trades
router.get('/trades', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const [trades, count] = await Promise.all([
      pool.query(
        `SELECT id, condition_id, direction, entry_price, size, market_prob, result, pnl, copy_source, created_at
         FROM trades WHERE user_id=$1 AND trade_type='copy'
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [req.userId, limit, offset]
      ),
      pool.query('SELECT COUNT(*) as count FROM trades WHERE user_id=$1 AND trade_type=\'copy\'', [req.userId])
    ]);

    const total = parseInt(count.rows[0].count);
    res.json({
      trades: trades.rows,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    });
  } catch(err) {
    console.error('Get copy trades error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
