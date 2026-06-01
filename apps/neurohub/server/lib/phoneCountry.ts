// Определение РФ + ближнее зарубежье (СНГ) по начальным цифрам номера.
// Eugene 2026-05-15 Босс «определение рф и СНГ по начальным цифрам».
//
// Используется в:
// - SMS-OTP (auth-sms): валидация что номер из подходящей зоны до отправки
// - welcome-gift логика (правило «1000 первых из РФ + ближнее зарубежье»)
// - billing (стоимость SMS разная по странам — провайдер сам биллит, но
//   логирование в sms_provider_logs нужно отделять)
//
// Формат входа: '+79261234567' / '79261234567' / '89261234567' / с пробелами,
// дефисами, скобками — нормализуем до '+79261234567' (E.164).

export type PhoneCountry = {
  code: string;       // ISO alpha-2: 'RU', 'BY', 'KZ', ...
  name: string;       // 'Россия', 'Беларусь', ...
  callingCode: string; // '+7', '+375', '+380', ...
  zone: "ru" | "near" | "far";  // ru = РФ, near = СНГ, far = дальнее
};

// Префиксы СНГ + РФ (ближнее зарубежье). Сортировка от длинного к короткому
// важна — '+7' матчится после '+7XXX' для KZ/RU disambiguation.
const PREFIXES: PhoneCountry[] = [
  // СНГ — каждой страны свой country code
  { code: "BY", name: "Беларусь",     callingCode: "+375", zone: "near" },
  { code: "UA", name: "Украина",      callingCode: "+380", zone: "near" },
  { code: "MD", name: "Молдова",      callingCode: "+373", zone: "near" },
  { code: "AM", name: "Армения",      callingCode: "+374", zone: "near" },
  { code: "AZ", name: "Азербайджан",  callingCode: "+994", zone: "near" },
  { code: "GE", name: "Грузия",       callingCode: "+995", zone: "near" },
  { code: "KG", name: "Кыргызстан",   callingCode: "+996", zone: "near" },
  { code: "TJ", name: "Таджикистан",  callingCode: "+992", zone: "near" },
  { code: "TM", name: "Туркменистан", callingCode: "+993", zone: "near" },
  { code: "UZ", name: "Узбекистан",   callingCode: "+998", zone: "near" },
  // РФ + Казахстан (общий код +7, но Казахстан по коду оператора 6/7).
  // +77 — Казахстан (мобильные), +76 — Казахстан. Остальные +7XX — РФ.
  { code: "KZ", name: "Казахстан",    callingCode: "+77",  zone: "near" },
  { code: "KZ", name: "Казахстан",    callingCode: "+76",  zone: "near" },
  { code: "RU", name: "Россия",       callingCode: "+7",   zone: "ru" },
];

// Нормализация до E.164: убираем все нецифры, обрабатываем 8XXX → +7XXX,
// добавляем + если начинается с цифры страны.
export function normalizePhone(raw: string): string {
  if (!raw) return "";
  let s = String(raw).replace(/[^\d+]/g, "");
  // 8XXXXXXXXXX → +7XXXXXXXXXX (российский шорткат)
  if (s.startsWith("8") && s.length === 11) s = "+7" + s.slice(1);
  // 7XXXXXXXXXX (без +) → +7XXXXXXXXXX
  if (!s.startsWith("+") && /^[0-9]{10,15}$/.test(s)) s = "+" + s;
  return s;
}

// Определение страны по нормализованному номеру.
// null = не РФ и не СНГ ИЛИ невалидный формат.
export function detectPhoneCountry(phoneRaw: string): PhoneCountry | null {
  const phone = normalizePhone(phoneRaw);
  if (!phone.startsWith("+")) return null;
  for (const c of PREFIXES) {
    if (phone.startsWith(c.callingCode)) {
      // длина: РФ +7 + 10 цифр = 12 символов с +.
      // СНГ +XXX + 9-10 цифр = 13-14 символов.
      const digits = phone.slice(1).length;
      if (c.code === "RU" || c.code === "KZ") {
        if (digits !== 11) continue;
      } else {
        if (digits < 9 || digits > 14) continue;
      }
      return c;
    }
  }
  return null;
}

// Маска для логов: +7926***4567. Не публикует полный номер.
export function maskPhone(phoneRaw: string): string {
  const phone = normalizePhone(phoneRaw);
  if (phone.length < 7) return "***";
  const head = phone.slice(0, 4);
  const tail = phone.slice(-4);
  return `${head}${"*".repeat(Math.max(3, phone.length - 8))}${tail}`;
}

// Базовая валидация — есть ли вообще смысл слать SMS на этот номер.
// Возвращает { ok, country, error }. error — text для UI.
export function validatePhoneForOtp(phoneRaw: string): {
  ok: boolean;
  country: PhoneCountry | null;
  normalized: string;
  error?: string;
} {
  const normalized = normalizePhone(phoneRaw);
  if (!normalized || !normalized.startsWith("+")) {
    return { ok: false, country: null, normalized, error: "Введите номер в формате +7XXXXXXXXXX" };
  }
  const country = detectPhoneCountry(normalized);
  if (!country) {
    return {
      ok: false,
      country: null,
      normalized,
      error: "Поддерживаются номера РФ и стран СНГ (Беларусь, Украина, Казахстан, Армения, Грузия, Молдова, Азербайджан, Узбекистан, Кыргызстан, Таджикистан, Туркменистан).",
    };
  }
  return { ok: true, country, normalized };
}
