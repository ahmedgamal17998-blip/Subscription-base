# CLAUDE.md — Paymob + GoHighLevel Auto-Renewal System

## Project Overview

A Node.js backend that integrates Paymob (Egypt payment gateway) with GoHighLevel (CRM) to handle automatic subscription renewals via Paymob's Subscription Module.

## What This System Does

1. Admin creates Products with pricing plans via admin panel or API
2. Customer visits `/subscribe/:slug` → picks a plan → pays via Paymob Unified Checkout
3. Paymob handles recurring billing automatically via Subscription Plans
4. Every payment event (success, fail, cancel) is forwarded to GoHighLevel via webhook
5. Daily cron cleans up abandoned pending subscriptions and finalizes ended cancellations

## Tech Stack

- **Runtime:** Node.js + Express
- **Database:** PostgreSQL + Prisma ORM
- **Cron:** node-cron (in-process, daily at 01:00 UTC)
- **Payment:** Paymob Intention API + Subscription Module (accept.paymob.com)
- **CRM:** GoHighLevel Inbound Webhook
- **Hosting:** VPS with PM2 + nginx (deployed via GitHub Actions)

## Project Structure

```text
paymob-ghl-autorenewal/
├── prisma/
│   └── schema.prisma           # Product, ProductPlan, Subscription, Payment
├── public/
│   ├── index.html              # Subscription page (dynamic per product slug)
│   ├── admin.html              # Admin dashboard (product & subscription management)
│   ├── success.html            # Post-payment success
│   └── failure.html            # Post-payment failure
├── src/
│   ├── index.js                # Entry point, Express setup, routes, health check
│   ├── config.js               # Env var loading + validation
│   ├── db.js                   # Prisma client singleton
│   ├── routes/
│   │   ├── payment.routes.js   # POST /api/payment/create
│   │   ├── webhook.routes.js   # POST /api/webhook/paymob (transaction)
│   │   │                       # POST /api/webhook/paymob-subscription (sub lifecycle)
│   │   │                       # GET  /api/webhook/paymob-redirect
│   │   ├── subscription.routes.js  # Admin: list, get, cancel, reactivate, trigger-cron
│   │   ├── product.routes.js       # Admin CRUD + public /slug/:slug/config
│   │   └── paymob-plans.routes.js  # Admin: list Paymob subscription plans
│   ├── services/
│   │   ├── paymob.service.js   # Paymob API (auth, intention, checkout URL, subscriptions)
│   │   ├── ghl.service.js      # Send events to GHL webhook
│   │   ├── subscription.service.js # Subscription DB operations
│   │   └── product.service.js  # Product/plan DB operations + Paymob plan creation
│   ├── middleware/
│   │   ├── hmac.middleware.js   # Verify Paymob HMAC (transaction webhooks)
│   │   ├── admin.middleware.js  # x-admin-key header check (timing-safe)
│   │   └── validate.middleware.js  # Payment input validation + phone normalization
│   ├── jobs/
│   │   └── renewal.job.js      # Daily cron: mark abandoned, finalize cancellations
│   └── utils/
│       └── logger.js           # Structured logging with secret redaction
├── scripts/
│   └── setup-plans.js          # One-time: create Paymob subscription plans (legacy)
├── deploy/
│   ├── ecosystem.config.js     # PM2 config
│   ├── nginx.conf              # Nginx reverse proxy template
│   ├── setup-vps.sh            # VPS provisioning script
│   └── migrate-data.sh         # Data migration helper
├── .github/workflows/
│   └── deploy.yml              # Auto-deploy on push to main
├── .env.example
├── .gitignore
├── package.json
└── CLAUDE.md                   # This file
```

## Key Architecture Decisions

### Paymob Subscription Module for Recurring Billing

Paymob handles recurring charges natively. The app creates Subscription Plans on Paymob, and the first payment links the customer to a Paymob subscription. Renewals are triggered by Paymob, not by our cron.

### Multi-Product Support

Products are created via admin API/panel. Each product has its own slug, plans, and pricing. The subscription page loads dynamically based on the product slug.

### Two Webhook Endpoints

- `/api/webhook/paymob` — Transaction events (HMAC-verified). Handles initial + renewal payments.
- `/api/webhook/paymob-subscription` — Subscription lifecycle events (created, suspended, resumed).

### Subscription Matching for Renewals

Paymob creates new order IDs for renewal transactions. The webhook handler falls back through: order ID → email+amount → email-only to find the correct local subscription.

### Cancellation = End of Billing Period

When cancelled, `cancelledAt = now()` is set but status stays "active". The daily cron finalizes cancellations when `nextRenewalDate` passes.

### Idempotency

Before processing any webhook, we check if `transactionId` already exists in the Payment table via upsert.

### Admin API Security

Admin routes require `x-admin-key` header, verified with timing-safe comparison.

## Paymob API Flow

### Payment Creation (Intention API)

1. `POST /v1/intention/` with secret key, amount, payment_methods, subscription_plan_id, billing_data
2. Returns `client_secret` + `intention_order_id`
3. Redirect customer to Unified Checkout URL with public key + client secret

### Webhook HMAC Verification (Transaction Events)

Concatenate these fields IN ORDER, then HMAC-SHA512 with HMAC secret:

```text
amount_cents, created_at, currency, error_occured, has_parent_transaction,
id, integration_id, is_3d_secure, is_auth, is_capture, is_refunded,
is_standalone_payment, is_voided, order.id, owner, pending,
source_data.pan, source_data.sub_type, source_data.type, success
```

### Subscription Webhook HMAC

SHA-512 of `"{trigger_type}for{subscription_data.id}"` using HMAC secret.

## Database Schema (Prisma)

### Product

- id, name, slug (unique), description, isActive, walletEnabled
- Has many ProductPlans and Subscriptions

### ProductPlan

- id, productId (FK), planType, amountCents, currency
- paymobSubscriptionPlanId (linked to Paymob), label, intervalLabel, badge, isActive
- Unique constraint: (productId, planType)

### Subscription

- id, email, firstName, lastName, phone, plan
- status: "pending" | "active" | "expired" | "cancelled" | "abandoned"
- amountCents, currency, nextRenewalDate, cancelledAt
- lastPaymobOrder, lastTransactionId, paymobSubscriptionId, paymobPlanId
- paymentMethod ("card" | "wallet"), productId (FK)

### Payment

- id, subscriptionId (FK), paymobOrderId, transactionId (unique)
- amountCents, status, type ("initial" | "renewal"), failReason

## GHL Webhook Events

- `payment_success` (type: initial/renewal) — with product_name, email, plan, amount, next_renewal
- `payment_failed` — with fail_reason
- `subscription_expired` — after failed retries
- `subscription_cancel_requested` — still active until period ends
- `subscription_cancelled` — period ended, fully cancelled

## Environment Variables

See `.env.example` for the full list. Key variables:

- `PAYMOB_API_KEY`, `PAYMOB_SECRET_KEY`, `PAYMOB_PUBLIC_KEY` — Paymob credentials
- `PAYMOB_HMAC_SECRET` — Webhook signature verification
- `PAYMOB_INTEGRATION_ID` — Primary (3DS) integration
- `PAYMOB_MOTO_INTEGRATION_ID` — MOTO integration for recurring charges (falls back to primary)
- `GHL_WEBHOOK_URL` — GoHighLevel inbound webhook (must be HTTPS)
- `DATABASE_URL` — PostgreSQL connection string
- `ADMIN_API_KEY` — Admin API authentication
- `APP_URL` — Public URL (for webhook callbacks and HTTPS redirect)

## Important Rules

- NEVER expose API keys in frontend code
- ALWAYS verify HMAC before processing transaction webhooks
- ALWAYS check idempotency before processing a payment
- ALWAYS check for duplicate active subscriptions before creating new ones
- NEVER log card tokens or API keys (logger auto-redacts sensitive keys)
- Return 200 to Paymob webhooks even on errors (to prevent infinite retries)
- Two integration IDs needed: 3DS (initial) + MOTO (recurring)

## Testing

- Paymob test card (success): 5123456789012346, any future expiry, CVV: 123
- Paymob test card (declined): 5111111111111118
- In test mode, token charges return `pending: true` (3DS required). In production, they succeed immediately.
