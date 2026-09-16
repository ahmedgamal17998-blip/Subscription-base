/**
 * SSO verification endpoint for nadi (community-clone) checkout integration.
 * GET /api/sso/verify?token=TOKEN
 * Returns { ok: true, name, email, phone } or { ok: false, error }
 */
const express = require('express');
const { createHmac, timingSafeEqual } = require('crypto');
const router = express.Router();

function verifyPaymentSsoToken(token) {
  try {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const dot = token.lastIndexOf('.');
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!body || !sig) return null;
    const secret = process.env.PAYMENT_SSO_SECRET;
    if (!secret || secret.length < 16) return null;
    const expectedSig = createHmac('sha256', secret).update(body).digest('hex');
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expectedSig, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const rem = body.length % 4;
    const padded = body.replace(/-/g, '+').replace(/_/g, '/') + (rem ? '='.repeat(4 - rem) : '');
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    return payload;
  } catch { return null; }
}

router.get('/verify', (req, res) => {
  const token = req.query.token;
  if (!token) return res.json({ ok: false, error: 'NO_TOKEN' });
  const payload = verifyPaymentSsoToken(token);
  if (!payload) return res.json({ ok: false, error: 'INVALID_TOKEN' });
  return res.json({ ok: true, name: payload.name || '', email: payload.email || '', phone: payload.phone || '' });
});

module.exports = router;
