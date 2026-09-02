'use strict';

const config = require('./config/env');
const logger = require('./utils/logger');
const { connectDB, disconnectDB } = require('./config/db');
const createApp = require('./app');

/**
 * Process bootstrap: connect the database first, then start listening, so the
 * service never accepts traffic it cannot serve. Shutdown drains in-flight
 * requests before closing the database.
 */
async function start() {
  await connectDB();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info('Paisa API started', {
      port: config.port,
      env: config.env,
      docs: `http://localhost:${config.port}/docs`,
      api: `http://localhost:${config.port}${config.apiPrefix}`,
    });
  });

  server.headersTimeout = 65000;
  server.keepAliveTimeout = 60000;

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down gracefully`);

    // Force-exit if a connection refuses to drain, so an orchestrator's
    // SIGKILL is never what actually stops us.
    const failsafe = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 15000).unref();

    server.close(async (err) => {
      if (err) logger.error('Error while closing HTTP server', { message: err.message });
      try {
        await disconnectDB();
      } catch (dbErr) {
        logger.error('Error while closing database connection', { message: dbErr.message });
      }
      clearTimeout(failsafe);
      process.exit(err ? 1 : 0);
    });
  }

  ['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, () => shutdown(signal)));

  // An unhandled rejection leaves the process in an unknown state; log loudly
  // and let the orchestrator restart a clean one.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: reason instanceof Error ? reason.stack : String(reason) });
    shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { message: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });

  return server;
}

if (require.main === module) {
  start().catch((err) => {
    logger.error('Failed to start server', { message: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = start;
