'use strict';

const { z } = require('zod');

/**
 * Password policy: length is the dominant factor in resistance to offline
 * cracking, so the floor is 8 with a mixed-content requirement rather than a
 * thicket of rules users work around with "Password1!".
 */
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((value) => /[a-zA-Z]/.test(value) && /\d/.test(value), {
    message: 'Password must contain at least one letter and one number',
  });

const email = z.string().trim().toLowerCase().email('Please provide a valid email address').max(160);

const signup = {
  body: z.object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
    email,
    password,
    currency: z.string().trim().length(3).toUpperCase().optional(),
    timezone: z.string().trim().max(60).optional(),
    monthlyIncome: z.coerce.number().min(0).optional(),
  }),
};

const login = {
  body: z.object({
    email,
    password: z.string().min(1, 'Password is required'),
  }),
};

const refresh = {
  body: z.object({
    refreshToken: z.string().min(10, 'A refresh token is required'),
  }),
};

const changePassword = {
  body: z.object({
    currentPassword: z.string().min(1, 'Your current password is required'),
    newPassword: password,
  }),
};

const updateProfile = {
  body: z
    .object({
      name: z.string().trim().min(2).max(80).optional(),
      currency: z.string().trim().length(3).toUpperCase().optional(),
      timezone: z.string().trim().max(60).optional(),
      monthlyIncome: z.coerce.number().min(0).optional(),
      preferences: z
        .object({
          budgetAlertThreshold: z.coerce.number().min(0.1).max(1).optional(),
          alertsEnabled: z.boolean().optional(),
          autoCategorize: z.boolean().optional(),
        })
        .optional(),
    })
    .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' }),
};

module.exports = { signup, login, refresh, changePassword, updateProfile };
