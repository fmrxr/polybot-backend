const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

// --- Start Signal Bot ---
router.post('/start', authMiddleware, async (req, res) => {
  try {
    const botManager = req.app.locals.botManager;

    const settings = await pool.query('SELECT * FROM bot_settings WHERE user_id = $1', [req.userId]);
    if (settings.rows.length === 0) {
      return res.status(404).json({ error: 'Bot settings not found' });
    }

    // Always restart — stop existing instance first if running
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
    await botManager.stopBot(req.userId);
    // Always succeeds — idempotent
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
      chainlinkPrice: status?.chainlinkPrice || null,
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

// --- Get Decisions (alias for signals, used by signal monitor) ---
router.get('/decisions', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);

    const result = await pool.query(
      'SELECT * FROM signals WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [req.userId, limit]
    );

    // Normalise field names so the frontend can read them uniformly
    const rows = result.rows.map(r => ({
      ...r,
      verdict:    r.verdict,
      direction:  r.direction,
      reason:     r.reason,
      // expose gate data under 'data' key so renderSignals() can read d.gate_failed etc.
      data: {
        ev_adjusted:  r.ev_adj,
        spread_pct:   r.spread_pct  || null,
        lag_age_sec:  r.lag_age_sec || null,
        gate_failed:  r.gate_failed || null,
        gate1_passed: r.gate1_passed,
        gate2_passed: r.gate2_passed,
        gate3_passed: r.gate3_passed,
      }
    }));

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch decisions' });
  }
});

// --- Gate Stats (signal monitor summary) ---
router.get('/gate-stats', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)                                                        AS total,
        COUNT(*) FILTER (WHERE verdict = 'TRADE')                      AS trade_count,
        COUNT(*) FILTER (WHERE verdict = 'SKIP')                       AS skip_count,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(COUNT(*) FILTER (WHERE verdict='SKIP')::numeric / COUNT(*) * 100, 1)
          ELSE 0 END                                                    AS skip_rate,
        ROUND(AVG(ev_adj)       FILTER (WHERE ev_adj       IS NOT NULL), 2)  AS avg_ev_adj,
        ROUND(AVG(confidence)   FILTER (WHERE confidence   IS NOT NULL), 3)  AS avg_gate1_conf,
        ROUND(AVG(lag_age_sec)  FILTER (WHERE lag_age_sec  IS NOT NULL), 1)  AS avg_lag_age,
        ROUND(AVG(spread_pct)   FILTER (WHERE spread_pct   IS NOT NULL), 3)  AS avg_spread_pct,
        ROUND(
          COUNT(*) FILTER (WHERE gate1_passed = true)::numeric /
          NULLIF(COUNT(*), 0) * 100, 1)                                AS gate1_rate,
        ROUND(
          COUNT(*) FILTER (WHERE gate2_passed = true)::numeric /
          NULLIF(COUNT(*), 0) * 100, 1)                                AS gate2_pass_rate,
        ROUND(
          (100 - COUNT(*) FILTER (WHERE verdict='SKIP')::numeric /
          NULLIF(COUNT(*), 0) * 100), 1)                               AS avg_total_cost,
        COUNT(*) FILTER (WHERE gate_failed = 0.2)                      AS skip_lag,
        COUNT(*) FILTER (WHERE gate_failed = 0.3)                      AS skip_chase,
        COUNT(*) FILTER (WHERE gate_failed = 0.4)                      AS skip_ev_trend,
        COUNT(*) FILTER (WHERE gate_failed = 1)                        AS skip_gate1,
        COUNT(*) FILTER (WHERE gate_failed = 1.5)                      AS skip_gate1_5,
        COUNT(*) FILTER (WHERE gate_failed = 2 OR gate_failed = 2.5)   AS skip_gate2,
        COUNT(*) FILTER (WHERE gate_failed = 3)                        AS skip_gate3,
        MAX(created_at)                                                 AS last_decision_at
      FROM signals
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
    `, [req.userId]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[gate-stats]', err.message);
    res.status(500).json({ error: 'Failed to fetch gate stats' });
  }
});

// ─── Real-time SSE stream ───────────────────────────────────────────────────
// Pushes bot state snapshots every 200ms without polling.
// Frontend: const es = new EventSource('/api/bot/stream?token=<jwt>')
router.get('/stream', authMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/Railway buffering
  res.flushHeaders();

  const botManager = req.app.locals.botManager;
  const bot = botManager.getBot(req.userId);

  if (!bot) {
    res.write(`data: ${JSON.stringify({ error: 'Bot not running', ts: Date.now() })}\n\n`);
    // Keep connection open so client can reconnect when bot starts
    const retry = setInterval(() => {
      const b = botManager.getBot(req.userId);
      if (b) {
        clearInterval(retry);
        attach(b);
      } else {
        res.write(`data: ${JSON.stringify({ error: 'Bot not running', ts: Date.now() })}\n\n`);
      }
    }, 2000);
    req.on('close', () => clearInterval(retry));
    return;
  }

  // Keepalive comment every 15s — prevents Railway HTTP/2 proxy from dropping idle streams
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (_) { clearInterval(keepalive); }
  }, 15000);

  req.on('close', () => clearInterval(keepalive));

  attach(bot);

  function attach(b) {
    const onState = (state) => {
      try { res.write(`data: ${JSON.stringify(state)}\n\n`); } catch (_) {}
    };
    b.streamEmitter.on('state', onState);
    if (b._lastStreamState?.ts) {
      try { res.write(`data: ${JSON.stringify(b._lastStreamState)}\n\n`); } catch (_) {}
    }
    req.on('close', () => b.streamEmitter.off('state', onState));
  }
});

// ─── Paper Lab Analytics ────────────────────────────────────────────────────
router.get('/analytics', authMiddleware, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;

    // All closed trades in window
    const tradesRes = await pool.query(`
      SELECT id, direction, entry_price, exit_price,
             COALESCE(trade_size, size) AS trade_size,
             pnl, result, close_reason, signal_confidence,
             ev_adj, gate1_score, gate2_score, gate3_score,
             created_at, closed_at
      FROM trades
      WHERE user_id = $1
        AND status = 'closed'
        AND created_at > NOW() - ($2 || ' days')::INTERVAL
        AND COALESCE(trade_size, size) IS NOT NULL
        AND COALESCE(trade_size, size) > 0
      ORDER BY created_at ASC
    `, [req.userId, days]);

    const trades = tradesRes.rows;

    // Open trades
    const openRes = await pool.query(`
      SELECT id, direction, entry_price, COALESCE(trade_size, size) AS trade_size,
             signal_confidence, ev_adj, created_at, market_question
      FROM trades WHERE user_id=$1 AND status='open'
    `, [req.userId]);

    if (!trades.length) {
      return res.json({
        summary: { total: 0, wins: 0, losses: 0, win_rate: 0, total_pnl: 0, avg_pnl: 0, best: 0, worst: 0, sharpe: 0, max_drawdown: 0, profit_factor: 0, expectancy: 0, avg_win: 0, avg_loss: 0 },
        pnl_curve: [],
        by_direction: [],
        by_exit_reason: [],
        by_ev_bucket: [],
        by_hour: [],
        open_trades: openRes.rows,
        total_open: openRes.rows.length
      });
    }

    const pnls = trades.map(t => parseFloat(t.pnl));
    const wins = trades.filter(t => t.result === 'WIN');
    const losses = trades.filter(t => t.result === 'LOSS');
    const totalPnl = pnls.reduce((s, p) => s + p, 0);
    const winRate = trades.length > 0 ? wins.length / trades.length : 0;
    const avgWin = wins.length ? wins.reduce((s,t)=>s+parseFloat(t.pnl),0)/wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s,t)=>s+parseFloat(t.pnl),0)/losses.length) : 0;

    // Sharpe
    const mean = totalPnl / pnls.length;
    const variance = pnls.reduce((s,p)=>s+Math.pow(p-mean,2),0)/pnls.length;
    const sharpe = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(pnls.length) : 0;

    // Max drawdown
    let peak = 0, cum = 0, maxDD = 0;
    for (const p of pnls) { cum += p; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDD) maxDD = dd; }

    const grossWins = wins.reduce((s,t)=>s+parseFloat(t.pnl),0);
    const grossLoss = Math.abs(losses.reduce((s,t)=>s+parseFloat(t.pnl),0));
    const profitFactor = grossLoss > 0 ? Math.min(grossWins/grossLoss, 99) : grossWins > 0 ? 99 : 0;
    const expectancy = winRate * avgWin - (1-winRate) * avgLoss;

    // P&L curve
    let runningPnl = 0;
    const pnlCurve = trades.map(t => {
      runningPnl += parseFloat(t.pnl);
      return { ts: t.closed_at || t.created_at, pnl: parseFloat(t.pnl), cumPnl: parseFloat(runningPnl.toFixed(2)), result: t.result };
    });

    // By direction
    const byDir = {};
    for (const t of trades) {
      if (!byDir[t.direction]) byDir[t.direction] = { trades:0, wins:0, pnl:0 };
      byDir[t.direction].trades++;
      if (t.result==='WIN') byDir[t.direction].wins++;
      byDir[t.direction].pnl += parseFloat(t.pnl);
    }

    // By exit reason
    const byReason = {};
    for (const t of trades) {
      const r = t.close_reason || 'resolved';
      if (!byReason[r]) byReason[r] = { count:0, pnl:0, wins:0 };
      byReason[r].count++;
      byReason[r].pnl += parseFloat(t.pnl);
      if (t.result==='WIN') byReason[r].wins++;
    }

    // By EV bucket
    const evBuckets = { '<0%':[], '0-2%':[], '2-5%':[], '5-10%':[], '>10%':[] };
    for (const t of trades) {
      const ev = parseFloat(t.ev_adj || 0);
      const p = parseFloat(t.pnl);
      if (ev < 0) evBuckets['<0%'].push(p);
      else if (ev < 2) evBuckets['0-2%'].push(p);
      else if (ev < 5) evBuckets['2-5%'].push(p);
      else if (ev < 10) evBuckets['5-10%'].push(p);
      else evBuckets['>10%'].push(p);
    }

    // By hour of day
    const byHour = {};
    for (const t of trades) {
      const h = new Date(t.created_at).getUTCHours();
      if (!byHour[h]) byHour[h] = { trades:0, pnl:0, wins:0 };
      byHour[h].trades++;
      byHour[h].pnl += parseFloat(t.pnl);
      if (t.result==='WIN') byHour[h].wins++;
    }

    res.json({
      summary: {
        total: trades.length,
        wins: wins.length,
        losses: losses.length,
        win_rate: parseFloat((winRate*100).toFixed(1)),
        total_pnl: parseFloat(totalPnl.toFixed(2)),
        avg_pnl: parseFloat((totalPnl/trades.length).toFixed(2)),
        best: parseFloat(Math.max(...pnls).toFixed(2)),
        worst: parseFloat(Math.min(...pnls).toFixed(2)),
        sharpe: parseFloat(sharpe.toFixed(3)),
        max_drawdown: parseFloat(maxDD.toFixed(2)),
        profit_factor: parseFloat(profitFactor.toFixed(2)),
        expectancy: parseFloat(expectancy.toFixed(2)),
        avg_win: parseFloat(avgWin.toFixed(2)),
        avg_loss: parseFloat(avgLoss.toFixed(2))
      },
      pnl_curve: pnlCurve,
      by_direction: Object.entries(byDir).map(([dir,v])=>({ dir, ...v, win_rate: v.trades>0?(v.wins/v.trades*100).toFixed(1):'0', pnl: v.pnl.toFixed(2) })),
      by_exit_reason: Object.entries(byReason).map(([reason,v])=>({ reason, ...v, win_rate: v.count>0?(v.wins/v.count*100).toFixed(1):'0', pnl: v.pnl.toFixed(2) })).sort((a,b)=>b.count-a.count),
      by_ev_bucket: Object.entries(evBuckets).map(([bucket,ps])=>({ bucket, count:ps.length, pnl: ps.reduce((s,p)=>s+p,0).toFixed(2), win_rate: ps.length>0?(ps.filter(p=>p>0).length/ps.length*100).toFixed(1):'0' })),
      by_hour: Object.entries(byHour).map(([h,v])=>({ hour:parseInt(h), ...v, win_rate: v.trades>0?(v.wins/v.trades*100).toFixed(1):'0', pnl: v.pnl.toFixed(2) })).sort((a,b)=>a.hour-b.hour),
      open_trades: openRes.rows,
      total_open: openRes.rows.length,
      days
    });
  } catch(err) {
    console.error('[analytics]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Polling fallback: GET /live-state ─────────────────────────────────────
// Returns last snapshot synchronously for clients that can't use SSE.
router.get('/live-state', authMiddleware, (req, res) => {
  const botManager = req.app.locals.botManager;
  const bot = botManager.getBot(req.userId);
  if (!bot) return res.json({ error: 'Bot not running', ts: Date.now() });
  res.json(bot._lastStreamState || { ts: Date.now(), isRunning: false });
});

module.exports = router;
