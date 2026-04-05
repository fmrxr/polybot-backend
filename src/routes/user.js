const express = require('express');
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
const { encrypt, decrypt } = require('../services/encryption');

const router = express.Router();
router.use(authMiddleware);

// Free public Polygon RPCs (no API key needed) — tried in order
const POLYGON_RPCS = [
  process.env.POLYGON_RPC_URL,
  'https://polygon-bor-rpc.publicnode.com',
  'https://1rpc.io/matic',
  'https://polygon.drpc.org',
].filter(Boolean);

async function getPolygonUsdcBalance(walletAddress) {
  const { ethers } = require('ethers');
  const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
  // Check both USDC.e (bridged) and native USDC — Polymarket uses both
  const TOKENS = [
    { addr: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, name: 'USDC' },
    { addr: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6, name: 'USDC.e' },
  ];
  for (const rpc of POLYGON_RPCS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      let total = 0;
      for (const token of TOKENS) {
        try {
          const contract = new ethers.Contract(token.addr, ERC20_ABI, provider);
          const raw = await Promise.race([
            contract.balanceOf(walletAddress),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
          ]);
          total += parseFloat(ethers.formatUnits(raw, token.decimals));
        } catch (_) {}
      }
      if (total >= 0) return parseFloat(total.toFixed(4));
    } catch (e) {
      console.warn(`[Balance] RPC ${rpc} failed: ${e.message}`);
    }
  }
  return null;
}

// GET /api/user/settings
router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bot_settings WHERE user_id = $1', [req.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Settings not found' });
    const settings = result.rows[0];
    const hasKey = !!settings.encrypted_private_key;
    const hasApiKey = !!settings.encrypted_polymarket_api_key;
    const hasClaudeKey = !!settings.claude_api_key_encrypted;
    delete settings.encrypted_private_key;
    delete settings.encrypted_polymarket_api_key;
    delete settings.claude_api_key_encrypted;
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
    claude_api_key, claude_model, auto_claude_analysis,
    gate1_threshold, gate2_ev_floor, gate3_enabled, gate3_min_delta,
    order_timeout_sec, adverse_ticks
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
        claude_api_key_encrypted, claude_model, claude_auto_analysis, gate1_threshold, gate2_ev_floor, gate3_enabled, gate3_min_delta,
        order_timeout_sec, adverse_ticks, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW())
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
        claude_api_key_encrypted = COALESCE($17, bot_settings.claude_api_key_encrypted),
        claude_model = COALESCE($18, bot_settings.claude_model),
        claude_auto_analysis = COALESCE($19, bot_settings.claude_auto_analysis),
        gate1_threshold = COALESCE($20, bot_settings.gate1_threshold),
        gate2_ev_floor = COALESCE($21, bot_settings.gate2_ev_floor),
        gate3_enabled = COALESCE($22, bot_settings.gate3_enabled),
        gate3_min_delta = COALESCE($23, bot_settings.gate3_min_delta),
        order_timeout_sec = COALESCE($24, bot_settings.order_timeout_sec),
        adverse_ticks = COALESCE($25, bot_settings.adverse_ticks),
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
      auto_claude_analysis !== undefined ? auto_claude_analysis : null,
      gate1_threshold || null, gate2_ev_floor || null,
      gate3_enabled !== undefined ? gate3_enabled : null,
      gate3_min_delta || null,
      order_timeout_sec || null, adverse_ticks || null
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

    // Fetch on-chain USDC balance from Polygon (no L2 API credentials needed)
    let balance = null;
    if (walletAddress) {
      const usdc = await getPolygonUsdcBalance(walletAddress);
      if (usdc !== null) {
        balance = { usdc_balance: usdc, address: walletAddress };
      } else if (cachedBalance != null) {
        balance = { usdc_balance: parseFloat(cachedBalance), address: walletAddress };
      }
    }

    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE result IS NOT NULL) as total_trades,
        COUNT(*) FILTER (WHERE result = 'WIN' OR (result = 'CLOSED' AND pnl > 0)) as wins,
        COUNT(*) FILTER (WHERE result = 'LOSS' OR (result = 'CLOSED' AND pnl <= 0)) as losses,
        COALESCE(SUM(pnl) FILTER (WHERE ABS(pnl) < 100000), 0) as total_pnl,
        COALESCE(SUM(trade_size) FILTER (WHERE trade_size < 10000), 0) as total_invested,
        COALESCE(AVG(trade_size) FILTER (WHERE trade_size < 10000), 0) as avg_trade_size,
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
        COALESCE(SUM(trade_size) FILTER (WHERE trade_size < 10000), 0) as total_invested,
        COALESCE(AVG(trade_size) FILTER (WHERE trade_size < 10000), 0) as avg_trade_size,
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

    // Also sync the live bot instance in memory — DB update alone doesn't affect
    // the running bot's this.paperBalance which was set at construction time
    const botManager = req.app.locals.botManager;
    if (botManager) {
      const bot = botManager.getBot(req.userId);
      if (bot) {
        bot.paperBalance = 10000;
        console.log(`[User] Paper balance reset in-memory for bot ${req.userId}`);
      }
    }

    res.json({ success: true, message: 'Paper balance reset to $10,000' });
  } catch (err) {
    console.error('Reset paper balance error:', err);
    res.status(500).json({ error: 'Failed to reset paper balance' });
  }
});

// GET /api/user/polymarket-balance — on-chain USDC balance on Polygon (no L2 creds needed)
router.get('/polymarket-balance', async (req, res) => {
  try {
    const settingsResult = await pool.query(
      'SELECT polymarket_wallet_address FROM bot_settings WHERE user_id = $1',
      [req.userId]
    );
    const walletAddress = settingsResult.rows[0]?.polymarket_wallet_address;
    if (!walletAddress) {
      return res.json({ balance: null, error: 'No wallet address configured' });
    }

    const balance = await getPolygonUsdcBalance(walletAddress);
    if (balance === null) {
      return res.json({ balance: null, error: 'All Polygon RPCs failed' });
    }

    await pool.query(
      'UPDATE bot_settings SET cached_polymarket_balance=$1, cached_balance_at=NOW() WHERE user_id=$2',
      [balance, req.userId]
    );

    res.json({ balance, address: walletAddress });
  } catch (err) {
    console.error('Polymarket balance route error:', err.message);
    res.json({ balance: null, error: err.message });
  }
});

module.exports = router;
