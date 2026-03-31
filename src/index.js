require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDB } = require('./models/db');
const authRoutes = require('./routes/auth');
const botRoutes = require('./routes/bot');
const tradesRoutes = require('./routes/trades');
const userRoutes = require('./routes/user');
const { BotManager } = require('./bot/BotManager');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Railway's proxy (fixes X-Forwarded-For rate limit error)
app.set('trust proxy', 1);

// Security
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/auth/', authLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/bot', botRoutes);
app.use('/api/trades', tradesRoutes);
app.use('/api/user', userRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Global bot manager
global.botManager = new BotManager();

// Start server
async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`🚀 PolyBot backend running on port ${PORT}`);
  });
}

start().catch(console.error);
