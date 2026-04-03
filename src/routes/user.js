const express = require('express');
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
const { encrypt, decrypt } = require('../services/encryption');

const router = express.Router();
router.use(authMiddleware);

// GET /api/user/settings
router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bot_settings WHERE user_id = $1', [req.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Settings not found' });
    const settings = result.rows[0];
    const hasKey = !!settings.encrypted_private_key;
    const hasApiKey = !!settings.encrypted_polymarket_api_key;
    const hasClaudeKey = !!settings.claude_api_key;
    delete settings.encrypted_private_key;
    delete settings.encrypted_polymarket_api_key;
    delete settings.claude_api_key;
    res.json({ ...settings, has_private_key: hasKey, has_polymarket_api_key: hasApiKey, has_claude_api_key: hasClaudeKey });
  } catch (err) {
    console.error('Settings GET error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/user/settings
router.put('/settings', async (req, res) => {
  const {
    private_key, polymarket_api_key, polymarket_wallet_address, kelly_cap, max_daily_loss, max_trade_size,
    min_ev_threshold, min_prob_diff, direction_filter,
    market_prob_min, market_prob_max, paper_trading, min_edge, snipe_before_close_sec, require_whale_convergence,
    claude_api_key, claude_model, auto_claude_analysis
  } = req.body;

  try {
    let encryptedKey = null;
    if (private_key) {
      if (!private_key.startsWith('0x') || private_key.length !== 66) {
        return res.status(400).json({ error: 'Invalid private key format (must be 0x + 64 hex chars)' });
      }
      encryptedKey = encrypt(private_key);
    }

    let encryptedApiKey = null;
    if (polymarket_api_key) {
      // Basic validation — should be non-empty
      if (polymarket_api_key.trim().length === 0) {
        return res.status(400).json({ error: 'Polymarket API key cannot be empty' });
      }
      encryptedApiKey = encrypt(polymarket_api_key);
    }

    let encryptedClaudeKey = null;
    if (claude_api_key) {
      if (claude_api_key.trim().length === 0) {
        return res.status(400).json({ error: 'Claude API key cannot be empty' });
      }
      encryptedClaudeKey = encrypt(claude_api_key);
    }

    await pool.query(`
      INSERT INTO bot_settings (user_id, encrypted_private_key, encrypted_polymarket_api_key, polymarket_wallet_address, kelly_cap, max_daily_loss, max_trade_size,
        min_ev_threshold, min_prob_diff, direction_filter, market_prob_min, market_prob_max, paper_trading, min_edge, snipe_before_close_sec, require_whale_convergence,
        claude_api_key, claude_model, auto_claude_analysis, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        encrypted_private_key = COALESCE($2, bot_settings.encrypted_private_key),
        encrypted_polymarket_api_key = COALESCE($3, bot_settings.encrypted_polymarket_api_key),
        polymarket_wallet_address = COALESCE($4, bot_settings.polymarket_wallet_address),
        kelly_cap = COALESCE($5, bot_settings.kelly_cap),
        max_daily_loss = COALESCE($6, bot_settings.max_daily_loss),
        max_trade_size = COALESCE($7, bot_settings.max_trade_size),
        min_ev_threshold = COALESCE($8, bot_settings.min_ev_threshold),
        min_prob_diff = COALESCE($9, bot_settings.min_prob_diff),
        direction_filter = COALESCE($10, bot_settings.direction_filter),
        market_prob_min = COALESCE($11, bot_settings.market_prob_min),
        market_prob_max = COALESCE($12, bot_settings.market_prob_max),
        paper_trading = COALESCE($13, bot_settings.paper_trading),
        min_edge = COALESCE($14, bot_settings.min_edge),
        snipe_before_close_sec = COALESCE($15, bot_settings.snipe_before_close_sec),
        require_whale_convergence = COALESCE($16, bot_settings.require_whale_convergence),
        claude_api_key = COALESCE($17, bot_settings.claude_api_key),
        claude_model = COALESCE($18, bot_settings.claude_model),
        auto_claude_analysis = COALESCE($19, bot_settings.auto_claude_analysis),
        updated_at = NOW()
    `, [
      req.userId, encryptedKey, encryptedApiKey, polymarket_wallet_address || null,
      kelly_cap || null, max_daily_loss || null, max_trade_size || null,
      min_ev_threshold || null, min_prob_diff || null, direction_filter || null,
      market_prob_min || null, market_prob_max || null,
      paper_trading !== undefined ? paper_trading : null,
      min_edge || null, snipe_before_close_sec || null,
      require_whale_convergence !== undefined ? require_whale_convergence : null,
      encryptedClaudeKey, claude_model || null,
      auto_claude_analysis !== undefined ? auto_claude_analysis : null
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error('Settings update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/user/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const settingsResult = await pool.query(
      'SELECT polymarket_wallet_address, paper_trading, paper_balance, cached_polymarket_balance, cached_balance_at FROM bot_settings WHERE user_id = $1',
      [req.userId]
    );
    const walletAddress = settingsResult.rows[0]?.polymarket_wallet_address || null;
    const isPaperMode = settingsResult.rows[0]?.paper_trading !== false;
    const paperBalance = parseFloat(settingsResult.rows[0]?.paper_balance) || 0;
    const cachedBalance = settingsResult.rows[0]?.cached_polymarket_balance;
    const cachedAt = settingsResult.rows[0]?.cached_balance_at;

    // 1. Try running bot first (live, no extra overhead)
    let balance = null;
    if (walletAddress && global.botManager && global.botManager.instances) {
      try {
        const bot = global.botManager.instances.get(req.userId);
        if (bot && bot.polymarket && bot.polymarket.getBalance) {
          balance = await bot.polymarket.getBalance();
        }
      } catch (e) {
        console.error('Balance fetch error:', e.message);
      }
    }

    // 2. Use cached CLOB balance if fresh enough (< 5 minutes old)
    if (!balance && cachedBalance != null && cachedAt) {
      const ageMs = Date.now() - new Date(cachedAt).getTime();
      if (ageMs < 5 * 60 * 1000) {
        balance = { usdc_balance: parseFloat(cachedBalance), address: walletAddress };
      }
    }

    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE result IS NOT NULL) as total_trades,
        COUNT(*) FILTER (WHERE result = 'WIN' OR (result = 'CLOSED' AND pnl > 0)) as wins,
        COUNT(*) FILTER (WHERE result = 'LOSS' OR (result = 'CLOSED' AND pnl <= 0)) as losses,
        COALESCE(SUM(pnl) FILTER (WHERE ABS(pnl) < 100000), 0) as total_pnl,
        COALESCE(SUM(size) FILTER (WHERE size < 10000), 0) as total_invested,
        COALESCE(AVG(size) FILTER (WHERE size < 10000), 0) as avg_trade_size,
        COALESCE(MAX(pnl) FILTER (WHERE ABS(pnl) < 100000), 0) as best_trade,
        COALESCE(MIN(pnl) FILTER (WHERE ABS(pnl) < 100000), 0) as worst_trade,
        COALESCE(SUM(pnl) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours' AND ABS(pnl) < 100000), 0) as daily_pnl
      FROM trades WHERE user_id = $1
    `, [req.userId]);

    const s = stats.rows[0];
    const winRate = s.total_trades > 0 ? (s.wins / s.total_trades * 100).toFixed(1) : 0;
    const roi = s.total_invested > 0 ? (s.total_pnl / s.total_invested * 100).toFixed(2) : 0;

    res.json({
      polymarket_balance: balance?.usdc_balance ?? null, // null = unknown, 0 = confirmed zero
      paper_trading: isPaperMode,
      paper_balance: paperBalance,
      wallet_address: walletAddress,
      total_trades: parseInt(s.total_trades),
      wins: parseInt(s.wins),
      losses: parseInt(s.losses),
      win_rate: parseFloat(winRate),
      total_pnl: parseFloat(s.total_pnl),
      total_invested: parseFloat(s.total_invested),
      daily_pnl: parseFloat(s.daily_pnl),
      roi: parseFloat(roi)
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/user/stats
router.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE result IS NOT NULL) as total_trades,
        COUNT(*) FILTER (WHERE result = 'WIN' OR (result = 'CLOSED' AND pnl > 0)) as wins,
        COUNT(*) FILTER (WHERE result = 'LOSS' OR (result = 'CLOSED' AND pnl <= 0)) as losses,
        COALESCE(SUM(pnl) FILTER (WHERE ABS(pnl) < 100000), 0) as total_pnl,
        COALESCE(SUM(size) FILTER (WHERE size < 10000), 0) as total_invested,
        COALESCE(AVG(size) FILTER (WHERE size < 10000), 0) as avg_trade_size,
        COALESCE(MAX(pnl) FILTER (WHERE ABS(pnl) < 100000), 0) as best_trade,
        COALESCE(MIN(pnl) FILTER (WHERE ABS(pnl) < 100000), 0) as worst_trade,
        COALESCE(SUM(pnl) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours' AND ABS(pnl) < 100000), 0) as daily_pnl
      FROM trades WHERE user_id = $1
    `, [req.userId]);

    const stats = result.rows[0];
    const winRate = stats.total_trades > 0
      ? (stats.wins / stats.total_trades * 100).toFixed(1) : 0;
    const roi = stats.total_invested > 0
      ? (stats.total_pnl / stats.total_invested * 100).toFixed(2) : 0;

    res.json({ ...stats, win_rate: parseFloat(winRate), roi: parseFloat(roi) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/user/reset-paper-balance — Reset paper trading balance to $10,000
router.post('/reset-paper-balance', async (req, res) => {
  try {
    await pool.query(
      'UPDATE bot_settings SET paper_balance = 10000, paper_balance_initialized = true WHERE user_id = $1',
      [req.userId]
    );
    res.json({ success: true, message: 'Paper balance reset to $10,000' });
  } catch (err) {
    console.error('Reset paper balance error:', err);
    res.status(500).json({ error: 'Failed to reset paper balance' });
  }
});

// GET /api/user/polymarket-balance — fetch real Polymarket in-exchange balance via CLOB API
// Decrypts private key, authenticates with Polymarket, returns collateral balance.
// Result is cached in DB for 5 minutes so dashboard can show it without the bot running.
router.get('/polymarket-balance', async (req, res) => {
  try {
    const settingsResult = await pool.query(
      'SELECT encrypted_private_key, polymarket_wallet_address FROM bot_settings WHERE user_id = $1',
      [req.userId]
    );
    const settings = settingsResult.rows[0];
    if (!settings?.encrypted_private_key) {
      return res.json({ balance: null, error: 'No private key configured' });
    }

    const { decrypt } = require('../services/encryption');
    const PolymarketFeed = require('../bot/PolymarketFeed');

    let privateKey;
    try {
      privateKey = decrypt(settings.encrypted_private_key);
    } catch (e) {
      return res.json({ balance: null, error: 'Could not decrypt private key' });
    }

    const balanceData = await PolymarketFeed.fetchBalance(privateKey, settings.polymarket_wallet_address);

    if (balanceData) {
      await pool.query(
        'UPDATE bot_settings SET cached_polymarket_balance=$1, cached_balance_at=NOW() WHERE user_id=$2',
        [balanceData.usdc, req.userId]
      );
      return res.json({ balance: balanceData.usdc, address: balanceData.wallet });
    }

    res.json({ balance: null, error: 'CLOB API did not return balance' });
  } catch (err) {
    console.error('Polymarket balance route error:', err);
    res.json({ balance: null, error: err.message });
  }
});

module.exports = router;
