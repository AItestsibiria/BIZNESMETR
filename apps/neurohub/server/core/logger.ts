// Минимальный logger-обёртка над console для core/plugins.
// Не претендует на pino/winston — Sprint 8 заменит на полноценный
// logger с redaction (см. docs/strategy/original/07 §6).

import type { Logger } from "./types";

export function createLogger(scope: string): Logger {
  const stamp = () => new Date().toISOString();
  const fmt = (level: string, msg: string, extra?: Record<string, unknown>) =>
    extra && Object.keys(extra).length > 0
      ? `${stamp()} [${scope}] ${level} ${msg} ${JSON.stringify(extra)}`
      : `${stamp()} [${scope}] ${level} ${msg}`;

  return {
    info: (msg, extra) => console.log(fmt("info", msg, extra)),
    warn: (msg, extra) => console.warn(fmt("warn", msg, extra)),
    error: (msg, extra) => console.error(fmt("error", msg, extra)),
  };
}
