'use strict';

const { z } = require('zod');
const {
  objectId,
  idParam,
  dateString,
  amount,
  category,
  csvList,
  booleanish,
  pagination,
} = require('./common.validator');
const { SPLIT_TYPE_LIST, GROUP_ICONS, GROUP_ROLE_LIST, SETTLEMENT_METHODS } = require('../constants/split');

/**
 * Request schemas for groups, shared expenses and settlements.
 *
 * Note what is deliberately *not* validated here: that shares add up. Zod can
 * check the shape of a participant list, but "these four amounts total the
 * bill" depends on the split type and needs a domain-quality error message
 * naming the shortfall, so it lives in split.service where the calculation
 * happens. Schema validation guards the shape; the service guards the maths.
 */

const memberInput = z
  .object({
    userId: objectId.optional(),
    email: z.string().trim().toLowerCase().email('Provide a valid email address').optional(),
    name: z.string().trim().min(1).max(80).optional(),
    role: z.enum(GROUP_ROLE_LIST).optional(),
  })
  .refine((m) => m.userId || m.email || m.name, {
    message: 'Each member needs a userId, an email, or a name',
  });

/** One participant's stake. `share` is a percentage, weight or exact amount. */
const participantInput = z.object({
  member: objectId,
  share: z.coerce.number().min(0).optional(),
});

const createGroup = {
  body: z.object({
    name: z.string().trim().min(1, 'Group name is required').max(60),
    icon: z.enum(GROUP_ICONS).optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    members: z.array(memberInput).max(49, 'A group cannot have more than 50 members').optional(),
    simplifyDebts: z.boolean().optional(),
  }),
};

const listGroups = {
  query: z.object({ includeArchived: booleanish.optional() }),
};

const updateGroup = {
  params: idParam,
  body: z
    .object({
      name: z.string().trim().min(1).max(60).optional(),
      icon: z.enum(GROUP_ICONS).optional(),
      simplifyDebts: z.boolean().optional(),
      isArchived: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' }),
};

const groupById = { params: idParam };

/**
 * Accepts the group either from the path (`/groups/:id/members`) or the body
 * (`/groups/add-member`), so the documented flat route and the RESTful nested
 * one share a single controller.
 */
const addMember = {
  params: z.object({ id: objectId.optional() }),
  body: memberInput.and(z.object({ groupId: objectId.optional() })),
};

const memberParams = {
  params: z.object({ id: objectId, memberId: objectId }),
};

const updateMemberRole = {
  params: z.object({ id: objectId, memberId: objectId }),
  body: z.object({ role: z.enum(GROUP_ROLE_LIST) }),
};

const createExpense = {
  params: z.object({ id: objectId.optional() }),
  body: z.object({
    groupId: objectId.optional(),
    description: z.string().trim().min(1, 'Description is required').max(140),
    amount,
    // Defaults to the caller — "I paid for this" is the common case.
    paidBy: objectId.optional(),
    splitType: z.enum(SPLIT_TYPE_LIST).optional(),
    // Omitted on an equal split means everyone in the group.
    participants: z.array(participantInput).max(50).optional(),
    category: category.optional(),
    date: dateString.optional(),
    note: z.string().trim().max(500).optional(),
    /** Mirror the payer's own share into their personal expense ledger. */
    addToPersonalExpenses: z.boolean().optional(),
  }),
};

const listExpenses = {
  params: idParam,
  query: z
    .object({
      ...pagination,
      category: csvList(category).optional(),
      member: objectId.optional(),
      search: z.string().trim().min(1).max(100).optional(),
      startDate: dateString.optional(),
      endDate: dateString.optional(),
    })
    .refine((q) => !(q.startDate && q.endDate) || q.endDate >= q.startDate, {
      message: 'endDate must be on or after startDate',
      path: ['endDate'],
    }),
};

const expenseParams = {
  params: z.object({ id: objectId, expenseId: objectId }),
};

const updateExpense = {
  params: z.object({ id: objectId, expenseId: objectId }),
  body: z
    .object({
      description: z.string().trim().min(1).max(140).optional(),
      amount: amount.optional(),
      paidBy: objectId.optional(),
      splitType: z.enum(SPLIT_TYPE_LIST).optional(),
      participants: z.array(participantInput).max(50).optional(),
      category: category.optional(),
      date: dateString.optional(),
      note: z.string().trim().max(500).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' }),
};

const balances = {
  params: idParam,
  query: z.object({ simplify: booleanish.optional() }),
};

const settle = {
  params: z.object({ id: objectId.optional() }),
  body: z
    .object({
      groupId: objectId.optional(),
      from: objectId,
      to: objectId,
      amount,
      method: z.enum(SETTLEMENT_METHODS).optional(),
      date: dateString.optional(),
      note: z.string().trim().max(300).optional(),
    })
    .refine((v) => String(v.from) !== String(v.to), {
      message: 'A member cannot settle up with themselves',
      path: ['to'],
    }),
};

const listSettlements = {
  params: idParam,
  query: z.object({ ...pagination }),
};

const settlementParams = {
  params: z.object({ id: objectId, settlementId: objectId }),
};

const searchUsers = {
  query: z.object({
    query: z.string().trim().min(3, 'Enter at least 3 characters to search').max(160),
    limit: z.coerce.number().int().min(1).max(20).optional(),
  }),
};

module.exports = {
  createGroup,
  listGroups,
  updateGroup,
  groupById,
  addMember,
  memberParams,
  updateMemberRole,
  createExpense,
  listExpenses,
  expenseParams,
  updateExpense,
  balances,
  settle,
  listSettlements,
  settlementParams,
  searchUsers,
};
