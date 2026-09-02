'use strict';

const express = require('express');
const controller = require('../controllers/auth.controller');
const validate = require('../middlewares/validate.middleware');
const schemas = require('../validators/auth.validator');
const { authenticate } = require('../middlewares/auth.middleware');
const { authLimiter } = require('../middlewares/rateLimit.middleware');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   name: Auth
 *   description: Registration, login and session management
 */

/**
 * @openapi
 * /auth/signup:
 *   post:
 *     tags: [Auth]
 *     summary: Create a new account
 *     description: Registers a user and returns an access/refresh token pair.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name: { type: string, example: Aarav Sharma }
 *               email: { type: string, format: email, example: aarav@example.com }
 *               password: { type: string, format: password, example: Paisa@2026 }
 *               currency: { type: string, example: INR }
 *               timezone: { type: string, example: Asia/Kolkata }
 *               monthlyIncome: { type: number, example: 85000 }
 *     responses:
 *       201:
 *         description: Account created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *       422: { $ref: '#/components/responses/ValidationError' }
 */
router.post('/signup', authLimiter, validate(schemas.signup), controller.signup);

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in with email and password
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email, example: aarav@example.com }
 *               password: { type: string, format: password, example: Paisa@2026 }
 *     responses:
 *       200:
 *         description: Logged in
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/login', authLimiter, validate(schemas.login), controller.login);

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Exchange a refresh token for a new token pair
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: New token pair issued
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/refresh', authLimiter, validate(schemas.refresh), controller.refresh);

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get the authenticated user's profile
 *     responses:
 *       200:
 *         description: The current user
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   patch:
 *     tags: [Auth]
 *     summary: Update profile and preferences
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               currency: { type: string, example: INR }
 *               timezone: { type: string, example: Asia/Kolkata }
 *               monthlyIncome: { type: number }
 *               preferences:
 *                 type: object
 *                 properties:
 *                   budgetAlertThreshold: { type: number, example: 0.8 }
 *                   alertsEnabled: { type: boolean }
 *                   autoCategorize: { type: boolean }
 *     responses:
 *       200: { description: Profile updated }
 */
router.get('/me', authenticate, controller.me);
router.patch('/me', authenticate, validate(schemas.updateProfile), controller.updateProfile);

/**
 * @openapi
 * /auth/change-password:
 *   post:
 *     tags: [Auth]
 *     summary: Change password and revoke other sessions
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword: { type: string, format: password }
 *               newPassword: { type: string, format: password }
 *     responses:
 *       200: { description: Password changed, new tokens issued }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/change-password', authenticate, authLimiter, validate(schemas.changePassword), controller.changePassword);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Sign out of all devices
 *     description: Revokes every refresh token issued before now.
 *     responses:
 *       200: { description: Signed out }
 */
router.post('/logout', authenticate, controller.logout);

/**
 * @openapi
 * /auth/deactivate:
 *   post:
 *     tags: [Auth]
 *     summary: Deactivate the account
 *     responses:
 *       200: { description: Account deactivated }
 */
router.post('/deactivate', authenticate, controller.deactivate);

module.exports = router;
