'use strict';

const { app, api, request, registerUser, seedExpenses } = require('./helpers');
const { CATEGORIES } = require('../src/constants/categories');
const { addMonths, fromZoned, zonedParts, daysInMonth } = require('../src/utils/date');

const TZ = 'Asia/Kolkata';

describe('AI insights', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await registerUser();
  });

  const dayIn = (monthOffset, day, hour = 12) => {
    const anchor = addMonths(new Date(), monthOffset, TZ);
    const { year, month } = zonedParts(anchor, TZ);
    return fromZoned({ year, month, day, hour }, TZ);
  };

  /** Every date of the given weekday inside a month, up to today. */
  const daysOfWeekIn = (monthOffset, weekday) => {
    const anchor = addMonths(new Date(), monthOffset, TZ);
    const { year, month } = zonedParts(anchor, TZ);
    const total = daysInMonth(anchor, TZ);
    const now = new Date();
    const dates = [];
    for (let day = 1; day <= total; day += 1) {
      const date = fromZoned({ year, month, day, hour: 13 }, TZ);
      if (date > now) break;
      if (zonedParts(date, TZ).weekday === weekday) dates.push(date);
    }
    return dates;
  };

  const findInsight = (body, type) => body.data.insights.find((i) => i.type === type);

  it('tells a new account it needs more data', async () => {
    const response = await request(app).get(api('/insights')).set(ctx.auth).expect(200);
    expect(findInsight(response.body, 'onboarding')).toBeDefined();
  });

  it('reports a month-over-month spending increase with the real numbers', async () => {
    const previous = Array.from({ length: 8 }, (_, i) => ({
      amount: 1250,
      category: CATEGORIES.FOOD,
      merchant: 'Swiggy',
      date: dayIn(-1, i + 1),
    }));
    const current = Array.from({ length: 8 }, (_, i) => ({
      amount: 1500,
      category: CATEGORIES.FOOD,
      merchant: 'Swiggy',
      date: dayIn(0, i + 1),
    }));
    await seedExpenses(ctx.user.id, [...previous, ...current]);

    const response = await request(app).get(api('/insights')).set(ctx.auth).expect(200);
    const trend = findInsight(response.body, 'spending_trend');

    expect(trend).toBeDefined();
    // 10,000 vs 12,000 is a 20% rise.
    expect(trend.metrics.changePercent).toBe(20);
    expect(trend.message).toContain('20%');
    expect(trend.severity).toBe('warning');
  });

  it('detects a weekend food habit', async () => {
    const rows = [];
    // Small weekday lunches, large weekend dinners, over two months.
    for (const offset of [-1, 0]) {
      for (const weekday of [1, 2, 3, 4, 5]) {
        for (const date of daysOfWeekIn(offset, weekday)) {
          rows.push({ amount: 250, category: CATEGORIES.FOOD, merchant: 'Swiggy', date });
        }
      }
      for (const weekday of [0, 6]) {
        for (const date of daysOfWeekIn(offset, weekday)) {
          rows.push({ amount: 1400, category: CATEGORIES.FOOD, merchant: 'Zomato', date });
        }
      }
    }
    await seedExpenses(ctx.user.id, rows);

    const response = await request(app).get(api('/insights')).set(ctx.auth).expect(200);
    const weekend = findInsight(response.body, 'weekend_pattern');

    expect(weekend).toBeDefined();
    expect(weekend.metrics.category).toBe(CATEGORIES.FOOD);
    expect(weekend.metrics.weekendPerDay).toBeGreaterThan(weekend.metrics.weekdayPerDay);
    expect(weekend.message.toLowerCase()).toContain('weekend');
  });

  it('flags a category spike against the user’s own baseline', async () => {
    const rows = [];
    // A steady ~2,000/month of shopping for three months...
    for (const offset of [-3, -2, -1]) {
      rows.push({ amount: 1000, category: CATEGORIES.SHOPPING, merchant: 'Amazon', date: dayIn(offset, 5) });
      rows.push({ amount: 1000, category: CATEGORIES.SHOPPING, merchant: 'Myntra', date: dayIn(offset, 15) });
    }
    // ...then a big month.
    rows.push({ amount: 9000, category: CATEGORIES.SHOPPING, merchant: 'Amazon', date: dayIn(0, 3) });
    for (let i = 0; i < 5; i += 1) {
      rows.push({ amount: 300, category: CATEGORIES.FOOD, merchant: 'Swiggy', date: dayIn(0, i + 1) });
    }
    await seedExpenses(ctx.user.id, rows);

    const response = await request(app).get(api('/insights')).set(ctx.auth).expect(200);
    const spike = findInsight(response.body, 'category_spike');

    expect(spike).toBeDefined();
    expect(spike.metrics.category).toBe(CATEGORIES.SHOPPING);
    expect(spike.metrics.changePercent).toBeGreaterThan(40);
  });

  it('warns about budget pace and ranks it first', async () => {
    await request(app).post(api('/budgets')).set(ctx.auth).send({ amount: 10000 }).expect(200);
    await seedExpenses(ctx.user.id, [
      { amount: 9000, category: CATEGORIES.FOOD, merchant: 'Swiggy', date: dayIn(0, 1) },
      ...Array.from({ length: 5 }, (_, i) => ({
        amount: 100,
        category: CATEGORIES.FOOD,
        merchant: 'Swiggy',
        date: dayIn(0, i + 1),
      })),
    ]);

    const response = await request(app).get(api('/insights')).set(ctx.auth).expect(200);
    const budget = findInsight(response.body, 'budget_pace');

    expect(budget).toBeDefined();
    expect(budget.severity).toMatch(/warning|critical/);
    // Budget problems are the most actionable finding, so they lead the report.
    expect(response.body.data.insights[0].type).toBe('budget_pace');
  });

  it('surfaces the subscription burden', async () => {
    const rows = [];
    for (let i = 0; i < 5; i += 1) {
      rows.push({ amount: 499, category: CATEGORIES.SUBSCRIPTIONS, merchant: 'Netflix', date: dayIn(-4 + i, 15) });
      rows.push({ amount: 119, category: CATEGORIES.SUBSCRIPTIONS, merchant: 'Spotify', date: dayIn(-4 + i, 5) });
    }
    await seedExpenses(ctx.user.id, rows);
    await request(app).post(api('/subscriptions/detect')).set(ctx.auth).send({}).expect(200);

    const response = await request(app).get(api('/insights')).set(ctx.auth).expect(200);
    const burden = findInsight(response.body, 'subscription_burden');

    expect(burden).toBeDefined();
    expect(burden.metrics.count).toBe(2);
    expect(burden.metrics.monthlyCost).toBe(618);
  });

  it('reports the savings rate when income is known', async () => {
    await seedExpenses(ctx.user.id, [
      { amount: 80000, category: CATEGORIES.INCOME, merchant: 'Payroll', type: 'credit', date: dayIn(0, 1) },
      ...Array.from({ length: 6 }, (_, i) => ({
        amount: 2000,
        category: CATEGORIES.FOOD,
        merchant: 'Swiggy',
        date: dayIn(0, i + 1),
      })),
    ]);

    const response = await request(app).get(api('/insights')).set(ctx.auth).expect(200);
    const savings = findInsight(response.body, 'savings_rate');

    expect(savings).toBeDefined();
    expect(savings.metrics.savingsRate).toBe(85);
    expect(savings.severity).toBe('positive');
  });

  it('spots many small purchases adding up', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      amount: 120,
      category: CATEGORIES.FOOD,
      merchant: 'Chai Point',
      date: dayIn(0, (i % 20) + 1),
    }));
    await seedExpenses(ctx.user.id, rows);

    const response = await request(app).get(api('/insights')).set(ctx.auth).expect(200);
    const leak = findInsight(response.body, 'small_spend_leak');

    expect(leak).toBeDefined();
    expect(leak.metrics.count).toBe(20);
    expect(leak.metrics.total).toBe(2400);
  });

  it('every insight carries the metrics behind its claim', async () => {
    await seedExpenses(
      ctx.user.id,
      Array.from({ length: 12 }, (_, i) => ({
        amount: 500 + i * 25,
        category: CATEGORIES.FOOD,
        merchant: 'Swiggy',
        date: dayIn(0, i + 1),
      }))
    );

    const response = await request(app).get(api('/insights')).set(ctx.auth).expect(200);

    expect(response.body.data.insights.length).toBeGreaterThan(0);
    for (const item of response.body.data.insights) {
      expect(item).toMatchObject({
        id: expect.any(String),
        type: expect.any(String),
        severity: expect.stringMatching(/positive|info|warning|critical/),
        title: expect.any(String),
        message: expect.any(String),
        metrics: expect.any(Object),
        confidence: expect.any(Number),
      });
      expect(item.confidence).toBeGreaterThan(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('honours the type filter and limit', async () => {
    await seedExpenses(
      ctx.user.id,
      Array.from({ length: 10 }, (_, i) => ({
        amount: 800,
        category: CATEGORIES.FOOD,
        merchant: 'Swiggy',
        date: dayIn(0, i + 1),
      }))
    );

    const filtered = await request(app)
      .get(api('/insights?types=category_concentration'))
      .set(ctx.auth)
      .expect(200);

    expect(filtered.body.data.insights.every((i) => i.type === 'category_concentration')).toBe(true);

    const limited = await request(app).get(api('/insights?limit=1')).set(ctx.auth).expect(200);
    expect(limited.body.data.insights).toHaveLength(1);
  });

  it('returns a one-line digest', async () => {
    await seedExpenses(
      ctx.user.id,
      Array.from({ length: 8 }, (_, i) => ({
        amount: 700,
        category: CATEGORIES.FOOD,
        merchant: 'Swiggy',
        date: dayIn(0, i + 1),
      }))
    );

    const response = await request(app).get(api('/insights/summary')).set(ctx.auth).expect(200);
    expect(response.body.data.headline).toEqual(expect.any(String));
    expect(response.body.data.headline.length).toBeGreaterThan(10);
  });

  it('lists the available insight types', async () => {
    const response = await request(app).get(api('/insights/types')).set(ctx.auth).expect(200);
    expect(response.body.data.types).toContain('weekend_pattern');
  });
});
