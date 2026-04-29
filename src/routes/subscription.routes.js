const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAdmin, requireSupport, requireAnyRole } = require('../middleware/auth.middleware');
const { requireAuthOrApiKey } = require('../middleware/api-key.middleware');
const subscriptionService = require('../services/subscription.service');
const ghlService = require('../services/ghl.service');
const { dispatch } = require('../services/webhook-dispatch.service');
const { log } = require('../utils/logger');

const router = express.Router();

const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, message: { error: 'Too many requests' } });
router.use(adminLimiter);

// ── Dashboard Stats ──────────────────────────────────────────────────────────
router.get('/stats', requireAnyRole, async (req, res) => {
  try {
    const stats = await subscriptionService.getDashboardStats();
    return res.status(200).json(stats);
  } catch (err) {
    log('ERROR', 'subscriptions', 'Failed to get stats', { error: err.message });
    return res.status(500).json({ error: 'Failed to get stats.' });
  }
});

// IMPORTANT: /trigger-cron must be registered BEFORE /:id
router.post('/trigger-cron', requireAdmin, async (req, res) => {
  const { runCleanupJob } = require('../jobs/renewal.job');
  runCleanupJob().catch((err) => log('ERROR', 'trigger-cron', 'Manual cron failed', { error: err.message }));
  return res.status(200).json({ success: true, message: 'Cron job triggered manually.' });
});

router.get('/', requireAuthOrApiKey('subscriptions:read'), async (req, res) => {
  try {
    const { status, productId, search } = req.query;
    const page = Math.max(+(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(+(req.query.limit) || 20, 1), 100);
    const result = await subscriptionService.listSubscriptions({ status, page, limit, productId: productId ? +productId : undefined, search: search || '' });
    return res.status(200).json(result);
  } catch (err) {
    log('ERROR', 'subscriptions', 'Failed to list subscriptions', { error: err.message });
    return res.status(500).json({ error: 'Failed to list subscriptions.' });
  }
});

router.get('/:id', requireAuthOrApiKey('subscriptions:read'), async (req, res) => {
  try {
    const sub = await subscriptionService.getSubscriptionWithPayments(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    return res.status(200).json(sub);
  } catch (err) {
    log('ERROR', 'subscriptions', 'Failed to get subscription', { error: err.message });
    return res.status(500).json({ error: 'Failed to get subscription.' });
  }
});

router.post('/:id/cancel', requireAuthOrApiKey('subscriptions:write'), async (req, res) => {
  try {
    const subscriptionId = parseInt(req.params.id);
    if (!Number.isFinite(subscriptionId) || subscriptionId <= 0) {
      return res.status(400).json({ error: 'Invalid subscription ID' });
    }
    const result = await subscriptionService.cancelSubscription(subscriptionId);
    // Suspend on Paymob if linked
    if (result.subscription.paymobSubscriptionId) {
      try {
        const paymobService = require('../services/paymob.service');
        const authToken = await paymobService.authenticate();
        await paymobService.suspendSubscription(authToken, result.subscription.paymobSubscriptionId);
        log('INFO', 'subscriptions', `Paymob subscription ${result.subscription.paymobSubscriptionId} suspended`);
      } catch (paymobErr) {
        log('WARN', 'subscriptions', 'Failed to suspend Paymob subscription', { error: paymobErr.message });
      }
    }
    await ghlService.notifyCancelRequested({
      subscriptionId,
      email: result.subscription.email,
      firstName: result.subscription.firstName,
      lastName: result.subscription.lastName,
      phone: result.subscription.phone,
      plan: result.subscription.plan,
      activeUntil: result.activeUntil,
      createdAt: result.subscription.createdAt,
      productName: result.subscription.product?.name, productId: result.subscription.product?.id,
    });

    // Fire outbound webhooks for cancel_requested
    await dispatch('cancel_requested', {
      type: 'cancel_requested',
      full_name: `${result.subscription.firstName} ${result.subscription.lastName}`,
      email: result.subscription.email,
      phone: result.subscription.phone,
      plan: result.subscription.plan,
      product_name: result.subscription.product?.name || '',
      product_id: result.subscription.product?.id ? String(result.subscription.product.id) : '',
      payment_status: 'cancel_requested',
      amount: (result.subscription.amountCents || 0) / 100,
      currency: result.subscription.currency || 'EGP',
      active_until: result.activeUntil,
      date_of_creation: result.subscription.createdAt,
      subscription_id: subscriptionId,
    }, result.subscription.productId);

    return res.status(200).json({
      success: true,
      message: 'Subscription will remain active until the end of the current billing period.',
      activeUntil: result.activeUntil,
    });
  } catch (err) {
    if (err.message.includes('Cannot cancel')) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.includes('not found') || err.code === 'P2025') {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    log('ERROR', 'subscriptions', 'Failed to cancel subscription', { error: err.message });
    return res.status(500).json({ error: 'Failed to cancel subscription.' });
  }
});

router.post('/:id/reactivate', requireAuthOrApiKey('subscriptions:write'), async (req, res) => {
  try {
    const subscriptionId = parseInt(req.params.id);
    if (!Number.isFinite(subscriptionId) || subscriptionId <= 0) {
      return res.status(400).json({ error: 'Invalid subscription ID' });
    }
    const sub = await subscriptionService.reactivateSubscription(subscriptionId);
    log('INFO', 'subscriptions', `Subscription #${subscriptionId} reactivated`);
    return res.status(200).json({ success: true, subscription: sub });
  } catch (err) {
    if (err.message.includes('Cannot reactivate')) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.includes('not found') || err.code === 'P2025') {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    log('ERROR', 'subscriptions', 'Failed to reactivate subscription', { error: err.message });
    return res.status(500).json({ error: 'Failed to reactivate subscription.' });
  }
});

module.exports = router;
