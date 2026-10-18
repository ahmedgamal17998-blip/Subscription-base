/**
 * Coupon discounts on renewals.
 *
 * Paymob charges each renewal at the Paymob subscription's own amount_cents, which can be
 * changed per subscription. So:
 *   - when the subscription is linked, set that amount to the discounted price
 *   - after each discounted renewal, count down; when none are left, set it back to full price
 * Every step is idempotent (we remember the amount we last set), and the daily job re-syncs
 * anything a failed call or a lost webhook left behind.
 */
const prisma = require('../db');
const paymobService = require('./paymob.service');
const { log } = require('../utils/logger');

/** Amount the next renewal should cost, or null if we never touch this subscription. */
function desiredRenewalAmount(sub) {
  if (!sub.renewalDiscountCents || !sub.fullPriceCents) return null;
  const stillDiscounted = sub.discountedRenewalsLeft === null || sub.discountedRenewalsLeft > 0;
  return stillDiscounted ? Math.max(100, sub.fullPriceCents - sub.renewalDiscountCents) : sub.fullPriceCents;
}

/**
 * Make the Paymob subscription charge desiredRenewalAmount. Returns true when in sync.
 * verify: read the amount from Paymob instead of trusting the one we last set.
 */
async function syncRenewalAmount(sub, { verify = false } = {}) {
  const target = desiredRenewalAmount(sub);
  // Nothing to renew: cancelled, or cancel requested (suspended on Paymob)
  if (target === null || sub.cancelledAt || (sub.status !== 'active' && sub.status !== 'pending')) return true;
  if (!sub.paymobSubscriptionId) return false;

  const authToken = await paymobService.authenticate();
  if (verify) {
    const live = await paymobService.getSubscription(authToken, sub.paymobSubscriptionId);
    if (live.amount_cents === target) {
      if (sub.paymobAmountCents !== target) {
        await prisma.subscription.update({ where: { id: sub.id }, data: { paymobAmountCents: target } });
      }
      return true;
    }
  } else if (sub.paymobAmountCents === target) {
    return true;
  }

  await paymobService.updateSubscriptionAmount(authToken, sub.paymobSubscriptionId, target);
  await prisma.subscription.update({ where: { id: sub.id }, data: { paymobAmountCents: target } });
  log('INFO', 'renewal-discount', `Sub #${sub.id}: renewals now ${target / 100}`, {
    paymobSubscriptionId: sub.paymobSubscriptionId, discountedRenewalsLeft: sub.discountedRenewalsLeft,
  });
  return true;
}

/** Same as syncRenewalAmount, but never throws — failures are retried by the daily job. */
async function trySync(sub, context, options) {
  try {
    return await syncRenewalAmount(sub, options);
  } catch (err) {
    log('ERROR', 'renewal-discount', `Sub #${sub.id}: renewal amount not synced (${context}) — will retry daily`, {
      error: err.message,
    });
    return false;
  }
}

/**
 * The Paymob "created" webhook normally links the subscription. If it was lost, find the
 * Paymob subscription ourselves so the renewal discount is applied before the first renewal.
 */
async function linkIfMissing(sub) {
  if (sub.paymobSubscriptionId || desiredRenewalAmount(sub) === null) return sub;
  try {
    // Match on the exact first-payment transaction, never just "latest for this email":
    // an older subscription of the same customer on the same plan must not be picked.
    const initial = await prisma.payment.findFirst({
      where: { subscriptionId: sub.id, type: 'initial', status: 'success' },
    });
    if (!initial) return sub;
    const authToken = await paymobService.authenticate();
    const match = (await paymobService.findSubscriptionsForCustomer(authToken, sub))
      .find((s) => String(s.initial_transaction) === String(initial.transactionId));
    if (!match) return sub; // Paymob may not have created it yet — the webhook or daily job will link it
    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: { paymobSubscriptionId: match.id },
    });
    log('INFO', 'renewal-discount', `Sub #${sub.id} linked to Paymob sub ${match.id} by search`);
    return updated;
  } catch (err) {
    log('WARN', 'renewal-discount', `Sub #${sub.id}: could not find its Paymob subscription`, { error: err.message });
    return sub;
  }
}

/** Daily safety net: re-sync every subscription that has a renewal discount. */
async function syncAll() {
  const subs = await prisma.subscription.findMany({
    where: { status: 'active', renewalDiscountCents: { not: null } },
  });
  let synced = 0;
  for (const sub of subs) {
    const linked = await linkIfMissing(sub);
    if (await trySync(linked, 'daily', { verify: true })) synced++;
  }
  return { checked: subs.length, synced };
}

module.exports = { desiredRenewalAmount, syncRenewalAmount, trySync, linkIfMissing, syncAll };
