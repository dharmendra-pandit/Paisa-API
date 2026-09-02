'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { success, created, paginationMeta } = require('../utils/apiResponse');
const expenseService = require('../services/expense.service');
const categorizationService = require('../services/categorization.service');

const createExpense = asyncHandler(async (req, res) => {
  const { expense, alerts } = await expenseService.createExpense(req.user, req.body);
  return created(res, {
    message: 'Expense recorded',
    // Alerts ride along on the write so the client can surface a budget
    // warning immediately, without polling the budget endpoint.
    data: { expense, budgetAlerts: alerts },
  });
});

const bulkCreate = asyncHandler(async (req, res) => {
  const expenses = await expenseService.createMany(req.user, req.body.expenses);
  return created(res, { message: `${expenses.length} expenses recorded`, data: { expenses, count: expenses.length } });
});

const listExpenses = asyncHandler(async (req, res) => {
  const { items, total, page, limit, summary } = await expenseService.listExpenses(req.user, req.query);
  return success(res, {
    data: { expenses: items, summary },
    meta: { pagination: paginationMeta({ total, page, limit }) },
  });
});

const getExpense = asyncHandler(async (req, res) => {
  const expense = await expenseService.getExpenseById(req.user, req.params.id);
  return success(res, { data: { expense } });
});

const updateExpense = asyncHandler(async (req, res) => {
  const { expense, alerts } = await expenseService.updateExpense(req.user, req.params.id, req.body);
  return success(res, { message: 'Expense updated', data: { expense, budgetAlerts: alerts } });
});

const deleteExpense = asyncHandler(async (req, res) => {
  const result = await expenseService.deleteExpense(req.user, req.params.id, { hard: req.query.hard === true });
  return success(res, { message: 'Expense deleted', data: result });
});

const restoreExpense = asyncHandler(async (req, res) => {
  const expense = await expenseService.restoreExpense(req.user, req.params.id);
  return success(res, { message: 'Expense restored', data: { expense } });
});

const usedCategories = asyncHandler(async (req, res) => {
  const categories = await expenseService.getUsedCategories(req.user);
  return success(res, { data: { categories } });
});

/** Dry run of the categoriser — lets a client preview a guess before saving. */
const categorize = asyncHandler(async (req, res) => {
  const result = await categorizationService.categorize({ userId: req.user._id, ...req.body });
  return success(res, {
    message: 'Category predicted',
    data: {
      ...result,
      isSubscription: categorizationService.looksLikeSubscription(req.body),
    },
  });
});

module.exports = {
  createExpense,
  bulkCreate,
  listExpenses,
  getExpense,
  updateExpense,
  deleteExpense,
  restoreExpense,
  usedCategories,
  categorize,
};
