/**
 * Analytics & Reporting routes
 * All require at least viewer role
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../db');
const { requireAnyRole } = require('../middleware/auth.middleware');
const { log } = require('../utils/logger');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 60 });

// ── GET /api/analytics/overview ───────────────────────────────────────────────
// High-level KPIs: MRR, total revenue, active subs, churn, etc.
router.get('/overview', limiter, requireAnyRole, async (req, res) => {
  try {
    const { productId } = req.query;
    const pId = productId ? parseInt(productId) : undefined;
    const where = pId ? { productId: pId } : {};

    const [
      totalActive,
      totalCancelled,
      totalExpired,
      totalAbandoned,
      totalPending,
      revenueAll,
      revenueInitial,
      revenueRenewals,
      failedPayments,
    ] = await prisma.$transaction([
      prisma.subscription.count({ where: { ...where, status: 'active' } }),
      prisma.subscription.count({ where: { ...where, status: 'cancelled' } }),
      prisma.subscription.count({ where: { ...where, status: 'expired' } }),
      prisma.subscription.count({ where: { ...where, status: 'abandoned' } }),
      prisma.subscription.count({ where: { ...where, status: 'pending' } }),
      prisma.payment.aggregate({
        where: { status: 'success', ...(pId ? { subscription: { productId: pId } } : {}) },
        _sum: { amountCents: true },
      }),
      prisma.payment.aggregate({
        where: { status: 'success', type: 'initial', ...(pId ? { subscription: { productId: pId } } : {}) },
        _sum: { amountCents: true },
      }),
      prisma.payment.aggregate({
        where: { status: 'success', type: 'renewal', ...(pId ? { subscription: { productId: pId } } : {}) },
        _sum: { amountCents: true },
      }),
      prisma.payment.count({
        where: { status: 'failed', ...(pId ? { subscription: { productId: pId } } : {}) },
      }),
    ]);

    // MRR: sum of amountCents of active monthly-equivalent subscriptions
    // Simplified: total active * avg monthly revenue
    const activeSubs = await prisma.subscription.findMany({
      where: { ...where, status: 'active' },
      select: { amountCents: true, plan: true },
    });

    const planMonthlyFactor = { weekly: 4.33, monthly: 1, '3-months': 0.33, '6-months': 0.17, yearly: 0.083 };
    const mrr = activeSubs.reduce((sum, s) => {
      const factor = planMonthlyFactor[s.plan] ?? 1;
      return sum + (s.amountCents * factor);
    }, 0);

    // Churn rate: cancelled / (active + cancelled) in the last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [newSubs30, cancelled30] = await prisma.$transaction([
      prisma.subscription.count({ where: { ...where, createdAt: { gte: thirtyDaysAgo } } }),
      prisma.subscription.count({ where: { ...where, status: 'cancelled', updatedAt: { gte: thirtyDaysAgo } } }),
    ]);
    const churnRate = newSubs30 > 0 ? ((cancelled30 / (totalActive + cancelled30)) * 100).toFixed(1) : '0.0';

    return res.json({
      kpis: {
        totalActive,
        totalCancelled,
        totalExpired,
        totalAbandoned,
        totalPending,
        mrr: Math.round(mrr),
        totalRevenue: revenueAll._sum.amountCents || 0,
        totalInitialRevenue: revenueInitial._sum.amountCents || 0,
        totalRenewalRevenue: revenueRenewals._sum.amountCents || 0,
        failedPayments,
        churnRate: parseFloat(churnRate),
        newSubs30,
        cancelled30,
      },
    });
  } catch (err) {
    log('ERROR', 'analytics', 'Overview failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to get analytics overview.' });
  }
});

// ── GET /api/analytics/monthly ────────────────────────────────────────────────
// Monthly breakdown: new subs, revenue (initial + renewals), cancellations
// Query: ?months=12&productId=
router.get('/monthly', limiter, requireAnyRole, async (req, res) => {
  try {
    const months = Math.min(Math.max(parseInt(req.query.months) || 12, 1), 24);
    const productId = req.query.productId ? parseInt(req.query.productId) : undefined;
    const pWhere = productId ? { productId } : {};

    const result = [];
    const now = new Date();

    for (let i = months - 1; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const label = start.toLocaleString('en', { month: 'short', year: '2-digit' });

      const [newSubs, cancellations, payments] = await prisma.$transaction([
        prisma.subscription.count({
          where: { ...pWhere, createdAt: { gte: start, lt: end } },
        }),
        prisma.subscription.count({
          where: { ...pWhere, status: 'cancelled', updatedAt: { gte: start, lt: end } },
        }),
        prisma.payment.findMany({
          where: {
            status: 'success',
            createdAt: { gte: start, lt: end },
            ...(productId ? { subscription: { productId } } : {}),
          },
          select: { amountCents: true, type: true },
        }),
      ]);

      const initialRevenue = payments.filter(p => p.type === 'initial').reduce((s, p) => s + p.amountCents, 0);
      const renewalRevenue = payments.filter(p => p.type === 'renewal').reduce((s, p) => s + p.amountCents, 0);

      result.push({
        label,
        month: start.toISOString().slice(0, 7),
        newSubs,
        cancellations,
        initialRevenue,
        renewalRevenue,
        totalRevenue: initialRevenue + renewalRevenue,
        totalPayments: payments.length,
      });
    }

    return res.json({ data: result });
  } catch (err) {
    log('ERROR', 'analytics', 'Monthly data failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to get monthly analytics.' });
  }
});

// ── GET /api/analytics/payments ───────────────────────────────────────────────
// Recent payments list with filters
router.get('/payments', limiter, requireAnyRole, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const { type, status, productId } = req.query;

    const where = {};
    if (type) where.type = type;
    if (status) where.status = status;
    if (productId) where.subscription = { productId: parseInt(productId) };

    const [payments, total] = await prisma.$transaction([
      prisma.payment.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          subscription: {
            select: {
              email: true, firstName: true, lastName: true,
              plan: true, currency: true,
              product: { select: { id: true, name: true } },
            },
          },
        },
      }),
      prisma.payment.count({ where }),
    ]);

    return res.json({ payments, total, page, limit });
  } catch (err) {
    log('ERROR', 'analytics', 'Payments list failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to get payments.' });
  }
});

// ── GET /api/analytics/conversion ────────────────────────────────────────────
// Conversion: pending → active, abandoned, success rate per product
router.get('/conversion', limiter, requireAnyRole, async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { isActive: true },
      select: { id: true, name: true, slug: true },
    });

    const data = await Promise.all(
      products.map(async (product) => {
        const [total, active, abandoned, cancelled] = await prisma.$transaction([
          prisma.subscription.count({ where: { productId: product.id } }),
          prisma.subscription.count({ where: { productId: product.id, status: 'active' } }),
          prisma.subscription.count({ where: { productId: product.id, status: 'abandoned' } }),
          prisma.subscription.count({ where: { productId: product.id, status: 'cancelled' } }),
        ]);
        const conversionRate = total > 0 ? ((active / total) * 100).toFixed(1) : '0.0';
        return { product, total, active, abandoned, cancelled, conversionRate: parseFloat(conversionRate) };
      })
    );

    return res.json({ data });
  } catch (err) {
    log('ERROR', 'analytics', 'Conversion failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to get conversion analytics.' });
  }
});

module.exports = router;
