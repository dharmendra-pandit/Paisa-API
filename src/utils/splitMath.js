'use strict';

/**
 * Pure arithmetic for shared expenses. No database, no Mongoose — everything
 * here is deterministic and unit-testable in isolation.
 *
 * ## Why integer paise
 *
 * Splitting money in floating point loses money. 100 / 3 is 33.33 three times
 * over, which is 99.99 — a paisa short of the bill. Round the other way and the
 * group owes 100.02 for a 100 rupee dinner. Over hundreds of expenses those
 * fractions accumulate into balances that never reach zero, and a user who
 * settles up in full is still shown owing 4 paise.
 *
 * So every calculation in this module converts to integer paise on the way in,
 * does exact integer arithmetic, and converts back on the way out. The
 * allocation functions guarantee the shares sum to the total exactly.
 */

const { round2 } = require('./money');

/** Rupees to integer paise. Rounds, so float noise cannot survive the trip. */
function toPaise(rupees) {
  return Math.round((Number(rupees) + Number.EPSILON) * 100);
}

/** Integer paise back to a 2-decimal rupee Number. */
function toRupees(paise) {
  return round2(paise / 100);
}

/**
 * Distributes totalPaise across weights so the parts sum to exactly the total,
 * using the largest-remainder (Hamilton) method.
 *
 * Each part gets the floor of its exact proportional value, which leaves a
 * handful of paise unallocated. Those go one each to the parts with the largest
 * discarded fraction — the fairest possible assignment, and the one that makes
 * "100 between 3 people" come out as 33.34 / 33.33 / 33.33 rather than three
 * equal shares that do not add up.
 *
 * Ties break on the lower index so the same input always produces the same
 * output; an unstable tie-break would make a re-saved expense silently move a
 * paisa between two members.
 */
function allocate(totalPaise, weights) {
  const total = Math.round(totalPaise);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  if (!weights.length) return [];
  // Zero total weight (every share is 0) cannot be proportioned, so fall back
  // to an even split rather than dividing by zero.
  if (totalWeight <= 0) return allocate(total, weights.map(() => 1));

  const exact = weights.map((w) => (total * w) / totalWeight);
  const floors = exact.map((v) => Math.floor(v));
  const allocated = floors.reduce((sum, v) => sum + v, 0);
  let remainder = total - allocated;

  // Order candidates by discarded fraction, largest first.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const result = [...floors];
  // remainder is smaller than weights.length by construction, but a negative
  // total (not reachable through validation) would loop forever without this.
  for (let i = 0; remainder > 0 && i < order.length; i += 1) {
    result[order[i].index] += 1;
    remainder -= 1;
  }

  return result;
}

/**
 * Turns "this bill, these participants, this rule" into the exact rupee amount
 * each participant owes.
 *
 * participants is [{ member, share }]. The meaning of share depends on the
 * split type: a percentage, a relative weight, or an exact rupee amount. For an
 * equal split it is ignored entirely.
 *
 * Returns [{ member, amount, share }] whose amounts sum to amount exactly.
 */
function computeSplits({ amount, splitType, participants }) {
  const totalPaise = toPaise(amount);

  switch (splitType) {
    case 'equal': {
      const parts = allocate(totalPaise, participants.map(() => 1));
      return participants.map((p, i) => ({ member: p.member, amount: toRupees(parts[i]), share: null }));
    }

    case 'exact': {
      // The amounts are already the answer; they are re-derived through paise
      // so the stored values cannot carry float noise from the request body.
      return participants.map((p) => ({
        member: p.member,
        amount: toRupees(toPaise(p.share)),
        share: round2(p.share),
      }));
    }

    case 'percentage': {
      const parts = allocate(totalPaise, participants.map((p) => Number(p.share) || 0));
      return participants.map((p, i) => ({ member: p.member, amount: toRupees(parts[i]), share: round2(p.share) }));
    }

    case 'shares': {
      const parts = allocate(totalPaise, participants.map((p) => Number(p.share) || 0));
      return participants.map((p, i) => ({ member: p.member, amount: toRupees(parts[i]), share: Number(p.share) }));
    }

    default:
      throw new Error(`Unsupported split type: ${splitType}`);
  }
}

/**
 * Reduces a set of net positions to the fewest payments that clear them.
 *
 * netByMember maps a member id to their net position in rupees: positive means
 * the group owes them, negative means they owe the group. The sum is always
 * zero, because every rupee someone paid is a rupee someone else owes.
 *
 * The algorithm repeatedly settles the largest debtor against the largest
 * creditor for the most that pair can clear. Each pass zeroes at least one
 * person, so a group of n people needs at most n-1 payments — which is what
 * turns "Aarav owes Priya 120, Priya owes Ravi 120" into "Aarav pays Ravi 120"
 * and spares everyone two transfers.
 *
 * This is the greedy heuristic, not a provably minimal solution: finding the
 * true minimum is NP-hard (it is subset-sum in disguise). Greedy is optimal
 * whenever no subgroup happens to balance internally, near-optimal when one
 * does, and always correct — every net position still lands on zero.
 */
function simplifyDebts(netByMember) {
  const creditors = [];
  const debtors = [];

  for (const [member, rupees] of Object.entries(netByMember)) {
    const paise = toPaise(rupees);
    if (paise > 0) creditors.push({ member, paise });
    else if (paise < 0) debtors.push({ member, paise: -paise });
  }

  // Deterministic ordering: biggest first, ties broken by id.
  const byAmount = (a, b) => b.paise - a.paise || (a.member < b.member ? -1 : 1);
  creditors.sort(byAmount);
  debtors.sort(byAmount);

  const transactions = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const settled = Math.min(debtor.paise, creditor.paise);

    if (settled > 0) {
      transactions.push({ from: debtor.member, to: creditor.member, amount: toRupees(settled) });
    }

    debtor.paise -= settled;
    creditor.paise -= settled;

    // Whoever hit zero drops out; the other stays for the next pairing.
    if (debtor.paise === 0) i += 1;
    if (creditor.paise === 0) j += 1;
  }

  return transactions;
}

/**
 * True when the parts add up to the whole within tolerance rupees.
 *
 * Used to validate client-supplied exact amounts and percentages before they
 * are trusted. The tolerance exists because clients round for display; the
 * server re-derives authoritative values afterwards regardless.
 */
function sumsTo(values, expected, tolerance) {
  const sum = values.reduce((acc, v) => acc + (Number(v) || 0), 0);
  return Math.abs(sum - expected) <= tolerance;
}

module.exports = { toPaise, toRupees, allocate, computeSplits, simplifyDebts, sumsTo };
