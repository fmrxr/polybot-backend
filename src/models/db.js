const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? {
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true'
  } : false,
  max: 20,
  idleTimeoutMillis: 30000,
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
      ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS status        VARCHAR(50)    DEFAULT 'open',
        ADD COLUMN IF NOT EXISTS trade_size    DECIMAL(20,2),
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
        ADD COLUMN IF NOT EXISTS require_whale_convergence BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS max_trade_size DECIMAL(20,2) DEFAULT 100.00,
        ADD COLUMN IF NOT EXISTS min_ev_threshold DECIMAL(5,2) DEFAULT 3.00,
        ADD COLUMN IF NOT EXISTS min_prob_diff DECIMAL(5,3) DEFAULT 0.050,
        ADD COLUMN IF NOT EXISTS direction_filter VARCHAR(10) DEFAULT 'BOTH',
        ADD COLUMN IF NOT EXISTS market_prob_min DECIMAL(5,3) DEFAULT 0.10,
        ADD COLUMN IF NOT EXISTS market_prob_max DECIMAL(5,3) DEFAULT 0.90,
        ADD COLUMN IF NOT EXISTS claude_model VARCHAR(100),
        ADD COLUMN IF NOT EXISTS paper_balance_initialized BOOLEAN DEFAULT false;

      ALTER TABLE signals
        ADD COLUMN IF NOT EXISTS gate_failed   DECIMAL(5,2),
        ADD COLUMN IF NOT EXISTS lag_age_sec   INTEGER,
        ADD COLUMN IF NOT EXISTS spread_pct    DECIMAL(10,4);
    `);

    console.log('[DB] Tables initialized successfully');
  } catch (err) {
    console.error('[DB] Table initialization error:', err.message);
  } finally {
    client.release();
  }
};

module.exports = { pool, initDB };
