'use strict';

/**
 * Operational (expected) application error. Anything thrown that is NOT an
 * ApiError is treated as a programmer error by the global error handler and is
 * reported as a 500 with the stack hidden from clients in production.
 */
class ApiError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = options.code || defaultCode(statusCode);
    this.details = options.details;
    this.isOperational = options.isOperational !== false;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = 'Bad request', details) {
    return new ApiError(400, message, { code: 'BAD_REQUEST', details });
  }

  static unauthorized(message = 'Authentication required', details) {
    return new ApiError(401, message, { code: 'UNAUTHORIZED', details });
  }

  static forbidden(message = 'You do not have access to this resource', details) {
    return new ApiError(403, message, { code: 'FORBIDDEN', details });
  }

  static notFound(message = 'Resource not found', details) {
    return new ApiError(404, message, { code: 'NOT_FOUND', details });
  }

  static conflict(message = 'Resource already exists', details) {
    return new ApiError(409, message, { code: 'CONFLICT', details });
  }

  static unprocessable(message = 'Validation failed', details) {
    return new ApiError(422, message, { code: 'VALIDATION_ERROR', details });
  }

  static tooMany(message = 'Too many requests', details) {
    return new ApiError(429, message, { code: 'RATE_LIMITED', details });
  }

  static internal(message = 'Something went wrong', details) {
    return new ApiError(500, message, { code: 'INTERNAL_ERROR', details, isOperational: false });
  }
}

function defaultCode(statusCode) {
  const map = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'VALIDATION_ERROR',
    429: 'RATE_LIMITED',
  };
  return map[statusCode] || 'INTERNAL_ERROR';
}

module.exports = ApiError;
