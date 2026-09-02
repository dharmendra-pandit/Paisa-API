'use strict';

/**
 * Shared-expense vocabulary. Like the category keys, these strings are
 * persisted on documents and understood by clients, so they must stay stable.
 */

/** How a bill is divided between the members it covers. */
const SPLIT_TYPES = Object.freeze({
  /** Divide evenly. The only input needed is *who* is involved. */
  EQUAL: 'equal',
  /** Caller supplies the exact rupee amount each member owes. */
  EXACT: 'exact',
  /** Caller supplies percentages, which must total 100. */
  PERCENTAGE: 'percentage',
  /** Caller supplies relative weights — "Aarav ate twice as much" = 2 shares. */
  SHARES: 'shares',
});

const SPLIT_TYPE_LIST = Object.freeze(Object.values(SPLIT_TYPES));

/** Roles inside a group. Only admins may rename it or remove other members. */
const GROUP_ROLES = Object.freeze({ ADMIN: 'admin', MEMBER: 'member' });
const GROUP_ROLE_LIST = Object.freeze(Object.values(GROUP_ROLES));

/**
 * Presets for the group avatar. Clients render their own artwork from the key;
 * storing a key rather than a URL keeps the icon themeable and offline-safe.
 */
const GROUP_ICONS = Object.freeze([
  'home',
  'trip',
  'couple',
  'friends',
  'office',
  'party',
  'sports',
  'food',
  'family',
  'other',
]);

/**
 * A settlement records money actually moving between two people, as opposed to
 * an expense, which records money leaving the group as a whole.
 */
const SETTLEMENT_METHODS = Object.freeze(['cash', 'upi', 'bank_transfer', 'card', 'wallet', 'other']);

/**
 * Rupee tolerance when checking that supplied amounts add up to the bill.
 *
 * Clients compute shares in floating point and round for display, so an exact
 * equality check rejects perfectly reasonable input (three shares of a ₹100
 * bill sent as 33.33 each). We accept anything within a paisa per member and
 * then re-derive the true amounts server-side, so the stored rows always sum
 * to the bill exactly regardless of what the client rounded to.
 */
const AMOUNT_TOLERANCE = 0.011;

/** Percentages must total 100 within this margin, for the same reason. */
const PERCENTAGE_TOLERANCE = 0.011;

module.exports = {
  SPLIT_TYPES,
  SPLIT_TYPE_LIST,
  GROUP_ROLES,
  GROUP_ROLE_LIST,
  GROUP_ICONS,
  SETTLEMENT_METHODS,
  AMOUNT_TOLERANCE,
  PERCENTAGE_TOLERANCE,
};
