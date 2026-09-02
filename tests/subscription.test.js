'use strict';

const { app, api, request, registerUser, seedExpenses, monthsAgo } = require('./helpers');
const { CATEGORIES } = require('../src/constants/categories');
const { classifyCadence, monthlyEquivalent } = require('../src/services/subscription.service');

describe('Subscription detection', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await registerUser();
  });

  /** N monthly charges for one merchant, most recent last. */
  const monthlySeries = (merchant, amount, count, { category = CATEGORIES.SUBSCRIPTIONS, day = 15 } = {}) =>
    Array.from({ length: count }, (_, i) => ({
      amount: typeof amount === 'function' ? amount(i) : amount,
      category,
      merchant,
      date: monthsAgo(count - 1 - i, day),
    }));

  describe('cadence classification (unit)', () => {
    it.each([
      [7, 'weekly'],
      [30, 'monthly'],
      [31, 'monthly'],
      [91, 'quarterly'],
      [365, 'yearly'],
      [17, 'irregular'],
    ])('maps a %i day gap to %s', (days, expected) => {
      expect(classifyCadence(days)).toBe(expected);
    });

    it('normalises every cadence to a monthly cost', () => {
      expect(monthlyEquivalent(499, 'monthly', 30)).toBe(499);
      expect(monthlyEquivalent(1200, 'yearly', 365)).toBe(100);
      expect(monthlyEquivalent(300, 'quarterly', 91)).toBe(100);
    });
  });

  describe('POST /subscriptions/detect', () => {
    it('detects a fixed monthly charge', async () => {
      await seedExpenses(ctx.user.id, monthlySeries('Netflix', 499, 5));

      const response = await request(app).post(api('/subscriptions/detect')).set(ctx.auth).send({}).expect(200);
      const netflix = response.body.data.detected.find((d) => d.merchant === 'Netflix');

      expect(netflix).toBeDefined();
      expect(netflix.cadence).toBe('monthly');
      expect(netflix.amount).toBe(499);
      expect(netflix.occurrences).toBe(5);
      expect(netflix.confidence).toBeGreaterThan(0.7);
      expect(netflix.metrics.merchantRecognised).toBe(true);
    });

    it('tolerates a small price change without losing the pattern', async () => {
      // 499 → 519: a price rise, still the same subscription.
      await seedExpenses(ctx.user.id, monthlySeries('Spotify', (i) => (i < 3 ? 499 : 519), 5));

      const response = await request(app).post(api('/subscriptions/detect')).set(ctx.auth).send({}).expect(200);
      const spotify = response.body.data.detected.find((d) => d.merchant === 'Spotify');

      expect(spotify).toBeDefined();
      expect(spotify.cadence).toBe('monthly');
    });

    it('ignores an irregular merchant with wandering amounts', async () => {
      // A cafe visited at random intervals for random amounts is not a subscription.
      await seedExpenses(ctx.user.id, [
        { amount: 180, category: CATEGORIES.FOOD, merchant: 'Corner Cafe', date: monthsAgo(3, 2) },
        { amount: 640, category: CATEGORIES.FOOD, merchant: 'Corner Cafe', date: monthsAgo(2, 19) },
        { amount: 310, category: CATEGORIES.FOOD, merchant: 'Corner Cafe', date: monthsAgo(2, 27) },
        { amount: 950, category: CATEGORIES.FOOD, merchant: 'Corner Cafe', date: monthsAgo(0, 8) },
      ]);

      const response = await request(app).post(api('/subscriptions/detect')).set(ctx.auth).send({}).expect(200);
      expect(response.body.data.detected.find((d) => d.merchant === 'Corner Cafe')).toBeUndefined();
    });

    it('needs more than a couple of charges before committing', async () => {
      await seedExpenses(ctx.user.id, monthlySeries('Netflix', 499, 2));

      const response = await request(app).post(api('/subscriptions/detect')).set(ctx.auth).send({}).expect(200);
      expect(response.body.data.detected).toHaveLength(0);
    });

    it('tags the underlying expenses as subscriptions', async () => {
      await seedExpenses(ctx.user.id, monthlySeries('Netflix', 499, 4));
      await request(app).post(api('/subscriptions/detect')).set(ctx.auth).send({}).expect(200);

      const list = await request(app).get(api('/expenses?isSubscription=true')).set(ctx.auth).expect(200);
      expect(list.body.data.expenses).toHaveLength(4);
    });

    it('projects the next expected charge', async () => {
      await seedExpenses(ctx.user.id, monthlySeries('Netflix', 499, 4));
      const response = await request(app).post(api('/subscriptions/detect')).set(ctx.auth).send({}).expect(200);

      const netflix = response.body.data.detected.find((d) => d.merchant === 'Netflix');
      expect(new Date(netflix.nextExpectedAt).getTime()).toBeGreaterThan(new Date(netflix.lastChargedAt).getTime());
    });

    it('estimates monthly and yearly cost across all subscriptions', async () => {
      await seedExpenses(ctx.user.id, [
        ...monthlySeries('Netflix', 499, 4),
        ...monthlySeries('Spotify', 119, 4, { day: 5 }),
      ]);

      const response = await request(app).post(api('/subscriptions/detect')).set(ctx.auth).send({}).expect(200);
      expect(response.body.data.summary.estimatedMonthlyCost).toBe(618);
      expect(response.body.data.summary.estimatedYearlyCost).toBe(7416);
    });

    it('runs as a dry run when persist is false', async () => {
      await seedExpenses(ctx.user.id, monthlySeries('Netflix', 499, 4));

      const response = await request(app)
        .post(api('/subscriptions/detect'))
        .set(ctx.auth)
        .send({ persist: false })
        .expect(200);

      expect(response.body.data.detected.length).toBeGreaterThan(0);

      const list = await request(app).get(api('/subscriptions')).set(ctx.auth).expect(200);
      expect(list.body.data.items).toHaveLength(0);
    });
  });

  describe('Review and listing', () => {
    beforeEach(async () => {
      await seedExpenses(ctx.user.id, monthlySeries('Netflix', 499, 4));
      await request(app).post(api('/subscriptions/detect')).set(ctx.auth).send({}).expect(200);
    });

    it('lists detected subscriptions with cost estimates', async () => {
      const response = await request(app).get(api('/subscriptions')).set(ctx.auth).expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.items[0].merchant).toBe('Netflix');
      expect(response.body.data.summary.estimatedMonthlyCost).toBe(499);
      expect(response.body.data.summary.estimatedYearlyCost).toBe(5988);
    });

    it('hides a dismissed subscription and untags its expenses', async () => {
      const list = await request(app).get(api('/subscriptions')).set(ctx.auth).expect(200);
      const id = list.body.data.items[0].id;

      await request(app).patch(api(`/subscriptions/${id}/review`)).set(ctx.auth).send({ verdict: 'dismissed' }).expect(200);

      const after = await request(app).get(api('/subscriptions')).set(ctx.auth).expect(200);
      expect(after.body.data.items).toHaveLength(0);

      const expenses = await request(app).get(api('/expenses?isSubscription=true')).set(ctx.auth).expect(200);
      expect(expenses.body.data.expenses).toHaveLength(0);
    });

    it('does not resurrect a dismissed subscription on the next detection run', async () => {
      const list = await request(app).get(api('/subscriptions')).set(ctx.auth).expect(200);
      const id = list.body.data.items[0].id;

      await request(app).patch(api(`/subscriptions/${id}/review`)).set(ctx.auth).send({ verdict: 'dismissed' }).expect(200);
      await request(app).post(api('/subscriptions/detect')).set(ctx.auth).send({}).expect(200);

      const after = await request(app).get(api('/subscriptions')).set(ctx.auth).expect(200);
      expect(after.body.data.items).toHaveLength(0);
    });

    it('lists upcoming charges', async () => {
      const response = await request(app).get(api('/subscriptions/upcoming?days=60')).set(ctx.auth).expect(200);
      expect(response.body.data.items.length).toBeGreaterThan(0);
      expect(response.body.data.items[0]).toHaveProperty('daysAway');
    });

    it('returns 404 when reviewing another user’s subscription', async () => {
      const list = await request(app).get(api('/subscriptions')).set(ctx.auth).expect(200);
      const other = await registerUser({ email: 'other@paisa.app' });

      await request(app)
        .patch(api(`/subscriptions/${list.body.data.items[0].id}/review`))
        .set(other.auth)
        .send({ verdict: 'confirmed' })
        .expect(404);
    });
  });
});
