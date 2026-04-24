const crypto = require('crypto');
const config = require('../config');
const { log } = require('../utils/logger');

function verifyHmac(req, res, next) {
  if (!req.body?.obj) {
    log('WARN', 'hmac', 'Webhook obj missing — skipping');
    return res.status(200).json({ message: 'ok' });
  }

  // TOKEN events have different HMAC fields — log and acknowledge without processing
  if (req.body.type === 'TOKEN') {
    log('INFO', 'hmac', 'TOKEN event received — acknowledged', { token: '***' });
    return res.status(200).json({ message: 'ok' });
  }

  const { obj } = req.body;
  const receivedHmac = req.query.hmac || req.body.hmac;

  const fields = [
    obj.amount_cents,
    obj.created_at,
    obj.currency,
    obj.error_occured,
    obj.has_parent_transaction,
    obj.id,
    obj.integration_id,
    obj.is_3d_secure,
    obj.is_auth,
    obj.is_capture,
    obj.is_refunded,
    obj.is_standalone_payment,
    obj.is_voided,
    obj.order?.id,
    obj.owner,
    obj.pending,
    obj.source_data?.pan,
    obj.source_data?.sub_type,
    obj.source_data?.type,
    obj.success,
  ];

  const concatenated = fields.map((v) => String(v ?? '')).join('');
  const computed = crypto
    .createHmac('sha512', config.PAYMOB_HMAC_SECRET)
    .update(concatenated)
    .digest('hex');

  const computedBuf = Buffer.from(computed, 'hex');
  const receivedBuf = Buffer.from(receivedHmac || '', 'hex');
  if (computedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(computedBuf, receivedBuf)) {
    log('WARN', 'hmac', 'Invalid HMAC signature', { transactionId: obj.id, orderId: obj.order?.id });
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  log('INFO', 'hmac', 'HMAC verified', { transactionId: obj.id, orderId: obj.order?.id });
  next();
}

module.exports = { verifyHmac };
