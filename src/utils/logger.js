'use strict';

const config = require('../config/env');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const COLORS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';

const threshold = LEVELS[config.logLevel] ?? LEVELS.info;
const useColor = !config.isProd && process.stdout.isTTY;

function format(level, message, meta) {
  const timestamp = new Date().toISOString();
  if (config.isProd) {
    // Structured JSON lines play nicely with log aggregators (CloudWatch, Loki, Datadog).
    return JSON.stringify({ timestamp, level, message, ...(meta ? { meta } : {}) });
  }
  const tag = useColor ? `${COLORS[level]}${level.toUpperCase()}${RESET}` : level.toUpperCase();
  const suffix = meta ? ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : '';
  return `${timestamp} [${tag}] ${message}${suffix}`;
}

function log(level, message, meta) {
  if (LEVELS[level] > threshold) return;
  const line = format(level, message, meta);
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

module.exports = {
  error: (message, meta) => log('error', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  info: (message, meta) => log('info', message, meta),
  debug: (message, meta) => log('debug', message, meta),
  stream: { write: (message) => log('info', message.trim()) },
};
