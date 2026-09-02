'use strict';

const { z } = require('zod');

/**
 * The conversation is sent whole on every turn — the server keeps no chat
 * state. That is deliberate: a stateless endpoint needs no session store, and
 * the client already holds the transcript it is rendering.
 */
const chat = {
  body: z.object({
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().trim().min(1, 'Messages cannot be empty').max(4000),
        })
      )
      .min(1, 'Ask Paisa AI a question to get started')
      .max(20, 'This conversation is too long. Start a new chat to continue'),
    includeContext: z.boolean().optional(),
  }),
};

module.exports = { chat };
