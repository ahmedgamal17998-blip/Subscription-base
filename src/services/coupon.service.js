const prisma = require('../db');

/**
 * Check a coupon code against a product and amount.
 * Returns { ok: true, coupon, discountCents } or { ok: false, status, error }.
 */
async function evaluateCoupon(code, productId, amountCents) {
  if (!code) return { ok: false, status: 400, error: 'Coupon code is required.' };

  const coupon = await prisma.coupon.findUnique({ where: { code: String(code).trim().toUpperCase() } });
  if (!coupon || !coupon.isActive) {
    return { ok: false, status: 404, error: 'Invalid or inactive coupon code.' };
  }
  if (coupon.productId && productId && coupon.productId !== parseInt(productId)) {
    return { ok: false, status: 400, error: 'This coupon is not valid for this product.' };
  }
  if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
    return { ok: false, status: 400, error: 'This coupon has expired.' };
  }
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
    return { ok: false, status: 400, error: 'This coupon has reached its usage limit.' };
  }

  const discountCents = coupon.discountType === 'percentage'
    ? Math.round((amountCents * coupon.discountValue) / 100)
    : Math.round(coupon.discountValue);

  return { ok: true, coupon, discountCents: Math.min(discountCents, amountCents) };
}

// Paymob rejects amounts below 1 EGP.
function finalAmountAfterDiscount(amountCents, discountCents) {
  return Math.max(100, amountCents - discountCents);
}

// Count a use only once the payment actually succeeded.
async function recordUse(code) {
  if (!code) return;
  await prisma.coupon.updateMany({ where: { code }, data: { usedCount: { increment: 1 } } });
}

module.exports = { evaluateCoupon, finalAmountAfterDiscount, recordUse };
