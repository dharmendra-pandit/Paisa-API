'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');

/**
 * Collapses an IPv6 address to its /64 prefix.
 *
 * ISPs hand out a /64 (or larger) to a single customer, so every one of the
 * 2^64 addresses inside it belongs to the same actor. Keying the limiter on the
 * full address would let one client walk through fresh addresses in its own
 * prefix and get an unlimited number of login attempts — the auth limiter's
 * 20-request budget would be worth nothing. Bucketing by /64 makes the limit
 * apply per subscriber, which is what it was meant to mean.
 *
 * IPv4 (and IPv4-mapped IPv6, which Node reports as ::ffff:1.2.3.4) is already
 * per-host, so it is returned unchanged.
 */
function normalizeIp(ip) {
  if (!ip) return 'unknown';

  // Node reports IPv4 over a dual-stack socket as ::ffff:203.0.113.7.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];

  if (!ip.includes(':')) return ip;

  // Expand the :: shorthand so the first four hextets can be read positionally.
  const [head, tail = ''] = ip.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headParts.length - tailParts.length;
  const full = ip.includes('::') ? [...headParts, ...Array(Math.max(0, missing)).fill('0'), ...tailParts] : headParts;

  return `${full.slice(0, 4).map((h) => h.toLowerCase()).join(':')}::/64`;
}

/**
 * Limits are keyed by user id when authenticated, network otherwise, so one
 * noisy corporate NAT does not exhaust the quota of everyone behind it — while
 * an anonymous attacker still cannot escape their bucket by rotating addresses.
 */
function keyGenerator(req) {
  if (req.user) return `u:${req.user._id}`;
  return `ip:${normalizeIp(req.ip)}`;
}

function handler(_req, _res, next) {
  next(ApiError.tooMany('Too many requests. Please slow down and try again shortly.'));
}

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator,
  handler,
  // Rate limiting a test suite only produces flaky tests.
  skip: () => config.isTest,
};

/** Blanket limiter applied to the whole API surface. */
const apiLimiter = rateLimit({ ...base, windowMs: config.rateLimit.windowMs, max: config.rateLimit.max });

/** Tighter budget for credential endpoints, which are the brute-force target. */
const authLimiter = rateLimit({
  ...base,
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  skipSuccessfulRequests: true,
});

/** Bulk SMS ingestion is expensive; keep it on a short leash. */
const smsLimiter = rateLimit({ ...base, windowMs: 60 * 1000, max: 60 });

/**
 * Group and split writes fan out into balance recomputation across every member,
 * so they get a dedicated budget rather than sharing the blanket API allowance.
 */
const splitLimiter = rateLimit({ ...base, windowMs: 60 * 1000, max: 90 });

/**
 * Every assistant call costs real money upstream and takes seconds to answer,
 * so it gets its own small budget. Keyed per user by the shared keyGenerator,
 * which matters here: this is a spend limit per account, not per network.
 */
const aiLimiter = rateLimit({ ...base, windowMs: config.rateLimit.windowMs, max: config.rateLimit.aiMax });

module.exports = { apiLimiter, authLimiter, smsLimiter, splitLimiter, aiLimiter, normalizeIp };
