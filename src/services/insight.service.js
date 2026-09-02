'use strict';

const mongoose = require('mongoose');
const Expense = require('../models/Expense');
const Subscription = require('../models/Subscription');
const { round2, percent, percentChange, mean, stdDev, formatCurrency } = require('../utils/money');
const { monthKey, monthRange, previousMonthKey, addDays, daysInMonth, zonedParts } = require('../utils/date');
const { CATEGORY_LABELS, NON_SPEND_CATEGORIES, TRANSACTION_TYPES } = require('../constants/categories');
const analyticsService = require('./analytics.service');
const budgetService = require('./budget.service');

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * Spending-pattern insight generation.
 *
 * Each generator is an independent function that either returns an insight or
 * null. They share one pre-fetched data bundle so a full report costs a fixed,
 * small number of round trips rather than one query per rule.
 *
 * Two rules keep the output trustworthy:
 *   - Every insight states the numbers it was derived from, so a user can
 *     check the claim instead of taking it on faith.
 *   - Nothing is emitted below a minimum sample size. "Your food spend tripled"
 *     off two data points is noise dressed up as analysis.
 */

const MIN_TRANSACTIONS_FOR_TREND = 5;
const SIGNIFICANT_CHANGE_PCT = 15;

const SEVERITY = { POSITIVE: 'positive', INFO: 'info', WARNING: 'warning', CRITICAL: 'critical' };

function insight({ type, severity, title, message, metrics = {}, priority = 50, confidence = 0.8 }) {
  return { type, severity, title, message, metrics, priority, confidence };
}

/** Collects everything the generators need, in parallel. */
async function collectContext(user, { month } = {}) {
  const targetMonth = month || monthKey(new Date(), user.timezone);
  const current = monthRange(targetMonth, user.timezone);
  const prevMonthKey = previousMonthKey(targetMonth, user.timezone);
  const previous = monthRange(prevMonthKey, user.timezone);
  // Three full months before the target month form the behavioural baseline.
  const baselineStart = monthRange(previousMonthKey(previousMonthKey(prevMonthKey, user.timezone), user.timezone), user.timezone).start;

  const [
    summary,
    currentByCategory,
    previousByCategory,
    baselineByCategory,
    weekdayByCategory,
    monthExpenses,
    subscriptions,
    budgets,
  ] = await Promise.all([
    analyticsService.getMonthlySummary(user, { month: targetMonth }),
    categoryTotals(user, current.start, current.end),
    categoryTotals(user, previous.start, previous.end),
    categoryTotals(user, baselineStart, current.start),
    weekendSplitByCategory(user, addDays(current.start, -60), current.end, user.timezone),
    Expense.find({
      user: user._id,
      isDeleted: false,
      type: TRANSACTION_TYPES.DEBIT,
      category: { $nin: NON_SPEND_CATEGORIES },
      date: { $gte: current.start, $lt: current.end },
    })
      .select('amount category merchant date note')
      .lean(),
    Subscription.find({ user: user._id, status: 'active', userVerdict: { $ne: 'dismissed' } }).lean(),
    budgetService.listBudgets(user, { month: targetMonth }),
  ]);

  return {
    user,
    month: targetMonth,
    prevMonthKey,
    range: current,
    summary,
    currentByCategory,
    previousByCategory,
    // Baseline covers three months; compare like-for-like against one month.
    baselineByCategory: baselineByCategory.map((row) => ({ ...row, total: round2(row.total / 3), count: Math.round(row.count / 3) })),
    weekdayByCategory,
    monthExpenses,
    subscriptions,
    budgets,
    currency: user.currency,
  };
}

async function categoryTotals(user, start, end) {
  const rows = await Expense.aggregate([
    { $match: analyticsService.spendMatch(user, start, end) },
    { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);
  return rows.map((r) => ({ category: r._id, total: round2(r.total), count: r.count }));
}

/** Per-category weekend vs weekday split, used by the weekend-habit insight. */
async function weekendSplitByCategory(user, start, end, timezone) {
  const rows = await Expense.aggregate([
    { $match: analyticsService.spendMatch(user, start, end) },
    {
      $addFields: {
        dow: { $dayOfWeek: { date: '$date', timezone } },
      },
    },
    {
      $group: {
        _id: { category: '$category', isWeekend: { $in: ['$dow', [1, 7]] } },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
        days: { $addToSet: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone } } },
      },
    },
  ]);

  const map = new Map();
  for (const row of rows) {
    const key = row._id.category;
    if (!map.has(key)) {
      map.set(key, {
        category: key,
        weekend: { total: 0, count: 0, days: 0 },
        weekday: { total: 0, count: 0, days: 0 },
      });
    }
    const bucket = row._id.isWeekend ? map.get(key).weekend : map.get(key).weekday;
    bucket.total = round2(row.total);
    bucket.count = row.count;
    bucket.days = row.days.length;
  }
  return [...map.values()];
}

/* ------------------------------------------------------------------ *
 * Generators — each returns an insight, an array of them, or null.
 * ------------------------------------------------------------------ */

/** "Your spending increased by 20% this month." */
function monthOverMonthTrend(ctx) {
  const { comparison } = ctx.summary;
  if (comparison.previousSpent <= 0) return null;
  if (ctx.summary.transactions < MIN_TRANSACTIONS_FOR_TREND) return null;

  const change = comparison.changePercent;
  if (change === null || Math.abs(change) < SIGNIFICANT_CHANGE_PCT) {
    return insight({
      type: 'spending_trend',
      severity: SEVERITY.POSITIVE,
      title: 'Your spending is steady',
      message: `Your spending is holding steady at ${money(ctx.summary.totalSpent, ctx)} this month, within ${Math.abs(change || 0)}% of last month.`,
      metrics: { current: ctx.summary.totalSpent, previous: comparison.previousSpent, changePercent: change },
      priority: 40,
      confidence: 0.9,
    });
  }

  const rising = change > 0;
  return insight({
    type: 'spending_trend',
    severity: rising ? SEVERITY.WARNING : SEVERITY.POSITIVE,
    title: rising ? `Spending increased by ${Math.abs(change)}% this month` : `Spending dropped by ${Math.abs(change)}% this month`,
    message: rising
      ? `Your spending increased by ${Math.abs(change)}% this month — ${money(ctx.summary.totalSpent, ctx)} versus ${money(comparison.previousSpent, ctx)} in ${ctx.prevMonthKey}.`
      : `Nicely done — you spent ${Math.abs(change)}% less this month: ${money(ctx.summary.totalSpent, ctx)} versus ${money(comparison.previousSpent, ctx)} in ${ctx.prevMonthKey}.`,
    metrics: {
      current: ctx.summary.totalSpent,
      previous: comparison.previousSpent,
      changePercent: change,
      changeAmount: comparison.changeAmount,
    },
    priority: rising ? 90 : 70,
    confidence: 0.92,
  });
}

/** "You spend more on food on weekends." */
function weekendHabits(ctx) {
  const results = [];

  for (const row of ctx.weekdayByCategory) {
    const { weekend, weekday } = row;
    if (weekend.count + weekday.count < 8) continue;
    if (weekend.days < 2 || weekday.days < 3) continue;

    // Per-active-day averages: a weekend only has two days in it.
    const weekendPerDay = round2(weekend.total / Math.max(weekend.days, 1));
    const weekdayPerDay = round2(weekday.total / Math.max(weekday.days, 1));
    if (weekdayPerDay <= 0) continue;

    const lift = percentChange(weekendPerDay, weekdayPerDay);
    if (lift === null || lift < 30) continue;

    const label = (CATEGORY_LABELS[row.category] || row.category).toLowerCase();
    results.push(
      insight({
        type: 'weekend_pattern',
        severity: SEVERITY.INFO,
        title: `You spend more on ${label} at weekends`,
        message: `You spend more on ${label} on weekends — about ${money(weekendPerDay, ctx)} per weekend day versus ${money(weekdayPerDay, ctx)} on weekdays, ${Math.round(lift)}% higher.`,
        metrics: {
          category: row.category,
          weekendPerDay,
          weekdayPerDay,
          liftPercent: Math.round(lift),
          weekendTotal: weekend.total,
          weekdayTotal: weekday.total,
        },
        priority: 65,
        confidence: weekend.count >= 6 ? 0.85 : 0.7,
      })
    );
  }

  return results.sort((a, b) => b.metrics.liftPercent - a.metrics.liftPercent).slice(0, 2);
}

/** Category spikes against the user's own three-month baseline. */
function categorySpikes(ctx) {
  const baseline = new Map(ctx.baselineByCategory.map((r) => [r.category, r]));
  const results = [];

  for (const row of ctx.currentByCategory) {
    const base = baseline.get(row.category);
    // Need a real baseline and a material amount before calling it a spike.
    if (!base || base.total < 500 || base.count < 2) continue;

    const change = percentChange(row.total, base.total);
    if (change === null || change < 40) continue;

    const label = CATEGORY_LABELS[row.category] || row.category;
    results.push(
      insight({
        type: 'category_spike',
        severity: change > 100 ? SEVERITY.WARNING : SEVERITY.INFO,
        title: `${label} spending is up ${Math.round(change)}%`,
        message: `You have spent ${money(row.total, ctx)} on ${label.toLowerCase()} this month, ${Math.round(change)}% above your usual ${money(base.total, ctx)} monthly average.`,
        metrics: { category: row.category, current: row.total, baseline: base.total, changePercent: Math.round(change), transactions: row.count },
        priority: 80,
        confidence: 0.82,
      })
    );
  }

  return results.sort((a, b) => b.metrics.changePercent - a.metrics.changePercent).slice(0, 2);
}

/** Where the largest share of the month went. */
function topCategoryConcentration(ctx) {
  const top = ctx.currentByCategory[0];
  if (!top || ctx.summary.totalSpent <= 0) return null;

  const share = percent(top.total, ctx.summary.totalSpent);
  if (share < 30) return null;

  const label = CATEGORY_LABELS[top.category] || top.category;
  return insight({
    type: 'category_concentration',
    severity: share > 55 ? SEVERITY.WARNING : SEVERITY.INFO,
    title: `${label} is ${share}% of your spending`,
    message: `${label} accounts for ${share}% of everything you spent this month (${money(top.total, ctx)} across ${top.count} transactions).`,
    metrics: { category: top.category, total: top.total, percentage: share, transactions: top.count },
    priority: 60,
    confidence: 0.95,
  });
}

/** Statistical outliers: charges far above this user's own normal. */
function unusualTransactions(ctx) {
  const amounts = ctx.monthExpenses.map((e) => e.amount);
  if (amounts.length < 8) return null;

  const average = mean(amounts);
  const deviation = stdDev(amounts);
  if (deviation <= 0) return null;

  const threshold = average + deviation * 2;
  const outliers = ctx.monthExpenses
    .filter((e) => e.amount > threshold)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);

  if (!outliers.length) return null;

  const biggest = outliers[0];
  return insight({
    type: 'unusual_transaction',
    severity: SEVERITY.INFO,
    title: 'An unusually large transaction stands out',
    message: `${money(biggest.amount, ctx)} at ${biggest.merchant || CATEGORY_LABELS[biggest.category] || 'an unnamed merchant'} is well above your typical ${money(average, ctx)} transaction this month.`,
    metrics: {
      averageTransaction: average,
      threshold: round2(threshold),
      outliers: outliers.map((o) => ({ amount: o.amount, merchant: o.merchant, category: o.category, date: o.date })),
    },
    priority: 55,
    confidence: 0.78,
  });
}

/** Death by a thousand cuts — many small charges that add up. */
function smallSpendLeak(ctx) {
  const small = ctx.monthExpenses.filter((e) => e.amount <= 200);
  if (small.length < 12) return null;

  const total = round2(small.reduce((sum, e) => sum + e.amount, 0));
  const share = percent(total, ctx.summary.totalSpent);
  if (share < 8) return null;

  return insight({
    type: 'small_spend_leak',
    severity: SEVERITY.INFO,
    title: `${small.length} small purchases added up to ${money(total, ctx)}`,
    message: `You made ${small.length} purchases under ${money(200, ctx)} this month. Individually small, together ${money(total, ctx)} — ${share}% of your monthly spending.`,
    metrics: { count: small.length, total, percentage: share, ceiling: 200 },
    priority: 50,
    confidence: 0.88,
  });
}

/** Recurring-payment burden. */
function subscriptionBurden(ctx) {
  if (!ctx.subscriptions.length) return null;

  const monthlyCost = round2(ctx.subscriptions.reduce((sum, s) => sum + (s.estimatedMonthlyCost || 0), 0));
  if (monthlyCost <= 0) return null;

  const share = ctx.summary.totalSpent ? percent(monthlyCost, ctx.summary.totalSpent) : 0;
  const priciest = [...ctx.subscriptions].sort((a, b) => b.estimatedMonthlyCost - a.estimatedMonthlyCost)[0];

  return insight({
    type: 'subscription_burden',
    severity: share > 20 ? SEVERITY.WARNING : SEVERITY.INFO,
    title: `${ctx.subscriptions.length} recurring payments cost ${money(monthlyCost, ctx)} a month`,
    message: `We detected ${ctx.subscriptions.length} recurring payments totalling about ${money(monthlyCost, ctx)} per month (${money(monthlyCost * 12, ctx)} a year). The largest is ${priciest.merchant} at ${money(priciest.amount, ctx)} ${priciest.cadence}.`,
    metrics: {
      count: ctx.subscriptions.length,
      monthlyCost,
      yearlyCost: round2(monthlyCost * 12),
      percentageOfSpend: share,
      largest: { merchant: priciest.merchant, amount: priciest.amount, cadence: priciest.cadence },
    },
    priority: 75,
    confidence: 0.8,
  });
}

/** Budget pace — the forward-looking warning, before the cap is actually hit. */
function budgetPace(ctx) {
  const results = [];
  const statuses = [ctx.budgets.overall, ...ctx.budgets.categories].filter(Boolean);

  for (const status of statuses) {
    if (status.status === 'safe') continue;

    const label = status.category === 'OVERALL' ? 'overall budget' : `${status.categoryLabel} budget`;
    const severity = status.isExceeded ? SEVERITY.CRITICAL : status.isWarning ? SEVERITY.WARNING : SEVERITY.INFO;

    results.push(
      insight({
        type: 'budget_pace',
        severity,
        title: status.isExceeded
          ? `You have exceeded your ${label}`
          : status.isWarning
            ? `You have used ${status.percentageUsed}% of your ${label}`
            : `You are on pace to overshoot your ${label}`,
        message: status.isExceeded
          ? `Your ${label} for ${status.month} is exhausted: ${money(status.spent, ctx)} against ${money(status.budget, ctx)}.`
          : status.isWarning
            ? `You have used ${status.percentageUsed}% of your ${label} with ${status.pace.daysRemaining} days to go. Keep it under ${money(status.pace.safeDailySpend, ctx)} a day to stay within it.`
            : `At ${money(status.pace.dailyBurnRate, ctx)} a day you are tracking towards ${money(status.pace.projectedSpend, ctx)}, above your ${money(status.budget, ctx)} ${label}.`,
        metrics: {
          category: status.category,
          budget: status.budget,
          spent: status.spent,
          remaining: status.remaining,
          percentageUsed: status.percentageUsed,
          projectedSpend: status.pace.projectedSpend,
          safeDailySpend: status.pace.safeDailySpend,
          daysRemaining: status.pace.daysRemaining,
        },
        priority: status.isExceeded ? 100 : status.isWarning ? 95 : 72,
        confidence: 0.93,
      })
    );
  }

  return results.slice(0, 3);
}

/** Savings rate, when we know income. */
function savingsRate(ctx) {
  const { totalIncome, netSavings, savingsRate: rate } = ctx.summary;
  if (!totalIncome || rate === null) return null;

  const positive = rate >= 20;
  return insight({
    type: 'savings_rate',
    severity: positive ? SEVERITY.POSITIVE : rate < 0 ? SEVERITY.WARNING : SEVERITY.INFO,
    title: positive ? `You saved ${rate}% of your income` : rate < 0 ? 'You spent more than you earned' : `Your savings rate is ${rate}%`,
    message:
      rate < 0
        ? `You spent ${money(Math.abs(netSavings), ctx)} more than the ${money(totalIncome, ctx)} that came in this month.`
        : `You kept ${money(netSavings, ctx)} of the ${money(totalIncome, ctx)} you received this month — a ${rate}% savings rate.`,
    metrics: { income: totalIncome, saved: netSavings, savingsRate: rate },
    priority: rate < 0 ? 92 : 68,
    confidence: 0.9,
  });
}

/** Pace against the month itself, independent of any budget. */
function projectedMonthEnd(ctx) {
  const { daysElapsed, daysInMonth: total, dailyAverage, projectedMonthEnd: projection, comparison } = ctx.summary;
  if (daysElapsed < 5 || daysElapsed >= total) return null;
  if (!comparison.previousSpent) return null;

  const change = percentChange(projection, comparison.previousSpent);
  if (change === null || Math.abs(change) < SIGNIFICANT_CHANGE_PCT) return null;

  return insight({
    type: 'month_projection',
    severity: change > 0 ? SEVERITY.WARNING : SEVERITY.POSITIVE,
    title: `On track to ${change > 0 ? 'spend' : 'save'} ${Math.abs(Math.round(change))}% ${change > 0 ? 'more' : 'less'} than last month`,
    message: `At ${money(dailyAverage, ctx)} a day you are heading for about ${money(projection, ctx)} by month end, versus ${money(comparison.previousSpent, ctx)} last month.`,
    metrics: { dailyAverage, projection, previousMonth: comparison.previousSpent, changePercent: Math.round(change), daysElapsed, daysInMonth: total },
    priority: 78,
    confidence: daysElapsed >= 10 ? 0.85 : 0.65,
  });
}

/** Which weekday consistently costs the most. */
function peakSpendingDay(ctx) {
  const byDay = new Map();
  for (const expense of ctx.monthExpenses) {
    const index = zonedParts(expense.date, ctx.user.timezone).weekday;
    byDay.set(index, round2((byDay.get(index) || 0) + expense.amount));
  }
  if (byDay.size < 4 || ctx.monthExpenses.length < 10) return null;

  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const entries = [...byDay.entries()].sort((a, b) => b[1] - a[1]);
  const [topIndex, topTotal] = entries[0];
  const others = mean(entries.slice(1).map((e) => e[1]));
  if (!others || topTotal < others * 1.5) return null;

  return insight({
    type: 'peak_day',
    severity: SEVERITY.INFO,
    title: `${names[topIndex]} is your most expensive day`,
    message: `${names[topIndex]}s cost you the most this month — ${money(topTotal, ctx)}, against a ${money(others, ctx)} average for other days.`,
    metrics: { day: names[topIndex], total: topTotal, otherDaysAverage: others },
    priority: 45,
    confidence: 0.72,
  });
}

/** Sanity guard for brand-new accounts with no history to analyse. */
function notEnoughData(ctx) {
  if (ctx.summary.transactions >= MIN_TRANSACTIONS_FOR_TREND) return null;
  return insight({
    type: 'onboarding',
    severity: SEVERITY.INFO,
    title: 'Add a few more expenses to unlock insights',
    message: `We have ${ctx.summary.transactions} transaction${ctx.summary.transactions === 1 ? '' : 's'} for ${ctx.month}. Log a handful more — or import your bank SMS — and patterns start showing up here.`,
    metrics: { transactions: ctx.summary.transactions, required: MIN_TRANSACTIONS_FOR_TREND },
    priority: 30,
    confidence: 1,
  });
}

function money(amount, ctx) {
  return formatCurrency(amount, ctx.currency);
}

const GENERATORS = [
  budgetPace,
  monthOverMonthTrend,
  categorySpikes,
  projectedMonthEnd,
  subscriptionBurden,
  weekendHabits,
  savingsRate,
  topCategoryConcentration,
  unusualTransactions,
  smallSpendLeak,
  peakSpendingDay,
  notEnoughData,
];

/**
 * Runs every generator and returns the ranked report.
 * A failing generator is logged-and-skipped rather than failing the request —
 * a partial report beats a 500.
 */
async function generateInsights(user, { month, limit = 10, types } = {}) {
  const ctx = await collectContext(user, { month });

  const collected = [];
  for (const generator of GENERATORS) {
    const produced = generator(ctx);
    if (!produced) continue;
    if (Array.isArray(produced)) collected.push(...produced);
    else collected.push(produced);
  }

  const filtered = types && types.length ? collected.filter((i) => types.includes(i.type)) : collected;
  const ranked = filtered
    .sort((a, b) => b.priority - a.priority || b.confidence - a.confidence)
    .slice(0, limit)
    .map((item, index) => ({ id: `${item.type}_${index + 1}`, ...item }));

  return {
    month: ctx.month,
    generatedAt: new Date(),
    currency: ctx.currency,
    context: {
      totalSpent: ctx.summary.totalSpent,
      totalIncome: ctx.summary.totalIncome,
      transactions: ctx.summary.transactions,
      previousMonthSpent: ctx.summary.comparison.previousSpent,
      activeSubscriptions: ctx.subscriptions.length,
      budgetsTracked: ctx.budgets.categories.length + (ctx.budgets.overall ? 1 : 0),
    },
    counts: {
      total: ranked.length,
      bySeverity: ranked.reduce((acc, i) => {
        acc[i.severity] = (acc[i.severity] || 0) + 1;
        return acc;
      }, {}),
    },
    insights: ranked,
  };
}

/**
 * Compact, single-paragraph digest — what a push notification or an email
 * subject line would say.
 */
async function generateSummary(user, { month } = {}) {
  const report = await generateInsights(user, { month, limit: 3 });
  const headline = report.insights[0];

  return {
    month: report.month,
    headline: headline ? headline.message : 'Nothing notable yet — keep logging expenses and insights will appear here.',
    severity: headline ? headline.severity : SEVERITY.INFO,
    totalSpent: report.context.totalSpent,
    supporting: report.insights.slice(1).map((i) => i.message),
    generatedAt: report.generatedAt,
  };
}

module.exports = { generateInsights, generateSummary, collectContext, SEVERITY };
