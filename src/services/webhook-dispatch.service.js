/**
 * Dynamic webhook dispatcher.
 * Fires all matching active OutboundWebhooks for a given event + productId.
 */
const axios = require('axios');
const crypto = require('crypto');
const prisma = require('../db');
const { log } = require('../utils/logger');

async function dispatch(eventName, payload, productId) {
  let webhooks;
  try {
    webhooks = await prisma.outboundWebhook.findMany({
      where: {
        isActive: true,
        OR: [
          { productId: null },
          ...(productId ? [{ productId }] : []),
        ],
      },
    });
  } catch (err) {
    log('ERROR', 'webhook-dispatch', 'Failed to fetch webhooks from DB', { error: err.message });
    return;
  }

  const matching = webhooks.filter((wh) => {
    const events = wh.events.split(',').map((e) => e.trim());
    return events.includes(eventName);
  });

  if (matching.length === 0) return;

  const enriched = { event: eventName, ...payload };

  await Promise.allSettled(
    matching.map(async (wh) => {
      try {
        const bodyString = JSON.stringify(enriched);
        const headers = { 'Content-Type': 'application/json' };

        // Sign with per-webhook HMAC-SHA256 secret if available
        if (wh.secret) {
          const sig = crypto.createHmac('sha256', wh.secret).update(bodyString).digest('hex');
          headers['X-Webhook-Signature'] = `sha256=${sig}`;
        }

        await axios.post(wh.url, bodyString, { timeout: 10000, headers });
        log('INFO', 'webhook-dispatch', `Event "${eventName}" dispatched`, { webhookId: wh.id, url: wh.url });
      } catch (err) {
        log('WARN', 'webhook-dispatch', `Event "${eventName}" failed`, {
          webhookId: wh.id, url: wh.url, error: err.message,
        });
      }
    })
  );
}

// Common payload fields for any subscription event; `extra` overrides/extends them.
function subscriptionPayload(sub, extra = {}) {
  return {
    full_name: `${sub.firstName} ${sub.lastName}`,
    email: sub.email,
    phone: sub.phone,
    plan: sub.plan,
    product_name: sub.product?.name || '',
    product_id: sub.product?.id ? String(sub.product.id) : '',
    amount: (sub.amountCents || 0) / 100,
    currency: sub.currency || 'EGP',
    date_of_creation: sub.createdAt,
    next_renewal: sub.nextRenewalDate,
    subscription_id: sub.id,
    ...extra,
  };
}

// Fire an event for a subscription (sub must include `product`).
function dispatchForSubscription(eventName, sub, extra) {
  return dispatch(eventName, subscriptionPayload(sub, extra), sub.productId);
}

module.exports = { dispatch, subscriptionPayload, dispatchForSubscription };
