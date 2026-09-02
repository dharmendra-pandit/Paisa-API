'use strict';

const { connectDB, disconnectDB } = require('../config/db');
const User = require('../models/User');
const Expense = require('../models/Expense');
const Budget = require('../models/Budget');
const Subscription = require('../models/Subscription');
const Group = require('../models/Group');
const SplitExpense = require('../models/SplitExpense');
const Settlement = require('../models/Settlement');
const logger = require('../utils/logger');
const { round2 } = require('../utils/money');
const { monthKey, monthRange, addMonths, fromZoned, zonedParts, daysInMonth, isWeekend } = require('../utils/date');
const { CATEGORIES, EXPENSE_SOURCES, TRANSACTION_TYPES } = require('../constants/categories');
const categorizationService = require('../services/categorization.service');
const subscriptionService = require('../services/subscription.service');
const budgetService = require('../services/budget.service');
const groupService = require('../services/group.service');
const splitService = require('../services/split.service');
const balanceService = require('../services/balance.service');
const data = require('./sampleData');

/**
 * Generates a realistic six-month history for the demo accounts.
 *
 * The data is deliberately *patterned* rather than uniformly random, because
 * flat noise makes every analytic look boring and every insight fire on
 * nothing. Concretely: fixed monthly charges are detectable subscriptions,
 * weekend food baskets run roughly double weekday ones, and the current month
 * is inflated so the month-over-month and budget-warning paths have something
 * real to report.
 *
 * Randomness is seeded, so `npm run seed` twice produces the same database.
 */

const MONTHS_OF_HISTORY = 6;
/** Current-month spend multiplier — drives the "spending increased" insight. */
const CURRENT_MONTH_INFLATION = 1.25;

/** Mulberry32: tiny, fast, deterministic. Reproducibility beats entropy here. */
function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeHelpers(random) {
  const between = (min, max) => round2(min + random() * (max - min));
  const intBetween = (min, max) => Math.floor(min + random() * (max - min + 1));
  const pick = (list) => list[Math.floor(random() * list.length)];
  const chance = (probability) => random() < probability;
  return { between, intBetween, pick, chance };
}

/** A wall-clock instant on a given day, at a plausible hour. */
function dateOn(year, month, day, hour, minute, timezone) {
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return fromZoned({ year, month, day: Math.min(day, maxDay), hour, minute }, timezone);
}

function buildExpenses(user, random) {
  const { between, intBetween, pick, chance } = makeHelpers(random);
  const tz = user.timezone;
  const now = new Date();
  const rows = [];

  const push = (row) => {
    // Never generate a transaction in the future — it would corrupt every
    // "so far this month" projection.
    if (row.date > now) return;
    rows.push(row);
  };

  for (let offset = MONTHS_OF_HISTORY - 1; offset >= 0; offset -= 1) {
    const anchor = addMonths(now, -offset, tz);
    const { year, month } = zonedParts(anchor, tz);
    const isCurrentMonth = offset === 0;
    const inflation = isCurrentMonth ? CURRENT_MONTH_INFLATION : 1;
    const totalDays = daysInMonth(anchor, tz);

    // --- Salary -------------------------------------------------------
    for (const income of data.INCOME) {
      push({
        amount: round2(user.monthlyIncome),
        type: TRANSACTION_TYPES.CREDIT,
        category: income.category,
        merchant: income.merchant,
        note: income.note,
        paymentMethod: income.paymentMethod,
        date: dateOn(year, month, income.dayOfMonth, 10, 5, tz),
        confirmed: true,
      });
    }

    // --- Fixed recurring charges (the subscription signal) -------------
    for (const item of data.RECURRING) {
      push({
        amount: item.amount,
        category: item.category,
        merchant: item.merchant,
        note: item.note,
        paymentMethod: item.paymentMethod,
        date: dateOn(year, month, item.dayOfMonth, 9, intBetween(0, 59), tz),
        confirmed: true,
        isSubscription: item.category === CATEGORIES.SUBSCRIPTIONS,
      });
    }

    // --- Monthly bills that vary in amount -----------------------------
    for (const bill of data.VARIABLE_BILLS) {
      push({
        amount: between(bill.min, bill.max),
        category: bill.category,
        merchant: bill.merchant,
        note: bill.note,
        paymentMethod: bill.paymentMethod,
        date: dateOn(year, month, bill.dayOfMonth, 19, intBetween(0, 59), tz),
        confirmed: true,
      });
    }

    // --- SIP ------------------------------------------------------------
    for (const sip of data.INVESTMENTS) {
      push({
        amount: sip.amount,
        category: sip.category,
        merchant: sip.merchant,
        note: sip.note,
        paymentMethod: sip.paymentMethod,
        date: dateOn(year, month, sip.dayOfMonth, 8, 30, tz),
        confirmed: true,
      });
    }

    // --- Daily discretionary spending -----------------------------------
    for (let day = 1; day <= totalDays; day += 1) {
      const date = dateOn(year, month, day, 13, 0, tz);
      if (date > now) break;
      const weekend = isWeekend(date, tz);

      // Food: more frequent AND larger at weekends.
      const foodEvents = weekend ? intBetween(1, 3) : chance(0.55) ? 1 : 0;
      for (let i = 0; i < foodEvents; i += 1) {
        const merchant = pick(data.FOOD_MERCHANTS);
        const [min, max] = weekend ? merchant.weekend : merchant.weekday;
        if (max === 0) continue;
        push({
          amount: round2(between(min, max) * inflation),
          category: CATEGORIES.FOOD,
          merchant: merchant.merchant,
          note: merchant.note,
          paymentMethod: pick(['upi', 'credit_card', 'wallet']),
          date: dateOn(year, month, day, weekend ? intBetween(12, 22) : intBetween(12, 15), intBetween(0, 59), tz),
          tags: weekend ? ['weekend'] : [],
        });
      }

      // Groceries: a weekly big shop plus top-ups.
      if (zonedParts(date, tz).weekday === 6 || chance(0.15)) {
        const merchant = pick(data.GROCERY_MERCHANTS);
        push({
          amount: round2(between(merchant.range[0], merchant.range[1]) * inflation),
          category: CATEGORIES.GROCERIES,
          merchant: merchant.merchant,
          note: merchant.note,
          paymentMethod: pick(['upi', 'credit_card']),
          date: dateOn(year, month, day, intBetween(10, 20), intBetween(0, 59), tz),
        });
      }

      // Transport: weekday commuting.
      if (!weekend && chance(0.7)) {
        const merchant = pick(data.TRANSPORT_MERCHANTS);
        push({
          amount: round2(between(merchant.range[0], merchant.range[1]) * inflation),
          category: CATEGORIES.TRANSPORT,
          merchant: merchant.merchant,
          note: merchant.note,
          paymentMethod: pick(['upi', 'wallet']),
          date: dateOn(year, month, day, intBetween(8, 21), intBetween(0, 59), tz),
        });
      }

      // Everything else: occasional.
      if (chance(0.12)) {
        const merchant = pick(data.DISCRETIONARY);
        push({
          amount: round2(between(merchant.range[0], merchant.range[1]) * inflation),
          category: merchant.category,
          merchant: merchant.merchant,
          note: merchant.note,
          paymentMethod: pick(['upi', 'credit_card', 'debit_card']),
          date: dateOn(year, month, day, intBetween(11, 22), intBetween(0, 59), tz),
        });
      }
    }
  }

  return rows.sort((a, b) => a.date - b.date);
}

/**
 * Writes generated rows with insertMany.
 *
 * Categories are pre-resolved here rather than routed through the expense
 * service: the seeder knows the ground truth, and one bulk insert is orders of
 * magnitude faster than thousands of individual creates with budget
 * re-evaluation on each.
 */
async function insertExpenses(user, rows) {
  const documents = rows.map((row) => {
    const merchantKey = categorizationService.buildMerchantKey(row.merchant);
    const predicted = categorizationService.categorizeByRules({
      merchant: row.merchant,
      note: row.note,
      amount: row.amount,
      type: row.type || TRANSACTION_TYPES.DEBIT,
    });

    return {
      user: user._id,
      amount: row.amount,
      currency: user.currency,
      type: row.type || TRANSACTION_TYPES.DEBIT,
      category: row.category,
      // Roughly a third of rows are marked user-confirmed, which is what the
      // merchant-memory layer learns from.
      categoryConfirmed: Boolean(row.confirmed),
      categorization: row.confirmed
        ? { method: 'manual', confidence: 1, matchedOn: null }
        : { method: predicted.method, confidence: predicted.confidence, matchedOn: predicted.matchedOn },
      note: row.note || '',
      merchant: row.merchant,
      merchantKey,
      date: row.date,
      paymentMethod: row.paymentMethod || 'other',
      tags: row.tags || [],
      source: EXPENSE_SOURCES.MANUAL,
      isSubscription: Boolean(row.isSubscription),
    };
  });

  await Expense.insertMany(documents, { ordered: false });
  return documents.length;
}

/** Runs the SMS samples through the real parser so seeded SMS rows are genuine. */
async function ingestSampleSms(user) {
  // Required lazily: the SMS service pulls in the expense service, which the
  // seeder otherwise has no reason to load.
  const smsService = require('../services/sms.service');
  const results = { created: 0, ignored: 0, duplicate: 0 };

  for (const sample of data.SAMPLE_SMS) {
    const result = await smsService.ingestSms(user, {
      message: sample.message,
      sender: sample.sender,
      save: true,
    });
    results[result.status] = (results[result.status] || 0) + 1;
  }

  return results;
}

async function createBudgets(user) {
  const month = monthKey(new Date(), user.timezone);
  let created = 0;

  for (const budget of data.BUDGETS) {
    await budgetService.setBudget(user, { ...budget, month });
    created += 1;
  }

  // A previous-month set too, so month-over-month views are not empty.
  const previous = monthKey(addMonths(new Date(), -1, user.timezone), user.timezone);
  for (const budget of data.BUDGETS) {
    await budgetService.setBudget(user, { ...budget, month: previous });
    created += 1;
  }

  return { month, created };
}

async function seedUser(userFixture, seed) {
  const random = createRandom(seed);

  // Model middleware hashes the password, so create() — not insertMany().
  const user = await User.create(userFixture);
  logger.info('Seeded user', { email: user.email });

  const rows = buildExpenses(user, random);
  const expenseCount = await insertExpenses(user, rows);
  const smsResults = await ingestSampleSms(user);
  const budgets = await createBudgets(user);
  const subscriptions = await subscriptionService.detectSubscriptions(user, {});

  const month = monthKey(new Date(), user.timezone);
  const { start, end } = monthRange(month, user.timezone);
  const spend = await budgetService.sumSpend(user._id, start, end, 'OVERALL');

  return {
    email: user.email,
    password: userFixture.password,
    expenses: expenseCount,
    sms: smsResults,
    budgets: budgets.created,
    subscriptionsDetected: subscriptions.detected.length,
    currentMonthSpend: spend.total,
  };
}

/**
 * Builds the demo shared-expense group.
 *
 * Runs after both demo users exist, because the group links them as real
 * members. Everything goes through the real services rather than direct inserts
 * so the seeded data exercises the same validation and split maths the API does
 * — if the calculation engine ever regresses, seeding fails rather than quietly
 * producing balances that do not add up.
 */
async function seedSplitGroup(users) {
  if (users.length < 2) return null;

  const [owner, friend] = users;
  const fixture = data.SPLIT_GROUP;

  const group = await groupService.createGroup(owner, {
    name: fixture.name,
    icon: fixture.icon,
    members: [
      { email: friend.email },
      ...fixture.placeholders.map((p) => ({ email: p.email, name: p.name })),
    ],
  });

  // Map the fixture's stable keys onto the member ids the group just minted.
  const memberId = {
    owner: String(group.memberForUser(owner._id)._id),
    friend: String(group.memberForUser(friend._id)._id),
  };
  for (const placeholder of fixture.placeholders) {
    const member = group.members.find((m) => m.email === placeholder.email);
    memberId[placeholder.key] = String(member._id);
  }

  const keys = Object.keys(memberId);
  const dayMs = 24 * 60 * 60 * 1000;

  for (const row of fixture.expenses) {
    let participants;
    if (row.splitType === 'exact') {
      participants = keys.map((k) => ({ member: memberId[k], share: row.exact[k] }));
    } else if (row.splitType === 'percentage') {
      participants = keys.map((k) => ({ member: memberId[k], share: row.percentage[k] }));
    } else if (row.splitType === 'shares') {
      participants = keys.map((k) => ({ member: memberId[k], share: row.shares[k] }));
    } else {
      participants = undefined; // equal across everyone
    }

    await splitService.createExpense(owner, group, {
      description: row.description,
      amount: row.amount,
      category: row.category,
      paidBy: memberId[row.paidBy],
      splitType: row.splitType,
      participants,
      date: new Date(Date.now() - row.daysAgo * dayMs),
    });
  }

  for (const row of fixture.settlements) {
    await balanceService.recordSettlement(owner, group, {
      from: memberId[row.from],
      to: memberId[row.to],
      amount: row.amount,
      method: row.method,
      note: row.note,
      date: new Date(Date.now() - row.daysAgo * dayMs),
    });
  }

  const balances = await balanceService.getGroupBalances(group);

  return {
    name: group.name,
    members: group.activeMembers().length,
    expenses: fixture.expenses.length,
    totalSpent: balances.totals.totalSpent,
    transactionsBefore: balances.totals.transactionsBeforeSimplification,
    transactionsAfter: balances.totals.transactionsAfterSimplification,
    ownerNet: balances.members.find((m) => m.member === memberId.owner).net,
  };
}

async function wipe() {
  await Promise.all([
    User.deleteMany({}),
    Expense.deleteMany({}),
    Budget.deleteMany({}),
    Subscription.deleteMany({}),
    Group.deleteMany({}),
    SplitExpense.deleteMany({}),
    Settlement.deleteMany({}),
  ]);
  logger.warn('Existing data cleared');
}

async function run() {
  const fresh = process.argv.includes('--fresh');

  await connectDB();

  if (fresh) {
    await wipe();
  } else {
    const existing = await User.countDocuments();
    if (existing > 0) {
      logger.warn(`Database already has ${existing} users. Re-run with --fresh to wipe and reseed.`);
      await disconnectDB();
      return;
    }
  }

  const summaries = [];
  const userDocs = [];
  for (const [index, fixture] of data.USERS.entries()) {
    const summary = await seedUser(fixture, 1337 + index * 101);
    summaries.push(summary);
    userDocs.push(await User.findOne({ email: fixture.email }));
  }

  const groupSummary = await seedSplitGroup(userDocs);

  process.stdout.write('\n Paisa sample data ready\n\n');
  for (const summary of summaries) {
    process.stdout.write(`  ${summary.email}  (password: ${summary.password})\n`);
    process.stdout.write(`    expenses: ${summary.expenses}   budgets: ${summary.budgets}   subscriptions: ${summary.subscriptionsDetected}\n`);
    process.stdout.write(`    sms ingested: ${summary.sms.created} created, ${summary.sms.ignored} ignored\n`);
    process.stdout.write(`    spend this month: ${summary.currentMonthSpend}\n\n`);
  }
  if (groupSummary) {
    process.stdout.write(`  Shared group: ${groupSummary.name}\n`);
    process.stdout.write(`    ${groupSummary.members} members, ${groupSummary.expenses} expenses, ${groupSummary.totalSpent} spent\n`);
    process.stdout.write(
      `    settle-up: ${groupSummary.transactionsBefore} transfers simplified to ${groupSummary.transactionsAfter}\n`
    );
    process.stdout.write(`    ${data.USERS[0].name} is ${groupSummary.ownerNet >= 0 ? 'owed' : 'owes'} ${Math.abs(groupSummary.ownerNet)}\n\n`);
  }

  process.stdout.write('  Log in via POST /api/v1/auth/login, then open http://localhost:5000/docs\n\n');

  await disconnectDB();
}

if (require.main === module) {
  run().catch(async (err) => {
    logger.error('Seeding failed', { message: err.message, stack: err.stack });
    await disconnectDB().catch(() => {});
    process.exit(1);
  });
}

module.exports = { run, seedUser, seedSplitGroup, buildExpenses, wipe, createRandom };
