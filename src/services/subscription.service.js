const prisma = require('../db');

// ── Helpers ──────────────────────────────────────────────────────────────────

function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ') || 'NA';
  return { firstName, lastName };
}

function nextMidnightUTC(daysFromNow) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  d.setUTCHours(0, 0, 0, 0);
  return d;
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

async function findPendingByEmail(email, productId) {
  const where = { email, status: 'pending' };
  if (productId !== undefined) where.productId = productId;
  return prisma.subscription.findFirst({ where });
}

async function createPending({ name, email, phone, plan, amountCents, currency, lastPaymobOrder, paymobPlanId, productId, paymentMethod, couponCode, discountCents, isOneTime }) {
  const { firstName, lastName } = splitName(name);
  const planDays = { weekly: 7, monthly: 30, '3-months': 90, '6-months': 180, yearly: 365 };
  // One-time payments use a short window (1 day) just for record keeping
  const nextRenewalDate = isOneTime ? nextMidnightUTC(1) : nextMidnightUTC(planDays[plan] ?? 30);
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

async function findPaymentByTransactionId(transactionId) {
  return prisma.payment.findUnique({ where: { transactionId: String(transactionId) } });
}

async function updatePaymentStatus(transactionId, status, failReason) {
  return prisma.payment.update({
    where: { transactionId: String(transactionId) },
    data: { status, ...(failReason ? { failReason } : {}) },
  });
}

async function updateLastTransaction(subscriptionId, orderId, transactionId) {
  return prisma.subscription.update({
    where: { id: subscriptionId },
    data: { lastPaymobOrder: String(orderId), lastTransactionId: String(transactionId) },
  });
}

async function renewSuccess(subscriptionId, orderId, transactionId, plan) {
  const planDays = { weekly: 7, monthly: 30, '3-months': 90, '6-months': 180, yearly: 365 };
  const days = planDays[plan] ?? 30;

  // Advance from the current nextRenewalDate, not from today, to prevent drift.
  // If the current renewal date is in the past (late charge), still advance from it.
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  const baseDate = sub.nextRenewalDate && sub.nextRenewalDate <= new Date()
    ? new Date(sub.nextRenewalDate)
    : new Date();
  baseDate.setUTCDate(baseDate.getUTCDate() + days);
  baseDate.setUTCHours(0, 0, 0, 0);

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

async function listSubscriptions({ status, page = 1, limit = 20, productId }) {
  const where = {};
  if (status) where.status = status;
  if (productId) where.productId = productId;
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
  findActiveByEmail,
  findActiveByEmailAndAmount,
  findPendingByEmail,
  createPending,
  activateSubscription,
  findByPaymobOrder,
  getSubscriptionById,
  logPayment,
  findPaymentByTransactionId,
  updatePaymentStatus,
  updateLastTransaction,
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
