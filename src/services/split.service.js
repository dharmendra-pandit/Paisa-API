'use strict';

const SplitExpense = require('../models/SplitExpense');
const Expense = require('../models/Expense');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { round2 } = require('../utils/money');
const { computeSplits, sumsTo } = require('../utils/splitMath');
const { SPLIT_TYPES, AMOUNT_TOLERANCE, PERCENTAGE_TOLERANCE } = require('../constants/split');
const { CATEGORY_LABELS, EXPENSE_SOURCES } = require('../constants/categories');
const categorizationService = require('./categorization.service');

/**
 * Shared-expense lifecycle.
 *
 * The one rule this module exists to enforce: whatever the client sends, the
 * stored splits sum to the bill exactly. Client-supplied amounts are treated as
 * *intent*, validated for plausibility, then re-derived server-side through the
 * integer-paise engine in utils/splitMath. A client that rounds 33.333 to 33.33
 * three times gets a correct 100 back, not a 99.99 expense that quietly poisons
 * every balance in the group.
 */

/**
 * Validates the requested participants against the group and the split type,
 * and returns the participant list the calculator expects.
 */
function buildParticipants(group, { splitType, participants, amount }) {
  const active = group.activeMembers();
  const activeIds = new Set(active.map((m) => String(m._id)));

  // An equal split with no explicit list means "everyone", which is the common
  // case and the one worth making effortless.
  const rows = participants && participants.length ? participants : active.map((m) => ({ member: String(m._id) }));

  if (!rows.length) throw ApiError.badRequest('An expense must be split between at least one member');

  const seen = new Set();
  for (const row of rows) {
    const id = String(row.member);
    if (!activeIds.has(id)) throw ApiError.badRequest('Every participant must be an active member of this group');
    if (seen.has(id)) throw ApiError.badRequest('A member can only appear once in a split');
    seen.add(id);
  }

  switch (splitType) {
    case SPLIT_TYPES.EQUAL:
      return rows.map((r) => ({ member: r.member, share: null }));

    case SPLIT_TYPES.EXACT: {
      const amounts = rows.map((r) => Number(r.share));
      if (amounts.some((a) => !Number.isFinite(a) || a < 0)) {
        throw ApiError.badRequest('Each participant needs a share amount of zero or more');
      }
      // Tolerance scales with the number of participants: each one can be off by
      // up to a paisa from client-side rounding, and those errors accumulate.
      const tolerance = AMOUNT_TOLERANCE * Math.max(1, rows.length);
      if (!sumsTo(amounts, Number(amount), tolerance)) {
        const total = round2(amounts.reduce((a, b) => a + b, 0));
        throw ApiError.unprocessable('The split amounts must add up to the total', [
          { field: 'body.participants', message: `Shares total ${total}, but the expense is ${round2(amount)}` },
        ]);
      }
      return rows.map((r) => ({ member: r.member, share: Number(r.share) }));
    }

    case SPLIT_TYPES.PERCENTAGE: {
      const percentages = rows.map((r) => Number(r.share));
      if (percentages.some((p) => !Number.isFinite(p) || p < 0)) {
        throw ApiError.badRequest('Each participant needs a percentage of zero or more');
      }
      const tolerance = PERCENTAGE_TOLERANCE * Math.max(1, rows.length);
      if (!sumsTo(percentages, 100, tolerance)) {
        const total = round2(percentages.reduce((a, b) => a + b, 0));
        throw ApiError.unprocessable('Split percentages must add up to 100', [
          { field: 'body.participants', message: `Percentages total ${total}%` },
        ]);
      }
      return rows.map((r) => ({ member: r.member, share: Number(r.share) }));
    }

    case SPLIT_TYPES.SHARES: {
      const shares = rows.map((r) => Number(r.share));
      if (shares.some((s) => !Number.isFinite(s) || s < 0)) {
        throw ApiError.badRequest('Each participant needs a share weight of zero or more');
      }
      if (shares.reduce((a, b) => a + b, 0) <= 0) {
        throw ApiError.badRequest('At least one participant must have a share greater than zero');
      }
      return rows.map((r) => ({ member: r.member, share: Number(r.share) }));
    }

    default:
      throw ApiError.badRequest(`Unsupported split type: ${splitType}`);
  }
}

/** Attaches the denormalised user id to each computed split row. */
function decorateSplits(group, computed) {
  return computed.map((row) => {
    const member = group.memberById(row.member);
    return {
      member: row.member,
      user: member && member.user ? member.user : null,
      amount: row.amount,
      share: row.share,
    };
  });
}

/**
 * Mirrors the payer's own share into their personal expense ledger.
 *
 * Without this, a user who pays for a 3000 group dinner sees either the whole
 * 3000 in their personal analytics (wrong — two thirds of it was not theirs) or
 * nothing at all (also wrong — their 1000 was real spending). The mirror records
 * exactly their share, tagged to its source.
 */
async function mirrorToPersonalLedger(user, group, splitExpense, payerMember) {
  if (!payerMember || !payerMember.user || String(payerMember.user) !== String(user._id)) return null;

  const share = splitExpense.shareFor(payerMember._id);
  if (share <= 0) return null;

  const merchant = splitExpense.description;

  const expense = await Expense.create({
    user: user._id,
    amount: share,
    currency: splitExpense.currency,
    type: 'debit',
    category: splitExpense.category,
    categoryConfirmed: true,
    categorization: { method: 'manual', confidence: 1 },
    note: `Your share of "${splitExpense.description}" in ${group.name}`,
    merchant,
    merchantKey: categorizationService.buildMerchantKey(merchant),
    date: splitExpense.date,
    paymentMethod: 'other',
    tags: ['split', group.name.toLowerCase().slice(0, 30)],
    source: EXPENSE_SOURCES.MANUAL,
  });

  splitExpense.personalExpense = expense._id;
  await splitExpense.save();
  return expense;
}

async function createExpense(user, group, payload) {
  if (group.isArchived) throw ApiError.badRequest('This group is archived — unarchive it to add expenses');

  const callerMember = group.memberForUser(user._id);
  const splitType = payload.splitType || SPLIT_TYPES.EQUAL;

  // Defaults to the caller, which is what "I paid for this" means.
  const paidBy = payload.paidBy ? group.memberById(payload.paidBy) : callerMember;
  if (!paidBy || !paidBy.isActive) throw ApiError.badRequest('The paying member is not an active member of this group');

  const participants = buildParticipants(group, { splitType, participants: payload.participants, amount: payload.amount });
  const computed = computeSplits({ amount: payload.amount, splitType, participants });

  const expense = await SplitExpense.create({
    group: group._id,
    description: payload.description,
    amount: payload.amount,
    currency: group.currency,
    category: payload.category || 'OTHER',
    paidBy: paidBy._id,
    paidByUser: paidBy.user || null,
    splitType,
    splits: decorateSplits(group, computed),
    date: payload.date || new Date(),
    note: payload.note || '',
    createdBy: user._id,
  });

  if (payload.addToPersonalExpenses) {
    await mirrorToPersonalLedger(user, group, expense, paidBy);
  }

  logger.info('Split expense created', {
    groupId: String(group._id),
    expenseId: String(expense._id),
    amount: payload.amount,
    splitType,
    participants: computed.length,
  });

  return expense;
}

/**
 * Rewrites an expense in place.
 *
 * Any change to the amount, the payer, the split type or the participants
 * invalidates the stored shares, so they are recomputed wholesale rather than
 * patched. Partial recomputation is where split bugs live.
 */
async function updateExpense(user, group, expenseId, patch) {
  const expense = await SplitExpense.findOne({ _id: expenseId, group: group._id, isDeleted: false });
  if (!expense) throw ApiError.notFound('Expense not found');

  for (const field of ['description', 'note', 'category']) {
    if (patch[field] !== undefined) expense[field] = patch[field];
  }
  if (patch.date !== undefined) expense.date = patch.date;

  const amount = patch.amount !== undefined ? patch.amount : expense.amount;
  const splitType = patch.splitType || expense.splitType;

  if (patch.paidBy !== undefined) {
    const payer = group.memberById(patch.paidBy);
    if (!payer || !payer.isActive) throw ApiError.badRequest('The paying member is not an active member of this group');
    expense.paidBy = payer._id;
    expense.paidByUser = payer.user || null;
  }

  const touchesSplit =
    patch.amount !== undefined || patch.splitType !== undefined || patch.participants !== undefined;

  if (touchesSplit) {
    const requested = patch.participants || expense.splits.map((s) => ({ member: String(s.member), share: s.share }));
    const participants = buildParticipants(group, { splitType, participants: requested, amount });
    expense.amount = amount;
    expense.splitType = splitType;
    expense.splits = decorateSplits(group, computeSplits({ amount, splitType, participants }));
  }

  await expense.save();

  // Keep the mirrored personal expense honest about the payer's new share.
  if (expense.personalExpense) {
    const payer = group.memberById(expense.paidBy);
    const share = expense.shareFor(expense.paidBy);
    await Expense.findByIdAndUpdate(expense.personalExpense, {
      $set: {
        amount: share,
        category: expense.category,
        date: expense.date,
        note: `Your share of "${expense.description}" in ${group.name}`,
        merchant: expense.description,
      },
    });
    if (!payer) logger.warn('Mirrored expense payer missing', { expenseId: String(expense._id) });
  }

  logger.info('Split expense updated', { groupId: String(group._id), expenseId: String(expense._id) });
  return expense;
}

/**
 * Soft-deletes an expense and its personal mirror.
 *
 * Soft rather than hard for the same reason personal expenses are: the row is
 * evidence of who paid what, and a group member disputing a balance needs to be
 * able to see that an expense existed and was removed.
 */
async function deleteExpense(user, group, expenseId) {
  const expense = await SplitExpense.findOne({ _id: expenseId, group: group._id, isDeleted: false });
  if (!expense) throw ApiError.notFound('Expense not found');

  await expense.softDelete();

  if (expense.personalExpense) {
    await Expense.findByIdAndUpdate(expense.personalExpense, { $set: { isDeleted: true, deletedAt: new Date() } });
  }

  logger.info('Split expense deleted', { groupId: String(group._id), expenseId: String(expense._id), userId: String(user._id) });
  return { id: String(expense._id), description: expense.description, amount: expense.amount };
}

/** The group ledger, newest first, with each row resolved for display. */
async function listExpenses(group, viewerMemberId, query = {}) {
  const { page = 1, limit = 20, category, member, search, startDate, endDate } = query;

  const filter = { group: group._id, isDeleted: false };
  if (category) filter.category = { $in: Array.isArray(category) ? category : [category] };
  if (member) filter['splits.member'] = member;
  if (search) filter.description = { $regex: escapeRegex(search), $options: 'i' };
  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = startDate;
    if (endDate) filter.date.$lte = endDate;
  }

  const [items, total, totals] = await Promise.all([
    SplitExpense.find(filter).sort({ date: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SplitExpense.countDocuments(filter),
    SplitExpense.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
  ]);

  return {
    items: items.map((doc) => presentExpense(doc, group, viewerMemberId)),
    total,
    page,
    limit,
    summary: {
      totalAmount: totals.length ? round2(totals[0].total) : 0,
      count: totals.length ? totals[0].count : 0,
      currency: group.currency,
    },
  };
}

async function getExpense(group, viewerMemberId, expenseId) {
  const expense = await SplitExpense.findOne({ _id: expenseId, group: group._id, isDeleted: false }).lean();
  if (!expense) throw ApiError.notFound('Expense not found');
  return presentExpense(expense, group, viewerMemberId);
}

/**
 * Shapes a stored expense for a specific viewer.
 *
 * `yourShare` and `lentOrBorrowed` are computed per-viewer because "you are owed
 * 400" is the single most important line in the UI, and deriving it client-side
 * means every client re-implements the sign convention.
 */
function presentExpense(doc, group, viewerMemberId) {
  const memberInfo = (id) => {
    const m = group.members.id ? group.members.id(id) : group.members.find((x) => String(x._id) === String(id));
    return m
      ? { member: String(m._id), name: m.name, avatar: m.avatar || '', user: m.user ? String(m.user) : null }
      : { member: String(id), name: 'Removed member', avatar: '', user: null };
  };

  const viewer = viewerMemberId ? String(viewerMemberId) : null;
  const yourSplit = viewer ? doc.splits.find((s) => String(s.member) === viewer) : null;
  const yourShare = yourSplit ? yourSplit.amount : 0;
  const youPaid = viewer && String(doc.paidBy) === viewer ? doc.amount : 0;
  const net = round2(youPaid - yourShare);

  return {
    id: String(doc._id || doc.id),
    description: doc.description,
    amount: doc.amount,
    currency: doc.currency,
    category: doc.category,
    categoryLabel: CATEGORY_LABELS[doc.category] || doc.category,
    date: doc.date,
    note: doc.note,
    splitType: doc.splitType,
    paidBy: memberInfo(doc.paidBy),
    splits: doc.splits.map((s) => ({ ...memberInfo(s.member), amount: s.amount, share: s.share })),
    participantCount: doc.splits.length,
    yourShare,
    youPaid,
    // Positive: the group owes you for this bill. Negative: you owe the payer.
    net,
    lentOrBorrowed: net > 0.005 ? 'lent' : net < -0.005 ? 'borrowed' : 'not-involved',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  createExpense,
  updateExpense,
  deleteExpense,
  listExpenses,
  getExpense,
  presentExpense,
  buildParticipants,
};
