import { pino, type Logger } from 'pino';
import { getConfig } from '../config/index.js';

/**
 * Structured logging (D6).
 *
 * JSON to stdout: Cloud Run ingests it directly, so there is no log agent to
 * configure and no file to rotate. The redact list is the security control --
 * tokens and connection strings must never reach a log sink, because log sinks
 * have broader read access than the database does.
 */

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["idempotency-key"]',
  'headers.authorization',
  'token',
  '*.token',
  'auth.token',
  'password',
  '*.password',
  'DATABASE_URL',
  'config.DATABASE_URL',
  'AUTH_SECRET',
  'config.AUTH_SECRET',
];

let root: Logger | undefined;

export function getLogger(): Logger {
  if (!root) {
    const cfg = getConfig();
    root = pino({
      level: cfg.isTest ? 'silent' : cfg.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      // Cloud Logging reads `severity`, not pino's numeric `level`.
      formatters: {
        level(label) {
          return { level: label, severity: label.toUpperCase() };
        },
      },
      base: { service: 'roxstar-backend' },
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return root;
}

export function resetLogger(): void {
  root = undefined;
}

export type { Logger };
