const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function adminMiddleware(req, res, next) {
  const { pool } = require('../models/db');
  try {
    const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
    if (!result.rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = { authMiddleware, adminMiddleware };
