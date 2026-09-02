'use strict';

const express = require('express');
const controller = require('../controllers/ai.controller');
const validate = require('../middlewares/validate.middleware');
const schemas = require('../validators/ai.validator');
const { aiLimiter } = require('../middlewares/rateLimit.middleware');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   name: Paisa AI
 *   description: Conversational answers grounded in the user's own spending
 */

/**
 * @openapi
 * /ai/status:
 *   get:
 *     tags: [Paisa AI]
 *     summary: Whether the assistant is configured on this server
 *     description: >
 *       Clients call this before showing the assistant at all. A deployment
 *       without an API key answers `available: false`, and the tab is hidden
 *       rather than offering a feature that will fail on first use.
 *     responses:
 *       200: { description: Availability flag }
 */
router.get('/status', controller.status);

/**
 * @openapi
 * /ai/chat:
 *   post:
 *     tags: [Paisa AI]
 *     summary: Ask Paisa AI about your money
 *     description: >
 *       Stateless — the client sends the whole conversation each turn and the
 *       server keeps no chat history. The user's month summary, top categories
 *       and top merchants are attached as context unless `includeContext` is
 *       false, so answers are grounded in real figures rather than guessed.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           example:
 *             messages:
 *               - { role: user, content: 'Where can I cut 5000 rupees?' }
 *     responses:
 *       200:
 *         description: The assistant's reply
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: OK
 *               data:
 *                 reply: 'Your food spend is 38% of the month...'
 *                 contextMonth: '2026-09'
 *       429: { description: Too many requests }
 *       500: { description: The assistant is unavailable }
 */
router.post('/chat', aiLimiter, validate(schemas.chat), controller.chat);

module.exports = router;
