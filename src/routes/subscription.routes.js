'use strict';

const express = require('express');
const controller = require('../controllers/subscription.controller');
const validate = require('../middlewares/validate.middleware');
const schemas = require('../validators/subscription.validator');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   name: Subscriptions
 *   description: Detection and management of recurring payments
 */

/**
 * @openapi
 * /subscriptions/detect:
 *   post:
 *     tags: [Subscriptions]
 *     summary: Run recurring-payment detection
 *     description: >
 *       Groups charges by normalised merchant and scores each group on cadence
 *       regularity, amount stability and merchant recognition. Groups above the
 *       confidence floor are saved as subscriptions and their charges are
 *       tagged. Pass `persist: false` for a dry run.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               lookbackDays: { type: integer, example: 210, minimum: 30, maximum: 730 }
 *               persist: { type: boolean, default: true }
 *     responses:
 *       200:
 *         description: Detected subscriptions with confidence and next expected charge
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: 3 recurring payments detected
 *               data:
 *                 detected:
 *                   - merchant: Netflix
 *                     amount: 499
 *                     cadence: monthly
 *                     intervalDays: 30
 *                     occurrences: 5
 *                     confidence: 0.94
 *                     nextExpectedAt: '2026-09-28T00:00:00.000Z'
 *                     metrics: { regularity: 0.97, amountStability: 1, merchantRecognised: true }
 *                 summary: { total: 3, active: 3, estimatedMonthlyCost: 1447, estimatedYearlyCost: 17364 }
 */
router.post('/detect', validate(schemas.detect), controller.detect);

/**
 * @openapi
 * /subscriptions:
 *   get:
 *     tags: [Subscriptions]
 *     summary: List detected subscriptions
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [active, lapsed, cancelled] } }
 *       - { in: query, name: includeDismissed, schema: { type: boolean, default: false } }
 *     responses:
 *       200: { description: Subscriptions with estimated monthly and yearly cost }
 */
router.get('/', validate(schemas.list), controller.list);

/**
 * @openapi
 * /subscriptions/upcoming:
 *   get:
 *     tags: [Subscriptions]
 *     summary: Charges expected in the next N days
 *     parameters:
 *       - { in: query, name: days, schema: { type: integer, default: 30, maximum: 180 } }
 *     responses:
 *       200: { description: Upcoming charges ordered by expected date }
 */
router.get('/upcoming', validate(schemas.upcoming), controller.upcoming);

/**
 * @openapi
 * /subscriptions/{id}/review:
 *   patch:
 *     tags: [Subscriptions]
 *     summary: Confirm or dismiss a detected subscription
 *     description: A user verdict is never overwritten by a later detection run.
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               verdict: { type: string, enum: [unreviewed, confirmed, dismissed] }
 *               status: { type: string, enum: [active, lapsed, cancelled] }
 *     responses:
 *       200: { description: Subscription updated }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.patch('/:id/review', validate(schemas.review), controller.review);

module.exports = router;
