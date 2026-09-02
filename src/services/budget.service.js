'use strict';

const mongoose = require('mongoose');
const Budget = require('../models/Budget');
const Expense = require('../models/Expense');
const ApiError = require('../utils/ApiError');
const { round2, percent, formatCurrency } = require('../utils/money');
const { monthKey, monthRange, daysInMonth, zonedParts } = require('../utils/date');
const { CATEGORY_LABELS, NON_SPEND_CATEGORIES, TRANSACTION_TYPES } = require('../constants/categories');
const notificationService = require('./notification.service');
const config = require('../config/env');

const { OVERALL } = Budget;

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * Spend actually charged against a budget.
 *
 * Only debits count, and the OVERALL cap ignores transfers/investments/income —
 * moving money between your own pockets is not consumption. A cap set directly
 * on one of those categories is honoured, because that is an explicit choice.
 */
function spendMatch(userId, start, end, category) {
  const match = {
    user: toObjectId(userId),
    isDeleted: false,
    type: TRANSACTION_TYPES.DEBIT,
    date: { $gte: start, $lt: end },
  };
  if (category === OVERALL) match.category = { $nin: NON_SPEND_CATEGORIES };
  else match.category = category;
  return match;
}

async function sumSpend(userId, start, end, category) {
  const [row] = await Expense.aggregate([
    { $match: spendMatch(userId, start, end, category) },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  return { total: round2(row ? row.total : 0), count: row ? row.count : 0 };
}

/** Creates or updates the cap for a month/category pair. */
async function setBudget(user, payload) {
  const month = payload.month || monthKey(new Date(), user.timezone);
  const category = payload.category || OVERALL;

  const budget = await Budget.findOneAndUpdate(
    { user: user._id, month, category },
    {
      $set: {
        amount: payload.amount,
        currency: payload.currency || user.currency,
        alertThreshold: payload.alertThreshold ?? user.preferences.budgetAlertThreshold ?? config.budgetAlertThreshold,
        alertsEnabled: payload.alertsEnabled ?? true,
        note: payload.note || '',
        autoRenew: payload.autoRenew ?? true,
      },
      // Raising a cap should let the user be warned again on the new scale.
      $setOnInsert: { user: user._id, month, category },
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );

  await Budget.updateOne(
    { _id: budget._id },
    { $set: { 'lastAlert.level': 'none', 'lastAlert.percentage': 0, 'lastAlert.sentAt': null } }
  );
  budget.lastAlert = { level: 'none', percentage: 0, sentAt: null };

  return computeStatus(user, budget);
}

/** Derives usage, pace and alert level for a single budget. */
async function computeStatus(user, budget) {
  const { start, end } = monthRange(budget.month, user.timezone);
  const { total: spent, count } = await sumSpend(user._id, start, end, budget.category);

  const remaining = round2(budget.amount - spent);
  const percentageUsed = percent(spent, budget.amount);
  const thresholdPct = Math.round((budget.alertThreshold || config.budgetAlertThreshold) * 100);

  const now = new Date();
  const totalDays = daysInMonth(start, user.timezone);
  // Clamp so a past month reports a full month and a future month reports day 1.
  const dayOfMonth = now < start ? 1 : now >= end ? totalDays : zonedParts(now, user.timezone).day;
  const daysRemaining = Math.max(totalDays - dayOfMonth, 0);

  const dailyBurnRate = round2(spent / dayOfMonth);
  const projectedSpend = round2(dailyBurnRate * totalDays);
  // "Ideal" pace = spending the cap evenly across the month.
  const paceRatio = budget.amount ? round2(spent / ((budget.amount / totalDays) * dayOfMonth)) : 0;

  let level = 'safe';
  if (percentageUsed >= 100) level = 'exceeded';
  else if (percentageUsed >= thresholdPct) level = 'warning';
  else if (projectedSpend > budget.amount) level = 'on-track-to-exceed';

  return {
    id: budget._id,
    month: budget.month,
    category: budget.category,
    categoryLabel: budget.category === OVERALL ? 'Overall' : CATEGORY_LABELS[budget.category],
    currency: budget.currency,
    budget: round2(budget.amount),
    spent,
    remaining,
    transactions: count,
    percentageUsed,
    alertThreshold: thresholdPct,
    alertsEnabled: budget.alertsEnabled,
    status: level,
    isExceeded: percentageUsed >= 100,
    isWarning: percentageUsed >= thresholdPct,
    pace: {
      dayOfMonth,
      totalDays,
      daysRemaining,
      dailyBurnRate,
      projectedSpend,
      // What you can still spend per remaining day without breaching the cap.
      safeDailySpend: daysRemaining > 0 ? round2(Math.max(remaining, 0) / daysRemaining) : 0,
      paceRatio,
      onTrack: projectedSpend <= budget.amount,
    },
    message: buildStatusMessage(level, percentageUsed, remaining, budget, thresholdPct),
    lastAlert: budget.lastAlert,
    note: budget.note,
  };
}

function buildStatusMessage(level, percentageUsed, remaining, budget, thresholdPct) {
  const money = (v) => formatCurrency(v, budget.currency);
  if (level === 'exceeded') {
    return `Budget exceeded by ${money(Math.abs(remaining))} (${percentageUsed}% used).`;
  }
  if (level === 'warning') {
    return `You have crossed the ${thresholdPct}% warning mark — ${money(remaining)} left for the rest of ${budget.month}.`;
  }
  if (level === 'on-track-to-exceed') {
    return `Spending is ahead of schedule; at this pace you will overshoot this budget. ${money(remaining)} remaining.`;
  }
  return `On track — ${money(remaining)} of ${money(budget.amount)} still available.`;
}

async function listBudgets(user, { month } = {}) {
  const targetMonth = month || monthKey(new Date(), user.timezone);
  const budgets = await Budget.find({ user: user._id, month: targetMonth }).sort({ category: 1 });
  const statuses = await Promise.all(budgets.map((b) => computeStatus(user, b)));

  // Overall first, then categories by spend.
  statuses.sort((a, b) => {
    if (a.category === OVERALL) return -1;
    if (b.category === OVERALL) return 1;
    return b.spent - a.spent;
  });

  const overall = statuses.find((s) => s.category === OVERALL) || null;
  const categories = statuses.filter((s) => s.category !== OVERALL);

  return {
    month: targetMonth,
    overall,
    categories,
    summary: {
      totalBudgeted: round2(statuses.reduce((sum, s) => sum + (s.category === OVERALL ? 0 : s.budget), 0)),
      totalSpentAgainstCategories: round2(categories.reduce((sum, s) => sum + s.spent, 0)),
      budgetsAtWarning: statuses.filter((s) => s.isWarning && !s.isExceeded).length,
      budgetsExceeded: statuses.filter((s) => s.isExceeded).length,
    },
  };
}

async function getBudget(user, budgetId) {
  const budget = await Budget.findOne({ _id: budgetId, user: user._id });
  if (!budget) throw ApiError.notFound('Budget not found');
  return computeStatus(user, budget);
}

async function deleteBudget(user, budgetId) {
  const budget = await Budget.findOneAndDelete({ _id: budgetId, user: user._id });
  if (!budget) throw ApiError.notFound('Budget not found');
  return { id: budget._id, month: budget.month, category: budget.category };
}

/**
 * Re-evaluates the budgets an expense touches and emits any newly crossed
 * alert. Alerts are edge-triggered: `lastAlert.level` is persisted so the user
 * is warned once at 80% rather than on every subsequent purchase.
 *
 * Called after a write, and deliberately non-fatal — a notification failure
 * must never roll back a recorded expense.
 */
async function evaluateBudgetsForExpense(user, expense) {
  if (!expense || expense.type !== TRANSACTION_TYPES.DEBIT || expense.isDeleted) return [];

  const month = monthKey(expense.date, user.timezone);
  // A non-spend category (transfer/investment/income) never moves the OVERALL
  // cap, so only its own explicit budget — if any — is re-evaluated.
  const countsTowardOverall = !NON_SPEND_CATEGORIES.includes(expense.category);
  const candidates = countsTowardOverall ? [OVERALL, expense.category] : [expense.category];

  const budgets = await Budget.find({
    user: user._id,
    month,
    category: { $in: candidates },
    alertsEnabled: true,
  });
  if (!budgets.length) return [];

  const alerts = [];

  for (const budget of budgets) {
    const status = await computeStatus(user, budget);
    const level = status.isExceeded ? 'exceeded' : status.isWarning ? 'warning' : 'none';
    const previous = budget.lastAlert ? budget.lastAlert.level : 'none';

    // Only escalations notify: none -> warning -> exceeded.
    const rank = { none: 0, warning: 1, exceeded: 2 };
    if (rank[level] <= rank[previous]) continue;

    const notification = {
      userId: user._id,
      level,
      month: budget.month,
      category: budget.category,
      categoryLabel: status.categoryLabel,
      budget: status.budget,
      spent: status.spent,
      remaining: status.remaining,
      percentage: status.percentageUsed,
      threshold: status.alertThreshold,
      message: notificationService.buildMessage({
        level,
        budget,
        spent: status.spent,
        percentage: status.percentageUsed,
        currency: budget.currency,
      }),
    };

    await Budget.updateOne(
      { _id: budget._id },
      { $set: { 'lastAlert.level': level, 'lastAlert.percentage': status.percentageUsed, 'lastAlert.sentAt': new Date() } }
    );

    if (user.preferences.alertsEnabled !== false) await notificationService.deliver(notification);
    alerts.push(notification);
  }

  return alerts;
}

/** Copies this month's auto-renewing caps into the next month, skipping existing ones. */
async function rolloverBudgets(user, { fromMonth, toMonth }) {
  const source = fromMonth || monthKey(new Date(), user.timezone);
  const target = toMonth || monthKey(monthRange(source, user.timezone).end, user.timezone);

  const budgets = await Budget.find({ user: user._id, month: source, autoRenew: true }).lean();
  if (!budgets.length) return { from: source, to: target, created: 0 };

  const operations = budgets.map((b) => ({
    updateOne: {
      filter: { user: user._id, month: target, category: b.category },
      update: {
        $setOnInsert: {
          user: user._id,
          month: target,
          category: b.category,
          amount: b.amount,
          currency: b.currency,
          alertThreshold: b.alertThreshold,
          alertsEnabled: b.alertsEnabled,
          autoRenew: b.autoRenew,
          note: b.note,
        },
      },
      upsert: true,
    },
  }));

  const result = await Budget.bulkWrite(operations, { ordered: false });
  return { from: source, to: target, created: result.upsertedCount || 0 };
}

module.exports = {
  setBudget,
  listBudgets,
  getBudget,
  deleteBudget,
  computeStatus,
  evaluateBudgetsForExpense,
  rolloverBudgets,
  sumSpend,
  OVERALL,
};
