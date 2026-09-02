'use strict';

const express = require('express');
const controller = require('../controllers/budget.controller');
const validate = require('../middlewares/validate.middleware');
const schemas = require('../validators/budget.validator');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   name: Budgets
 *   description: Monthly caps, usage tracking and threshold warnings
 */

/**
 * @openapi
 * /budgets:
 *   post:
 *     tags: [Budgets]
 *     summary: Set (or update) a monthly budget
 *     description: >
 *       Upserts the cap for a month and category. Use `OVERALL` — the default —
 *       for a whole-month cap; transfers, investments and income are excluded
 *       from it. The response includes live usage, pace and projected month-end
 *       spend.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount]
 *             properties:
 *               amount: { type: number, example: 40000 }
 *               month: { type: string, example: '2026-08', description: Defaults to the current month }
 *               category: { type: string, example: OVERALL, description: A category name, or OVERALL }
 *               alertThreshold: { type: number, example: 0.8, description: Fraction of the cap that triggers a warning }
 *               alertsEnabled: { type: boolean, default: true }
 *               autoRenew: { type: boolean, default: true }
 *               note: { type: string }
 *     responses:
 *       200:
 *         description: Budget saved with live usage
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/BudgetStatusResponse' }
 *       422: { $ref: '#/components/responses/ValidationError' }
 *   get:
 *     tags: [Budgets]
 *     summary: List budgets for a month with usage percentages
 *     parameters:
 *       - { in: query, name: month, schema: { type: string, example: '2026-08' } }
 *     responses:
 *       200:
 *         description: Overall and per-category budget status
 */
router.post('/', validate(schemas.setBudget), controller.setBudget);
router.get('/', validate(schemas.list), controller.listBudgets);

/**
 * @openapi
 * /budgets/categories:
 *   get:
 *     tags: [Budgets]
 *     summary: Categories available for budgeting
 *     responses:
 *       200: { description: Category reference list }
 */
router.get('/categories', controller.categories);

/**
 * @openapi
 * /budgets/rollover:
 *   post:
 *     tags: [Budgets]
 *     summary: Carry auto-renewing budgets into the next month
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fromMonth: { type: string, example: '2026-08' }
 *               toMonth: { type: string, example: '2026-09' }
 *     responses:
 *       200: { description: Budgets carried forward }
 */
router.post('/rollover', validate(schemas.rollover), controller.rollover);

/**
 * @openapi
 * /budgets/{id}:
 *   get:
 *     tags: [Budgets]
 *     summary: Get one budget with its current usage
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Budget status }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Budgets]
 *     summary: Delete a budget
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Budget deleted }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id', validate(schemas.byId), controller.getBudget);
router.delete('/:id', validate(schemas.byId), controller.deleteBudget);

module.exports = router;
