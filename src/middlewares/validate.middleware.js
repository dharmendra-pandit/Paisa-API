'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Builds a middleware from a `{ body, query, params }` map of Zod schemas.
 *
 * Parsed output replaces the raw input, so controllers receive coerced,
 * stripped, defaulted values and never re-validate. Express 5 exposes `query`
 * as a getter, so the parsed query is redefined rather than assigned.
 */
function validate(schemas) {
  return (req, _res, next) => {
    const details = [];

    for (const source of ['params', 'query', 'body']) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);
      if (!result.success) {
        for (const issue of result.error.issues) {
          details.push({
            field: [source, ...issue.path].join('.'),
            message: issue.message,
            code: issue.code,
          });
        }
        continue;
      }

      if (source === 'query') {
        Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
      } else {
        req[source] = result.data;
      }
    }

    if (details.length) return next(ApiError.unprocessable('Validation failed', details));
    return next();
  };
}

module.exports = validate;
