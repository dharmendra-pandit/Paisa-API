'use strict';

const mongoose = require('mongoose');
const Expense = require('../src/models/Expense');
const { repairOne, legacyAmount } = require('../src/scripts/repairSmsExpenses');
const { parseSms } = require('../src/services/sms.service');

/** An expense exactly as the old parser saved it from [raw]. */
async function legacyRow(raw, fields) {
  const parsed = parseSms(raw);
  return Expense.create({
    user: new mongoose.Types.ObjectId(),
    category: 'OTHER',
    date: new Date(),
    source: 'sms',
    type: parsed.type,
    sms: { raw: parsed.raw, fingerprint: parsed.fingerprint },
    ...fields,
  });
}

describe('repairing SMS expenses saved by the old parser', () => {
  it('knew the old parser cut long amounts short', () => {
    expect(legacyAmount('Rs.1500.00 debited from A/c XX1234 to SWIGGY')).toBe(150);
  });

  it('restores the full amount', async () => {
    const raw = 'Rs.1500.00 debited from A/c XX1234 to SWIGGY on 23-11-26';
    const row = await legacyRow(raw, { amount: 150, merchant: 'SWIGGY', note: 'Paid to SWIGGY' });

    const changes = await repairOne(row.toObject());

    expect(changes.amount).toBe(1500);
    expect((await Expense.findById(row._id)).amount).toBe(1500);
  });

  it('replaces "your" with the real sender and re-categorises', async () => {
    const raw = 'Rs.5000.00 credited to your A/c XX1234 on 23-11-26 from RAHUL SHARMA via UPI. Ref 512345678901';
    const row = await legacyRow(raw, { amount: 5000, merchant: 'your', note: 'Received from your' });

    await repairOne(row.toObject());

    const fixed = await Expense.findById(row._id);
    expect(fixed.merchant).toBe('RAHUL SHARMA');
    expect(fixed.note).toBe('Received from RAHUL SHARMA');
  });

  it('changes nothing the second time', async () => {
    const raw = 'Rs.1500.00 debited from A/c XX1234 to SWIGGY on 23-11-26';
    const row = await legacyRow(raw, { amount: 150, merchant: 'SWIGGY', note: 'Paid to SWIGGY' });

    await repairOne(row.toObject());
    expect(await repairOne((await Expense.findById(row._id)).toObject())).toBeNull();
  });

  it('never overwrites what the user corrected by hand', async () => {
    const raw = 'Rs.1500.00 debited from A/c XX1234 to SWIGGY on 23-11-26';
    // The user already fixed the amount and renamed it themselves.
    const row = await legacyRow(raw, { amount: 1450, merchant: 'Team lunch', note: 'Paid to SWIGGY' });

    expect(await repairOne(row.toObject())).toBeNull();
    const kept = await Expense.findById(row._id);
    expect(kept.amount).toBe(1450);
    expect(kept.merchant).toBe('Team lunch');
  });
});
