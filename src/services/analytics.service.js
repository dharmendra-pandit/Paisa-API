'use strict';

const mongoose = require('mongoose');
const Expense = require('../models/Expense');
const { round2, percent, percentChange, mean } = require('../utils/money');
const {
  monthKey,
  monthRange,
  previousMonthKey,
  startOfDay,
  endOfDay,
  addDays,
  daysInMonth,
  zonedParts,
  dayKey,
} = require('../utils/date');
const {
  CATEGORIES,
  CATEGORY_LABELS,
  NON_SPEND_CATEGORIES,
  TRANSACTION_TYPES,
} = require('../constants/categories');

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * Read-only spending analytics.
 *
 * Every aggregation buckets by the *user's* timezone (via `$dateToString`'s
 * timezone option) rather than UTC — a late-night Sunday dinner in IST must
 * report as Sunday, not Monday.
 */

/** Base match for "money the user actually burned". */
function spendMatch(user, start, end, { includeNonSpend = false } = {}) {
  const match = {
    user: toObjectId(user._id),
    isDeleted: false,
    type: TRANSACTION_TYPES.DEBIT,
    date: { $gte: start, $lt: end },
  };
  if (!includeNonSpend) match.category = { $nin: NON_SPEND_CATEGORIES };
  return match;
}

/** Resolves month / startDate / endDate query shapes into one window. */
function resolveRange(user, query = {}) {
  if (query.month) {
    const { start, end, key } = monthRange(query.month, user.timezone);
    return { start, end, label: key, granularityHint: 'day' };
  }
  if (query.startDate || query.endDate) {
    const start = query.startDate ? startOfDay(query.startDate, user.timezone) : addDays(new Date(), -30);
    // Exclusive upper bound derived from an inclusive end date.
    const end = query.endDate ? new Date(endOfDay(query.endDate, user.timezone).getTime() + 1) : new Date();
    return { start, end, label: `${dayKey(start, user.timezone)}..${dayKey(addDays(end, -1), user.timezone)}`, granularityHint: 'day' };
  }
  const { start, end, key } = monthRange(monthKey(new Date(), user.timezone), user.timezone);
  return { start, end, label: key, granularityHint: 'day' };
}

async function totalsFor(user, start, end) {
  const [row] = await Expense.aggregate([
    {
      $match: {
        user: toObjectId(user._id),
        isDeleted: false,
        date: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: null,
        spent: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$type', TRANSACTION_TYPES.DEBIT] }, { $not: [{ $in: ['$category', NON_SPEND_CATEGORIES] }] }] },
              '$amount',
              0,
            ],
          },
        },
        income: {
          $sum: { $cond: [{ $eq: ['$type', TRANSACTION_TYPES.CREDIT] }, '$amount', 0] },
        },
        invested: {
          $sum: {
            $cond: [
              // Only money *sent* to investments. Income and transfers are
              // non-spend as well, but neither of them is saving.
              { $and: [{ $eq: ['$type', TRANSACTION_TYPES.DEBIT] }, { $eq: ['$category', CATEGORIES.INVESTMENTS] }] },
              '$amount',
              0,
            ],
          },
        },
        transactions: { $sum: 1 },
        spendTransactions: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$type', TRANSACTION_TYPES.DEBIT] }, { $not: [{ $in: ['$category', NON_SPEND_CATEGORIES] }] }] },
              1,
              0,
            ],
          },
        },
        largest: { $max: { $cond: [{ $eq: ['$type', TRANSACTION_TYPES.DEBIT] }, '$amount', 0] } },
      },
    },
  ]);

  if (!row) {
    return { spent: 0, income: 0, invested: 0, transactions: 0, spendTransactions: 0, largest: 0 };
  }
  return {
    spent: round2(row.spent),
    income: round2(row.income),
    invested: round2(row.invested),
    transactions: row.transactions,
    spendTransactions: row.spendTransactions,
    largest: round2(row.largest),
  };
}

/** Headline numbers for a month, with month-over-month comparison. */
async function getMonthlySummary(user, { month } = {}) {
  const targetMonth = month || monthKey(new Date(), user.timezone);
  const { start, end } = monthRange(targetMonth, user.timezone);
  const prevMonth = previousMonthKey(targetMonth, user.timezone);
  const prevRange = monthRange(prevMonth, user.timezone);

  const [current, previous, topCategories] = await Promise.all([
    totalsFor(user, start, end),
    totalsFor(user, prevRange.start, prevRange.end),
    getCategoryBreakdown(user, { month: targetMonth, limit: 3 }),
  ]);

  const now = new Date();
  const totalDays = daysInMonth(start, user.timezone);
  const elapsedDays = now >= end ? totalDays : now < start ? 0 : zonedParts(now, user.timezone).day;
  const dailyAverage = elapsedDays > 0 ? round2(current.spent / elapsedDays) : 0;

  return {
    month: targetMonth,
    currency: user.currency,
    totalSpent: current.spent,
    totalIncome: current.income,
    totalInvested: current.invested,
    netSavings: round2(current.income - current.spent - current.invested),
    savingsRate: current.income ? percent(current.income - current.spent - current.invested, current.income) : null,
    transactions: current.transactions,
    averageTransaction: current.spendTransactions ? round2(current.spent / current.spendTransactions) : 0,
    largestExpense: current.largest,
    dailyAverage,
    projectedMonthEnd: elapsedDays > 0 && now < end ? round2(dailyAverage * totalDays) : current.spent,
    daysElapsed: elapsedDays,
    daysInMonth: totalDays,
    comparison: {
      previousMonth: prevMonth,
      previousSpent: previous.spent,
      changeAmount: round2(current.spent - previous.spent),
      changePercent: percentChange(current.spent, previous.spent),
      direction: current.spent === previous.spent ? 'flat' : current.spent > previous.spent ? 'up' : 'down',
    },
    topCategories: topCategories.categories,
  };
}

/** Category-wise breakdown with share of total and per-category averages. */
async function getCategoryBreakdown(user, query = {}) {
  const { start, end, label } = resolveRange(user, query);

  const rows = await Expense.aggregate([
    { $match: spendMatch(user, start, end, { includeNonSpend: query.includeNonSpend === true }) },
    {
      $group: {
        _id: '$category',
        total: { $sum: '$amount' },
        count: { $sum: 1 },
        average: { $avg: '$amount' },
        largest: { $max: '$amount' },
        lastSpentAt: { $max: '$date' },
      },
    },
    { $sort: { total: -1 } },
  ]);

  const grandTotal = round2(rows.reduce((sum, r) => sum + r.total, 0));
  const limited = query.limit ? rows.slice(0, query.limit) : rows;

  return {
    range: { start, end, label },
    currency: user.currency,
    totalSpent: grandTotal,
    categories: limited.map((row) => ({
      category: row._id,
      label: CATEGORY_LABELS[row._id] || row._id,
      total: round2(row.total),
      percentage: percent(row.total, grandTotal),
      count: row.count,
      average: round2(row.average),
      largest: round2(row.largest),
      lastSpentAt: row.lastSpentAt,
    })),
  };
}

const GRANULARITY_FORMAT = { day: '%Y-%m-%d', week: '%G-W%V', month: '%Y-%m' };

/**
 * Time series of spend. Buckets with no spending are back-filled with zeros for
 * `day`, because a chart with holes misrepresents a quiet week as a short one.
 */
async function getTrends(user, query = {}) {
  const granularity = query.granularity || 'day';
  const { start, end, label } = resolveRange(user, query);

  const rows = await Expense.aggregate([
    { $match: spendMatch(user, start, end) },
    {
      $group: {
        _id: { $dateToString: { format: GRANULARITY_FORMAT[granularity], date: '$date', timezone: user.timezone } },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const byKey = new Map(rows.map((r) => [r._id, r]));
  const series = granularity === 'day' ? fillDailySeries(user, start, end, byKey) : rows.map(toPoint);

  const values = series.map((p) => p.total);
  const nonZero = values.filter((v) => v > 0);
  const peak = series.reduce((best, p) => (!best || p.total > best.total ? p : best), null);

  return {
    granularity,
    range: { start, end, label },
    currency: user.currency,
    series,
    stats: {
      total: round2(values.reduce((a, b) => a + b, 0)),
      average: round2(mean(values)),
      averageActiveBucket: round2(mean(nonZero)),
      peak: peak ? { period: peak.period, total: peak.total } : null,
      activeBuckets: nonZero.length,
      buckets: series.length,
      // A simple first-half vs second-half comparison reads as "trending up/down".
      direction: describeDirection(values),
    },
  };
}

function toPoint(row) {
  return { period: row._id, total: round2(row.total), count: row.count };
}

function fillDailySeries(user, start, end, byKey) {
  const series = [];
  const limit = new Date(end.getTime() - 1);
  for (let cursor = new Date(start); cursor <= limit; cursor = addDays(cursor, 1)) {
    const key = dayKey(cursor, user.timezone);
    const row = byKey.get(key);
    series.push({
      period: key,
      total: row ? round2(row.total) : 0,
      count: row ? row.count : 0,
      isWeekend: [0, 6].includes(zonedParts(cursor, user.timezone).weekday),
    });
    // Guard against runaway ranges on a very wide filter.
    if (series.length > 400) break;
  }
  return series;
}

function describeDirection(values) {
  if (values.length < 4) return 'insufficient-data';
  const mid = Math.floor(values.length / 2);
  const first = mean(values.slice(0, mid));
  const second = mean(values.slice(mid));
  const change = percentChange(second, first);
  if (change === null) return 'insufficient-data';
  if (Math.abs(change) < 10) return 'stable';
  return change > 0 ? 'rising' : 'falling';
}

/** Spend by day-of-week, aggregated across the range. Feeds the weekend insight. */
async function getWeekdayPattern(user, query = {}) {
  const { start, end, label } = resolveRange(user, query);

  const rows = await Expense.aggregate([
    { $match: spendMatch(user, start, end) },
    {
      $group: {
        // $dayOfWeek is 1=Sunday..7=Saturday in the given timezone.
        _id: { $dayOfWeek: { date: '$date', timezone: user.timezone } },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const byIndex = new Map(rows.map((r) => [r._id - 1, r]));

  const days = names.map((name, index) => {
    const row = byIndex.get(index);
    return {
      day: name,
      dayIndex: index,
      isWeekend: index === 0 || index === 6,
      total: row ? round2(row.total) : 0,
      count: row ? row.count : 0,
      average: row && row.count ? round2(row.total / row.count) : 0,
    };
  });

  const weekendTotal = round2(days.filter((d) => d.isWeekend).reduce((s, d) => s + d.total, 0));
  const weekdayTotal = round2(days.filter((d) => !d.isWeekend).reduce((s, d) => s + d.total, 0));

  // Per-day averages need the real number of calendar days in the window: a
  // month holds roughly nine weekend days, not two, and dividing by a single
  // week's worth would overstate weekend spending several times over.
  const { weekendDays, weekdayDays } = countCalendarDays(user, start, end);

  return {
    range: { start, end, label },
    days,
    weekendVsWeekday: {
      weekendTotal,
      weekdayTotal,
      weekendDays,
      weekdayDays,
      weekendDailyAverage: weekendDays ? round2(weekendTotal / weekendDays) : 0,
      weekdayDailyAverage: weekdayDays ? round2(weekdayTotal / weekdayDays) : 0,
      weekendShare: percent(weekendTotal, weekendTotal + weekdayTotal),
    },
  };
}

/** Counts weekend and weekday calendar days in [start, end), in the user's timezone. */
function countCalendarDays(user, start, end) {
  let weekendDays = 0;
  let weekdayDays = 0;
  const limit = new Date(end.getTime() - 1);

  for (let cursor = new Date(start); cursor <= limit; cursor = addDays(cursor, 1)) {
    const weekday = zonedParts(cursor, user.timezone).weekday;
    if (weekday === 0 || weekday === 6) weekendDays += 1;
    else weekdayDays += 1;
    // Same guard as the daily series: never walk an unbounded range.
    if (weekendDays + weekdayDays > 400) break;
  }

  return { weekendDays, weekdayDays };
}

/** Merchants ranked by spend — "where is the money actually going". */
async function getTopMerchants(user, query = {}) {
  const { start, end, label } = resolveRange(user, query);
  const limit = query.limit || 10;

  const rows = await Expense.aggregate([
    { $match: { ...spendMatch(user, start, end), merchantKey: { $nin: ['', null] } } },
    {
      $group: {
        _id: '$merchantKey',
        merchant: { $last: '$merchant' },
        category: { $last: '$category' },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
        lastSpentAt: { $max: '$date' },
      },
    },
    { $sort: { total: -1 } },
    { $limit: limit },
  ]);

  const grandTotal = round2(rows.reduce((s, r) => s + r.total, 0));

  return {
    range: { start, end, label },
    merchants: rows.map((row) => ({
      merchant: row.merchant || row._id,
      merchantKey: row._id,
      category: row.category,
      total: round2(row.total),
      count: row.count,
      average: round2(row.total / row.count),
      percentage: percent(row.total, grandTotal),
      lastSpentAt: row.lastSpentAt,
    })),
  };
}

/** One call that backs a home screen, so the app does not fan out six requests. */
async function getDashboard(user) {
  const month = monthKey(new Date(), user.timezone);

  const [summary, breakdown, trends, merchants, recent] = await Promise.all([
    getMonthlySummary(user, { month }),
    getCategoryBreakdown(user, { month, limit: 6 }),
    getTrends(user, { month, granularity: 'day' }),
    getTopMerchants(user, { month, limit: 5 }),
    Expense.find({ user: user._id, isDeleted: false }).sort({ date: -1 }).limit(5).lean(),
  ]);

  return {
    month,
    summary,
    categories: breakdown.categories,
    dailyTrend: trends.series,
    trendStats: trends.stats,
    topMerchants: merchants.merchants,
    recentTransactions: recent.map((doc) => ({ ...doc, id: doc._id, _id: undefined })),
  };
}

module.exports = {
  getMonthlySummary,
  getCategoryBreakdown,
  getTrends,
  getWeekdayPattern,
  getTopMerchants,
  getDashboard,
  totalsFor,
  resolveRange,
  spendMatch,
};
