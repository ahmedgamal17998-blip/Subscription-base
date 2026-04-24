const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const prisma = require('../db');
const config = require('../config');
const { requireAdmin, requireAuth } = require('../middleware/auth.middleware');
const { log } = require('../utils/logger');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { error: 'Too many auth attempts. Try again later.' },
});

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    config.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = signToken(user);
    log('INFO', 'auth', 'User logged in', { email: user.email, role: user.role });
    return res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) {
    log('ERROR', 'auth', 'Login error', { error: err.message });
    return res.status(500).json({ error: 'Login failed.' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get user.' });
  }
});

// ── POST /api/auth/change-password ───────────────────────────────────────────
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

    const hashed = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.user.id }, data: { password: hashed } });
    log('INFO', 'auth', 'Password changed', { userId: req.user.id });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to change password.' });
  }
});

// ── GET /api/auth/team ────────────────────────────────────────────────────────
router.get('/team', requireAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list team.' });
  }
});

// ── POST /api/auth/team ───────────────────────────────────────────────────────
router.post('/team', requireAdmin, async (req, res) => {
  try {
    const { email, name, password, role } = req.body;
    if (!email || !name || !password) {
      return res.status(400).json({ error: 'email, name, and password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const validRoles = ['admin', 'viewer', 'support'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Use: admin, viewer, or support.' });
    }

    const hashed = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase().trim(),
        name: name.trim(),
        password: hashed,
        role: role || 'viewer',
      },
      select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
    });
    log('INFO', 'auth', 'Team member created', { email: user.email, role: user.role, by: req.user.email });
    return res.status(201).json(user);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }
    return res.status(500).json({ error: 'Failed to create team member.' });
  }
});

// ── PUT /api/auth/team/:id ────────────────────────────────────────────────────
router.put('/team/:id', requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { name, role, isActive, password } = req.body;

    // Prevent admin from demoting themselves
    if (userId === req.user.id && role && role !== 'admin') {
      return res.status(400).json({ error: 'You cannot change your own role.' });
    }

    const data = {};
    if (name) data.name = name.trim();
    if (role) data.role = role;
    if (typeof isActive === 'boolean') data.isActive = isActive;
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      data.password = await bcrypt.hash(password, 12);
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
    });
    log('INFO', 'auth', 'Team member updated', { userId, by: req.user.email });
    return res.json(user);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'User not found.' });
    return res.status(500).json({ error: 'Failed to update team member.' });
  }
});

// ── DELETE /api/auth/team/:id ─────────────────────────────────────────────────
router.delete('/team/:id', requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete yourself.' });
    }
    await prisma.user.delete({ where: { id: userId } });
    log('INFO', 'auth', 'Team member deleted', { userId, by: req.user.email });
    return res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'User not found.' });
    return res.status(500).json({ error: 'Failed to delete team member.' });
  }
});

module.exports = router;
