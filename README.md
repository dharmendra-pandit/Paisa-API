# Paisa — Personal Finance + Expense AI API

Production-ready backend for a personal finance app: JWT auth, expense tracking with
rule-based auto-categorisation, monthly budgets with threshold warnings, spending
analytics, natural-language insights, bank-SMS parsing, recurring-payment detection,
and Splitwise-style shared expenses with debt simplification.

**Node.js · Express · MongoDB (Mongoose) · JWT · Zod · Swagger · Jest**

---

## Quick start

```bash
# 1. Install
npm install

# 2. Configure (the defaults work against a local MongoDB)
cp .env.example .env
#    then set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET — the process refuses to
#    boot with placeholder values shorter than 16 characters.
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 3. Load six months of realistic sample data (optional but recommended)
npm run seed

# 4. Run
npm run dev          # nodemon
npm start            # plain node
```

| URL | What |
| --- | --- |
| `http://localhost:5000/docs` | Interactive Swagger UI |
| `http://localhost:5000/docs.json` | Raw OpenAPI 3.0 spec |
| `http://localhost:5000/api/v1/health` | Liveness + database readiness |

Seeded demo login: **`demo@paisa.app` / `Paisa@2026`**

### Docker

```bash
docker compose up --build      # API on :5000, MongoDB on :27017
docker compose exec api npm run seed
```

---

## Project structure

```
src/
├── config/
│   ├── env.js                 Zod-validated environment; fails fast on bad config
│   └── db.js                  Mongoose connection lifecycle
├── constants/
│   ├── categories.js          Canonical categories, payment methods, sources
│   ├── categoryRules.js       Merchant/keyword knowledge base for categorisation
│   ├── smsPatterns.js         Regex library for the bank-SMS parser
│   └── split.js               Split types, group roles, settlement methods
├── models/
│   ├── User.js                Password hashing, session generation, preferences
│   ├── Expense.js             Transactions + SMS provenance + soft delete
│   ├── Budget.js              Monthly caps with edge-triggered alert bookkeeping
│   ├── Subscription.js        Detected recurring payments
│   ├── Group.js               Shared-expense groups; linked and placeholder members
│   ├── SplitExpense.js        A shared bill and each member's stake in it
│   ├── Settlement.js          Immutable record of money moving between members
│   └── index.js               Model registry, so scripts see every schema
├── services/                  All business logic — controllers stay thin
│   ├── auth.service.js        Signup, login, refresh, revocation
│   ├── token.service.js       JWT signing/verification
│   ├── categorization.service.js  The auto-categorisation engine
│   ├── expense.service.js     CRUD, filtering, pagination, aggregate summaries
│   ├── budget.service.js      Usage, pace projection, threshold alerts
│   ├── analytics.service.js   Totals, breakdowns, trends, merchant ranking
│   ├── insight.service.js     Natural-language insight generators
│   ├── sms.service.js         SMS → structured transaction → expense
│   ├── subscription.service.js  Recurrence detection and scoring
│   ├── group.service.js       Groups, membership, placeholder claiming
│   ├── split.service.js       Shared-expense lifecycle and share validation
│   ├── balance.service.js     Derived balances, simplification, settlements
│   └── notification.service.js  Delivery seam for budget alerts
├── controllers/               HTTP shape only: parse, delegate, respond
├── routes/                    Routing + inline @openapi documentation
├── validators/                Zod request schemas
├── middlewares/               auth, validate, rate limit, request id, errors
├── docs/swagger.js            OpenAPI definition and UI mounting
├── scripts/
│   └── syncIndexes.js         Explicit index build — a required deploy step
├── seed/                      Sample data generator
├── utils/                     ApiError, response envelope, money, timezone dates
│   └── splitMath.js           Integer-paise allocation and debt simplification
├── app.js                     Express assembly (exported without listening)
└── server.js                  Bootstrap, signals, graceful shutdown
deploy/                        Caddyfile, provisioning, deploy and backup scripts
tests/                         185 tests over an in-memory MongoDB
postman/                       Collection + environment
```

**Request flow:** `route → validate (Zod) → authenticate → controller → service → model`.
Controllers never touch Mongoose; services never touch `req`/`res`. That split is
what makes the business logic directly testable and reusable from the seeder.

---

## API overview

All endpoints are under `/api/v1`. Everything except `/auth/*`, `/health` and `/meta`
requires `Authorization: Bearer <accessToken>`.

### Auth
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/signup` | Create account, receive token pair |
| POST | `/auth/login` | Authenticate |
| POST | `/auth/refresh` | Rotate the token pair |
| GET/PATCH | `/auth/me` | Read / update profile and preferences |
| POST | `/auth/change-password` | Change password, revoke other sessions |
| POST | `/auth/logout` | Sign out of all devices |
| POST | `/auth/deactivate` | Deactivate account |

### Expenses
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/expenses` | Add an expense (auto-categorised when `category` is omitted) |
| GET | `/expenses` | List with filters, pagination and whole-set totals |
| POST | `/expenses/bulk` | Add up to 100 at once |
| POST | `/expenses/categorize` | Preview a category without saving |
| GET | `/expenses/categories` | Categories this account actually uses |
| GET/PATCH/DELETE | `/expenses/:id` | Read / update / delete (soft by default) |
| POST | `/expenses/:id/restore` | Undo a soft delete |

Filters: `month`, `startDate`, `endDate` (inclusive), `category` (CSV), `type`,
`source`, `paymentMethod`, `tags`, `minAmount`, `maxAmount`, `search`,
`isSubscription`, `sortBy`, `sortOrder`, `page`, `limit`.

### Budgets
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/budgets` | Set (upsert) a monthly cap, overall or per category |
| GET | `/budgets` | All caps for a month with live usage and pace |
| GET/DELETE | `/budgets/:id` | Read / delete one |
| POST | `/budgets/rollover` | Carry auto-renewing caps into the next month |
| GET | `/budgets/categories` | Categories available for budgeting |

### Analytics
`/analytics/summary`, `/categories`, `/trends`, `/weekday`, `/merchants`, `/dashboard`

### Insights
`/insights`, `/insights/summary`, `/insights/types`

### SMS
`/sms/parse`, `/sms/parse-batch`

### Subscriptions
`/subscriptions/detect`, `/subscriptions`, `/subscriptions/upcoming`,
`/subscriptions/:id/review`

### Groups — shared expenses
| Method | Path | Purpose |
|---|---|---|
| POST | `/groups/create` | Create a group (alias: `POST /groups`) |
| GET | `/groups` | Your groups, each with your net position |
| GET | `/groups/:id` | Members, balances and recent expenses in one call |
| PATCH | `/groups/:id` | Rename, re-icon, archive, toggle simplification |
| DELETE | `/groups/:id` | Delete — refused while the group has expenses |
| POST | `/groups/add-member` | Add a member (alias: `POST /groups/:id/members`) |
| DELETE | `/groups/:id/members/:memberId` | Remove — refused while they owe money |
| PATCH | `/groups/:id/members/:memberId` | Promote or demote an admin |
| POST | `/groups/:id/expenses` | Add a shared expense |
| GET | `/groups/:id/expenses` | The group ledger, annotated with your share |
| PATCH | `/groups/:id/expenses/:expenseId` | Edit — recomputes every share |
| DELETE | `/groups/:id/expenses/:expenseId` | Soft delete |
| GET | `/groups/:id/balances` | Who owes whom, before and after simplification |
| POST | `/groups/:id/settle` | Record a payment (alias: `POST /groups/settle`) |
| GET | `/groups/:id/settlements` | Settlement history |
| DELETE | `/groups/:id/settlements/:settlementId` | Reverse a mistaken settlement |
| GET | `/groups/search-users` | Find accounts by email prefix |
| GET | `/groups/meta` | Icons, split types, settlement methods |

---

## How the interesting parts work

### Auto-categorisation

Four layers, in decreasing order of trust:

1. **Direction** — a credit is income (or a transfer), never spending.
2. **Merchant memory** — what *this user* previously confirmed for this merchant.
   Every manual correction improves later guesses, so the engine adapts per account.
3. **Rule engine** — weighted scoring over a merchant/keyword knowledge base.
   A merchant hit outweighs a keyword hit, and longer phrases beat shorter ones, so
   `amazon prime` resolves to Subscriptions while `amazon` resolves to Shopping.
4. **Amount heuristics** — a deliberately conservative last resort before `OTHER`.

Every result reports its `method`, a `confidence` and the token it `matchedOn`, so the
client can say "we think this is Food" instead of pretending to be certain, and a bad
guess is debuggable afterwards.

```jsonc
// POST /expenses  { "amount": 480, "merchant": "Swiggy", "note": "Dinner order" }
"categorization": { "method": "rule-engine", "confidence": 0.85, "matchedOn": "swiggy" }
```

### Budget warnings

Usage is computed live from expenses rather than from a running counter, so an edited
or deleted expense can never leave a stale total behind. The overall cap excludes
transfers, investments and income — moving money between your own pockets is not
consumption.

Alerts are **edge-triggered**: `lastAlert.level` is persisted, so you are warned once
when you cross 80% and again if you exceed 100%, not on every subsequent purchase.
Alerts ride along on the write that caused them:

```jsonc
// POST /expenses response
"budgetAlerts": [{
  "level": "warning", "category": "FOOD", "budget": 8000, "spent": 6480,
  "percentage": 81,
  "message": "Heads up — you have used 81% of your Food & Dining budget for 2026-08…"
}]
```

Each budget also reports a `pace` block: daily burn rate, projected month-end spend,
and the safe daily amount for the remaining days.

### AI insights

Independent generators share one pre-fetched data bundle, so a full report costs a
fixed handful of queries rather than one per rule. Two rules keep the output honest:
every insight states the numbers behind it, and nothing is emitted below a minimum
sample size — "your food spend tripled" off two data points is noise dressed up as
analysis.

Real output from the seeded demo account:

```
[CRITICAL] Your overall budget for 2026-08 is exhausted: ₹72,926 against ₹45,000.
[WARNING]  Your spending increased by 23.2% this month — ₹72,926 versus ₹59,180 in 2026-07.
[INFO]     You spend more on food & dining on weekends — about ₹1,835 per weekend day
           versus ₹320 on weekdays, 474% higher.
[INFO]     You have spent ₹28,093 on food & dining this month, 56% above your usual
           ₹17,994 monthly average.
[WARNING]  We detected 9 recurring payments totalling about ₹35,402 per month.
[POSITIVE] You kept ₹87,074 of the ₹1,70,000 you received this month — a 51.2% savings rate.
```

Generators: `budget_pace`, `spending_trend`, `category_spike`, `month_projection`,
`subscription_burden`, `weekend_pattern`, `savings_rate`, `category_concentration`,
`unusual_transaction`, `small_spend_leak`, `peak_day`, `onboarding`.

### SMS parsing

Conservative by design — it would rather return `isTransaction: false` than invent an
expense, because a phantom row silently poisons every budget and trend downstream.

- OTPs, promotions and "bill due" reminders are recognised and skipped (`status: ignored`
  with HTTP 200 — that is the parser working, not an error).
- Amount, direction, merchant, bank, masked account, reference and transaction date are
  extracted separately, and confidence rises with each corroborating field.
- Direction comes from the *earliest* matching keyword, so
  `"debited … towards CREDIT CARD payment"` is correctly a debit.
- A SHA-256 fingerprint of the normalised body, plus a partial unique index, makes
  re-posting the same message return `status: duplicate` instead of double-counting —
  and that holds under concurrent submits, because the index is the real guard.

```jsonc
// "Rs.499.00 debited from A/c XX4521 on 28-08-26 to NETFLIX via UPI. Ref 429183746512."
{ "amount": 499, "type": "debit", "merchant": "NETFLIX", "bank": "HDFC Bank",
  "accountLast4": "4521", "referenceId": "429183746512", "paymentMethod": "upi",
  "confidence": 0.95 }
```

### Subscription detection

A subscription is a merchant you pay on a **rhythm**, for a **stable amount**. Both
halves matter: a daily coffee shop is regular but its amounts wander, while a one-off
₹499 purchase is stable but has no rhythm.

Charges are grouped by a normalised merchant key (`SWIGGY*ORDER 8837`,
`Swiggy India Pvt Ltd` and `swiggy` all collapse to `swiggy`), then scored on gap
regularity, amount stability, number of observations and merchant recognition. Only
groups above a confidence floor are committed, and a user's confirm/dismiss verdict is
never overwritten by a later run.

---

### Shared expenses and split maths

Four split types are supported: `equal`, `exact` (rupee amounts), `percentage`
and `shares` (relative weights). Whatever a client sends is treated as *intent* —
validated for plausibility, then re-derived server-side.

The reason is that splitting money in floating point loses money. `100 / 3` is
33.33 three times over, which is ₹99.99 — a paisa short of the bill. Round the
other way and the group owes ₹100.02 for a ₹100 dinner. Over hundreds of expenses
those fractions accumulate into balances that never reach zero, and a user who
settles up in full is still shown owing four paise.

So `utils/splitMath.js` converts to integer paise, allocates with the
largest-remainder method — each share gets the floor of its exact value, and the
leftover paise go one each to the largest discarded fractions — and converts
back. `₹100` between three people comes out as `33.34 / 33.33 / 33.33`, which
adds up. A 20,000-case fuzz test in the suite asserts the shares always sum to
the bill exactly.

Placeholder members make the feature usable before everyone has installed the
app: add someone by email and their balances accrue against a seat in the group.
When they later sign up with that address, `claimPlaceholders` links the account
to the existing member row, so their whole history transfers with no migration.

### Balances are derived, never stored

There is no `balance` column anywhere in this codebase. A stored balance is a
cache of a sum, and every edit, delete, member removal and settlement is a chance
for it to drift from the ledger it summarises — after which there is no way to
tell which number is lying.

Every balance is recomputed on read from the two sources of truth:

```
net = paid out − consumed + settlements paid − settlements received
```

Positive means the group owes you. The sum across a group is always exactly zero,
and `balance.service.js` asserts that invariant on every computation, logging
loudly if it is ever violated — a non-zero total means money was invented or
destroyed and nothing downstream can be trusted.

Partial settlement falls out of this for free: paying ₹200 of a ₹300 debt is
simply a ₹200 ledger entry, and the next read reports ₹100 outstanding. No
`isSettled` flag to get out of step.

### Debt simplification

A group of four people can easily accumulate a dozen small mutual debts. The
balances endpoint returns both the literal pairwise ledger and a simplified plan:
repeatedly settle the largest debtor against the largest creditor, which zeroes
at least one person per pass and needs at most n−1 transfers.

That turns *"Aarav owes Bhavna ₹600, Bhavna owes Chirag ₹600"* into a single
*"Aarav pays Chirag ₹600"*. Bhavna is spared two transfers she nets nothing from.

This is the greedy heuristic, not a provable minimum — finding the true minimum
is NP-hard, being subset-sum in disguise. It is optimal whenever no subgroup
happens to balance internally, near-optimal when one does, and always correct:
every net position still lands on zero.

Both views are returned because they answer different questions. Simplified tells
you the fewest transfers that clear the group; detailed tells you *why* you owe
it, and is what settles the argument when someone disputes a number.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `5000` | |
| `API_PREFIX` | `/api/v1` | |
| `CORS_ORIGINS` | `*` | Comma-separated origins |
| `MONGODB_URI` | — | **Required** |
| `MONGODB_URI_TEST` | — | Used when `NODE_ENV=test` |
| `JWT_ACCESS_SECRET` | — | **Required**, min 16 chars |
| `JWT_REFRESH_SECRET` | — | **Required**, min 16 chars, must differ |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | |
| `JWT_REFRESH_EXPIRES_IN` | `30d` | |
| `BCRYPT_SALT_ROUNDS` | `12` | Forced to 4 under test for speed |
| `APP_TIMEZONE` | `Asia/Kolkata` | Default for new users |
| `DEFAULT_CURRENCY` | `INR` | |
| `BUDGET_ALERT_THRESHOLD` | `0.8` | Default warning point |
| `SUBSCRIPTION_MIN_OCCURRENCES` | `3` | Charges needed before committing |
| `SUBSCRIPTION_LOOKBACK_DAYS` | `210` | Detection window |
| `SUBSCRIPTION_AMOUNT_TOLERANCE` | `0.15` | Allowed price drift |
| `RATE_LIMIT_MAX` | `300` | Per window, per user/IP |
| `AUTH_RATE_LIMIT_MAX` | `20` | Tighter budget for credential endpoints |
| `SWAGGER_ENABLED` | `true` | |

`src/config/env.js` validates all of this with Zod at import time and throws on bad
input, so a mis-configured process never boots and then fails mysteriously later.

---

## Testing

```bash
npm test
```

185 tests across 8 suites, run against an in-memory MongoDB — no local database
required, and no developer data touched.

```
PASS tests/auth.test.js            PASS tests/analytics.test.js
PASS tests/expense.test.js         PASS tests/insights.test.js
PASS tests/budget.test.js          PASS tests/categorization.test.js
PASS tests/sms.test.js             PASS tests/subscription.test.js

Tests: 153 passed, 153 total
```

Coverage includes the cases that actually matter: cross-user data isolation on every
resource, the 80% alert firing exactly once, SMS de-duplication, promotional-message
rejection, merchant-memory learning (and *not* leaking between accounts), inverted
date ranges, and insight generators staying silent on thin data.

---

## Design notes

**Timezone-correct money.** Every calendar bucket resolves in the user's own timezone
via `Intl.DateTimeFormat`, not UTC. An 11:40pm Sunday dinner in IST reports as Sunday —
which is exactly what the weekend-spending insight depends on being right.

**Errors.** One handler normalises the whole error zoo — Mongoose validation and cast
errors, duplicate-key 11000s, JWT expiry, Zod issues, malformed JSON — into a single
contract. Operational errors (`ApiError`) carry a safe message; anything else is logged
in full and returned as an opaque 500. Every response carries an `X-Request-Id` that
also appears in the logs and error body.

**Response envelope.** Success is `{ success, message, data, meta? }`; failure is
`{ success: false, message, error: { code, details? } }`. Validation failures list the
offending fields.

**Soft deletes.** Expenses are soft-deleted by default so historical trends stay honest
after a user tidies up their list.

**Security.** bcrypt at cost 12; `select: false` on the hash; identical responses for
unknown-email and wrong-password (with a decoy bcrypt compare so the timing matches
too); helmet, CORS allowlist, `express-mongo-sanitize`, `hpp`, per-user rate limiting;
access/refresh tokens signed with *different* secrets and carrying a `type` claim, so a
refresh token can never be replayed as an access token.

**Session revocation.** Tokens carry a `tv` (token version) claim compared against the
user record. A counter rather than a timestamp on purpose: JWT `iat` has one-second
resolution, so a time-based stamp cannot reliably distinguish a token minted just
before a revocation from one minted just after it — logging out and immediately
refreshing would have slipped through.

**Indexes.** Compound indexes on every real access path (`user + date`,
`user + category + date`, `user + merchantKey + date`), a unique
`user + month + category` on budgets, and a partial unique index on the SMS fingerprint
so only SMS-sourced rows carry the de-duplication constraint.

---

## Deployment

Production deployment to a self-managed VPS is documented in
**[DEPLOYMENT.md](./DEPLOYMENT.md)** — Docker Compose running the API, MongoDB
and Caddy, with automatic Let's Encrypt certificates for your domain.

```bash
bash deploy/provision.sh    # once: docker, firewall, fail2ban, swap, deploy user
cp .env.production.example .env.production && nano .env.production
bash deploy/deploy.sh       # build, sync indexes, roll the containers
```

Two things about the production setup are worth knowing even if you never read
the full guide:

**MongoDB publishes no ports.** The development `docker-compose.yml` binds
`27017:27017` with no authentication, which is fine on a laptop and catastrophic
on a public IP — unauthenticated MongoDB is found by automated scanners within
hours. `docker-compose.prod.yml` keeps the database on an internal network, with
authentication, behind a least-privilege application user that is not root.

**Indexes are an explicit deploy step.** Production runs with Mongoose's
`autoIndex` disabled, because letting a booting web process build indexes blocks
startup and makes replicas race each other. That means the unique constraints on
account email, SMS replay fingerprints, budget keys and subscription keys exist
*only* because `npm run indexes:sync` runs — `deploy.sh` does it before the new
API serves traffic. Skip it on a fresh database and duplicate accounts become
possible.

---

## Postman

Import both files from `postman/`:

- `Paisa.postman_collection.json` — 56 requests across 8 folders
- `Paisa.postman_environment.json` — `baseUrl` and token variables

Run **Auth → Login** first; the test script captures the tokens automatically, so every
other request is authenticated with no copy-pasting. The collection includes negative
cases too (wrong password, promotional SMS, OTP) and assertions on the response
envelope, so it doubles as a smoke test.

Suggested order: `Auth → Expenses → Budgets → SMS → Subscriptions/Detect → Analytics →
Insights`. Run `npm run seed` first — analytics and insights need history before they
have anything interesting to say.

---

## License

MIT
