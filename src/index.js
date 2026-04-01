require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { initDB, addDecisionsTable, addCopyTradingSchema } = require('./models/db');
const authRoutes = require('./routes/auth');
const botRoutes = require('./routes/bot');
const tradesRoutes = require('./routes/trades');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const copyRoutes = require('./routes/copy');
const { BotManager } = require('./bot/BotManager');

const app = express();
const PORT = process.env.PORT || 3001;

const requiredEnvs = ['DATABASE_URL', 'JWT_SECRET'];
const missingEnvs = requiredEnvs.filter((key) => !process.env[key]);
if (missingEnvs.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvs.join(', ')}`);
  process.exit(1);
}
if (!process.env.ENCRYPTION_KEY) {
  console.warn('⚠️  ENCRYPTION_KEY not set — using insecure default. Set this in Railway env vars!');
}

// Trust Railway proxy
app.set('trust proxy', 1);

// Security
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

const allowedOrigins = [
  /\.netlify\.app$/,
  /\.railway\.app$/,
  /\.vercel\.app$/,
  /^http:\/\/localhost(:\d+)?$/,
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / same-origin
    if (allowedOrigins.some(p => (typeof p === 'string' ? p === origin : p.test(origin)))) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/bot', botRoutes);
app.use('/api/trades', tradesRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/copy', copyRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Global bot manager
global.botManager = new BotManager();

// Auto-restart bots for users who were active before server restart
async function autoRestartBots() {
  const { pool } = require('./models/db');
  try {
    // Restart GBM bots
    const result = await pool.query(
      'SELECT bs.*, bs.user_id FROM bot_settings bs WHERE bs.is_active = true AND bs.encrypted_private_key IS NOT NULL'
    );
    for (const settings of result.rows) {
      try {
        await global.botManager.startBot(settings.user_id, settings);
        console.log(`✅ Auto-restarted GBM bot for user ${settings.user_id}`);
      } catch(e) {
        console.error(`❌ Failed to auto-restart GBM bot for user ${settings.user_id}:`, e.message);
      }
    }

    // Restart copy bots
    const copyResult = await pool.query(
      'SELECT DISTINCT ct.user_id, bs.* FROM copy_targets ct JOIN bot_settings bs ON ct.user_id=bs.user_id WHERE ct.is_active=true'
    );
    for (const settings of copyResult.rows) {
      try {
        await global.botManager.startCopyBot(settings.user_id, settings);
        console.log(`✅ Auto-restarted copy bot for user ${settings.user_id}`);
      } catch(e) {
        console.error(`❌ Failed to auto-restart copy bot for user ${settings.user_id}:`, e.message);
      }
    }
  } catch(e) {
    console.error('Auto-restart error:', e.message);
  }
}

// Seed admin user
async function seedAdmin() {
  const { pool } = require('./models/db');
  try {
    await pool.query(
      'UPDATE users SET is_admin = true WHERE email = $1',
      ['mereeffet@gmail.com']
    );
  } catch (e) {
    console.error('Admin seed error:', e.message);
  }
}

// Start server
async function start() {
  await initDB();
  await addDecisionsTable();
  await addCopyTradingSchema();
  await seedAdmin();
  await autoRestartBots();
  app.listen(PORT, () => {
    console.log(`🚀 PolyBot backend running on port ${PORT}`);
  });
}

start().catch(console.error);
