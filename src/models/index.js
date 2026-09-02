'use strict';

/**
 * Central model registry.
 *
 * Requiring this module guarantees every schema is compiled and registered on
 * the mongoose connection. Scripts that operate across all models (index sync,
 * backups, maintenance) need that guarantee — `mongoose.models` is only
 * populated for files that have actually been imported, so a script that
 * requires models ad-hoc silently skips whichever ones it forgot.
 */

const User = require('./User');
const Expense = require('./Expense');
const Budget = require('./Budget');
const Subscription = require('./Subscription');
const Group = require('./Group');
const SplitExpense = require('./SplitExpense');
const Settlement = require('./Settlement');

module.exports = { User, Expense, Budget, Subscription, Group, SplitExpense, Settlement };
