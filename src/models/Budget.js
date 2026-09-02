'use strict';

const mongoose = require('mongoose');
const { CATEGORY_LIST } = require('../constants/categories');
const { round2 } = require('../utils/money');
const config = require('../config/env');

const { Schema } = mongoose;

/** Sentinel for the overall (non category-specific) budget of a month. */
const OVERALL = 'OVERALL';

const budgetSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Calendar month this budget governs, as YYYY-MM in the user's timezone. */
    month: {
      type: String,
      required: true,
      match: [/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be in YYYY-MM format'],
      index: true,
    },

    /** OVERALL for the month-wide cap, or a specific category cap. */
    category: { type: String, enum: [...CATEGORY_LIST, OVERALL], default: OVERALL, index: true },

    amount: { type: Number, required: [true, 'Budget amount is required'], min: [1, 'Budget must be at least 1'], set: round2 },
    currency: { type: String, default: 'INR', uppercase: true, maxlength: 3 },

    /** Fraction of the cap that triggers a warning (0.8 = warn at 80%). */
    alertThreshold: { type: Number, min: 0.1, max: 1, default: config.budgetAlertThreshold },
    alertsEnabled: { type: Boolean, default: true },

    /**
     * Alert bookkeeping. Storing the last level we notified at makes warnings
     * edge-triggered — the user is told once when they cross 80%, not on every
     * subsequent expense.
     */
    lastAlert: {
      level: { type: String, enum: ['none', 'warning', 'exceeded'], default: 'none' },
      percentage: { type: Number, default: 0 },
      sentAt: { type: Date, default: null },
    },

    note: { type: String, trim: true, maxlength: 200, default: '' },
    /** Carried into the next month by the rollover helper when true. */
    autoRenew: { type: Boolean, default: true },
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

// One cap per user, per month, per category.
budgetSchema.index({ user: 1, month: 1, category: 1 }, { unique: true });

budgetSchema.statics.OVERALL = OVERALL;

module.exports = mongoose.model('Budget', budgetSchema);
module.exports.OVERALL = OVERALL;
