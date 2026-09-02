'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { success, created } = require('../utils/apiResponse');
const authService = require('../services/auth.service');

const signup = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.signup(req.body);
  return created(res, { message: 'Account created successfully', data: { user, ...tokens } });
});

const login = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.login(req.body);
  return success(res, { message: 'Logged in successfully', data: { user, ...tokens } });
});

const refresh = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.refreshTokens(req.body.refreshToken);
  return success(res, { message: 'Token refreshed', data: { user, ...tokens } });
});

const me = asyncHandler(async (req, res) => success(res, { data: { user: req.user } }));

const updateProfile = asyncHandler(async (req, res) => {
  const user = await authService.updateProfile(req.user, req.body);
  return success(res, { message: 'Profile updated', data: { user } });
});

const changePassword = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.changePassword(req.user, req.body);
  return success(res, { message: 'Password changed. Other sessions have been signed out.', data: { user, ...tokens } });
});

/**
 * With stateless JWTs the access token stays valid until it expires; this
 * revokes every refresh token so no new access token can be minted.
 */
const logout = asyncHandler(async (req, res) => {
  const result = await authService.logoutAll(req.user);
  return success(res, { message: 'Signed out of all devices', data: result });
});

const deactivate = asyncHandler(async (req, res) => {
  const result = await authService.deactivate(req.user);
  return success(res, { message: 'Account deactivated', data: result });
});

module.exports = { signup, login, refresh, me, updateProfile, changePassword, logout, deactivate };
