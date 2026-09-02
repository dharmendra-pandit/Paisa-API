'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');

const config = require('./config/env');
const logger = require('./utils/logger');
const requestId = require('./middlewares/requestId.middleware');
const { apiLimiter } = require('./middlewares/rateLimit.middleware');
const { notFoundHandler, errorHandler } = require('./middlewares/error.middleware');
const { mountSwagger } = require('./docs/swagger');
const routes = require('./routes');

/**
 * Builds the Express application.
 *
 * Exported without starting a listener so tests can drive it with supertest
 * against an in-memory MongoDB, and so the process bootstrap (signals, DB
 * connection) stays in server.js.
 */
function createApp() {
  const app = express();

  // Behind a load balancer, req.ip must reflect X-Forwarded-For or every
  // rate-limit bucket collapses onto the proxy's address.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(
    helmet({
      // Swagger UI loads inline styles/scripts; CSP is relaxed only for it.
      contentSecurityPolicy: config.isProd ? undefined : false,
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy'],
    })
  );

  // auth.middleware falls back to an accessToken cookie for browser clients;
  // without this parser req.cookies is undefined and that path silently dies.
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(compression());

  // Strips $-prefixed and dotted keys so a crafted body cannot become a query
  // operator; hpp collapses duplicated query params into a predictable shape.
  app.use(mongoSanitize({ replaceWith: '_' }));
  app.use(hpp({ whitelist: ['category', 'tags'] }));

  if (!config.isTest) {
    app.use(
      morgan(config.isProd ? 'combined' : 'dev', {
        stream: logger.stream,
        skip: (req) => req.path === '/health' || req.path === `${config.apiPrefix}/health`,
      })
    );
  }

  mountSwagger(app, '/docs');

  app.use(config.apiPrefix, apiLimiter, routes);

  // Root: a signpost, so a bare GET / is not a confusing 404.
  app.get('/', (_req, res) =>
    res.json({
      success: true,
      message: 'Paisa API',
      data: {
        version: '1.0.0',
        environment: config.env,
        documentation: '/docs',
        openapi: '/docs.json',
        health: `${config.apiPrefix}/health`,
      },
    })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
module.exports.createApp = createApp;
