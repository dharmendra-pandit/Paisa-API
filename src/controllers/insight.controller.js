'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/apiResponse');
const insightService = require('../services/insight.service');
const { INSIGHT_TYPES } = require('../validators/insight.validator');

const list = asyncHandler(async (req, res) => {
  const data = await insightService.generateInsights(req.user, req.query);
  return success(res, { message: `${data.insights.length} insights generated`, data });
});

/** One-line digest — what a push notification or email subject would carry. */
const summary = asyncHandler(async (req, res) => {
  const data = await insightService.generateSummary(req.user, req.query);
  return success(res, { data });
});

/** Discovery endpoint so clients can build type filters without hardcoding. */
const types = asyncHandler(async (_req, res) => success(res, { data: { types: INSIGHT_TYPES } }));

module.exports = { list, summary, types };
