const prisma = require('../db');
const { planDays, midnightUTCAfter } = require('../utils/plans');

// ── Helpers ──────────────────────────────────────────────────────────────────

function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ') || 'NA';
  return { firstName, lastName };
}

// ── Core functions ───────────────────────────────────────────────────────────

async function findActiveByEmail(email, productId) {
  const where = { email, status: 'active' };
  if (productId !== undefined) where.productId = productId;
  return prisma.subscription.findFirst({ where, include: { product: true } });
}

async function findActiveByEmailAndAmount(email, amountCents) {
  return prisma.subscription.findFirst({
    where: { email, status: 'active', amountCents },
    include: { product: true },
  });
}

// All active subscriptions for an email (used to avoid guessing when several exist).
async function findAllActiveByEmail(email) {
  return prisma.subscription.findMany({ where: { email, status: 'active' }, include: { product: true } });
}

async function abandonPendingByEmail(email, productId) {
  return prisma.subscription.updateMany({
    where: { email, status: 'pending', productId: productId ?? null },
    data: { status: 'abandoned' },
  });
}

async function createPending({ name, email, phone, plan, amountCents, currency, lastPaymobOrder, paymobPlanId, productId, paymentMethod, couponCode, discountCents, isOneTime }) {
  const { firstName, lastName } = splitName(name);
  // One-time payments use a short window (1 day) just for record keeping
  const nextRenewalDate = midnightUTCAfter(isOneTime ? 1 : planDays(plan));
  return prisma.subscription.create({
    data: {
      email, firstName, lastName, phone, plan,
      status: 'pending', amountCents, currency,
      nextRenewalDate, lastPaymobOrder,
      paymobPlanId: paymobPlanId || null,
      productId: productId || null,
      paymentMethod: paymentMethod || null,
      couponCode: couponCode || null,
      discountCents: discountCents || null,
    },
  });
}

async function activateSubscription(subscriptionId, transactionId, paymentMethod) {
  const data = { status: 'active', lastTransactionId: String(transactionId) };
  if (paymentMethod) data.paymentMethod = paymentMethod;
  return prisma.subscription.update({ where: { id: subscriptionId }, data });
}

async function findByPaymobOrder(orderId) {
  return prisma.subscription.findFirst({ where: { lastPaymobOrder: String(orderId) }, include: { product: true } });
}

async function getSubscriptionById(id) {
  return prisma.subscription.findUnique({ where: { id: parseInt(id) }, include: { product: true } });
}

async function logPayment({ subscriptionId, paymobOrderId, transactionId, amountCents, status, type, failReason }) {
  return prisma.payment.upsert({
    where: { transactionId: String(transactionId) },
    update: {},
    create: { subscriptionId, paymobOrderId, transactionId: String(transactionId), amountCents, status, type, failReason },
  });
}

/**
 * Record a transaction exactly once. Returns false if another request already recorded it
 * (Paymob retries webhooks, sometimes concurrently) — the caller must then stop.
 */
async function claimPayment({ subscriptionId, paymobOrderId, transactionId, amountCents, status, type, failReason }) {
  try {
    await prisma.payment.create({
      data: { subscriptionId, paymobOrderId, transactionId: String(transactionId), amountCents, status, type, failReason },
    });
    return true;
  } catch (err) {
    if (err.code === 'P2002') return false;
    throw err;
  }
}

async function findPaymentByTransactionId(transactionId) {
  return prisma.payment.findUnique({ where: { transactionId: String(transactionId) } });
}

async function renewSuccess(subscriptionId, orderId, transactionId, plan) {
  const days = planDays(plan);

  // Advance from the current nextRenewalDate, not from today, to prevent drift.
  // If the current renewal date is in the past (late charge), still advance from it.
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  const baseDate = sub.nextRenewalDate && sub.nextRenewalDate <= new Date()
    ? midnightUTCAfter(days, sub.nextRenewalDate)
    : midnightUTCAfter(days);

  return prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      lastPaymobOrder: String(orderId),
      lastTransactionId: String(transactionId),
      nextRenewalDate: baseDate,
    },
  });
}

// ── Paymob Subscription Module helpers ───────────────────────────────────────

async function updatePaymobSubscription(localId, { paymobSubscriptionId, nextRenewalDate }) {
  const data = {};
  if (paymobSubscriptionId !== undefined) data.paymobSubscriptionId = paymobSubscriptionId;
  if (nextRenewalDate !== undefined) data.nextRenewalDate = nextRenewalDate;
  return prisma.subscription.update({ where: { id: localId }, data });
}

async function findByPaymobSubscriptionId(paymobSubId) {
  return prisma.subscription.findFirst({ where: { paymobSubscriptionId: paymobSubId }, include: { product: true } });
}

// ── Admin / List functions ───────────────────────────────────────────────────

async function listSubscriptions({ status, page = 1, limit = 20, productId, search }) {
  const where = {};
  if (status) where.status = status;
  if (productId) where.productId = productId;
  if (search) {
    const s = search.trim();
    where.OR = [
      { email: { contains: s, mode: 'insensitive' } },
      { firstName: { contains: s, mode: 'insensitive' } },
      { lastName: { contains: s, mode: 'insensitive' } },
      { phone: { contains: s } },
    ];
  }
  const [subscriptions, total] = await prisma.$transaction([
    prisma.subscription.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, firstName: true, lastName: true, phone: true,
        plan: true, status: true, amountCents: true, currency: true,
        nextRenewalDate: true, paymobSubscriptionId: true, paymobPlanId: true,
        cancelledAt: true, createdAt: true, updatedAt: true,
        product: { select: { id: true, name: true, slug: true } },
      },
    }),
    prisma.subscription.count({ where }),
  ]);
  return { subscriptions, total, page, limit };
}

async function getSubscriptionWithPayments(id) {
  return prisma.subscription.findUnique({
    where: { id: parseInt(id) },
    include: { payments: { orderBy: { createdAt: 'desc' } }, product: true },
  });
}

// ── Cancellation functions ───────────────────────────────────────────────────

async function cancelSubscription(subscriptionId) {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { product: true } });
  if (!sub) throw new Error('Subscription not found');
  if (sub.status !== 'active' || sub.cancelledAt) {
    throw new Error(`Cannot cancel subscription with status '${sub.status}'`);
  }
  const updated = await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { cancelledAt: new Date() },
    include: { product: true },
  });
  return { subscription: updated, activeUntil: sub.nextRenewalDate };
}

async function findCancelledDue() {
  return prisma.subscription.findMany({
    where: { status: 'active', cancelledAt: { not: null }, nextRenewalDate: { lte: new Date() } },
    include: { product: true },
  });
}

async function markCancelled(subscriptionId) {
  return prisma.subscription.update({ where: { id: subscriptionId }, data: { status: 'cancelled' } });
}

async function reactivateSubscription(subscriptionId) {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { product: true } });
  if (!sub) throw new Error('Subscription not found');
  // Allow reactivation for: cancelled subs, or active subs with pending cancellation
  if (sub.status === 'active' && sub.cancelledAt) {
    // Undo cancel — just clear cancelledAt, keep existing nextRenewalDate
    return prisma.subscription.update({
      where: { id: subscriptionId },
      data: { cancelledAt: null },
      include: { product: true },
    });
  }
  // Fully cancelled subscriptions cannot be reactivated for free.
  // The customer must subscribe again (which creates a new payment).
  throw new Error(`Cannot reactivate subscription with status '${sub.status}'. The customer must subscribe again.`);
}

async function markAbandonedPending() {
  return prisma.subscription.updateMany({
    where: { status: 'pending', createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    data: { status: 'abandoned' },
  });
}

async function getDashboardStats() {
  const [totalActive, totalCancelled, totalExpired, totalPending, totalRevenue, recentPayments] = await prisma.$transaction([
    prisma.subscription.count({ where: { status: 'active' } }),
    prisma.subscription.count({ where: { status: 'cancelled' } }),
    prisma.subscription.count({ where: { status: 'expired' } }),
    prisma.subscription.count({ where: { status: 'pending' } }),
    prisma.payment.aggregate({ where: { status: 'success' }, _sum: { amountCents: true } }),
    prisma.payment.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: { subscription: { select: { email: true, firstName: true, lastName: true, plan: true } } },
    }),
  ]);
  return {
    totalActive,
    totalCancelled,
    totalExpired,
    totalPending,
    totalRevenue: totalRevenue._sum.amountCents || 0,
    recentPayments,
  };
}

module.exports = {
  splitName,
  findActiveByEmail,
  findActiveByEmailAndAmount,
  findAllActiveByEmail,
  abandonPendingByEmail,
  createPending,
  activateSubscription,
  findByPaymobOrder,
  getSubscriptionById,
  logPayment,
  claimPayment,
  findPaymentByTransactionId,
  renewSuccess,
  updatePaymobSubscription,
  findByPaymobSubscriptionId,
  listSubscriptions,
  getSubscriptionWithPayments,
  cancelSubscription,
  reactivateSubscription,
  findCancelledDue,
  markCancelled,
  markAbandonedPending,
  getDashboardStats,
};
