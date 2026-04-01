// Vercel serverless entry point.
// Exports the Express app — Vercel handles the HTTP binding.
// src/index.js (Railway) is unchanged and still calls app.listen() for that deployment.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { pool, initDB, addDecisionsTable, addCopyTradingSchema, addWhalePerformanceSchema } = require('../src/models/db');
const authRoutes   = require('../src/routes/auth');
const botRoutes    = require('../src/routes/bot');
const tradesRoutes = require('../src/routes/trades');
const userRoutes   = require('../src/routes/user');
const adminRoutes  = require('../src/routes/admin');
const copyRoutes   = require('../src/routes/copy');
const claudeRoutes = require('../src/routes/claude');
const { BotManager } = require('../src/bot/BotManager');

const app = express();
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

const allowedOrigins = [
  /\.netlify\.app$/,
  /\.railway\.app$/,
  /\.vercel\.app$/,
  /^http:\/\/localhost(:\d+)?$/,
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.some(p => (typeof p === 'string' ? p === origin : p.test(origin)))) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());

// Lazy DB + BotManager init (serverless functions cold-start on each request)
let initialized = false;
app.use(async (req, res, next) => {
  if (initialized) return next();
  try {
    await initDB();
    await addDecisionsTable();
    await addCopyTradingSchema();
    await addWhalePerformanceSchema();
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      await pool.query('UPDATE users SET is_admin = true WHERE email = $1', [adminEmail.toLowerCase()]);
    }
    if (!global.botManager) global.botManager = new BotManager();
    initialized = true;
    next();
  } catch (e) {
    console.error('Init error:', e.message);
    res.status(503).json({ error: 'Service initializing, please retry.' });
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

module.exports = app;
