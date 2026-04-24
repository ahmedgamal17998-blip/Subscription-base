const crypto = require('crypto');
const config = require('../config');

function timingSafeEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!timingSafeEqual(key, config.ADMIN_API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { requireAdmin };
