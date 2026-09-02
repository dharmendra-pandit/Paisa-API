'use strict';

const Group = require('../models/Group');
const User = require('../models/User');
const SplitExpense = require('../models/SplitExpense');
const Settlement = require('../models/Settlement');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { GROUP_ROLES } = require('../constants/split');

const MAX_MEMBERS = 50;

/**
 * Loads a group the caller is entitled to see.
 *
 * A group the user is not a member of reports 404, not 403. Distinguishing the
 * two would turn the endpoint into an oracle for "does this group id exist",
 * which is the same reasoning that makes login return one message for both a
 * wrong password and an unknown address.
 */
async function loadGroupForUser(user, groupId, { requireAdmin = false } = {}) {
  const group = await Group.findById(groupId);
  if (!group) throw ApiError.notFound('Group not found');

  const member = group.memberForUser(user._id);
  if (!member) throw ApiError.notFound('Group not found');

  if (requireAdmin && member.role !== GROUP_ROLES.ADMIN) {
    throw ApiError.forbidden('Only a group admin can do that');
  }

  return { group, member };
}

/**
 * Resolves one requested member into a subdocument.
 *
 * Three shapes are accepted, in descending order of precision: an explicit
 * userId, an email (linked if that account exists, held as a placeholder if
 * not), or a bare name for someone with no email at all. The email path is what
 * makes a placeholder claimable later — see claimPlaceholders.
 */
async function resolveMemberInput(input) {
  const email = input.email ? String(input.email).toLowerCase().trim() : '';

  if (input.userId) {
    const account = await User.findById(input.userId).select('name email avatar isActive');
    if (!account || !account.isActive) throw ApiError.notFound('That user account does not exist');
    return { user: account._id, name: input.name || account.name, email: account.email, avatar: account.avatar || '' };
  }

  if (email) {
    const account = await User.findOne({ email, isActive: true }).select('name email avatar');
    if (account) {
      return { user: account._id, name: input.name || account.name, email: account.email, avatar: account.avatar || '' };
    }
    // No account yet: hold the seat. Balances accrue against the placeholder
    // and transfer intact when they sign up with this address.
    if (!input.name) throw ApiError.badRequest(`No Paisa account for ${email} — supply a name to add them as a placeholder`);
    return { user: null, name: input.name, email, avatar: '' };
  }

  if (!input.name) throw ApiError.badRequest('Each member needs a userId, an email, or a name');
  return { user: null, name: input.name, email: '', avatar: '' };
}

/** Rejects a member who is already in the group, by account or by email. */
function assertNotDuplicate(group, candidate) {
  const clash = group.members.find((m) => {
    if (!m.isActive) return false;
    if (candidate.user && m.user) return String(m.user) === String(candidate.user);
    if (candidate.email && m.email) return m.email === candidate.email;
    return false;
  });

  if (clash) throw ApiError.conflict(`${clash.name} is already in this group`);
}

async function createGroup(user, { name, icon, currency, members = [], simplifyDebts = true }) {
  const group = new Group({
    name,
    icon,
    currency: currency || user.currency,
    createdBy: user._id,
    simplifyDebts,
    // The creator is always a member, and always an admin — a group with no
    // admin can never be edited again.
    members: [
      {
        user: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar || '',
        role: GROUP_ROLES.ADMIN,
      },
    ],
  });

  for (const input of members) {
    const resolved = await resolveMemberInput(input);
    assertNotDuplicate(group, resolved);
    group.members.push({ ...resolved, role: GROUP_ROLES.MEMBER });
  }

  if (group.members.length > MAX_MEMBERS) {
    throw ApiError.badRequest(`A group cannot have more than ${MAX_MEMBERS} members`);
  }

  await group.save();
  logger.info('Group created', { groupId: String(group._id), userId: String(user._id), members: group.members.length });
  return group;
}

async function addMember(user, groupId, input) {
  const { group } = await loadGroupForUser(user, groupId, { requireAdmin: true });

  if (group.isArchived) throw ApiError.badRequest('This group is archived');
  if (group.activeMembers().length >= MAX_MEMBERS) {
    throw ApiError.badRequest(`A group cannot have more than ${MAX_MEMBERS} members`);
  }

  const resolved = await resolveMemberInput(input);

  // Re-activating someone who was previously removed keeps their historical
  // splits attached to the same member id instead of orphaning them.
  const retired = group.members.find(
    (m) => !m.isActive && ((resolved.user && m.user && String(m.user) === String(resolved.user)) || (resolved.email && m.email === resolved.email))
  );

  if (retired) {
    retired.isActive = true;
    retired.removedAt = null;
    retired.name = resolved.name || retired.name;
    retired.avatar = resolved.avatar || retired.avatar;
  } else {
    assertNotDuplicate(group, resolved);
    group.members.push({ ...resolved, role: input.role === GROUP_ROLES.ADMIN ? GROUP_ROLES.ADMIN : GROUP_ROLES.MEMBER });
  }

  group.markModified('members');
  await group.save();
  return group;
}

/**
 * Retires a member.
 *
 * Two guards matter here. A member carrying a non-zero balance cannot leave —
 * removing them would silently destroy money the group owes or is owed. And the
 * last admin cannot leave, because the group would become uneditable.
 *
 * The row is deactivated rather than deleted so their name still renders on the
 * expenses they were part of.
 */
async function removeMember(user, groupId, memberId, { balanceService }) {
  const { group } = await loadGroupForUser(user, groupId, { requireAdmin: true });

  const member = group.memberById(memberId);
  if (!member || !member.isActive) throw ApiError.notFound('Member not found in this group');

  const balances = await balanceService.computeBalances(group);
  const net = balances.netByMember[String(memberId)] || 0;
  if (Math.abs(net) >= 0.01) {
    throw ApiError.badRequest(
      `${member.name} still has an outstanding balance of ${group.currency} ${Math.abs(net).toFixed(2)}. Settle up before removing them.`
    );
  }

  const admins = group.activeMembers().filter((m) => m.role === GROUP_ROLES.ADMIN);
  if (member.role === GROUP_ROLES.ADMIN && admins.length === 1) {
    throw ApiError.badRequest('Promote another member to admin before removing the last one');
  }

  member.isActive = false;
  member.removedAt = new Date();
  group.markModified('members');
  await group.save();

  return { group, removed: { id: String(member._id), name: member.name } };
}

/** Promotes or demotes a member. The last admin cannot demote themselves. */
async function updateMemberRole(user, groupId, memberId, role) {
  const { group } = await loadGroupForUser(user, groupId, { requireAdmin: true });

  const member = group.memberById(memberId);
  if (!member || !member.isActive) throw ApiError.notFound('Member not found in this group');
  if (!member.user) throw ApiError.badRequest('A placeholder member cannot be an admin until they join');

  const admins = group.activeMembers().filter((m) => m.role === GROUP_ROLES.ADMIN);
  if (member.role === GROUP_ROLES.ADMIN && role !== GROUP_ROLES.ADMIN && admins.length === 1) {
    throw ApiError.badRequest('A group must keep at least one admin');
  }

  member.role = role;
  group.markModified('members');
  await group.save();
  return group;
}

async function updateGroup(user, groupId, patch) {
  const { group } = await loadGroupForUser(user, groupId, { requireAdmin: true });

  for (const field of ['name', 'icon', 'simplifyDebts', 'isArchived']) {
    if (patch[field] !== undefined) group[field] = patch[field];
  }

  await group.save();
  return group;
}

/**
 * Deletes a group, but only once it is empty of financial history.
 *
 * A group with live expenses is archived instead: the ledger is the record of
 * who paid what, and destroying it to tidy a list is never the right trade.
 */
async function deleteGroup(user, groupId) {
  const { group } = await loadGroupForUser(user, groupId, { requireAdmin: true });

  const expenses = await SplitExpense.countDocuments({ group: group._id, isDeleted: false });
  if (expenses > 0) {
    throw ApiError.badRequest(`This group has ${expenses} expenses. Archive it instead of deleting it.`);
  }

  await Settlement.deleteMany({ group: group._id });
  await SplitExpense.deleteMany({ group: group._id });
  await group.deleteOne();

  logger.info('Group deleted', { groupId: String(group._id), userId: String(user._id) });
  return { id: String(group._id), name: group.name };
}

/**
 * Every group the user belongs to, each with their own position in it.
 *
 * The balance for each group is computed in one fan-out rather than per-group
 * round trips, because this backs the groups tab and is hit on every app open.
 */
async function listGroups(user, { includeArchived = false } = {}, { balanceService }) {
  const filter = { memberUsers: user._id };
  if (!includeArchived) filter.isArchived = false;

  const groups = await Group.find(filter).sort({ updatedAt: -1 });

  const withBalances = await Promise.all(
    groups.map(async (group) => {
      const balances = await balanceService.computeBalances(group);
      const me = group.memberForUser(user._id);
      const myNet = me ? balances.netByMember[String(me._id)] || 0 : 0;

      return {
        ...presentGroup(group),
        memberCount: group.activeMembers().length,
        yourBalance: myNet,
        // Pre-resolved so the client does not re-derive the sign of a float.
        yourStatus: myNet > 0.005 ? 'owed' : myNet < -0.005 ? 'owes' : 'settled',
        totalExpenses: balances.totals.expenseCount,
        totalSpent: balances.totals.totalSpent,
      };
    })
  );

  const aggregate = withBalances.reduce(
    (acc, g) => {
      if (g.yourBalance > 0) acc.totalOwedToYou += g.yourBalance;
      else acc.totalYouOwe += Math.abs(g.yourBalance);
      return acc;
    },
    { totalOwedToYou: 0, totalYouOwe: 0 }
  );

  return {
    groups: withBalances,
    summary: {
      count: withBalances.length,
      totalOwedToYou: Math.round(aggregate.totalOwedToYou * 100) / 100,
      totalYouOwe: Math.round(aggregate.totalYouOwe * 100) / 100,
      netPosition: Math.round((aggregate.totalOwedToYou - aggregate.totalYouOwe) * 100) / 100,
      currency: user.currency,
    },
  };
}

/**
 * Links placeholder members to a freshly registered account.
 *
 * Called on signup: anyone who was added to a group by email before they had an
 * account inherits those memberships, along with every split and balance
 * already recorded against them. Without this, signing up would strand their
 * history behind a placeholder nobody can log in as.
 *
 * Failures are logged and swallowed by the caller — a hiccup linking old groups
 * must never fail the registration itself.
 */
async function claimPlaceholders(userDoc) {
  const email = String(userDoc.email).toLowerCase();

  const groups = await Group.find({ members: { $elemMatch: { user: null, email, isActive: true } } });
  if (!groups.length) return { claimed: 0, groups: [] };

  const claimed = [];

  for (const group of groups) {
    // Guard against the edge case where the account is already a member under
    // a different row; linking would give them two seats at the table.
    if (group.memberForUser(userDoc._id)) continue;

    const placeholder = group.members.find((m) => !m.user && m.isActive && m.email === email);
    if (!placeholder) continue;

    placeholder.user = userDoc._id;
    placeholder.name = userDoc.name || placeholder.name;
    placeholder.avatar = userDoc.avatar || placeholder.avatar;
    group.markModified('members');
    await group.save();

    // Historical rows carry a denormalised user id for convenience; backfill it
    // so the new account's own queries see their past splits.
    await SplitExpense.updateMany({ group: group._id, paidBy: placeholder._id }, { $set: { paidByUser: userDoc._id } });
    await SplitExpense.updateMany(
      { group: group._id, 'splits.member': placeholder._id },
      { $set: { 'splits.$[row].user': userDoc._id } },
      { arrayFilters: [{ 'row.member': placeholder._id }] }
    );
    await Settlement.updateMany({ group: group._id, from: placeholder._id }, { $set: { fromUser: userDoc._id } });
    await Settlement.updateMany({ group: group._id, to: placeholder._id }, { $set: { toUser: userDoc._id } });

    claimed.push({ id: String(group._id), name: group.name });
  }

  if (claimed.length) {
    logger.info('Placeholder memberships claimed', { userId: String(userDoc._id), groups: claimed.length });
  }

  return { claimed: claimed.length, groups: claimed };
}

/** Serialises a group with its members resolved for display. */
function presentGroup(group) {
  const json = group.toJSON();
  json.members = group.members
    .filter((m) => m.isActive)
    .map((m) => ({
      id: String(m._id),
      user: m.user ? String(m.user) : null,
      name: m.name,
      email: m.email || null,
      avatar: m.avatar || '',
      role: m.role,
      isPlaceholder: !m.user,
      joinedAt: m.joinedAt,
    }));
  return json;
}

/** Looks up accounts by email so a client can offer real users when adding. */
async function searchUsers(user, { query, limit = 10 }) {
  const term = String(query).toLowerCase().trim();
  if (term.length < 3) throw ApiError.badRequest('Enter at least 3 characters to search');

  // Anchored prefix match only. A substring search over emails would let anyone
  // enumerate the user table one character at a time.
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const users = await User.find({
    email: { $regex: `^${escaped}`, $options: 'i' },
    isActive: true,
    _id: { $ne: user._id },
  })
    .select('name email avatar')
    .limit(Math.min(limit, 20))
    .lean();

  return {
    users: users.map((u) => ({ id: String(u._id), name: u.name, email: u.email, avatar: u.avatar || '' })),
  };
}

module.exports = {
  MAX_MEMBERS,
  loadGroupForUser,
  createGroup,
  listGroups,
  addMember,
  removeMember,
  updateMemberRole,
  updateGroup,
  deleteGroup,
  claimPlaceholders,
  presentGroup,
  searchUsers,
  resolveMemberInput,
};
