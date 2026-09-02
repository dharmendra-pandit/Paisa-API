'use strict';

const { app, api, request, registerUser, seedExpenses, daysAgo } = require('./helpers');
const { CATEGORIES } = require('../src/constants/categories');

describe('Expenses', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await registerUser();
  });

  describe('POST /expenses', () => {
    it('records an expense and auto-categorises it', async () => {
      const response = await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 480, merchant: 'Swiggy', note: 'Dinner order', paymentMethod: 'upi' })
        .expect(201);

      const { expense } = response.body.data;
      expect(expense.amount).toBe(480);
      expect(expense.category).toBe(CATEGORIES.FOOD);
      expect(expense.categoryConfirmed).toBe(false);
      expect(expense.categorization.method).toBe('rule-engine');
      expect(expense.categorization.confidence).toBeGreaterThan(0.5);
    });

    it('treats an explicit category as user-confirmed', async () => {
      const response = await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 12000, category: CATEGORIES.RENT, merchant: 'Landlord' })
        .expect(201);

      expect(response.body.data.expense.category).toBe(CATEGORIES.RENT);
      expect(response.body.data.expense.categoryConfirmed).toBe(true);
      expect(response.body.data.expense.categorization.method).toBe('manual');
    });

    it('rejects a zero or negative amount', async () => {
      await request(app).post(api('/expenses')).set(ctx.auth).send({ amount: 0 }).expect(422);
      await request(app).post(api('/expenses')).set(ctx.auth).send({ amount: -100 }).expect(422);
    });

    it('rejects an unknown category', async () => {
      const response = await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 100, category: 'CRYPTO_MOONSHOT' })
        .expect(422);

      expect(response.body.error.details[0].field).toBe('body.category');
    });

    it('rounds an over-precise amount to two decimals', async () => {
      const response = await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 33.333333, merchant: 'Chai Point' })
        .expect(201);

      expect(response.body.data.expense.amount).toBe(33.33);
    });

    it('flags a known subscription merchant', async () => {
      const response = await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 499, merchant: 'Netflix', note: 'Monthly plan' })
        .expect(201);

      expect(response.body.data.expense.category).toBe(CATEGORIES.SUBSCRIPTIONS);
      expect(response.body.data.expense.isSubscription).toBe(true);
    });
  });

  describe('Merchant memory', () => {
    it('reuses a category the user previously confirmed for that merchant', async () => {
      // "Anand Stores" matches no rule, so only memory can classify it.
      await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 300, merchant: 'Anand Stores', category: CATEGORIES.GROCERIES })
        .expect(201);

      const response = await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 450, merchant: 'Anand Stores' })
        .expect(201);

      expect(response.body.data.expense.category).toBe(CATEGORIES.GROCERIES);
      expect(response.body.data.expense.categorization.method).toBe('merchant-memory');
    });

    it('does not leak one user’s memory into another account', async () => {
      await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 300, merchant: 'Anand Stores', category: CATEGORIES.GROCERIES })
        .expect(201);

      const other = await registerUser({ email: 'other@paisa.app' });
      const response = await request(app)
        .post(api('/expenses'))
        .set(other.auth)
        .send({ amount: 450, merchant: 'Anand Stores' })
        .expect(201);

      expect(response.body.data.expense.category).toBe(CATEGORIES.OTHER);
    });
  });

  describe('GET /expenses', () => {
    beforeEach(async () => {
      await seedExpenses(ctx.user.id, [
        { amount: 500, category: CATEGORIES.FOOD, merchant: 'Swiggy', date: daysAgo(1) },
        { amount: 1200, category: CATEGORIES.GROCERIES, merchant: 'BigBasket', date: daysAgo(3) },
        { amount: 250, category: CATEGORIES.TRANSPORT, merchant: 'Uber', date: daysAgo(5) },
        { amount: 8000, category: CATEGORIES.SHOPPING, merchant: 'Amazon', date: daysAgo(40) },
        { amount: 85000, category: CATEGORIES.INCOME, merchant: 'Payroll', type: 'credit', date: daysAgo(2) },
      ]);
    });

    it('returns a page with pagination metadata', async () => {
      const response = await request(app).get(api('/expenses?limit=2')).set(ctx.auth).expect(200);

      expect(response.body.data.expenses).toHaveLength(2);
      expect(response.body.meta.pagination).toMatchObject({ total: 5, page: 1, limit: 2, totalPages: 3, hasNextPage: true });
    });

    it('summarises the whole filtered set, not just the page', async () => {
      const response = await request(app).get(api('/expenses?limit=1')).set(ctx.auth).expect(200);

      expect(response.body.data.expenses).toHaveLength(1);
      expect(response.body.data.summary.count).toBe(5);
      expect(response.body.data.summary.totalSpent).toBe(9950);
      expect(response.body.data.summary.totalReceived).toBe(85000);
    });

    it('filters by category', async () => {
      const response = await request(app).get(api('/expenses?category=FOOD,TRANSPORT')).set(ctx.auth).expect(200);

      expect(response.body.data.expenses).toHaveLength(2);
      expect(response.body.data.expenses.every((e) => ['FOOD', 'TRANSPORT'].includes(e.category))).toBe(true);
    });

    it('filters by an inclusive date range', async () => {
      const from = daysAgo(6).toISOString().slice(0, 10);
      const to = daysAgo(0).toISOString().slice(0, 10);
      const response = await request(app)
        .get(api(`/expenses?startDate=${from}&endDate=${to}`))
        .set(ctx.auth)
        .expect(200);

      // The 40-day-old shopping row is outside the window.
      expect(response.body.data.expenses).toHaveLength(4);
    });

    it('filters by amount range and type', async () => {
      const response = await request(app)
        .get(api('/expenses?type=debit&minAmount=400&maxAmount=2000'))
        .set(ctx.auth)
        .expect(200);

      expect(response.body.data.expenses.map((e) => e.amount).sort((a, b) => a - b)).toEqual([500, 1200]);
    });

    it('searches notes and merchants', async () => {
      const response = await request(app).get(api('/expenses?search=bigbasket')).set(ctx.auth).expect(200);
      expect(response.body.data.expenses).toHaveLength(1);
      expect(response.body.data.expenses[0].merchant).toBe('BigBasket');
    });

    it('sorts by amount', async () => {
      const response = await request(app).get(api('/expenses?sortBy=amount&sortOrder=desc')).set(ctx.auth).expect(200);
      const amounts = response.body.data.expenses.map((e) => e.amount);
      expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    });

    it('rejects an inverted date range', async () => {
      const response = await request(app)
        .get(api('/expenses?startDate=2026-08-20&endDate=2026-08-01'))
        .set(ctx.auth)
        .expect(422);

      expect(response.body.error.details[0].field).toBe('query.endDate');
    });

    it('never returns another user’s expenses', async () => {
      const other = await registerUser({ email: 'other@paisa.app' });
      const response = await request(app).get(api('/expenses')).set(other.auth).expect(200);
      expect(response.body.data.expenses).toHaveLength(0);
    });
  });

  describe('Update and delete', () => {
    let expenseId;

    beforeEach(async () => {
      const response = await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 500, merchant: 'Swiggy', note: 'Lunch' })
        .expect(201);
      expenseId = response.body.data.expense.id;
    });

    it('updates fields in place', async () => {
      const response = await request(app)
        .patch(api(`/expenses/${expenseId}`))
        .set(ctx.auth)
        .send({ amount: 650, note: 'Lunch for two' })
        .expect(200);

      expect(response.body.data.expense.amount).toBe(650);
      expect(response.body.data.expense.note).toBe('Lunch for two');
    });

    it('marks a manual category correction as confirmed', async () => {
      const response = await request(app)
        .patch(api(`/expenses/${expenseId}`))
        .set(ctx.auth)
        .send({ category: CATEGORIES.ENTERTAINMENT })
        .expect(200);

      expect(response.body.data.expense.category).toBe(CATEGORIES.ENTERTAINMENT);
      expect(response.body.data.expense.categoryConfirmed).toBe(true);
    });

    it('soft-deletes by default and hides the row from listings', async () => {
      const response = await request(app).delete(api(`/expenses/${expenseId}`)).set(ctx.auth).expect(200);
      expect(response.body.data.mode).toBe('soft');

      const list = await request(app).get(api('/expenses')).set(ctx.auth).expect(200);
      expect(list.body.data.expenses).toHaveLength(0);
    });

    it('restores a soft-deleted expense', async () => {
      await request(app).delete(api(`/expenses/${expenseId}`)).set(ctx.auth).expect(200);
      await request(app).post(api(`/expenses/${expenseId}/restore`)).set(ctx.auth).expect(200);

      const list = await request(app).get(api('/expenses')).set(ctx.auth).expect(200);
      expect(list.body.data.expenses).toHaveLength(1);
    });

    it('returns 404 for an expense belonging to someone else', async () => {
      const other = await registerUser({ email: 'other@paisa.app' });
      await request(app).get(api(`/expenses/${expenseId}`)).set(other.auth).expect(404);
      await request(app).patch(api(`/expenses/${expenseId}`)).set(other.auth).send({ amount: 1 }).expect(404);
      await request(app).delete(api(`/expenses/${expenseId}`)).set(other.auth).expect(404);
    });

    it('returns 400 for a malformed id', async () => {
      await request(app).get(api('/expenses/not-an-object-id')).set(ctx.auth).expect(422);
    });
  });

  describe('POST /expenses/categorize', () => {
    it('predicts without saving anything', async () => {
      const response = await request(app)
        .post(api('/expenses/categorize'))
        .set(ctx.auth)
        .send({ merchant: 'Netflix', note: 'Monthly plan', amount: 649 })
        .expect(200);

      expect(response.body.data.category).toBe(CATEGORIES.SUBSCRIPTIONS);
      expect(response.body.data.isSubscription).toBe(true);

      const list = await request(app).get(api('/expenses')).set(ctx.auth).expect(200);
      expect(list.body.data.expenses).toHaveLength(0);
    });
  });
});
