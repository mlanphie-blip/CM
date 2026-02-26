const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../database');
const { authenticate, requireRole, JWT_SECRET } = require('../middleware/auth');
const { logAction } = require('../services/audit');

const router = express.Router();

// Login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  logAction(user.id, 'login', 'user', user.id);
  res.json({
    token,
    user: { id: user.id, username: user.username, email: user.email, full_name: user.full_name, role: user.role }
  });
});

// Register
router.post('/register', (req, res) => {
  const { username, email, password, full_name, role } = req.body;
  if (!username || !email || !password || !full_name) {
    return res.status(400).json({ error: 'All fields required' });
  }
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) {
    return res.status(409).json({ error: 'Username or email already exists' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)'
  ).run(username, email, hash, full_name, role || 'reviewer');
  logAction(result.lastInsertRowid, 'register', 'user', result.lastInsertRowid);
  res.status(201).json({ id: result.lastInsertRowid, username, email, full_name, role: role || 'reviewer' });
});

// Get current user
router.get('/me', authenticate, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, username, email, full_name, role, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// List all users (for assignment purposes)
router.get('/users', authenticate, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, email, full_name, role FROM users').all();
  res.json(users);
});

module.exports = router;
