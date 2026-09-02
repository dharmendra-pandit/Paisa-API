'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { success, created } = require('../utils/apiResponse');
const smsService = require('../services/sms.service');

/**
 * Ingests one bank SMS.
 *
 * The status code reflects what actually happened: 201 for a new expense, 200
 * for a duplicate, a preview, or a message we deliberately ignored. A rejected
 * message is not an error — a promotional SMS being skipped is the parser
 * working correctly.
 */
const parse = asyncHandler(async (req, res) => {
  const result = await smsService.ingestSms(req.user, req.body);

  const messages = {
    created: 'SMS converted into an expense',
    duplicate: 'This SMS was already recorded',
    ignored: 'Message was not a transaction and has been skipped',
    parsed: 'SMS parsed (preview only, nothing saved)',
  };

  const payload = {
    status: result.status,
    parsed: result.parsed,
    expense: result.expense,
    budgetAlerts: result.alerts || [],
    ...(result.reason ? { reason: result.reason } : {}),
  };

  if (result.status === 'created') return created(res, { message: messages.created, data: payload });
  return success(res, { message: messages[result.status], data: payload });
});

/** Bulk import — reports per-message outcomes so partial success is visible. */
const parseBatch = asyncHandler(async (req, res) => {
  const { messages, save } = req.body;
  const result = await smsService.ingestBatch(req.user, messages, { save });
  return success(res, {
    message: `${result.summary.created} of ${result.total} messages converted into expenses`,
    data: result,
  });
});

module.exports = { parse, parseBatch };
