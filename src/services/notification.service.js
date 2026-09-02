'use strict';

const logger = require('../utils/logger');
const { formatCurrency } = require('../utils/money');
const { CATEGORY_LABELS } = require('../constants/categories');
const { OVERALL } = require('../models/Budget');

/**
 * Delivery seam for budget warnings.
 *
 * Alerts are computed and persisted by the budget service; this module is the
 * single place that would fan them out to push/email/SMS. It logs today, and a
 * real provider drops in behind `deliver()` without touching business logic.
 */

function buildMessage({ level, budget, spent, percentage, currency }) {
  const scope = budget.category === OVERALL ? 'monthly budget' : `${CATEGORY_LABELS[budget.category]} budget`;
  const spentText = formatCurrency(spent, currency);
  const capText = formatCurrency(budget.amount, currency);

  if (level === 'exceeded') {
    return `You have exceeded your ${scope} for ${budget.month}: ${spentText} of ${capText} (${percentage}%).`;
  }
  return `Heads up — you have used ${percentage}% of your ${scope} for ${budget.month}: ${spentText} of ${capText}.`;
}

async function deliver(notification) {
  logger.warn('Budget alert', {
    userId: String(notification.userId),
    level: notification.level,
    month: notification.month,
    category: notification.category,
    percentage: notification.percentage,
  });
  // Replace with a push/email provider call. Kept async so swapping in a real
  // transport does not change any caller.
  return notification;
}

module.exports = { buildMessage, deliver };
