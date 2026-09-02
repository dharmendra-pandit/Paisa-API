'use strict';

const { z } = require('zod');
const { monthString, dateString, booleanish } = require('./common.validator');

/** Shared window selector: either a month, or an explicit date range. */
const rangeQuery = z
  .object({
    month: monthString.optional(),
    startDate: dateString.optional(),
    endDate: dateString.optional(),
  })
  .refine((q) => !(q.startDate && q.endDate) || q.endDate >= q.startDate, {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
  });

const summary = { query: z.object({ month: monthString.optional() }) };

const breakdown = {
  query: rangeQuery.and(
    z.object({
      limit: z.coerce.number().int().min(1).max(20).optional(),
      includeNonSpend: booleanish.optional(),
    })
  ),
};

const trends = {
  query: rangeQuery.and(
    z.object({
      granularity: z.enum(['day', 'week', 'month']).default('day'),
    })
  ),
};

const merchants = {
  query: rangeQuery.and(z.object({ limit: z.coerce.number().int().min(1).max(50).optional() })),
};

const weekday = { query: rangeQuery };

module.exports = { summary, breakdown, trends, merchants, weekday, rangeQuery };
