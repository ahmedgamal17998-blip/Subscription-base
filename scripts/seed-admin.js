/**
 * Run once after migration to create the first admin user.
 * Usage:
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=YourPass123 node scripts/seed-admin.js
 *
 * Or it reads ADMIN_EMAIL + ADMIN_PASSWORD from .env if set.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || 'Admin';

  if (!email || !password) {
    console.error('❌  Set ADMIN_EMAIL and ADMIN_PASSWORD env vars before running this script.');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('❌  ADMIN_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    console.log(`⚠️  Admin user already exists: ${existing.email}`);
    process.exit(0);
  }

  const hashed = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { email: email.toLowerCase().trim(), name, password: hashed, role: 'admin' },
  });

  console.log(`✅  Admin user created: ${user.email} (role: ${user.role})`);

  // Also seed GHL webhook from env if set
  const ghlUrl = process.env.GHL_WEBHOOK_URL;
  if (ghlUrl) {
    const existing = await prisma.outboundWebhook.findFirst({ where: { url: ghlUrl } });
    if (!existing) {
      await prisma.outboundWebhook.create({
        data: {
          name: 'GoHighLevel',
          url: ghlUrl,
          events: 'payment_success,payment_failed,renewal_success,renewal_failed,cancelled,cancel_requested,expired',
          isActive: true,
        },
      });
      console.log(`✅  GHL webhook seeded: ${ghlUrl}`);
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
