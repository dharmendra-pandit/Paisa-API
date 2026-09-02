'use strict';

const mongoose = require('mongoose');
const { CATEGORY_LIST, CATEGORIES } = require('../constants/categories');
const { round2 } = require('../utils/money');

const { Schema } = mongoose;

const CADENCES = Object.freeze(['weekly', 'monthly', 'quarterly', 'yearly', 'irregular']);

const subscriptionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    merchant: { type: String, required: true, trim: true, maxlength: 120 },
    merchantKey: { type: String, required: true, trim: true, maxlength: 120, index: true },

    category: { type: String, enum: CATEGORY_LIST, default: CATEGORIES.SUBSCRIPTIONS },

    /** Representative charge — the median, so one price hike does not skew it. */
    amount: { type: Number, required: true, min: 0, set: round2 },
    currency: { type: String, default: 'INR', uppercase: true, maxlength: 3 },
    cadence: { type: String, enum: CADENCES, default: 'monthly' },
    /** Observed mean gap between charges, in days. */
    intervalDays: { type: Number, min: 1 },

    occurrences: { type: Number, default: 0, min: 0 },
    firstChargedAt: { type: Date },
    lastChargedAt: { type: Date },
    nextExpectedAt: { type: Date, index: true },

    /** 0-1 detector score: how regular the cadence and how stable the amount. */
    confidence: { type: Number, min: 0, max: 1, default: 0 },

    status: { type: String, enum: ['active', 'lapsed', 'cancelled'], default: 'active', index: true },
    /**
     * Set when a user confirms or rejects the detection. The detector never
     * overwrites a human decision — it only refreshes the derived statistics.
     */
    userVerdict: { type: String, enum: ['unreviewed', 'confirmed', 'dismissed'], default: 'unreviewed' },

    expenses: [{ type: Schema.Types.ObjectId, ref: 'Expense' }],
    estimatedMonthlyCost: { type: Number, default: 0, set: round2 },
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

subscriptionSchema.index({ user: 1, merchantKey: 1 }, { unique: true });
subscriptionSchema.index({ user: 1, status: 1, nextExpectedAt: 1 });

subscriptionSchema.virtual('estimatedYearlyCost').get(function estimatedYearlyCost() {
  return round2((this.estimatedMonthlyCost || 0) * 12);
});

subscriptionSchema.statics.CADENCES = CADENCES;

module.exports = mongoose.model('Subscription', subscriptionSchema);
module.exports.CADENCES = CADENCES;
