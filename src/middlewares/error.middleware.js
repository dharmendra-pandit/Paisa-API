'use strict';

const mongoose = require('mongoose');
const { ZodError } = require('zod');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const config = require('../config/env');

/** Terminal 404 for unmatched routes — runs after every router. */
function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} does not exist`));
}

/**
 * Translates the error zoo (Mongoose, JWT, Zod, body-parser, our own ApiError)
 * into one predictable client contract. Anything unrecognised is a programmer
 * error: logged in full, reported as an opaque 500.
 */
function normalize(err) {
  if (err instanceof ApiError) return err;

  if (err instanceof ZodError) {
    return ApiError.unprocessable('Validation failed', formatZodIssues(err));
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    return ApiError.unprocessable('Validation failed', details);
  }

  if (err instanceof mongoose.Error.CastError) {
    return ApiError.badRequest(`Invalid value for "${err.path}"`, [{ field: err.path, message: `"${err.value}" is not a valid ${err.kind}` }]);
  }

  // 11000 = duplicate key against a unique index.
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || err.keyValue || {}).join(', ') || 'field';
    return ApiError.conflict(`A record with this ${field} already exists`, [{ field, message: 'must be unique' }]);
  }

  if (err.name === 'TokenExpiredError') {
    return new ApiError(401, 'Your session has expired, please log in again', { code: 'TOKEN_EXPIRED' });
  }

  if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
    return new ApiError(401, 'Invalid authentication token', { code: 'TOKEN_INVALID' });
  }

  // Thrown by express.json() on malformed payloads.
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return ApiError.badRequest('Request body is not valid JSON');
  }

  if (err.type === 'entity.too.large') {
    return new ApiError(413, 'Request body is too large', { code: 'PAYLOAD_TOO_LARGE' });
  }

  return new ApiError(err.statusCode || 500, err.message || 'Something went wrong', {
    code: err.code && typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR',
    isOperational: false,
  });
}

function formatZodIssues(err) {
  return err.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
function errorHandler(err, req, res, _next) {
  const apiError = normalize(err);

  const context = {
    method: req.method,
    path: req.originalUrl,
    status: apiError.statusCode,
    requestId: req.id,
    userId: req.user ? String(req.user._id) : undefined,
  };

  if (apiError.statusCode >= 500) {
    logger.error(apiError.message, { ...context, stack: err.stack });
  } else {
    logger.warn(apiError.message, context);
  }

  const body = {
    success: false,
    message: apiError.statusCode >= 500 && config.isProd ? 'Something went wrong' : apiError.message,
    error: { code: apiError.code, ...(apiError.details ? { details: apiError.details } : {}) },
  };

  if (req.id) body.requestId = req.id;
  // Stacks are a debugging aid, never a production response field.
  if (!config.isProd && apiError.statusCode >= 500) body.error.stack = err.stack;

  return res.status(apiError.statusCode).json(body);
}

module.exports = { notFoundHandler, errorHandler };
