// Single source of truth for plan durations (days).
const PLAN_DAYS = { weekly: 7, monthly: 30, '3-months': 90, '6-months': 180, yearly: 365 };

const PLAN_TYPES = Object.keys(PLAN_DAYS);

function planDays(plan) {
  return PLAN_DAYS[plan] ?? 30;
}

// Midnight UTC, `days` days from `from` (default: now).
function midnightUTCAfter(days, from = new Date()) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// YYYY-MM-DD, the format Paymob expects for subscription_start_date.
function toPaymobDate(date) {
  return date.toISOString().slice(0, 10);
}

module.exports = { PLAN_DAYS, PLAN_TYPES, planDays, midnightUTCAfter, toPaymobDate };
