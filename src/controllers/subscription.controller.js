'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/apiResponse');
const subscriptionService = require('../services/subscription.service');

/** Re-runs recurrence detection over the user's history. */
const detect = asyncHandler(async (req, res) => {
  const result = await subscriptionService.detectSubscriptions(req.user, req.body);
  return success(res, {
    message: `${result.detected.length} recurring payments detected`,
    data: result,
  });
});

const list = asyncHandler(async (req, res) => {
  const data = await subscriptionService.listSubscriptions(req.user, req.query);
  return success(res, { data });
});

/** Confirm or dismiss a detection; the detector will not override the verdict. */
const review = asyncHandler(async (req, res) => {
  const subscription = await subscriptionService.reviewSubscription(req.user, req.params.id, req.body);
  return success(res, { message: 'Subscription updated', data: { subscription } });
});

const upcoming = asyncHandler(async (req, res) => {
  const data = await subscriptionService.getUpcomingCharges(req.user, req.query);
  return success(res, { data });
});

module.exports = { detect, list, review, upcoming };
