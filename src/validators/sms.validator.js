'use strict';

const { z } = require('zod');
const { booleanish, dateString } = require('./common.validator');

const smsEntry = z.object({
  message: z.string().trim().min(10, 'An SMS body must be at least 10 characters').max(1000),
  sender: z.string().trim().max(40).optional(),
  receivedAt: dateString.optional(),
});

const parse = {
  body: smsEntry.extend({
    // save=false previews the parse without writing anything.
    save: booleanish.optional().default(true),
  }),
};

const parseBatch = {
  body: z.object({
    messages: z.array(smsEntry).min(1, 'Provide at least one message').max(50, 'At most 50 messages per request'),
    save: booleanish.optional().default(true),
  }),
};

module.exports = { parse, parseBatch };
