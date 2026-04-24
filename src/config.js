require('dotenv').config();

const REQUIRED_VARS = [
  'PAYMOB_API_KEY',
  'PAYMOB_HMAC_SECRET',
  'PAYMOB_SECRET_KEY',
  'PAYMOB_PUBLIC_KEY',
  'PAYMOB_INTEGRATION_ID',
  'DATABASE_URL',
  'JWT_SECRET',
];

for (const varName of REQUIRED_VARS) {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}`);
  }
}

// GHL_WEBHOOK_URL is now optional — webhooks are managed in the DB.
// If provided, it will be seeded as the first webhook on startup.
if (process.env.GHL_WEBHOOK_URL && !process.env.GHL_WEBHOOK_URL.startsWith('https://')) {
  throw new Error('GHL_WEBHOOK_URL must use HTTPS');
}

module.exports = {
  PAYMOB_API_KEY: process.env.PAYMOB_API_KEY,
  PAYMOB_HMAC_SECRET: process.env.PAYMOB_HMAC_SECRET,
  PAYMOB_SECRET_KEY: process.env.PAYMOB_SECRET_KEY,
  PAYMOB_PUBLIC_KEY: process.env.PAYMOB_PUBLIC_KEY,
  PAYMOB_INTEGRATION_ID: process.env.PAYMOB_INTEGRATION_ID,
  PAYMOB_MOTO_INTEGRATION_ID: process.env.PAYMOB_MOTO_INTEGRATION_ID || process.env.PAYMOB_INTEGRATION_ID,
  GHL_WEBHOOK_URL: process.env.GHL_WEBHOOK_URL || null, // optional — kept for seed script
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_API_KEY: process.env.ADMIN_API_KEY || null, // kept for backward compat / seed
  PORT: parseInt(process.env.PORT) || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  CURRENCY: process.env.CURRENCY || 'EGP',
  WEEKLY_AMOUNT_CENTS: parseInt(process.env.WEEKLY_AMOUNT_CENTS) || null,
  MONTHLY_AMOUNT_CENTS: parseInt(process.env.MONTHLY_AMOUNT_CENTS) || 10000,
  YEARLY_AMOUNT_CENTS: parseInt(process.env.YEARLY_AMOUNT_CENTS) || 100000,
  PAYMOB_MONTHLY_PLAN_ID: parseInt(process.env.PAYMOB_MONTHLY_PLAN_ID) || null,
  PAYMOB_YEARLY_PLAN_ID: parseInt(process.env.PAYMOB_YEARLY_PLAN_ID) || null,
  PAYMOB_WEEKLY_PLAN_ID: parseInt(process.env.PAYMOB_WEEKLY_PLAN_ID) || null,
  PAYMOB_WALLET_INTEGRATION_ID: process.env.PAYMOB_WALLET_INTEGRATION_ID || null,
  APP_URL: process.env.APP_URL || null,
  // CORS origins allowed for embedded checkout (comma-separated)
  EMBED_ORIGINS: process.env.EMBED_ORIGINS || '*',
};
