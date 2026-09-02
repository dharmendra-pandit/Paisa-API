'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');

const { accessSecret, refreshSecret, accessExpiresIn, refreshExpiresIn, issuer, audience } = config.jwt;

/**
 * Access and refresh tokens are signed with *different* secrets and carry a
 * `type` claim, so a refresh token can never be replayed as an access token
 * even if a verifier is wired up incorrectly.
 */
function sign(payload, secret, expiresIn) {
  return jwt.sign(payload, secret, {
    expiresIn,
    issuer,
    audience,
    jwtid: crypto.randomUUID(),
  });
}

function generateAccessToken(user) {
  return sign({ sub: String(user._id), email: user.email, type: 'access', tv: user.tokenVersion || 0 }, accessSecret, accessExpiresIn);
}

function generateRefreshToken(user) {
  return sign({ sub: String(user._id), type: 'refresh', tv: user.tokenVersion || 0 }, refreshSecret, refreshExpiresIn);
}

function verify(token, secret, expectedType) {
  const decoded = jwt.verify(token, secret, { issuer, audience });
  if (decoded.type !== expectedType) {
    throw ApiError.unauthorized(`Expected a ${expectedType} token`);
  }
  return decoded;
}

const verifyAccessToken = (token) => verify(token, accessSecret, 'access');
const verifyRefreshToken = (token) => verify(token, refreshSecret, 'refresh');

/** Seconds until expiry, handy for clients that pre-emptively refresh. */
function expiresInSeconds(token) {
  const { exp } = jwt.decode(token) || {};
  return exp ? Math.max(0, exp - Math.floor(Date.now() / 1000)) : null;
}

function issueTokenPair(user) {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: expiresInSeconds(accessToken),
  };
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  issueTokenPair,
  expiresInSeconds,
};
