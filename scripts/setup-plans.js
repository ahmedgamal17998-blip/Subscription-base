#!/usr/bin/env node

/**
 * One-time setup script: Creates Paymob subscription plans.
 * Run: node scripts/setup-plans.js
 * Then add the printed plan IDs to your .env file.
 */

require('dotenv').config();
const axios = require('axios');

const BASE_URL = 'https://accept.paymob.com/api';

const PAYMOB_API_KEY = process.env.PAYMOB_API_KEY;
const MOTO_INTEGRATION_ID = process.env.PAYMOB_MOTO_INTEGRATION_ID || process.env.PAYMOB_INTEGRATION_ID;
const MONTHLY_AMOUNT = parseInt(process.env.MONTHLY_AMOUNT_CENTS) || 10000;
const YEARLY_AMOUNT = parseInt(process.env.YEARLY_AMOUNT_CENTS) || 100000;
const WEBHOOK_URL = process.env.PAYMOB_SUBSCRIPTION_WEBHOOK_URL || '';

async function main() {
  if (!PAYMOB_API_KEY) {
    console.error('ERROR: PAYMOB_API_KEY is required in .env');
    process.exit(1);
  }
  if (!MOTO_INTEGRATION_ID) {
    console.error('ERROR: PAYMOB_MOTO_INTEGRATION_ID or PAYMOB_INTEGRATION_ID is required in .env');
    process.exit(1);
  }

  console.log('Authenticating with Paymob...');
  const authRes = await axios.post(`${BASE_URL}/auth/tokens`, { api_key: PAYMOB_API_KEY });
  const authToken = authRes.data.token;
  console.log('Authenticated successfully.\n');

  const headers = { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' };

  // Create Monthly Plan
  console.log('Creating Monthly Plan (frequency: 30 days)...');
  const monthlyRes = await axios.post(`${BASE_URL}/acceptance/subscription-plans`, {
    frequency: 30,
    name: 'Monthly Plan',
    amount_cents: MONTHLY_AMOUNT,
    integration: parseInt(MOTO_INTEGRATION_ID),
    use_transaction_amount: false,
    is_active: true,
    plan_type: 'rent',
    webhook_url: WEBHOOK_URL || undefined,
  }, { headers });
  const monthlyPlanId = monthlyRes.data.id;
  console.log(`  Monthly Plan created! ID: ${monthlyPlanId}`);
  console.log(`  Amount: ${MONTHLY_AMOUNT / 100} EGP, Frequency: 30 days\n`);

  // Create Yearly Plan
  console.log('Creating Yearly Plan (frequency: 360 days)...');
  const yearlyRes = await axios.post(`${BASE_URL}/acceptance/subscription-plans`, {
    frequency: 360,
    name: 'Yearly Plan',
    amount_cents: YEARLY_AMOUNT,
    integration: parseInt(MOTO_INTEGRATION_ID),
    use_transaction_amount: false,
    is_active: true,
    plan_type: 'rent',
    webhook_url: WEBHOOK_URL || undefined,
  }, { headers });
  const yearlyPlanId = yearlyRes.data.id;
  console.log(`  Yearly Plan created! ID: ${yearlyPlanId}`);
  console.log(`  Amount: ${YEARLY_AMOUNT / 100} EGP, Frequency: 360 days\n`);

  // Create Weekly Plan (7 days — minimum Paymob allows)
  console.log('Creating Weekly Plan (frequency: 7 days)...');
  const weeklyRes = await axios.post(`${BASE_URL}/acceptance/subscription-plans`, {
    frequency: 7,
    name: 'Weekly Plan',
    amount_cents: MONTHLY_AMOUNT,
    integration: parseInt(MOTO_INTEGRATION_ID),
    use_transaction_amount: false,
    is_active: true,
    plan_type: 'rent',
    webhook_url: WEBHOOK_URL || undefined,
  }, { headers });
  const weeklyPlanId = weeklyRes.data.id;
  console.log(`  Weekly Plan created! ID: ${weeklyPlanId}`);
  console.log(`  Amount: ${MONTHLY_AMOUNT / 100} EGP, Frequency: 7 days\n`);

  console.log('========================================');
  console.log('Add these to your .env file:');
  console.log('========================================');
  console.log(`PAYMOB_MONTHLY_PLAN_ID=${monthlyPlanId}`);
  console.log(`PAYMOB_YEARLY_PLAN_ID=${yearlyPlanId}`);
  console.log(`PAYMOB_WEEKLY_PLAN_ID=${weeklyPlanId}`);
  console.log('========================================');
}

main().catch((err) => {
  console.error('ERROR:', err.response?.data || err.message);
  process.exit(1);
});
