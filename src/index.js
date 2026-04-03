require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { pool, initDB } = require('./models/db');
const BotManager = require('./bot/BotManager');

const app = express();
const PORT = process.env.PORT || 3001;

// --- Security ---
app.use(helmet());

// --- CORS: Exact origins only ---
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5173',
].filter(Boolean).map(o => o.replace(/\/$/, ''));

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// --- Bot Manager (no global) ---
const botManager = new BotManager();
app.locals.botManager = botManager;

// --- Routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/bot', require('./routes/bot'));
app.use('/api/user', require('./routes/user'));
app.use('/api/copy', require('./routes/copy'));
app.use('/api/claude', require('./routes/claude'));
app.use('/api/admin', require('./routes/admin'));

// --- Health Check ---
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    activeBots: botManager.getActiveCount()
  });
});

// --- Root ---
app.get('/', (req, res) => {
  res.json({ message: 'PolyBot Backend v1.0 — REAL EDGE MODE', status: 'running' });
});

// --- Auto-restart active bots on deploy ---
const autoRestartBots = async () => {
  try {
    // Restart signal bots
    const signalResult = await pool.query(`
      SELECT bs.*, u.email AS user_email 
      FROM bot_settings bs 
      JOIN users u ON bs.user_id = u.id 
      WHERE bs.is_active = true
    `);

    for (const settings of signalResult.rows) {
      try {
        console.log(`[AutoRestart] Starting signal bot for user ${settings.user_id} (${settings.user_email})`);
        await botManager.startBot(settings.user_id, settings);
      } catch (err) {
        console.error(`[AutoRestart] Failed to restart signal bot for user ${settings.user_id}:`, err.message);
      }
    }

    // Restart copy bots
    const copyResult = await pool.query(`
      SELECT DISTINCT ON (ct.user_id) ct.user_id, bs.*, u.email AS user_email
      FROM copy_targets ct 
      JOIN bot_settings bs ON ct.user_id = bs.user_id 
      JOIN users u ON ct.user_id = u.id
      WHERE ct.is_active = true AND bs.copy_bot_active = true
      ORDER BY ct.user_id, ct.updated_at DESC
    `);

    for (const settings of copyResult.rows) {
      try {
        console.log(`[AutoRestart] Starting copy bot for user ${settings.user_id} (${settings.user_email})`);
        await botManager.startCopyBot(settings.user_id, settings);
      } catch (err) {
        console.error(`[AutoRestart] Failed to restart copy bot for user ${settings.user_id}:`, err.message);
      }
    }

    const totalRestarted = signalResult.rows.length + copyResult.rows.length;
    if (totalRestarted > 0) {
      console.log(`[AutoRestart] Restarted ${totalRestarted} bot(s)`);
    }
  } catch (err) {
    console.error('[AutoRestart] Error:', err.message);
  }
};

// --- Start Server ---
const startServer = async () => {
  try {
    await initDB();
    console.log('[DB] Connected and initialized');

    const server = app.listen(PORT, () => {
      console.log(`[Server] PolyBot backend running on port ${PORT}`);
      console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`[Server] CORS origins: ${allowedOrigins.join(', ')}`);
    });

    // Auto-restart after short delay to let server settle
    setTimeout(autoRestartBots, 3000);

    // --- Graceful Shutdown ---
    const shutdown = async (signal) => {
      console.log(`\n[Server] ${signal} received. Graceful shutdown starting...`);

      // Stop all bot instances
      try {
        console.log('[Server] Stopping all bot instances...');
        await botManager.stopAll();
        console.log('[Server] All bots stopped.');
      } catch (err) {
        console.error('[Server] Error stopping bots:', err.message);
      }

      // Close database pool
      try {
        await pool.end();
        console.log('[Server] Database pool closed.');
      } catch (err) {
        console.error('[Server] Error closing DB pool:', err.message);
      }

      // Close HTTP server
      server.close(() => {
        console.log('[Server] HTTP server closed.');
        process.exit(0);
      });

      // Force exit after 10s
      setTimeout(() => {
        console.error('[Server] Forced exit after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (err) {
    console.error('[Server] Failed to start:', err.message);
    process.exit(1);
  }
};

startServer();

module.exports = app;
