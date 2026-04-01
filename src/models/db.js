const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bot_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        encrypted_private_key TEXT,
        kelly_cap DECIMAL DEFAULT 0.25,
        max_daily_loss DECIMAL DEFAULT 50.0,
        max_trade_size DECIMAL DEFAULT 20.0,
        min_ev_threshold DECIMAL DEFAULT 0.12,
        min_prob_diff DECIMAL DEFAULT 0.08,
        direction_filter VARCHAR(10) DEFAULT 'BOTH',
        market_prob_min DECIMAL DEFAULT 0.40,
        market_prob_max DECIMAL DEFAULT 0.60,
        is_active BOOLEAN DEFAULT false,
        paper_trading BOOLEAN DEFAULT true,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        condition_id VARCHAR(255),
        direction VARCHAR(10) NOT NULL,
        entry_price DECIMAL NOT NULL,
        size DECIMAL NOT NULL,
        model_prob DECIMAL,
        market_prob DECIMAL,
        expected_value DECIMAL,
        result VARCHAR(10),
        pnl DECIMAL,
        fee DECIMAL,
        paper BOOLEAN DEFAULT false,
        order_id VARCHAR(255),
        order_status VARCHAR(20),
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bot_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        level VARCHAR(10) DEFAULT 'INFO',
        message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id);
      CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
      CREATE INDEX IF NOT EXISTS idx_bot_logs_user_id ON bot_logs(user_id);

      -- Add new columns to existing tables if they don't exist yet
      ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS paper_trading BOOLEAN DEFAULT true;
      ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS encrypted_polymarket_api_key TEXT;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS paper BOOLEAN DEFAULT false;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS order_id VARCHAR(255);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS order_status VARCHAR(20);
    `);
    console.log('✅ Database initialized');
  } finally {
    client.release();
  }
}


// Note: call addDecisionsTable() after initDB() if upgrading existing DB
async function addDecisionsTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_decisions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        verdict VARCHAR(10),
        direction VARCHAR(10),
        reason TEXT,
        data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_user_id ON bot_decisions(user_id);
    `);
  } finally {
    client.release();
  }
}
module.exports = { pool, initDB, addDecisionsTable };
