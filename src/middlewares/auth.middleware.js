'use strict';

const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const tokenService = require('../services/token.service');

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  // Cookie fallback keeps browser clients working without a JS-readable token.
  if (req.cookies && req.cookies.accessToken) return req.cookies.accessToken;
  return null;
}

/**
 * Rejects the request unless it carries a live access token belonging to an
 * active user. The user is re-read on every request so a deactivation or a
 * password change takes effect immediately rather than at token expiry.
 */
const authenticate = asyncHandler(async (req, _res, next) => {
  const token = extractBearerToken(req);
  if (!token) throw ApiError.unauthorized('Authentication required. Send an Authorization: Bearer <token> header.');

  const decoded = tokenService.verifyAccessToken(token);

  const user = await User.findById(decoded.sub);
  if (!user) throw ApiError.unauthorized('The account for this token no longer exists');
  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');
  if (user.isTokenRevoked(decoded)) {
    throw ApiError.unauthorized('Your session is no longer valid, please log in again');
  }

  req.user = user;
  req.token = token;
  return next();
});

/** Attaches the user when a valid token is present, but never blocks. */
const optionalAuth = asyncHandler(async (req, _res, next) => {
  const token = extractBearerToken(req);
  if (!token) return next();
  try {
    const decoded = tokenService.verifyAccessToken(token);
    const user = await User.findById(decoded.sub);
    if (user && user.isActive && !user.isTokenRevoked(decoded)) req.user = user;
  } catch {
    // Anonymous is a valid outcome here.
  }
  return next();
});

module.exports = { authenticate, optionalAuth, extractBearerToken };
