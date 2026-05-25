// Eugene 2026-05-25 security hardening (LOW-RISK approved set).
//
// sanitizeSecrets() — редактирует секрето-подобные значения из произвольной
// строки перед логированием / выводом в admin-диагностику. Закрывает риск
// «секрет попал в лог/ответ через traceback» (Secrets-admin-only rule +
// Never-leak-secrets rule).
//
// Чистая функция, без зависимостей. Безопасна для hot-path (не throw'ит).

const REDACTED = "[REDACTED]";

// Имена env-ключей которые считаются секретами (по суффиксу).
const SECRET_KEY_SUFFIX = /(_KEY|_TOKEN|_SECRET|_PASS|PASSWORD)$/i;

/**
 * Редактирует секрето-подобные значения в строке:
 *  - Anthropic-ключи (sk-ant-…) и прочие sk-… токены
 *  - Bearer-токены в Authorization
 *  - длинные base64/hex-строки (≥32 символов)
 *  - значения env-ключей с секрето-подобным именем (KEY=value, "TOKEN": "value")
 * Все совпадения → "[REDACTED]". Никогда не throw'ит.
 */
export function sanitizeSecrets(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  try {
    // 1) Bearer-токены: "Bearer <token>" → "Bearer [REDACTED]".
    out = out.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, `Bearer ${REDACTED}`);

    // 2) sk-… ключи (sk-ant-…, sk-proj-…, sk-…) — провайдерские секреты.
    out = out.replace(/\bsk-[A-Za-z0-9._\-]{12,}/g, REDACTED);

    // 3) KEY=value / KEY: value / "KEY":"value" где KEY имеет секрето-подобный
    //    суффикс. Захватываем имя ключа + разделитель, редактируем значение.
    //    Значение — до пробела/кавычки/запятой/точки-с-запятой/перевода строки.
    out = out.replace(
      /([A-Za-z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASS|PASSWORD))(\s*[:=]\s*"?)([^"\s,;]+)("?)/gi,
      (_m, key: string, sep: string, _val: string, q: string) => {
        // Только если имя ключа действительно матчит суффикс (защита от FP).
        return SECRET_KEY_SUFFIX.test(key) ? `${key}${sep}${REDACTED}${q}` : _m;
      },
    );

    // 4) Длинные base64/hex строки (≥32 символов) — вероятные сырые секреты
    //    (session secrets, signed url secrets, raw tokens). Делаем последним,
    //    чтобы не задеть уже отредактированные участки.
    out = out.replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, REDACTED);
    out = out.replace(/\b[A-Fa-f0-9]{32,}\b/g, REDACTED);
  } catch {
    // Никогда не ломаем вызывающий код из-за санитизации.
    return REDACTED;
  }
  return out;
}

/**
 * Превращает произвольную ошибку в безопасную (санитизированную) строку.
 * Используется в catch-блоках где error может содержать значения env.
 */
export function sanitizeError(e: unknown): string {
  let msg: string;
  try {
    if (e instanceof Error) {
      msg = e.message + (e.stack ? `\n${e.stack}` : "");
    } else if (typeof e === "string") {
      msg = e;
    } else {
      msg = JSON.stringify(e);
    }
  } catch {
    msg = String(e);
  }
  return sanitizeSecrets(msg || "");
}
