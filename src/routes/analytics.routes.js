'use strict';

const express = require('express');
const controller = require('../controllers/analytics.controller');
const validate = require('../middlewares/validate.middleware');
const schemas = require('../validators/analytics.validator');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   name: Analytics
 *   description: Totals, category breakdowns and spending trends
 */

/**
 * @openapi
 * /analytics/summary:
 *   get:
 *     tags: [Analytics]
 *     summary: Monthly totals with month-over-month comparison
 *     parameters:
 *       - { in: query, name: month, schema: { type: string, example: '2026-08' }, description: Defaults to the current month }
 *     responses:
 *       200:
 *         description: Totals, savings rate, daily average and projected month-end spend
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 month: '2026-08'
 *                 totalSpent: 38420.5
 *                 totalIncome: 85000
 *                 netSavings: 41579.5
 *                 savingsRate: 48.9
 *                 dailyAverage: 1280.68
 *                 projectedMonthEnd: 39700.1
 *                 comparison: { previousMonth: '2026-07', previousSpent: 32010, changePercent: 20, direction: up }
 */
router.get('/summary', validate(schemas.summary), controller.summary);

/**
 * @openapi
 * /analytics/categories:
 *   get:
 *     tags: [Analytics]
 *     summary: Category-wise breakdown
 *     parameters:
 *       - { in: query, name: month, schema: { type: string, example: '2026-08' } }
 *       - { in: query, name: startDate, schema: { type: string, format: date } }
 *       - { in: query, name: endDate, schema: { type: string, format: date } }
 *       - { in: query, name: limit, schema: { type: integer, maximum: 20 } }
 *       - { in: query, name: includeNonSpend, schema: { type: boolean }, description: Include transfers, investments and income }
 *     responses:
 *       200: { description: Per-category totals, share of spend and averages }
 */
router.get('/categories', validate(schemas.breakdown), controller.breakdown);

/**
 * @openapi
 * /analytics/trends:
 *   get:
 *     tags: [Analytics]
 *     summary: Daily, weekly or monthly spending trend
 *     description: Daily series are zero-filled so a chart has no gaps.
 *     parameters:
 *       - { in: query, name: granularity, schema: { type: string, enum: [day, week, month], default: day } }
 *       - { in: query, name: month, schema: { type: string, example: '2026-08' } }
 *       - { in: query, name: startDate, schema: { type: string, format: date } }
 *       - { in: query, name: endDate, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: Time series with peak, average and direction }
 */
router.get('/trends', validate(schemas.trends), controller.trends);

/**
 * @openapi
 * /analytics/weekday:
 *   get:
 *     tags: [Analytics]
 *     summary: Spend by day of week, with a weekend/weekday split
 *     parameters:
 *       - { in: query, name: month, schema: { type: string, example: '2026-08' } }
 *       - { in: query, name: startDate, schema: { type: string, format: date } }
 *       - { in: query, name: endDate, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: Per-day totals and weekend versus weekday averages }
 */
router.get('/weekday', validate(schemas.weekday), controller.weekday);

/**
 * @openapi
 * /analytics/merchants:
 *   get:
 *     tags: [Analytics]
 *     summary: Top merchants by spend
 *     parameters:
 *       - { in: query, name: limit, schema: { type: integer, default: 10, maximum: 50 } }
 *       - { in: query, name: month, schema: { type: string, example: '2026-08' } }
 *     responses:
 *       200: { description: Ranked merchants }
 */
router.get('/merchants', validate(schemas.merchants), controller.merchants);

/**
 * @openapi
 * /analytics/dashboard:
 *   get:
 *     tags: [Analytics]
 *     summary: Everything a home screen needs, in one request
 *     responses:
 *       200: { description: Summary, categories, daily trend, top merchants and recent transactions }
 */
router.get('/dashboard', controller.dashboard);

module.exports = router;
