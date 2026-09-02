'use strict';

const mongoose = require('mongoose');
const { SETTLEMENT_METHODS } = require('../constants/split');
const { round2 } = require('../utils/money');

const { Schema } = mongoose;

/**
 * A payment from one member to another, recorded to cancel out debt.
 *
 * Settlements are stored as immutable ledger entries rather than as a flag on
 * expenses. That is the difference between "this ₹300 dinner is settled" and
 * "Aarav paid Priya ₹300" — the second survives a later edit to the dinner, and
 * it is what makes partial settlement expressible at all: paying ₹200 of a ₹300
 * debt is simply a ₹200 entry, and the balance recomputes to ₹100 on its own.
 *
 * Nothing here mutates an expense, so there is no "settled" state to get out of
 * step with the arithmetic.
 */
const settlementSchema = new Schema(
  {
    group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },

    /** Group member subdocument ids — the payer and the recipient. */
    from: { type: Schema.Types.ObjectId, required: true, index: true },
    to: { type: Schema.Types.ObjectId, required: true, index: true },

    fromUser: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    toUser: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    amount: { type: Number, required: true, min: [0.01, 'Settlement amount must be greater than zero'], set: round2 },
    currency: { type: String, default: 'INR', uppercase: true, maxlength: 3 },

    method: { type: String, enum: SETTLEMENT_METHODS, default: 'upi' },
    date: { type: Date, required: true, default: () => new Date(), index: true },
    note: { type: String, trim: true, maxlength: 300, default: '' },

    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

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

settlementSchema.index({ group: 1, isDeleted: 1, date: -1 });

settlementSchema.methods.softDelete = function softDelete() {
  this.isDeleted = true;
  this.deletedAt = new Date();
  return this.save();
};

module.exports = mongoose.model('Settlement', settlementSchema);
