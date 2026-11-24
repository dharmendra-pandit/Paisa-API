'use strict';

/**
 * Corrects expenses that an older SMS parser recorded wrongly.
 *
 *     npm run sms:repair
 *
 * Two parser bugs were fixed together:
 *   - amounts over 999 written without commas lost their last digits
 *     ("Rs.1500" was saved as 150, "INR 85000" as 850);
 *   - payee names were missed for UPI handles, ICICI's "…; SWIGGY credited",
 *     Axis's "UPI/P2M/…/SWIGGY", and incoming credits, where "credited to
 *     your A/c" produced a transaction titled "your".
 *
 * Re-importing cannot fix these, because the server rightly refuses to record
 * the same message twice. This re-reads each SMS-sourced expense from the
 * message it was made from, and changes a field only when it still holds
 * exactly what the OLD parser would have produced — so an amount, name or
 * category the user corrected by hand is never overwritten.
 *
 * Idempotent: once a row is corrected it no longer matches the old parser's
 * output, so a second run changes nothing. deploy.sh runs it on every deploy.
 */

const mongoose = require('mongoose');
const logger = require('../utils/logger');
const { round2 } = require('../utils/money');
const { connectDB, disconnectDB } = require('../config/db');
const { TRANSACTION_TYPES } = require('../constants/categories');

require('../models');
const Expense = require('../models/Expense');
const { parseSms } = require('../services/sms.service');
const categorizationService = require('../services/categorization.service');

// --- The old parser's behaviour, kept only to recognise its output ---------

const LEGACY_NUMBER = '([0-9]{1,3}(?:,[0-9]{2,3})*(?:\\.[0-9]{1,2})?|[0-9]+(?:\\.[0-9]{1,2})?)';
const LEGACY_AMOUNT = [
  new RegExp(`\\b(?:debited|credited)\\s+(?:by|for|with)\\s+(?:(?:rs|inr|₹)\\.?\\s*)?${LEGACY_NUMBER}`, 'i'),
  new RegExp(`(?:rs|inr|₹)\\.?\\s*${LEGACY_NUMBER}`, 'i'),
  new RegExp(`${LEGACY_NUMBER}\\s*(?:rs|inr|rupees)\\b`, 'i'),
];
const LEGACY_MERCHANT = [
  /(?:at|to)\s+([A-Za-z0-9][A-Za-z0-9&'._\- ]{2,40}?)\s+(?:on|via|using|dated|ref|upi|for|txn|a\/c)\b/i,
  /(?:vpa|to vpa)\s+([A-Za-z0-9._-]{3,40})@[A-Za-z]{2,20}/i,
  /(?:info|desc|narration|remarks?)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9&'._\- ]{2,40})/i,
  /\btrf\s+to\s+([A-Za-z0-9][A-Za-z0-9&'._\- ]{2,40}?)(?:\s+ref|\s+on|[.;]|$)/i,
  /(?:at|to)\s+([A-Za-z0-9][A-Za-z0-9&'._\- ]{2,40}?)(?:[.;]|$)/i,
];
const LEGACY_TAIL = /\b(?:on|via|using|ref|txn|dated|for|upi|a\/c|info|avl|bal)\b.*$/i;

function firstMatch(patterns, text) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match;
  }
  return null;
}

function legacyAmount(text) {
  const match = firstMatch(LEGACY_AMOUNT, text);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? round2(value) : null;
}

function legacyMerchant(text) {
  const match = firstMatch(LEGACY_MERCHANT, text);
  if (!match) return null;
  const merchant = match[1].replace(LEGACY_TAIL, '').replace(/[.,;:_-]+$/, '').replace(/\s+/g, ' ').trim();
  if (merchant.length < 3 || /^\d+$/.test(merchant)) return null;
  return merchant;
}

/** What ingestion stores as the title and note for a parsed message. */
function displayFields(merchant, bank, type) {
  return {
    merchant: merchant || bank || 'Unknown',
    note: merchant ? `${type === TRANSACTION_TYPES.DEBIT ? 'Paid to' : 'Received from'} ${merchant}` : 'Imported from SMS',
  };
}

// ---------------------------------------------------------------------------

async function repairOne(doc) {
  const raw = doc.sms && doc.sms.raw;
  if (!raw) return null;

  const fresh = parseSms(raw, { sender: doc.sms.sender || undefined });
  if (!fresh.isTransaction) return null;

  const changes = {};

  const oldAmount = legacyAmount(raw);
  if (oldAmount !== null && doc.amount === oldAmount && fresh.amount !== oldAmount) {
    changes.amount = fresh.amount;
  }

  const before = displayFields(legacyMerchant(raw), fresh.bank, doc.type);
  const after = displayFields(fresh.merchant, fresh.bank, doc.type);
  if (doc.merchant === before.merchant && after.merchant !== before.merchant) {
    changes.merchant = after.merchant;
    if (doc.note === before.note) changes.note = after.note;
  }

  if (!Object.keys(changes).length) return null;

  // A new name can mean a new category ("your" said nothing; "SWIGGY" says
  // food) — but only where the category was the classifier's guess.
  if (changes.merchant !== undefined && !doc.categoryConfirmed) {
    const result = await categorizationService.categorize({
      userId: doc.user,
      merchant: changes.merchant,
      note: changes.note ?? doc.note,
      rawText: raw,
      amount: changes.amount ?? doc.amount,
      type: doc.type,
    });
    changes.category = result.category;
    changes.categorization = { method: result.method, confidence: result.confidence, matchedOn: result.matchedOn };
    changes.merchantKey = result.merchantKey;
  } else if (changes.merchant !== undefined) {
    changes.merchantKey = categorizationService.buildMerchantKey(changes.merchant);
  }

  await Expense.updateOne({ _id: doc._id }, { $set: changes });
  return changes;
}

async function repairSmsExpenses() {
  await connectDB();

  const cursor = Expense.find({ source: 'sms', 'sms.raw': { $exists: true } }).lean().cursor();
  let checked = 0;
  let amounts = 0;
  let names = 0;

  for await (const doc of cursor) {
    checked += 1;
    try {
      const changes = await repairOne(doc);
      if (changes && changes.amount !== undefined) amounts += 1;
      if (changes && changes.merchant !== undefined) names += 1;
    } catch (err) {
      logger.error('Could not repair SMS expense', { id: String(doc._id), message: err.message });
    }
  }

  process.stdout.write(
    `   SMS expenses checked: ${checked}, amounts corrected: ${amounts}, names corrected: ${names}\n`
  );
  await disconnectDB();
}

if (require.main === module) {
  repairSmsExpenses().catch(async (err) => {
    logger.error('SMS repair failed', { message: err.message });
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { repairOne, repairSmsExpenses, legacyAmount, legacyMerchant };
