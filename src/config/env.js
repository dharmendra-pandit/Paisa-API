'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const bool = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

/**
 * Like bool(), but preserves "unset" as undefined so the caller can pick a
 * default that depends on NODE_ENV rather than baking one into the schema.
 */
const tribool = () =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const num = (def, min) => {
  let schema = z.coerce.number();
  if (typeof min === 'number') schema = schema.min(min);
  return schema.default(def);
};

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: num(5000, 0),
  API_PREFIX: z.string().default('/api/v1'),
  CORS_ORIGINS: z.string().default('*'),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_URI_TEST: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  BCRYPT_SALT_ROUNDS: num(12, 4),

  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  DEFAULT_CURRENCY: z.string().default('INR'),
  BUDGET_ALERT_THRESHOLD: num(0.8, 0.1),

  SUBSCRIPTION_MIN_OCCURRENCES: num(3, 2),
  SUBSCRIPTION_LOOKBACK_DAYS: num(210, 30),
  SUBSCRIPTION_AMOUNT_TOLERANCE: num(0.15, 0),

  RATE_LIMIT_WINDOW_MS: num(15 * 60 * 1000, 1000),
  RATE_LIMIT_MAX: num(300, 1),
  AUTH_RATE_LIMIT_MAX: num(20, 1),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  SWAGGER_ENABLED: tribool(),

  // Deliberately provider-neutral names. The model vendor is an implementation
  // detail of ai.service.js, and swapping it should not mean renaming config
  // across every environment file and deploy script.
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  AI_MODEL: z.string().default('deepseek-chat'),
  AI_TIMEOUT_MS: num(30000, 1000),
  AI_MAX_OUTPUT_TOKENS: num(800, 64),
  AI_RATE_LIMIT_MAX: num(30, 1),
  // Set only for a reasoning ("thinking") model. Its presence switches the
  // request to the parameters such models accept; see requestBody().
  // An empty `AI_REASONING_EFFORT=` line, as the example file ships, means
  // unset rather than an invalid value that stops the server booting.
  AI_REASONING_EFFORT: z.preprocess(
    (value) => (value === '' ? undefined : value),
    // 'none' is the newer models' lowest setting; older ones call it 'minimal'.
    z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional()
  ),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Fail fast: a mis-configured process should never boot in production.
  throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill in the values.`);
}

const raw = parsed.data;
const isTest = raw.NODE_ENV === 'test';

const config = Object.freeze({
  env: raw.NODE_ENV,
  isProd: raw.NODE_ENV === 'production',
  isTest,
  port: raw.PORT,
  apiPrefix: raw.API_PREFIX,
  corsOrigins: raw.CORS_ORIGINS === '*' ? '*' : raw.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),

  mongoUri: isTest ? raw.MONGODB_URI_TEST || raw.MONGODB_URI : raw.MONGODB_URI,

  jwt: Object.freeze({
    accessSecret: raw.JWT_ACCESS_SECRET,
    refreshSecret: raw.JWT_REFRESH_SECRET,
    accessExpiresIn: raw.JWT_ACCESS_EXPIRES_IN,
    refreshExpiresIn: raw.JWT_REFRESH_EXPIRES_IN,
    issuer: 'paisa-api',
    audience: 'paisa-app',
  }),
  bcryptRounds: isTest ? 4 : raw.BCRYPT_SALT_ROUNDS,

  timezone: raw.APP_TIMEZONE,
  currency: raw.DEFAULT_CURRENCY,
  budgetAlertThreshold: raw.BUDGET_ALERT_THRESHOLD,

  subscription: Object.freeze({
    minOccurrences: raw.SUBSCRIPTION_MIN_OCCURRENCES,
    lookbackDays: raw.SUBSCRIPTION_LOOKBACK_DAYS,
    amountTolerance: raw.SUBSCRIPTION_AMOUNT_TOLERANCE,
  }),

  rateLimit: Object.freeze({
    windowMs: raw.RATE_LIMIT_WINDOW_MS,
    max: raw.RATE_LIMIT_MAX,
    authMax: raw.AUTH_RATE_LIMIT_MAX,
    aiMax: raw.AI_RATE_LIMIT_MAX,
  }),

  // The assistant is optional infrastructure: without a key the endpoints
  // answer 503 rather than the process refusing to boot. A missing AI key
  // should never take down expense tracking.
  ai: Object.freeze({
    enabled: Boolean(raw.AI_API_KEY),
    apiKey: raw.AI_API_KEY,
    baseUrl: raw.AI_BASE_URL.replace(/\/+$/, ''),
    model: raw.AI_MODEL,
    timeoutMs: raw.AI_TIMEOUT_MS,
    maxOutputTokens: raw.AI_MAX_OUTPUT_TOKENS,
    reasoningEffort: raw.AI_REASONING_EFFORT || null,
  }),

  logLevel: isTest ? 'error' : raw.LOG_LEVEL,
  // Interactive API docs enumerate every endpoint and schema. That is a gift
  // during development and an attack-surface map on a public domain, so
  // production must opt in explicitly rather than opt out.
  swaggerEnabled: raw.SWAGGER_ENABLED ?? raw.NODE_ENV !== 'production',
});

module.exports = config;
