'use strict';

const express = require('express');
const controller = require('../controllers/group.controller');
const schemas = require('../validators/split.validator');
const validate = require('../middlewares/validate.middleware');
const { splitLimiter } = require('../middlewares/rateLimit.middleware');

const router = express.Router();

/**
 * Route ordering matters here. Express matches in declaration order, so every
 * literal path (`/create`, `/add-member`, `/settle`, `/meta`, `/search-users`)
 * has to be declared before the `/:id` parameter routes — otherwise "create"
 * would be parsed as a group id and rejected as a malformed ObjectId.
 */

/**
 * @openapi
 * /groups/meta:
 *   get:
 *     tags: [Groups]
 *     summary: Reference data for building group and split forms
 *     responses:
 *       200:
 *         description: Icons, split types, settlement methods and categories
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/meta', controller.meta);

/**
 * @openapi
 * /groups/search-users:
 *   get:
 *     tags: [Groups]
 *     summary: Find registered users by email prefix, to add them to a group
 *     description: >
 *       Anchored prefix match on email, minimum three characters. A substring
 *       search would let any account enumerate the user table.
 *     parameters:
 *       - in: query
 *         name: query
 *         required: true
 *         schema: { type: string, minLength: 3 }
 *         example: aarav@
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 20, default: 10 }
 *     responses:
 *       200: { description: Matching accounts }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/search-users', validate(schemas.searchUsers), controller.searchUsers);

/**
 * @openapi
 * /groups/create:
 *   post:
 *     tags: [Groups]
 *     summary: Create a group
 *     description: >
 *       The creator is automatically added as an admin member. Other members can
 *       be supplied by userId, by email (linked if that account exists, held as a
 *       claimable placeholder if not), or by bare name for someone with no email.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/GroupInput' }
 *     responses:
 *       201: { description: Group created }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *       422: { $ref: '#/components/responses/ValidationError' }
 */
router.post('/create', splitLimiter, validate(schemas.createGroup), controller.createGroup);

/**
 * @openapi
 * /groups:
 *   post:
 *     tags: [Groups]
 *     summary: Create a group (RESTful alias of /groups/create)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/GroupInput' }
 *     responses:
 *       201: { description: Group created }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   get:
 *     tags: [Groups]
 *     summary: List every group you belong to, with your balance in each
 *     parameters:
 *       - in: query
 *         name: includeArchived
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200:
 *         description: Groups plus an aggregate of what you owe and are owed
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/', splitLimiter, validate(schemas.createGroup), controller.createGroup);
router.get('/', validate(schemas.listGroups), controller.listGroups);

/**
 * @openapi
 * /groups/add-member:
 *   post:
 *     tags: [Groups]
 *     summary: Add a member to a group
 *     description: >
 *       Admin only. Supply the target group as `groupId` in the body. Someone
 *       who was previously removed is re-activated rather than duplicated, so
 *       their historical splits stay attached.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/MemberInput'
 *               - type: object
 *                 required: [groupId]
 *                 properties:
 *                   groupId: { type: string }
 *     responses:
 *       201: { description: Member added }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.post('/add-member', splitLimiter, validate(schemas.addMember), controller.addMember);

/**
 * @openapi
 * /groups/settle:
 *   post:
 *     tags: [Groups]
 *     summary: Record a payment between two members
 *     description: >
 *       Supply the target group as `groupId` in the body. Partial settlement
 *       needs no special flag — paying 200 of a 300 debt simply leaves 100
 *       outstanding on the next balance read.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/SettlementInput'
 *               - type: object
 *                 required: [groupId]
 *                 properties:
 *                   groupId: { type: string }
 *     responses:
 *       201: { description: Settlement recorded, with refreshed balances }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       422: { $ref: '#/components/responses/ValidationError' }
 */
router.post('/settle', splitLimiter, validate(schemas.settle), controller.settle);

/**
 * @openapi
 * /groups/{id}:
 *   get:
 *     tags: [Groups]
 *     summary: Group detail — members, balances and recent expenses
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Everything a group screen needs, in one call }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Groups]
 *     summary: Rename, re-icon, archive or toggle debt simplification
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Group updated }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Groups]
 *     summary: Delete a group that has no expenses
 *     description: A group with live expenses must be archived instead; the ledger is evidence.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Group deleted }
 *       400: { description: The group still has expenses }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/:id', validate(schemas.groupById), controller.getGroup);
router.patch('/:id', validate(schemas.updateGroup), controller.updateGroup);
router.delete('/:id', validate(schemas.groupById), controller.deleteGroup);

/**
 * @openapi
 * /groups/{id}/members:
 *   post:
 *     tags: [Groups]
 *     summary: Add a member (RESTful alias of /groups/add-member)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/MemberInput' }
 *     responses:
 *       201: { description: Member added }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/:id/members', splitLimiter, validate(schemas.addMember), controller.addMember);

/**
 * @openapi
 * /groups/{id}/members/{memberId}:
 *   delete:
 *     tags: [Groups]
 *     summary: Remove a member
 *     description: >
 *       Admin only, and refused while the member carries a non-zero balance —
 *       removing them would destroy money the group owes or is owed. The last
 *       admin cannot be removed either.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: memberId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Member removed }
 *       400: { description: Member still owes or is owed money }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   patch:
 *     tags: [Groups]
 *     summary: Promote or demote a member
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: memberId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Role updated }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.delete('/:id/members/:memberId', validate(schemas.memberParams), controller.removeMember);
router.patch('/:id/members/:memberId', validate(schemas.updateMemberRole), controller.updateMemberRole);

/**
 * @openapi
 * /groups/{id}/expenses:
 *   post:
 *     tags: [Groups]
 *     summary: Add a shared expense
 *     description: >
 *       Supports four split types. `equal` needs only the participant list (omit
 *       it entirely to include everyone). `exact` takes rupee amounts that must
 *       total the bill, `percentage` takes values totalling 100, and `shares`
 *       takes relative weights. Whatever is sent, the stored shares are
 *       recomputed server-side in integer paise and always sum to the bill
 *       exactly.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/SplitExpenseInput' }
 *     responses:
 *       201: { description: Expense added, with refreshed balances }
 *       400: { description: Participants are not all active members }
 *       422: { description: Shares do not add up to the bill }
 *   get:
 *     tags: [Groups]
 *     summary: The group ledger, newest first
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *         description: Comma-separated category keys
 *       - in: query
 *         name: member
 *         schema: { type: string }
 *         description: Only expenses this member is part of
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200: { description: Expenses, each annotated with your own share }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/:id/expenses', splitLimiter, validate(schemas.createExpense), controller.createExpense);
router.get('/:id/expenses', validate(schemas.listExpenses), controller.listExpenses);

/**
 * @openapi
 * /groups/{id}/expenses/{expenseId}:
 *   get:
 *     tags: [Groups]
 *     summary: One shared expense
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: expenseId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: The expense }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Groups]
 *     summary: Edit a shared expense
 *     description: >
 *       Changing the amount, payer, split type or participants recomputes every
 *       share from scratch rather than patching them, because partial
 *       recomputation is where split bugs live.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: expenseId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Expense updated, with refreshed balances }
 *   delete:
 *     tags: [Groups]
 *     summary: Delete a shared expense
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: expenseId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Expense deleted, with refreshed balances }
 */
router.get('/:id/expenses/:expenseId', validate(schemas.expenseParams), controller.getExpense);
router.patch('/:id/expenses/:expenseId', splitLimiter, validate(schemas.updateExpense), controller.updateExpense);
router.delete('/:id/expenses/:expenseId', validate(schemas.expenseParams), controller.deleteExpense);

/**
 * @openapi
 * /groups/{id}/balances:
 *   get:
 *     tags: [Groups]
 *     summary: Who owes whom, before and after debt simplification
 *     description: >
 *       Returns per-member net positions, the literal pairwise ledger, and the
 *       minimal set of transfers that clears the group. Simplification turns
 *       "A owes B 300, B owes C 300" into a single "A pays C 300".
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: simplify
 *         schema: { type: boolean }
 *         description: Overrides the group's own simplifyDebts preference
 *     responses:
 *       200: { description: Balances, settle-up plan and your own position }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id/balances', validate(schemas.balances), controller.getBalances);

/**
 * @openapi
 * /groups/{id}/settle:
 *   post:
 *     tags: [Groups]
 *     summary: Record a payment between two members (RESTful alias of /groups/settle)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/SettlementInput' }
 *     responses:
 *       201: { description: Settlement recorded, with refreshed balances }
 */
router.post('/:id/settle', splitLimiter, validate(schemas.settle), controller.settle);

/**
 * @openapi
 * /groups/{id}/settlements:
 *   get:
 *     tags: [Groups]
 *     summary: Settlement history for a group
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Payments recorded between members }
 */
router.get('/:id/settlements', validate(schemas.listSettlements), controller.listSettlements);

/**
 * @openapi
 * /groups/{id}/settlements/{settlementId}:
 *   delete:
 *     tags: [Groups]
 *     summary: Reverse a settlement recorded in error
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: settlementId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Settlement reversed, with refreshed balances }
 */
router.delete('/:id/settlements/:settlementId', validate(schemas.settlementParams), controller.deleteSettlement);

module.exports = router;
