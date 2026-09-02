'use strict';

const { z } = require('zod');
const {
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
} = require('./common.validator');

const createBody = z.object({
  amount,
  // Omitting the category is the normal path — it triggers auto-categorisation.
  category: category.optional(),
  type: transactionType.optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  note: z.string().trim().max(500).optional(),
  merchant: z.string().trim().max(120).optional(),
  date: dateString.optional(),
  paymentMethod: paymentMethod.optional(),
  tags: tags.optional(),
  source: expenseSource.optional(),
  isSubscription: z.boolean().optional(),
});

const create = { body: createBody };

const bulkCreate = {
  body: z.object({
    expenses: z.array(createBody).min(1, 'Provide at least one expense').max(100, 'At most 100 expenses per request'),
  }),
};

const update = {
  params: idParam,
  body: z
    .object({
      amount: amount.optional(),
      category: category.optional(),
      type: transactionType.optional(),
      currency: z.string().trim().length(3).toUpperCase().optional(),
      note: z.string().trim().max(500).optional(),
      merchant: z.string().trim().max(120).optional(),
      date: dateString.optional(),
      paymentMethod: paymentMethod.optional(),
      tags: tags.optional(),
      isSubscription: z.boolean().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' }),
};

const list = {
  query: z
    .object({
      ...pagination,
      month: monthString.optional(),
      startDate: dateString.optional(),
      endDate: dateString.optional(),
      category: csvList(category).optional(),
      type: transactionType.optional(),
      source: expenseSource.optional(),
      paymentMethod: paymentMethod.optional(),
      tags: tags.optional(),
      minAmount: z.coerce.number().min(0).optional(),
      maxAmount: z.coerce.number().min(0).optional(),
      search: z.string().trim().min(1).max(100).optional(),
      isSubscription: booleanish.optional(),
      includeDeleted: booleanish.optional(),
      sortBy: z.enum(['date', 'amount', 'createdAt', 'category']).default('date'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    })
    .refine((q) => !(q.minAmount !== undefined && q.maxAmount !== undefined) || q.maxAmount >= q.minAmount, {
      message: 'maxAmount must be greater than or equal to minAmount',
      path: ['maxAmount'],
    })
    .refine((q) => !(q.startDate && q.endDate) || q.endDate >= q.startDate, {
      message: 'endDate must be on or after startDate',
      path: ['endDate'],
    }),
};

const byId = { params: idParam };

const remove = {
  params: idParam,
  query: z.object({ hard: booleanish.optional() }),
};

/** Dry-run classification, so a client can preview a category before saving. */
const categorize = {
  body: z.object({
    merchant: z.string().trim().max(120).optional(),
    note: z.string().trim().max(500).optional(),
    amount: z.coerce.number().min(0).optional(),
    type: transactionType.optional(),
  }),
};

module.exports = { create, bulkCreate, update, list, byId, remove, categorize };
