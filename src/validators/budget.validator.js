'use strict';

const { z } = require('zod');
const { idParam, monthString, amount, category } = require('./common.validator');
const { OVERALL } = require('../models/Budget');

const setBudget = {
  body: z.object({
    amount,
    // Defaults to the current month and the overall (non category) cap.
    month: monthString.optional(),
    category: z.union([category, z.literal(OVERALL)]).optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    alertThreshold: z.coerce
      .number()
      .min(0.1, 'Alert threshold must be at least 0.1 (10%)')
      .max(1, 'Alert threshold cannot exceed 1 (100%)')
      .optional(),
    alertsEnabled: z.boolean().optional(),
    autoRenew: z.boolean().optional(),
    note: z.string().trim().max(200).optional(),
  }),
};

const list = {
  query: z.object({ month: monthString.optional() }),
};

const byId = { params: idParam };

const rollover = {
  body: z.object({
    fromMonth: monthString.optional(),
    toMonth: monthString.optional(),
  }),
};

module.exports = { setBudget, list, byId, rollover };
