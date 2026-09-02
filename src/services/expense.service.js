'use strict';

const mongoose = require('mongoose');
const Expense = require('../models/Expense');
const ApiError = require('../utils/ApiError');
const { round2 } = require('../utils/money');
const { monthRange, startOfDay, endOfDay } = require('../utils/date');
const { TRANSACTION_TYPES, EXPENSE_SOURCES, CATEGORIES } = require('../constants/categories');
const categorizationService = require('./categorization.service');
const budgetService = require('./budget.service');
const logger = require('../utils/logger');

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

const SORT_FIELDS = { date: 'date', amount: 'amount', createdAt: 'createdAt', category: 'category' };

/**
 * Translates validated query parameters into a Mongo filter.
 * Soft-deleted rows are excluded unless explicitly requested.
 */
function buildFilter(user, query = {}) {
  const filter = { user: toObjectId(user._id), isDeleted: query.includeDeleted === true };

  if (query.month) {
    const { start, end } = monthRange(query.month, user.timezone);
    filter.date = { $gte: start, $lt: end };
  } else if (query.startDate || query.endDate) {
    filter.date = {};
    if (query.startDate) filter.date.$gte = startOfDay(query.startDate, user.timezone);
    // Inclusive end date: "to 2026-08-31" must include that whole day.
    if (query.endDate) filter.date.$lte = endOfDay(query.endDate, user.timezone);
  }

  if (query.category && query.category.length) filter.category = { $in: query.category };
  if (query.type) filter.type = query.type;
  if (query.source) filter.source = query.source;
  if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
  if (typeof query.isSubscription === 'boolean') filter.isSubscription = query.isSubscription;
  if (query.tags && query.tags.length) filter.tags = { $in: query.tags };

  if (query.minAmount !== undefined || query.maxAmount !== undefined) {
    filter.amount = {};
    if (query.minAmount !== undefined) filter.amount.$gte = query.minAmount;
    if (query.maxAmount !== undefined) filter.amount.$lte = query.maxAmount;
  }

  if (query.search) {
    // Escaped so user input cannot inject regex metacharacters.
    const safe = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    filter.$or = [{ note: rx }, { merchant: rx }, { tags: rx }];
  }

  return filter;
}

/**
 * Resolves the final category for a write.
 * An explicit category from the client is authoritative and marks the row as
 * confirmed — that is the signal the merchant-memory layer learns from.
 */
async function resolveCategory(user, payload, existing) {
  if (payload.category) {
    return {
      category: payload.category,
      categoryConfirmed: true,
      categorization: { method: 'manual', confidence: 1, matchedOn: null },
      merchantKey: categorizationService.buildMerchantKey(payload.merchant || (existing && existing.merchant) || payload.note || ''),
    };
  }

  if (user.preferences.autoCategorize === false) {
    const fallback = CATEGORIES.OTHER;
    return {
      category: existing ? existing.category : fallback,
      categoryConfirmed: false,
      categorization: { method: 'fallback', confidence: 0.2, matchedOn: null },
      merchantKey: categorizationService.buildMerchantKey(payload.merchant || ''),
    };
  }

  const result = await categorizationService.categorize({
    userId: user._id,
    merchant: payload.merchant || (existing && existing.merchant),
    note: payload.note ?? (existing && existing.note),
    rawText: payload.rawText,
    tags: payload.tags,
    amount: payload.amount ?? (existing && existing.amount),
    type: payload.type || (existing && existing.type) || TRANSACTION_TYPES.DEBIT,
  });

  return {
    category: result.category,
    categoryConfirmed: false,
    categorization: { method: result.method, confidence: result.confidence, matchedOn: result.matchedOn },
    merchantKey: result.merchantKey,
  };
}

/** Creates one expense, auto-categorising it and returning any budget alerts raised. */
async function createExpense(user, payload) {
  const resolved = await resolveCategory(user, payload);

  const expense = await Expense.create({
    user: user._id,
    amount: payload.amount,
    currency: payload.currency || user.currency,
    type: payload.type || TRANSACTION_TYPES.DEBIT,
    category: resolved.category,
    categoryConfirmed: resolved.categoryConfirmed,
    categorization: resolved.categorization,
    note: payload.note || '',
    merchant: payload.merchant || '',
    merchantKey: resolved.merchantKey,
    date: payload.date || new Date(),
    paymentMethod: payload.paymentMethod || 'other',
    tags: payload.tags || [],
    source: payload.source || EXPENSE_SOURCES.MANUAL,
    sms: payload.sms,
    isSubscription:
      payload.isSubscription ??
      categorizationService.looksLikeSubscription({
        merchant: payload.merchant,
        note: payload.note,
        rawText: payload.rawText,
        paymentMethod: payload.paymentMethod,
      }),
  });

  const alerts = await safeEvaluateBudgets(user, expense);
  return { expense, alerts };
}

/** Budget alerting must never take down the write that triggered it. */
async function safeEvaluateBudgets(user, expense) {
  try {
    return await budgetService.evaluateBudgetsForExpense(user, expense);
  } catch (err) {
    logger.error('Budget evaluation failed', { message: err.message, expenseId: String(expense._id) });
    return [];
  }
}

async function listExpenses(user, query = {}) {
  const filter = buildFilter(user, query);

  const page = query.page || 1;
  const limit = query.limit || 20;
  const sortField = SORT_FIELDS[query.sortBy] || 'date';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

  const [items, total, summary] = await Promise.all([
    Expense.find(filter)
      .sort({ [sortField]: sortOrder, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Expense.countDocuments(filter),
    summarize(filter),
  ]);

  return { items: items.map(present), total, page, limit, summary };
}

/** Totals for the *entire* filtered set, not just the current page. */
async function summarize(filter) {
  const [row] = await Expense.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        totalDebit: { $sum: { $cond: [{ $eq: ['$type', TRANSACTION_TYPES.DEBIT] }, '$amount', 0] } },
        totalCredit: { $sum: { $cond: [{ $eq: ['$type', TRANSACTION_TYPES.CREDIT] }, '$amount', 0] } },
        count: { $sum: 1 },
        avgAmount: { $avg: '$amount' },
        maxAmount: { $max: '$amount' },
      },
    },
  ]);

  if (!row) return { totalSpent: 0, totalReceived: 0, net: 0, count: 0, averageAmount: 0, largestAmount: 0 };

  return {
    totalSpent: round2(row.totalDebit),
    totalReceived: round2(row.totalCredit),
    net: round2(row.totalCredit - row.totalDebit),
    count: row.count,
    averageAmount: round2(row.avgAmount),
    largestAmount: round2(row.maxAmount),
  };
}

/** Strips Mongo internals so lean() documents match the toJSON contract. */
function present(doc) {
  if (!doc) return doc;
  const { _id, __v, ...rest } = doc;
  return { id: _id, ...rest };
}

async function getExpenseById(user, id) {
  const expense = await Expense.findOne({ _id: id, user: user._id, isDeleted: false });
  if (!expense) throw ApiError.notFound('Expense not found');
  return expense;
}

async function updateExpense(user, id, payload) {
  const expense = await getExpenseById(user, id);

  const merchantChanged = payload.merchant !== undefined && payload.merchant !== expense.merchant;
  const noteChanged = payload.note !== undefined && payload.note !== expense.note;

  // Re-categorise only when the client did not choose, and only when the text
  // the guess was based on actually changed — otherwise a price edit would
  // silently reshuffle a category the user already accepted.
  const shouldRecategorize =
    !payload.category && !expense.categoryConfirmed && (merchantChanged || noteChanged);

  const assignable = [
    'amount', 'currency', 'type', 'note', 'merchant', 'date', 'paymentMethod', 'tags', 'isSubscription',
  ];
  for (const field of assignable) {
    if (payload[field] !== undefined) expense[field] = payload[field];
  }

  if (payload.category) {
    expense.category = payload.category;
    expense.categoryConfirmed = true;
    expense.categorization = { method: 'manual', confidence: 1, matchedOn: null };
  } else if (shouldRecategorize) {
    const result = await categorizationService.categorize({
      userId: user._id,
      merchant: expense.merchant,
      note: expense.note,
      amount: expense.amount,
      type: expense.type,
      tags: expense.tags,
    });
    expense.category = result.category;
    expense.categorization = { method: result.method, confidence: result.confidence, matchedOn: result.matchedOn };
  }

  if (merchantChanged) expense.merchantKey = categorizationService.buildMerchantKey(expense.merchant);

  await expense.save();
  const alerts = await safeEvaluateBudgets(user, expense);
  return { expense, alerts };
}

/** Soft delete by default so historical trends stay honest; hard delete on request. */
async function deleteExpense(user, id, { hard = false } = {}) {
  if (hard) {
    const removed = await Expense.findOneAndDelete({ _id: id, user: user._id });
    if (!removed) throw ApiError.notFound('Expense not found');
    return { id: removed._id, deleted: true, mode: 'hard' };
  }

  const expense = await Expense.findOneAndUpdate(
    { _id: id, user: user._id, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: new Date() } },
    { new: true }
  );
  if (!expense) throw ApiError.notFound('Expense not found');
  return { id: expense._id, deleted: true, mode: 'soft', deletedAt: expense.deletedAt };
}

async function restoreExpense(user, id) {
  const expense = await Expense.findOneAndUpdate(
    { _id: id, user: user._id, isDeleted: true },
    { $set: { isDeleted: false, deletedAt: null } },
    { new: true }
  );
  if (!expense) throw ApiError.notFound('Deleted expense not found');
  return expense;
}

/** Bulk insert used by SMS ingestion and the seeder. */
async function createMany(user, payloads) {
  const created = [];
  for (const payload of payloads) {
    const { expense } = await createExpense(user, payload);
    created.push(expense);
  }
  return created;
}

/**
 * Distinct categories the user has actually used, with counts — powers filter
 * chips in the client without a second round trip.
 */
async function getUsedCategories(user) {
  return Expense.aggregate([
    { $match: { user: toObjectId(user._id), isDeleted: false } },
    { $group: { _id: '$category', count: { $sum: 1 }, total: { $sum: '$amount' } } },
    { $project: { _id: 0, category: '$_id', count: 1, total: { $round: ['$total', 2] } } },
    { $sort: { total: -1 } },
  ]);
}

module.exports = {
  createExpense,
  createMany,
  listExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense,
  restoreExpense,
  getUsedCategories,
  buildFilter,
  present,
};
