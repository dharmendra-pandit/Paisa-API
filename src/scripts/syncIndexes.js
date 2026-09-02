'use strict';

/**
 * Builds every schema index declared in the models.
 *
 * Production runs with `autoIndex: false` (see config/db.js) because letting a
 * booting web process build indexes is a foot-gun: it blocks startup on a large
 * collection, and N replicas racing to build the same index multiplies the
 * work. The trade-off is that index creation must be an explicit deploy step —
 * this script.
 *
 * Run it after every deploy that changes a schema:
 *
 *     npm run indexes:sync
 *
 * `syncIndexes()` is deliberate rather than `createIndexes()`: it also DROPS
 * indexes that no longer exist in the schema, so the database converges on the
 * code instead of accumulating orphans from previous releases. Nothing is
 * dropped that the schema still declares.
 *
 * The unique indexes this creates carry real correctness weight — duplicate
 * account prevention (User.email), SMS replay protection
 * (Expense.sms.fingerprint), one-cap-per-month (Budget) and one-row-per-merchant
 * (Subscription). Without this step those constraints simply do not exist.
 */

const mongoose = require('mongoose');
const config = require('../config/env');
const logger = require('../utils/logger');
const { connectDB, disconnectDB } = require('../config/db');

// Side-effect import: registers every schema on the connection.
require('../models');

async function syncIndexes() {
  await connectDB();
  logger.info('Synchronising indexes', { db: mongoose.connection.name, env: config.env });

  const models = Object.values(mongoose.models);
  const results = [];

  for (const model of models) {
    const startedAt = Date.now();
    try {
      // Returns the names of indexes that were dropped, if any.
      const dropped = await model.syncIndexes();
      const indexes = await model.collection.indexes();
      results.push({
        model: model.modelName,
        indexes: indexes.length,
        dropped: dropped.length ? dropped : undefined,
        ms: Date.now() - startedAt,
      });
    } catch (err) {
      // Report every model before failing, so one bad index does not hide the
      // state of the rest.
      results.push({ model: model.modelName, error: err.message });
    }
  }

  for (const row of results) {
    if (row.error) logger.error(`  ✗ ${row.model}: ${row.error}`);
    else logger.info(`  ✓ ${row.model}: ${row.indexes} indexes in ${row.ms}ms`, row.dropped ? { dropped: row.dropped } : undefined);
  }

  const failed = results.filter((r) => r.error);
  if (failed.length) throw new Error(`${failed.length} model(s) failed to sync indexes`);

  logger.info(`Index sync complete across ${results.length} models`);
  return results;
}

if (require.main === module) {
  syncIndexes()
    .then(async () => {
      await disconnectDB();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error('Index sync failed', { message: err.message, stack: err.stack });
      await disconnectDB().catch(() => {});
      process.exit(1);
    });
}

module.exports = syncIndexes;
