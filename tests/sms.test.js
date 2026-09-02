'use strict';

const { app, api, request, registerUser } = require('./helpers');
const { parseSms } = require('../src/services/sms.service');
const { SAMPLE_SMS } = require('../src/seed/sampleData');
const { CATEGORIES } = require('../src/constants/categories');

describe('SMS parsing', () => {
  describe('parser (unit)', () => {
    it.each(SAMPLE_SMS)('parses the $sender sample correctly', (sample) => {
      const parsed = parseSms(sample.message, { sender: sample.sender });

      expect(parsed.isTransaction).toBe(sample.expect.isTransaction);
      if (!sample.expect.isTransaction) return;

      expect(parsed.amount).toBe(sample.expect.amount);
      expect(parsed.type).toBe(sample.expect.type);
      if (sample.expect.merchant) expect(parsed.merchant).toContain(sample.expect.merchant);
      if (sample.expect.accountLast4) expect(parsed.accountLast4).toBe(sample.expect.accountLast4);
      if (sample.expect.paymentMethod) expect(parsed.paymentMethod).toBe(sample.expect.paymentMethod);
    });

    it('reads an amount with thousands separators', () => {
      const parsed = parseSms('Rs.1,24,500.75 debited from A/c XX1234 to BUILDER on 12-08-26');
      expect(parsed.amount).toBe(124500.75);
    });

    it('picks the direction from the earliest keyword, not the last', () => {
      const parsed = parseSms('Rs.5,000 debited from A/c XX1234 towards CREDIT CARD payment on 10-08-26');
      expect(parsed.type).toBe('debit');
    });

    it('extracts the transaction date from the body', () => {
      const parsed = parseSms('Rs.499 debited from A/c XX4521 on 28-08-26 to NETFLIX');
      expect(parsed.date.toISOString().slice(0, 10)).toBe('2026-08-28');
    });

    it('ignores an OTP message', () => {
      const parsed = parseSms('729103 is your OTP for a transaction of Rs.4,999. Do not share this OTP.');
      expect(parsed.isTransaction).toBe(false);
    });

    it('ignores a promotional message that mentions money', () => {
      const parsed = parseSms('Flat 50% OFF! Get cashback up to Rs.150 on your next order.');
      expect(parsed.isTransaction).toBe(false);
    });

    it('reports why it gave up when there is no amount', () => {
      const parsed = parseSms('Your account statement for August is now available.');
      expect(parsed.isTransaction).toBe(false);
      expect(parsed.reason).toMatch(/amount/i);
    });

    it('produces a stable fingerprint regardless of whitespace', () => {
      const a = parseSms('Rs.499 debited from A/c XX4521 to NETFLIX on 28-08-26');
      const b = parseSms('Rs.499   debited from A/c XX4521 to   NETFLIX on 28-08-26  ');
      expect(a.fingerprint).toBe(b.fingerprint);
    });

    it('raises confidence when more fields corroborate', () => {
      const rich = parseSms('Rs.499.00 debited from A/c XX4521 on 28-08-26 to NETFLIX via UPI. Ref 429183746512.', {
        sender: 'VM-HDFCBK',
      });
      const sparse = parseSms('Rs.499 spent');
      expect(rich.confidence).toBeGreaterThan(sparse.confidence);
    });
  });

  describe('POST /sms/parse', () => {
    let ctx;

    beforeEach(async () => {
      ctx = await registerUser();
    });

    it('converts a debit alert into a categorised expense', async () => {
      const response = await request(app)
        .post(api('/sms/parse'))
        .set(ctx.auth)
        .send({
          message: 'Rs.499.00 debited from A/c XX4521 on 28-08-26 to NETFLIX via UPI. Ref 429183746512. -HDFC Bank',
          sender: 'VM-HDFCBK',
        })
        .expect(201);

      expect(response.body.data.status).toBe('created');
      expect(response.body.data.expense.amount).toBe(499);
      expect(response.body.data.expense.type).toBe('debit');
      expect(response.body.data.expense.category).toBe(CATEGORIES.SUBSCRIPTIONS);
      expect(response.body.data.expense.source).toBe('sms');
      expect(response.body.data.expense.sms.accountLast4).toBe('4521');
    });

    it('records a credit as income', async () => {
      const response = await request(app)
        .post(api('/sms/parse'))
        .set(ctx.auth)
        .send({ message: 'INR 85,000.00 credited to A/c XX4521 on 01-08-26 towards SALARY AUG. Ref 8812340091.' })
        .expect(201);

      expect(response.body.data.expense.type).toBe('credit');
      expect(response.body.data.expense.category).toBe(CATEGORIES.INCOME);
    });

    it('skips a promotional message with 200 and status ignored', async () => {
      const response = await request(app)
        .post(api('/sms/parse'))
        .set(ctx.auth)
        .send({ message: 'Flat 50% OFF on your next order! Use coupon SAVE50 for cashback up to Rs.150.' })
        .expect(200);

      expect(response.body.data.status).toBe('ignored');
      expect(response.body.data.expense).toBeNull();
    });

    it('does not create a second expense for a replayed message', async () => {
      const message = 'Rs.320 debited from A/c XX1188 on 21-08-26 trf to UBER Ref 774411220033.';

      await request(app).post(api('/sms/parse')).set(ctx.auth).send({ message }).expect(201);
      const replay = await request(app).post(api('/sms/parse')).set(ctx.auth).send({ message }).expect(200);

      expect(replay.body.data.status).toBe('duplicate');

      const list = await request(app).get(api('/expenses')).set(ctx.auth).expect(200);
      expect(list.body.data.expenses).toHaveLength(1);
    });

    it('previews without saving when save=false', async () => {
      const response = await request(app)
        .post(api('/sms/parse'))
        .set(ctx.auth)
        .send({ message: 'Rs.1,240.50 spent on Credit Card XX8890 at SWIGGY on 24-08-26.', save: false })
        .expect(200);

      expect(response.body.data.status).toBe('parsed');

      const list = await request(app).get(api('/expenses')).set(ctx.auth).expect(200);
      expect(list.body.data.expenses).toHaveLength(0);
    });

    it('lets the same message be recorded by two different users', async () => {
      const message = 'Rs.499.00 debited from A/c XX4521 on 28-08-26 to NETFLIX via UPI.';
      const other = await registerUser({ email: 'other@paisa.app' });

      await request(app).post(api('/sms/parse')).set(ctx.auth).send({ message }).expect(201);
      await request(app).post(api('/sms/parse')).set(other.auth).send({ message }).expect(201);
    });

    it('rejects a message that is too short to be a bank alert', async () => {
      await request(app).post(api('/sms/parse')).set(ctx.auth).send({ message: 'hi' }).expect(422);
    });
  });

  describe('POST /sms/parse-batch', () => {
    it('reports a per-message outcome', async () => {
      const ctx = await registerUser();
      const response = await request(app)
        .post(api('/sms/parse-batch'))
        .set(ctx.auth)
        .send({ messages: SAMPLE_SMS.map(({ message, sender }) => ({ message, sender })) })
        .expect(200);

      const expectedCreated = SAMPLE_SMS.filter((s) => s.expect.isTransaction).length;
      const expectedIgnored = SAMPLE_SMS.length - expectedCreated;

      expect(response.body.data.summary.created).toBe(expectedCreated);
      expect(response.body.data.summary.ignored).toBe(expectedIgnored);
      expect(response.body.data.results).toHaveLength(SAMPLE_SMS.length);
    });
  });
});
