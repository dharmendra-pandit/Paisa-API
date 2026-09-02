'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { success, created, paginationMeta } = require('../utils/apiResponse');
const groupService = require('../services/group.service');
const splitService = require('../services/split.service');
const balanceService = require('../services/balance.service');
const ApiError = require('../utils/ApiError');
const { GROUP_ICONS, SPLIT_TYPE_LIST, SETTLEMENT_METHODS } = require('../constants/split');
const { CATEGORY_LIST, CATEGORY_LABELS } = require('../constants/categories');

/**
 * The group id arrives either in the path (RESTful routes) or in the body (the
 * flat `/groups/add-member` and `/groups/settle` shapes). Both are supported, so
 * every handler resolves it through here rather than reaching for req.params.id.
 */
function resolveGroupId(req) {
  const id = req.params.id || req.body.groupId;
  if (!id) throw ApiError.badRequest('A groupId is required');
  return id;
}

const createGroup = asyncHandler(async (req, res) => {
  const group = await groupService.createGroup(req.user, req.body);
  return created(res, { message: 'Group created', data: { group: groupService.presentGroup(group) } });
});

const listGroups = asyncHandler(async (req, res) => {
  const data = await groupService.listGroups(req.user, req.query, { balanceService });
  return success(res, { data });
});

/** Group detail: members, balances and the most recent activity in one call. */
const getGroup = asyncHandler(async (req, res) => {
  const { group, member } = await groupService.loadGroupForUser(req.user, req.params.id);

  const [balances, expenses] = await Promise.all([
    balanceService.getGroupBalances(group),
    splitService.listExpenses(group, member._id, { page: 1, limit: 10 }),
  ]);

  return success(res, {
    data: {
      group: groupService.presentGroup(group),
      you: { member: String(member._id), role: member.role },
      balances,
      recentExpenses: expenses.items,
    },
  });
});

const updateGroup = asyncHandler(async (req, res) => {
  const group = await groupService.updateGroup(req.user, req.params.id, req.body);
  return success(res, { message: 'Group updated', data: { group: groupService.presentGroup(group) } });
});

const deleteGroup = asyncHandler(async (req, res) => {
  const result = await groupService.deleteGroup(req.user, req.params.id);
  return success(res, { message: 'Group deleted', data: result });
});

const addMember = asyncHandler(async (req, res) => {
  const group = await groupService.addMember(req.user, resolveGroupId(req), req.body);
  return created(res, { message: 'Member added', data: { group: groupService.presentGroup(group) } });
});

const removeMember = asyncHandler(async (req, res) => {
  const { group, removed } = await groupService.removeMember(req.user, req.params.id, req.params.memberId, { balanceService });
  return success(res, { message: `${removed.name} removed from the group`, data: { group: groupService.presentGroup(group), removed } });
});

const updateMemberRole = asyncHandler(async (req, res) => {
  const group = await groupService.updateMemberRole(req.user, req.params.id, req.params.memberId, req.body.role);
  return success(res, { message: 'Member role updated', data: { group: groupService.presentGroup(group) } });
});

// ---------------------------------------------------------------------------
// Shared expenses
// ---------------------------------------------------------------------------

const createExpense = asyncHandler(async (req, res) => {
  const { group, member } = await groupService.loadGroupForUser(req.user, resolveGroupId(req));
  const expense = await splitService.createExpense(req.user, group, req.body);
  const balances = await balanceService.getGroupBalances(group);

  return created(res, {
    message: 'Expense added',
    data: {
      expense: splitService.presentExpense(expense.toObject(), group, member._id),
      balances,
    },
  });
});

const listExpenses = asyncHandler(async (req, res) => {
  const { group, member } = await groupService.loadGroupForUser(req.user, req.params.id);
  const { items, total, page, limit, summary } = await splitService.listExpenses(group, member._id, req.query);

  return success(res, {
    data: { expenses: items, summary },
    meta: paginationMeta({ total, page, limit }),
  });
});

const getExpense = asyncHandler(async (req, res) => {
  const { group, member } = await groupService.loadGroupForUser(req.user, req.params.id);
  const expense = await splitService.getExpense(group, member._id, req.params.expenseId);
  return success(res, { data: { expense } });
});

const updateExpense = asyncHandler(async (req, res) => {
  const { group, member } = await groupService.loadGroupForUser(req.user, req.params.id);
  const expense = await splitService.updateExpense(req.user, group, req.params.expenseId, req.body);
  const balances = await balanceService.getGroupBalances(group);

  return success(res, {
    message: 'Expense updated',
    data: { expense: splitService.presentExpense(expense.toObject(), group, member._id), balances },
  });
});

const deleteExpense = asyncHandler(async (req, res) => {
  const { group } = await groupService.loadGroupForUser(req.user, req.params.id);
  const result = await splitService.deleteExpense(req.user, group, req.params.expenseId);
  const balances = await balanceService.getGroupBalances(group);
  return success(res, { message: 'Expense deleted', data: { ...result, balances } });
});

// ---------------------------------------------------------------------------
// Balances and settlements
// ---------------------------------------------------------------------------

const getBalances = asyncHandler(async (req, res) => {
  const { group, member } = await groupService.loadGroupForUser(req.user, req.params.id);

  const [balances, yours] = await Promise.all([
    balanceService.getGroupBalances(group, { simplify: req.query.simplify }),
    balanceService.getMemberBalance(group, member._id),
  ]);

  return success(res, { data: { ...balances, you: yours } });
});

const settle = asyncHandler(async (req, res) => {
  const { group } = await groupService.loadGroupForUser(req.user, resolveGroupId(req));
  const result = await balanceService.recordSettlement(req.user, group, req.body);
  return created(res, { message: result.message, data: { settlement: result.settlement, balances: result.balances } });
});

const listSettlements = asyncHandler(async (req, res) => {
  const { group } = await groupService.loadGroupForUser(req.user, req.params.id);
  const { items, total, page, limit } = await balanceService.listSettlements(group, req.query);
  return success(res, { data: { settlements: items }, meta: paginationMeta({ total, page, limit }) });
});

const deleteSettlement = asyncHandler(async (req, res) => {
  const { group } = await groupService.loadGroupForUser(req.user, req.params.id);
  const result = await balanceService.deleteSettlement(req.user, group, req.params.settlementId);
  return success(res, { message: 'Settlement reversed', data: result });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const searchUsers = asyncHandler(async (req, res) => {
  const data = await groupService.searchUsers(req.user, req.query);
  return success(res, { data });
});

/** Reference data so a client can build the group and split forms offline. */
const meta = asyncHandler(async (_req, res) =>
  success(res, {
    data: {
      icons: GROUP_ICONS,
      splitTypes: SPLIT_TYPE_LIST,
      settlementMethods: SETTLEMENT_METHODS,
      categories: CATEGORY_LIST.map((value) => ({ value, label: CATEGORY_LABELS[value] })),
      maxMembers: groupService.MAX_MEMBERS,
    },
  })
);

module.exports = {
  createGroup,
  listGroups,
  getGroup,
  updateGroup,
  deleteGroup,
  addMember,
  removeMember,
  updateMemberRole,
  createExpense,
  listExpenses,
  getExpense,
  updateExpense,
  deleteExpense,
  getBalances,
  settle,
  listSettlements,
  deleteSettlement,
  searchUsers,
  meta,
};
