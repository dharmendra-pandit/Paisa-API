'use strict';

const crypto = require('crypto');

/**
 * Stamps every request with a correlation id, echoed back as `X-Request-Id`
 * and attached to every log line and error body. An upstream proxy id is
 * honoured so a trace survives across hops.
 */
function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.id = typeof incoming === 'string' && incoming.length <= 64 ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = requestId;
