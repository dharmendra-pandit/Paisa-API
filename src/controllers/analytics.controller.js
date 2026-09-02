'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/apiResponse');
const analyticsService = require('../services/analytics.service');

const summary = asyncHandler(async (req, res) => {
  const data = await analyticsService.getMonthlySummary(req.user, req.query);
  return success(res, { data });
});

const breakdown = asyncHandler(async (req, res) => {
  const data = await analyticsService.getCategoryBreakdown(req.user, req.query);
  return success(res, { data });
});

const trends = asyncHandler(async (req, res) => {
  const data = await analyticsService.getTrends(req.user, req.query);
  return success(res, { data });
});

const weekday = asyncHandler(async (req, res) => {
  const data = await analyticsService.getWeekdayPattern(req.user, req.query);
  return success(res, { data });
});

const merchants = asyncHandler(async (req, res) => {
  const data = await analyticsService.getTopMerchants(req.user, req.query);
  return success(res, { data });
});

/** Everything a home screen needs, in one round trip. */
const dashboard = asyncHandler(async (req, res) => {
  const data = await analyticsService.getDashboard(req.user);
  return success(res, { data });
});

module.exports = { summary, breakdown, trends, weekday, merchants, dashboard };
