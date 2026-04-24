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

async function getSubscription(authToken, subscriptionId) {
  try {
    const res = await axios.get(`${BASE_URL}/acceptance/subscriptions/${subscriptionId}`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });
    log('INFO', 'paymob', 'Paymob subscription fetched', { subscriptionId });
    return res.data;
  } catch (err) {
    log('ERROR', 'paymob', 'Paymob getSubscription failed', { subscriptionId, error: err.message });
    throw new Error(`Paymob getSubscription failed: ${err.message}`);
  }
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
    log('ERROR', 'paymob', 'Paymob createSubscriptionPlan failed', { name, error: err.message });
    throw new Error(`Paymob createSubscriptionPlan failed: ${err.message}`);
  }
}

module.exports = {
  authenticate,
  createIntention,
  getUnifiedCheckoutUrl,
  suspendSubscription,
  getSubscription,
  createSubscriptionPlan,
};
