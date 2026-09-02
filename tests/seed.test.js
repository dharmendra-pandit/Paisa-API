'use strict';

const User = require('../src/models/User');
const { seedSplitGroup } = require('../src/seed/seed');
const data = require('../src/seed/sampleData');
const balanceService = require('../src/services/balance.service');
const Group = require('../src/models/Group');

/**
 * The seeder builds its demo group through the real services rather than direct
 * inserts, so this doubles as an integration check on the split engine: if the
 * calculation or balance code ever regresses, seeding produces balances that do
 * not sum to zero and this fails.
 */
describe('Seed — shared expense group', () => {
  it('builds a group whose balances reconcile exactly', async () => {
    const users = [];
    for (const fixture of data.USERS) {
      users.push(await User.create(fixture));
    }

    const summary = await seedSplitGroup(users);

    expect(summary).not.toBeNull();
    expect(summary.name).toBe('Goa Trip 2026');
    // Two real accounts plus two placeholders.
    expect(summary.members).toBe(4);
    expect(summary.expenses).toBe(data.SPLIT_GROUP.expenses.length);

    const expectedTotal = data.SPLIT_GROUP.expenses.reduce((sum, e) => sum + e.amount, 0);
    expect(summary.totalSpent).toBe(expectedTotal);

    // Simplification should genuinely reduce the transfer count on this data.
    expect(summary.transactionsAfter).toBeLessThanOrEqual(summary.transactionsBefore);
    expect(summary.transactionsAfter).toBeLessThanOrEqual(3); // at most n-1 for 4 members

    const group = await Group.findOne({ name: 'Goa Trip 2026' });
    const balances = await balanceService.getGroupBalances(group);

    // The invariant that matters: every rupee paid is a rupee owed.
    const net = balances.members.reduce((sum, m) => sum + m.net, 0);
    expect(Math.round(net * 100) / 100).toBe(0);

    // The partial settlement means the group is mid-flight, not clean.
    expect(balances.isSettled).toBe(false);
    expect(balances.totals.settlementCount).toBe(1);
  });

  it('returns null rather than throwing when there are too few users', async () => {
    const solo = [await User.create(data.USERS[0])];
    expect(await seedSplitGroup(solo)).toBeNull();
  });
});
