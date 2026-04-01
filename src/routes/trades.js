const express = require('express');
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/trades - paginated trade history
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;

    const result = await pool.query(`
      SELECT * FROM trades WHERE user_id = $1
      ORDER BY created_at DESC LIMIT $2 OFFSET $3
    `, [req.userId, limit, offset]);

    const count = await pool.query('SELECT COUNT(*) FROM trades WHERE user_id = $1', [req.userId]);

    res.json({
      trades: result.rows,
      total: parseInt(count.rows[0].count),
      page,
      pages: Math.ceil(count.rows[0].count / limit)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/trades/curve - P&L curve data for chart
router.get('/curve', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        created_at,
        pnl,
        result,
        direction,
        SUM(pnl) OVER (ORDER BY created_at ASC ROWS UNBOUNDED PRECEDING) as cumulative_pnl
      FROM trades WHERE user_id = $1 AND pnl IS NOT NULL
      ORDER BY created_at ASC
    `, [req.userId]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/trades/breakdown - performance by direction and market prob
router.get('/breakdown', async (req, res) => {
  try {
    const byDirection = await pool.query(`
      SELECT
        direction,
        COUNT(*) as trades,
        COUNT(*) FILTER (WHERE result = 'WIN') as wins,
        ROUND(COUNT(*) FILTER (WHERE result = 'WIN') * 100.0 / NULLIF(COUNT(*), 0), 1) as win_rate,
        COALESCE(SUM(pnl), 0) as pnl
      FROM trades WHERE user_id = $1 AND result IS NOT NULL
      GROUP BY direction
    `, [req.userId]);

    const byProb = await pool.query(`
      SELECT
        CASE
          WHEN market_prob < 0.30 THEN '< 30%'
          WHEN market_prob < 0.40 THEN '30-40%'
          WHEN market_prob < 0.50 THEN '40-50%'
          WHEN market_prob < 0.60 THEN '50-60%'
          ELSE '60%+'
        END as prob_range,
        COUNT(*) as trades,
        ROUND(COUNT(*) FILTER (WHERE result = 'WIN') * 100.0 / NULLIF(COUNT(*), 0), 1) as win_rate,
        COALESCE(SUM(pnl), 0) as pnl
      FROM trades WHERE user_id = $1 AND result IS NOT NULL
      GROUP BY prob_range
      ORDER BY MIN(market_prob)
    `, [req.userId]);

    const byExitReason = await pool.query(`
      SELECT
        COALESCE(exit_reason, 'resolved') as exit_reason,
        COUNT(*) as count,
        ROUND(AVG(pnl), 2) as avg_pnl
      FROM trades WHERE user_id = $1 AND result IS NOT NULL
      GROUP BY exit_reason
      ORDER BY CASE WHEN exit_reason = 'auto_closed_profit' THEN 0 WHEN exit_reason = 'auto_closed_loss' THEN 1 ELSE 2 END
    `, [req.userId]);

    res.json({ by_direction: byDirection.rows, by_prob: byProb.rows, by_exit_reason: byExitReason.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
