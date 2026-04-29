/**
 * API Keys management — admin only
 * External integrations use: x-api-key: sk_live_xxxx
 */
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth.middleware');
const { log } = require('../utils/logger');

const router = express.Router();

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, message: { error: 'Too many requests' } });
router.use(limiter);

const VALID_SCOPES = [
  'subscriptions:read',
  'subscriptions:write',
  'analytics:read',
  'products:read',
  'webhooks:read',
  'webhooks:write',
];

// ── List all API keys ─────────────────────────────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
  try {
    const keys = await prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        isActive: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    return res.json(keys);
  } catch (err) {
    log('ERROR', 'api-keys', 'List failed', { error: err.message });
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ── Create API key ────────────────────────────────────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, scopes, expiresAt } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }

    if (!scopes || !Array.isArray(scopes) || scopes.length === 0) {
      return res.status(400).json({ error: 'At least one scope is required' });
    }

    const invalidScopes = scopes.filter(s => !VALID_SCOPES.includes(s));
    if (invalidScopes.length > 0) {
      return res.status(400).json({ error: `Invalid scopes: ${invalidScopes.join(', ')}` });
    }

    // Generate key: sk_live_ + 32 random bytes as hex (64 chars)
    const randomPart = crypto.randomBytes(32).toString('hex');
    const fullKey = `sk_live_${randomPart}`;
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');
    const keyPrefix = fullKey.slice(0, 16); // "sk_live_" + 8 chars

    const apiKey = await prisma.apiKey.create({
      data: {
        name: name.trim(),
        keyHash,
        keyPrefix,
        scopes: scopes.join(','),
        isActive: true,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });

    log('INFO', 'api-keys', `API key created: ${apiKey.name}`);

    // Return the full key ONCE — it won't be retrievable again
    return res.status(201).json({
      id: apiKey.id,
      name: apiKey.name,
      key: fullKey,   // ← shown only once
      keyPrefix,
      scopes: apiKey.scopes,
      isActive: apiKey.isActive,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
    });
  } catch (err) {
    log('ERROR', 'api-keys', 'Create failed', { error: err.message });
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ── Update API key (name, scopes, isActive, expiresAt) ───────────────────────
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, scopes, isActive, expiresAt } = req.body;

    const existing = await prisma.apiKey.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'API key not found' });

    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (isActive !== undefined) data.isActive = Boolean(isActive);
    if (expiresAt !== undefined) data.expiresAt = expiresAt ? new Date(expiresAt) : null;
    if (scopes !== undefined) {
      if (!Array.isArray(scopes) || scopes.length === 0) {
        return res.status(400).json({ error: 'At least one scope is required' });
      }
      const invalid = scopes.filter(s => !VALID_SCOPES.includes(s));
      if (invalid.length > 0) {
        return res.status(400).json({ error: `Invalid scopes: ${invalid.join(', ')}` });
      }
      data.scopes = scopes.join(',');
    }

    const updated = await prisma.apiKey.update({ where: { id }, data });
    log('INFO', 'api-keys', `API key updated: ${updated.name}`);

    return res.json({
      id: updated.id,
      name: updated.name,
      keyPrefix: updated.keyPrefix,
      scopes: updated.scopes,
      isActive: updated.isActive,
      expiresAt: updated.expiresAt,
      lastUsedAt: updated.lastUsedAt,
      createdAt: updated.createdAt,
    });
  } catch (err) {
    log('ERROR', 'api-keys', 'Update failed', { error: err.message });
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ── Delete (revoke) API key ───────────────────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.apiKey.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'API key not found' });

    await prisma.apiKey.delete({ where: { id } });
    log('INFO', 'api-keys', `API key deleted: ${existing.name}`);

    return res.json({ message: 'API key revoked' });
  } catch (err) {
    log('ERROR', 'api-keys', 'Delete failed', { error: err.message });
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ── List valid scopes ─────────────────────────────────────────────────────────
router.get('/scopes', requireAdmin, (req, res) => {
  res.json(VALID_SCOPES);
});

module.exports = router;
