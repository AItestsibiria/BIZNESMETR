// Logger обёртка. Console-backed для скорости + auto-redaction
// чувствительных значений (Sprint 8 hardening).
//
// Redaction-стратегия: рекурсивно проходим extra-объект и заменяем
// значения ключей, которые «пахнут» секретом, на "[REDACTED]".

import type { Logger } from "./types";

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|session|jwt)/i;

const MAX_REDACT_DEPTH = 6;

function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > MAX_REDACT_DEPTH) return "[DEPTH_LIMIT]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(k) && v !== null && v !== undefined && v !== "") {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

function format(level: string, scope: string, msg: string, extra?: Record<string, unknown>): string {
  const stamp = new Date().toISOString();
  if (!extra || Object.keys(extra).length === 0) {
    return `${stamp} [${scope}] ${level} ${msg}`;
  }
  const safe = redact(extra) as Record<string, unknown>;
  return `${stamp} [${scope}] ${level} ${msg} ${JSON.stringify(safe)}`;
}

export function createLogger(scope: string): Logger {
  return {
    info: (msg, extra) => console.log(format("info", scope, msg, extra)),
    warn: (msg, extra) => console.warn(format("warn", scope, msg, extra)),
    error: (msg, extra) => console.error(format("error", scope, msg, extra)),
  };
}
