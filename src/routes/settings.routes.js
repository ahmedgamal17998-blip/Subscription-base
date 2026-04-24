/**
 * Product Settings routes
 * GET/PUT /api/products/:id/settings
 * GET     /api/products/:id/embed  — returns iframe snippet
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth.middleware');
const { log } = require('../utils/logger');
const config = require('../config');

const router = express.Router({ mergeParams: true });

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100 });

// ── GET /api/products/:id/settings ───────────────────────────────────────────
router.get('/', limiter, requireAdmin, async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    let settings = await prisma.productSettings.findUnique({ where: { productId } });
    if (!settings) {
      // Auto-create default settings if missing
      settings = await prisma.productSettings.create({ data: { productId } });
    }
    return res.json(settings);
  } catch (err) {
    log('ERROR', 'settings', 'Failed to get settings', { error: err.message });
    return res.status(500).json({ error: 'Failed to get product settings.' });
  }
});

// ── PUT /api/products/:id/settings ───────────────────────────────────────────
router.put('/', limiter, requireAdmin, async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const {
      successUrl, failureUrl,
      headCode,
      logoUrl, primaryColor, accentColor, ctaText, checkoutTitle,
      couponsEnabled, embedEnabled,
    } = req.body;

    // Validate URLs if provided
    const urlFields = { successUrl, failureUrl };
    for (const [field, val] of Object.entries(urlFields)) {
      if (val && !val.startsWith('http')) {
        return res.status(400).json({ error: `${field} must be a valid URL starting with http/https.` });
      }
    }

    const data = {};
    if (successUrl !== undefined) data.successUrl = successUrl || null;
    if (failureUrl !== undefined) data.failureUrl = failureUrl || null;
    if (headCode !== undefined) data.headCode = headCode || null;
    if (logoUrl !== undefined) data.logoUrl = logoUrl || null;
    if (primaryColor !== undefined) data.primaryColor = primaryColor || '#6366f1';
    if (accentColor !== undefined) data.accentColor = accentColor || '#7c3aed';
    if (ctaText !== undefined) data.ctaText = ctaText || null;
    if (checkoutTitle !== undefined) data.checkoutTitle = checkoutTitle || null;
    if (typeof couponsEnabled === 'boolean') data.couponsEnabled = couponsEnabled;
    if (typeof embedEnabled === 'boolean') data.embedEnabled = embedEnabled;

    const settings = await prisma.productSettings.upsert({
      where: { productId },
      update: data,
      create: { productId, ...data },
    });

    log('INFO', 'settings', 'Product settings updated', { productId });
    return res.json(settings);
  } catch (err) {
    log('ERROR', 'settings', 'Failed to update settings', { error: err.message });
    return res.status(500).json({ error: 'Failed to update product settings.' });
  }
});

// ── GET /api/products/:id/embed ───────────────────────────────────────────────
router.get('/embed', limiter, requireAdmin, async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const baseUrl = config.APP_URL || 'https://your-domain.com';
    const checkoutUrl = `${baseUrl}/subscribe/${product.slug}`;

    const iframeSnippet = `<!-- ${product.name} — Checkout Embed -->
<iframe
  src="${checkoutUrl}"
  width="100%"
  height="720"
  frameborder="0"
  style="border:none;border-radius:16px;max-width:700px;display:block;margin:0 auto;"
  title="${product.name} Checkout"
  loading="lazy"
  allow="payment"
></iframe>`;

    const jsSnippet = `<!-- ${product.name} — Auto-resize Checkout Embed -->
<div id="checkout-${product.slug}"></div>
<script>
(function(){
  var iframe = document.createElement('iframe');
  iframe.src = '${checkoutUrl}';
  iframe.style.cssText = 'width:100%;border:none;border-radius:16px;max-width:700px;display:block;margin:0 auto;';
  iframe.height = 720;
  iframe.setAttribute('frameborder','0');
  iframe.setAttribute('allow','payment');
  iframe.title = '${product.name} Checkout';
  document.getElementById('checkout-${product.slug}').appendChild(iframe);
  window.addEventListener('message', function(e){
    if(e.data && e.data.type === 'checkout-height'){
      iframe.height = e.data.height + 40;
    }
  });
})();
</script>`;

    return res.json({
      productName: product.name,
      slug: product.slug,
      checkoutUrl,
      iframeSnippet,
      jsSnippet,
    });
  } catch (err) {
    log('ERROR', 'settings', 'Failed to get embed code', { error: err.message });
    return res.status(500).json({ error: 'Failed to get embed code.' });
  }
});

module.exports = router;
