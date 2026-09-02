'use strict';

const mongoose = require('mongoose');
const Expense = require('../models/Expense');
const Subscription = require('../models/Subscription');
const ApiError = require('../utils/ApiError');
const config = require('../config/env');
const { round2, median, mean, stdDev, percent } = require('../utils/money');
const { addDays, daysBetween } = require('../utils/date');
const { TRANSACTION_TYPES, CATEGORIES } = require('../constants/categories');
const { SUBSCRIPTION_MERCHANT_HINTS } = require('../constants/categoryRules');
const categorizationService = require('./categorization.service');

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * Recurring-payment detection.
 *
 * A subscription is a merchant you pay on a *rhythm*, for a *stable* amount.
 * Both halves matter: a daily coffee shop is regular but the amounts wander,
 * while a one-off ₹499 purchase is stable but has no rhythm. The detector
 * scores each merchant on both axes plus a merchant-name prior, and only
 * commits above a confidence floor.
 */

/** Median gap in days → a human-readable cadence, with the tolerance band. */
const CADENCE_BANDS = Object.freeze([
  { cadence: 'weekly', min: 5, max: 9, nominal: 7 },
  { cadence: 'monthly', min: 25, max: 38, nominal: 30 },
  { cadence: 'quarterly', min: 80, max: 100, nominal: 91 },
  { cadence: 'yearly', min: 330, max: 400, nominal: 365 },
]);

const MIN_CONFIDENCE = 0.55;

function classifyCadence(intervalDays) {
  const band = CADENCE_BANDS.find((b) => intervalDays >= b.min && intervalDays <= b.max);
  return band ? band.cadence : 'irregular';
}

function monthlyEquivalent(amount, cadence, intervalDays) {
  const perMonth = {
    weekly: 52 / 12,
    monthly: 1,
    quarterly: 1 / 3,
    yearly: 1 / 12,
  };
  if (perMonth[cadence]) return round2(amount * perMonth[cadence]);
  // Irregular: fall back to the observed gap.
  return intervalDays > 0 ? round2((amount * 30.44) / intervalDays) : 0;
}

/**
 * Scores one merchant's charge history.
 * Returns null when the pattern is not convincing enough to persist.
 */
function analyseGroup(group) {
  const charges = group.charges.slice().sort((a, b) => a.date - b.date);
  if (charges.length < config.subscription.minOccurrences) return null;

  const gaps = [];
  for (let i = 1; i < charges.length; i += 1) {
    gaps.push(daysBetween(charges[i - 1].date, charges[i].date));
  }
  // Same-day repeat purchases are not a cadence.
  const positiveGaps = gaps.filter((g) => g >= 1);
  if (positiveGaps.length < config.subscription.minOccurrences - 1) return null;

  const medianGap = median(positiveGaps);
  if (!medianGap) return null;

  const cadence = classifyCadence(medianGap);
  // An irregular rhythm is only a subscription if the merchant name says so.
  const merchantIsKnown = SUBSCRIPTION_MERCHANT_HINTS.some((hint) =>
    categorizationService.containsPhrase(group.merchantKey, hint)
  );
  if (cadence === 'irregular' && !merchantIsKnown) return null;

  // Regularity: how tightly the gaps cluster around their median (0-1).
  const gapDeviation = stdDev(positiveGaps) / medianGap;
  const regularity = Math.max(0, 1 - gapDeviation);

  // Amount stability: mean relative deviation from the median charge (0-1).
  const amounts = charges.map((c) => c.amount);
  const medianAmount = median(amounts);
  const amountDrift = medianAmount
    ? mean(amounts.map((a) => Math.abs(a - medianAmount) / medianAmount))
    : 1;
  const stability = Math.max(0, 1 - amountDrift / Math.max(config.subscription.amountTolerance, 0.01) / 4);

  // More observations mean more evidence, saturating at six charges.
  const evidence = Math.min(charges.length / 6, 1);

  let confidence = regularity * 0.4 + stability * 0.3 + evidence * 0.2;
  if (merchantIsKnown) confidence += 0.15;
  if (charges.some((c) => c.paymentMethod === 'auto_debit')) confidence += 0.05;
  confidence = Math.round(Math.min(confidence, 0.99) * 100) / 100;

  if (confidence < MIN_CONFIDENCE) return null;

  const last = charges[charges.length - 1];
  const intervalDays = Math.round(medianGap);
  const nextExpectedAt = addDays(last.date, intervalDays);

  // No charge for 1.5 cycles means the user probably cancelled.
  const daysSinceLast = daysBetween(last.date, new Date());
  const status = daysSinceLast > intervalDays * 1.5 + 5 ? 'lapsed' : 'active';

  return {
    merchant: group.merchant,
    merchantKey: group.merchantKey,
    category: group.category,
    amount: medianAmount,
    currency: group.currency,
    cadence,
    intervalDays,
    occurrences: charges.length,
    firstChargedAt: charges[0].date,
    lastChargedAt: last.date,
    nextExpectedAt,
    confidence,
    status,
    expenses: charges.map((c) => c.id),
    estimatedMonthlyCost: monthlyEquivalent(medianAmount, cadence, intervalDays),
    metrics: {
      regularity: round2(regularity),
      amountStability: round2(stability),
      averageGapDays: round2(mean(positiveGaps)),
      gapStdDevDays: round2(stdDev(positiveGaps)),
      amountRange: { min: round2(Math.min(...amounts)), max: round2(Math.max(...amounts)) },
      merchantRecognised: merchantIsKnown,
    },
  };
}

/** Pulls candidate charges and buckets them by merchant key. */
async function loadCandidateGroups(user, { lookbackDays }) {
  const since = addDays(new Date(), -lookbackDays);

  const rows = await Expense.aggregate([
    {
      $match: {
        user: toObjectId(user._id),
        isDeleted: false,
        type: TRANSACTION_TYPES.DEBIT,
        date: { $gte: since },
        merchantKey: { $nin: ['', null] },
      },
    },
    { $sort: { date: 1 } },
    {
      $group: {
        _id: '$merchantKey',
        merchant: { $last: '$merchant' },
        category: { $last: '$category' },
        currency: { $last: '$currency' },
        charges: {
          $push: { id: '$_id', amount: '$amount', date: '$date', paymentMethod: '$paymentMethod' },
        },
      },
    },
    { $match: { $expr: { $gte: [{ $size: '$charges' }, config.subscription.minOccurrences] } } },
  ]);

  return rows.map((row) => ({
    merchantKey: row._id,
    merchant: row.merchant || row._id,
    category: row.category || CATEGORIES.SUBSCRIPTIONS,
    currency: row.currency || user.currency,
    charges: row.charges,
  }));
}

/**
 * Runs detection and reconciles the Subscription collection.
 *
 * A user's explicit verdict is never overwritten — a dismissed detection stays
 * dismissed even though its statistics keep refreshing.
 */
async function detectSubscriptions(user, { lookbackDays = config.subscription.lookbackDays, persist = true } = {}) {
  const groups = await loadCandidateGroups(user, { lookbackDays });

  const detected = groups.map(analyseGroup).filter(Boolean).sort((a, b) => b.confidence - a.confidence);

  if (!persist) {
    return { detected, persisted: 0, summary: summarise(detected) };
  }

  const existing = await Subscription.find({ user: user._id }).lean();
  const byKey = new Map(existing.map((s) => [s.merchantKey, s]));

  const operations = [];
  const expenseIds = [];

  for (const item of detected) {
    const prior = byKey.get(item.merchantKey);
    const dismissed = prior && prior.userVerdict === 'dismissed';

    operations.push({
      updateOne: {
        filter: { user: user._id, merchantKey: item.merchantKey },
        update: {
          $set: {
            merchant: item.merchant,
            category: item.category,
            amount: item.amount,
            currency: item.currency,
            cadence: item.cadence,
            intervalDays: item.intervalDays,
            occurrences: item.occurrences,
            firstChargedAt: item.firstChargedAt,
            lastChargedAt: item.lastChargedAt,
            nextExpectedAt: item.nextExpectedAt,
            confidence: item.confidence,
            expenses: item.expenses,
            estimatedMonthlyCost: item.estimatedMonthlyCost,
            // A dismissed subscription must not resurrect itself as active.
            status: dismissed ? 'cancelled' : item.status,
          },
          $setOnInsert: { user: user._id, merchantKey: item.merchantKey, userVerdict: 'unreviewed' },
        },
        upsert: true,
      },
    });

    if (!dismissed) expenseIds.push(...item.expenses);
  }

  let persisted = 0;
  if (operations.length) {
    const result = await Subscription.bulkWrite(operations, { ordered: false });
    persisted = (result.upsertedCount || 0) + (result.modifiedCount || 0);
  }

  // Flag the underlying charges so the expense list can badge them.
  if (expenseIds.length) {
    await Expense.updateMany({ _id: { $in: expenseIds }, user: user._id }, { $set: { isSubscription: true } });
    await linkExpensesToSubscriptions(user, detected);
  }

  // Anything previously detected but absent from this run has gone quiet.
  const detectedKeys = new Set(detected.map((d) => d.merchantKey));
  const staleKeys = existing.filter((s) => !detectedKeys.has(s.merchantKey) && s.status === 'active').map((s) => s.merchantKey);
  if (staleKeys.length) {
    await Subscription.updateMany(
      { user: user._id, merchantKey: { $in: staleKeys }, userVerdict: { $ne: 'confirmed' } },
      { $set: { status: 'lapsed' } }
    );
  }

  return { detected, persisted, summary: summarise(detected) };
}

/** Back-references each charge to its subscription document. */
async function linkExpensesToSubscriptions(user, detected) {
  const subs = await Subscription.find({ user: user._id, merchantKey: { $in: detected.map((d) => d.merchantKey) } })
    .select('_id merchantKey')
    .lean();

  const operations = subs.map((sub) => {
    const match = detected.find((d) => d.merchantKey === sub.merchantKey);
    return {
      updateMany: {
        filter: { _id: { $in: match ? match.expenses : [] }, user: user._id },
        update: { $set: { subscription: sub._id } },
      },
    };
  });

  if (operations.length) await Expense.bulkWrite(operations, { ordered: false });
}

function summarise(detected) {
  const active = detected.filter((d) => d.status === 'active');
  const monthlyTotal = round2(active.reduce((sum, d) => sum + d.estimatedMonthlyCost, 0));
  return {
    total: detected.length,
    active: active.length,
    lapsed: detected.length - active.length,
    estimatedMonthlyCost: monthlyTotal,
    estimatedYearlyCost: round2(monthlyTotal * 12),
    byCadence: detected.reduce((acc, d) => {
      acc[d.cadence] = (acc[d.cadence] || 0) + 1;
      return acc;
    }, {}),
  };
}

async function listSubscriptions(user, { status, includeDismissed = false } = {}) {
  const filter = { user: user._id };
  if (status) filter.status = status;
  if (!includeDismissed) filter.userVerdict = { $ne: 'dismissed' };

  const subscriptions = await Subscription.find(filter).sort({ estimatedMonthlyCost: -1 }).lean();

  const monthlyTotal = round2(
    subscriptions.filter((s) => s.status === 'active').reduce((sum, s) => sum + (s.estimatedMonthlyCost || 0), 0)
  );

  return {
    items: subscriptions.map((s) => ({
      ...s,
      id: s._id,
      _id: undefined,
      estimatedYearlyCost: round2((s.estimatedMonthlyCost || 0) * 12),
      shareOfMonthlyCost: percent(s.estimatedMonthlyCost || 0, monthlyTotal),
    })),
    summary: {
      count: subscriptions.length,
      active: subscriptions.filter((s) => s.status === 'active').length,
      estimatedMonthlyCost: monthlyTotal,
      estimatedYearlyCost: round2(monthlyTotal * 12),
    },
  };
}

/** Records a user's confirm/dismiss decision and syncs the expense flags. */
async function reviewSubscription(user, id, { verdict, status }) {
  const subscription = await Subscription.findOne({ _id: id, user: user._id });
  if (!subscription) throw ApiError.notFound('Subscription not found');

  if (verdict) subscription.userVerdict = verdict;
  if (status) subscription.status = status;
  if (verdict === 'dismissed') subscription.status = 'cancelled';
  await subscription.save();

  await Expense.updateMany(
    { user: user._id, merchantKey: subscription.merchantKey },
    { $set: { isSubscription: verdict !== 'dismissed' } }
  );

  return subscription;
}

/** Charges expected in the next N days — the "what is about to hit my account" view. */
async function getUpcomingCharges(user, { days = 30 } = {}) {
  const until = addDays(new Date(), days);
  const subscriptions = await Subscription.find({
    user: user._id,
    status: 'active',
    userVerdict: { $ne: 'dismissed' },
    nextExpectedAt: { $lte: until },
  })
    .sort({ nextExpectedAt: 1 })
    .lean();

  return {
    windowDays: days,
    totalExpected: round2(subscriptions.reduce((sum, s) => sum + s.amount, 0)),
    items: subscriptions.map((s) => ({
      id: s._id,
      merchant: s.merchant,
      amount: s.amount,
      cadence: s.cadence,
      category: s.category,
      expectedOn: s.nextExpectedAt,
      daysAway: Math.max(daysBetween(new Date(), s.nextExpectedAt), 0),
      confidence: s.confidence,
    })),
  };
}

module.exports = {
  detectSubscriptions,
  listSubscriptions,
  reviewSubscription,
  getUpcomingCharges,
  analyseGroup,
  classifyCadence,
  monthlyEquivalent,
};
