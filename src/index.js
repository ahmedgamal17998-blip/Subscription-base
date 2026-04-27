const config = require('./config');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const paymentRoutes = require('./routes/payment.routes');
const webhookRoutes = require('./routes/webhook.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const productRoutes = require('./routes/product.routes');
const paymobPlansRoutes = require('./routes/paymob-plans.routes');
const authRoutes = require('./routes/auth.routes');
const settingsRoutes = require('./routes/settings.routes');
const outboundWebhookRoutes = require('./routes/outbound-webhook.routes');
const couponRoutes = require('./routes/coupon.routes');
const analyticsRoutes = require('./routes/analytics.routes');

const { startCleanupCron } = require('./jobs/renewal.job');
const { log } = require('./utils/logger');
const prisma = require('./db');

const app = express();

app.set('trust proxy', 1);

// ── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  frameguard: false, // disable X-Frame-Options so our custom header takes effect
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      frameSrc: ["https://accept.paymob.com", "*"],
      frameAncestors: ["*"], // allow this page to be embedded in iframes from any domain
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
  permissionsPolicy: {
    features: { camera: [], microphone: [], geolocation: [] },
  },
}));

// ── CORS — allow embed from configured origins ───────────────────────────────
const embedOrigins = config.EMBED_ORIGINS === '*' ? '*' : config.EMBED_ORIGINS.split(',').map(o => o.trim());
app.use(cors({
  origin: embedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key'],
}));

// Allow checkout pages to be embedded in iframes from any domain
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  next();
});

// ── HTTPS redirect in production ─────────────────────────────────────────────
if (config.NODE_ENV === 'production' && config.APP_URL?.startsWith('https')) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/products', productRoutes);
app.use('/api/products/:id/settings', settingsRoutes);
app.use('/api/paymob-plans', paymobPlansRoutes);
app.use('/api/webhooks', outboundWebhookRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/analytics', analyticsRoutes);

// ── SPA & Static routes ──────────────────────────────────────────────────────
app.get('/subscribe/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', version: '2.0.0' });
  } catch {
    res.status(503).json({ status: 'degraded' });
  }
});

// Legacy public config (kept for backward compatibility)
app.get('/api/config/public', (req, res) => {
  const plans = {};
  if (config.PAYMOB_WEEKLY_PLAN_ID && config.WEEKLY_AMOUNT_CENTS) {
    plans.weekly = { amountCents: config.WEEKLY_AMOUNT_CENTS, currency: config.CURRENCY, label: 'Weekly', interval: '/ week' };
  }
  plans.monthly = { amountCents: config.MONTHLY_AMOUNT_CENTS, currency: config.CURRENCY, label: 'Monthly', interval: '/ month' };
  plans.yearly = { amountCents: config.YEARLY_AMOUNT_CENTS, currency: config.CURRENCY, label: 'Yearly', interval: '/ year', badge: 'Best Value' };
  res.json({ plans, currency: config.CURRENCY });
});

if (config.NODE_ENV !== 'production') {
  log('WARN', 'server', `Running in ${config.NODE_ENV} mode — set NODE_ENV=production on VPS`);
}

process.on('uncaughtException', (err) => {
  log('ERROR', 'process', 'Uncaught exception', { error: err.message });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', 'process', 'Unhandled rejection', { error: String(reason) });
  process.exit(1);
});

const server = app.listen(config.PORT, () => {
  log('INFO', 'server', `Server v2.0 started on port ${config.PORT} (${config.NODE_ENV})`);
  startCleanupCron();
});

function gracefulShutdown(signal) {
  log('INFO', 'server', `${signal} received — shutting down gracefully`);
  server.close(async () => {
    await prisma.$disconnect();
    log('INFO', 'server', 'Server closed');
    process.exit(0);
  });
  setTimeout(() => {
    log('WARN', 'server', 'Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
