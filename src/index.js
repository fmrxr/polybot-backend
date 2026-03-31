require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { initDB } = require('./models/db');
const authRoutes = require('./routes/auth');
const botRoutes = require('./routes/bot');
const tradesRoutes = require('./routes/trades');
const userRoutes = require('./routes/user');
const { BotManager } = require('./bot/BotManager');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Railway proxy
app.set('trust proxy', 1);

// Security
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/bot', botRoutes);
app.use('/api/trades', tradesRoutes);
app.use('/api/user', userRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Global bot manager
global.botManager = new BotManager();

// Auto-restart bots for users who were active before server restart
async function autoRestartBots() {
  const { pool } = require('./models/db');
  try {
    const result = await pool.query(
      'SELECT bs.*, bs.user_id FROM bot_settings bs WHERE bs.is_active = true AND bs.encrypted_private_key IS NOT NULL'
    );
    for (const settings of result.rows) {
      try {
        await global.botManager.startBot(settings.user_id, settings);
        console.log(`✅ Auto-restarted bot for user ${settings.user_id}`);
      } catch(e) {
        console.error(`❌ Failed to auto-restart bot for user ${settings.user_id}:`, e.message);
      }
    }
  } catch(e) {
    console.error('Auto-restart error:', e.message);
  }
}

// Start server
async function start() {
  await initDB();
  await autoRestartBots();
  app.listen(PORT, () => {
    console.log(`🚀 PolyBot backend running on port ${PORT}`);
  });
}

start().catch(console.error);
