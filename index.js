// Vercel serverless entry point — lightweight, no BotManager.
// The bot polling loop runs on Railway (src/index.js). Vercel handles
// auth, settings, trades history, and dashboard reads only.
require('dotenv').config();
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');

const { pool, initDB } = require('./src/models/db');
const authRoutes   = require('./src/routes/auth');
const botRoutes    = require('./src/routes/bot');
const tradesRoutes = require('./src/routes/trades');
const userRoutes   = require('./src/routes/user');
const adminRoutes  = require('./src/routes/admin');
const copyRoutes   = require('./src/routes/copy');
const claudeRoutes = require('./src/routes/claude');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

const allowedOrigins = [/\.netlify\.app$/, /\.railway\.app$/, /\.vercel\.app$/, /^http:\/\/localhost(:\d+)?$/];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.some(p => p.test(origin))) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());

// Lazy DB init on first request
let dbReady = false;
app.use(async (req, res, next) => {
  if (dbReady) return next();
  try {
    await initDB();
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      await pool.query('UPDATE users SET is_admin = true WHERE email = $1', [adminEmail.toLowerCase()]);
    }
    // No BotManager on Vercel — bot runs on Railway
    global.botManager = null;
    app.locals.botManager = {
      startBot: async () => { throw new Error('Bot runs on Railway, not Vercel'); },
      stopBot: async () => { throw new Error('Bot runs on Railway, not Vercel'); },
      getBotStatus: () => ({ status: 'unknown', message: 'Bot managed by Railway' }),
      getBot: () => null,
      getActiveCount: () => 0,
      startCopyBot: async () => { throw new Error('Bot runs on Railway, not Vercel'); },
      stopCopyBot: async () => {},
      stopAll: async () => {},
    };
    dbReady = true;
    next();
  } catch (e) {
    console.error('DB init error:', e.message);
    res.status(503).json({ error: 'Database unavailable. Check DATABASE_URL env var.' });
  }
});

app.use('/api/auth',   authRoutes);
app.use('/api/bot',    botRoutes);
app.use('/api/trades', tradesRoutes);
app.use('/api/user',   userRoutes);
app.use('/api/admin',  adminRoutes);
app.use('/api/copy',   copyRoutes);
app.use('/api/claude', claudeRoutes);
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Static files + SPA fallback
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

module.exports = app;
