// Eugene 2026-05-23 Босс «подарочные сертификаты». Генерация уникальных
// 12-символьных кодов формата XXXX-XXXX-XXXX (uppercase, без неоднозначных
// 0/O/1/I/L). Race-safe: вызывающий передаёт callback `existsCb` для
// проверки уникальности в той же транзакции, в которой код будет вставлен.
//
// Spec: docs/strategy/original/06 — модули owns тables. Plugin: gift-certificates.

import crypto from "crypto";

// Алфавит без неоднозначных символов:
//   - O, 0 убраны (визуальная путаница)
//   - I, 1, L убраны
//   - U, V убрана пара (рукопись)
//   - 26 - 5 = 21 буква + 8 цифр = 29 символов. log2(29) ≈ 4.86 → log2(29^12) ≈ 58.3 бит энтропии
//
// При 1M активных кодов вероятность коллизии ≈ 1M / 29^12 ≈ 1.7e-12 — пренебрежимо.
const ALPHABET = "ABCDEFGHJKMNPQRSTUWXYZ23456789"; // 30 символов; добавил Z обратно (визуально чётко) и убрал V (легко путать с U)

export interface GenerateCodeOptions {
  /** Проверка наличия кода в БД (для race-safe генерации). Должна вернуть true если уже занят. */
  existsCb?: (code: string) => boolean;
  /** Максимум попыток уникальности. Default 8. */
  maxRetries?: number;
}

/**
 * Сгенерировать уникальный 12-символьный код формата XXXX-XXXX-XXXX.
 *
 * Если передан `existsCb` — перебирает варианты до уникальности (до maxRetries).
 * Если не уникальность не достигнута — throw.
 */
export function generateCode(opts: GenerateCodeOptions = {}): string {
  const maxRetries = opts.maxRetries ?? 8;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const raw = generateRaw12();
    const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
    if (!opts.existsCb || !opts.existsCb(code)) return code;
  }
  throw new Error(
    `[giftCertificateCode] Failed to generate unique code after ${maxRetries} attempts. ` +
    "Возможна коллизия — увеличить алфавит или длину.",
  );
}

function generateRaw12(): string {
  // crypto.randomBytes даёт криптографически стойкое случайство.
  // Берём 12 байт, каждый mod ALPHABET.length.
  const buf = crypto.randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i += 1) {
    out += ALPHABET[buf[i] % ALPHABET.length];
  }
  return out;
}

const CODE_REGEX = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

/**
 * Валидация формата кода. НЕ проверяет существование в БД (это отдельный шаг).
 */
export function isCodeValid(code: string): boolean {
  if (typeof code !== "string") return false;
  return CODE_REGEX.test(code.trim().toUpperCase());
}

/**
 * Нормализация кода: trim + uppercase + одиночные дефисы.
 * Юзер вводит "abcd efgh ijkl" / "abcdefghijkl" → канон "ABCD-EFGH-IJKL".
 */
export function normalizeCode(raw: string): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw.replace(/[\s-]+/g, "").toUpperCase();
  if (cleaned.length !== 12) return raw.trim().toUpperCase();
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}-${cleaned.slice(8, 12)}`;
}
