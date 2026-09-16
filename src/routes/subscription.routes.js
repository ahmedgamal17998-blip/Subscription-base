const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAdmin, requireSupport, requireAnyRole } = require('../middleware/auth.middleware');
const { requireAuthOrApiKey } = require('../middleware/api-key.middleware');
const subscriptionService = require('../services/subscription.service');
const paymobService = require('../services/paymob.service');
const { dispatchForSubscription } = require('../services/webhook-dispatch.service');
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
    const sub = result.subscription;

    // Stop future charges on Paymob now; the customer stays active until the period ends
    try {
      const suspendedId = await paymobService.suspendForSubscription(sub);
      if (suspendedId) {
        if (!sub.paymobSubscriptionId) {
          await subscriptionService.updatePaymobSubscription(subscriptionId, { paymobSubscriptionId: suspendedId });
        }
        log('INFO', 'subscriptions', `Paymob subscription ${suspendedId} suspended for #${subscriptionId}`);
      } else {
        log('WARN', 'subscriptions',
          '⚠️ MANUAL ACTION REQUIRED — Paymob subscription not found. Suspend it on the Paymob dashboard.',
          { subscriptionId, email: sub.email, paymobPlanId: sub.paymobPlanId });
      }
    } catch (paymobErr) {
      log('WARN', 'subscriptions', '⚠️ Failed to suspend Paymob subscription — use "Sync Paymob"', {
        subscriptionId, error: paymobErr.message,
      });
    }

    await dispatchForSubscription('cancel_requested', sub, {
      type: 'cancel_requested',
      payment_status: 'cancel_requested',
      active_until: result.activeUntil,
    });

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

// ── Force suspend on Paymob (for already-cancelled subs that Paymob still charges) ──
router.post('/:id/paymob-suspend', requireAuthOrApiKey('subscriptions:write'), async (req, res) => {
  try {
    const subscriptionId = parseInt(req.params.id);
    if (!Number.isFinite(subscriptionId) || subscriptionId <= 0) {
      return res.status(400).json({ error: 'Invalid subscription ID' });
    }
    const sub = await subscriptionService.getSubscriptionById(subscriptionId);
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });

    const suspendedId = await paymobService.suspendForSubscription(sub);
    if (!suspendedId) {
      return res.status(404).json({
        error: 'Could not find matching Paymob subscription. Please suspend manually on the Paymob dashboard.',
      });
    }
    if (!sub.paymobSubscriptionId) {
      await subscriptionService.updatePaymobSubscription(subscriptionId, { paymobSubscriptionId: suspendedId });
    }
    log('INFO', 'subscriptions', `Force-suspended Paymob sub ${suspendedId} for local #${subscriptionId}`);
    return res.json({ success: true, message: 'Paymob subscription suspended.' });
  } catch (err) {
    log('ERROR', 'subscriptions', 'paymob-suspend failed', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
