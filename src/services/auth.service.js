'use strict';

const bcrypt = require('bcryptjs');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const config = require('../config/env');
const tokenService = require('./token.service');
const logger = require('../utils/logger');
const groupService = require('./group.service');

/**
 * Registers a new account.
 *
 * The duplicate check is best-effort — the unique index on `email` is the real
 * guarantee against a race between two concurrent signups, and the 11000 path
 * below turns that into the same friendly 409.
 */
async function signup({ name, email, password, currency, timezone, monthlyIncome }) {
  const normalizedEmail = String(email).toLowerCase().trim();

  const existing = await User.exists({ email: normalizedEmail });
  if (existing) throw ApiError.conflict('An account with this email already exists');

  try {
    const user = await User.create({
      name,
      email: normalizedEmail,
      password,
      ...(currency ? { currency } : {}),
      ...(timezone ? { timezone } : {}),
      ...(monthlyIncome !== undefined ? { monthlyIncome } : {}),
    });

    // Anyone added to a group by this email before the account existed has
    // balances waiting under a placeholder; link them now. A failure here must
    // never fail the registration itself, so it is logged and swallowed.
    let claimedGroups = { claimed: 0, groups: [] };
    try {
      claimedGroups = await groupService.claimPlaceholders(user);
    } catch (claimErr) {
      logger.error('Failed to claim placeholder group memberships', {
        userId: String(user._id),
        message: claimErr.message,
      });
    }

    logger.info('User registered', { userId: String(user._id), claimedGroups: claimedGroups.claimed });
    return { user, tokens: tokenService.issueTokenPair(user), claimedGroups };
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('An account with this email already exists');
    throw err;
  }
}

/**
 * Authenticates a credential pair.
 *
 * The same message is returned whether the email is unknown or the password is
 * wrong, so the endpoint cannot be used to enumerate registered addresses. The
 * hash comparison runs even for a missing user to keep timing uniform.
 */
async function login({ email, password }) {
  const normalizedEmail = String(email).toLowerCase().trim();
  const user = await User.findOne({ email: normalizedEmail }).select('+password');

  const isValid = user ? await user.comparePassword(password) : await burnTime(password);
  if (!user || !isValid) throw ApiError.unauthorized('Invalid email or password');
  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');

  user.lastLoginAt = new Date();
  await user.save({ validateBeforeSave: false });

  logger.info('User logged in', { userId: String(user._id) });
  return { user, tokens: tokenService.issueTokenPair(user) };
}

/**
 * Equalises response time for unknown emails against a real bcrypt compare, so
 * a fast rejection cannot be read as "that address is not registered".
 * The decoy hash is built once, at the configured cost, on first use.
 */
let decoyHash = null;
async function burnTime(password) {
  if (!decoyHash) decoyHash = await bcrypt.hash('paisa-timing-equaliser', config.bcryptRounds);
  await bcrypt.compare(String(password), decoyHash);
  return false;
}

/**
 * Exchanges a refresh token for a fresh pair. The new refresh token replaces
 * the old one on the client, so a stolen token has a bounded useful life.
 */
async function refreshTokens(refreshToken) {
  if (!refreshToken) throw ApiError.badRequest('A refresh token is required');

  const decoded = tokenService.verifyRefreshToken(refreshToken);
  const user = await User.findById(decoded.sub);

  if (!user) throw ApiError.unauthorized('The account for this token no longer exists');
  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');
  if (user.isTokenRevoked(decoded)) {
    throw ApiError.unauthorized('This session has been revoked, please log in again');
  }

  return { user, tokens: tokenService.issueTokenPair(user) };
}

/**
 * Revokes every live session by advancing the session generation. With
 * stateless JWTs this is what makes "log out of all devices" real.
 */
async function logoutAll(user) {
  user.revokeSessions();
  await user.save({ validateBeforeSave: false });
  return { revokedAt: new Date(), sessionGeneration: user.tokenVersion };
}

async function changePassword(user, { currentPassword, newPassword }) {
  const fresh = await User.findById(user._id).select('+password');
  const matches = await fresh.comparePassword(currentPassword);
  if (!matches) throw ApiError.unauthorized('Your current password is incorrect');

  if (currentPassword === newPassword) {
    throw ApiError.badRequest('Your new password must be different from the current one');
  }

  // The pre-save hook re-hashes and bumps tokenVersion, killing old sessions.
  fresh.password = newPassword;
  await fresh.save();

  logger.info('Password changed', { userId: String(fresh._id) });
  return { user: fresh, tokens: tokenService.issueTokenPair(fresh) };
}

async function updateProfile(user, payload) {
  const assignable = ['name', 'currency', 'timezone', 'monthlyIncome'];
  for (const field of assignable) {
    if (payload[field] !== undefined) user[field] = payload[field];
  }

  if (payload.preferences) {
    for (const [key, value] of Object.entries(payload.preferences)) {
      if (value !== undefined) user.preferences[key] = value;
    }
  }

  await user.save();
  return user;
}

async function deactivate(user) {
  user.isActive = false;
  user.revokeSessions();
  await user.save({ validateBeforeSave: false });
  return { deactivated: true };
}

module.exports = {
  signup,
  login,
  refreshTokens,
  logoutAll,
  changePassword,
  updateProfile,
  deactivate,
};
