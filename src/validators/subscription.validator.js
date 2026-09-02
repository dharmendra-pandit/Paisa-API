'use strict';

const { z } = require('zod');
const { idParam, booleanish } = require('./common.validator');

const detect = {
  body: z.object({
    lookbackDays: z.coerce.number().int().min(30).max(730).optional(),
    // persist=false runs the detector as a dry run.
    persist: booleanish.optional().default(true),
  }),
};

const list = {
  query: z.object({
    status: z.enum(['active', 'lapsed', 'cancelled']).optional(),
    includeDismissed: booleanish.optional(),
  }),
};

const review = {
  params: idParam,
  body: z
    .object({
      verdict: z.enum(['unreviewed', 'confirmed', 'dismissed']).optional(),
      status: z.enum(['active', 'lapsed', 'cancelled']).optional(),
    })
    .refine((value) => value.verdict || value.status, { message: 'Provide a verdict or a status' }),
};

const upcoming = {
  query: z.object({ days: z.coerce.number().int().min(1).max(180).optional() }),
};

module.exports = { detect, list, review, upcoming };
