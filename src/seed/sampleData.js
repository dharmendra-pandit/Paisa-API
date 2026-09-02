'use strict';

const { CATEGORIES } = require('../constants/categories');

/**
 * Fixtures for the seeder and the test suite.
 *
 * The catalogue is shaped to exercise every feature end to end: fixed monthly
 * charges become detectable subscriptions, food merchants carry a deliberate
 * weekend bias so the weekend-pattern insight has something real to find, and
 * the SMS samples cover the debit/credit/promotional/OTP cases the parser must
 * separate.
 */

const USERS = Object.freeze([
  {
    name: 'Aarav Sharma',
    email: 'demo@paisa.app',
    password: 'Paisa@2026',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    monthlyIncome: 85000,
  },
  {
    name: 'Diya Menon',
    email: 'diya@paisa.app',
    password: 'Paisa@2026',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    monthlyIncome: 62000,
  },
]);

/** Charges on a fixed monthly rhythm — the subscription detector's targets. */
const RECURRING = Object.freeze([
  { merchant: 'Netflix', amount: 499, dayOfMonth: 28, category: CATEGORIES.SUBSCRIPTIONS, paymentMethod: 'auto_debit', note: 'Netflix monthly plan' },
  { merchant: 'Spotify', amount: 119, dayOfMonth: 5, category: CATEGORIES.SUBSCRIPTIONS, paymentMethod: 'auto_debit', note: 'Spotify Premium' },
  { merchant: 'Google One', amount: 130, dayOfMonth: 12, category: CATEGORIES.SUBSCRIPTIONS, paymentMethod: 'auto_debit', note: 'Google One 100GB' },
  { merchant: 'Cult Fit', amount: 1499, dayOfMonth: 8, category: CATEGORIES.HEALTH, paymentMethod: 'credit_card', note: 'Gym membership' },
  { merchant: 'Airtel', amount: 799, dayOfMonth: 15, category: CATEGORIES.BILLS_UTILITIES, paymentMethod: 'upi', note: 'Broadband bill' },
  { merchant: 'Landlord', amount: 18000, dayOfMonth: 2, category: CATEGORIES.RENT, paymentMethod: 'net_banking', note: 'House rent' },
]);

/** Irregular monthly bills — present every month, but the amount moves. */
const VARIABLE_BILLS = Object.freeze([
  { merchant: 'Tata Power', dayOfMonth: 18, min: 900, max: 2400, category: CATEGORIES.BILLS_UTILITIES, paymentMethod: 'upi', note: 'Electricity bill' },
  { merchant: 'Indian Oil', dayOfMonth: 22, min: 1500, max: 3000, category: CATEGORIES.FUEL, paymentMethod: 'credit_card', note: 'Petrol' },
]);

/** Weekday and weekend food merchants — weekend baskets are deliberately larger. */
const FOOD_MERCHANTS = Object.freeze([
  { merchant: 'Swiggy', weekday: [180, 420], weekend: [650, 1400], note: 'Food delivery' },
  { merchant: 'Zomato', weekday: [200, 450], weekend: [700, 1500], note: 'Food delivery' },
  { merchant: 'Third Wave Coffee', weekday: [180, 320], weekend: [400, 700], note: 'Coffee' },
  { merchant: 'Barbeque Nation', weekday: [0, 0], weekend: [1600, 2800], note: 'Dinner out' },
]);

const GROCERY_MERCHANTS = Object.freeze([
  { merchant: 'BigBasket', range: [900, 2600], note: 'Weekly groceries' },
  { merchant: 'Blinkit', range: [180, 700], note: 'Quick groceries' },
  { merchant: 'Licious', range: [400, 1100], note: 'Meat and seafood' },
]);

const TRANSPORT_MERCHANTS = Object.freeze([
  { merchant: 'Uber', range: [120, 480], note: 'Cab to office' },
  { merchant: 'Ola', range: [110, 420], note: 'Cab ride' },
  { merchant: 'Rapido', range: [45, 160], note: 'Bike taxi' },
  { merchant: 'Delhi Metro', range: [30, 90], note: 'Metro recharge' },
]);

const DISCRETIONARY = Object.freeze([
  { merchant: 'Amazon', range: [400, 4500], category: CATEGORIES.SHOPPING, note: 'Online order' },
  { merchant: 'Myntra', range: [800, 3500], category: CATEGORIES.SHOPPING, note: 'Clothing' },
  { merchant: 'BookMyShow', range: [300, 1200], category: CATEGORIES.ENTERTAINMENT, note: 'Movie tickets' },
  { merchant: 'Apollo Pharmacy', range: [150, 900], category: CATEGORIES.HEALTH, note: 'Medicines' },
  { merchant: 'Decathlon', range: [700, 3000], category: CATEGORIES.SHOPPING, note: 'Sports gear' },
]);

const INVESTMENTS = Object.freeze([
  { merchant: 'Groww', amount: 10000, dayOfMonth: 3, category: CATEGORIES.INVESTMENTS, paymentMethod: 'auto_debit', note: 'Monthly SIP' },
]);

const INCOME = Object.freeze([
  { merchant: 'Acme Corp Payroll', dayOfMonth: 1, category: CATEGORIES.INCOME, paymentMethod: 'net_banking', note: 'Monthly salary' },
]);

/**
 * Representative bank SMS bodies.
 * `expect` records what a correct parse must produce, so the test suite and the
 * seeder agree on ground truth.
 */
const SAMPLE_SMS = Object.freeze([
  {
    sender: 'VM-HDFCBK',
    message: 'Rs.499.00 debited from A/c XX4521 on 28-08-26 to NETFLIX via UPI. Ref 429183746512. Not you? Call 18002586161. -HDFC Bank',
    expect: { isTransaction: true, amount: 499, type: 'debit', merchant: 'NETFLIX', accountLast4: '4521', paymentMethod: 'upi' },
  },
  {
    sender: 'VM-HDFCBK',
    message: 'INR 85,000.00 credited to A/c XX4521 on 01-08-26 towards SALARY AUG 2026. Ref 8812340091. -HDFC Bank',
    expect: { isTransaction: true, amount: 85000, type: 'credit' },
  },
  {
    sender: 'AX-ICICIB',
    message: 'Rs 1,240.50 spent on ICICI Bank Credit Card XX8890 at SWIGGY on 24-08-26. Avl Lmt Rs 78,759.50.',
    expect: { isTransaction: true, amount: 1240.5, type: 'debit', merchant: 'SWIGGY', paymentMethod: 'credit_card' },
  },
  {
    sender: 'JD-SBIINB',
    message: 'Dear Customer, Rs.2,350.00 has been debited from A/c XX7712 on 19-08-26 to BIGBASKET. Ref no 987654321012. -SBI',
    expect: { isTransaction: true, amount: 2350, type: 'debit', merchant: 'BIGBASKET' },
  },
  {
    sender: 'VK-AXISBK',
    message: 'Rs.320 debited from A/c XX1188 on 21-08-26 trf to UBER INDIA SYSTEMS Ref 774411220033. -Axis Bank',
    expect: { isTransaction: true, amount: 320, type: 'debit' },
  },
  {
    sender: 'AD-SWIGGY',
    message: 'Flat 50% OFF on your next order! Use coupon SAVE50 and get cashback up to Rs.150. Order now on Swiggy.',
    expect: { isTransaction: false },
  },
  {
    sender: 'VM-HDFCBK',
    message: '729103 is your OTP for a transaction of Rs.4,999 on HDFC Bank Card XX4521. Do not share this OTP with anyone.',
    expect: { isTransaction: false },
  },
  {
    sender: 'AD-ICICIB',
    message: 'Your credit card bill of Rs.14,320 is due on 05-09-26. Pay now to avoid late fees.',
    expect: { isTransaction: false },
  },
]);

/** Budgets created for the current month by the seeder. */
const BUDGETS = Object.freeze([
  { category: 'OVERALL', amount: 45000, alertThreshold: 0.8, note: 'Overall monthly cap' },
  { category: CATEGORIES.FOOD, amount: 8000, alertThreshold: 0.8, note: 'Eating out and delivery' },
  { category: CATEGORIES.GROCERIES, amount: 7000, alertThreshold: 0.85 },
  { category: CATEGORIES.TRANSPORT, amount: 4000, alertThreshold: 0.75 },
  { category: CATEGORIES.SHOPPING, amount: 6000, alertThreshold: 0.8 },
  { category: CATEGORIES.ENTERTAINMENT, amount: 2500, alertThreshold: 0.8 },
]);

/**
 * A shared-expense group spanning both demo accounts plus two placeholder
 * members, so the seeded database exercises every split type, a partial
 * settlement, and the debt-simplification path.
 *
 * Members are referenced by the keys below rather than by id, because ids are
 * only known once the group is saved.
 */
const SPLIT_GROUP = Object.freeze({
  name: 'Goa Trip 2026',
  icon: 'trip',
  // 'owner' is the first demo user; 'friend' is the second. The rest are
  // placeholders — people invited by email who have not signed up yet.
  placeholders: Object.freeze([
    { key: 'rohan', name: 'Rohan Iyer', email: 'rohan@example.com' },
    { key: 'meera', name: 'Meera Nair', email: 'meera@example.com' },
  ]),
  expenses: Object.freeze([
    {
      description: 'Beach villa — 3 nights',
      amount: 24000,
      category: 'TRAVEL',
      paidBy: 'owner',
      splitType: 'equal',
      daysAgo: 12,
    },
    {
      description: 'Flights to Goa',
      amount: 32800,
      category: 'TRAVEL',
      paidBy: 'friend',
      splitType: 'equal',
      daysAgo: 20,
    },
    {
      description: 'Scooter rental',
      amount: 3200,
      category: 'TRANSPORT',
      paidBy: 'rohan',
      // Only three of the four rode; an equal split would be wrong.
      splitType: 'shares',
      shares: { owner: 1, friend: 1, rohan: 1, meera: 0 },
      daysAgo: 10,
    },
    {
      description: 'Seafood dinner at Martins',
      amount: 8450,
      category: 'FOOD',
      paidBy: 'owner',
      splitType: 'exact',
      exact: { owner: 2400, friend: 1850, rohan: 2600, meera: 1600 },
      daysAgo: 9,
    },
    {
      description: 'Groceries and drinks',
      amount: 4600,
      category: 'GROCERIES',
      paidBy: 'meera',
      splitType: 'equal',
      daysAgo: 8,
    },
    {
      description: 'Water sports',
      amount: 6000,
      category: 'ENTERTAINMENT',
      paidBy: 'friend',
      splitType: 'percentage',
      percentage: { owner: 30, friend: 30, rohan: 25, meera: 15 },
      daysAgo: 7,
    },
  ]),
  /** One partial repayment, so balances are mid-settlement rather than clean. */
  settlements: Object.freeze([
    { from: 'rohan', to: 'owner', amount: 5000, method: 'upi', daysAgo: 3, note: 'Part payment for the villa' },
  ]),
});

module.exports = {
  USERS,
  RECURRING,
  VARIABLE_BILLS,
  FOOD_MERCHANTS,
  GROCERY_MERCHANTS,
  TRANSPORT_MERCHANTS,
  DISCRETIONARY,
  INVESTMENTS,
  INCOME,
  SAMPLE_SMS,
  BUDGETS,
  SPLIT_GROUP,
};
