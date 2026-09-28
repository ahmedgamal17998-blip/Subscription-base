/**
 * Checkout / webhook tests — no database, no network.
 *
 *   node tests/checkout.test.js
 *
 * Prisma and axios are replaced with fakes, so the real routes run against an
 * in-memory database and a fake Paymob that mimics its rules (e.g. it rejects
 * plan frequencies Paymob does not accept).
 */
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const r = (p) => path.join(ROOT, p);

process.env.PAYMOB_API_KEY = 'k';
process.env.PAYMOB_HMAC_SECRET = 'hsecret';
process.env.PAYMOB_SECRET_KEY = 'sk';
process.env.PAYMOB_PUBLIC_KEY = 'pk';
process.env.PAYMOB_INTEGRATION_ID = '111';
process.env.DATABASE_URL = 'x';
process.env.JWT_SECRET = 'jwt';
process.env.APP_URL = 'https://app.test';
process.env.NODE_ENV = 'test';

// ── fake prisma ──────────────────────────────────────────────────────────────
const db = { subscription: [], payment: [], coupon: [], product: [], productPlan: [], productSettings: [], outboundWebhook: [], apiKey: [] };
const ids = {};
// Column defaults from prisma/schema.prisma that the real DB would fill in
const DEFAULTS = {
  product: { isActive: true, productType: 'subscription', walletEnabled: false },
  productPlan: { isActive: true, currency: 'EGP' },
  subscription: { status: 'pending', currency: 'EGP' },
};

function match(row, where = {}) {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return v.some((w) => match(row, w));
    // composite unique key, e.g. productId_planType: { productId, planType }
    if (k.includes('_') && v && typeof v === 'object' && !(v instanceof Date)) return match(row, v);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('not' in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      if ('lte' in v) return row[k] <= v.lte;
      if ('lt' in v) return row[k] < v.lt;
      return true;
    }
    return (row[k] ?? null) === (v ?? null);
  });
}

function withIncludes(name, row) {
  if (!row) return row;
  const out = { ...row };
  if (name === 'subscription') {
    out.product = db.product.find((p) => p.id === row.productId) || null;
    out.payments = db.payment.filter((p) => p.subscriptionId === row.id);
  }
  if (name === 'productPlan') out.product = db.product.find((p) => p.id === row.productId);
  if (name === 'product') out.plans = db.productPlan.filter((p) => p.productId === row.id);
  return out;
}

function model(name) {
  const t = db[name];
  const api = {
    findFirst: async ({ where } = {}) => withIncludes(name, [...t].reverse().find((x) => match(x, where))),
    findUnique: async ({ where }) => withIncludes(name, t.find((x) => match(x, where))),
    findMany: async ({ where } = {}) => t.filter((x) => match(x, where)).map((x) => withIncludes(name, x)),
    count: async ({ where } = {}) => t.filter((x) => match(x, where)).length,
    create: async ({ data }) => {
      if (name === 'payment' && t.some((x) => x.transactionId === data.transactionId)) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      ids[name] = (ids[name] || 0) + 1;
      const nested = data.plans?.create;
      const row = { id: ids[name], createdAt: new Date(), ...DEFAULTS[name], ...data };
      delete row.plans;
      if (name === 'coupon') row.usedCount = row.usedCount ?? 0;
      t.push(row);
      for (const plan of nested || []) await model('productPlan').create({ data: { ...plan, productId: row.id } });
      return withIncludes(name, row);
    },
    update: async ({ where, data }) => {
      const row = t.find((x) => match(x, where));
      if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
      for (const [k, v] of Object.entries(data)) row[k] = v && v.increment ? (row[k] || 0) + v.increment : v;
      return withIncludes(name, row);
    },
    updateMany: async ({ where, data }) => {
      const rows = t.filter((x) => match(x, where));
      for (const row of rows) for (const [k, v] of Object.entries(data)) row[k] = v && v.increment ? (row[k] || 0) + v.increment : v;
      return { count: rows.length };
    },
    upsert: async ({ where, create }) => t.find((x) => match(x, where)) || api.create({ data: create }),
  };
  return api;
}
const prisma = new Proxy({}, { get: (_, k) => (k === '$transaction' ? (a) => Promise.all(a) : model(k)) });
require.cache[require.resolve(r('src/db.js'))] = { exports: prisma, loaded: true, id: r('src/db.js') };
require.cache[require.resolve(r('src/utils/logger.js'))] = { exports: { log: () => {} }, loaded: true, id: r('src/utils/logger.js') };

// ── fake Paymob + outbound webhooks ──────────────────────────────────────────
const axios = require('axios');
const calls = { intentions: [], suspended: [], dispatched: [], plans: [] };
const PAYMOB_FREQUENCIES = [7, 15, 30, 60, 90, 180, 360]; // 365 is NOT one of them
let orderSeq = 5000;

axios.post = async (url, body) => {
  if (url.includes('/auth/tokens')) return { data: { token: 't' } };
  if (url.includes('/v1/intention/')) {
    calls.intentions.push(body);
    return { data: { client_secret: 'cs', intention_order_id: ++orderSeq } };
  }
  if (url.includes('/subscription-plans')) {
    calls.plans.push(body);
    if (!PAYMOB_FREQUENCIES.includes(body.frequency)) {
      throw Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { frequency: [`"${body.frequency}" is not a valid choice.`] } },
      });
    }
    return { data: { id: 8000 + calls.plans.length } };
  }
  if (url.includes('/suspend')) { calls.suspended.push(url); return { data: {} }; }
  if (url.includes('hook.test')) { calls.dispatched.push(JSON.parse(body).event); return { data: {} }; }
  throw new Error('unexpected POST ' + url);
};
axios.get = async (url) => {
  if (url.includes('/acceptance/subscriptions')) {
    return { data: { results: [{ id: 777, state: 'active', client_info: { email: 'A@x.com' } }], next: null } };
  }
  throw new Error('unexpected GET ' + url);
};

// ── app ──────────────────────────────────────────────────────────────────────
const rlPath = require.resolve('express-rate-limit');
const noLimit = () => (req, res, next) => next();
require.cache[rlPath] = { exports: Object.assign(noLimit, { rateLimit: noLimit, default: noLimit }), loaded: true, id: rlPath };

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api/payment', require(r('src/routes/payment.routes.js')));
app.use('/api/webhook', require(r('src/routes/webhook.routes.js')));
app.use('/api/subscriptions', require(r('src/routes/subscription.routes.js')));
app.use('/api/products', require(r('src/routes/product.routes.js')));

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function txHmac(obj) {
  const fields = [obj.amount_cents, obj.created_at, obj.currency, obj.error_occured, obj.has_parent_transaction, obj.id,
    obj.integration_id, obj.is_3d_secure, obj.is_auth, obj.is_capture, obj.is_refunded, obj.is_standalone_payment,
    obj.is_voided, obj.order?.id, obj.owner, obj.pending, obj.source_data?.pan, obj.source_data?.sub_type,
    obj.source_data?.type, obj.success].map((v) => String(v ?? '')).join('');
  return crypto.createHmac('sha512', 'hsecret').update(fields).digest('hex');
}

function tx(id, orderId, amount, success = true, email = 'a@x.com') {
  const obj = { id, order: { id: orderId, shipping_data: { email } }, amount_cents: amount, success, pending: false, source_data: { type: 'card' }, currency: 'EGP' };
  return call('POST', '/api/webhook/paymob?hmac=' + txHmac(obj), { type: 'TRANSACTION', obj });
}

function subHook(trigger, data) {
  const hmac = crypto.createHmac('sha512', 'hsecret').update(`${trigger}for${data.id}`).digest('hex');
  return call('POST', '/api/webhook/paymob-subscription', { trigger_type: trigger, subscription_data: data, hmac });
}

const dayStr = (d) => d.toISOString().slice(0, 10);
const results = [];
async function test(name, fn) {
  try { await fn(); results.push('PASS ' + name); }
  catch (e) { results.push('FAIL ' + name + ' → ' + e.message); }
}

(async () => {
  const admin = 'Bearer ' + jwt.sign({ id: 1, role: 'admin', email: 'ad@x' }, 'jwt');
  const viewer = 'Bearer ' + jwt.sign({ id: 9, role: 'viewer', email: 'v@x' }, 'jwt');

  db.outboundWebhook.push({ id: 1, isActive: true, productId: null, url: 'https://hook.test/x',
    events: 'payment_success,payment_failed,renewal_success,renewal_failed,cancelled,cancel_requested,expired' });

  // ── admin: creating products ───────────────────────────────────────────────
  await test('One-Time product: plan type one_time is accepted, no Paymob plan created', async () => {
    const res = await call('POST', '/api/products', { name: 'Ebook', type: 'one_time',
      plans: [{ label: 'Ebook', amountCents: 19900, planType: 'one_time', intervalLabel: 'One-Time' }] }, { Authorization: admin });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.productType, 'one_time');
    assert.strictEqual(db.productPlan.at(-1).planType, 'one_time');
    assert.strictEqual(db.productPlan.at(-1).paymobSubscriptionPlanId, null);
  });

  await test('two One-Time plans in one product are refused with a clear message', async () => {
    const res = await call('POST', '/api/products', { name: 'Two', type: 'one_time', plans: [
      { label: 'A', amountCents: 100, planType: 'one_time', intervalLabel: 'One-Time' },
      { label: 'B', amountCents: 200, planType: 'one_time', intervalLabel: 'One-Time' },
    ] }, { Authorization: admin });
    assert.strictEqual(res.status, 400);
    assert.ok(/only one One-Time plan/.test(res.body.error), res.body.error);
  });

  await test('subscription product creates its Paymob plan (monthly = 30 days)', async () => {
    const res = await call('POST', '/api/products', { name: 'Prod', type: 'subscription',
      plans: [{ label: 'Monthly', amountCents: 150000, planType: 'monthly', intervalLabel: 'Monthly' }] }, { Authorization: admin });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(calls.plans.at(-1).frequency, 30);
    assert.ok(db.productPlan.at(-1).paymobSubscriptionPlanId > 8000);
  });

  const prod = db.product.find((p) => p.name === 'Prod');
  const monthlyPlanId = db.productPlan.find((p) => p.productId === prod.id).paymobSubscriptionPlanId;
  const pay = { name: 'Ali Test', email: 'A@x.com', phone: '01000000000', plan: 'monthly', productSlug: prod.slug, paymentMethod: 'card' };

  // ── checkout ───────────────────────────────────────────────────────────────
  let firstOrder, secondOrder;
  await test('subscription checkout sends subscription_start_date one period ahead (no double charge)', async () => {
    const res = await call('POST', '/api/payment/create', pay);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const body = calls.intentions.at(-1);
    const expected = new Date(); expected.setUTCDate(expected.getUTCDate() + 30);
    assert.strictEqual(body.subscription_start_date, dayStr(expected));
    assert.strictEqual(body.subscription_plan_id, monthlyPlanId);
    firstOrder = orderSeq;
  });

  await test('customer can retry checkout; the unpaid attempt is retired (no 409)', async () => {
    const res = await call('POST', '/api/payment/create', pay);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    secondOrder = orderSeq;
    assert.deepStrictEqual(db.subscription.map((s) => s.status), ['abandoned', 'pending']);
  });

  await test('initial payment activates once even when the webhook arrives twice at once', async () => {
    await Promise.all([tx(900, secondOrder, 150000), tx(900, secondOrder, 150000)]);
    assert.strictEqual(db.subscription[1].status, 'active');
    assert.deepStrictEqual(calls.dispatched, ['payment_success']);
    assert.strictEqual(db.payment.length, 1);
  });

  await test('subscription "created" webhook uses a future starts_at as the next renewal', async () => {
    const start = new Date(); start.setUTCDate(start.getUTCDate() + 30);
    const later = new Date(); later.setUTCDate(later.getUTCDate() + 60);
    await subHook('created', { id: 777, plan_id: monthlyPlanId, initial_transaction: 900,
      starts_at: dayStr(start), next_billing: dayStr(later), client_info: { email: 'a@x.com' } });
    assert.strictEqual(db.subscription[1].paymobSubscriptionId, 777);
    assert.strictEqual(dayStr(db.subscription[1].nextRenewalDate), dayStr(start));
  });

  await test('an early extra charge is recorded as needs_refund, with no event and no renewal', async () => {
    const before = db.subscription[1].nextRenewalDate;
    await tx(901, 6001, 150000);
    assert.strictEqual(db.payment.find((x) => x.transactionId === '901').status, 'needs_refund');
    assert.deepStrictEqual(calls.dispatched, ['payment_success']);
    assert.strictEqual(db.subscription[1].nextRenewalDate, before);
  });

  await test('a real renewal extends the period and fires renewal_success', async () => {
    db.subscription[1].nextRenewalDate = new Date(Date.now() - 3600e3);
    await tx(902, 6002, 150000);
    assert.deepStrictEqual(calls.dispatched, ['payment_success', 'renewal_success']);
    assert.ok(db.subscription[1].nextRenewalDate > new Date(Date.now() + 25 * 864e5));
  });

  await test('a retired attempt still activates if the customer pays it', async () => {
    await tx(903, firstOrder, 150000);
    assert.strictEqual(db.subscription[0].status, 'active');
    assert.strictEqual(db.payment.find((x) => x.transactionId === '903').type, 'initial');
  });

  await test('a renewal is never guessed when an email has several active subscriptions', async () => {
    const n = calls.dispatched.length;
    await tx(904, 6004, 99999);
    assert.strictEqual(db.payment.find((x) => x.transactionId === '904'), undefined);
    assert.strictEqual(calls.dispatched.length, n);
  });

  // ── one-time ───────────────────────────────────────────────────────────────
  const buyer = { name: 'Mona Buyer', email: 'mona@x.com', phone: '01011111111', productSlug: prod.slug, paymentMethod: 'card' };

  await test('One-Time plan on a subscription product is a plain payment', async () => {
    await call('POST', `/api/products/${prod.id}/plans`, { planType: 'one_time', amountCents: 10000, label: 'One time', intervalLabel: 'One-Time' }, { Authorization: admin });
    const res = await call('POST', '/api/payment/create', { ...buyer, plan: 'one_time' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const body = calls.intentions.at(-1);
    assert.strictEqual(body.amount, 10000);
    assert.strictEqual(body.subscription_plan_id, undefined);
    assert.strictEqual(body.subscription_start_date, undefined);
    await tx(950, orderSeq, 10000, true, 'mona@x.com');
    assert.strictEqual(db.subscription.at(-1).status, 'active');
  });

  await test('a one-time buyer can still subscribe, and renewals go to the subscription', async () => {
    const res = await call('POST', '/api/payment/create', { ...buyer, plan: 'monthly' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    await tx(951, orderSeq, 150000, true, 'mona@x.com');
    const monthly = db.subscription.at(-1);
    monthly.nextRenewalDate = new Date(Date.now() - 3600e3);
    const n = calls.dispatched.length;
    await tx(952, 7000, 150000, true, 'mona@x.com');
    assert.deepStrictEqual(calls.dispatched.slice(n), ['renewal_success']);
    assert.strictEqual(db.payment.find((x) => x.transactionId === '952').subscriptionId, monthly.id);
  });

  // ── yearly = 360 days, and repair of missing Paymob plans ──────────────────
  await test('yearly plan missing on Paymob is created at checkout with 360 days', async () => {
    db.productPlan.push({ id: 970, productId: prod.id, planType: 'yearly', isActive: true, amountCents: 100, paymobSubscriptionPlanId: null });
    const res = await call('POST', '/api/payment/create', { ...buyer, email: 'y@x.com', plan: 'yearly' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.plans.at(-1).frequency, 360);
    const planId = calls.intentions.at(-1).subscription_plan_id;
    assert.strictEqual(db.productPlan.find((p) => p.id === 970).paymobSubscriptionPlanId, planId);
    const start = new Date(); start.setUTCDate(start.getUTCDate() + 360);
    assert.strictEqual(calls.intentions.at(-1).subscription_start_date, dayStr(start));
  });

  await test('if Paymob refuses the plan, checkout is blocked (503) and nothing is charged', async () => {
    const plans = require(r('src/utils/plans.js'));
    plans.PLAN_DAYS.weekly = 365; // a frequency Paymob rejects
    db.productPlan.push({ id: 971, productId: prod.id, planType: 'weekly', isActive: true, amountCents: 2200, paymobSubscriptionPlanId: null });
    const n = calls.intentions.length;
    const res = await call('POST', '/api/payment/create', { ...buyer, email: 'z@x.com', plan: 'weekly' });
    plans.PLAN_DAYS.weekly = 7;
    assert.strictEqual(res.status, 503);
    assert.strictEqual(calls.intentions.length, n);
  });

  // ── admin actions ──────────────────────────────────────────────────────────
  await test('viewer cannot cancel a subscription', async () => {
    const res = await call('POST', '/api/subscriptions/2/cancel', null, { Authorization: viewer });
    assert.strictEqual(res.status, 403);
  });

  await test('admin cancel suspends on Paymob and fires cancel_requested once', async () => {
    db.subscription[1].cancelledAt = null;
    db.subscription[1].nextRenewalDate = new Date(Date.now() + 20 * 864e5);
    const res = await call('POST', '/api/subscriptions/2/cancel', null, { Authorization: admin });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(calls.suspended.at(-1).includes('/777/suspend'));
    assert.strictEqual(calls.dispatched.filter((e) => e === 'cancel_requested').length, 1);
  });

  await test('Paymob "suspended" keeps a cancel-pending customer active until the period ends', async () => {
    await subHook('suspended', { id: 777 });
    assert.strictEqual(db.subscription[1].status, 'active');
    assert.ok(!calls.dispatched.includes('cancelled'));
  });

  server.close();
  console.log(results.join('\n'));
  const failed = results.filter((x) => x.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
