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
    delete settings.encrypted_private_key;
    delete settings.encrypted_polymarket_api_key;
    res.json({ ...settings, has_private_key: hasKey, has_polymarket_api_key: hasApiKey });
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
    market_prob_min, market_prob_max, paper_trading
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

    await pool.query(`
      INSERT INTO bot_settings (user_id, encrypted_private_key, encrypted_polymarket_api_key, polymarket_wallet_address, kelly_cap, max_daily_loss, max_trade_size,
        min_ev_threshold, min_prob_diff, direction_filter, market_prob_min, market_prob_max, paper_trading, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
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
        updated_at = NOW()
    `, [
      req.userId, encryptedKey, encryptedApiKey, polymarket_wallet_address || null,
      kelly_cap || null, max_daily_loss || null, max_trade_size || null,
      min_ev_threshold || null, min_prob_diff || null, direction_filter || null,
      market_prob_min || null, market_prob_max || null,
      paper_trading !== undefined ? paper_trading : null
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
    const { BotManager } = require('../bot/BotManager');
    const botManager = global.botManager;

    const settingsResult = await pool.query('SELECT polymarket_wallet_address FROM bot_settings WHERE user_id = $1', [req.userId]);
    const walletAddress = settingsResult.rows[0]?.polymarket_wallet_address || null;

    let balance = null;
    if (walletAddress && botManager) {
      const bot = botManager.bots.get(req.userId);
      if (bot && bot.polymarket) {
        try {
          balance = await bot.polymarket.getBalance();
        } catch (e) {
          console.error('Balance fetch error:', e.message);
        }
      }
    }

    const stats = await pool.query(`
      SELECT
        COUNT(*) as total_trades,
        COUNT(*) FILTER (WHERE result = 'WIN') as wins,
        COUNT(*) FILTER (WHERE result = 'LOSS') as losses,
        COALESCE(SUM(pnl), 0) as total_pnl,
        COALESCE(SUM(size), 0) as total_invested,
        COALESCE(AVG(size), 0) as avg_trade_size,
        COALESCE(MAX(pnl), 0) as best_trade,
        COALESCE(MIN(pnl), 0) as worst_trade,
        COALESCE(SUM(pnl) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'), 0) as daily_pnl
      FROM trades WHERE user_id = $1
    `, [req.userId]);

    const s = stats.rows[0];
    const winRate = s.total_trades > 0 ? (s.wins / s.total_trades * 100).toFixed(1) : 0;
    const roi = s.total_invested > 0 ? (s.total_pnl / s.total_invested * 100).toFixed(2) : 0;

    res.json({
      polymarket_balance: balance?.usdc_balance || 0,
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
        COUNT(*) as total_trades,
        COUNT(*) FILTER (WHERE result = 'WIN') as wins,
        COUNT(*) FILTER (WHERE result = 'LOSS') as losses,
        COALESCE(SUM(pnl), 0) as total_pnl,
        COALESCE(SUM(size), 0) as total_invested,
        COALESCE(AVG(size), 0) as avg_trade_size,
        COALESCE(MAX(pnl), 0) as best_trade,
        COALESCE(MIN(pnl), 0) as worst_trade,
        COALESCE(SUM(pnl) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'), 0) as daily_pnl
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

module.exports = router;
