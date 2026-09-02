'use strict';

const express = require('express');
const controller = require('../controllers/sms.controller');
const validate = require('../middlewares/validate.middleware');
const schemas = require('../validators/sms.validator');
const { smsLimiter } = require('../middlewares/rateLimit.middleware');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   name: SMS
 *   description: Turn raw bank SMS alerts into expenses
 */

/**
 * @openapi
 * /sms/parse:
 *   post:
 *     tags: [SMS]
 *     summary: Parse a bank SMS into an expense
 *     description: >
 *       Extracts the amount, direction (credit/debit), merchant, account tail,
 *       reference and date, then categorises the result and saves it.
 *
 *       Pass `save: false` to preview without writing. Promotional messages and
 *       OTPs are recognised and skipped with `status: ignored` — that is a
 *       success, not an error. Re-posting the same message returns
 *       `status: duplicate` rather than creating a second expense.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message]
 *             properties:
 *               message: { type: string, example: 'Rs.499.00 debited from A/c XX4521 on 29-08-26 to NETFLIX via UPI. Ref 429183746512. -HDFC Bank' }
 *               sender: { type: string, example: VM-HDFCBK }
 *               receivedAt: { type: string, format: date-time }
 *               save: { type: boolean, default: true }
 *           examples:
 *             debit:
 *               summary: A debit alert
 *               value: { message: 'Rs.499.00 debited from A/c XX4521 on 29-08-26 to NETFLIX via UPI. Ref 429183746512. -HDFC Bank', sender: VM-HDFCBK }
 *             credit:
 *               summary: Salary credit
 *               value: { message: 'INR 85,000.00 credited to A/c XX4521 on 01-08-26 towards SALARY AUG. Ref 8812340091. -HDFC Bank', sender: VM-HDFCBK }
 *             promotional:
 *               summary: Promotional message that must be ignored
 *               value: { message: 'Flat 50% off on your next order! Use coupon SAVE50 and get cashback up to Rs.150.', sender: AD-SWIGGY }
 *     responses:
 *       201:
 *         description: A new expense was created
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: SMS converted into an expense
 *               data:
 *                 status: created
 *                 parsed: { isTransaction: true, amount: 499, type: debit, merchant: NETFLIX, bank: HDFC Bank, accountLast4: '4521', referenceId: '429183746512', paymentMethod: upi, confidence: 0.95 }
 *       200:
 *         description: Duplicate, preview, or a message that was not a transaction
 *       422: { $ref: '#/components/responses/ValidationError' }
 */
router.post('/parse', smsLimiter, validate(schemas.parse), controller.parse);

/**
 * @openapi
 * /sms/parse-batch:
 *   post:
 *     tags: [SMS]
 *     summary: Parse up to 50 messages in one request
 *     description: Reports a per-message outcome, so partial success is visible.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [messages]
 *             properties:
 *               messages:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [message]
 *                   properties:
 *                     message: { type: string }
 *                     sender: { type: string }
 *                     receivedAt: { type: string, format: date-time }
 *               save: { type: boolean, default: true }
 *     responses:
 *       200: { description: Per-message results and a summary by status }
 */
router.post('/parse-batch', smsLimiter, validate(schemas.parseBatch), controller.parseBatch);

module.exports = router;
