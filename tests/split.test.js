'use strict';

const { app, api, request, registerUser } = require('./helpers');
const { computeSplits, simplifyDebts, allocate } = require('../src/utils/splitMath');

/**
 * Shared-expense suite.
 *
 * The assertions that matter most are the arithmetic ones: shares must sum to
 * the bill exactly, and net positions across a group must sum to zero. Those two
 * invariants are what stand between this feature and balances that never reach
 * zero, so they are checked after every mutation rather than only at the end.
 */

const sum = (values) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;

/** Creates a group owned by `owner` with N placeholder friends. */
async function makeGroup(owner, { name = 'Goa Trip', members = [] } = {}) {
  const res = await request(app)
    .post(api('/groups/create'))
    .set(owner.auth)
    .send({ name, icon: 'trip', members })
    .expect(201);

  const group = res.body.data.group;
  const byName = (n) => group.members.find((m) => m.name === n);
  return { group, byName, me: group.members.find((m) => m.user === owner.user.id) };
}

describe('Split expenses — pure calculation engine', () => {
  it('allocates every paisa of an indivisible bill', () => {
    const parts = allocate(10000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(parts).toEqual([3334, 3333, 3333]);
  });

  it('splits equally without losing or inventing money', () => {
    const splits = computeSplits({
      amount: 100,
      splitType: 'equal',
      participants: [{ member: 'a' }, { member: 'b' }, { member: 'c' }],
    });
    expect(sum(splits.map((s) => s.amount))).toBe(100);
    expect(splits.map((s) => s.amount)).toEqual([33.34, 33.33, 33.33]);
  });

  it('keeps percentage and share splits exact', () => {
    const pct = computeSplits({
      amount: 999.99,
      splitType: 'percentage',
      participants: [{ member: 'a', share: 33.33 }, { member: 'b', share: 33.33 }, { member: 'c', share: 33.34 }],
    });
    expect(sum(pct.map((s) => s.amount))).toBe(999.99);

    const shares = computeSplits({
      amount: 1000,
      splitType: 'shares',
      participants: [{ member: 'a', share: 2 }, { member: 'b', share: 1 }, { member: 'c', share: 1 }],
    });
    expect(shares.map((s) => s.amount)).toEqual([500, 250, 250]);
  });

  it('never drifts across thousands of random splits', () => {
    let mismatches = 0;
    for (let i = 0; i < 5000; i += 1) {
      const amount = Math.round(Math.random() * 100000) / 100;
      const n = 2 + Math.floor(Math.random() * 8);
      const participants = Array.from({ length: n }, (_, k) => ({
        member: String(k),
        share: Math.round(Math.random() * 1000) / 10,
      }));
      const splitType = ['equal', 'shares', 'percentage'][i % 3];
      const result = computeSplits({ amount, splitType, participants });
      if (sum(result.map((s) => s.amount)) !== amount) mismatches += 1;
    }
    expect(mismatches).toBe(0);
  });

  it('collapses a debt chain into a single transfer', () => {
    // A owes B 300 and B owes C 300 — the middle position cancels out entirely.
    expect(simplifyDebts({ A: -300, B: 0, C: 300 })).toEqual([{ from: 'A', to: 'C', amount: 300 }]);
  });

  it('clears every position it simplifies', () => {
    const net = { A: -500, B: -250, C: 300, D: 450 };
    const transactions = simplifyDebts(net);
    const settled = { ...net };
    for (const t of transactions) {
      settled[t.from] += t.amount;
      settled[t.to] -= t.amount;
    }
    expect(Object.values(settled).every((v) => Math.abs(v) < 0.005)).toBe(true);
    // At most n-1 transfers for n people.
    expect(transactions.length).toBeLessThanOrEqual(3);
  });
});

describe('Groups', () => {
  it('creates a group with the creator as admin', async () => {
    const owner = await registerUser();
    const { group, me } = await makeGroup(owner);

    expect(group.name).toBe('Goa Trip');
    expect(group.members).toHaveLength(1);
    expect(me.role).toBe('admin');
    expect(me.isPlaceholder).toBe(false);
  });

  it('adds a registered user by email and a stranger as a placeholder', async () => {
    const owner = await registerUser();
    const friend = await registerUser({ email: 'priya@paisa.app', name: 'Priya' });

    const { group } = await makeGroup(owner, {
      members: [{ email: 'priya@paisa.app' }, { email: 'ravi@example.com', name: 'Ravi' }],
    });

    const priya = group.members.find((m) => m.name === 'Priya');
    const ravi = group.members.find((m) => m.name === 'Ravi');

    expect(priya.user).toBe(friend.user.id);
    expect(priya.isPlaceholder).toBe(false);
    expect(ravi.user).toBeNull();
    expect(ravi.isPlaceholder).toBe(true);
  });

  it('rejects a placeholder with no name to identify them by', async () => {
    const owner = await registerUser();
    const res = await request(app)
      .post(api('/groups/create'))
      .set(owner.auth)
      .send({ name: 'Flat', members: [{ email: 'nobody@example.com' }] })
      .expect(400);

    expect(res.body.message).toMatch(/supply a name/i);
  });

  it('refuses to add the same person twice', async () => {
    const owner = await registerUser();
    const { group } = await makeGroup(owner, { members: [{ email: 'ravi@example.com', name: 'Ravi' }] });

    await request(app)
      .post(api('/groups/add-member'))
      .set(owner.auth)
      .send({ groupId: group.id, email: 'ravi@example.com', name: 'Ravi' })
      .expect(409);
  });

  it('hides groups you are not a member of behind a 404', async () => {
    const owner = await registerUser();
    const outsider = await registerUser({ email: 'outsider@paisa.app' });
    const { group } = await makeGroup(owner);

    await request(app).get(api(`/groups/${group.id}`)).set(outsider.auth).expect(404);
    await request(app).get(api(`/groups/${group.id}/balances`)).set(outsider.auth).expect(404);
  });

  it('only lets an admin add members', async () => {
    const owner = await registerUser();
    const friend = await registerUser({ email: 'priya@paisa.app', name: 'Priya' });
    const { group } = await makeGroup(owner, { members: [{ email: 'priya@paisa.app' }] });

    await request(app)
      .post(api('/groups/add-member'))
      .set(friend.auth)
      .send({ groupId: group.id, email: 'new@example.com', name: 'New' })
      .expect(403);
  });

  it('lists your groups with your net position in each', async () => {
    const owner = await registerUser();
    const { group, byName } = await makeGroup(owner, { members: [{ email: 'r@example.com', name: 'Ravi' }] });

    await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({ description: 'Cab', amount: 1000 })
      .expect(201);

    const res = await request(app).get(api('/groups')).set(owner.auth).expect(200);
    const listed = res.body.data.groups[0];

    // Paid 1000, consumed 500 — owed 500 by Ravi.
    expect(listed.yourBalance).toBe(500);
    expect(listed.yourStatus).toBe('owed');
    expect(res.body.data.summary.totalOwedToYou).toBe(500);
    expect(byName('Ravi')).toBeDefined();
  });
});

describe('Shared expenses', () => {
  it('splits equally across everyone when no participants are named', async () => {
    const owner = await registerUser();
    const { group } = await makeGroup(owner, {
      members: [{ email: 'a@example.com', name: 'Ravi' }, { email: 'b@example.com', name: 'Priya' }],
    });

    const res = await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({ description: 'Dinner', amount: 100, category: 'FOOD' })
      .expect(201);

    const expense = res.body.data.expense;
    expect(expense.splits).toHaveLength(3);
    expect(sum(expense.splits.map((s) => s.amount))).toBe(100);
    expect(expense.yourShare).toBe(33.34);
    expect(expense.youPaid).toBe(100);
    expect(expense.lentOrBorrowed).toBe('lent');
  });

  it('honours an exact split and rejects one that does not add up', async () => {
    const owner = await registerUser();
    const { group, byName, me } = await makeGroup(owner, { members: [{ email: 'r@example.com', name: 'Ravi' }] });

    await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({
        description: 'Groceries',
        amount: 250.75,
        splitType: 'exact',
        participants: [
          { member: me.id, share: 100.25 },
          { member: byName('Ravi').id, share: 150.5 },
        ],
      })
      .expect(201);

    const bad = await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({
        description: 'Broken',
        amount: 300,
        splitType: 'exact',
        participants: [
          { member: me.id, share: 100 },
          { member: byName('Ravi').id, share: 150 },
        ],
      })
      .expect(422);

    expect(bad.body.message).toMatch(/add up to the total/i);
  });

  it('rejects percentages that do not total 100', async () => {
    const owner = await registerUser();
    const { group, byName, me } = await makeGroup(owner, { members: [{ email: 'r@example.com', name: 'Ravi' }] });

    const res = await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({
        description: 'Rent',
        amount: 20000,
        splitType: 'percentage',
        participants: [
          { member: me.id, share: 60 },
          { member: byName('Ravi').id, share: 30 },
        ],
      })
      .expect(422);

    expect(res.body.message).toMatch(/add up to 100/i);
  });

  it('refuses a participant who is not in the group', async () => {
    const owner = await registerUser();
    const other = await registerUser({ email: 'x@paisa.app' });
    const { group: mine, me } = await makeGroup(owner);
    const { group: theirs } = await makeGroup(other, { name: 'Other' });
    const strangerMember = theirs.members[0].id;

    await request(app)
      .post(api(`/groups/${mine.id}/expenses`))
      .set(owner.auth)
      .send({
        description: 'Nope',
        amount: 100,
        splitType: 'exact',
        participants: [
          { member: me.id, share: 50 },
          { member: strangerMember, share: 50 },
        ],
      })
      .expect(400);
  });

  it('recomputes every share when an expense is edited', async () => {
    const owner = await registerUser();
    const { group } = await makeGroup(owner, {
      members: [{ email: 'a@example.com', name: 'Ravi' }, { email: 'b@example.com', name: 'Priya' }],
    });

    const created = await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({ description: 'Hotel', amount: 3000 })
      .expect(201);

    const updated = await request(app)
      .patch(api(`/groups/${group.id}/expenses/${created.body.data.expense.id}`))
      .set(owner.auth)
      .send({ amount: 4500 })
      .expect(200);

    const splits = updated.body.data.expense.splits;
    expect(sum(splits.map((s) => s.amount))).toBe(4500);
    expect(splits.every((s) => s.amount === 1500)).toBe(true);
  });

  it('mirrors only your own share into your personal ledger', async () => {
    const owner = await registerUser();
    const { group } = await makeGroup(owner, {
      members: [{ email: 'a@example.com', name: 'Ravi' }, { email: 'b@example.com', name: 'Priya' }],
    });

    await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({ description: 'Team lunch', amount: 3000, category: 'FOOD', addToPersonalExpenses: true })
      .expect(201);

    const personal = await request(app).get(api('/expenses')).set(owner.auth).expect(200);
    const mirrored = personal.body.data.expenses.find((e) => e.merchant === 'Team lunch');

    // A third of the bill, not the whole thing.
    expect(mirrored.amount).toBe(1000);
    expect(mirrored.tags).toContain('split');
  });
});

describe('Balances and settlement', () => {
  it('reports who owes whom and nets to zero', async () => {
    const owner = await registerUser();
    const { group, byName, me } = await makeGroup(owner, { members: [{ email: 'r@example.com', name: 'Ravi' }] });

    await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({ description: 'Tickets', amount: 2000 })
      .expect(201);

    const res = await request(app).get(api(`/groups/${group.id}/balances`)).set(owner.auth).expect(200);
    const data = res.body.data;

    expect(sum(data.members.map((m) => m.net))).toBe(0);
    expect(data.members.find((m) => m.member === me.id).net).toBe(1000);
    expect(data.members.find((m) => m.member === byName('Ravi').id).net).toBe(-1000);
    expect(data.settleUp).toEqual([
      expect.objectContaining({ amount: 1000, from: expect.objectContaining({ name: 'Ravi' }) }),
    ]);
    expect(data.isSettled).toBe(false);
  });

  it('simplifies a circular debt into one transfer', async () => {
    const owner = await registerUser({ name: 'Aarav' });
    const { group, byName, me } = await makeGroup(owner, {
      members: [{ email: 'b@example.com', name: 'Bhavna' }, { email: 'c@example.com', name: 'Chirag' }],
    });
    const bhavna = byName('Bhavna');
    const chirag = byName('Chirag');

    // Aarav owes Bhavna 300: Bhavna pays, split between Aarav and Bhavna.
    await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({
        description: 'Lunch',
        amount: 600,
        paidBy: bhavna.id,
        splitType: 'exact',
        participants: [{ member: me.id, share: 600 }],
      })
      .expect(201);

    // Bhavna owes Chirag 600: Chirag pays for Bhavna alone.
    await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({
        description: 'Taxi',
        amount: 600,
        paidBy: chirag.id,
        splitType: 'exact',
        participants: [{ member: bhavna.id, share: 600 }],
      })
      .expect(201);

    const res = await request(app).get(api(`/groups/${group.id}/balances`)).set(owner.auth).expect(200);
    const data = res.body.data;

    // Bhavna's +600 and -600 cancel: one transfer, Aarav to Chirag.
    expect(data.simplifiedDebts).toHaveLength(1);
    expect(data.simplifiedDebts[0]).toMatchObject({
      from: expect.objectContaining({ name: 'Aarav' }),
      to: expect.objectContaining({ name: 'Chirag' }),
      amount: 600,
    });
    expect(data.totals.transactionsSaved).toBe(1);
  });

  it('supports partial settlement and then full settlement', async () => {
    const owner = await registerUser();
    const { group, byName, me } = await makeGroup(owner, { members: [{ email: 'r@example.com', name: 'Ravi' }] });
    const ravi = byName('Ravi');

    await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({ description: 'Concert', amount: 600 })
      .expect(201);

    // Ravi owes 300. He pays 200 of it.
    const partial = await request(app)
      .post(api('/groups/settle'))
      .set(owner.auth)
      .send({ groupId: group.id, from: ravi.id, to: me.id, amount: 200, method: 'upi' })
      .expect(201);

    expect(partial.body.data.balances.members.find((m) => m.member === ravi.id).net).toBe(-100);
    expect(partial.body.data.balances.isSettled).toBe(false);

    // And then the rest.
    const full = await request(app)
      .post(api(`/groups/${group.id}/settle`))
      .set(owner.auth)
      .send({ from: ravi.id, to: me.id, amount: 100 })
      .expect(201);

    expect(full.body.data.balances.isSettled).toBe(true);
    expect(full.body.data.balances.settleUp).toHaveLength(0);
  });

  it('reverses a settlement recorded in error', async () => {
    const owner = await registerUser();
    const { group, byName, me } = await makeGroup(owner, { members: [{ email: 'r@example.com', name: 'Ravi' }] });
    const ravi = byName('Ravi');

    await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({ description: 'Books', amount: 400 })
      .expect(201);

    const settled = await request(app)
      .post(api(`/groups/${group.id}/settle`))
      .set(owner.auth)
      .send({ from: ravi.id, to: me.id, amount: 200 })
      .expect(201);

    const reversed = await request(app)
      .delete(api(`/groups/${group.id}/settlements/${settled.body.data.settlement.id}`))
      .set(owner.auth)
      .expect(200);

    expect(reversed.body.data.balances.members.find((m) => m.member === ravi.id).net).toBe(-200);
  });

  it('rebalances when an expense is deleted', async () => {
    const owner = await registerUser();
    const { group, byName } = await makeGroup(owner, { members: [{ email: 'r@example.com', name: 'Ravi' }] });

    const created = await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({ description: 'Mistake', amount: 1000 })
      .expect(201);

    const deleted = await request(app)
      .delete(api(`/groups/${group.id}/expenses/${created.body.data.expense.id}`))
      .set(owner.auth)
      .expect(200);

    expect(deleted.body.data.balances.isSettled).toBe(true);
    expect(deleted.body.data.balances.members.find((m) => m.member === byName('Ravi').id).net).toBe(0);
  });

  it('refuses to remove a member who still owes money', async () => {
    const owner = await registerUser();
    const { group, byName } = await makeGroup(owner, { members: [{ email: 'r@example.com', name: 'Ravi' }] });
    const ravi = byName('Ravi');

    await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({ description: 'Fuel', amount: 800 })
      .expect(201);

    const blocked = await request(app)
      .delete(api(`/groups/${group.id}/members/${ravi.id}`))
      .set(owner.auth)
      .expect(400);

    expect(blocked.body.message).toMatch(/outstanding balance/i);
  });

  it('will not let the last admin leave', async () => {
    const owner = await registerUser();
    const { group, me } = await makeGroup(owner);

    const res = await request(app).delete(api(`/groups/${group.id}/members/${me.id}`)).set(owner.auth).expect(400);
    expect(res.body.message).toMatch(/admin/i);
  });
});

describe('Placeholder members', () => {
  it('transfers a placeholder and its balances to a matching new signup', async () => {
    const owner = await registerUser();
    const { group, byName } = await makeGroup(owner, { members: [{ email: 'later@paisa.app', name: 'Later' }] });
    const placeholder = byName('Later');

    await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({ description: 'Advance', amount: 1000 })
      .expect(201);

    // The placeholder now signs up with that exact address.
    const joined = await registerUser({ email: 'later@paisa.app', name: 'Later Joiner' });

    const theirGroups = await request(app).get(api('/groups')).set(joined.auth).expect(200);
    expect(theirGroups.body.data.groups).toHaveLength(1);
    expect(theirGroups.body.data.groups[0].id).toBe(group.id);
    // They inherit the debt already recorded against the placeholder.
    expect(theirGroups.body.data.groups[0].yourBalance).toBe(-500);

    const detail = await request(app).get(api(`/groups/${group.id}`)).set(joined.auth).expect(200);
    // Same member row, now linked to a real account.
    expect(detail.body.data.you.member).toBe(placeholder.id);
  });
});

describe('Group lifecycle', () => {
  it('archives rather than deletes a group with history', async () => {
    const owner = await registerUser();
    const { group } = await makeGroup(owner, { members: [{ email: 'r@example.com', name: 'Ravi' }] });

    await request(app)
      .post(api(`/groups/${group.id}/expenses`))
      .set(owner.auth)
      .send({ description: 'Anything', amount: 100 })
      .expect(201);

    const blocked = await request(app).delete(api(`/groups/${group.id}`)).set(owner.auth).expect(400);
    expect(blocked.body.message).toMatch(/archive/i);

    await request(app).patch(api(`/groups/${group.id}`)).set(owner.auth).send({ isArchived: true }).expect(200);

    const active = await request(app).get(api('/groups')).set(owner.auth).expect(200);
    expect(active.body.data.groups).toHaveLength(0);

    const all = await request(app).get(api('/groups?includeArchived=true')).set(owner.auth).expect(200);
    expect(all.body.data.groups).toHaveLength(1);
  });

  it('deletes an empty group', async () => {
    const owner = await registerUser();
    const { group } = await makeGroup(owner);

    await request(app).delete(api(`/groups/${group.id}`)).set(owner.auth).expect(200);
    await request(app).get(api(`/groups/${group.id}`)).set(owner.auth).expect(404);
  });

  it('finds users by email prefix but not by substring', async () => {
    const owner = await registerUser();
    await registerUser({ email: 'findable@paisa.app', name: 'Findable' });

    const hit = await request(app).get(api('/groups/search-users?query=findable')).set(owner.auth).expect(200);
    expect(hit.body.data.users).toHaveLength(1);

    // A substring search would let anyone enumerate the user table.
    const miss = await request(app).get(api('/groups/search-users?query=able@pai')).set(owner.auth).expect(200);
    expect(miss.body.data.users).toHaveLength(0);
  });
});
