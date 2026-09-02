'use strict';

const { app, api, request, registerUser, seedExpenses } = require('./helpers');
const { CATEGORIES } = require('../src/constants/categories');
const { monthKey } = require('../src/utils/date');

describe('Budgets', () => {
  let ctx;
  let month;

  beforeEach(async () => {
    ctx = await registerUser();
    month = monthKey(new Date(), 'Asia/Kolkata');
  });

  /** A date inside the current month that is never in the future. */
  const inThisMonth = () => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 10, 0, 0));
  };

  describe('POST /budgets', () => {
    it('creates an overall monthly budget', async () => {
      const response = await request(app)
        .post(api('/budgets'))
        .set(ctx.auth)
        .send({ amount: 40000 })
        .expect(200);

      expect(response.body.data.budget).toMatchObject({
        category: 'OVERALL',
        budget: 40000,
        spent: 0,
        percentageUsed: 0,
        status: 'safe',
        alertThreshold: 80,
      });
    });

    it('updates an existing budget rather than duplicating it', async () => {
      await request(app).post(api('/budgets')).set(ctx.auth).send({ amount: 40000 }).expect(200);
      await request(app).post(api('/budgets')).set(ctx.auth).send({ amount: 50000 }).expect(200);

      const list = await request(app).get(api('/budgets')).set(ctx.auth).expect(200);
      expect(list.body.data.overall.budget).toBe(50000);
      expect(list.body.data.categories).toHaveLength(0);
    });

    it('rejects an out-of-range alert threshold', async () => {
      await request(app)
        .post(api('/budgets'))
        .set(ctx.auth)
        .send({ amount: 1000, alertThreshold: 1.5 })
        .expect(422);
    });
  });

  describe('Usage tracking', () => {
    it('computes the usage percentage against actual spend', async () => {
      await request(app).post(api('/budgets')).set(ctx.auth).send({ amount: 10000 }).expect(200);
      await seedExpenses(ctx.user.id, [
        { amount: 3000, category: CATEGORIES.FOOD, date: inThisMonth() },
        { amount: 1500, category: CATEGORIES.TRANSPORT, date: inThisMonth() },
      ]);

      const response = await request(app).get(api('/budgets')).set(ctx.auth).expect(200);
      expect(response.body.data.overall.spent).toBe(4500);
      expect(response.body.data.overall.percentageUsed).toBe(45);
      expect(response.body.data.overall.remaining).toBe(5500);
    });

    it('excludes transfers, investments and income from the overall cap', async () => {
      await request(app).post(api('/budgets')).set(ctx.auth).send({ amount: 10000 }).expect(200);
      await seedExpenses(ctx.user.id, [
        { amount: 2000, category: CATEGORIES.FOOD, date: inThisMonth() },
        { amount: 10000, category: CATEGORIES.INVESTMENTS, date: inThisMonth() },
        { amount: 5000, category: CATEGORIES.TRANSFER, date: inThisMonth() },
        { amount: 80000, category: CATEGORIES.INCOME, type: 'credit', date: inThisMonth() },
      ]);

      const response = await request(app).get(api('/budgets')).set(ctx.auth).expect(200);
      expect(response.body.data.overall.spent).toBe(2000);
    });

    it('tracks a category budget independently', async () => {
      await request(app)
        .post(api('/budgets'))
        .set(ctx.auth)
        .send({ amount: 5000, category: CATEGORIES.FOOD })
        .expect(200);

      await seedExpenses(ctx.user.id, [
        { amount: 2000, category: CATEGORIES.FOOD, date: inThisMonth() },
        { amount: 9000, category: CATEGORIES.SHOPPING, date: inThisMonth() },
      ]);

      const response = await request(app).get(api('/budgets')).set(ctx.auth).expect(200);
      const food = response.body.data.categories.find((c) => c.category === CATEGORIES.FOOD);
      expect(food.spent).toBe(2000);
      expect(food.percentageUsed).toBe(40);
    });
  });

  describe('Threshold warnings', () => {
    it('raises a warning on the expense that crosses 80%', async () => {
      await request(app).post(api('/budgets')).set(ctx.auth).send({ amount: 1000 }).expect(200);

      const below = await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 700, merchant: 'Swiggy' })
        .expect(201);
      expect(below.body.data.budgetAlerts).toHaveLength(0);

      const crossing = await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 150, merchant: 'Swiggy' })
        .expect(201);

      expect(crossing.body.data.budgetAlerts).toHaveLength(1);
      expect(crossing.body.data.budgetAlerts[0]).toMatchObject({ level: 'warning', category: 'OVERALL' });
      expect(crossing.body.data.budgetAlerts[0].percentage).toBe(85);
    });

    it('warns only once per level, not on every later expense', async () => {
      await request(app).post(api('/budgets')).set(ctx.auth).send({ amount: 1000 }).expect(200);

      const first = await request(app).post(api('/expenses')).set(ctx.auth).send({ amount: 850, merchant: 'Swiggy' });
      expect(first.body.data.budgetAlerts).toHaveLength(1);

      const second = await request(app).post(api('/expenses')).set(ctx.auth).send({ amount: 20, merchant: 'Swiggy' });
      expect(second.body.data.budgetAlerts).toHaveLength(0);
    });

    it('escalates from warning to exceeded', async () => {
      await request(app).post(api('/budgets')).set(ctx.auth).send({ amount: 1000 }).expect(200);
      await request(app).post(api('/expenses')).set(ctx.auth).send({ amount: 850, merchant: 'Swiggy' });

      const exceeding = await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 300, merchant: 'Swiggy' })
        .expect(201);

      expect(exceeding.body.data.budgetAlerts[0].level).toBe('exceeded');
      expect(exceeding.body.data.budgetAlerts[0].message).toContain('exceeded');
    });

    it('honours a custom alert threshold', async () => {
      await request(app)
        .post(api('/budgets'))
        .set(ctx.auth)
        .send({ amount: 1000, alertThreshold: 0.5 })
        .expect(200);

      const response = await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 550, merchant: 'Swiggy' })
        .expect(201);

      expect(response.body.data.budgetAlerts[0].level).toBe('warning');
    });

    it('raises both the category and the overall alert when both are crossed', async () => {
      await request(app).post(api('/budgets')).set(ctx.auth).send({ amount: 1000 }).expect(200);
      await request(app)
        .post(api('/budgets'))
        .set(ctx.auth)
        .send({ amount: 900, category: CATEGORIES.FOOD })
        .expect(200);

      const response = await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 880, merchant: 'Swiggy' })
        .expect(201);

      const levels = response.body.data.budgetAlerts.map((a) => a.category).sort();
      expect(levels).toEqual(['FOOD', 'OVERALL']);
    });

    it('does not alert when alerts are disabled', async () => {
      await request(app)
        .post(api('/budgets'))
        .set(ctx.auth)
        .send({ amount: 1000, alertsEnabled: false })
        .expect(200);

      const response = await request(app)
        .post(api('/expenses'))
        .set(ctx.auth)
        .send({ amount: 950, merchant: 'Swiggy' })
        .expect(201);

      expect(response.body.data.budgetAlerts).toHaveLength(0);
    });
  });

  describe('Pace projection', () => {
    it('reports burn rate and projected month-end spend', async () => {
      await request(app).post(api('/budgets')).set(ctx.auth).send({ amount: 30000 }).expect(200);
      await seedExpenses(ctx.user.id, [{ amount: 6000, category: CATEGORIES.FOOD, date: inThisMonth() }]);

      const response = await request(app).get(api('/budgets')).set(ctx.auth).expect(200);
      const { pace } = response.body.data.overall;

      expect(pace.dailyBurnRate).toBeGreaterThan(0);
      expect(pace.projectedSpend).toBeGreaterThan(0);
      expect(pace.totalDays).toBeGreaterThanOrEqual(28);
      expect(typeof pace.onTrack).toBe('boolean');
    });
  });

  describe('Lifecycle', () => {
    it('deletes a budget', async () => {
      const created = await request(app).post(api('/budgets')).set(ctx.auth).send({ amount: 5000 }).expect(200);
      await request(app).delete(api(`/budgets/${created.body.data.budget.id}`)).set(ctx.auth).expect(200);

      const list = await request(app).get(api('/budgets')).set(ctx.auth).expect(200);
      expect(list.body.data.overall).toBeNull();
    });

    it('carries auto-renewing budgets into the next month', async () => {
      await request(app).post(api('/budgets')).set(ctx.auth).send({ amount: 40000, month }).expect(200);
      await request(app)
        .post(api('/budgets'))
        .set(ctx.auth)
        .send({ amount: 8000, category: CATEGORIES.FOOD, month })
        .expect(200);

      const response = await request(app).post(api('/budgets/rollover')).set(ctx.auth).send({}).expect(200);
      expect(response.body.data.created).toBe(2);

      const next = await request(app).get(api(`/budgets?month=${response.body.data.to}`)).set(ctx.auth).expect(200);
      expect(next.body.data.overall.budget).toBe(40000);
    });

    it('returns 404 for another user’s budget', async () => {
      const created = await request(app).post(api('/budgets')).set(ctx.auth).send({ amount: 5000 }).expect(200);
      const other = await registerUser({ email: 'other@paisa.app' });
      await request(app).get(api(`/budgets/${created.body.data.budget.id}`)).set(other.auth).expect(404);
    });
  });
});
