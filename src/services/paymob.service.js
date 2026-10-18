const axios = require('axios');
const config = require('../config');
const { log } = require('../utils/logger');

const BASE_URL = 'https://accept.paymob.com/api';

async function authenticate() {
  try {
    const res = await axios.post(`${BASE_URL}/auth/tokens`, {
      api_key: config.PAYMOB_API_KEY,
    });
    log('INFO', 'paymob', 'Paymob auth successful');
    return res.data.token;
  } catch (err) {
    log('ERROR', 'paymob', 'Paymob auth failed', { error: err.message });
    throw new Error(`Paymob authentication failed: ${err.message}`);
  }
}

async function createIntention({
  amount,
  currency,
  paymentMethods,
  subscriptionPlanId,
  subscriptionStartDate,
  items,
  billingData,
  customer,
  notificationUrl,
  redirectionUrl,
}) {
  try {
    const body = {
      amount,
      currency,
      payment_methods: paymentMethods,
      items: items || [],
      billing_data: billingData,
      customer,
      notification_url: notificationUrl,
      redirection_url: redirectionUrl,
    };

    if (subscriptionPlanId) {
      body.subscription_plan_id = subscriptionPlanId;
      // Without a start date Paymob starts the subscription today and immediately
      // deducts the plan amount via MOTO — on top of this checkout payment (double charge).
      if (subscriptionStartDate) body.subscription_start_date = subscriptionStartDate;
    }

    const res = await axios.post('https://accept.paymob.com/v1/intention/', body, {
      headers: {
        Authorization: `Token ${config.PAYMOB_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const clientSecret = res.data.client_secret;
    // intention_order_id is the numeric Paymob order ID — matches obj.order.id in webhooks
    const intentionOrderId = res.data.intention_order_id;
    log('INFO', 'paymob', 'Paymob intention created', { intentionOrderId });
    return { client_secret: clientSecret, intention_order_id: intentionOrderId };
  } catch (err) {
    const errData = err.response?.data;
    log('ERROR', 'paymob', 'Paymob createIntention failed', { error: err.message, response: errData });
    throw new Error(`Paymob createIntention failed: ${err.message}`);
  }
}

function getUnifiedCheckoutUrl(clientSecret) {
  return `https://accept.paymob.com/unifiedcheckout/?publicKey=${config.PAYMOB_PUBLIC_KEY}&clientSecret=${clientSecret}`;
}

async function suspendSubscription(authToken, subscriptionId) {
  try {
    const res = await axios.post(
      `${BASE_URL}/acceptance/subscriptions/${subscriptionId}/suspend`,
      {},
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    log('INFO', 'paymob', 'Paymob subscription suspended', { subscriptionId });
    return res.data;
  } catch (err) {
    log('ERROR', 'paymob', 'Paymob suspendSubscription failed', { subscriptionId, error: err.message });
    throw new Error(`Paymob suspendSubscription failed: ${err.message}`);
  }
}

async function searchSubscriptionsByPlan(authToken, planId) {
  const results = [];
  let url = `${BASE_URL}/acceptance/subscriptions`;
  let params = { subscription_plan: planId, page_size: 100 };
  try {
    while (url) {
      const res = await axios.get(url, { params, headers: { Authorization: `Bearer ${authToken}` } });
      results.push(...(res.data.results || []));
      url = res.data.next || null;
      params = undefined; // `next` already carries the query string
    }
  } catch (err) {
    log('WARN', 'paymob', 'searchSubscriptionsByPlan failed', { planId, error: err.message });
  }
  return results;
}

/**
 * Suspend the Paymob subscription behind a local subscription.
 * Uses the stored Paymob ID, or finds it by plan + email when the ID was never linked.
 * Returns the Paymob subscription ID that was suspended, or null if none was found.
 */
// Paymob subscriptions for this customer on this plan (newest first)
async function findSubscriptionsForCustomer(authToken, sub) {
  if (!sub.paymobPlanId) return [];
  const email = sub.email.toLowerCase();
  return (await searchSubscriptionsByPlan(authToken, sub.paymobPlanId))
    .filter((s) => (s.client_info?.email || '').toLowerCase() === email)
    .sort((a, b) => b.id - a.id);
}

/**
 * Set the amount Paymob charges on every future renewal of one subscription.
 * Paymob deducts each renewal at the subscription's own amount_cents (editable per
 * subscription, independent of the plan) — this is how coupon discounts reach renewals.
 */
async function updateSubscriptionAmount(authToken, subscriptionId, amountCents) {
  try {
    const res = await axios.put(
      `${BASE_URL}/acceptance/subscriptions/${subscriptionId}`,
      { amount_cents: amountCents },
      { headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' } }
    );
    if (res.data?.amount_cents !== undefined && res.data.amount_cents !== amountCents) {
      throw new Error(`Paymob kept amount ${res.data.amount_cents}`);
    }
    log('INFO', 'paymob', 'Paymob subscription renewal amount set', { subscriptionId, amountCents });
    return res.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log('ERROR', 'paymob', 'Paymob updateSubscriptionAmount failed', { subscriptionId, amountCents, error: detail });
    throw new Error(`Paymob updateSubscriptionAmount failed: ${detail}`);
  }
}

async function resumeSubscription(authToken, subscriptionId) {
  try {
    const res = await axios.post(
      `${BASE_URL}/acceptance/subscriptions/${subscriptionId}/resume`,
      {},
      { headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' } }
    );
    log('INFO', 'paymob', 'Paymob subscription resumed', { subscriptionId });
    return res.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log('ERROR', 'paymob', 'Paymob resumeSubscription failed', { subscriptionId, error: detail });
    throw new Error(`Paymob resumeSubscription failed: ${detail}`);
  }
}

async function getSubscription(authToken, subscriptionId) {
  const res = await axios.get(`${BASE_URL}/acceptance/subscriptions/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return res.data;
}

// IDs of every transaction Paymob made for one subscription (initial + renewals)
async function listSubscriptionTransactionIds(authToken, subscriptionId) {
  const res = await axios.get(`${BASE_URL}/acceptance/subscriptions/${subscriptionId}/transactions`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  const list = res.data?.results || res.data || [];
  return list.map((t) => String(t.id));
}

async function suspendForSubscription(sub) {
  const authToken = await authenticate();
  if (sub.paymobSubscriptionId) {
    await suspendSubscription(authToken, sub.paymobSubscriptionId);
    return sub.paymobSubscriptionId;
  }
  const matches = await findSubscriptionsForCustomer(authToken, sub);
  if (!matches.length) return null;

  for (const m of matches) {
    if (m.state !== 'suspended') await suspendSubscription(authToken, m.id);
  }
  return matches[0].id;
}

async function listSubscriptionPlans() {
  const authToken = await authenticate();
  const res = await axios.get(`${BASE_URL}/acceptance/subscription-plans`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return res.data.results || res.data || [];
}

async function createSubscriptionPlan(authToken, { name, frequency, amountCents, integrationId, webhookUrl }) {
  try {
    const res = await axios.post(
      `${BASE_URL}/acceptance/subscription-plans`,
      {
        frequency,
        name,
        amount_cents: amountCents,
        integration: integrationId,
        use_transaction_amount: false,
        is_active: true,
        webhook_url: webhookUrl,
        plan_type: 'rent',
      },
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    log('INFO', 'paymob', 'Paymob subscription plan created', { planId: res.data.id, name });
    return res.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log('ERROR', 'paymob', 'Paymob createSubscriptionPlan failed', { name, error: detail });
    throw new Error(`Paymob rejected the plan: ${detail}`);
  }
}

module.exports = {
  authenticate,
  createIntention,
  getUnifiedCheckoutUrl,
  suspendSubscription,
  searchSubscriptionsByPlan,
  suspendForSubscription,
  resumeSubscription,
  getSubscription,
  listSubscriptionTransactionIds,
  findSubscriptionsForCustomer,
  updateSubscriptionAmount,
  listSubscriptionPlans,
  createSubscriptionPlan,
};
