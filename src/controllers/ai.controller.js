'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/apiResponse');
const aiService = require('../services/ai.service');

const chat = asyncHandler(async (req, res) => {
  const data = await aiService.chat(req.user, req.body);
  return success(res, { data });
});

/** Lets a client hide the assistant entirely when the server has no key. */
const status = asyncHandler(async (_req, res) => success(res, { data: aiService.status() }));

module.exports = { chat, status };
