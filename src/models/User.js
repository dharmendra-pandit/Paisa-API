'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../config/env');

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: 2,
      maxlength: 80,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Please provide a valid email address'],
    },
    // select:false keeps the hash out of every incidental query and response.
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 8,
      select: false,
    },
    /**
     * Profile picture URL. Split groups render a member list, so every user
     * needs a stable visual identity; clients fall back to initials when empty.
     */
    avatar: { type: String, trim: true, maxlength: 500, default: '' },

    currency: { type: String, default: config.currency, uppercase: true, maxlength: 3 },
    timezone: { type: String, default: config.timezone },
    monthlyIncome: { type: Number, default: 0, min: 0 },

    preferences: {
      budgetAlertThreshold: {
        type: Number,
        default: config.budgetAlertThreshold,
        min: 0.1,
        max: 1,
      },
      alertsEnabled: { type: Boolean, default: true },
      autoCategorize: { type: Boolean, default: true },
    },

    /**
     * Session generation. Every token embeds the version current at issue, and
     * a mismatch is rejected — which is how "log out everywhere" and a password
     * change revoke live sessions without a token blacklist table.
     *
     * A counter rather than a timestamp on purpose: JWT `iat` has one-second
     * resolution, so a time-based stamp cannot distinguish a token minted just
     * before a revocation from one minted just after it.
     */
    tokenVersion: { type: Number, default: 0, min: 0 },

    lastLoginAt: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete ret.password;
        delete ret.__v;
        delete ret.tokenVersion;
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
  }
);

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, config.bcryptRounds);
  // A password change must not leave older sessions alive.
  if (!this.isNew) this.tokenVersion += 1;
  return next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

/**
 * True when the token belongs to a superseded session generation. Tokens issued
 * before this build (with no `tv` claim) are treated as generation 0.
 */
userSchema.methods.isTokenRevoked = function isTokenRevoked(decoded) {
  return (decoded.tv || 0) !== this.tokenVersion;
};

/** Bumps the generation, invalidating every token already in the wild. */
userSchema.methods.revokeSessions = function revokeSessions() {
  this.tokenVersion += 1;
  return this.tokenVersion;
};

module.exports = mongoose.model('User', userSchema);
