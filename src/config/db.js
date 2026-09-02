'use strict';

const mongoose = require('mongoose');
const config = require('./env');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);
if (!config.isProd) mongoose.set('debug', config.logLevel === 'debug');

let connectionPromise = null;

async function connectDB(uri = config.mongoUri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connectionPromise) return connectionPromise;

  connectionPromise = mongoose
    .connect(uri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 20,
      minPoolSize: 2,
      autoIndex: !config.isProd, // in prod, build indexes via a migration/ops step
    })
    .then((m) => {
      logger.info('MongoDB connected', { host: m.connection.host, db: m.connection.name });
      return m.connection;
    })
    .catch((err) => {
      connectionPromise = null;
      throw err;
    });

  return connectionPromise;
}

async function disconnectDB() {
  connectionPromise = null;
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    logger.info('MongoDB disconnected');
  }
}

mongoose.connection.on('error', (err) => logger.error('MongoDB connection error', { message: err.message }));
mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

module.exports = { connectDB, disconnectDB, mongoose };
