'use strict';

/**
 * Test bootstrap.
 *
 * Every suite runs against a throwaway in-memory MongoDB, so tests need no
 * local database, never touch developer data, and stay isolated from each
 * other. Environment defaults are assigned before any application module is
 * required, because config/env validates and freezes at import time.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test_access_secret_value_at_least_32_chars';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_refresh_secret_value_at_least_32_chars';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/paisa';
process.env.LOG_LEVEL = 'error';
process.env.SWAGGER_ENABLED = 'false';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { dbName: 'paisa_test' });
  // Indexes carry real behaviour here (unique email, SMS de-duplication), so
  // they must exist before the first assertion rather than lazily.
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
