/**
 * Outbound Webhooks management
 * Replaces the hardcoded GHL_WEBHOOK_URL with a DB-driven webhook list.
 */
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth.middleware');
const { log } = require('../utils/logger');

function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100 });

const VALID_EVENTS = [
  'payment_success', 'payment_failed',
  'renewal_success', 'renewal_failed',
  'cancelled', 'cancel_requested', 'expired',
];

function parseEvents(eventsStr) {
  if (Array.isArray(eventsStr)) return eventsStr.map(e => String(e).trim()).filter(Boolean);
  return (eventsStr || '').split(',').map(e => e.trim()).filter(Boolean);
}

function validateEvents(events) {
  for (const e of events) {
    if (!VALID_EVENTS.includes(e)) return `Invalid event: ${e}`;
  }
  return null;
}

// ── GET /api/webhooks ─────────────────────────────────────────────────────────
router.get('/', limiter, requireAdmin, async (req, res) => {
  try {
    const webhooks = await prisma.outboundWebhook.findMany({
      include: { product: { select: { id: true, name: true, slug: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ webhooks, validEvents: VALID_EVENTS });
  } catch (err) {
    log('ERROR', 'webhooks', 'Failed to list webhooks', { error: err.message });
    return res.status(500).json({ error: 'Failed to list webhooks.' });
  }
});

// ── POST /api/webhooks ────────────────────────────────────────────────────────
router.post('/', limiter, requireAdmin, async (req, res) => {
  try {
    const { name, url, events, productId } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url are required.' });
    if (!url.startsWith('https://')) return res.status(400).json({ error: 'URL must use HTTPS.' });

    const eventsArr = parseEvents(events || VALID_EVENTS.join(','));
    const err = validateEvents(eventsArr);
    if (err) return res.status(400).json({ error: err });

    const secret = generateSecret();

    const webhook = await prisma.outboundWebhook.create({
      data: {
        name: name.trim(),
        url,
        events: eventsArr.join(','),
        secret,
        productId: productId ? parseInt(productId) : null,
        isActive: true,
      },
      include: { product: { select: { id: true, name: true, slug: true } } },
    });

    log('INFO', 'webhooks', 'Webhook created', { id: webhook.id, name: webhook.name });
    // Return full secret once on creation
    return res.status(201).json({ ...webhook, secret });
  } catch (err) {
    log('ERROR', 'webhooks', 'Failed to create webhook', { error: err.message });
    return res.status(500).json({ error: 'Failed to create webhook.' });
  }
});

// ── PUT /api/webhooks/:id ─────────────────────────────────────────────────────
router.put('/:id', limiter, requireAdmin, async (req, res) => {
  try {
    const { name, url, events, productId, isActive } = req.body;
    const data = {};
    if (name) data.name = name.trim();
    if (url) {
      if (!url.startsWith('https://')) return res.status(400).json({ error: 'URL must use HTTPS.' });
      data.url = url;
    }
    if (events) {
      const eventsArr = parseEvents(events);
      const err = validateEvents(eventsArr);
      if (err) return res.status(400).json({ error: err });
      data.events = eventsArr.join(',');
    }
    if (productId !== undefined) data.productId = productId ? parseInt(productId) : null;
    if (typeof isActive === 'boolean') data.isActive = isActive;

    const webhook = await prisma.outboundWebhook.update({
      where: { id: parseInt(req.params.id) },
      data,
      include: { product: { select: { id: true, name: true, slug: true } } },
    });

    log('INFO', 'webhooks', 'Webhook updated', { id: webhook.id });
    return res.json(webhook);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Webhook not found.' });
    return res.status(500).json({ error: 'Failed to update webhook.' });
  }
});

// ── POST /api/webhooks/:id/regenerate-secret ─────────────────────────────────
router.post('/:id/regenerate-secret', limiter, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const secret = generateSecret();
    const webhook = await prisma.outboundWebhook.update({
      where: { id },
      data: { secret },
    });
    log('INFO', 'webhooks', 'Secret regenerated', { id: webhook.id });
    return res.json({ id: webhook.id, secret });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Webhook not found.' });
    return res.status(500).json({ error: 'Failed to regenerate secret.' });
  }
});

// ── GET /api/webhooks/:id/secret ──────────────────────────────────────────────
router.get('/:id/secret', limiter, requireAdmin, async (req, res) => {
  try {
    const webhook = await prisma.outboundWebhook.findUnique({
      where: { id: parseInt(req.params.id) },
      select: { id: true, secret: true },
    });
    if (!webhook) return res.status(404).json({ error: 'Webhook not found.' });
    return res.json({ id: webhook.id, secret: webhook.secret });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get secret.' });
  }
});

// ── DELETE /api/webhooks/:id ──────────────────────────────────────────────────
router.delete('/:id', limiter, requireAdmin, async (req, res) => {
  try {
    await prisma.outboundWebhook.delete({ where: { id: parseInt(req.params.id) } });
    log('INFO', 'webhooks', 'Webhook deleted', { id: req.params.id });
    return res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Webhook not found.' });
    return res.status(500).json({ error: 'Failed to delete webhook.' });
  }
});

module.exports = router;
