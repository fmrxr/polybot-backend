const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('../models/db');

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters');
  }
  return secret;
};

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many auth attempts. Try again in 15 minutes.' }
});

// --- Register ---
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check if user exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, role',
      [email.toLowerCase(), passwordHash]
    );

    const user = result.rows[0];

    // Create default bot settings
    await pool.query(
      'INSERT INTO bot_settings (user_id) VALUES ($1)',
      [user.id]
    );

    // Generate tokens
    const accessToken = jwt.sign({ userId: user.id }, getJwtSecret(), { expiresIn: '2h' });
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const refreshExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET token = $2, expires_at = $3',
      [user.id, refreshToken, refreshExpiry]
    );

    res.status(201).json({
      token: accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, role: user.role }
    });

  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// --- Login ---
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, role FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate tokens
    const accessToken = jwt.sign({ userId: user.id }, getJwtSecret(), { expiresIn: '2h' });
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const refreshExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET token = $2, expires_at = $3',
      [user.id, refreshToken, refreshExpiry]
    );

    res.json({
      token: accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, role: user.role }
    });

  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// --- Refresh Token ---
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    // Find valid refresh token
    const result = await pool.query(
      'SELECT * FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
      [refreshToken]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const userId = result.rows[0].user_id;

    // Generate new tokens (rotation)
    const newAccessToken = jwt.sign({ userId }, getJwtSecret(), { expiresIn: '2h' });
    const newRefreshToken = crypto.randomBytes(64).toString('hex');
    const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      'UPDATE refresh_tokens SET token = $1, expires_at = $2 WHERE user_id = $3',
      [newRefreshToken, newExpiry, userId]
    );

    res.json({
      token: newAccessToken,
      refreshToken: newRefreshToken
    });

  } catch (err) {
    console.error('[Auth] Refresh error:', err.message);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// --- Logout (invalidate refresh token) ---
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    }
    res.json({ message: 'Logged out' });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

module.exports = router;
