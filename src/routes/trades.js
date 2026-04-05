const express = require('express');
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/trades - paginated trade history, all trades for user
// Optional ?session=current to scope to active session only
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;

    const result = await pool.query(`
      SELECT * FROM trades WHERE user_id = $1
      ORDER BY created_at DESC LIMIT $2 OFFSET $3
    `, [req.userId, limit, offset]);

    const count = await pool.query(
      `SELECT COUNT(*) FROM trades WHERE user_id = $1`,
      [req.userId]
    );

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

// GET /api/trades/stats — Pro metrics: Sharpe, max drawdown, expectancy, profit factor, streak
router.get('/stats', async (req, res) => {
  try {
    // Fetch all resolved trades ordered by time
    const result = await pool.query(`
      SELECT pnl, result, created_at, trade_size AS size
      FROM trades
      WHERE user_id = $1 AND result IS NOT NULL AND pnl IS NOT NULL
      ORDER BY created_at ASC
    `, [req.userId]);

    const trades = result.rows;
    if (!trades.length) {
      return res.json({ sharpe: 0, max_drawdown: 0, expectancy: 0,
        win_streak: 0, loss_streak: 0, total_trades: 0, profit_factor: 0,
        avg_win: 0, avg_loss: 0, win_rate: 0 });
    }

    // Expectancy = (winRate * avgWin) - (lossRate * avgLoss)
    const wins = trades.filter(t => t.result === 'WIN');
    const losses = trades.filter(t => t.result === 'LOSS');
    const winRate = wins.length / trades.length;
    const avgWin = wins.length > 0
      ? wins.reduce((s, t) => s + parseFloat(t.pnl), 0) / wins.length
      : 0;
    const avgLoss = losses.length > 0
      ? Math.abs(losses.reduce((s, t) => s + parseFloat(t.pnl), 0) / losses.length)
      : 0;
    const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

    // Sharpe Ratio = mean(returns) / std(returns) * sqrt(N)
    const pnls = trades.map(t => parseFloat(t.pnl));
    const mean = pnls.reduce((s, p) => s + p, 0) / pnls.length;
    const variance = pnls.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / pnls.length;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(pnls.length) : 0;

    // Max Drawdown: peak-to-trough on cumulative P&L curve
    let peak = 0, cumPnl = 0, maxDrawdown = 0;
    for (const pnl of pnls) {
      cumPnl += pnl;
      if (cumPnl > peak) peak = cumPnl;
      const drawdown = peak - cumPnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    // Current streak
    let winStreak = 0, lossStreak = 0;
    for (let i = trades.length - 1; i >= 0; i--) {
      if (trades[i].result === 'WIN') {
        if (lossStreak === 0) winStreak++;
        else break;
      } else {
        if (winStreak === 0) lossStreak++;
        else break;
      }
    }

    // Profit factor = gross wins / gross losses
    const grossWins = wins.reduce((s, t) => s + parseFloat(t.pnl), 0);
    const grossLosses = Math.abs(losses.reduce((s, t) => s + parseFloat(t.pnl), 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

    res.json({
      sharpe: parseFloat(sharpe.toFixed(3)),
      max_drawdown: parseFloat(maxDrawdown.toFixed(2)),
      expectancy: parseFloat(expectancy.toFixed(3)),
      win_streak: winStreak,
      loss_streak: lossStreak,
      profit_factor: parseFloat(Math.min(profitFactor, 99).toFixed(2)),
      avg_win: parseFloat(avgWin.toFixed(2)),
      avg_loss: parseFloat(avgLoss.toFixed(2)),
      total_trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      win_rate: parseFloat((winRate * 100).toFixed(1)),
      total_pnl: parseFloat(pnls.reduce((s, p) => s + p, 0).toFixed(2)),
      gross_wins: parseFloat(grossWins.toFixed(2)),
      gross_losses: parseFloat(grossLosses.toFixed(2))
    });
  } catch(err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/trades/audit — find phantom P&L sources
router.get('/audit', async (req, res) => {
  try {
    const suspicious = await pool.query(`
      SELECT id, created_at, direction, entry_price, trade_size AS size, pnl, result, signal_confidence, ev_adj
      FROM trades WHERE user_id = $1 AND ABS(COALESCE(pnl,0)) > 10
      ORDER BY ABS(pnl) DESC LIMIT 50
    `, [req.userId]);

    const totals = await pool.query(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(pnl), 0) as total_pnl,
        COALESCE(SUM(pnl) FILTER (WHERE ABS(pnl) < 100000), 0) as clean_pnl,
        COALESCE(SUM(pnl) FILTER (WHERE ABS(pnl) >= 100000), 0) as phantom_pnl,
        COUNT(*) FILTER (WHERE ABS(pnl) >= 100000) as phantom_count,
        COUNT(*) FILTER (WHERE ABS(pnl) >= 10) as suspicious_count
      FROM trades WHERE user_id = $1
    `, [req.userId]);

    res.json({ suspicious_trades: suspicious.rows, totals: totals.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trades/sessions - session history list
router.get('/sessions', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        s.id, s.started_at, s.ended_at, s.paper_trading,
        s.initial_balance, s.final_balance, s.total_trades,
        s.wins, s.losses, s.total_pnl, s.win_rate,
        EXTRACT(EPOCH FROM (COALESCE(s.ended_at, NOW()) - s.started_at)) AS duration_sec
      FROM trading_sessions s
      WHERE s.user_id = $1
      ORDER BY s.started_at DESC
      LIMIT 50
    `, [req.userId]);
    res.json({ sessions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
