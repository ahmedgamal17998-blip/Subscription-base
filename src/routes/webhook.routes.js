const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { verifyHmac } = require('../middleware/hmac.middleware');
const prisma = require('../db');
const subscriptionService = require('../services/subscription.service');
const { dispatch } = require('../services/webhook-dispatch.service');
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

    log('INFO', 'webhook', 'TRANSACTION event', { transactionId, orderId, success });

    // Idempotency check
    const existing = await subscriptionService.findPaymentByTransactionId(transactionId);
    if (existing) {
      log('INFO', 'webhook', 'Already processed', { transactionId });
      return res.status(200).json({ message: 'Already processed' });
    }

    // Find subscription
    let sub = await subscriptionService.findByPaymobOrder(orderId);

    if (!sub) {
      const email = obj.order?.shipping_data?.email;
      if (email) {
        sub = await subscriptionService.findActiveByEmailAndAmount(email, amountCents);
        if (sub) {
          log('INFO', 'webhook', 'Found by email+amount fallback', { orderId, email, subId: sub.id });
        } else {
          sub = await subscriptionService.findActiveByEmail(email);
          if (sub) {
            log('WARN', 'webhook', 'Found by email-only fallback — verify manually', { orderId, email, subId: sub.id });
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

    const type = sub.status === 'pending' ? 'initial' : 'renewal';

    if (type === 'renewal' && sub.status !== 'active') {
      log('WARN', 'webhook', `Ignoring renewal for non-active sub #${sub.id}`, { status: sub.status });
      await subscriptionService.logPayment({
        subscriptionId: sub.id, paymobOrderId: orderId, transactionId,
        amountCents, status: success ? 'success' : 'failed', type: 'renewal',
        failReason: `Ignored: subscription status is ${sub.status}`,
      });
      return res.status(200).json({ message: 'ok' });
    }

    if (type === 'renewal' && sub.cancelledAt) {
      log('WARN', 'webhook', `Ignoring renewal for cancelled sub #${sub.id}`);
      await subscriptionService.logPayment({
        subscriptionId: sub.id, paymobOrderId: orderId, transactionId,
        amountCents, status: success ? 'success' : 'failed', type: 'renewal',
        failReason: 'Ignored: subscription is pending cancellation',
      });
      return res.status(200).json({ message: 'ok' });
    }

    if (success) {
      if (type === 'initial') {
        await subscriptionService.activateSubscription(sub.id, transactionId, paymentMethod);
      } else {
        await subscriptionService.renewSuccess(sub.id, orderId, transactionId, sub.plan);
      }

      await subscriptionService.logPayment({
        subscriptionId: sub.id, paymobOrderId: orderId, transactionId,
        amountCents, status: 'success', type,
      });

      const updatedSub = await subscriptionService.getSubscriptionById(sub.id);
      const eventName = type === 'renewal' ? 'renewal_success' : 'payment_success';

      await dispatch(eventName, {
        type,
        full_name: `${updatedSub.firstName} ${updatedSub.lastName}`,
        email: updatedSub.email,
        phone: updatedSub.phone,
        plan: updatedSub.plan,
        product_name: updatedSub.product?.name || '',
        product_id: updatedSub.product?.id ? String(updatedSub.product.id) : '',
        payment_status: 'success',
        payment_method: paymentMethod || 'card',
        amount: amountCents / 100,
        currency: updatedSub.currency,
        date_of_creation: updatedSub.createdAt,
        next_renewal: updatedSub.nextRenewalDate,
        transaction_id: String(transactionId),
        subscription_id: updatedSub.id,
        coupon_code: updatedSub.couponCode || null,
        discount_cents: updatedSub.discountCents || 0,
      }, updatedSub.productId);

      log('INFO', 'webhook', `Payment ${type} — SUCCESS #${sub.id} (${paymentMethod})`);
    } else {
      await subscriptionService.logPayment({
        subscriptionId: sub.id, paymobOrderId: orderId, transactionId,
        amountCents, status: 'failed', type, failReason,
      });

      const failedSub = await subscriptionService.getSubscriptionById(sub.id);
      const eventName = type === 'renewal' ? 'renewal_failed' : 'payment_failed';

      await dispatch(eventName, {
        type,
        full_name: `${failedSub.firstName} ${failedSub.lastName}`,
        email: failedSub.email,
        phone: failedSub.phone,
        plan: failedSub.plan,
        product_name: failedSub.product?.name || '',
        product_id: failedSub.product?.id ? String(failedSub.product.id) : '',
        payment_status: 'failed',
        payment_method: paymentMethod || 'card',
        amount: amountCents / 100,
        currency: failedSub.currency || 'EGP',
        fail_reason: failReason || '',
        date_of_creation: failedSub.createdAt,
        next_renewal: failedSub.nextRenewalDate,
        transaction_id: String(transactionId),
        subscription_id: failedSub.id,
      }, failedSub.productId);

      log('WARN', 'webhook', `Payment ${type} — FAILED #${sub.id}`, { failReason });
    }

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
          sub = await prisma.subscription.findFirst({
            where: { email, status: 'active', paymobPlanId: subscription_data.plan_id },
            include: { product: true },
          });
        }
        if (!sub) {
          sub = await subscriptionService.findActiveByEmail(email);
          if (sub) log('WARN', 'sub-webhook', 'Found by email-only fallback', { email, subId: sub.id });
        }
      }

      if (sub) {
        await subscriptionService.updatePaymobSubscription(sub.id, {
          paymobSubscriptionId: subscription_data.id,
          nextRenewalDate: subscription_data.next_billing ? new Date(subscription_data.next_billing) : undefined,
        });
        log('INFO', 'sub-webhook', `Subscription #${sub.id} linked to Paymob sub ${subscription_data.id}`);
      }
    } else if (trigger_type === 'suspended') {
      const sub = await subscriptionService.findByPaymobSubscriptionId(subscription_data.id);
      if (sub) {
        await subscriptionService.markCancelled(sub.id);
        await dispatch('cancelled', {
          type: 'cancelled',
          full_name: `${sub.firstName} ${sub.lastName}`,
          email: sub.email, phone: sub.phone, plan: sub.plan,
          product_name: sub.product?.name || '',
          product_id: sub.product?.id ? String(sub.product.id) : '',
          payment_status: 'cancelled',
          amount: (sub.amountCents || 0) / 100,
          currency: sub.currency || 'EGP',
          date_of_creation: sub.createdAt,
          next_renewal: sub.nextRenewalDate,
          subscription_id: sub.id,
        }, sub.productId);
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

  if (orderId) {
    try {
      const sub = await subscriptionService.findByPaymobOrder(String(orderId));
      if (sub?.product) {
        productSlug = sub.product.slug;
        productName = sub.product.name;

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
