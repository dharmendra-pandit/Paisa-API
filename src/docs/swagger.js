'use strict';

const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const config = require('../config/env');
const { CATEGORY_LIST, PAYMENT_METHODS } = require('../constants/categories');
const { SPLIT_TYPE_LIST, GROUP_ICONS, GROUP_ROLE_LIST, SETTLEMENT_METHODS } = require('../constants/split');

/**
 * OpenAPI definition.
 *
 * Endpoint documentation lives beside the routes as `@openapi` JSDoc, so a
 * route and its contract are edited together and cannot drift apart. Only the
 * shared pieces — security, envelopes, reusable schemas — are declared here.
 */
const definition = {
  openapi: '3.0.3',
  info: {
    title: 'Paisa API',
    version: '1.0.0',
    description: [
      'Backend for **Paisa**, a personal finance and expense tracking app.',
      '',
      'Features: JWT auth, expense management with rule-based auto-categorisation,',
      'monthly budgets with threshold warnings, spending analytics, natural-language',
      'insights, bank-SMS parsing, recurring-payment detection and Splitwise-style',
      'shared expenses with debt simplification.',
      '',
      '### Authentication',
      'Call `POST /auth/login`, then send `Authorization: Bearer <accessToken>` on',
      'every other request. Access tokens are short-lived; use `POST /auth/refresh`',
      'with the refresh token to get a new pair.',
      '',
      '### Response envelope',
      'Success: `{ success: true, message, data, meta? }`.',
      'Failure: `{ success: false, message, error: { code, details? } }`.',
      '',
      '### Amounts and dates',
      'Amounts are numbers with two decimals in the account currency (INR by default).',
      'Dates are ISO-8601. Calendar bucketing uses the timezone on the user profile,',
      'so a late-night Sunday purchase reports as Sunday, not Monday.',
    ].join('\n'),
    contact: { name: 'Paisa API Support', email: 'support@paisa.app' },
    license: { name: 'MIT' },
  },
  servers: [
    { url: `http://localhost:${config.port}${config.apiPrefix}`, description: 'Local development' },
    { url: `https://api.paisa.app${config.apiPrefix}`, description: 'Production' },
  ],
  tags: [
    { name: 'System', description: 'Health and reference data' },
    { name: 'Auth', description: 'Registration, login and session management' },
    { name: 'Expenses', description: 'Recording, querying and correcting transactions' },
    { name: 'Budgets', description: 'Monthly caps, usage tracking and threshold warnings' },
    { name: 'Analytics', description: 'Totals, category breakdowns and spending trends' },
    { name: 'Insights', description: 'Natural-language findings derived from spending patterns' },
    { name: 'SMS', description: 'Turn raw bank SMS alerts into expenses' },
    { name: 'Subscriptions', description: 'Detection and management of recurring payments' },
    { name: 'Groups', description: 'Splitwise-style shared expenses, balances and settlements' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '66cf0a2b8f1e4d3a9b7c1e20' },
          name: { type: 'string', example: 'Aarav Sharma' },
          email: { type: 'string', format: 'email', example: 'aarav@example.com' },
          currency: { type: 'string', example: 'INR' },
          timezone: { type: 'string', example: 'Asia/Kolkata' },
          monthlyIncome: { type: 'number', example: 85000 },
          preferences: {
            type: 'object',
            properties: {
              budgetAlertThreshold: { type: 'number', example: 0.8 },
              alertsEnabled: { type: 'boolean', example: true },
              autoCategorize: { type: 'boolean', example: true },
            },
          },
        },
      },
      AuthResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Logged in successfully' },
          data: {
            type: 'object',
            properties: {
              user: { $ref: '#/components/schemas/User' },
              accessToken: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
              refreshToken: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
              tokenType: { type: 'string', example: 'Bearer' },
              expiresIn: { type: 'integer', example: 900, description: 'Access token lifetime in seconds' },
            },
          },
        },
      },
      ExpenseInput: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount: { type: 'number', example: 480 },
          category: {
            type: 'string',
            enum: CATEGORY_LIST,
            description: 'Omit to trigger auto-categorisation. Supplying it marks the row user-confirmed.',
          },
          type: { type: 'string', enum: ['debit', 'credit'], default: 'debit' },
          currency: { type: 'string', example: 'INR' },
          note: { type: 'string', example: 'Dinner order' },
          merchant: { type: 'string', example: 'Swiggy' },
          date: { type: 'string', format: 'date-time', example: '2026-08-29T20:15:00.000Z' },
          paymentMethod: { type: 'string', enum: PAYMENT_METHODS, example: 'upi' },
          tags: { type: 'array', items: { type: 'string' }, example: ['weekend', 'friends'] },
          isSubscription: { type: 'boolean' },
        },
      },
      Expense: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          amount: { type: 'number', example: 480 },
          currency: { type: 'string', example: 'INR' },
          type: { type: 'string', enum: ['debit', 'credit'] },
          category: { type: 'string', enum: CATEGORY_LIST },
          categoryConfirmed: { type: 'boolean', example: false },
          categorization: {
            type: 'object',
            properties: {
              method: { type: 'string', enum: ['manual', 'merchant-memory', 'rule-engine', 'amount-heuristic', 'fallback'] },
              confidence: { type: 'number', example: 0.93 },
              matchedOn: { type: 'string', example: 'swiggy' },
            },
          },
          note: { type: 'string' },
          merchant: { type: 'string' },
          merchantKey: { type: 'string', example: 'swiggy' },
          date: { type: 'string', format: 'date-time' },
          paymentMethod: { type: 'string', enum: PAYMENT_METHODS },
          tags: { type: 'array', items: { type: 'string' } },
          source: { type: 'string', enum: ['manual', 'sms', 'import', 'recurring'] },
          isSubscription: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      BudgetAlert: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['warning', 'exceeded'] },
          month: { type: 'string', example: '2026-08' },
          category: { type: 'string', example: 'FOOD' },
          budget: { type: 'number', example: 8000 },
          spent: { type: 'number', example: 6480 },
          percentage: { type: 'number', example: 81 },
          message: { type: 'string', example: 'Heads up — you have used 81% of your Food & Dining budget for 2026-08: ₹6,480 of ₹8,000.' },
        },
      },
      ExpenseResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Expense recorded' },
          data: {
            type: 'object',
            properties: {
              expense: { $ref: '#/components/schemas/Expense' },
              budgetAlerts: { type: 'array', items: { $ref: '#/components/schemas/BudgetAlert' } },
            },
          },
        },
      },
      BudgetStatus: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          month: { type: 'string', example: '2026-08' },
          category: { type: 'string', example: 'OVERALL' },
          budget: { type: 'number', example: 40000 },
          spent: { type: 'number', example: 32400 },
          remaining: { type: 'number', example: 7600 },
          percentageUsed: { type: 'number', example: 81 },
          alertThreshold: { type: 'integer', example: 80 },
          status: { type: 'string', enum: ['safe', 'on-track-to-exceed', 'warning', 'exceeded'] },
          isWarning: { type: 'boolean', example: true },
          isExceeded: { type: 'boolean', example: false },
          pace: {
            type: 'object',
            properties: {
              dayOfMonth: { type: 'integer', example: 29 },
              daysRemaining: { type: 'integer', example: 2 },
              dailyBurnRate: { type: 'number', example: 1117.24 },
              projectedSpend: { type: 'number', example: 34634.5 },
              safeDailySpend: { type: 'number', example: 3800 },
              onTrack: { type: 'boolean', example: true },
            },
          },
          message: { type: 'string' },
        },
      },
      BudgetStatusResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: {
            type: 'object',
            properties: { budget: { $ref: '#/components/schemas/BudgetStatus' } },
          },
        },
      },
      MemberInput: {
        type: 'object',
        description:
          'One person to add to a group. Supply a userId for a known account, an email (linked if that account exists, otherwise held as a claimable placeholder), or just a name.',
        properties: {
          userId: { type: 'string', example: '66cf0a2b8f1e4d3a9b7c1e20' },
          email: { type: 'string', format: 'email', example: 'priya@example.com' },
          name: { type: 'string', example: 'Priya' },
          role: { type: 'string', enum: GROUP_ROLE_LIST, default: 'member' },
        },
      },
      GroupInput: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', example: 'Goa Trip 2026' },
          icon: { type: 'string', enum: GROUP_ICONS, example: 'trip' },
          currency: { type: 'string', example: 'INR' },
          members: { type: 'array', items: { $ref: '#/components/schemas/MemberInput' } },
          simplifyDebts: {
            type: 'boolean',
            default: true,
            description: 'Report balances as the minimal set of transfers that clears the group.',
          },
        },
      },
      SplitParticipant: {
        type: 'object',
        required: ['member'],
        properties: {
          member: { type: 'string', description: 'Group member id, not a user id', example: '66cf0a2b8f1e4d3a9b7c1e33' },
          share: {
            type: 'number',
            description:
              'Meaning depends on splitType: an exact rupee amount, a percentage, or a relative weight. Ignored for an equal split.',
            example: 40,
          },
        },
      },
      SplitExpenseInput: {
        type: 'object',
        required: ['description', 'amount'],
        properties: {
          description: { type: 'string', example: 'Beach shack dinner' },
          amount: { type: 'number', example: 3600 },
          paidBy: { type: 'string', description: 'Group member id. Defaults to you.' },
          splitType: { type: 'string', enum: SPLIT_TYPE_LIST, default: 'equal' },
          participants: {
            type: 'array',
            items: { $ref: '#/components/schemas/SplitParticipant' },
            description: 'Omit on an equal split to include every active member.',
          },
          category: { type: 'string', enum: CATEGORY_LIST, example: 'FOOD' },
          date: { type: 'string', format: 'date-time' },
          note: { type: 'string' },
          addToPersonalExpenses: {
            type: 'boolean',
            description: 'Mirror your own share into your personal ledger, so solo analytics stay accurate.',
          },
        },
      },
      SettlementInput: {
        type: 'object',
        required: ['from', 'to', 'amount'],
        properties: {
          from: { type: 'string', description: 'Group member id of the payer' },
          to: { type: 'string', description: 'Group member id of the recipient' },
          amount: { type: 'number', example: 1200, description: 'Partial payments are simply a smaller amount.' },
          method: { type: 'string', enum: SETTLEMENT_METHODS, default: 'upi' },
          date: { type: 'string', format: 'date-time' },
          note: { type: 'string' },
        },
      },
      MemberBalance: {
        type: 'object',
        properties: {
          member: { type: 'string' },
          name: { type: 'string', example: 'Aarav' },
          avatar: { type: 'string' },
          totalPaid: { type: 'number', example: 5400 },
          totalShare: { type: 'number', example: 3600 },
          net: { type: 'number', example: 1800, description: 'Positive: the group owes them. Negative: they owe the group.' },
          status: { type: 'string', enum: ['owed', 'owes', 'settled'] },
        },
      },
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string', example: 'Validation failed' },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'VALIDATION_ERROR' },
              details: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    field: { type: 'string', example: 'body.amount' },
                    message: { type: 'string', example: 'Amount must be greater than zero' },
                  },
                },
              },
            },
          },
          requestId: { type: 'string', example: '5f0d1e3c-7a2b-4c8e-9f10-2a3b4c5d6e7f' },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: 'Missing, expired or invalid access token',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Forbidden: {
        description: 'Authenticated but not permitted',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'Resource does not exist or does not belong to this user',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Conflict: {
        description: 'Resource already exists',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      ValidationError: {
        description: 'Request failed schema validation',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      RateLimited: {
        description: 'Too many requests',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
  // Applied to every operation unless a route overrides it with `security: []`.
  security: [{ bearerAuth: [] }],
};

// glob patterns are POSIX-only: a Windows path.join() produces backslashes,
// which match nothing and silently yield a spec with zero paths.
const routeGlob = path.join(__dirname, '..', 'routes', '*.js').replace(/\\/g, '/');

const spec = swaggerJsdoc({ definition, apis: [routeGlob] });

const uiOptions = {
  explorer: true,
  customSiteTitle: 'Paisa API Documentation',
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    docExpansion: 'list',
    filter: true,
    tagsSorter: 'alpha',
  },
};

/** Mounts /docs (interactive) and /docs.json (raw spec) when enabled. */
function mountSwagger(app, basePath = '/docs') {
  if (!config.swaggerEnabled) return;

  app.get(`${basePath}.json`, (_req, res) => res.json(spec));
  app.use(basePath, swaggerUi.serve, swaggerUi.setup(spec, uiOptions));
}

module.exports = { spec, mountSwagger };
