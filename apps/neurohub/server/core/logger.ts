// Logger обёртка. Console-backed для скорости + auto-redaction
// чувствительных значений.
//
// Eugene 2026-05-20 (N1 fix): добавлен VALUE-level redaction для PII и
// secret-like patterns в свободном тексте — Sprint 8 hardening + правило
// PII redaction в pm2 logs.
//
// Redaction-стратегии:
//   1. KEY-based: ключи вроде `password`/`api_key` — значение → "[REDACTED]"
//   2. VALUE-based: phone/email/long-secret в значениях полей и в msg —
//      маскируются partially (first/last chars visible для debugging)
//   3. Глубина ограничена MAX_REDACT_DEPTH чтобы не залипнуть на циклах.

import type { Logger } from "./types";

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|session|jwt)/i;

const MAX_REDACT_DEPTH = 6;

// === PII / secret patterns ===

// Email — стандартный RFC-relaxed pattern. Маска: f***@domain.com.
const EMAIL_RE = /([a-zA-Z0-9_.+-])([a-zA-Z0-9_.+-]*?)@([a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)/g;
function maskEmail(_m: string, first: string, _mid: string, domain: string): string {
  return `${first}***@${domain}`;
}

// Phone — E.164 / российский формат. Маска: +7XXX***XX67 (last 4 visible).
// Pattern достаточно строгий чтобы не маскировать обычные числа.
const PHONE_RE = /(\+?[78])[\s\-(]*(\d{3})[\s\-)]*(\d{3})[\s\-]*(\d{2})[\s\-]*(\d{2})/g;
function maskPhone(_m: string, p: string, _a: string, _b: string, c: string, d: string): string {
  return `${p}XXX***${c}${d}`;
}

// API-ключи известных провайдеров. Маска: sk-ant-*** / sk-*** / etc.
const KNOWN_KEY_RE = /(sk-ant-api03-|sk-proj-|sk-|AQVN|t1\.9eu|TGW-|API_)[A-Za-z0-9_\-]{16,}/g;
function maskKnownKey(m: string): string {
  // Prefix до первого `_`, `-` или 8 символов
  const prefix = m.slice(0, 8);
  return `${prefix}***[${m.length}ch]`;
}

// Generic long random base64/hex/alphanumeric — 32+ символов без пробелов.
// Применяется ТОЛЬКО к строкам которые выглядят как secret (mixed case +
// numbers + длина >= 32). Это эвристика — может ложно сработать на base64-
// encoded image-data; для логов это OK (мы не логируем image-data).
const LONG_SECRET_RE = /\b([A-Za-z0-9+/=_\-]{40,})\b/g;
function maskLongSecret(m: string): string {
  // Если есть пробелы / слешы — это URL, не secret. Skip.
  if (/[/]/.test(m)) return m;
  return `${m.slice(0, 6)}***[${m.length}ch]`;
}

/**
 * Маскирует PII / secret patterns в строке.
 * Порядок важен: known-keys → emails → phones → generic-long.
 */
export function redactPII(text: string): string {
  if (!text || typeof text !== "string" || text.length === 0) return text;
  let out = text;
  try {
    out = out.replace(KNOWN_KEY_RE, maskKnownKey);
    out = out.replace(EMAIL_RE, maskEmail);
    out = out.replace(PHONE_RE, maskPhone);
    out = out.replace(LONG_SECRET_RE, maskLongSecret);
  } catch {
    // Если regex blew up — вернём оригинал. Логгер не должен ломаться.
    return text;
  }
  return out;
}

function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > MAX_REDACT_DEPTH) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return redactPII(value);
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
  const safeMsg = redactPII(msg);
  if (!extra || Object.keys(extra).length === 0) {
    return `${stamp} [${scope}] ${level} ${safeMsg}`;
  }
  const safe = redact(extra) as Record<string, unknown>;
  return `${stamp} [${scope}] ${level} ${safeMsg} ${JSON.stringify(safe)}`;
}

export function createLogger(scope: string): Logger {
  return {
    info: (msg, extra) => console.log(format("info", scope, msg, extra)),
    warn: (msg, extra) => console.warn(format("warn", scope, msg, extra)),
    error: (msg, extra) => console.error(format("error", scope, msg, extra)),
  };
}
