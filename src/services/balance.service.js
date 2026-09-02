'use strict';

const SplitExpense = require('../models/SplitExpense');
const Settlement = require('../models/Settlement');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { round2 } = require('../utils/money');
const { toPaise, toRupees, simplifyDebts } = require('../utils/splitMath');

/**
 * Balance engine.
 *
 * ## Balances are derived, never stored
 *
 * There is no `balance` column anywhere in this codebase, and that is a
 * deliberate choice. A stored balance is a cache of a sum, and every edit,
 * delete, member removal and settlement becomes an opportunity for that cache
 * to drift from the ledger it summarises. Once it drifts there is no way to
 * tell which number is the lie.
 *
 * Instead every balance is recomputed from the two immutable-ish sources of
 * truth — expenses and settlements — on each read. A group is bounded (50
 * members, and expense counts in the hundreds or low thousands), the queries are
 * covered by indexes, and the arithmetic is a linear pass. The correctness
 * guarantee is worth far more than the microseconds.
 *
 * If a group ever grows past what this comfortably handles, the fix is a
 * periodically materialised snapshot plus a delta since its timestamp — not a
 * mutable running total.
 */

/**
 * Net position of every member of a group, in integer paise internally.
 *
 *   net = (what they paid out) - (what they consumed) + (settlements they paid)
 *         - (settlements they received)
 *
 * Positive means the group owes them. Negative means they owe the group. The
 * sum across all members is always exactly zero — that invariant is asserted
 * below, because a non-zero total means money was invented or destroyed and no
 * downstream number can be trusted.
 */
async function computeBalances(group) {
  const [expenses, settlements] = await Promise.all([
    SplitExpense.find({ group: group._id, isDeleted: false }).select('amount paidBy splits date').lean(),
    Settlement.find({ group: group._id, isDeleted: false }).select('from to amount date').lean(),
  ]);

  const netPaise = new Map();
  const bump = (memberId, paise) => {
    const key = String(memberId);
    netPaise.set(key, (netPaise.get(key) || 0) + paise);
  };

  // Seed every active member so someone with no activity still appears, at zero.
  for (const member of group.activeMembers()) netPaise.set(String(member._id), 0);

  const paidPaise = new Map();
  const owedPaise = new Map();
  let totalSpentPaise = 0;

  for (const expense of expenses) {
    const amount = toPaise(expense.amount);
    totalSpentPaise += amount;

    bump(expense.paidBy, amount);
    paidPaise.set(String(expense.paidBy), (paidPaise.get(String(expense.paidBy)) || 0) + amount);

    for (const split of expense.splits) {
      const share = toPaise(split.amount);
      bump(split.member, -share);
      owedPaise.set(String(split.member), (owedPaise.get(String(split.member)) || 0) + share);
    }
  }

  // A settlement moves real money: the payer's debt shrinks, the receiver's
  // credit shrinks by the same amount.
  for (const settlement of settlements) {
    const amount = toPaise(settlement.amount);
    bump(settlement.from, amount);
    bump(settlement.to, -amount);
  }

  const netByMember = {};
  let checksum = 0;
  for (const [member, paise] of netPaise.entries()) {
    netByMember[member] = toRupees(paise);
    checksum += paise;
  }

  if (checksum !== 0) {
    // Not throwable — the user still deserves their data — but this is a bug
    // report, and it needs to be loud enough to find in production logs.
    logger.error('Balance invariant violated: net positions do not sum to zero', {
      groupId: String(group._id),
      checksumPaise: checksum,
      expenses: expenses.length,
      settlements: settlements.length,
    });
  }

  return {
    netByMember,
    paidByMember: mapToRupees(paidPaise),
    owedByMember: mapToRupees(owedPaise),
    totals: {
      totalSpent: toRupees(totalSpentPaise),
      expenseCount: expenses.length,
      settlementCount: settlements.length,
    },
    // Handed back so callers building a detailed view do not re-query.
    raw: { expenses, settlements },
  };
}

function mapToRupees(map) {
  const out = {};
  for (const [key, paise] of map.entries()) out[key] = toRupees(paise);
  return out;
}

/**
 * Who owes whom, before simplification.
 *
 * This is the literal ledger: for each expense, everybody covered by it owes
 * their share to whoever paid. Reciprocal debts between the same two people are
 * netted off, so "A owes B 100, B owes A 30" reports once as "A owes B 70".
 *
 * Kept alongside the simplified view because they answer different questions.
 * Simplified tells you the fewest transfers that clear the group. Detailed tells
 * you why you owe it — and when someone disputes a number, this is the view that
 * settles the argument.
 */
function computePairwiseDebts({ expenses, settlements }) {
  // ledger[debtor][creditor] = paise owed
  const ledger = new Map();

  const owe = (debtor, creditor, paise) => {
    const from = String(debtor);
    const to = String(creditor);
    if (from === to || paise === 0) return;
    if (!ledger.has(from)) ledger.set(from, new Map());
    const row = ledger.get(from);
    row.set(to, (row.get(to) || 0) + paise);
  };

  for (const expense of expenses) {
    for (const split of expense.splits) {
      // The payer's own share is not a debt to themselves.
      owe(split.member, expense.paidBy, toPaise(split.amount));
    }
  }

  // Paying someone back cancels debt in that direction.
  for (const settlement of settlements) {
    owe(settlement.to, settlement.from, toPaise(settlement.amount));
  }

  const debts = [];
  const seen = new Set();

  for (const [from, row] of ledger.entries()) {
    for (const [to, paise] of row.entries()) {
      const pairKey = [from, to].sort().join('|');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const reverse = ledger.get(to)?.get(from) || 0;
      const netPaise = paise - reverse;

      if (netPaise > 0) debts.push({ from, to, amount: toRupees(netPaise) });
      else if (netPaise < 0) debts.push({ from: to, to: from, amount: toRupees(-netPaise) });
    }
  }

  return debts.sort((a, b) => b.amount - a.amount);
}

/**
 * The full balance view for a group: per-member positions, the detailed
 * who-owes-whom ledger, and the simplified set of transfers that clears it.
 */
async function getGroupBalances(group, { simplify } = {}) {
  const balances = await computeBalances(group);
  const useSimplified = simplify === undefined ? group.simplifyDebts : simplify;

  const memberById = new Map(group.members.map((m) => [String(m._id), m]));
  const describe = (memberId) => {
    const member = memberById.get(String(memberId));
    return {
      member: String(memberId),
      name: member ? member.name : 'Removed member',
      avatar: member ? member.avatar || '' : '',
      user: member && member.user ? String(member.user) : null,
    };
  };

  const detailed = computePairwiseDebts(balances.raw);
  const simplified = simplifyDebts(balances.netByMember);

  const settlementPlan = (useSimplified ? simplified : detailed).map((t) => ({
    from: describe(t.from),
    to: describe(t.to),
    amount: t.amount,
  }));

  const members = group
    .activeMembers()
    .map((member) => {
      const id = String(member._id);
      const net = balances.netByMember[id] || 0;
      return {
        member: id,
        user: member.user ? String(member.user) : null,
        name: member.name,
        avatar: member.avatar || '',
        isPlaceholder: !member.user,
        totalPaid: balances.paidByMember[id] || 0,
        totalShare: balances.owedByMember[id] || 0,
        net,
        status: net > 0.005 ? 'owed' : net < -0.005 ? 'owes' : 'settled',
      };
    })
    .sort((a, b) => b.net - a.net);

  return {
    groupId: String(group._id),
    currency: group.currency,
    simplified: useSimplified,
    members,
    // The transfers that clear the group, under the chosen view.
    settleUp: settlementPlan,
    detailedDebts: detailed.map((t) => ({ from: describe(t.from), to: describe(t.to), amount: t.amount })),
    simplifiedDebts: simplified.map((t) => ({ from: describe(t.from), to: describe(t.to), amount: t.amount })),
    totals: {
      ...balances.totals,
      // How much movement simplification saves, which is the feature's whole pitch.
      transactionsBeforeSimplification: detailed.length,
      transactionsAfterSimplification: simplified.length,
      transactionsSaved: Math.max(0, detailed.length - simplified.length),
    },
    isSettled: members.every((m) => m.status === 'settled'),
  };
}

/**
 * What one member owes or is owed, and to whom — the "your balance" card.
 */
async function getMemberBalance(group, memberId) {
  const full = await getGroupBalances(group);
  const me = full.members.find((m) => m.member === String(memberId));

  const owedToMe = full.settleUp.filter((t) => t.to.member === String(memberId));
  const iOwe = full.settleUp.filter((t) => t.from.member === String(memberId));

  return {
    member: String(memberId),
    currency: group.currency,
    net: me ? me.net : 0,
    status: me ? me.status : 'settled',
    totalPaid: me ? me.totalPaid : 0,
    totalShare: me ? me.totalShare : 0,
    owedToYou: owedToMe.map((t) => ({ from: t.from, amount: t.amount })),
    youOwe: iOwe.map((t) => ({ to: t.to, amount: t.amount })),
  };
}

/**
 * Records a payment between two members.
 *
 * Partial settlement needs no special handling: paying 200 of a 300 debt is
 * simply a 200 entry, and the next balance read reports 100 outstanding. That
 * falls out of deriving balances rather than storing them.
 *
 * Overpayment is allowed and flips the debt, which is correct — if you hand a
 * friend 500 to clear 300, they now owe you 200. Refusing it would force users
 * to record a real-world transfer as something other than what happened.
 */
async function recordSettlement(user, group, { from, to, amount, method, date, note }) {
  const fromMember = group.memberById(from);
  const toMember = group.memberById(to);

  if (!fromMember || !fromMember.isActive) throw ApiError.notFound('The paying member is not in this group');
  if (!toMember || !toMember.isActive) throw ApiError.notFound('The receiving member is not in this group');
  if (String(from) === String(to)) throw ApiError.badRequest('A member cannot settle up with themselves');

  const settlement = await Settlement.create({
    group: group._id,
    from: fromMember._id,
    to: toMember._id,
    fromUser: fromMember.user || null,
    toUser: toMember.user || null,
    amount,
    currency: group.currency,
    method,
    date: date || new Date(),
    note: note || '',
    recordedBy: user._id,
  });

  logger.info('Settlement recorded', {
    groupId: String(group._id),
    settlementId: String(settlement._id),
    amount,
    userId: String(user._id),
  });

  const balances = await getGroupBalances(group);

  return {
    settlement: presentSettlement(settlement, group),
    balances,
    message: `${fromMember.name} paid ${toMember.name} ${group.currency} ${round2(amount).toFixed(2)}`,
  };
}

async function listSettlements(group, { page = 1, limit = 20 } = {}) {
  const filter = { group: group._id, isDeleted: false };

  const [items, total] = await Promise.all([
    Settlement.find(filter).sort({ date: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Settlement.countDocuments(filter),
  ]);

  return {
    items: items.map((doc) => presentSettlement(doc, group)),
    total,
    page,
    limit,
  };
}

/** Reverses a settlement that was recorded in error. */
async function deleteSettlement(user, group, settlementId) {
  const settlement = await Settlement.findOne({ _id: settlementId, group: group._id, isDeleted: false });
  if (!settlement) throw ApiError.notFound('Settlement not found');

  await settlement.softDelete();
  logger.info('Settlement reversed', { settlementId: String(settlement._id), userId: String(user._id) });

  return { id: String(settlement._id), balances: await getGroupBalances(group) };
}

function presentSettlement(doc, group) {
  const raw = doc.toJSON ? doc.toJSON() : { ...doc, id: doc._id };
  const member = (id) => {
    const m = group.members.id ? group.members.id(id) : group.members.find((x) => String(x._id) === String(id));
    return m ? { member: String(m._id), name: m.name, avatar: m.avatar || '', user: m.user ? String(m.user) : null } : null;
  };

  return {
    id: String(raw.id || raw._id),
    from: member(raw.from),
    to: member(raw.to),
    amount: raw.amount,
    currency: raw.currency,
    method: raw.method,
    date: raw.date,
    note: raw.note,
    createdAt: raw.createdAt,
  };
}

module.exports = {
  computeBalances,
  computePairwiseDebts,
  getGroupBalances,
  getMemberBalance,
  recordSettlement,
  listSettlements,
  deleteSettlement,
  presentSettlement,
};
