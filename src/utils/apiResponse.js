'use strict';

/** Every successful response shares this envelope so clients can parse uniformly. */
function success(res, { data = null, message = 'OK', statusCode = 200, meta } = {}) {
  const body = { success: true, message, data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
}

function created(res, { data, message = 'Created', meta } = {}) {
  return success(res, { data, message, statusCode: 201, meta });
}

/** Builds the pagination block used by every list endpoint. */
function paginationMeta({ total, page, limit }) {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}

module.exports = { success, created, paginationMeta };
