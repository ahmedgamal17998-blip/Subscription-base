const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAdmin, requireAnyRole } = require('../middleware/auth.middleware');
const productService = require('../services/product.service');
const { log } = require('../utils/logger');

const router = express.Router();

const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, message: { error: 'Too many requests' } });

// ── Public: product config for subscribe page ───────────────────────────────
router.get('/slug/:slug/config', async (req, res) => {
  try {
    const config = await productService.getPublicProductConfig(req.params.slug);
    if (!config) return res.status(404).json({ error: 'Product not found' });
    return res.json(config);
  } catch (err) {
    log('ERROR', 'products', 'Failed to get product config', { error: err.message });
    return res.status(500).json({ error: 'Failed to get product config.' });
  }
});

// ── Admin: list all products ────────────────────────────────────────────────
router.get('/', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const products = await productService.listProducts();
    return res.json(products);
  } catch (err) {
    log('ERROR', 'products', 'Failed to list products', { error: err.message });
    return res.status(500).json({ error: 'Failed to list products.' });
  }
});

// ── Admin: create product ───────────────────────────────────────────────────
router.post('/', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { name, description, walletEnabled, plans } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Product name is required.' });
    }
    if (!plans || !Array.isArray(plans) || plans.length === 0) {
      return res.status(400).json({ error: 'At least one plan is required.' });
    }

    const validPlanTypes = ['weekly', 'monthly', '3-months', '6-months', 'yearly'];
    for (const plan of plans) {
      if (!validPlanTypes.includes(plan.planType)) {
        return res.status(400).json({ error: `Invalid plan type: ${plan.planType}` });
      }
      if (!plan.amountCents || plan.amountCents <= 0) {
        return res.status(400).json({ error: `Amount is required for plan: ${plan.planType}` });
      }
      if (!plan.label) {
        return res.status(400).json({ error: `Label is required for plan: ${plan.planType}` });
      }
      if (!plan.intervalLabel) {
        return res.status(400).json({ error: `Interval label is required for plan: ${plan.planType}` });
      }
    }

    const product = await productService.createProduct({ name: name.trim(), description, walletEnabled: !!walletEnabled, plans });
    log('INFO', 'products', 'Product created', { productId: product.id, slug: product.slug });
    return res.status(201).json(product);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A product with this name already exists.' });
    }
    log('ERROR', 'products', 'Failed to create product', { error: err.message });
    return res.status(500).json({ error: 'Failed to create product.' });
  }
});

// ── Admin: get product detail ───────────────────────────────────────────────
router.get('/:id', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const product = await productService.getProductById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    return res.json(product);
  } catch (err) {
    log('ERROR', 'products', 'Failed to get product', { error: err.message });
    return res.status(500).json({ error: 'Failed to get product.' });
  }
});

// ── Admin: update product ───────────────────────────────────────────────────
router.put('/:id', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { name, description, isActive, walletEnabled } = req.body;
    const product = await productService.updateProduct(req.params.id, { name, description, isActive, walletEnabled });
    log('INFO', 'products', 'Product updated', { productId: product.id });
    return res.json(product);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Product not found' });
    log('ERROR', 'products', 'Failed to update product', { error: err.message });
    return res.status(500).json({ error: 'Failed to update product.' });
  }
});

// ── Admin: add plan to product ──────────────────────────────────────────────
router.post('/:id/plans', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { planType, amountCents, currency, label, intervalLabel, badge } = req.body;
    if (!planType || !amountCents || !label || !intervalLabel) {
      return res.status(400).json({ error: 'planType, amountCents, label, and intervalLabel are required.' });
    }
    const plan = await productService.addPlan(req.params.id, {
      planType, amountCents, currency, label, intervalLabel, badge,
    });
    log('INFO', 'products', 'Plan added', { productId: req.params.id, planId: plan.id });
    return res.status(201).json(plan);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'This plan type already exists for this product.' });
    log('ERROR', 'products', 'Failed to add plan', { error: err.message });
    return res.status(500).json({ error: 'Failed to add plan.' });
  }
});

// ── Admin: update plan ──────────────────────────────────────────────────────
router.put('/:id/plans/:planId', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const plan = await productService.updatePlan(req.params.planId, req.body);
    log('INFO', 'products', 'Plan updated', { planId: plan.id });
    return res.json(plan);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Plan not found' });
    log('ERROR', 'products', 'Failed to update plan', { error: err.message });
    return res.status(500).json({ error: 'Failed to update plan.' });
  }
});

// ── Admin: deactivate plan ──────────────────────────────────────────────────
router.delete('/:id/plans/:planId', adminLimiter, requireAdmin, async (req, res) => {
  try {
    await productService.deactivatePlan(req.params.planId);
    log('INFO', 'products', 'Plan deactivated', { planId: req.params.planId });
    return res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Plan not found' });
    log('ERROR', 'products', 'Failed to deactivate plan', { error: err.message });
    return res.status(500).json({ error: 'Failed to deactivate plan.' });
  }
});

// ── Admin: delete product ───────────────────────────────────────────────────
router.delete('/:id', adminLimiter, requireAdmin, async (req, res) => {
  try {
    await productService.deleteProduct(req.params.id);
    log('INFO', 'products', 'Product deleted', { productId: req.params.id });
    return res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Product not found' });
    if (err.message.includes('active subscriptions')) return res.status(400).json({ error: err.message });
    log('ERROR', 'products', 'Failed to delete product', { error: err.message });
    return res.status(500).json({ error: 'Failed to delete product.' });
  }
});

module.exports = router;
