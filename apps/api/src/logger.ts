import type { LogLevel } from './env.ts';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const SENSITIVE_KEY_RE = /(password|token|secret|authorization|cookie|key)/i;

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      clean[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : sanitizeValue(nested, depth + 1);
    }
    return clean;
  }
  return value;
}

export interface StructuredLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(
  minLevel: LogLevel = 'info',
  sink: (line: string) => void = (line) => console.log(line)
): StructuredLogger {
  function emit(level: LogLevel, message: string, meta: Record<string, unknown> = {}) {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    const sanitizedMeta = sanitizeValue(meta) as Record<string, unknown>;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...sanitizedMeta
    };
    sink(JSON.stringify(entry));
  }

  return {
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta)
  };
}
