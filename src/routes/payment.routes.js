const express = require('express');
const rateLimit = require('express-rate-limit');
const { validatePaymentInput } = require('../middleware/validate.middleware');
const paymobService = require('../services/paymob.service');
const subscriptionService = require('../services/subscription.service');
const productService = require('../services/product.service');
const prisma = require('../db');
const config = require('../config');
const { log } = require('../utils/logger');

const router = express.Router();

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

// ── Coupon helper ─────────────────────────────────────────────────────────────
async function applyCoupon(code, productId, amountCents) {
  if (!code) return { discountCents: 0, coupon: null };

  const coupon = await prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
  if (!coupon || !coupon.isActive) return { discountCents: 0, coupon: null };

  // Product restriction
  if (coupon.productId && productId && coupon.productId !== productId) return { discountCents: 0, coupon: null };

  // Expiry
  if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) return { discountCents: 0, coupon: null };

  // Usage limit
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) return { discountCents: 0, coupon: null };

  const discountCents = coupon.discountType === 'percentage'
    ? Math.round((amountCents * coupon.discountValue) / 100)
    : Math.round(coupon.discountValue);

  return { discountCents, coupon };
}

// ── POST /api/payment/create ──────────────────────────────────────────────────
router.post('/create', paymentLimiter, validatePaymentInput, async (req, res) => {
  try {
    const { name, email, phone, plan, productSlug, paymentMethod, couponCode } = req.body;
    const useWallet = paymentMethod === 'wallet';

    let amountCents;
    let subscriptionPlanId = null;
    let productId = null;
    let productName = '';
    let productType = 'subscription';
    let productObj = null;

    if (productSlug) {
      // ── Product-based flow ──────────────────────────────────────────────────
      productObj = await productService.getProductBySlug(productSlug);
      if (!productObj || !productObj.isActive) {
        return res.status(404).json({ error: 'Product not found.' });
      }

      productType = productObj.productType || 'subscription';

      const productPlan = productObj.plans.find((p) => p.planType === plan && p.isActive);
      if (!productPlan) {
        return res.status(400).json({ error: `Plan "${plan}" is not available for this product.` });
      }

      amountCents = productPlan.amountCents;
      productId = productObj.id;
      productName = productObj.name;

      // Reject wallet if not enabled
      if (useWallet && (!productObj.walletEnabled || !config.PAYMOB_WALLET_INTEGRATION_ID)) {
        return res.status(400).json({ error: 'Wallet payment is not available for this product.' });
      }

      // For subscription type: use Paymob subscription plan for auto-renewal
      if (productType === 'subscription' && !useWallet && productPlan.paymobSubscriptionPlanId) {
        subscriptionPlanId = productPlan.paymobSubscriptionPlanId;
      }
      // one_time: no subscription plan — standard payment
    } else {
      // ── Legacy flow (env var amounts) ───────────────────────────────────────
      const amounts = { monthly: config.MONTHLY_AMOUNT_CENTS, yearly: config.YEARLY_AMOUNT_CENTS, weekly: config.WEEKLY_AMOUNT_CENTS };
      amountCents = amounts[plan];
      if (!amountCents) {
        return res.status(400).json({ error: `Plan "${plan}" is not available. Please use a product link.` });
      }
      if (!useWallet) {
        const planIds = { monthly: config.PAYMOB_MONTHLY_PLAN_ID, yearly: config.PAYMOB_YEARLY_PLAN_ID, weekly: config.PAYMOB_WEEKLY_PLAN_ID };
        subscriptionPlanId = planIds[plan];
        if (!subscriptionPlanId) {
          return res.status(400).json({ error: 'Subscription plan not configured.' });
        }
      }
    }

    // ── Coupon application ───────────────────────────────────────────────────
    let discountCents = 0;
    let appliedCoupon = null;

    // Only apply coupon if product has coupons enabled OR it's a one-time payment
    const settingsEnabled = productObj?.settings?.couponsEnabled ?? false;
    if (couponCode && (settingsEnabled || productType === 'one_time')) {
      const result = await applyCoupon(couponCode, productId, amountCents);
      discountCents = result.discountCents;
      appliedCoupon = result.coupon;
    }

    const finalAmount = Math.max(100, amountCents - discountCents); // minimum 1 EGP

    // ── Duplicate checks (only for subscriptions) ────────────────────────────
    if (productType === 'subscription') {
      const existing = await subscriptionService.findActiveByEmail(email, productId);
      if (existing) {
        return res.status(409).json({
          error: 'An active subscription already exists for this email.',
          plan: existing.plan,
          nextRenewalDate: existing.nextRenewalDate,
        });
      }

      const pendingSub = await subscriptionService.findPendingByEmail(email, productId);
      if (pendingSub) {
        return res.status(409).json({ error: 'A payment is already in progress for this email.' });
      }
    }

    // ── Build intention ──────────────────────────────────────────────────────
    const paymentMethods = useWallet
      ? [parseInt(config.PAYMOB_WALLET_INTEGRATION_ID)]
      : [parseInt(config.PAYMOB_INTEGRATION_ID)];

    const [firstName, ...lastParts] = name.trim().split(/\s+/);
    const lastName = lastParts.join(' ') || 'NA';

    const isOneTime = productType === 'one_time' || useWallet;
    const itemName = productName
      ? `${productName} — ${plan}${isOneTime ? ' (One-time)' : ' Subscription'}`
      : `${plan.charAt(0).toUpperCase() + plan.slice(1)} ${isOneTime ? 'Payment' : 'Subscription'}`;

    const intentionResult = await paymobService.createIntention({
      amount: finalAmount,
      currency: config.CURRENCY,
      paymentMethods,
      subscriptionPlanId: isOneTime ? null : subscriptionPlanId,
      items: [{
        name: itemName,
        amount: finalAmount,
        description: isOneTime ? `${plan} one-time payment` : `${plan} auto-renewal subscription`,
        quantity: 1,
      }],
      billingData: {
        first_name: firstName,
        last_name: lastName,
        email,
        phone_number: phone,
        country: 'EG',
        apartment: 'NA',
        street: 'NA',
        building: 'NA',
        floor: 'NA',
        state: 'Cairo',
      },
      customer: { first_name: firstName, last_name: lastName, email },
      notificationUrl: config.APP_URL ? `${config.APP_URL}/api/webhook/paymob` : undefined,
      redirectionUrl: config.APP_URL ? `${config.APP_URL}/api/webhook/paymob-redirect` : undefined,
    });

    // ── Create pending subscription record ───────────────────────────────────
    let subscription;
    try {
      subscription = await subscriptionService.createPending({
        name, email, phone,
        plan: isOneTime ? plan : plan,
        amountCents: finalAmount,
        currency: config.CURRENCY,
        lastPaymobOrder: String(intentionResult.intention_order_id),
        paymobPlanId: isOneTime ? null : subscriptionPlanId,
        productId,
        paymentMethod: useWallet ? 'wallet' : 'card',
        couponCode: appliedCoupon?.code || null,
        discountCents: discountCents || null,
        isOneTime,
      });
    } catch (dbErr) {
      log('ERROR', 'payment', 'DB write failed after Paymob intention — RECONCILE MANUALLY', {
        orderId: intentionResult.intention_order_id, email, plan, amountCents, error: dbErr.message,
      });
      return res.status(500).json({ error: 'Unable to create payment. Please try again.' });
    }

    // Increment coupon usage if applied
    if (appliedCoupon) {
      await prisma.coupon.update({
        where: { id: appliedCoupon.id },
        data: { usedCount: { increment: 1 } },
      }).catch(() => {}); // non-blocking
    }

    const checkoutUrl = paymobService.getUnifiedCheckoutUrl(intentionResult.client_secret);

    log('INFO', 'payment', 'Payment intention created', {
      subscriptionId: subscription.id, plan, productSlug,
      paymentMethod: useWallet ? 'wallet' : 'card',
      coupon: appliedCoupon?.code || null, discountCents,
    });

    return res.status(200).json({ success: true, checkoutUrl });
  } catch (err) {
    log('ERROR', 'payment', 'Failed to create payment', { error: err.message });
    return res.status(500).json({ error: 'Unable to create payment. Please try again.' });
  }
});

module.exports = router;
