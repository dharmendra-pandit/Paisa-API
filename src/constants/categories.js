'use strict';

/**
 * Canonical expense categories. Keep the keys stable — they are persisted on
 * documents and referenced by the categorisation engine, analytics and clients.
 */
const CATEGORIES = Object.freeze({
  FOOD: 'FOOD',
  GROCERIES: 'GROCERIES',
  TRANSPORT: 'TRANSPORT',
  FUEL: 'FUEL',
  SHOPPING: 'SHOPPING',
  ENTERTAINMENT: 'ENTERTAINMENT',
  SUBSCRIPTIONS: 'SUBSCRIPTIONS',
  BILLS_UTILITIES: 'BILLS_UTILITIES',
  RENT: 'RENT',
  HEALTH: 'HEALTH',
  EDUCATION: 'EDUCATION',
  TRAVEL: 'TRAVEL',
  INVESTMENTS: 'INVESTMENTS',
  FEES_CHARGES: 'FEES_CHARGES',
  TRANSFER: 'TRANSFER',
  INCOME: 'INCOME',
  OTHER: 'OTHER',
});

const CATEGORY_LIST = Object.freeze(Object.values(CATEGORIES));

const CATEGORY_LABELS = Object.freeze({
  FOOD: 'Food & Dining',
  GROCERIES: 'Groceries',
  TRANSPORT: 'Transport',
  FUEL: 'Fuel',
  SHOPPING: 'Shopping',
  ENTERTAINMENT: 'Entertainment',
  SUBSCRIPTIONS: 'Subscriptions',
  BILLS_UTILITIES: 'Bills & Utilities',
  RENT: 'Rent & Housing',
  HEALTH: 'Health & Fitness',
  EDUCATION: 'Education',
  TRAVEL: 'Travel',
  INVESTMENTS: 'Investments & Savings',
  FEES_CHARGES: 'Fees & Charges',
  TRANSFER: 'Transfers',
  INCOME: 'Income',
  OTHER: 'Uncategorised',
});

const TRANSACTION_TYPES = Object.freeze({ DEBIT: 'debit', CREDIT: 'credit' });
const TRANSACTION_TYPE_LIST = Object.freeze(Object.values(TRANSACTION_TYPES));

const EXPENSE_SOURCES = Object.freeze({
  MANUAL: 'manual',
  SMS: 'sms',
  IMPORT: 'import',
  RECURRING: 'recurring',
});
const EXPENSE_SOURCE_LIST = Object.freeze(Object.values(EXPENSE_SOURCES));

const PAYMENT_METHODS = Object.freeze([
  'cash',
  'upi',
  'debit_card',
  'credit_card',
  'net_banking',
  'wallet',
  'auto_debit',
  'other',
]);

/** Categories excluded from "spending" analytics (they move money, they don't burn it). */
const NON_SPEND_CATEGORIES = Object.freeze([CATEGORIES.INCOME, CATEGORIES.TRANSFER, CATEGORIES.INVESTMENTS]);

module.exports = {
  CATEGORIES,
  CATEGORY_LIST,
  CATEGORY_LABELS,
  TRANSACTION_TYPES,
  TRANSACTION_TYPE_LIST,
  EXPENSE_SOURCES,
  EXPENSE_SOURCE_LIST,
  PAYMENT_METHODS,
  NON_SPEND_CATEGORIES,
};
