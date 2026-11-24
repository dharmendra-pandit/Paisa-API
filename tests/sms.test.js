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

    it.each([
      ['Rs.1500.00 debited from A/c XX1234 to SWIGGY on 23-11-26', 1500],
      ['INR 85000 credited to A/c XX1234 on 01-11-26', 85000],
      ['A/C X7712 debited by 12500.0 on date 23Nov25 trf to AMAZON', 12500],
      ['Sent Rs.250000.00 From HDFC Bank A/C *1234 To LANDLORD On 23/11/26', 250000],
      ['3200 Rs debited from your a/c XX1234 for EMI on 23-11-26', 3200],
      ['Rs.1,500 debited from A/c XX1234 to SWIGGY', 1500],
      ['Rs.499 debited to NETFLIX', 499],
    ])('reads every digit of an amount: %s', (message, amount) => {
      // Amounts over 999 written without commas used to lose their last
      // digits: "Rs.1500" was recorded as 150.
      expect(parseSms(message).amount).toBe(amount);
    });

    it.each([
      ['Sent Rs.250.00 from Kotak Bank AC X1234 to swiggy@icici on 23-11-26.UPI Ref 512345678901.', 'swiggy'],
      ['ICICI Bank Acct XX123 debited for Rs 250.00 on 23-Nov-26; SWIGGY credited. UPI:512345678901.', 'SWIGGY'],
      ['INR 250.00 debited A/c no. XX1234 23-11-26, 10:00:00 UPI/P2M/512345678901/SWIGGY Not you? SMS BLOCKUPI to 919951860002', 'SWIGGY'],
      ['Rs.5000.00 credited to your A/c XX1234 on 23-11-26 from RAHUL SHARMA via UPI. Ref 512345678901', 'RAHUL SHARMA'],
      ['Received Rs.1200 in your Kotak Bank AC X1234 from rahul@okaxis on 23-11-26.UPI Ref:512345678901', 'rahul'],
      ['Spent Rs.1250 On HDFC Bank Card 1234 At AMAZON On 2026-11-23:10:00:00 Bal Rs.10000', 'AMAZON'],
    ])('reads the other party: %s', (message, merchant) => {
      expect(parseSms(message).merchant).toBe(merchant);
    });

    it('never names a transaction after the user\'s own account', () => {
      const parsed = parseSms('Rs.5000.00 credited to your A/c XX1234 on 23-11-26. Avl Bal Rs.12000');
      expect(parsed.merchant).toBeNull();
    });

    it('reads an SBI UPI alert that has no currency marker', () => {
      const parsed = parseSms(
        'Dear UPI user A/C X7712 debited by 250.0 on date 23Nov25 trf to SWIGGY Refno 512345678901. If not u? call 1800111109. -SBI',
        { sender: 'JD-SBIUPI-S' }
      );
      expect(parsed.isTransaction).toBe(true);
      expect(parsed.amount).toBe(250);
      expect(parsed.type).toBe('debit');
      expect(parsed.merchant).toContain('SWIGGY');
    });

    it('takes the debited amount, not a balance mentioned first in the text', () => {
      const parsed = parseSms('Avl Bal Rs 5,000.00. A/c XX1234 debited for Rs 250.00 on 23-11-26 to ZOMATO.');
      expect(parsed.amount).toBe(250);
    });

    it('keeps a real debit alert that ends with an OTP safety footer', () => {
      const parsed = parseSms(
        'Rs.1,499.00 debited from A/c XX4521 on 23-11-26 to AMAZON via UPI. Never share your OTP or PIN with anyone. -HDFC Bank'
      );
      expect(parsed.isTransaction).toBe(true);
      expect(parsed.amount).toBe(1499);
    });

    it('reads the bank from a sender carrying a traffic-class suffix', () => {
      const message = 'Rs.499.00 debited from A/c XX4521 on 28-08-26 to NETFLIX via UPI. Ref 429183746512.';
      expect(parseSms(message, { sender: 'VM-HDFCBK-S' }).bank).toBe('HDFC Bank');
      expect(parseSms(message, { sender: 'AX-ICICIB-T' }).bank).toBe('ICICI Bank');
      expect(parseSms(message, { sender: 'VM-HDFCBK' }).bank).toBe('HDFC Bank');
    });

    it('keeps the receive time when the body date is the same day', () => {
      // 28 Aug 2026, 14:05 IST.
      const receivedAt = new Date('2026-08-28T08:35:00.000Z');
      const parsed = parseSms('Rs.499 debited from A/c XX4521 on 28-08-26 to NETFLIX', {
        receivedAt,
        timezone: 'Asia/Kolkata',
      });
      expect(parsed.date.toISOString()).toBe(receivedAt.toISOString());
    });

    it('matches the same day in the user timezone, not in UTC', () => {
      // 29 Aug 2026, 01:00 IST — still 28 Aug in UTC, so a UTC comparison would
      // wrongly move a "29-08-26" alert to the receive time of the day before.
      const receivedAt = new Date('2026-08-28T19:30:00.000Z');
      const parsed = parseSms('Rs.499 debited from A/c XX4521 on 29-08-26 to NETFLIX', {
        receivedAt,
        timezone: 'Asia/Kolkata',
      });
      expect(parsed.date.toISOString()).toBe(receivedAt.toISOString());
    });

    it('keeps the body date when the message arrived on a later day', () => {
      const parsed = parseSms('Rs.499 debited from A/c XX4521 on 20-08-26 to NETFLIX', {
        receivedAt: new Date('2026-08-28T08:35:00.000Z'),
        timezone: 'Asia/Kolkata',
      });
      expect(parsed.date.toISOString().slice(0, 10)).toBe('2026-08-20');
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
