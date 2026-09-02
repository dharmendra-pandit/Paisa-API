'use strict';

const express = require('express');
const controller = require('../controllers/expense.controller');
const validate = require('../middlewares/validate.middleware');
const schemas = require('../validators/expense.validator');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   name: Expenses
 *   description: Recording, querying and correcting transactions
 */

/**
 * @openapi
 * /expenses:
 *   post:
 *     tags: [Expenses]
 *     summary: Add an expense
 *     description: >
 *       Records a transaction. Omit `category` to let the auto-categoriser pick
 *       one; the response reports the method and confidence behind the choice.
 *       Any budget threshold crossed by this expense is returned in `budgetAlerts`.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ExpenseInput' }
 *           examples:
 *             autoCategorised:
 *               summary: Let the engine choose the category
 *               value: { amount: 480, merchant: Swiggy, note: Dinner order, date: '2026-08-29T20:15:00.000Z', paymentMethod: upi }
 *             explicit:
 *               summary: Caller supplies the category
 *               value: { amount: 12000, category: RENT, merchant: Landlord, note: August rent, paymentMethod: net_banking }
 *     responses:
 *       201:
 *         description: Expense recorded
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ExpenseResponse' }
 *       422: { $ref: '#/components/responses/ValidationError' }
 *   get:
 *     tags: [Expenses]
 *     summary: List expenses with filters
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, default: 20, maximum: 100 } }
 *       - { in: query, name: month, schema: { type: string, example: '2026-08' }, description: Shorthand for a whole calendar month }
 *       - { in: query, name: startDate, schema: { type: string, format: date } }
 *       - { in: query, name: endDate, schema: { type: string, format: date }, description: Inclusive }
 *       - { in: query, name: category, schema: { type: string, example: 'FOOD,TRANSPORT' }, description: Comma-separated }
 *       - { in: query, name: type, schema: { type: string, enum: [debit, credit] } }
 *       - { in: query, name: source, schema: { type: string, enum: [manual, sms, import, recurring] } }
 *       - { in: query, name: paymentMethod, schema: { type: string } }
 *       - { in: query, name: minAmount, schema: { type: number } }
 *       - { in: query, name: maxAmount, schema: { type: number } }
 *       - { in: query, name: search, schema: { type: string }, description: Matches note, merchant and tags }
 *       - { in: query, name: isSubscription, schema: { type: boolean } }
 *       - { in: query, name: sortBy, schema: { type: string, enum: [date, amount, createdAt, category], default: date } }
 *       - { in: query, name: sortOrder, schema: { type: string, enum: [asc, desc], default: desc } }
 *     responses:
 *       200:
 *         description: A page of expenses plus totals for the whole filtered set
 */
router.post('/', validate(schemas.create), controller.createExpense);
router.get('/', validate(schemas.list), controller.listExpenses);

/**
 * @openapi
 * /expenses/bulk:
 *   post:
 *     tags: [Expenses]
 *     summary: Add up to 100 expenses in one request
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [expenses]
 *             properties:
 *               expenses:
 *                 type: array
 *                 items: { $ref: '#/components/schemas/ExpenseInput' }
 *     responses:
 *       201: { description: Expenses recorded }
 */
router.post('/bulk', validate(schemas.bulkCreate), controller.bulkCreate);

/**
 * @openapi
 * /expenses/categories:
 *   get:
 *     tags: [Expenses]
 *     summary: Categories this user has actually used, with totals
 *     responses:
 *       200: { description: Category usage }
 */
router.get('/categories', controller.usedCategories);

/**
 * @openapi
 * /expenses/categorize:
 *   post:
 *     tags: [Expenses]
 *     summary: Preview the auto-categorisation for a description
 *     description: Runs the rule engine without saving anything.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               merchant: { type: string, example: Netflix }
 *               note: { type: string, example: Monthly plan }
 *               amount: { type: number, example: 649 }
 *               type: { type: string, enum: [debit, credit] }
 *     responses:
 *       200:
 *         description: Predicted category with confidence and the token it matched
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: Category predicted
 *               data: { category: SUBSCRIPTIONS, confidence: 0.95, method: rule-engine, matchedOn: netflix, merchantKey: netflix, isSubscription: true }
 */
router.post('/categorize', validate(schemas.categorize), controller.categorize);

/**
 * @openapi
 * /expenses/{id}:
 *   get:
 *     tags: [Expenses]
 *     summary: Get one expense
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: The expense }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Expenses]
 *     summary: Update an expense
 *     description: >
 *       Supplying `category` marks the row as user-confirmed, which teaches the
 *       categoriser what this merchant means for this user.
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ExpenseInput' }
 *     responses:
 *       200: { description: Expense updated }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Expenses]
 *     summary: Delete an expense
 *     description: Soft delete by default; pass `hard=true` to remove the document permanently.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: query, name: hard, schema: { type: boolean, default: false } }
 *     responses:
 *       200: { description: Expense deleted }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id', validate(schemas.byId), controller.getExpense);
router.patch('/:id', validate(schemas.update), controller.updateExpense);
router.delete('/:id', validate(schemas.remove), controller.deleteExpense);

/**
 * @openapi
 * /expenses/{id}/restore:
 *   post:
 *     tags: [Expenses]
 *     summary: Restore a soft-deleted expense
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Expense restored }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/:id/restore', validate(schemas.byId), controller.restoreExpense);

module.exports = router;
