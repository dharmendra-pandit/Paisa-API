'use strict';

const { z } = require('zod');
const mongoose = require('mongoose');
const { CATEGORY_LIST, TRANSACTION_TYPE_LIST, EXPENSE_SOURCE_LIST, PAYMENT_METHODS } = require('../constants/categories');

/** Reusable primitives shared by every request schema. */

const objectId = z
  .string()
  .refine((value) => mongoose.Types.ObjectId.isValid(value), { message: 'Must be a valid resource id' });

const idParam = z.object({ id: objectId });

const monthString = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be in YYYY-MM format (e.g. 2026-08)');

/** Accepts YYYY-MM-DD or a full ISO timestamp and yields a Date. */
const dateString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Must be a valid ISO date (YYYY-MM-DD)' })
  .transform((value) => new Date(value));

const amount = z.coerce
  .number({ invalid_type_error: 'Amount must be a number' })
  .positive('Amount must be greater than zero')
  .max(100000000, 'Amount is unrealistically large')
  // Money is 2dp; silently truncating extra precision beats rejecting it.
  .transform((value) => Math.round(value * 100) / 100);

const category = z.enum(CATEGORY_LIST, {
  errorMap: () => ({ message: `Category must be one of: ${CATEGORY_LIST.join(', ')}` }),
});

const transactionType = z.enum(TRANSACTION_TYPE_LIST);
const expenseSource = z.enum(EXPENSE_SOURCE_LIST);
const paymentMethod = z.enum(PAYMENT_METHODS);

/** Query strings arrive as "FOOD,TRANSPORT" or repeated params; both work. */
const csvList = (schema) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value : value.split(',')))
    .transform((values) => values.map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(schema));

/** "true"/"false"/"1"/"0" from a query string into a real boolean. */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : ['1', 'true', 'yes'].includes(value.toLowerCase())));

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  // Capped so a client cannot ask for the whole collection in one page.
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

const tags = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : value.split(',')))
  .transform((values) => [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))].slice(0, 10))
  .pipe(z.array(z.string().max(30)));

module.exports = {
  objectId,
  idParam,
  monthString,
  dateString,
  amount,
  category,
  transactionType,
  expenseSource,
  paymentMethod,
  csvList,
  booleanish,
  pagination,
  tags,
};
