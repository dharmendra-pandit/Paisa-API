'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/apiResponse');
const budgetService = require('../services/budget.service');
const { CATEGORY_LIST, CATEGORY_LABELS } = require('../constants/categories');
const { OVERALL } = require('../models/Budget');

/** Upsert: setting a budget for an existing month/category updates it in place. */
const setBudget = asyncHandler(async (req, res) => {
  const status = await budgetService.setBudget(req.user, req.body);
  return success(res, { message: 'Budget saved', data: { budget: status } });
});

const listBudgets = asyncHandler(async (req, res) => {
  const data = await budgetService.listBudgets(req.user, req.query);
  return success(res, { data });
});

const getBudget = asyncHandler(async (req, res) => {
  const budget = await budgetService.getBudget(req.user, req.params.id);
  return success(res, { data: { budget } });
});

const deleteBudget = asyncHandler(async (req, res) => {
  const result = await budgetService.deleteBudget(req.user, req.params.id);
  return success(res, { message: 'Budget deleted', data: result });
});

/** Copies auto-renewing caps forward, so a new month is not a blank slate. */
const rollover = asyncHandler(async (req, res) => {
  const result = await budgetService.rolloverBudgets(req.user, req.body);
  return success(res, { message: `${result.created} budgets carried into ${result.to}`, data: result });
});

/** Static reference data for building the budget form client-side. */
const categories = asyncHandler(async (_req, res) =>
  success(res, {
    data: {
      overall: OVERALL,
      categories: CATEGORY_LIST.map((value) => ({ value, label: CATEGORY_LABELS[value] })),
    },
  })
);

module.exports = { setBudget, listBudgets, getBudget, deleteBudget, rollover, categories };
