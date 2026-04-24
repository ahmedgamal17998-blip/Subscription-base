const axios = require('axios');
const config = require('../config');
const { log } = require('../utils/logger');

async function sendEvent(eventData) {
  try {
    await axios.post(config.GHL_WEBHOOK_URL, eventData, { timeout: 10000 });
    log('INFO', 'ghl', 'GHL event sent', { event: eventData.event });
  } catch (err) {
    log('WARN', 'ghl', 'GHL event failed', { event: eventData.event, error: err.message });
  }
}

async function notifyPaymentSuccess({
  subscriptionId, transactionId, email, firstName, lastName,
  phone, plan, amountCents, currency, type, nextRenewalDate,
  createdAt, paymentMethod, productName, productId,
}) {
  await sendEvent({
    event: 'payment_success',
    type,
    full_name: `${firstName} ${lastName}`,
    email,
    phone,
    plan,
    product_name: productName || '',
    product_id: productId ? String(productId) : '',
    payment_status: 'success',
    payment_method: paymentMethod || 'card',
    amount: amountCents / 100,
    currency,
    date_of_creation: createdAt,
    next_renewal: nextRenewalDate,
    transaction_id: String(transactionId),
    subscription_id: subscriptionId,
  });
}

async function notifyPaymentFailed({
  subscriptionId, email, firstName, lastName,
  phone, plan, failReason, createdAt, productName, productId,
}) {
  await sendEvent({
    event: 'payment_failed',
    full_name: `${firstName} ${lastName}`,
    email,
    phone,
    plan,
    product_name: productName || '',
    product_id: productId ? String(productId) : '',
    payment_status: 'failed',
    fail_reason: failReason || '',
    date_of_creation: createdAt,
    subscription_id: subscriptionId,
  });
}

async function notifyExpired({ subscriptionId, email, firstName, lastName, phone, plan, createdAt, productName, productId }) {
  await sendEvent({
    event: 'subscription_expired',
    full_name: `${firstName} ${lastName}`,
    email,
    phone,
    plan,
    product_name: productName || '',
    product_id: productId ? String(productId) : '',
    payment_status: 'expired',
    date_of_creation: createdAt,
    subscription_id: subscriptionId,
  });
}

async function notifyCancelRequested({
  subscriptionId, email, firstName, lastName, phone, plan, activeUntil, createdAt, productName, productId,
}) {
  await sendEvent({
    event: 'subscription_cancel_requested',
    full_name: `${firstName} ${lastName}`,
    email,
    phone,
    plan,
    product_name: productName || '',
    product_id: productId ? String(productId) : '',
    payment_status: 'cancel_requested',
    active_until: activeUntil,
    date_of_creation: createdAt,
    subscription_id: subscriptionId,
  });
}

async function notifyCancelled({ subscriptionId, email, firstName, lastName, phone, plan, createdAt, productName, productId }) {
  await sendEvent({
    event: 'subscription_cancelled',
    full_name: `${firstName} ${lastName}`,
    email,
    phone,
    plan,
    product_name: productName || '',
    product_id: productId ? String(productId) : '',
    payment_status: 'cancelled',
    date_of_creation: createdAt,
    subscription_id: subscriptionId,
  });
}

module.exports = { notifyPaymentSuccess, notifyPaymentFailed, notifyExpired, notifyCancelRequested, notifyCancelled };
