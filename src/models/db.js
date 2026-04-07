const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? {
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true'
  } : false,
  max: 20,
  // Keep connections alive for 10 minutes — the bot ticks every 8-10s so a
  // 30s idle timeout caused constant connect/disconnect churn (new client log every 20s).
  idleTimeoutMillis: 600000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

pool.on('connect', () => {
  console.log('[DB] New client connected to pool');
});

// Initialize tables
const initDB = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'user',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bot_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id),
        paper_trading BOOLEAN DEFAULT true,
        paper_balance DECIMAL(20, 2) DEFAULT 1000.00,
        is_active BOOLEAN DEFAULT false,
        copy_bot_active BOOLEAN DEFAULT false,
        gate1_threshold DECIMAL(5, 3) DEFAULT 0.450,
        gate2_ev_floor DECIMAL(5, 2) DEFAULT 3.00,
        gate3_enabled BOOLEAN DEFAULT true,
        gate3_min_edge DECIMAL(5, 2) DEFAULT 5.00,
        kelly_cap DECIMAL(5, 2) DEFAULT 0.10,
        max_daily_loss DECIMAL(20, 2) DEFAULT 50.00,
        max_drawdown_pct DECIMAL(5, 2) DEFAULT 15.00,
        snipe_timer_seconds INTEGER DEFAULT 10,
        stale_lag_seconds INTEGER DEFAULT 20,
        chase_threshold DECIMAL(5, 2) DEFAULT 8.00,
        whale_convergence BOOLEAN DEFAULT false,
        encrypted_private_key TEXT,
        polymarket_wallet_address VARCHAR(255),
        claude_api_key_encrypted TEXT,
        claude_auto_analysis BOOLEAN DEFAULT false,
        claude_last_analysis TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        market_id VARCHAR(255),
        market_question TEXT,
        token_id VARCHAR(255),
        direction VARCHAR(10),
        entry_price DECIMAL(20, 8),
        exit_price DECIMAL(20, 8),
        trade_size DECIMAL(20, 2),
        pnl DECIMAL(20, 2),
        status VARCHAR(50) DEFAULT 'open',
        trade_type VARCHAR(50) DEFAULT 'signal',
        signal_confidence DECIMAL(5, 3),
        ev_adj DECIMAL(10, 4),
        gate1_score DECIMAL(5, 3),
        gate2_score DECIMAL(10, 4),
        gate3_score DECIMAL(10, 4),
        close_reason VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        closed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        market_id VARCHAR(255),
        market_question TEXT,
        verdict VARCHAR(50),
        reason TEXT,
        direction VARCHAR(10),
        confidence DECIMAL(5, 3),
        ev_raw DECIMAL(10, 4),
        ev_adj DECIMAL(10, 4),
        ema_edge DECIMAL(10, 4),
        gate1_passed BOOLEAN,
        gate2_passed BOOLEAN,
        gate3_passed BOOLEAN,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS copy_targets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        wallet_address VARCHAR(255) NOT NULL,
        label VARCHAR(255),
        multiplier DECIMAL(5, 2) DEFAULT 1.00,
        max_trade_size DECIMAL(20, 2) DEFAULT 100.00,
        min_whale_score DECIMAL(5, 2) DEFAULT 0.50,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS copy_trades (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        copy_target_id INTEGER REFERENCES copy_targets(id),
        source_wallet VARCHAR(255),
        market_id VARCHAR(255),
        token_id VARCHAR(255),
        direction VARCHAR(10),
        entry_price DECIMAL(20, 8),
        trade_size DECIMAL(20, 2),
        whale_score DECIMAL(5, 2),
        status VARCHAR(50) DEFAULT 'executed',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS claude_analyses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        analysis TEXT,
        feedback TEXT,
        trade_count INTEGER DEFAULT 0,
        signal_count INTEGER DEFAULT 0,
        total_pnl DECIMAL(20,2) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_user_id INTEGER REFERENCES users(id),
        action VARCHAR(255),
        target_user_id INTEGER,
        details JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id),
        token TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Add columns that may not exist in older deployments (safe to run multiple times)
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user';

      ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS status        VARCHAR(50)    DEFAULT 'open',
        ADD COLUMN IF NOT EXISTS trade_size    DECIMAL(20,2),
        ADD COLUMN IF NOT EXISTS size          DECIMAL(20,2),
        ADD COLUMN IF NOT EXISTS market_id     VARCHAR(255),
        ADD COLUMN IF NOT EXISTS market_question TEXT,
        ADD COLUMN IF NOT EXISTS trade_type    VARCHAR(50)    DEFAULT 'signal',
        ADD COLUMN IF NOT EXISTS signal_confidence DECIMAL(5,3),
        ADD COLUMN IF NOT EXISTS ev_adj        DECIMAL(10,4),
        ADD COLUMN IF NOT EXISTS gate1_score   DECIMAL(5,3),
        ADD COLUMN IF NOT EXISTS gate2_score   DECIMAL(10,4),
        ADD COLUMN IF NOT EXISTS gate3_score   DECIMAL(10,4),
        ADD COLUMN IF NOT EXISTS close_reason  VARCHAR(100),
        ADD COLUMN IF NOT EXISTS closed_at     TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS result        VARCHAR(20),
        ADD COLUMN IF NOT EXISTS slippage      DECIMAL(10,6),
        ADD COLUMN IF NOT EXISTS lag_age_sec   INTEGER,
        ADD COLUMN IF NOT EXISTS exit_price    DECIMAL(20,8),
        ADD COLUMN IF NOT EXISTS token_id      VARCHAR(255);

      ALTER TABLE copy_targets
        ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ DEFAULT NOW();

      ALTER TABLE bot_settings
        ADD COLUMN IF NOT EXISTS copy_bot_active    BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS gate1_threshold    DECIMAL(5,3) DEFAULT 0.450,
        ADD COLUMN IF NOT EXISTS gate2_ev_floor     DECIMAL(5,2) DEFAULT 5.00,
        ADD COLUMN IF NOT EXISTS gate3_enabled      BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS gate3_min_edge     DECIMAL(5,2) DEFAULT 5.00,
        ADD COLUMN IF NOT EXISTS snipe_timer_seconds INTEGER DEFAULT 10,
        ADD COLUMN IF NOT EXISTS stale_lag_seconds  INTEGER DEFAULT 20,
        ADD COLUMN IF NOT EXISTS chase_threshold    DECIMAL(5,2) DEFAULT 8.00,
        ADD COLUMN IF NOT EXISTS whale_convergence  BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS max_drawdown_pct   DECIMAL(5,2) DEFAULT 15.00,
        ADD COLUMN IF NOT EXISTS claude_auto_analysis BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS claude_last_analysis TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS claude_api_key_encrypted TEXT,
        ADD COLUMN IF NOT EXISTS encrypted_polymarket_api_key TEXT,
        ADD COLUMN IF NOT EXISTS cached_polymarket_balance DECIMAL(20,2),
        ADD COLUMN IF NOT EXISTS cached_balance_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS min_edge DECIMAL(5,4) DEFAULT 0.05,
        ADD COLUMN IF NOT EXISTS snipe_before_close_sec INTEGER DEFAULT 10,
        ADD COLUMN IF NOT EXISTS order_timeout_sec INTEGER DEFAULT 60,
        ADD COLUMN IF NOT EXISTS adverse_ticks INTEGER DEFAULT 8,
        ADD COLUMN IF NOT EXISTS gate3_min_delta DECIMAL(5,4) DEFAULT 0.05,
        ADD COLUMN IF NOT EXISTS require_whale_convergence BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS max_trade_size DECIMAL(20,2) DEFAULT 100.00,
        ADD COLUMN IF NOT EXISTS min_ev_threshold DECIMAL(5,2) DEFAULT 3.00,
        ADD COLUMN IF NOT EXISTS min_prob_diff DECIMAL(5,3) DEFAULT 0.050,
        ADD COLUMN IF NOT EXISTS direction_filter VARCHAR(10) DEFAULT 'BOTH',
        ADD COLUMN IF NOT EXISTS market_prob_min DECIMAL(5,3) DEFAULT 0.10,
        ADD COLUMN IF NOT EXISTS market_prob_max DECIMAL(5,3) DEFAULT 0.90,
        ADD COLUMN IF NOT EXISTS claude_model VARCHAR(100),
        ADD COLUMN IF NOT EXISTS paper_balance_initialized BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS kelly_mode VARCHAR(10) DEFAULT 'manual',
        ADD COLUMN IF NOT EXISTS flip_threshold DECIMAL(5,2) DEFAULT 5.00,
        ADD COLUMN IF NOT EXISTS ev_decay_ratio DECIMAL(5,2) DEFAULT 2.00,
        ADD COLUMN IF NOT EXISTS early_skip_sec INTEGER DEFAULT 100,
        ADD COLUMN IF NOT EXISTS late_skip_sec INTEGER DEFAULT 600,
        ADD COLUMN IF NOT EXISTS early_window_sec INTEGER DEFAULT 100,
        ADD COLUMN IF NOT EXISTS late_window_sec INTEGER DEFAULT 600,
        ADD COLUMN IF NOT EXISTS min_remaining_sec INTEGER DEFAULT 400,
        ADD COLUMN IF NOT EXISTS min_btc_delta DECIMAL(8,5) DEFAULT 0.00500;

      ALTER TABLE signals
        ADD COLUMN IF NOT EXISTS gate_failed   DECIMAL(5,2),
        ADD COLUMN IF NOT EXISTS lag_age_sec   INTEGER,
        ADD COLUMN IF NOT EXISTS spread_pct    DECIMAL(10,4),
        ADD COLUMN IF NOT EXISTS session_id    INTEGER,
        ADD COLUMN IF NOT EXISTS scenario      VARCHAR(32);

      ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS scenario      VARCHAR(32);

      ALTER TABLE copy_targets
        ADD COLUMN IF NOT EXISTS min_confirmations INTEGER DEFAULT 1;

    `);

    // trading_sessions — one row per bot start/stop cycle, scopes all trades/signals
    await client.query(`
      CREATE TABLE IF NOT EXISTS trading_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        started_at TIMESTAMPTZ DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        paper_trading BOOLEAN DEFAULT true,
        initial_balance DECIMAL(20,2),
        final_balance DECIMAL(20,2),
        total_trades INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        total_pnl DECIMAL(20,4) DEFAULT 0,
        win_rate DECIMAL(5,2) DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON trading_sessions(user_id);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES trading_sessions(id);
    `);

    // whale_performance — tracks historical performance per copy target address
    await client.query(`
      CREATE TABLE IF NOT EXISTS whale_performance (
        id SERIAL PRIMARY KEY,
        target_address VARCHAR(255) NOT NULL UNIQUE,
        total_trades INTEGER DEFAULT 0,
        win_trades INTEGER DEFAULT 0,
        total_pnl DECIMAL DEFAULT 0,
        avg_latency_ms INTEGER DEFAULT 0,
        last_updated TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_whale_perf_address ON whale_performance(target_address);
    `);

    // skipped_signals — tracks every SKIP for post-hoc analysis
    // Evaluated after market resolution to measure missed-opportunity cost per filter
    await client.query(`
      CREATE TABLE IF NOT EXISTS skipped_signals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        market_id VARCHAR(255) NOT NULL,
        market_question TEXT,
        skip_reason VARCHAR(64),        -- gate name that blocked: btcFlat, G1, G2, G3, evTrend, etc.
        skip_detail TEXT,               -- full reason string
        direction VARCHAR(10),          -- YES/NO — direction signal would have taken
        entry_price DECIMAL(10,6),      -- Gamma price at skip time
        ev_adj DECIMAL(10,4),           -- EV_adj at skip time (if computed)
        confidence DECIMAL(5,3),
        btc_delta DECIMAL(8,5),
        remaining_sec INTEGER,
        scenario VARCHAR(32),
        -- Resolution fields (filled in later by evaluator)
        resolved_price DECIMAL(10,6),   -- 0.01 (lost) or 0.99 (won) from Gamma
        would_win BOOLEAN,              -- true if direction was correct
        sim_pnl DECIMAL(10,4),          -- simulated P&L = shares*(resolved-entry) - fee
        evaluated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_skipped_user_time ON skipped_signals(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_skipped_market ON skipped_signals(market_id);
      CREATE INDEX IF NOT EXISTS idx_skipped_unevaluated ON skipped_signals(evaluated_at) WHERE evaluated_at IS NULL;
    `);

    // Ensure legacy 'size' column has no NOT NULL constraint (old schema had it; new schema uses trade_size)
    try {
      await client.query(`ALTER TABLE trades ALTER COLUMN size DROP NOT NULL`);
    } catch (_) { /* column may not exist or constraint already dropped — safe to ignore */ }

    // Close any legacy open trades that pre-date the token_id column
    const legacy = await client.query(`
      UPDATE trades SET status = 'closed', close_reason = 'LEGACY_NO_TOKEN_ID', closed_at = NOW()
      WHERE token_id IS NULL AND status = 'open'
    `);
    if (legacy.rowCount > 0) {
      console.log(`[DB] Closed ${legacy.rowCount} legacy trade(s) with no token_id`);
    }

    console.log('[DB] Tables initialized successfully');
  } catch (err) {
    console.error('[DB] Table initialization error:', err.message);
  } finally {
    client.release();
  }
};

module.exports = { pool, initDB };
