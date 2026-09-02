'use strict';

const config = require('../config/env');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TZ = config.timezone;

/**
 * Timezone-aware date helpers.
 *
 * Money is bucketed by the user local calendar (a 11:40pm Sunday dinner in IST
 * must not land on Monday), so every helper below resolves wall-clock parts in
 * an IANA timezone and returns real UTC instants.
 */

const formatterCache = new Map();

function getFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      })
    );
  }
  return formatterCache.get(timeZone);
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function toDate(value) {
  if (value instanceof Date) return value;
  const d = new Date(value === undefined || value === null ? Date.now() : value);
  if (Number.isNaN(d.getTime())) throw new TypeError('Invalid date: ' + String(value));
  return d;
}

/** Wall-clock parts of an instant inside a timezone. */
function zonedParts(date, timeZone) {
  const tz = timeZone || DEFAULT_TZ;
  const parts = getFormatter(tz)
    .formatToParts(toDate(date))
    .reduce(function (acc, p) {
      acc[p.type] = p.value;
      return acc;
    }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

/** Minutes the timezone is ahead of UTC at the given instant (DST aware). */
function offsetMinutes(date, timeZone) {
  const d = toDate(date);
  const p = zonedParts(d, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUTC - d.getTime()) / 60000);
}

/** Converts a wall-clock time in timeZone into the matching UTC instant. */
function fromZoned(input, timeZone) {
  const naive = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour || 0,
    input.minute || 0,
    input.second || 0,
    input.ms || 0
  );
  const firstGuess = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60000);
  // Resolve twice: around a DST transition the first offset can be stale.
  return new Date(naive - offsetMinutes(firstGuess, timeZone) * 60000);
}

function addDays(date, days) {
  return new Date(toDate(date).getTime() + days * DAY_MS);
}

function startOfDay(date, timeZone) {
  const p = zonedParts(date || new Date(), timeZone);
  return fromZoned({ year: p.year, month: p.month, day: p.day }, timeZone);
}

function endOfDay(date, timeZone) {
  return new Date(addDays(startOfDay(date, timeZone), 1).getTime() - 1);
}

function startOfMonth(date, timeZone) {
  const p = zonedParts(date || new Date(), timeZone);
  return fromZoned({ year: p.year, month: p.month, day: 1 }, timeZone);
}

/** Exclusive upper bound - pair with $lt so no millisecond is ever lost. */
function startOfNextMonth(date, timeZone) {
  const p = zonedParts(date || new Date(), timeZone);
  return p.month === 12
    ? fromZoned({ year: p.year + 1, month: 1, day: 1 }, timeZone)
    : fromZoned({ year: p.year, month: p.month + 1, day: 1 }, timeZone);
}

function endOfMonth(date, timeZone) {
  return new Date(startOfNextMonth(date, timeZone).getTime() - 1);
}

/** ISO week start (Monday). */
function startOfWeek(date, timeZone) {
  const p = zonedParts(date || new Date(), timeZone);
  const daysSinceMonday = (p.weekday + 6) % 7;
  return startOfDay(addDays(startOfDay(date, timeZone), -daysSinceMonday), timeZone);
}

function addMonths(date, months, timeZone) {
  const p = zonedParts(date, timeZone);
  const totalMonths = p.year * 12 + (p.month - 1) + months;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const daysInTarget = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return fromZoned(
    { year: year, month: month, day: Math.min(p.day, daysInTarget), hour: p.hour, minute: p.minute },
    timeZone
  );
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Example: 2026-08 */
function monthKey(date, timeZone) {
  const p = zonedParts(date || new Date(), timeZone);
  return p.year + '-' + pad2(p.month);
}

/** Example: 2026-08-31 */
function dayKey(date, timeZone) {
  const p = zonedParts(date || new Date(), timeZone);
  return p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
}

/** Parses YYYY-MM into its inclusive start / exclusive end instants. */
function monthRange(key, timeZone) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(key || '').trim());
  if (!match) throw new TypeError('Invalid month key "' + key + '", expected YYYY-MM');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new TypeError('Invalid month "' + key + '"');
  const start = fromZoned({ year: year, month: month, day: 1 }, timeZone);
  const end =
    month === 12
      ? fromZoned({ year: year + 1, month: 1, day: 1 }, timeZone)
      : fromZoned({ year: year, month: month + 1, day: 1 }, timeZone);
  return { start: start, end: end, key: match[1] + '-' + match[2] };
}

function previousMonthKey(key, timeZone) {
  const range = monthRange(key, timeZone);
  return monthKey(addDays(range.start, -1), timeZone);
}

function isWeekend(date, timeZone) {
  const weekday = zonedParts(date, timeZone).weekday;
  return weekday === 0 || weekday === 6;
}

function startOfUtcDay(date) {
  const d = toDate(date);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function daysBetween(a, b) {
  return Math.round((startOfUtcDay(b) - startOfUtcDay(a)) / DAY_MS);
}

/** Number of days in the calendar month of the given date. */
function daysInMonth(date, timeZone) {
  const p = zonedParts(date || new Date(), timeZone);
  return new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
}

module.exports = {
  DAY_MS,
  DEFAULT_TZ,
  toDate,
  zonedParts,
  offsetMinutes,
  fromZoned,
  startOfDay,
  endOfDay,
  startOfMonth,
  startOfNextMonth,
  endOfMonth,
  startOfWeek,
  addDays,
  addMonths,
  monthKey,
  dayKey,
  monthRange,
  previousMonthKey,
  isWeekend,
  daysBetween,
  daysInMonth,
};
