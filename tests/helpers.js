'use strict';

const request = require('supertest');
const createApp = require('../src/app');
const config = require('../src/config/env');
const Expense = require('../src/models/Expense');
const User = require('../src/models/User');
const categorizationService = require('../src/services/categorization.service');
const { CATEGORIES } = require('../src/constants/categories');

const app = createApp();
const api = (path) => `${config.apiPrefix}${path}`;

const DEFAULT_USER = {
  name: 'Test User',
  email: 'test@paisa.app',
  password: 'Paisa@2026',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  monthlyIncome: 80000,
};

/** Registers a user and returns the record plus a ready-made auth header. */
async function registerUser(overrides = {}) {
  const payload = { ...DEFAULT_USER, ...overrides };
  const response = await request(app).post(api('/auth/signup')).send(payload).expect(201);

  const { user, accessToken, refreshToken } = response.body.data;
  const document = await User.findById(user.id);

  return {
    user,
    document,
    accessToken,
    refreshToken,
    password: payload.password,
    auth: { Authorization: `Bearer ${accessToken}` },
  };
}

/**
 * Inserts expenses directly, bypassing the API.
 *
 * Analytics and insight suites need dozens of rows at specific dates; going
 * through HTTP for each would make those tests slow and hard to read.
 */
async function seedExpenses(userId, rows) {
  const documents = rows.map((row) => ({
    user: userId,
    amount: row.amount,
    currency: row.currency || 'INR',
    type: row.type || 'debit',
    category: row.category || CATEGORIES.OTHER,
    categoryConfirmed: row.categoryConfirmed !== false,
    categorization: { method: 'manual', confidence: 1 },
    note: row.note || '',
    merchant: row.merchant || '',
    merchantKey: categorizationService.buildMerchantKey(row.merchant || ''),
    date: row.date instanceof Date ? row.date : new Date(row.date),
    paymentMethod: row.paymentMethod || 'other',
    tags: row.tags || [],
    source: row.source || 'manual',
    isSubscription: Boolean(row.isSubscription),
  }));

  return Expense.insertMany(documents);
}

/** Midnight in the user's timezone, N days before now. */
function daysAgo(days, hour = 12) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}

/** Same day-of-month, N months back — used to build recurring charge series. */
function monthsAgo(months, day = 15, hour = 10) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, day, hour, 0, 0));
}

module.exports = { app, api, request, registerUser, seedExpenses, daysAgo, monthsAgo, DEFAULT_USER };
