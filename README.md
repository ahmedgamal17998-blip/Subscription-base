# Paymob + GoHighLevel Auto-Renewal System

A Node.js backend that integrates **Paymob** (Egypt payment gateway) with **GoHighLevel** (CRM) to handle automatic subscription renewals.

Customers subscribe via a branded payment page, Paymob handles recurring billing, and every payment event is forwarded to GoHighLevel for CRM automation.

## Features

- Multi-product support with per-product pricing plans
- Paymob Unified Checkout (card + wallet payments)
- Automatic recurring billing via Paymob Subscription Module
- Webhook-driven payment processing (initial + renewal)
- GoHighLevel CRM integration (payment success, failure, cancellation events)
- Admin dashboard for managing products, plans, and subscriptions
- Admin REST API with API key authentication
- Daily cron for abandoned payment cleanup and cancellation finalization
- HMAC signature verification on all webhooks
- Rate limiting on public and admin endpoints

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js + Express |
| Database | PostgreSQL + Prisma ORM |
| Payment | Paymob API (accept.paymob.com) |
| CRM | GoHighLevel Inbound Webhook |
| Cron | node-cron (in-process) |
| Process Manager | PM2 |
| Reverse Proxy | nginx |
| CI/CD | GitHub Actions |

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL database
- Paymob account (Egypt) with API keys
- GoHighLevel account with Inbound Webhook URL

### 1. Clone and Install

```bash
git clone <repo-url>
cd paymob-ghl-autorenewal
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in all required values (see [Environment Variables](#environment-variables) below).

### 3. Set Up Database

```bash
npx prisma db push
```

### 4. Create Paymob Subscription Plans (Legacy Flow)

If using the legacy env-var-based plans (no admin product management):

```bash
node scripts/setup-plans.js
```

This creates Monthly, Yearly, and Weekly plans on Paymob and prints the plan IDs to add to your `.env`.

### 5. Run

```bash
# Development
npm run dev

# Production
npm start
```

The server starts on `http://localhost:3000` (or the configured `PORT`).

## How It Works

### Payment Flow

```
Customer visits /subscribe/:slug
    → Selects plan (monthly/yearly/etc.)
    → Fills name, email, phone
    → Backend creates Paymob Intention with subscription_plan_id
    → Customer redirected to Paymob Unified Checkout
    → Customer pays
    → Paymob sends TRANSACTION webhook → backend activates subscription
    → Paymob sends SUBSCRIPTION webhook → backend links Paymob subscription ID
    → GoHighLevel receives payment_success event
```

### Renewal Flow

```
Paymob auto-charges the customer on the billing cycle
    → Paymob sends TRANSACTION webhook
    → Backend matches subscription by order ID / email+amount
    → Updates nextRenewalDate
    → GoHighLevel receives payment_success (type: renewal) event
```

### Cancellation Flow

```
Admin calls POST /api/subscriptions/:id/cancel
    → cancelledAt = now(), status stays "active"
    → Paymob subscription suspended (if linked)
    → GoHighLevel receives subscription_cancel_requested
    → Daily cron checks: if nextRenewalDate passed → status = "cancelled"
    → GoHighLevel receives subscription_cancelled
```

## API Reference

### Public Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Subscription page (default product) |
| GET | `/subscribe/:slug` | Subscription page for a specific product |
| GET | `/admin.html` | Admin dashboard |
| GET | `/health` | Health check (`{ status: "ok" }` or `{ status: "degraded" }`) |
| GET | `/api/config/public` | Legacy plan config (env-var-based plans) |
| GET | `/api/products/slug/:slug/config` | Product plans config for subscribe page |

### Payment Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payment/create` | Create a payment intention and return checkout URL |

**POST /api/payment/create** body:

```json
{
  "name": "Mohamed Ahmed",
  "email": "customer@example.com",
  "phone": "01012345678",
  "plan": "monthly",
  "productSlug": "my-product",
  "paymentMethod": "card"
}
```

- `plan`: `"weekly"`, `"monthly"`, `"3-months"`, `"6-months"`, or `"yearly"`
- `productSlug`: (optional) if omitted, uses legacy env-var pricing
- `paymentMethod`: `"card"` (auto-renewal) or `"wallet"` (one-time)

Response:

```json
{
  "success": true,
  "checkoutUrl": "https://accept.paymob.com/unifiedcheckout/?publicKey=...&clientSecret=..."
}
```

### Webhook Endpoints (called by Paymob)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/webhook/paymob` | Transaction webhook (HMAC-verified) |
| POST | `/api/webhook/paymob-subscription` | Subscription lifecycle webhook |
| GET | `/api/webhook/paymob-redirect` | Post-payment redirect (success/failure page) |

### Admin Endpoints

All admin endpoints require the `x-admin-key` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/subscriptions/stats` | Dashboard statistics |
| GET | `/api/subscriptions` | List subscriptions (paginated) |
| GET | `/api/subscriptions/:id` | Get subscription with payment history |
| POST | `/api/subscriptions/:id/cancel` | Cancel subscription (active until period ends) |
| POST | `/api/subscriptions/:id/reactivate` | Undo pending cancellation |
| POST | `/api/subscriptions/trigger-cron` | Manually trigger daily cleanup job |

**Query parameters for GET /api/subscriptions:**

- `status` — filter by status (`active`, `pending`, `cancelled`, `expired`, `abandoned`)
- `productId` — filter by product ID
- `page` — page number (default: 1)
- `limit` — items per page (default: 20, max: 100)

### Product Management Endpoints (Admin)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/products` | List all products |
| POST | `/api/products` | Create a product with plans |
| GET | `/api/products/:id` | Get product details |
| PUT | `/api/products/:id` | Update product (name, description, active, wallet) |
| DELETE | `/api/products/:id` | Delete product (no active subscriptions) |
| POST | `/api/products/:id/plans` | Add a plan to a product |
| PUT | `/api/products/:id/plans/:planId` | Update a plan |
| DELETE | `/api/products/:id/plans/:planId` | Deactivate a plan |

**POST /api/products** body:

```json
{
  "name": "English Super Fast",
  "description": "English language course subscription",
  "walletEnabled": false,
  "plans": [
    {
      "planType": "monthly",
      "amountCents": 10000,
      "label": "Monthly",
      "intervalLabel": "/ month"
    },
    {
      "planType": "yearly",
      "amountCents": 100000,
      "label": "Yearly",
      "intervalLabel": "/ year",
      "badge": "Best Value"
    }
  ]
}
```

Valid plan types: `weekly`, `monthly`, `3-months`, `6-months`, `yearly`

### Paymob Plans (Admin)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/paymob-plans` | List all Paymob subscription plans (read-only) |

## GoHighLevel Integration

The system sends these webhook events to your GHL Inbound Webhook URL:

| Event | When | Key Fields |
|-------|------|------------|
| `payment_success` (type: initial) | First payment completed | email, full_name, phone, plan, product_name, amount, next_renewal |
| `payment_success` (type: renewal) | Auto-renewal charged | email, full_name, phone, plan, product_name, amount, next_renewal |
| `payment_failed` | Payment declined | email, full_name, phone, plan, fail_reason |
| `subscription_cancel_requested` | Cancel API called | email, full_name, phone, plan, active_until |
| `subscription_cancelled` | Billing period ended | email, full_name, phone, plan |
| `subscription_expired` | Max retries exceeded | email, full_name, phone, plan |

### GHL Workflow Setup

1. In GoHighLevel, go to **Automation** > **Create Workflow**
2. Add trigger: **Inbound Webhook**
3. Copy the webhook URL into your `.env` as `GHL_WEBHOOK_URL`
4. Create branches based on `{{event}}`:
   - `payment_success` → Add/update contact, send confirmation
   - `payment_failed` → Send retry notification
   - `subscription_cancel_requested` → Send retention email
   - `subscription_cancelled` → Remove from active list
   - `subscription_expired` → Send re-subscribe email

## Database Schema

Four tables managed by Prisma:

- **Product** — Products with name, slug, description, wallet toggle
- **ProductPlan** — Per-product pricing (plan type, amount, Paymob plan ID, labels)
- **Subscription** — Customer subscriptions (status, plan, renewal dates, Paymob IDs)
- **Payment** — Payment history (transaction ID, status, type, fail reason)

See [prisma/schema.prisma](prisma/schema.prisma) for the full schema.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PAYMOB_API_KEY` | Yes | — | Paymob API key (legacy auth) |
| `PAYMOB_SECRET_KEY` | Yes | — | Paymob secret key (Intention API) |
| `PAYMOB_PUBLIC_KEY` | Yes | — | Paymob public key (Unified Checkout) |
| `PAYMOB_HMAC_SECRET` | Yes | — | Webhook signature verification |
| `PAYMOB_INTEGRATION_ID` | Yes | — | Primary integration (3DS, for initial payments) |
| `PAYMOB_MOTO_INTEGRATION_ID` | No | Same as above | MOTO integration (for recurring charges) |
| `PAYMOB_WALLET_INTEGRATION_ID` | No | — | Mobile wallet integration |
| `GHL_WEBHOOK_URL` | Yes | — | GoHighLevel Inbound Webhook URL (must be HTTPS) |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `ADMIN_API_KEY` | Yes | — | Admin API authentication key |
| `APP_URL` | No | — | Public URL (for Paymob callbacks, HTTPS redirect) |
| `PORT` | No | 3000 | Server port |
| `NODE_ENV` | No | development | Environment (`development` or `production`) |
| `CURRENCY` | No | EGP | Default currency |
| `MONTHLY_AMOUNT_CENTS` | No | 10000 | Legacy monthly plan amount (piasters) |
| `YEARLY_AMOUNT_CENTS` | No | 100000 | Legacy yearly plan amount (piasters) |
| `WEEKLY_AMOUNT_CENTS` | No | — | Legacy weekly plan amount (piasters) |
| `PAYMOB_MONTHLY_PLAN_ID` | No | — | Paymob subscription plan ID (legacy) |
| `PAYMOB_YEARLY_PLAN_ID` | No | — | Paymob subscription plan ID (legacy) |
| `PAYMOB_WEEKLY_PLAN_ID` | No | — | Paymob subscription plan ID (legacy) |

## Paymob Dashboard Setup

### Required Configuration

1. **Integration IDs** — Create two integrations in Paymob Dashboard:
   - **Card (3DS)** — for initial customer payments (requires 3D Secure)
   - **Card (MOTO)** — for recurring charges (no 3DS, skips customer interaction)

2. **Webhook URLs** — In Paymob Dashboard > Developers:
   - **Transaction processed callback:** `https://your-domain.com/api/webhook/paymob`
   - **Transaction response callback:** `https://your-domain.com/api/webhook/paymob-redirect`

3. **API Keys** — From Paymob Dashboard > Settings:
   - API Key, Secret Key, Public Key, HMAC Secret

### Test Cards

| Card Number | Result |
|-------------|--------|
| 5123 4567 8901 2346 | Success |
| 5111 1111 1111 1118 | Declined |

Expiry: any future date. CVV: 123.

> **Note:** In test mode, token-based charges return `pending: true` (3DS required). In production, they succeed immediately.

## Deployment

### VPS Deployment (Recommended)

The project includes a full VPS setup script:

```bash
# 1. Copy setup script to your VPS
scp deploy/setup-vps.sh root@YOUR_VPS_IP:~/

# 2. SSH in and run it
ssh root@YOUR_VPS_IP
chmod +x setup-vps.sh
sudo ./setup-vps.sh
```

The script installs Node.js, PostgreSQL, nginx, PM2, fail2ban, and configures everything. It supports both IP-only (testing) and domain (production with SSL) modes.

### After Setup

```bash
# On the VPS as deploy user
su - deploy
cd /home/deploy/paymob-ghl
git clone <repo-url> .
nano .env  # fill in Paymob + GHL keys
npm install --production
npx prisma db push
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup  # run the printed command as root
```

### CI/CD

The project auto-deploys on push to `main` via GitHub Actions. Set these GitHub secrets:

- `VPS_HOST` — VPS IP or hostname
- `VPS_SSH_KEY` — SSH private key for the `deploy` user

### Data Migration (Neon → VPS)

If migrating from Neon PostgreSQL:

```bash
chmod +x deploy/migrate-data.sh
./deploy/migrate-data.sh
```

Prompts for source and destination DATABASE_URLs, exports data, and imports to VPS.

## Project Structure

```
paymob-ghl-autorenewal/
├── prisma/schema.prisma        # Database schema
├── public/                     # Frontend pages
│   ├── index.html              # Subscription page (dynamic per product)
│   ├── admin.html              # Admin dashboard
│   ├── success.html            # Post-payment success
│   └── failure.html            # Post-payment failure
├── src/
│   ├── index.js                # Express app setup + health check
│   ├── config.js               # Environment variable loading
│   ├── db.js                   # Prisma client
│   ├── routes/                 # API route handlers
│   ├── services/               # Business logic (Paymob, GHL, subscriptions, products)
│   ├── middleware/              # HMAC verification, admin auth, input validation
│   ├── jobs/                   # Cron job (daily cleanup)
│   └── utils/                  # Logger with secret redaction
├── scripts/setup-plans.js      # One-time Paymob plan setup
├── deploy/                     # VPS deployment configs
│   ├── ecosystem.config.js     # PM2 config
│   ├── nginx.conf              # Nginx template
│   ├── setup-vps.sh            # Full VPS provisioning
│   └── migrate-data.sh         # Neon → VPS data migration
└── .github/workflows/deploy.yml # CI/CD auto-deploy
```

## Security

- HMAC-SHA512 verification on all Paymob transaction webhooks
- Timing-safe comparison for admin API key and HMAC
- Helmet.js security headers (CSP, referrer policy, permissions policy)
- Rate limiting on payment creation (5/min) and admin endpoints (100/15min)
- Input validation and sanitization on all user inputs
- Secret redaction in logs (card tokens, API keys, passwords)
- HTTPS redirect in production
- CORS restricted to app domain

## License

Private project. All rights reserved.
