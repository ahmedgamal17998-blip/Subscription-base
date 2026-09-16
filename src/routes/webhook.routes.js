const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { verifyHmac } = require('../middleware/hmac.middleware');
const prisma = require('../db');
const subscriptionService = require('../services/subscription.service');
const { dispatchForSubscription } = require('../services/webhook-dispatch.service');
const couponService = require('../services/coupon.service');
const config = require('../config');
const { log } = require('../utils/logger');

const router = express.Router();

const webhookLimiter = rateLimit({ windowMs: 1 * 60 * 1000, limit: 60, message: { error: 'Too many requests' } });
router.use(webhookLimiter);

// ── Transaction Webhook (from Paymob) ────────────────────────────────────────
router.post('/paymob', verifyHmac, async (req, res) => {
  try {
    if (req.body.type !== 'TRANSACTION') {
      log('INFO', 'webhook', 'Skipping non-TRANSACTION event', { type: req.body.type });
      return res.status(200).json({ message: 'ok' });
    }

    const obj = req.body.obj;
    const transactionId = String(obj.id);
    const orderId = String(obj.order?.id);
    const success = obj.success === true;
    const amountCents = obj.amount_cents;
    const failReason = obj.data?.message;

    const sourceType = obj.source_data?.type || '';
    const paymentMethod = sourceType.toLowerCase() === 'wallet' ? 'wallet' : 'card';

    // Skip pending (3DS in-progress) transactions — we'll receive the final one when captured
    if (obj.pending === true) {
      log('INFO', 'webhook', 'Skipping pending (3DS) transaction', { transactionId, orderId });
      return res.status(200).json({ message: 'ok' });
    }

    log('INFO', 'webhook', 'TRANSACTION event', { transactionId, orderId, success });

    // Find subscription — by order first (initial checkout), then by email (Paymob renewals use new orders)
    let sub = await subscriptionService.findByPaymobOrder(orderId);
    const matchedByOrder = !!sub;

    if (!sub) {
      const email = obj.order?.shipping_data?.email?.toLowerCase();
      if (email) {
        sub = await subscriptionService.findActiveByEmailAndAmount(email, amountCents);
        if (!sub) {
          // Only fall back to email alone when it is unambiguous — never guess between products
          const actives = await subscriptionService.findAllActiveByEmail(email);
          if (actives.length === 1) {
            sub = actives[0];
            log('WARN', 'webhook', 'Found by email-only fallback — verify manually', { orderId, email, subId: sub.id });
          } else if (actives.length > 1) {
            log('ERROR', 'webhook', 'Ambiguous renewal — several active subscriptions for this email', {
              orderId, transactionId, email, amountCents, subIds: actives.map((a) => a.id),
            });
          }
        }
      }
    }

    if (!sub) {
      log('ERROR', 'webhook', 'ORPHAN PAYMENT — no subscription found', {
        orderId, transactionId, amountCents, success,
        email: obj.order?.shipping_data?.email,
      });
      return res.status(200).json({ message: 'ok' });
    }

    // An unpaid attempt that was superseded or expired is still the customer's checkout for this order
    const isInitial = sub.status === 'pending' || (matchedByOrder && sub.status === 'abandoned');
    const type = isInitial ? 'initial' : 'renewal';
    const base = { subscriptionId: sub.id, paymobOrderId: orderId, transactionId, amountCents, type };

    if (type === 'renewal') {
      let ignoreReason = null;
      let needsRefund = false;
      const renewalDate = sub.nextRenewalDate ? new Date(sub.nextRenewalDate) : null;
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

      if (sub.status !== 'active') {
        ignoreReason = `Ignored: subscription status is ${sub.status}`;
      } else if (sub.cancelledAt) {
        ignoreReason = 'Ignored: subscription is pending cancellation';
      } else if (renewalDate && renewalDate > tomorrow) {
        // Charge before the period ended (e.g. Paymob's immediate first-cycle deduction on
        // subscriptions created without a start date). The customer paid twice.
        ignoreReason = 'Early charge before renewal date — refund in Paymob';
        needsRefund = success;
      }

      if (ignoreReason) {
        const claimed = await subscriptionService.claimPayment({
          ...base,
          status: needsRefund ? 'needs_refund' : (success ? 'success' : 'failed'),
          failReason: ignoreReason,
        });
        if (claimed) {
          log(needsRefund ? 'ERROR' : 'WARN', 'webhook', `${ignoreReason} — sub #${sub.id}`, {
            orderId, transactionId, amountCents, success, nextRenewalDate: renewalDate,
          });
        }
        return res.status(200).json({ message: 'ok' });
      }
    }

    // Record first; if another delivery of this webhook already did, stop here (no duplicate events)
    const claimed = await subscriptionService.claimPayment({
      ...base,
      status: success ? 'success' : 'failed',
      failReason: success ? null : failReason,
    });
    if (!claimed) {
      log('INFO', 'webhook', 'Already processed', { transactionId });
      return res.status(200).json({ message: 'Already processed' });
    }

    if (success) {
      if (type === 'initial') {
        await subscriptionService.activateSubscription(sub.id, transactionId, paymentMethod);
        await couponService.recordUse(sub.couponCode);
      } else {
        await subscriptionService.renewSuccess(sub.id, orderId, transactionId, sub.plan);
      }
    }

    const updatedSub = await subscriptionService.getSubscriptionById(sub.id);
    const eventName = `${type === 'renewal' ? 'renewal' : 'payment'}_${success ? 'success' : 'failed'}`;
    await dispatchForSubscription(eventName, updatedSub, {
      type,
      payment_status: success ? 'success' : 'failed',
      payment_method: paymentMethod,
      amount: amountCents / 100,
      transaction_id: transactionId,
      ...(success
        ? { coupon_code: updatedSub.couponCode || null, discount_cents: updatedSub.discountCents || 0 }
        : { fail_reason: failReason || '' }),
    });

    if (success) log('INFO', 'webhook', `Payment ${type} — SUCCESS #${sub.id} (${paymentMethod})`);
    else log('WARN', 'webhook', `Payment ${type} — FAILED #${sub.id}`, { failReason });

    return res.status(200).json({ message: 'ok' });
  } catch (err) {
    log('ERROR', 'webhook', 'Webhook processing error', { error: err.message });
    return res.status(200).json({ message: 'ok' });
  }
});

// ── Subscription Webhook (Paymob Subscription Module) ───────────────────────
router.post('/paymob-subscription', async (req, res) => {
  try {
    const { subscription_data, trigger_type, hmac } = req.body;

    if (!subscription_data || !trigger_type || !hmac) {
      log('WARN', 'sub-webhook', 'Missing fields in subscription webhook');
      return res.status(200).json({ message: 'ok' });
    }

    const hmacString = `${trigger_type}for${subscription_data.id}`;
    const calculatedHmac = crypto
      .createHmac('sha512', config.PAYMOB_HMAC_SECRET)
      .update(hmacString)
      .digest('hex');

    const calcBuf = Buffer.from(calculatedHmac, 'hex');
    const receivedBuf = Buffer.from(hmac || '', 'hex');
    if (calcBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(calcBuf, receivedBuf)) {
      log('WARN', 'sub-webhook', 'HMAC verification failed', { trigger_type });
      return res.status(401).json({ error: 'Invalid HMAC' });
    }

    log('INFO', 'sub-webhook', 'Subscription webhook received', {
      trigger_type, subscriptionId: subscription_data.id, state: subscription_data.state,
    });

    if (trigger_type === 'created') {
      const initialTxnId = subscription_data.initial_transaction;
      let sub = null;

      if (initialTxnId) {
        const payment = await subscriptionService.findPaymentByTransactionId(String(initialTxnId));
        if (payment) sub = await subscriptionService.getSubscriptionById(payment.subscriptionId);
      }

      if (!sub && subscription_data.client_info?.email) {
        const email = subscription_data.client_info.email;
        if (subscription_data.plan_id) {
          // Search BOTH active AND pending — race condition: this webhook sometimes fires
          // before the TRANSACTION webhook has activated the subscription.
          sub = await prisma.subscription.findFirst({
            where: {
              email,
              status: { in: ['active', 'pending'] },
              paymobPlanId: String(subscription_data.plan_id),
            },
            orderBy: { createdAt: 'desc' },
            include: { product: true },
          });
        }
        if (!sub) {
          // Last resort: most recent active or pending by email
          sub = await prisma.subscription.findFirst({
            where: { email, status: { in: ['active', 'pending'] } },
            orderBy: { createdAt: 'desc' },
            include: { product: true },
          });
          if (sub) log('WARN', 'sub-webhook', 'Found by email-only fallback', { email, subId: sub.id });
        }
      }

      if (sub) {
        // First automatic deduction: starts_at when it is in the future (we send a start date),
        // otherwise next_billing (older subscriptions that started on the checkout day).
        const startsAt = subscription_data.starts_at ? new Date(subscription_data.starts_at) : null;
        const firstDeduction = startsAt && startsAt > new Date()
          ? startsAt
          : (subscription_data.next_billing ? new Date(subscription_data.next_billing) : null);
        await subscriptionService.updatePaymobSubscription(sub.id, {
          paymobSubscriptionId: subscription_data.id,
          nextRenewalDate: firstDeduction || undefined,
        });
        log('INFO', 'sub-webhook', `Subscription #${sub.id} linked to Paymob sub ${subscription_data.id}`);
      }
    } else if (trigger_type === 'suspended') {
      const sub = await subscriptionService.findByPaymobSubscriptionId(subscription_data.id);
      if (!sub || sub.status !== 'active') {
        // Unknown, or already finalized locally — nothing to do
      } else if (sub.cancelledAt && sub.nextRenewalDate > new Date()) {
        // We suspended it ourselves on cancel. The customer keeps access until the paid period
        // ends; the daily cron finalizes it and sends the `cancelled` event then.
        log('INFO', 'sub-webhook', `Subscription #${sub.id} suspended on Paymob; active until period end`);
      } else {
        await subscriptionService.markCancelled(sub.id);
        await dispatchForSubscription('cancelled', sub, { type: 'cancelled', payment_status: 'cancelled' });
        log('INFO', 'sub-webhook', `Subscription #${sub.id} suspended`);
      }
    } else if (trigger_type === 'resumed') {
      log('INFO', 'sub-webhook', `Subscription resumed on Paymob`, { paymobSubId: subscription_data.id });
    }

    return res.status(200).json({ message: 'ok' });
  } catch (err) {
    log('ERROR', 'sub-webhook', 'Subscription webhook error', { error: err.message });
    return res.status(200).json({ message: 'ok' });
  }
});

// ── Redirect (after customer completes checkout) ──────────────────────────────
router.get('/paymob-redirect', async (req, res) => {
  const success = req.query.success === 'true';
  const orderId = req.query.order;

  let productSlug = '';
  let productName = '';
  let customSuccessUrl = null;
  let customFailureUrl = null;
  let amountValue = '';
  let currencyValue = '';
  let subId = '';

  if (orderId) {
    try {
      const sub = await subscriptionService.findByPaymobOrder(String(orderId));
      if (sub?.product) {
        productSlug = sub.product.slug;
        productName = sub.product.name;
        amountValue = sub.amountCents ? (sub.amountCents / 100).toString() : '';
        currencyValue = sub.currency || 'EGP';
        subId = String(sub.id);

        // Load custom redirect URLs from product settings
        const settings = await prisma.productSettings.findUnique({
          where: { productId: sub.product.id },
        });
        if (settings) {
          customSuccessUrl = settings.successUrl || null;
          customFailureUrl = settings.failureUrl || null;
        }
      }
    } catch (_) { /* ignore — redirect still works without product info */ }
  }

  if (success) {
    if (customSuccessUrl) return res.redirect(customSuccessUrl);
    const params = new URLSearchParams();
    if (productSlug) params.set('product_slug', productSlug);
    if (productName) params.set('product', productName);
    if (amountValue) params.set('amount', amountValue);
    if (currencyValue) params.set('currency', currencyValue);
    if (subId) params.set('sub', subId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return res.redirect(`/success.html${qs}`);
  } else {
    if (customFailureUrl) return res.redirect(customFailureUrl);
    const params = new URLSearchParams();
    if (productSlug) params.set('product_slug', productSlug);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return res.redirect(`/failure.html${qs}`);
  }
});

module.exports = router;
