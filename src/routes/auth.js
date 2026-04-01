const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../models/db');

const router = express.Router();

function getJwtSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }
  return process.env.JWT_SECRET;
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
      [email.toLowerCase(), passwordHash]
    );

    const user = result.rows[0];
    // Create default bot settings
    await pool.query('INSERT INTO bot_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);

    const token = jwt.sign({ userId: user.id }, getJwtSecret(), { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: user.id, email: user.email, is_admin: false } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message.includes('JWT_SECRET') ? 'Server configuration error' : 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user.id }, getJwtSecret(), { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, is_admin: user.is_admin || false } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message.includes('JWT_SECRET') ? 'Server configuration error' : 'Server error' });
  }
});

module.exports = router;
