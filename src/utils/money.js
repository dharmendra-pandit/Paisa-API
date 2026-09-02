'use strict';

/**
 * Amounts are stored as Numbers (rupees, 2 decimals). Every write goes through
 * round2 so floating point noise never accumulates inside aggregates.
 */
function round2(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 0;
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function percent(part, whole, decimals = 1) {
  if (!whole) return 0;
  const factor = 10 ** decimals;
  return Math.round((part / whole) * 100 * factor) / factor;
}

/** Signed % change from previous to current; null when there is no base. */
function percentChange(current, previous, decimals = 1) {
  if (!previous) return null;
  const factor = 10 ** decimals;
  return Math.round(((current - previous) / Math.abs(previous)) * 100 * factor) / factor;
}

function formatCurrency(amount, currency = 'INR', locale = 'en-IN') {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount || 0);
  } catch (err) {
    return currency + ' ' + round2(amount);
  }
}

function mean(values) {
  if (!values.length) return 0;
  return round2(values.reduce((a, b) => a + b, 0) / values.length);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round2((sorted[mid - 1] + sorted[mid]) / 2);
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / (values.length - 1);
  return round2(Math.sqrt(variance));
}

module.exports = { round2, percent, percentChange, formatCurrency, mean, median, stdDev };
