'use strict';

const { app, api, request, registerUser, seedExpenses } = require('./helpers');
const { CATEGORIES } = require('../src/constants/categories');
const { monthKey, monthRange, addMonths, fromZoned, zonedParts } = require('../src/utils/date');

const TZ = 'Asia/Kolkata';

describe('Analytics', () => {
  let ctx;
  let thisMonth;
  let lastMonth;

  /** A safe day inside a month: early enough never to be in the future. */
  const dayIn = (monthOffset, day, hour = 12) => {
    const anchor = addMonths(new Date(), monthOffset, TZ);
    const { year, month } = zonedParts(anchor, TZ);
    return fromZoned({ year, month, day, hour }, TZ);
  };

  beforeEach(async () => {
    ctx = await registerUser();
    thisMonth = monthKey(new Date(), TZ);
    lastMonth = monthKey(monthRange(thisMonth, TZ).start, TZ);
    lastMonth = monthKey(addMonths(new Date(), -1, TZ), TZ);

    await seedExpenses(ctx.user.id, [
      // Current month
      { amount: 3000, category: CATEGORIES.FOOD, merchant: 'Swiggy', date: dayIn(0, 1) },
      { amount: 2000, category: CATEGORIES.FOOD, merchant: 'Zomato', date: dayIn(0, 2) },
      { amount: 4000, category: CATEGORIES.GROCERIES, merchant: 'BigBasket', date: dayIn(0, 3) },
      { amount: 1000, category: CATEGORIES.TRANSPORT, merchant: 'Uber', date: dayIn(0, 3) },
      { amount: 10000, category: CATEGORIES.INVESTMENTS, merchant: 'Groww', date: dayIn(0, 4) },
      { amount: 80000, category: CATEGORIES.INCOME, merchant: 'Payroll', type: 'credit', date: dayIn(0, 1) },
      // Previous month — the comparison baseline
      { amount: 5000, category: CATEGORIES.FOOD, merchant: 'Swiggy', date: dayIn(-1, 10) },
      { amount: 3000, category: CATEGORIES.SHOPPING, merchant: 'Amazon', date: dayIn(-1, 12) },
    ]);
  });

  describe('GET /analytics/summary', () => {
    it('reports monthly totals, excluding investments from spend', async () => {
      const response = await request(app).get(api('/analytics/summary')).set(ctx.auth).expect(200);
      const data = response.body.data;

      expect(data.month).toBe(thisMonth);
      expect(data.totalSpent).toBe(10000);
      expect(data.totalIncome).toBe(80000);
      expect(data.totalInvested).toBe(10000);
      expect(data.netSavings).toBe(60000);
      // No cap set, so savings falls back to the accounting definition.
      expect(data.savingsBasis).toBe('income');
      expect(data.monthlyBudget).toBe(0);
    });

    describe('savings against a budget', () => {
      /** Sets this month's OVERALL cap through the API the app itself uses. */
      const setBudget = (amount) =>
        request(app).post(api('/budgets')).set(ctx.auth).send({ amount, category: 'OVERALL' }).expect(200);

      it('grows the pot with money that arrived, rather than the cap alone', async () => {
        await setBudget(50000);

        const { body } = await request(app).get(api('/analytics/summary')).set(ctx.auth).expect(200);

        // ₹50,000 cap plus the ₹80,000 that came in, less ₹10,000 of spend.
        // The ₹10,000 moved into investments is not spending, so it does not
        // reduce the figure.
        expect(body.data.monthlyBudget).toBe(50000);
        expect(body.data.spendableIncome).toBe(80000);
        expect(body.data.spendablePot).toBe(130000);
        expect(body.data.netSavings).toBe(120000);
        expect(body.data.savingsRate).toBe(92.3);
        expect(body.data.savingsBasis).toBe('budget');
      });

      it('does not count arriving money twice once it is spent', async () => {
        await setBudget(50000);

        const before = await request(app).get(api('/analytics/summary')).set(ctx.auth).expect(200);

        // Spend the whole ₹80,000 that arrived. The pot is unchanged, so
        // savings must fall by exactly that much — not stay flat because the
        // credit was banked as savings on arrival.
        await seedExpenses(ctx.user.id, [
          { amount: 80000, category: CATEGORIES.SHOPPING, merchant: 'Croma', date: dayIn(0, 5) },
        ]);

        const after = await request(app).get(api('/analytics/summary')).set(ctx.auth).expect(200);

        expect(after.body.data.spendablePot).toBe(before.body.data.spendablePot);
        expect(after.body.data.netSavings).toBe(before.body.data.netSavings - 80000);
        expect(after.body.data.netSavings).toBe(40000);
      });

      it('ignores self-transfers, which move money rather than add it', async () => {
        await setBudget(50000);

        await seedExpenses(ctx.user.id, [
          { amount: 25000, category: CATEGORIES.TRANSFER, merchant: 'Own account', type: 'credit', date: dayIn(0, 6) },
        ]);

        const { body } = await request(app).get(api('/analytics/summary')).set(ctx.auth).expect(200);

        // The credit lands in totalIncome, but only the ₹80,000 of real income
        // is allowed to raise what the user may spend.
        expect(body.data.totalIncome).toBe(105000);
        expect(body.data.spendableIncome).toBe(80000);
        expect(body.data.spendablePot).toBe(130000);
      });

      it('reports the whole budget as saved before anything is spent', async () => {
        const fresh = await registerUser({ email: 'nospend@paisa.app' });
        await request(app)
          .post(api('/budgets'))
          .set(fresh.auth)
          .send({ amount: 50000, category: 'OVERALL' })
          .expect(200);

        const { body } = await request(app).get(api('/analytics/summary')).set(fresh.auth).expect(200);

        expect(body.data.netSavings).toBe(50000);
        expect(body.data.savingsRate).toBe(100);
      });

      it('goes negative rather than flooring at zero when the pot is breached', async () => {
        // A fresh account, so nothing arrives to soften the overspend.
        const fresh = await registerUser({ email: 'overspent@paisa.app' });
        await seedExpenses(fresh.user.id, [
          { amount: 10000, category: CATEGORIES.FOOD, merchant: 'Swiggy', date: dayIn(0, 2) },
        ]);
        await request(app)
          .post(api('/budgets'))
          .set(fresh.auth)
          .send({ amount: 8000, category: 'OVERALL' })
          .expect(200);

        const { body } = await request(app).get(api('/analytics/summary')).set(fresh.auth).expect(200);

        // ₹10,000 spent against an ₹8,000 cap and no income.
        expect(body.data.netSavings).toBe(-2000);
        expect(body.data.savingsRate).toBe(-25);
        expect(body.data.savingsBasis).toBe('budget');
      });

      it('leaves the rate undefined for an account with no budget and no income', async () => {
        const fresh = await registerUser({ email: 'blank@paisa.app' });

        const { body } = await request(app).get(api('/analytics/summary')).set(fresh.auth).expect(200);

        expect(body.data.netSavings).toBe(0);
        expect(body.data.savingsRate).toBeNull();
        expect(body.data.savingsBasis).toBeNull();
      });
    });

    it('compares against the previous month', async () => {
      const response = await request(app).get(api('/analytics/summary')).set(ctx.auth).expect(200);
      const { comparison } = response.body.data;

      expect(comparison.previousMonth).toBe(lastMonth);
      expect(comparison.previousSpent).toBe(8000);
      expect(comparison.changeAmount).toBe(2000);
      expect(comparison.changePercent).toBe(25);
      expect(comparison.direction).toBe('up');
    });

    it('reads a specific month', async () => {
      const response = await request(app)
        .get(api(`/analytics/summary?month=${lastMonth}`))
        .set(ctx.auth)
        .expect(200);

      expect(response.body.data.totalSpent).toBe(8000);
    });

    it('rejects a malformed month', async () => {
      await request(app).get(api('/analytics/summary?month=2026-13')).set(ctx.auth).expect(422);
    });
  });

  describe('GET /analytics/categories', () => {
    it('breaks spend down by category with percentage shares', async () => {
      const response = await request(app).get(api('/analytics/categories')).set(ctx.auth).expect(200);
      const { categories, totalSpent } = response.body.data;

      expect(totalSpent).toBe(10000);
      const food = categories.find((c) => c.category === CATEGORIES.FOOD);
      expect(food.total).toBe(5000);
      expect(food.percentage).toBe(50);
      expect(food.count).toBe(2);
      expect(food.label).toBe('Food & Dining');
    });

    it('sorts categories by spend, descending', async () => {
      const response = await request(app).get(api('/analytics/categories')).set(ctx.auth).expect(200);
      const totals = response.body.data.categories.map((c) => c.total);
      expect(totals).toEqual([...totals].sort((a, b) => b - a));
    });

    it('excludes investments unless asked for them', async () => {
      const without = await request(app).get(api('/analytics/categories')).set(ctx.auth).expect(200);
      expect(without.body.data.categories.some((c) => c.category === CATEGORIES.INVESTMENTS)).toBe(false);

      const with_ = await request(app)
        .get(api('/analytics/categories?includeNonSpend=true'))
        .set(ctx.auth)
        .expect(200);
      expect(with_.body.data.categories.some((c) => c.category === CATEGORIES.INVESTMENTS)).toBe(true);
    });
  });

  describe('GET /analytics/trends', () => {
    it('returns a zero-filled daily series', async () => {
      const response = await request(app).get(api('/analytics/trends?granularity=day')).set(ctx.auth).expect(200);
      const { series, stats } = response.body.data;

      expect(series.length).toBeGreaterThanOrEqual(28);
      // Days without spending are present with a zero, so charts have no gaps.
      expect(series.some((p) => p.total === 0)).toBe(true);
      expect(stats.total).toBe(10000);
      expect(stats.peak.total).toBe(5000);
      expect(series[0]).toHaveProperty('isWeekend');
    });

    it('aggregates by month', async () => {
      const response = await request(app)
        .get(api(`/analytics/trends?granularity=month&startDate=${lastMonth}-01&endDate=${thisMonth}-28`))
        .set(ctx.auth)
        .expect(200);

      expect(response.body.data.series.length).toBeGreaterThanOrEqual(2);
    });

    it('rejects an unknown granularity', async () => {
      await request(app).get(api('/analytics/trends?granularity=hourly')).set(ctx.auth).expect(422);
    });
  });

  describe('GET /analytics/weekday', () => {
    it('returns all seven days with a weekend split', async () => {
      const response = await request(app).get(api('/analytics/weekday')).set(ctx.auth).expect(200);
      const { days, weekendVsWeekday } = response.body.data;

      expect(days).toHaveLength(7);
      expect(days.map((d) => d.day)).toContain('Sunday');
      expect(weekendVsWeekday.weekendTotal + weekendVsWeekday.weekdayTotal).toBe(10000);
      // Per-day averages, not raw totals — two weekend days versus five weekdays.
      expect(weekendVsWeekday).toHaveProperty('weekendDailyAverage');
    });
  });

  describe('GET /analytics/merchants', () => {
    it('ranks merchants by spend', async () => {
      const response = await request(app).get(api('/analytics/merchants?limit=3')).set(ctx.auth).expect(200);
      const { merchants } = response.body.data;

      expect(merchants.length).toBeLessThanOrEqual(3);
      expect(merchants[0].merchant).toBe('BigBasket');
      expect(merchants[0].total).toBe(4000);
    });
  });

  describe('GET /analytics/dashboard', () => {
    it('returns everything a home screen needs in one call', async () => {
      const response = await request(app).get(api('/analytics/dashboard')).set(ctx.auth).expect(200);
      const data = response.body.data;

      expect(data).toHaveProperty('summary');
      expect(data).toHaveProperty('categories');
      expect(data).toHaveProperty('dailyTrend');
      expect(data).toHaveProperty('topMerchants');
      expect(data.recentTransactions.length).toBeGreaterThan(0);
    });
  });

  it('scopes every analytic to the authenticated user', async () => {
    const other = await registerUser({ email: 'other@paisa.app' });
    const response = await request(app).get(api('/analytics/summary')).set(other.auth).expect(200);
    expect(response.body.data.totalSpent).toBe(0);
  });
});
