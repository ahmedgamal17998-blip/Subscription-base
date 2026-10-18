/**
 * Coupons management + public validation endpoint
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth.middleware');
const { log } = require('../utils/logger');
const { evaluateCoupon, finalAmountAfterDiscount } = require('../services/coupon.service');

const router = express.Router();

const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100 });
const publicLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20 });

// appliesTo: first_payment | renewals (+ renewalCount: number of discounted renewals, empty = all)
function parseScope(appliesTo, renewalCount) {
  const value = appliesTo === 'all_renewals' ? 'renewals' : (appliesTo || 'first_payment');
  if (!['first_payment', 'renewals'].includes(value)) return { error: 'appliesTo must be "first_payment" or "renewals".' };
  if (value === 'first_payment') return { appliesTo: value, renewalCount: null };
  if (renewalCount === undefined || renewalCount === null || renewalCount === '') return { appliesTo: value, renewalCount: null };
  const n = Number(renewalCount);
  if (!Number.isInteger(n) || n < 1 || n > 120) return { error: 'renewalCount must be a whole number between 1 and 120.' };
  return { appliesTo: value, renewalCount: n };
}

// ── Public: validate coupon ───────────────────────────────────────────────────
router.post('/validate', publicLimiter, async (req, res) => {
  try {
    const { code, productId, amountCents } = req.body;
    if (!code || !amountCents) return res.status(400).json({ error: 'code and amountCents are required.' });

    const result = await evaluateCoupon(code, productId, amountCents);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    const { coupon, discountCents } = result;
    const finalAmount = finalAmountAfterDiscount(amountCents, discountCents);

    return res.json({
      valid: true,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discountCents,
      finalAmount,
      appliesTo: coupon.appliesTo,
      renewalCount: coupon.renewalCount ?? null,
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
    const scope = parseScope(appliesTo, req.body.renewalCount);
    if (scope.error) return res.status(400).json({ error: scope.error });

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
        appliesTo: scope.appliesTo,
        renewalCount: scope.renewalCount,
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
    if (appliesTo !== undefined || req.body.renewalCount !== undefined) {
      const scope = parseScope(appliesTo, req.body.renewalCount);
      if (scope.error) return res.status(400).json({ error: scope.error });
      data.appliesTo = scope.appliesTo;
      data.renewalCount = scope.renewalCount;
    }
    if (discountType && !['percentage', 'fixed'].includes(discountType)) {
      return res.status(400).json({ error: 'discountType must be "percentage" or "fixed".' });
    }
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
