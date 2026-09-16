const express = require('express');
const rateLimit = require('express-rate-limit');
const { validatePaymentInput } = require('../middleware/validate.middleware');
const paymobService = require('../services/paymob.service');
const subscriptionService = require('../services/subscription.service');
const productService = require('../services/product.service');
const couponService = require('../services/coupon.service');
const { planDays, midnightUTCAfter, toPaymobDate, ONE_TIME_PLAN } = require('../utils/plans');
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

      // Recurring card payment → Paymob subscription plan for auto-renewal.
      // one_time product, One-Time plan or wallet → a single standard payment.
      const recurring = productType === 'subscription' && plan !== ONE_TIME_PLAN && !useWallet;
      if (recurring) {
        if (!productPlan.paymobSubscriptionPlanId) {
          // Never sell a "subscription" that Paymob cannot renew
          log('ERROR', 'payment', 'Plan has no Paymob subscription plan — checkout blocked', {
            productSlug, plan, productPlanId: productPlan.id,
          });
          return res.status(503).json({ error: 'This plan is not available right now. Please contact support.' });
        }
        subscriptionPlanId = productPlan.paymobSubscriptionPlanId;
      }
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

    const isOneTime = productType === 'one_time' || plan === ONE_TIME_PLAN || useWallet;

    // ── Coupon application ───────────────────────────────────────────────────
    let discountCents = 0;
    let appliedCoupon = null;

    // Only apply coupon if product has coupons enabled OR it's a one-time payment
    const settingsEnabled = productObj?.settings?.couponsEnabled ?? false;
    if (couponCode && (settingsEnabled || isOneTime)) {
      const result = await couponService.evaluateCoupon(couponCode, productId, amountCents);
      if (result.ok) {
        discountCents = result.discountCents;
        appliedCoupon = result.coupon;
      }
    }

    const finalAmount = couponService.finalAmountAfterDiscount(amountCents, discountCents);

    // ── Duplicate checks (only for recurring subscriptions) ──────────────────
    if (!isOneTime) {
      const existing = await subscriptionService.findActiveByEmail(email, productId);
      if (existing) {
        return res.status(409).json({
          error: 'An active subscription already exists for this email.',
          plan: existing.plan,
          nextRenewalDate: existing.nextRenewalDate,
        });
      }

      // A customer who left the Paymob page and came back must be able to retry.
      // The old unpaid attempt is retired; if it still gets paid, the webhook activates it by order ID.
      const superseded = await subscriptionService.abandonPendingByEmail(email, productId);
      if (superseded.count) {
        log('INFO', 'payment', 'Superseded unpaid checkout attempt(s)', { email, productId, count: superseded.count });
      }
    }

    // ── Build intention ──────────────────────────────────────────────────────
    const paymentMethods = useWallet
      ? [parseInt(config.PAYMOB_WALLET_INTEGRATION_ID)]
      : [parseInt(config.PAYMOB_INTEGRATION_ID)];

    const [firstName, ...lastParts] = name.trim().split(/\s+/);
    const lastName = lastParts.join(' ') || 'NA';

    const itemName = productName
      ? `${productName} — ${plan === ONE_TIME_PLAN ? 'One-time' : plan}${isOneTime && plan !== ONE_TIME_PLAN ? ' (One-time)' : isOneTime ? '' : ' Subscription'}`
      : `${plan.charAt(0).toUpperCase() + plan.slice(1)} ${isOneTime ? 'Payment' : 'Subscription'}`;

    const intentionResult = await paymobService.createIntention({
      amount: finalAmount,
      currency: config.CURRENCY,
      paymentMethods,
      subscriptionPlanId: isOneTime ? null : subscriptionPlanId,
      // First automatic deduction one full period from now — today's charge is this checkout.
      subscriptionStartDate: isOneTime ? null : toPaymobDate(midnightUTCAfter(planDays(plan))),
      items: [{
        name: itemName,
        amount: finalAmount,
        description: isOneTime ? 'One-time payment' : `${plan} auto-renewal subscription`,
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
        plan,
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
