/**
 * API Key middleware — for external integrations
 *
 * Usage:
 *   router.get('/path', requireApiKey('subscriptions:read'), handler)
 *
 * External callers send:   x-api-key: sk_live_xxxx...
 *
 * requireAuthOrApiKey(scope) accepts EITHER a valid JWT (admin dashboard)
 * OR a valid API key with the required scope (external tools).
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const config = require('../config');
const { log } = require('../utils/logger');

// ── Verify API key only ───────────────────────────────────────────────────────
async function requireApiKey(scope) {
  return async (req, res, next) => {
    const rawKey = req.headers['x-api-key'];
    if (!rawKey) {
      return res.status(401).json({ error: 'API key required (x-api-key header)' });
    }

    const result = await _verifyKey(rawKey, scope);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    req.apiKey = result.apiKey;
    next();
  };
}

// ── Accept JWT (dashboard) OR API key (external) ──────────────────────────────
function requireAuthOrApiKey(scope) {
  return async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const rawKey = req.headers['x-api-key'];

    // Try JWT first
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        const payload = jwt.verify(token, config.JWT_SECRET);
        req.user = payload;
        return next();
      } catch {
        // Fall through to API key check
      }
    }

    // Try API key
    if (rawKey) {
      const result = await _verifyKey(rawKey, scope);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      req.apiKey = result.apiKey;
      return next();
    }

    return res.status(401).json({ error: 'Authentication required' });
  };
}

// ── Internal helper ───────────────────────────────────────────────────────────
async function _verifyKey(rawKey, scope) {
  try {
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hash } });

    if (!apiKey || !apiKey.isActive) {
      return { ok: false, status: 401, error: 'Invalid or revoked API key' };
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      return { ok: false, status: 401, error: 'API key expired' };
    }

    if (scope) {
      const scopes = apiKey.scopes.split(',').map(s => s.trim());
      if (!scopes.includes(scope)) {
        return { ok: false, status: 403, error: `Scope required: ${scope}` };
      }
    }

    // Update lastUsedAt asynchronously (don't await — don't slow down request)
    prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => {});

    return { ok: true, apiKey };
  } catch (err) {
    log('ERROR', 'api-key', 'Verification error', { error: err.message });
    return { ok: false, status: 500, error: 'Internal error' };
  }
}

module.exports = { requireApiKey, requireAuthOrApiKey };
