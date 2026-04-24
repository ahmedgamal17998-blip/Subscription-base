const cron = require('node-cron');
const subscriptionService = require('../services/subscription.service');
const ghlService = require('../services/ghl.service');
const { log } = require('../utils/logger');

async function runCleanupJob() {
  log('INFO', 'cleanup.job', 'Daily cleanup started');

  // Mark stale pending subscriptions as abandoned (older than 24h — never paid)
  try {
    const abandonedResult = await subscriptionService.markAbandonedPending();
    if (abandonedResult.count > 0) {
      log('INFO', 'cleanup.job', `Marked ${abandonedResult.count} stale pending subscriptions as abandoned`);
    }
  } catch (err) {
    log('ERROR', 'cleanup.job', 'Failed to mark abandoned subscriptions', { error: err.message });
  }

  // Process ended cancellations (cancelledAt set + nextRenewalDate passed)
  try {
    const cancelledSubs = await subscriptionService.findCancelledDue();
    for (const sub of cancelledSubs) {
      try {
        await subscriptionService.markCancelled(sub.id);
        await ghlService.notifyCancelled({
          subscriptionId: sub.id,
          email: sub.email,
          firstName: sub.firstName,
          lastName: sub.lastName,
          phone: sub.phone,
          plan: sub.plan,
          createdAt: sub.createdAt,
          productName: sub.product?.name, productId: sub.product?.id,
        });
        log('INFO', 'cleanup.job', `CANCEL #${sub.id} ${sub.email} — period ended`);
      } catch (err) {
        log('ERROR', 'cleanup.job', `CANCEL #${sub.id} failed`, { error: err.message });
      }
    }
  } catch (err) {
    log('ERROR', 'cleanup.job', 'Failed to process cancellations', { error: err.message });
  }

  log('INFO', 'cleanup.job', 'Daily cleanup complete');
}

function startCleanupCron() {
  cron.schedule('0 1 * * *', runCleanupJob, { timezone: 'UTC' });
  log('INFO', 'cleanup.job', 'Daily cleanup cron scheduled at 01:00 UTC');
}

module.exports = { startCleanupCron, runCleanupJob };
