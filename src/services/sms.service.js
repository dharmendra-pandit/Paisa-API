'use strict';

const crypto = require('crypto');
const Expense = require('../models/Expense');
const ApiError = require('../utils/ApiError');
const { round2 } = require('../utils/money');
const { TRANSACTION_TYPES, EXPENSE_SOURCES } = require('../constants/categories');
const {
  AMOUNT_PATTERNS,
  DEBIT_KEYWORDS,
  CREDIT_KEYWORDS,
  MERCHANT_PATTERNS,
  ACCOUNT_PATTERNS,
  REFERENCE_PATTERNS,
  DATE_PATTERNS,
  PAYMENT_METHOD_HINTS,
  NON_TRANSACTION_PATTERNS,
  OTP_PATTERNS,
  COMPLETED_TRANSACTION_PATTERN,
  SENDER_PATTERN,
  BANK_CODES,
} = require('../constants/smsPatterns');
const categorizationService = require('./categorization.service');
const expenseService = require('./expense.service');

/**
 * Bank-SMS → structured transaction.
 *
 * The parser is deliberately conservative: it would rather return
 * `isTransaction: false` than invent an expense, because a phantom row silently
 * poisons every budget, trend and insight downstream. Each extraction step
 * records what it matched so a bad parse is diagnosable from the response
 * alone.
 */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Collapses whitespace but preserves case — merchant names need it. */
function tidy(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function firstMatch(patterns, text) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match;
  }
  return null;
}

function parseAmount(text) {
  const match = firstMatch(AMOUNT_PATTERNS, text);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? round2(value) : null;
}

/**
 * Direction is decided by whichever keyword family appears *earliest*, because
 * templates lead with the operative verb ("debited ... towards credit card")
 * and a naive count would flip on the trailing noun.
 */
function parseType(lower) {
  const earliest = (keywords) =>
    keywords.reduce((best, keyword) => {
      const index = lower.indexOf(keyword);
      return index !== -1 && index < best ? index : best;
    }, Infinity);

  const debitAt = earliest(DEBIT_KEYWORDS);
  const creditAt = earliest(CREDIT_KEYWORDS);

  if (debitAt === Infinity && creditAt === Infinity) return { type: null, matchedOn: null };
  if (creditAt < debitAt) return { type: TRANSACTION_TYPES.CREDIT, matchedOn: CREDIT_KEYWORDS.find((k) => lower.indexOf(k) === creditAt) };
  return { type: TRANSACTION_TYPES.DEBIT, matchedOn: DEBIT_KEYWORDS.find((k) => lower.indexOf(k) === debitAt) };
}

/** Trailing connectives survive greedy captures; strip them so keys stay stable. */
const MERCHANT_TAIL = /\b(?:on|via|using|ref|txn|dated|for|upi|a\/c|info|avl|bal)\b.*$/i;

function parseMerchant(text) {
  const match = firstMatch(MERCHANT_PATTERNS, text);
  if (!match) return null;
  const merchant = tidy(match[1].replace(MERCHANT_TAIL, '').replace(/[.,;:_-]+$/, ''));
  if (merchant.length < 3 || /^\d+$/.test(merchant)) return null;
  return merchant;
}

function parseDate(text, fallback) {
  const match = firstMatch(DATE_PATTERNS, text);
  if (!match) return { date: fallback, matchedOn: null };

  const raw = match[1];

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return { date: new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3])), matchedOn: raw };

  const numeric = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(raw);
  if (numeric) {
    // Indian bank SMS is DD-MM-YY; two-digit years are this century.
    const year = numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
    const parsed = new Date(Date.UTC(year, Number(numeric[2]) - 1, Number(numeric[1])));
    if (!Number.isNaN(parsed.getTime())) return { date: parsed, matchedOn: raw };
  }

  const worded = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})$/.exec(raw);
  if (worded) {
    const month = MONTHS[worded[2].slice(0, 3).toLowerCase()];
    const year = worded[3].length === 2 ? 2000 + Number(worded[3]) : Number(worded[3]);
    if (month) {
      const parsed = new Date(Date.UTC(year, month - 1, Number(worded[1])));
      if (!Number.isNaN(parsed.getTime())) return { date: parsed, matchedOn: raw };
    }
  }

  return { date: fallback, matchedOn: null };
}

function parsePaymentMethod(text) {
  for (const hint of PAYMENT_METHOD_HINTS) {
    if (hint.patterns.some((pattern) => pattern.test(text))) return hint.method;
  }
  return 'other';
}

function parseBank(sender, text) {
  const senderMatch = SENDER_PATTERN.exec(tidy(sender).toUpperCase());
  if (senderMatch && BANK_CODES[senderMatch[1]]) return BANK_CODES[senderMatch[1]];

  const inline = /\b(hdfc|icici|sbi|axis|kotak|pnb|canara|idfc|indusind|yes bank|bob|paytm)\b/i.exec(text);
  if (inline) return tidy(inline[1]).toUpperCase();
  return null;
}

/** `YYYY-MM-DD` of an instant as seen in [timezone]; null for an unknown zone. */
function calendarDay(instant, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch (_err) {
    return null;
  }
}

/** Stable identity for a message, so the same alert cannot be ingested twice. */
function fingerprint(text) {
  return crypto.createHash('sha256').update(String(text).toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
}

/**
 * Pure parse — no database, no user. Returns everything it could extract plus
 * a confidence score and the reasons behind it.
 */
function parseSms(rawMessage, { sender, receivedAt, timezone } = {}) {
  const message = tidy(rawMessage);
  if (!message) throw ApiError.badRequest('SMS message text is required');

  const lower = message.toLowerCase();
  const reasons = [];

  const otp = COMPLETED_TRANSACTION_PATTERN.test(message)
    ? null
    : OTP_PATTERNS.find((pattern) => pattern.test(message));
  const promotional = otp || NON_TRANSACTION_PATTERNS.find((pattern) => pattern.test(message));
  if (promotional) {
    return {
      isTransaction: false,
      reason: 'Message looks informational or promotional, not a completed transaction',
      matchedOn: String(promotional),
      confidence: 0,
      raw: message,
    };
  }

  const amount = parseAmount(message);
  if (!amount) {
    return { isTransaction: false, reason: 'No currency amount found in the message', confidence: 0, raw: message };
  }
  reasons.push(`amount ${amount}`);

  const { type, matchedOn: typeMatch } = parseType(lower);
  if (!type) {
    return {
      isTransaction: false,
      reason: 'Could not determine whether the money was debited or credited',
      confidence: 0.2,
      raw: message,
      partial: { amount },
    };
  }
  reasons.push(`direction "${typeMatch}"`);

  const merchant = parseMerchant(message);
  if (merchant) reasons.push(`merchant "${merchant}"`);

  const accountMatch = firstMatch(ACCOUNT_PATTERNS, message);
  const referenceMatch = firstMatch(REFERENCE_PATTERNS, message);
  const received = receivedAt ? new Date(receivedAt) : null;
  const validReceived = received && !Number.isNaN(received.getTime()) ? received : null;
  let { date, matchedOn: dateMatch } = parseDate(message, validReceived || new Date());
  if (dateMatch) reasons.push(`date "${dateMatch}"`);

  // A body date is only a calendar day, which parses to midnight UTC — 5:30 AM
  // in India — so every alert of a day would list as having happened at dawn
  // and sort in arbitrary order. When that day is the day the phone received
  // the message, the receive time is the same transaction, told precisely.
  // A statement arriving days later keeps the date its body states.
  if (dateMatch && validReceived && calendarDay(validReceived, timezone) === date.toISOString().slice(0, 10)) {
    date = validReceived;
  }

  const paymentMethod = parsePaymentMethod(message);
  const bank = parseBank(sender, message);

  // Confidence grows with each independently corroborating field.
  let confidence = 0.55;
  if (merchant) confidence += 0.2;
  if (accountMatch) confidence += 0.1;
  if (referenceMatch) confidence += 0.05;
  if (bank) confidence += 0.05;
  if (paymentMethod !== 'other') confidence += 0.05;

  return {
    isTransaction: true,
    amount,
    currency: 'INR',
    type,
    merchant: merchant || null,
    merchantKey: categorizationService.buildMerchantKey(merchant || ''),
    bank,
    accountLast4: accountMatch ? accountMatch[1] : null,
    referenceId: referenceMatch ? referenceMatch[1] : null,
    date,
    paymentMethod,
    confidence: Math.round(Math.min(confidence, 0.98) * 100) / 100,
    reasons,
    fingerprint: fingerprint(message),
    raw: message,
    sender: sender ? tidy(sender) : null,
  };
}

/** Parse + categorise, without persisting. Used by the dry-run preview mode. */
async function previewSms(user, { message, sender, receivedAt }) {
  const parsed = parseSms(message, { sender, receivedAt, timezone: user.timezone });
  if (!parsed.isTransaction) return { parsed, expense: null };

  const category = await categorizationService.categorize({
    userId: user._id,
    merchant: parsed.merchant,
    note: parsed.raw,
    rawText: parsed.raw,
    amount: parsed.amount,
    type: parsed.type,
  });

  const duplicate = await Expense.exists({ user: user._id, 'sms.fingerprint': parsed.fingerprint });

  return {
    parsed,
    duplicate: Boolean(duplicate),
    expense: {
      amount: parsed.amount,
      type: parsed.type,
      category: category.category,
      categoryConfidence: category.confidence,
      categoryMethod: category.method,
      merchant: parsed.merchant,
      date: parsed.date,
      paymentMethod: parsed.paymentMethod,
      isSubscription: categorizationService.looksLikeSubscription({
        merchant: parsed.merchant,
        rawText: parsed.raw,
        paymentMethod: parsed.paymentMethod,
      }),
    },
  };
}

/**
 * Parse and persist. Returns a discriminated result per message so a bulk
 * request can report partial success rather than failing wholesale.
 */
async function ingestSms(user, { message, sender, receivedAt, save = true }) {
  const preview = await previewSms(user, { message, sender, receivedAt });

  if (!preview.parsed.isTransaction) {
    return { status: 'ignored', reason: preview.parsed.reason, parsed: preview.parsed, expense: null };
  }

  if (!save) return { status: 'parsed', parsed: preview.parsed, expense: preview.expense, alerts: [] };

  if (preview.duplicate) {
    const existing = await Expense.findOne({ user: user._id, 'sms.fingerprint': preview.parsed.fingerprint });
    return { status: 'duplicate', reason: 'This SMS has already been recorded', parsed: preview.parsed, expense: existing };
  }

  const { parsed } = preview;

  try {
    const { expense, alerts } = await expenseService.createExpense(user, {
      amount: parsed.amount,
      currency: parsed.currency,
      type: parsed.type,
      merchant: parsed.merchant || parsed.bank || 'Unknown',
      note: parsed.merchant ? `${parsed.type === 'debit' ? 'Paid to' : 'Received from'} ${parsed.merchant}` : 'Imported from SMS',
      rawText: parsed.raw,
      date: parsed.date,
      paymentMethod: parsed.paymentMethod,
      source: EXPENSE_SOURCES.SMS,
      sms: {
        raw: parsed.raw.slice(0, 1000),
        sender: parsed.sender,
        bank: parsed.bank,
        accountLast4: parsed.accountLast4,
        referenceId: parsed.referenceId,
        fingerprint: parsed.fingerprint,
      },
    });

    return { status: 'created', parsed, expense, alerts };
  } catch (err) {
    // The unique index is the real guard against a concurrent double-submit.
    if (err.code === 11000) {
      const existing = await Expense.findOne({ user: user._id, 'sms.fingerprint': parsed.fingerprint });
      return { status: 'duplicate', reason: 'This SMS has already been recorded', parsed, expense: existing };
    }
    throw err;
  }
}

async function ingestBatch(user, messages, { save = true } = {}) {
  const results = [];
  for (const entry of messages) {
    // Sequential on purpose: duplicate detection within one batch depends on
    // earlier writes already being visible.
    results.push(await ingestSms(user, { ...entry, save }));
  }

  const summary = results.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    },
    { created: 0, duplicate: 0, ignored: 0, parsed: 0 }
  );

  return { results, summary, total: results.length };
}

module.exports = { parseSms, previewSms, ingestSms, ingestBatch, fingerprint };
