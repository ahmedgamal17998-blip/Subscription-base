const { PrismaClient } = require('@prisma/client');

// Prisma's default pool is (CPU cores * 2 + 1) = 3 connections on a 1-core server, with a 10s
// wait before failing. A traffic spike queues behind those 3, so give it more room unless the
// DATABASE_URL already says otherwise.
function withPoolDefaults(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', '10');
    if (!u.searchParams.has('pool_timeout')) u.searchParams.set('pool_timeout', '20');
    return u.toString();
  } catch {
    return url;
  }
}

const prisma = new PrismaClient({
  datasources: { db: { url: withPoolDefaults(process.env.DATABASE_URL) } },
});

module.exports = prisma;
