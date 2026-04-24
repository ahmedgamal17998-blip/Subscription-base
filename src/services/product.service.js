const prisma = require('../db');
const paymobService = require('./paymob.service');
const config = require('../config');
const { log } = require('../utils/logger');

const PLAN_FREQUENCY_DAYS = { weekly: 7, monthly: 30, '3-months': 90, '6-months': 180, yearly: 365 };

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function ensureUniqueSlug(baseSlug, excludeId) {
  let slug = baseSlug;
  let counter = 2;
  while (true) {
    const existing = await prisma.product.findUnique({ where: { slug } });
    if (!existing || existing.id === excludeId) return slug;
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
}

async function createPaymobPlan(productName, planType, amountCents) {
  try {
    const authToken = await paymobService.authenticate();
    const integrationId = config.PAYMOB_MOTO_INTEGRATION_ID || config.PAYMOB_INTEGRATION_ID;
    const webhookUrl = config.APP_URL ? `${config.APP_URL}/api/webhook/paymob-subscription` : '';
    const frequency = PLAN_FREQUENCY_DAYS[planType];
    if (!frequency) return null;

    const result = await paymobService.createSubscriptionPlan(authToken, {
      name: `${productName} — ${planType}`,
      frequency,
      amountCents,
      integrationId: parseInt(integrationId),
      webhookUrl,
    });
    log('INFO', 'product', `Paymob plan created for ${productName} (${planType})`, { paymobPlanId: result.id });
    return result.id;
  } catch (err) {
    log('WARN', 'product', `Failed to create Paymob plan for ${productName} (${planType})`, { error: err.message });
    return null;
  }
}

async function createProduct({ name, description, walletEnabled, productType, plans }) {
  const slug = await ensureUniqueSlug(slugify(name));
  const isSubscription = (productType || 'subscription') === 'subscription';

  // Auto-create Paymob subscription plans (only for subscription type)
  const plansWithPaymob = [];
  for (const p of plans) {
    const paymobPlanId = isSubscription ? await createPaymobPlan(name, p.planType, p.amountCents) : null;
    plansWithPaymob.push({
      planType: p.planType,
      amountCents: p.amountCents,
      currency: p.currency || 'EGP',
      paymobSubscriptionPlanId: paymobPlanId,
      label: p.label,
      intervalLabel: p.intervalLabel,
      badge: p.badge || null,
    });
  }

  return prisma.product.create({
    data: {
      name,
      slug,
      description: description || null,
      walletEnabled: !!walletEnabled,
      productType: productType || 'subscription',
      plans: { create: plansWithPaymob },
    },
    include: { plans: true, settings: true },
  });
}

async function listProducts() {
  return prisma.product.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      plans: { orderBy: { planType: 'asc' } },
      settings: true,
      _count: { select: { subscriptions: true } },
    },
  });
}

async function getProductById(id) {
  return prisma.product.findUnique({
    where: { id: parseInt(id) },
    include: {
      plans: { orderBy: { planType: 'asc' } },
      settings: true,
      _count: { select: { subscriptions: true } },
    },
  });
}

async function getProductBySlug(slug) {
  return prisma.product.findUnique({
    where: { slug },
    include: { plans: { orderBy: { planType: 'asc' } }, settings: true },
  });
}

async function updateProduct(id, { name, description, isActive, walletEnabled, productType }) {
  const data = {};
  if (name !== undefined) {
    data.name = name;
    data.slug = await ensureUniqueSlug(slugify(name), parseInt(id));
  }
  if (description !== undefined) data.description = description;
  if (isActive !== undefined) data.isActive = isActive;
  if (walletEnabled !== undefined) data.walletEnabled = walletEnabled;
  if (productType !== undefined) data.productType = productType;
  return prisma.product.update({
    where: { id: parseInt(id) },
    data,
    include: { plans: true, settings: true },
  });
}

async function addPlan(productId, { planType, amountCents, currency, label, intervalLabel, badge }) {
  const product = await prisma.product.findUnique({ where: { id: parseInt(productId) } });
  if (!product) throw new Error('Product not found');
  const paymobPlanId = await createPaymobPlan(product.name, planType, amountCents);

  return prisma.productPlan.create({
    data: {
      productId: parseInt(productId),
      planType,
      amountCents,
      currency: currency || 'EGP',
      paymobSubscriptionPlanId: paymobPlanId,
      label,
      intervalLabel,
      badge: badge || null,
    },
  });
}

async function updatePlan(planId, data) {
  const updateData = {};
  if (data.amountCents !== undefined) updateData.amountCents = data.amountCents;
  if (data.currency !== undefined) updateData.currency = data.currency;
  if (data.label !== undefined) updateData.label = data.label;
  if (data.intervalLabel !== undefined) updateData.intervalLabel = data.intervalLabel;
  if (data.badge !== undefined) updateData.badge = data.badge;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;
  return prisma.productPlan.update({
    where: { id: parseInt(planId) },
    data: updateData,
  });
}

async function deactivatePlan(planId) {
  return prisma.productPlan.update({
    where: { id: parseInt(planId) },
    data: { isActive: false },
  });
}

async function deleteProduct(id) {
  const product = await prisma.product.findUnique({
    where: { id: parseInt(id) },
    include: { _count: { select: { subscriptions: { where: { status: 'active' } } } } },
  });
  if (!product) throw { code: 'P2025' };
  if (product._count.subscriptions > 0) {
    throw new Error('Cannot delete product with active subscriptions. Deactivate it instead.');
  }
  // Delete plans first, then product
  await prisma.productPlan.deleteMany({ where: { productId: parseInt(id) } });
  return prisma.product.delete({ where: { id: parseInt(id) } });
}

async function deletePlan(planId) {
  return prisma.productPlan.delete({ where: { id: parseInt(planId) } });
}

async function getPublicProductConfig(slug) {
  const product = await prisma.product.findUnique({
    where: { slug },
    include: {
      plans: { where: { isActive: true }, orderBy: { planType: 'asc' } },
      settings: true,
    },
  });
  if (!product || !product.isActive) return null;

  const plans = {};
  for (const p of product.plans) {
    plans[p.planType] = {
      amountCents: p.amountCents,
      currency: p.currency,
      label: p.label,
      interval: p.intervalLabel,
      ...(p.badge ? { badge: p.badge } : {}),
    };
  }

  // Expose only safe settings fields to the public checkout page
  const publicSettings = product.settings ? {
    logoUrl: product.settings.logoUrl,
    primaryColor: product.settings.primaryColor,
    accentColor: product.settings.accentColor,
    ctaText: product.settings.ctaText,
    checkoutTitle: product.settings.checkoutTitle,
    couponsEnabled: product.settings.couponsEnabled,
    headCode: product.settings.headCode, // safe to expose — it's the owner's own code
  } : {};

  return {
    product: {
      id: product.id,
      name: product.name,
      slug: product.slug,
      productType: product.productType,
    },
    plans,
    currency: product.plans[0]?.currency || 'EGP',
    walletEnabled: product.walletEnabled && !!config.PAYMOB_WALLET_INTEGRATION_ID,
    settings: publicSettings,
  };
}

module.exports = {
  slugify,
  createProduct,
  listProducts,
  getProductById,
  getProductBySlug,
  updateProduct,
  addPlan,
  updatePlan,
  deactivatePlan,
  deleteProduct,
  deletePlan,
  getPublicProductConfig,
};
