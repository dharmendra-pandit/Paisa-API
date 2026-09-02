'use strict';

const mongoose = require('mongoose');
const { GROUP_ROLES, GROUP_ROLE_LIST, GROUP_ICONS } = require('../constants/split');

const { Schema } = mongoose;

/**
 * A person inside a group.
 *
 * Two kinds of member exist and they are deliberately handled by one schema:
 *
 *  - a *linked* member has `user` pointing at a real account;
 *  - a *placeholder* has `user: null` and just a name, so you can split a
 *    dinner bill with someone who has not installed the app yet.
 *
 * The subdocument's own `_id` — not the user id — is the canonical handle used
 * by splits, settlements and balances. That indirection is what makes the two
 * kinds interchangeable: when a placeholder is later claimed by a real account,
 * `user` is filled in and every historical split still points at the right
 * person without a data migration.
 */
const memberSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    /** Display name. Copied from the account at add-time, editable for placeholders. */
    name: { type: String, required: true, trim: true, maxlength: 80 },

    /**
     * Lowercased email. For a placeholder this is the claim key — when someone
     * signs up with this address they inherit the member and its history.
     */
    email: { type: String, trim: true, lowercase: true, maxlength: 160, default: '' },

    avatar: { type: String, trim: true, maxlength: 500, default: '' },

    role: { type: String, enum: GROUP_ROLE_LIST, default: GROUP_ROLES.MEMBER },

    joinedAt: { type: Date, default: () => new Date() },

    /**
     * Members are retired, never deleted, because their name must still render
     * on the expenses they were part of. A retired member cannot be added to
     * new expenses and must be settled up before they can be removed.
     */
    isActive: { type: Boolean, default: true },
    removedAt: { type: Date, default: null },
  },
  { _id: true }
);

memberSchema.virtual('isPlaceholder').get(function isPlaceholder() {
  return !this.user;
});

const groupSchema = new Schema(
  {
    name: { type: String, required: [true, 'Group name is required'], trim: true, minlength: 1, maxlength: 60 },
    icon: { type: String, enum: GROUP_ICONS, default: 'friends' },

    /**
     * Splitting across currencies needs FX rates dated to each expense, which
     * is a separate feature. A group is single-currency and expenses inherit it.
     */
    currency: { type: String, default: 'INR', uppercase: true, maxlength: 3 },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    members: {
      type: [memberSchema],
      validate: [(value) => value.length > 0, 'A group needs at least one member'],
    },

    /**
     * Denormalised list of linked account ids. Every "groups I belong to" query
     * filters on this, and an array index makes that a single index hit instead
     * of an unindexed scan into the members subdocuments.
     */
    memberUsers: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],

    /** When true, balances are reported after debt simplification. */
    simplifyDebts: { type: Boolean, default: true },

    isArchived: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete ret.__v;
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
  }
);

groupSchema.index({ memberUsers: 1, isArchived: 1, updatedAt: -1 });

/** Keeps the denormalised membership list in step with the subdocuments. */
groupSchema.methods.syncMemberUsers = function syncMemberUsers() {
  const ids = this.members.filter((m) => m.user && m.isActive).map((m) => m.user);
  // De-duplicate via string keys — ObjectIds are objects, so Set dedupes by
  // reference identity and would happily keep two copies of the same id.
  const seen = new Map(ids.map((id) => [String(id), id]));
  this.memberUsers = [...seen.values()];
  return this.memberUsers;
};

groupSchema.pre('save', function syncBeforeSave(next) {
  if (this.isModified('members')) this.syncMemberUsers();
  next();
});

/** The member subdocument for a given account, or undefined. */
groupSchema.methods.memberForUser = function memberForUser(userId) {
  return this.members.find((m) => m.user && String(m.user) === String(userId) && m.isActive);
};

groupSchema.methods.memberById = function memberById(memberId) {
  return this.members.id(memberId);
};

groupSchema.methods.activeMembers = function activeMembers() {
  return this.members.filter((m) => m.isActive);
};

groupSchema.methods.isAdmin = function isAdmin(userId) {
  const member = this.memberForUser(userId);
  return Boolean(member && member.role === GROUP_ROLES.ADMIN);
};

module.exports = mongoose.model('Group', groupSchema);
module.exports.memberSchema = memberSchema;
