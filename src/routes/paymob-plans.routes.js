const express = require('express');
const { requireAdmin } = require('../middleware/admin.middleware');
const paymobService = require('../services/paymob.service');
const { log } = require('../utils/logger');

const router = express.Router();

// ── List all Paymob subscription plans (read-only view) ─────────────────────
router.get('/', requireAdmin, async (req, res) => {
  try {
    const authToken = await paymobService.authenticate();
    const axios = require('axios');
    const result = await axios.get('https://accept.paymob.com/api/acceptance/subscription-plans', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const plans = result.data.results || result.data || [];
    return res.json(plans);
  } catch (err) {
    log('ERROR', 'paymob-plans', 'Failed to list plans', { error: err.message });
    return res.status(500).json({ error: 'Failed to list Paymob plans.' });
  }
});

module.exports = router;
