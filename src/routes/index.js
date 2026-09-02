'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { authenticate } = require('../middlewares/auth.middleware');
const { success } = require('../utils/apiResponse');
const { CATEGORY_LIST, CATEGORY_LABELS, PAYMENT_METHODS, TRANSACTION_TYPE_LIST } = require('../constants/categories');

const authRoutes = require('./auth.routes');
const expenseRoutes = require('./expense.routes');
const budgetRoutes = require('./budget.routes');
const analyticsRoutes = require('./analytics.routes');
const insightRoutes = require('./insight.routes');
const smsRoutes = require('./sms.routes');
const subscriptionRoutes = require('./subscription.routes');
const groupRoutes = require('./group.routes');

const router = express.Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [System]
 *     summary: Liveness and database readiness probe
 *     security: []
 *     responses:
 *       200: { description: Service is healthy }
 *       503: { description: Database is not connected }
 */
router.get('/health', (_req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const dbState = states[mongoose.connection.readyState] || 'unknown';
  const healthy = mongoose.connection.readyState === 1;

  return res.status(healthy ? 200 : 503).json({
    success: healthy,
    message: healthy ? 'OK' : 'Database unavailable',
    data: {
      status: healthy ? 'healthy' : 'degraded',
      database: dbState,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  });
});

/**
 * @openapi
 * /meta:
 *   get:
 *     tags: [System]
 *     summary: Enumerations clients need to render forms
 *     security: []
 *     responses:
 *       200: { description: Categories, payment methods and transaction types }
 */
router.get('/meta', (_req, res) =>
  success(res, {
    data: {
      categories: CATEGORY_LIST.map((value) => ({ value, label: CATEGORY_LABELS[value] })),
      paymentMethods: PAYMENT_METHODS,
      transactionTypes: TRANSACTION_TYPE_LIST,
    },
  })
);

// Public.
router.use('/auth', authRoutes);

// Everything below requires a valid access token.
router.use('/expenses', authenticate, expenseRoutes);
router.use('/budgets', authenticate, budgetRoutes);
router.use('/analytics', authenticate, analyticsRoutes);
router.use('/insights', authenticate, insightRoutes);
router.use('/sms', authenticate, smsRoutes);
router.use('/subscriptions', authenticate, subscriptionRoutes);
router.use('/groups', authenticate, groupRoutes);

module.exports = router;
