'use strict';

const Expense = require('../models/Expense');
const { CATEGORIES, TRANSACTION_TYPES } = require('../constants/categories');
const { CATEGORY_RULES, SUBSCRIPTION_MERCHANT_HINTS, AMOUNT_HEURISTICS } = require('../constants/categoryRules');

/**
 * Rule-based auto-categorisation.
 *
 * Four layers run in decreasing order of trust:
 *
 *   1. Direction   — a credit is income (or a transfer) and never "spending".
 *   2. Merchant memory — what THIS user previously confirmed for this merchant.
 *      Self-training: every manual correction improves later guesses.
 *   3. Rule engine — weighted merchant/keyword scoring over the knowledge base.
 *   4. Amount heuristics — a conservative last resort before OTHER.
 *
 * Every result carries a confidence and the token it matched on, so the client
 * can show "we think this is Food" rather than pretending to be certain, and
 * so a wrong guess is debuggable after the fact.
 */

/**
 * Tokens that carry no identity: corporate suffixes, payment-rail words, and
 * the per-transaction wrapping banks add ("SWIGGY*ORDER 8837"). Stripping them
 * is what lets every spelling of one merchant collapse onto a single key.
 */
const MERCHANT_NOISE = [
  'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'corp', 'co', 'company', 'india', 'in', 'technologies',
  'services', 'solutions', 'enterprises', 'retail', 'store', 'online', 'payment', 'payments', 'upi', 'pay',
  'order', 'orders', 'txn', 'transaction', 'ref', 'invoice', 'purchase',
];

/** Lowercase, strip punctuation, collapse whitespace. Padded for phrase matching. */
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable join key for a merchant. "SWIGGY*ORDER 8837", "Swiggy India Pvt Ltd"
 * and "swiggy" must all collapse to `swiggy`, otherwise recurrence detection
 * sees three different merchants.
 */
function buildMerchantKey(merchant) {
  const tokens = normalizeText(merchant)
    .split(' ')
    .filter(Boolean)
    // Drop trailing order/reference numbers, keep meaningful ones like "1mg".
    .filter((token) => !/^\d+$/.test(token) || token.length <= 2)
    .filter((token) => !MERCHANT_NOISE.includes(token));

  const key = tokens.join(' ').trim();
  // If stripping removed everything, the noise WAS the name.
  return key || normalizeText(merchant);
}

/** Whole-word / whole-phrase containment. Avoids "ola" matching "chocolate". */
function containsPhrase(haystack, phrase) {
  if (!phrase) return false;
  return ` ${haystack} `.includes(` ${normalizeText(phrase)} `);
}

function buildHaystack({ merchant, note, rawText, tags }) {
  return normalizeText([merchant, note, rawText, Array.isArray(tags) ? tags.join(' ') : ''].filter(Boolean).join(' '));
}

/**
 * Scores every rule against the text.
 *
 * A merchant hit is worth far more than a keyword hit, and longer phrases beat
 * shorter ones so "amazon prime" (Subscriptions) wins over "amazon" (Shopping).
 */
function scoreRules(haystack) {
  const scores = [];

  for (const rule of CATEGORY_RULES) {
    let score = 0;
    let best = null;
    let bestWeight = 0;

    for (const merchant of rule.merchants) {
      if (!containsPhrase(haystack, merchant)) continue;
      const words = merchant.trim().split(/\s+/).length;
      const weight = 10 + words * 4;
      score += weight;
      if (weight > bestWeight) {
        bestWeight = weight;
        best = merchant;
      }
    }

    for (const keyword of rule.keywords) {
      if (!containsPhrase(haystack, keyword)) continue;
      const words = keyword.trim().split(/\s+/).length;
      const weight = 3 + words;
      score += weight;
      if (weight > bestWeight) {
        bestWeight = weight;
        best = keyword;
      }
    }

    if (score > 0) scores.push({ category: rule.category, score, matchedOn: best });
  }

  return scores.sort((a, b) => b.score - a.score);
}

/**
 * Maps a raw score into 0-1. A clear winner over a distant runner-up is more
 * trustworthy than a narrow one, so the margin modulates the result.
 */
function toConfidence(top, runnerUp) {
  const saturated = Math.min(top.score / 24, 1);
  const base = 0.55 + saturated * 0.4;
  if (!runnerUp) return Math.round(Math.min(base, 0.97) * 100) / 100;
  const margin = (top.score - runnerUp.score) / top.score;
  return Math.round(Math.min(base * (0.75 + margin * 0.25), 0.97) * 100) / 100;
}

/** Pure, synchronous classification — no database access. Unit-testable. */
function categorizeByRules({ merchant, note, rawText, tags, amount, type = TRANSACTION_TYPES.DEBIT } = {}) {
  const haystack = buildHaystack({ merchant, note, rawText, tags });
  const scores = scoreRules(haystack);
  const top = scores[0];

  if (type === TRANSACTION_TYPES.CREDIT) {
    // Money coming in is income unless it is plainly an internal movement.
    const transferHit = scores.find((s) => s.category === CATEGORIES.TRANSFER);
    if (transferHit && (!top || transferHit.score >= top.score)) {
      return { category: CATEGORIES.TRANSFER, confidence: 0.85, method: 'rule-engine', matchedOn: transferHit.matchedOn };
    }
    const incomeHit = scores.find((s) => s.category === CATEGORIES.INCOME);
    return {
      category: CATEGORIES.INCOME,
      confidence: incomeHit ? 0.95 : 0.75,
      method: 'rule-engine',
      matchedOn: incomeHit ? incomeHit.matchedOn : 'credit transaction',
    };
  }

  if (top) {
    return {
      category: top.category,
      confidence: toConfidence(top, scores[1]),
      method: 'rule-engine',
      matchedOn: top.matchedOn,
    };
  }

  const numericAmount = Number(amount) || 0;
  for (const heuristic of AMOUNT_HEURISTICS) {
    const inRange = numericAmount >= heuristic.min && numericAmount <= heuristic.max;
    const hasHint = heuristic.requireAny.some((hint) => containsPhrase(haystack, hint));
    if (inRange && hasHint) {
      return { category: heuristic.category, confidence: 0.6, method: 'amount-heuristic', matchedOn: `amount ${numericAmount}` };
    }
  }

  return { category: CATEGORIES.OTHER, confidence: 0.2, method: 'fallback', matchedOn: null };
}

/**
 * Full classification, including the per-user merchant memory lookup.
 *
 * Only categories a human actually confirmed are recalled, so one bad
 * auto-guess cannot entrench itself by feeding back into later guesses.
 */
async function categorize(input = {}) {
  const { userId, merchant, note, rawText } = input;
  const merchantKey = buildMerchantKey(merchant || extractMerchantFallback(note || rawText));

  if (userId && merchantKey) {
    const remembered = await Expense.findOne({
      user: userId,
      merchantKey,
      categoryConfirmed: true,
      isDeleted: false,
    })
      .sort({ date: -1 })
      .select('category')
      .lean();

    if (remembered) {
      return {
        category: remembered.category,
        confidence: 0.96,
        method: 'merchant-memory',
        matchedOn: merchantKey,
        merchantKey,
      };
    }
  }

  return { ...categorizeByRules(input), merchantKey };
}

/** When no merchant field was supplied, the first few note words are the best proxy. */
function extractMerchantFallback(text) {
  return normalizeText(text).split(' ').slice(0, 3).join(' ');
}

/** Subscription-shaped merchant (Netflix, Spotify) or explicit renewal wording. */
function looksLikeSubscription({ merchant, note, rawText, paymentMethod } = {}) {
  const haystack = buildHaystack({ merchant, note, rawText });
  if (SUBSCRIPTION_MERCHANT_HINTS.some((hint) => containsPhrase(haystack, hint))) return true;
  if (paymentMethod === 'auto_debit') return true;
  return ['subscription', 'membership', 'auto renew', 'autorenew', 'renewal', 'recurring payment'].some((hint) =>
    containsPhrase(haystack, hint)
  );
}

module.exports = {
  categorize,
  categorizeByRules,
  looksLikeSubscription,
  buildMerchantKey,
  normalizeText,
  containsPhrase,
};
