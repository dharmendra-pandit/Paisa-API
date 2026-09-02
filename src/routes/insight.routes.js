'use strict';

const express = require('express');
const controller = require('../controllers/insight.controller');
const validate = require('../middlewares/validate.middleware');
const schemas = require('../validators/insight.validator');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   name: Insights
 *   description: Natural-language findings derived from spending patterns
 */

/**
 * @openapi
 * /insights:
 *   get:
 *     tags: [Insights]
 *     summary: Generate spending insights
 *     description: >
 *       Runs every insight generator over the month and returns them ranked by
 *       priority. Each insight carries the metrics it was derived from, so the
 *       claim can be checked rather than trusted. Generators that lack a
 *       sufficient sample stay silent.
 *     parameters:
 *       - { in: query, name: month, schema: { type: string, example: '2026-08' } }
 *       - { in: query, name: limit, schema: { type: integer, default: 10, maximum: 25 } }
 *       - { in: query, name: types, schema: { type: string, example: 'weekend_pattern,spending_trend' }, description: Comma-separated filter }
 *     responses:
 *       200:
 *         description: Ranked insights
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: 4 insights generated
 *               data:
 *                 month: '2026-08'
 *                 insights:
 *                   - id: spending_trend_1
 *                     type: spending_trend
 *                     severity: warning
 *                     title: Spending increased by 20% this month
 *                     message: Your spending increased by 20% this month — ₹38,421 versus ₹32,010 in 2026-07.
 *                     metrics: { current: 38420.5, previous: 32010, changePercent: 20 }
 *                     confidence: 0.92
 *                   - id: weekend_pattern_2
 *                     type: weekend_pattern
 *                     severity: info
 *                     title: You spend more on food & dining at weekends
 *                     message: You spend more on food & dining on weekends — about ₹1,240 per weekend day versus ₹610 on weekdays, 103% higher.
 *                     metrics: { category: FOOD, weekendPerDay: 1240, weekdayPerDay: 610, liftPercent: 103 }
 *                     confidence: 0.85
 */
router.get('/', validate(schemas.list), controller.list);

/**
 * @openapi
 * /insights/summary:
 *   get:
 *     tags: [Insights]
 *     summary: One-line digest of the most important finding
 *     parameters:
 *       - { in: query, name: month, schema: { type: string, example: '2026-08' } }
 *     responses:
 *       200: { description: Headline plus supporting lines }
 */
router.get('/summary', validate(schemas.summary), controller.summary);

/**
 * @openapi
 * /insights/types:
 *   get:
 *     tags: [Insights]
 *     summary: List every insight type the engine can emit
 *     responses:
 *       200: { description: Insight type reference }
 */
router.get('/types', controller.types);

module.exports = router;
