/**
 * Coupons management + public validation endpoint
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth.middleware');
const { log } = require('../utils/logger');

const router = express.Router();

const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100 });
const publicLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20 });

// ── Public: validate coupon ───────────────────────────────────────────────────
router.post('/validate', publicLimiter, async (req, res) => {
  try {
    const { code, productId, amountCents } = req.body;
    if (!code || !amountCents) return res.status(400).json({ error: 'code and amountCents are required.' });

    const coupon = await prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });

    if (!coupon || !coupon.isActive) {
      return res.status(404).json({ error: 'Invalid or inactive coupon code.' });
    }

    // Check product restriction
    if (coupon.productId && productId && coupon.productId !== parseInt(productId)) {
      return res.status(400).json({ error: 'This coupon is not valid for this product.' });
    }

    // Check expiry
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
      return res.status(400).json({ error: 'This coupon has expired.' });
    }

    // Check usage limit
    if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
      return res.status(400).json({ error: 'This coupon has reached its usage limit.' });
    }

    // Calculate discount
    let discountCents = 0;
    if (coupon.discountType === 'percentage') {
      discountCents = Math.round((amountCents * coupon.discountValue) / 100);
    } else {
      discountCents = Math.round(coupon.discountValue);
    }

    const finalAmount = Math.max(0, amountCents - discountCents);

    return res.json({
      valid: true,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discountCents,
      finalAmount,
      appliesTo: coupon.appliesTo,
    });
  } catch (err) {
    log('ERROR', 'coupons', 'Coupon validation error', { error: err.message });
    return res.status(500).json({ error: 'Failed to validate coupon.' });
  }
});

// ── Admin: list coupons ───────────────────────────────────────────────────────
router.get('/', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const coupons = await prisma.coupon.findMany({
      include: { product: { select: { id: true, name: true, slug: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(coupons);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list coupons.' });
  }
});

// ── Admin: create coupon ──────────────────────────────────────────────────────
router.post('/', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { code, discountType, discountValue, appliesTo, maxUses, expiresAt, productId } = req.body;

    if (!code || !discountType || discountValue === undefined) {
      return res.status(400).json({ error: 'code, discountType, and discountValue are required.' });
    }
    if (!['percentage', 'fixed'].includes(discountType)) {
      return res.status(400).json({ error: 'discountType must be "percentage" or "fixed".' });
    }
    if (discountType === 'percentage' && (discountValue < 0 || discountValue > 100)) {
      return res.status(400).json({ error: 'Percentage discount must be between 0 and 100.' });
    }
    if (discountValue < 0) {
      return res.status(400).json({ error: 'discountValue must be positive.' });
    }

    const coupon = await prisma.coupon.create({
      data: {
        code: code.trim().toUpperCase(),
        discountType,
        discountValue: parseFloat(discountValue),
        appliesTo: appliesTo || 'first_payment',
        maxUses: maxUses ? parseInt(maxUses) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        productId: productId ? parseInt(productId) : null,
      },
      include: { product: { select: { id: true, name: true, slug: true } } },
    });

    log('INFO', 'coupons', 'Coupon created', { code: coupon.code, by: req.user.email });
    return res.status(201).json(coupon);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'A coupon with this code already exists.' });
    return res.status(500).json({ error: 'Failed to create coupon.' });
  }
});

// ── Admin: update coupon ──────────────────────────────────────────────────────
router.put('/:id', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { discountType, discountValue, appliesTo, maxUses, expiresAt, productId, isActive } = req.body;
    const data = {};
    if (discountType) data.discountType = discountType;
    if (discountValue !== undefined) data.discountValue = parseFloat(discountValue);
    if (appliesTo) data.appliesTo = appliesTo;
    if (maxUses !== undefined) data.maxUses = maxUses ? parseInt(maxUses) : null;
    if (expiresAt !== undefined) data.expiresAt = expiresAt ? new Date(expiresAt) : null;
    if (productId !== undefined) data.productId = productId ? parseInt(productId) : null;
    if (typeof isActive === 'boolean') data.isActive = isActive;

    const coupon = await prisma.coupon.update({
      where: { id: parseInt(req.params.id) },
      data,
      include: { product: { select: { id: true, name: true, slug: true } } },
    });
    return res.json(coupon);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Coupon not found.' });
    return res.status(500).json({ error: 'Failed to update coupon.' });
  }
});

// ── Admin: delete coupon ──────────────────────────────────────────────────────
router.delete('/:id', adminLimiter, requireAdmin, async (req, res) => {
  try {
    await prisma.coupon.delete({ where: { id: parseInt(req.params.id) } });
    return res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Coupon not found.' });
    return res.status(500).json({ error: 'Failed to delete coupon.' });
  }
});

module.exports = router;
