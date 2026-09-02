'use strict';

const mongoose = require('mongoose');
const {
  CATEGORY_LIST,
  TRANSACTION_TYPE_LIST,
  TRANSACTION_TYPES,
  EXPENSE_SOURCE_LIST,
  EXPENSE_SOURCES,
  PAYMENT_METHODS,
} = require('../constants/categories');
const { round2 } = require('../utils/money');

const { Schema } = mongoose;

const expenseSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    amount: {
      type: Number,
      required: [true, 'Amount is required'],
      min: [0.01, 'Amount must be greater than zero'],
      set: round2,
    },
    currency: { type: String, default: 'INR', uppercase: true, maxlength: 3 },
    type: { type: String, enum: TRANSACTION_TYPE_LIST, default: TRANSACTION_TYPES.DEBIT, index: true },

    category: { type: String, enum: CATEGORY_LIST, required: true, index: true },
    /**
     * True once a human picks the category. The auto-categoriser never
     * overwrites a manual choice, and these rows are the training signal for
     * the merchant-memory layer.
     */
    categoryConfirmed: { type: Boolean, default: false },
    categorization: {
      method: { type: String, enum: ['manual', 'merchant-memory', 'rule-engine', 'amount-heuristic', 'fallback'], default: 'manual' },
      confidence: { type: Number, min: 0, max: 1, default: 1 },
      matchedOn: { type: String },
    },

    note: { type: String, trim: true, maxlength: 500, default: '' },
    merchant: { type: String, trim: true, maxlength: 120, default: '' },
    /** Lowercased, punctuation-stripped merchant — the join key for recurrence detection. */
    merchantKey: { type: String, trim: true, maxlength: 120, default: '', index: true },

    date: { type: Date, required: true, default: () => new Date(), index: true },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, default: 'other' },
    tags: [{ type: String, trim: true, lowercase: true, maxlength: 30 }],

    source: { type: String, enum: EXPENSE_SOURCE_LIST, default: EXPENSE_SOURCES.MANUAL, index: true },
    sms: {
      raw: { type: String, maxlength: 1000 },
      sender: { type: String, maxlength: 40 },
      bank: { type: String, maxlength: 60 },
      accountLast4: { type: String, maxlength: 6 },
      referenceId: { type: String, maxlength: 40 },
      /** SHA-256 of the normalised body; the unique index below kills replays. */
      fingerprint: { type: String, maxlength: 64 },
    },

    isSubscription: { type: Boolean, default: false, index: true },
    subscription: { type: Schema.Types.ObjectId, ref: 'Subscription', default: null },

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

// Every list/analytics query is "this user, this window, newest first".
expenseSchema.index({ user: 1, date: -1 });
expenseSchema.index({ user: 1, isDeleted: 1, date: -1 });
expenseSchema.index({ user: 1, category: 1, date: -1 });
expenseSchema.index({ user: 1, merchantKey: 1, date: -1 });
// Partial + sparse: only SMS-sourced rows carry a fingerprint, and only they
// need the uniqueness guarantee.
expenseSchema.index(
  { user: 1, 'sms.fingerprint': 1 },
  { unique: true, partialFilterExpression: { 'sms.fingerprint': { $type: 'string' } } }
);
expenseSchema.index({ note: 'text', merchant: 'text' });

expenseSchema.virtual('isCredit').get(function isCredit() {
  return this.type === TRANSACTION_TYPES.CREDIT;
});

/** Soft delete keeps history intact for trend maths while hiding the row. */
expenseSchema.methods.softDelete = function softDelete() {
  this.isDeleted = true;
  this.deletedAt = new Date();
  return this.save();
};

module.exports = mongoose.model('Expense', expenseSchema);
