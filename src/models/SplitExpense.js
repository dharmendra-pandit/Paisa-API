'use strict';

const mongoose = require('mongoose');
const { CATEGORY_LIST, CATEGORIES } = require('../constants/categories');
const { SPLIT_TYPE_LIST, SPLIT_TYPES } = require('../constants/split');
const { round2 } = require('../utils/money');

const { Schema } = mongoose;

/**
 * One member's stake in a shared bill.
 *
 * `amount` is always the authoritative rupee figure the member owes, computed
 * server-side. `share` is the raw input that produced it — a percentage, a
 * weight, or the exact amount the client asked for — kept so the expense can be
 * re-opened for editing with the user's original intent intact rather than
 * reverse-engineered from rounded rupees.
 */
const splitShareSchema = new Schema(
  {
    /** Group member subdocument id — never a user id. See Group.memberSchema. */
    member: { type: Schema.Types.ObjectId, required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    amount: { type: Number, required: true, min: 0, set: round2 },
    share: { type: Number, default: null },
  },
  { _id: false }
);

const splitExpenseSchema = new Schema(
  {
    group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },

    description: { type: String, required: [true, 'Description is required'], trim: true, maxlength: 140 },
    amount: { type: Number, required: [true, 'Amount is required'], min: [0.01, 'Amount must be greater than zero'], set: round2 },
    currency: { type: String, default: 'INR', uppercase: true, maxlength: 3 },

    category: { type: String, enum: CATEGORY_LIST, default: CATEGORIES.OTHER, index: true },

    /** The member who actually paid the merchant. */
    paidBy: { type: Schema.Types.ObjectId, required: true, index: true },
    paidByUser: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    splitType: { type: String, enum: SPLIT_TYPE_LIST, default: SPLIT_TYPES.EQUAL },

    /**
     * Who owes what. Invariant enforced by the service layer: these amounts sum
     * to `amount` exactly, to the paisa. Balance maths is a straight sum over
     * this array, so any drift here becomes money appearing or vanishing.
     */
    splits: {
      type: [splitShareSchema],
      validate: [(value) => value.length > 0, 'An expense must be split between at least one member'],
    },

    date: { type: Date, required: true, default: () => new Date(), index: true },
    note: { type: String, trim: true, maxlength: 500, default: '' },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /**
     * Set when the payer chose to mirror this into their personal ledger, so
     * their own analytics include their share. Deleting the split expense
     * deletes the mirror too.
     */
    personalExpense: { type: Schema.Types.ObjectId, ref: 'Expense', default: null },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
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

// The group ledger view: this group, newest first, excluding deleted rows.
splitExpenseSchema.index({ group: 1, isDeleted: 1, date: -1 });
// Balance recomputation scans every live expense for a group.
splitExpenseSchema.index({ group: 1, isDeleted: 1, 'splits.member': 1 });
splitExpenseSchema.index({ description: 'text' });

splitExpenseSchema.methods.softDelete = function softDelete() {
  this.isDeleted = true;
  this.deletedAt = new Date();
  return this.save();
};

/** What a given member owes on this bill, 0 if they are not part of it. */
splitExpenseSchema.methods.shareFor = function shareFor(memberId) {
  const row = this.splits.find((s) => String(s.member) === String(memberId));
  return row ? row.amount : 0;
};

module.exports = mongoose.model('SplitExpense', splitExpenseSchema);
