const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Verify JWT token from Authorization: Bearer <token>
 * Attaches req.user = { id, email, role, name }
 */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Require Admin role
 */
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    next();
  });
}

/**
 * Require Admin or Support role
 */
function requireSupport(req, res, next) {
  requireAuth(req, res, () => {
    if (!['admin', 'support'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  });
}

/**
 * Any authenticated user (admin | viewer | support)
 */
function requireAnyRole(req, res, next) {
  requireAuth(req, res, next);
}

module.exports = { requireAuth, requireAdmin, requireSupport, requireAnyRole };
