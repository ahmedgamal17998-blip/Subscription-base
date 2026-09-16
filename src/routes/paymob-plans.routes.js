const express = require('express');
const { requireAdmin } = require('../middleware/auth.middleware');
const paymobService = require('../services/paymob.service');
const { log } = require('../utils/logger');

const router = express.Router();

// ── List all Paymob subscription plans (read-only view) ─────────────────────
router.get('/', requireAdmin, async (req, res) => {
  try {
    return res.json(await paymobService.listSubscriptionPlans());
  } catch (err) {
    log('ERROR', 'paymob-plans', 'Failed to list plans', { error: err.message });
    return res.status(500).json({ error: 'Failed to list Paymob plans.' });
  }
});

module.exports = router;
