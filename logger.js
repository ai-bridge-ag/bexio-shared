// Tiny logger shim for the bexio-shared package.
//
// Why not pino directly? This package is consumed by multiple agents that
// each ship their own structured logger (pino, with their own redaction +
// destination config). Hard-binding pino here would either pull a duplicate
// instance or force consumers to share a logger instance via env tricks.
//
// Instead: default to a console-based logger that emits one-line JSON-ish
// messages, and let consumers swap in their own logger via setLogger().
// Same shape as pino's child-logger API (info / warn / error + .child(bindings))
// so existing pino-using code paths work unchanged.

let activeLogger = makeConsoleLogger({ mod: 'bexio-shared' });

function makeConsoleLogger(bindings = {}) {
  const tag = (level, obj, msg) => {
    const merged = { level, ...bindings, ...(typeof obj === 'object' ? obj : {}) };
    const message = typeof obj === 'string' ? obj : (msg || '');
    // Emit on stderr for warn/error, stdout otherwise — matches pino's default.
    const out = level === 'warn' || level === 'error' ? console.error : console.log;
    out(JSON.stringify({ ...merged, msg: message }));
  };
  return {
    info:  (obj, msg) => tag('info',  obj, msg),
    warn:  (obj, msg) => tag('warn',  obj, msg),
    error: (obj, msg) => tag('error', obj, msg),
    debug: (obj, msg) => tag('debug', obj, msg),
    child: (extra) => makeConsoleLogger({ ...bindings, ...extra }),
  };
}

/**
 * Replace the package-wide logger. Intended use: at app startup, the
 * consumer calls setLogger(myPinoLogger) so all bexio-shared logs flow
 * into the host app's logging pipeline.
 *
 * Accepts any logger-shaped object with at least { info, warn, error,
 * child }. Pino loggers fit; so does Bunyan; so does a plain console
 * shim like the default above.
 */
export function setLogger(logger) {
  if (!logger || typeof logger.info !== 'function') {
    throw new Error('setLogger: argument must implement .info()');
  }
  activeLogger = logger;
}

/**
 * The "logger" handle the rest of the package imports. Intentionally an
 * accessor — modules grab it once at import-time but if the consumer calls
 * setLogger() at boot, subsequent .child() calls inside the package use
 * the new logger.
 *
 * Usage in a bexio-shared module:
 *   import { logger } from './logger.js';
 *   const log = logger.child({ mod: 'bexio-http' });
 */
export const logger = {
  info:  (...args) => activeLogger.info(...args),
  warn:  (...args) => activeLogger.warn(...args),
  error: (...args) => activeLogger.error(...args),
  debug: (...args) => (activeLogger.debug || activeLogger.info)(...args),
  child: (bindings) => activeLogger.child(bindings),
};
