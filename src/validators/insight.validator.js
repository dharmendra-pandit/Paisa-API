'use strict';

const { z } = require('zod');
const { monthString, csvList } = require('./common.validator');

const INSIGHT_TYPES = [
  'spending_trend',
  'weekend_pattern',
  'category_spike',
  'category_concentration',
  'unusual_transaction',
  'small_spend_leak',
  'subscription_burden',
  'budget_pace',
  'savings_rate',
  'month_projection',
  'peak_day',
  'onboarding',
];

const list = {
  query: z.object({
    month: monthString.optional(),
    limit: z.coerce.number().int().min(1).max(25).default(10),
    types: csvList(z.enum(INSIGHT_TYPES)).optional(),
  }),
};

const summary = { query: z.object({ month: monthString.optional() }) };

module.exports = { list, summary, INSIGHT_TYPES };
