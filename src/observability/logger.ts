/**
 * Failover-Proxy v4.0 — Structured Logger
 *
 * JSON-structured logging with request correlation, automatic context injection,
 * and log level filtering. Zero external dependencies.
 *
 * Log format:
 *   {"level":"info","ts":"...","msg":"...","requestId":"abc-123",...}
 */

import type { LogLevel, LogEntry } from '../types';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

let _minLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  _minLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[_minLevel];
}

function formatEntry(entry: LogEntry): string {
  // Extract known fields, rest goes into extras
  const { level, timestamp, message, requestId, provider, keySuffix, durationMs, ...extras } = entry;
  const obj: Record<string, unknown> = {
    level,
    ts: timestamp,
    msg: message,
  };
  if (requestId) obj.requestId = requestId;
  if (provider) obj.provider = provider;
  if (keySuffix) obj.key = keySuffix;
  if (durationMs !== undefined) obj.durationMs = durationMs;

  // Merge extras
  for (const [k, v] of Object.entries(extras)) {
    if (v !== undefined && v !== null) {
      obj[k] = v;
    }
  }

  return JSON.stringify(obj);
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...context,
  };

  const line = formatEntry(entry);

  if (level === 'error' || level === 'fatal') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

/**
 * Create a child logger pre-bound with context fields.
 * Useful for per-request logging.
 */
export function createLogger(baseContext?: Record<string, unknown>) {
  const ctx = baseContext || {};
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', msg, { ...ctx, ...extra }),
    info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, { ...ctx, ...extra }),
    warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, { ...ctx, ...extra }),
    error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, { ...ctx, ...extra }),
    fatal: (msg: string, extra?: Record<string, unknown>) => emit('fatal', msg, { ...ctx, ...extra }),
  };
}

/** Root logger for startup / global events. */
export const logger = createLogger();
