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
  coupon: { isActive: true, usedCount: 0, maxUses: null, appliesTo: 'first_payment', renewalCount: null },
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
  if (name === 'product') {
    out.plans = db.productPlan.filter((p) => p.productId === row.id);
    out.settings = db.productSettings.find((s) => s.productId === row.id) || null;
  }
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
      if (failNext[name] > 0) { failNext[name]--; throw new Error('database unavailable'); }
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
// $transaction: array form, or callback form (no rollback needed for these tests)
const failNext = { payment: 0 }; // make the next N writes to a table throw, like a DB hiccup
const prisma = new Proxy({}, {
  get: (_, k) => (k === '$transaction' ? (a) => (typeof a === 'function' ? a(prisma) : Promise.all(a)) : model(k)),
});
require.cache[require.resolve(r('src/db.js'))] = { exports: prisma, loaded: true, id: r('src/db.js') };
require.cache[require.resolve(r('src/utils/logger.js'))] = { exports: { log: () => {} }, loaded: true, id: r('src/utils/logger.js') };

// ── fake Paymob + outbound webhooks ──────────────────────────────────────────
const axios = require('axios');
const calls = { intentions: [], suspended: [], dispatched: [], plans: [], amounts: [] };
// Paymob subscriptions that exist on the fake Paymob side, found by the customer search
const paymobSubs = [{ id: 777, state: 'active', client_info: { email: 'A@x.com' } }];
const paymobFail = { put: 0, resume: 0 };
const paymobTx = {}; // paymob subscription id -> transaction ids
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
  if (url.includes('/resume')) {
    if (paymobFail.resume > 0) { paymobFail.resume--; throw new Error('Paymob unavailable'); }
    (calls.resumed = calls.resumed || []).push(url);
    return { data: {} };
  }
  if (url.includes('hook.test')) { calls.dispatched.push(JSON.parse(body).event); return { data: {} }; }
  throw new Error('unexpected POST ' + url);
};
axios.get = async (url) => {
  const one = url.match(/\/acceptance\/subscriptions\/(\d+)(\/transactions)?$/);
  if (one) {
    const id = Number(one[1]);
    if (one[2]) return { data: { results: (paymobTx[id] || []).map((t) => ({ id: t })) } };
    const found = paymobSubs.find((x) => x.id === id);
    if (!found) throw Object.assign(new Error('404'), { response: { status: 404, data: { detail: 'Not found.' } } });
    return { data: found };
  }
  if (url.includes('/acceptance/subscriptions')) {
    return { data: { results: paymobSubs, next: null } };
  }
  throw new Error('unexpected GET ' + url);
};

// ── app ──────────────────────────────────────────────────────────────────────
axios.put = async (url, body) => {
  const m = url.match(/\/acceptance\/subscriptions\/(\d+)$/);
  if (m) {
    if (paymobFail.put > 0) { paymobFail.put--; throw new Error('Paymob unavailable'); }
    calls.amounts.push({ id: Number(m[1]), amount: body.amount_cents });
    const target = paymobSubs.find((x) => x.id === Number(m[1]));
    if (target) target.amount_cents = body.amount_cents;
    return { data: { id: Number(m[1]), amount_cents: body.amount_cents } };
  }
  throw new Error('unexpected PUT ' + url);
};

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
app.use('/api/coupons', require(r('src/routes/coupon.routes.js')));

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

  await test('a DB failure answers 500 (Paymob retries) and the retry then activates', async () => {
    const res0 = await call('POST', '/api/payment/create', { ...pay, email: 'retry@x.com' });
    assert.strictEqual(res0.status, 200, JSON.stringify(res0.body));
    const order = orderSeq;
    const n = calls.dispatched.length;
    failNext.payment = 1;
    const first = await tx(910, order, 150000, true, 'retry@x.com');
    assert.strictEqual(first.status, 500);
    assert.strictEqual(db.subscription.at(-1).status, 'pending');
    assert.strictEqual(calls.dispatched.length, n, 'no event before the payment is stored');
    const second = await tx(910, order, 150000, true, 'retry@x.com');
    assert.strictEqual(second.status, 200);
    assert.strictEqual(db.subscription.at(-1).status, 'active');
    assert.deepStrictEqual(calls.dispatched.slice(n), ['payment_success']);
  });

  await test('"already subscribed" reply does not reveal the plan or renewal date', async () => {
    const res = await call('POST', '/api/payment/create', { ...pay, email: 'retry@x.com' });
    assert.strictEqual(res.status, 409);
    assert.deepStrictEqual(Object.keys(res.body), ['error']);
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


  // ── coupons on renewals ────────────────────────────────────────────────────
  db.productSettings.push({ id: 1, productId: prod.id, couponsEnabled: true });
  const due = (s) => { s.nextRenewalDate = new Date(Date.now() - 3600e3); };
  const coupon = async (body) => {
    const res = await call('POST', '/api/coupons', body, { Authorization: admin });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  let txId = 2000;
  let orderNo = 9000;

  await test('fixed coupon is in EGP: 100 EGP off a 1,500 plan charges 1,400', async () => {
    await coupon({ code: 'FIX100', discountType: 'fixed', discountValue: 100, appliesTo: 'first_payment' });
    const res = await call('POST', '/api/payment/create', { ...pay, email: 'fix@x.com', couponCode: 'fix100' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.intentions.at(-1).amount, 140000);
  });

  await test('"first payment only": renewals stay full price, Paymob amount never touched', async () => {
    await coupon({ code: 'FIRST20', discountType: 'percentage', discountValue: 20, appliesTo: 'first_payment' });
    paymobSubs.push({ id: 801, state: 'active', initial_transaction: txId + 1, client_info: { email: 'first@x.com' } });
    const n = calls.amounts.length;
    const res = await call('POST', '/api/payment/create', { ...pay, email: 'first@x.com', couponCode: 'FIRST20' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.intentions.at(-1).amount, 120000);
    await tx(++txId, orderSeq, 120000, true, 'first@x.com');
    const s = db.subscription.find((x) => x.email === 'first@x.com');
    assert.strictEqual(s.status, 'active');
    assert.strictEqual(s.renewalDiscountCents ?? null, null);
    assert.strictEqual(calls.amounts.length, n, 'no Paymob amount change');
  });

  await test('"first payment + 2 renewals": Paymob set to discounted price, back to full after the 2nd renewal', async () => {
    await coupon({ code: 'TWO20', discountType: 'percentage', discountValue: 20, appliesTo: 'renewals', renewalCount: 2 });
    paymobSubs.push({ id: 802, state: 'active', initial_transaction: txId + 1, client_info: { email: 'two@x.com' } });
    const res = await call('POST', '/api/payment/create', { ...pay, email: 'two@x.com', couponCode: 'TWO20' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.intentions.at(-1).amount, 120000);
    const s = db.subscription.find((x) => x.email === 'two@x.com');
    assert.deepStrictEqual([s.fullPriceCents, s.renewalDiscountCents, s.discountedRenewalsLeft], [150000, 30000, 2]);

    // first payment → linked by search, renewal price set to 1,200
    await tx(++txId, orderSeq, 120000, true, 'two@x.com');
    assert.deepStrictEqual(calls.amounts.filter((a) => a.id === 802), [{ id: 802, amount: 120000 }]);

    // Paymob "created" arrives after — already in sync, no second call
    await subHook('created', { id: 802, plan_id: monthlyPlanId, initial_transaction: txId, client_info: { email: 'two@x.com' } });
    assert.strictEqual(calls.amounts.filter((a) => a.id === 802).length, 1);

    // renewal 1 (discounted) → 1 left, nothing to change
    due(s); await tx(++txId, ++orderNo, 120000, true, 'two@x.com');
    assert.strictEqual(s.discountedRenewalsLeft, 1);
    assert.strictEqual(calls.amounts.filter((a) => a.id === 802).length, 1);

    // renewal 2 (last discounted) → 0 left, Paymob back to full price
    due(s); await tx(++txId, ++orderNo, 120000, true, 'two@x.com');
    assert.strictEqual(s.discountedRenewalsLeft, 0);
    assert.deepStrictEqual(calls.amounts.filter((a) => a.id === 802).at(-1), { id: 802, amount: 150000 });

    // renewal 3 (full price) → no further changes
    const before = calls.amounts.length;
    due(s); await tx(++txId, ++orderNo, 150000, true, 'two@x.com');
    assert.strictEqual(calls.amounts.length, before);
    assert.strictEqual(s.discountedRenewalsLeft, 0);
  });

  await test('"every renewal": discounted forever, never switched back', async () => {
    await coupon({ code: 'ALL10', discountType: 'percentage', discountValue: 10, appliesTo: 'all_renewals' });
    paymobSubs.push({ id: 803, state: 'active', initial_transaction: txId + 1, client_info: { email: 'all@x.com' } });
    await call('POST', '/api/payment/create', { ...pay, email: 'all@x.com', couponCode: 'ALL10' });
    await tx(++txId, orderSeq, 135000, true, 'all@x.com');
    const s = db.subscription.find((x) => x.email === 'all@x.com');
    assert.strictEqual(s.discountedRenewalsLeft ?? null, null);
    for (let i = 0; i < 3; i++) { due(s); await tx(++txId, ++orderNo, 135000, true, 'all@x.com'); }
    assert.deepStrictEqual(calls.amounts.filter((a) => a.id === 803), [{ id: 803, amount: 135000 }]);
  });

  await test('if Paymob refuses the price change, the payment still activates and the daily job fixes it', async () => {
    await coupon({ code: 'RETRY', discountType: 'percentage', discountValue: 50, appliesTo: 'renewals', renewalCount: 1 });
    paymobSubs.push({ id: 804, state: 'active', initial_transaction: txId + 1, client_info: { email: 'flaky@x.com' } });
    await call('POST', '/api/payment/create', { ...pay, email: 'flaky@x.com', couponCode: 'RETRY' });
    paymobFail.put = 1;
    const res = await tx(++txId, orderSeq, 75000, true, 'flaky@x.com');
    const s = db.subscription.find((x) => x.email === 'flaky@x.com');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(s.status, 'active');
    assert.strictEqual(calls.amounts.filter((a) => a.id === 804).length, 0);
    const result = await require(r('src/services/renewal-discount.service.js')).syncAll();
    assert.ok(result.checked >= 1);
    assert.deepStrictEqual(calls.amounts.filter((a) => a.id === 804), [{ id: 804, amount: 75000 }]);
  });

  await test('coupon API rejects a bad renewal count and stores the legacy "all_renewals" as every renewal', async () => {
    const bad = await call('POST', '/api/coupons', { code: 'BAD', discountType: 'percentage', discountValue: 5, appliesTo: 'renewals', renewalCount: 0 }, { Authorization: admin });
    assert.strictEqual(bad.status, 400);
    const legacy = db.coupon.find((c) => c.code === 'ALL10');
    assert.deepStrictEqual([legacy.appliesTo, legacy.renewalCount], ['renewals', null]);
  });


  await test('linking never picks an OLD Paymob subscription of the same customer', async () => {
    await coupon({ code: 'OLD30', discountType: 'percentage', discountValue: 30, appliesTo: 'renewals', renewalCount: 1 });
    // the customer's previous (suspended) subscription on the same plan
    paymobSubs.push({ id: 805, state: 'suspended', initial_transaction: 1, client_info: { email: 'again@x.com' } });
    await call('POST', '/api/payment/create', { ...pay, email: 'again@x.com', couponCode: 'OLD30' });
    const s = db.subscription.find((x) => x.email === 'again@x.com');
    await tx(++txId, orderSeq, 105000, true, 'again@x.com');
    assert.strictEqual(s.paymobSubscriptionId ?? null, null, 'not linked to the old one');
    assert.strictEqual(calls.amounts.filter((a) => a.id === 805).length, 0);
    // Paymob creates the new one and tells us → linked and discounted
    paymobSubs.push({ id: 806, state: 'active', initial_transaction: txId, client_info: { email: 'again@x.com' } });
    await subHook('created', { id: 806, plan_id: monthlyPlanId, initial_transaction: txId, client_info: { email: 'again@x.com' } });
    assert.strictEqual(s.paymobSubscriptionId, 806);
    assert.deepStrictEqual(calls.amounts.filter((a) => a.id === 806), [{ id: 806, amount: 105000 }]);
  });

  await test('a renewal charged at FULL price while a discount was due keeps the discount and is flagged', async () => {
    const s = db.subscription.find((x) => x.email === 'again@x.com');
    assert.strictEqual(s.discountedRenewalsLeft, 1);
    paymobSubs.find((x) => x.id === 806).amount_cents = 150000; // someone changed it on Paymob
    due(s); await tx(++txId, ++orderNo, 150000, true, 'again@x.com');
    assert.strictEqual(s.discountedRenewalsLeft, 1, 'discount not used up');
    assert.ok(/refund the difference/.test(db.payment.find((x) => x.transactionId === String(txId)).failReason));
    const fixed = await require(r('src/services/renewal-discount.service.js')).syncAll();
    assert.ok(fixed.synced >= 1);
    assert.strictEqual(paymobSubs.find((x) => x.id === 806).amount_cents, 105000, 'daily job reads Paymob and restores the discount');
  });

  await test('a renewal is matched by asking Paymob when two subscriptions share email and amount', async () => {
    const a = db.subscription.find((x) => x.email === 'again@x.com');
    // a second active subscription for the same email, same price
    await call('POST', '/api/payment/create', { ...pay, email: 'again@x.com', plan: 'monthly' }).catch(() => {});
    const second = { ...a, id: 9999, paymobSubscriptionId: 807, lastPaymobOrder: 'x', discountedRenewalsLeft: null, renewalDiscountCents: null, paymobAmountCents: null };
    db.subscription.push(second);
    paymobTx[807] = ['7777'];
    second.nextRenewalDate = new Date(Date.now() - 3600e3);
    await tx(7777, ++orderNo, 105000, true, 'again@x.com');
    assert.strictEqual(db.payment.find((x) => x.transactionId === '7777').subscriptionId, 9999);
    db.subscription.splice(db.subscription.indexOf(second), 1);
  });

  await test('undo cancel resumes the subscription on Paymob', async () => {
    const s = db.subscription.find((x) => x.email === 'two@x.com');
    s.nextRenewalDate = new Date(Date.now() + 10 * 864e5);
    const c = await call('POST', `/api/subscriptions/${s.id}/cancel`, null, { Authorization: admin });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const u = await call('POST', `/api/subscriptions/${s.id}/reactivate`, null, { Authorization: admin });
    assert.strictEqual(u.status, 200, JSON.stringify(u.body));
    assert.ok((calls.resumed || []).some((x) => x.includes('/802/resume')));
    assert.strictEqual(s.cancelledAt, null);
  });

  await test('if Paymob refuses to resume, the cancellation is kept (no silent free access)', async () => {
    const s = db.subscription.find((x) => x.email === 'two@x.com');
    await call('POST', `/api/subscriptions/${s.id}/cancel`, null, { Authorization: admin });
    paymobFail.resume = 1;
    const u = await call('POST', `/api/subscriptions/${s.id}/reactivate`, null, { Authorization: admin });
    assert.strictEqual(u.status, 502);
    assert.ok(s.cancelledAt, 'still cancel-pending');
  });

  server.close();
  console.log(results.join('\n'));
  const failed = results.filter((x) => x.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
