'use strict';

/**
 * Pattern library for the bank-SMS parser.
 *
 * Indian bank/wallet alerts are near-templated but every issuer words them
 * slightly differently, so the parser runs a battery of small, well-understood
 * regexes rather than one unreadable mega-pattern. Each group below is ordered
 * from most specific to most generic; the parser takes the first hit.
 */

/**
 * One amount: "1,24,500.75", "1500.00", "499", "250.0".
 *
 * The comma form must contain at least one comma. With the commas optional, a
 * plain "1500" was taken by that branch as "150" — three digits, no comma,
 * nothing after — and the alternation never reached the plain-digits branch,
 * so every amount over 999 written without separators lost its last digits.
 */
const NUMBER = String.raw`([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)(?![0-9])`;

/**
 * Amounts, most specific first.
 *
 * The verb-anchored form leads because it names the transaction amount itself.
 * SBI's UPI alerts ("A/C X1234 debited by 250.0 on date 23Nov25") carry no
 * currency marker at all, and alerts that do often mention a second figure —
 * "Avl Bal Rs 5,000" — that a bare currency match would happily take instead.
 */
const AMOUNT_PATTERNS = Object.freeze([
  new RegExp(String.raw`\b(?:debited|credited)\s+(?:by|for|with)\s+(?:(?:rs|inr|₹)\.?\s*)?` + NUMBER, 'i'),
  new RegExp(String.raw`(?:rs|inr|₹)\.?\s*` + NUMBER, 'i'),
  new RegExp(NUMBER + String.raw`\s*(?:rs|inr|rupees)\b`, 'i'),
]);

/** Words that mark money leaving the account. */
const DEBIT_KEYWORDS = Object.freeze([
  'debited', 'debit', 'spent', 'paid', 'withdrawn', 'purchase', 'deducted', 'charged', 'sent', 'transferred to',
  'payment of', 'txn of', 'has been used', 'auto-debited', 'autodebited', 'emi', 'billed',
]);

/** Words that mark money arriving. */
const CREDIT_KEYWORDS = Object.freeze([
  'credited', 'credit', 'received', 'deposited', 'refund', 'refunded', 'cashback', 'salary', 'reversed',
  'added to', 'has been credited',
]);

/**
 * Merchant extraction. The capture group is the merchant.
 * Terminators keep the match from swallowing the rest of the sentence.
 */
const MERCHANT_PATTERNS = Object.freeze([
  /(?:at|to)\s+([A-Za-z0-9][A-Za-z0-9&'._\- ]{2,40}?)\s+(?:on|via|using|dated|ref|upi|for|txn|a\/c)\b/i,
  // A UPI handle: "to swiggy@icici", "to VPA swiggy@ybl" — the part before @.
  /\b(?:to|vpa)\s+(?:vpa\s+)?([A-Za-z0-9._-]{3,40})@[A-Za-z][A-Za-z0-9.-]{1,20}/i,
  // ICICI names the payee as the account that was credited: "…; SWIGGY credited."
  /;\s*([A-Za-z0-9][A-Za-z0-9&'._\- ]{2,40}?)\s+credited\b/i,
  // Axis and others write the UPI narration: "UPI/P2M/512345678901/SWIGGY".
  /\bUPI\/(?:P2[AM]\/|DR\/|CR\/)?\d{6,}\/([A-Za-z0-9][A-Za-z0-9&'._\- ]{2,40}?)(?:\/|\s+(?:not|ref|on|call|sms)\b|[.;]|$)/i,
  /(?:info|desc|narration|remarks?)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9&'._\- ]{2,40})/i,
  /\btrf\s+to\s+([A-Za-z0-9][A-Za-z0-9&'._\- ]{2,40}?)(?:\s+ref|\s+on|[.;]|$)/i,
  /(?:at|to)\s+([A-Za-z0-9][A-Za-z0-9&'._\- ]{2,40}?)(?:[.;]|$)/i,
]);

/**
 * Who sent the money, for an incoming credit. Tried before MERCHANT_PATTERNS
 * on credits, whose "to" names the user's own account ("credited to your
 * A/c"), not the other party.
 */
const CREDIT_MERCHANT_PATTERNS = Object.freeze([
  /\bfrom\s+(?:vpa\s+)?([A-Za-z0-9._-]{3,40})@[A-Za-z][A-Za-z0-9.-]{1,20}/i,
  /\bfrom\s+([A-Za-z][A-Za-z0-9&'._\- ]{2,40}?)(?:\s+(?:on|via|ref|upi|a\/c|info|imps|neft|rtgs|txn)\b|[.;(]|$)/i,
]);

/**
 * Captures that are the user's own account or a filler word, never a payee —
 * "credited to your A/c" once produced a transaction titled "your".
 */
const MERCHANT_STOPWORDS = /^(?:your|you|ur|self|a\/c|ac|acct|account|card|bank|the|beneficiary|linked)\b/i;

/** Masked account / card identifiers: "A/c XX1234", "card ending 5678". */
const ACCOUNT_PATTERNS = Object.freeze([
  /(?:a\/c|acct|account)\s*(?:no\.?)?\s*(?:x+|\*+)?\s*(\d{3,6})\b/i,
  /(?:card|cc|debit card|credit card)\s*(?:no\.?)?\s*(?:ending(?:\s+with)?|xx+|\*+)\s*(\d{3,6})\b/i,
  /\b(?:xx|\*{2,})(\d{3,6})\b/i,
]);

/** Bank/issuer reference number, useful for de-duplicating replayed SMS. */
const REFERENCE_PATTERNS = Object.freeze([
  /(?:ref(?:erence)?(?:\s*(?:no|id|num))?|txn(?:\s*(?:id|no))?|utr|rrn)\s*[:.#-]?\s*([A-Za-z0-9]{6,25})\b/i,
]);

/** Transaction date inside the message body: "on 12-08-25", "on 12 Aug 2025". */
const DATE_PATTERNS = Object.freeze([
  /\bon\s+(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/i,
  /\bon\s+(\d{1,2}[-\s][A-Za-z]{3,9}[-\s]\d{2,4})\b/i,
  /\b(\d{4}-\d{2}-\d{2})\b/,
]);

/** Payment rail hints, mapped onto Expense.paymentMethod. */
const PAYMENT_METHOD_HINTS = Object.freeze([
  { method: 'upi', patterns: [/\bupi\b/i, /\bvpa\b/i, /@(?:okaxis|oksbi|okhdfcbank|okicici|ybl|paytm|apl|ibl)\b/i] },
  { method: 'credit_card', patterns: [/\bcredit card\b/i, /\bcc\s*x+\d/i] },
  { method: 'debit_card', patterns: [/\bdebit card\b/i, /\batm\b/i] },
  { method: 'net_banking', patterns: [/\bneft\b/i, /\bimps\b/i, /\brtgs\b/i, /\bnet\s*banking\b/i] },
  { method: 'auto_debit', patterns: [/\bauto\s*-?\s*debit(?:ed)?\b/i, /\be-?mandate\b/i, /\bsi\s+debit\b/i, /\bnach\b/i] },
  { method: 'wallet', patterns: [/\bwallet\b/i, /\bpaytm balance\b/i] },
]);

/**
 * Messages that mention money but are not transactions. Filtering these out
 * matters more than any single extraction rule — a promotional SMS turned into
 * an expense silently corrupts every downstream analytic.
 */
const NON_TRANSACTION_PATTERNS = Object.freeze([
  /\b(?:will be|is) (?:debited|charged)\b/i,
  /\b(?:offer|sale|discount|cashback offer|coupon|flat \d+% off|apply now|pre[\s-]?approved)\b/i,
  /\b(?:loan|credit limit) (?:offer|eligib)/i,
  /\bdue (?:on|date)\b.*\bpay\b/i,
  /\bbalance (?:enquiry|is|as on)\b/i,
  /\breminder\b/i,
]);

/**
 * One-time-password messages. These alone are not enough to skip a message:
 * plenty of real debit alerts end with "Never share your OTP/PIN", and treating
 * that safety footer as an OTP threw the whole alert away. A message is an OTP
 * only when it mentions one *and* reports no money that has already moved.
 */
const OTP_PATTERNS = Object.freeze([
  /\b(?:otp|one[\s-]?time[\s-]?password|verification code)\b/i,
  /\bdo not share\b/i,
]);

/** Past-tense verbs that only appear once money has actually moved. */
const COMPLETED_TRANSACTION_PATTERN =
  /\b(?:debited|credited|spent|withdrawn|sent|received|paid|transferred|deducted|refunded)\b/i;

/**
 * Sender IDs look like "VM-HDFCBK" or "AD-ICICIB"; the middle is the bank code.
 *
 * Under TRAI's newer header rules, most banks append a one-letter traffic class
 * — "-S" service, "-T" transactional, "-P" promotional, "-G" government — so
 * the same bank now arrives as "VM-HDFCBK-S". Without the optional suffix the
 * whole header failed to match and the bank name was silently lost.
 */
const SENDER_PATTERN = /^(?:[A-Z]{2}-)?([A-Z]{4,10})(?:-[STPG])?$/i;

const BANK_CODES = Object.freeze({
  HDFCBK: 'HDFC Bank',
  ICICIB: 'ICICI Bank',
  SBIINB: 'State Bank of India',
  SBIPSG: 'State Bank of India',
  AXISBK: 'Axis Bank',
  KOTAKB: 'Kotak Mahindra Bank',
  PNBSMS: 'Punjab National Bank',
  CANBNK: 'Canara Bank',
  IDFCFB: 'IDFC First Bank',
  INDUSB: 'IndusInd Bank',
  YESBNK: 'Yes Bank',
  BOBTXN: 'Bank of Baroda',
  PYTMBK: 'Paytm Payments Bank',
  AMZNIN: 'Amazon Pay',
});

module.exports = {
  AMOUNT_PATTERNS,
  DEBIT_KEYWORDS,
  CREDIT_KEYWORDS,
  MERCHANT_PATTERNS,
  CREDIT_MERCHANT_PATTERNS,
  MERCHANT_STOPWORDS,
  ACCOUNT_PATTERNS,
  REFERENCE_PATTERNS,
  DATE_PATTERNS,
  PAYMENT_METHOD_HINTS,
  NON_TRANSACTION_PATTERNS,
  OTP_PATTERNS,
  COMPLETED_TRANSACTION_PATTERN,
  SENDER_PATTERN,
  BANK_CODES,
};
