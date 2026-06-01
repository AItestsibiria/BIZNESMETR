// Eugene 2026-05-18 Босс «На планшете 8800 показывает но позвонить нельзя».
// Нужна разная UX для устройств которые могут / не могут делать звонки.
//
// Логика:
// - iPhone / Android phone (с SIM) → могут tel:// → стандартный flow
// - iPad без cellular / desktop / laptop → не могут tel:// → показываем
//   QR-код + текст «возьмите смартфон с этим номером и позвоните»
//
// User-Agent — единственный надёжный signal в браузере (нет API для
// «есть ли SIM»). Используем conservative detection: считаем «можно
// позвонить» только если явно phone-class device.

/**
 * Можно ли с этого устройства напрямую сделать tel:// звонок?
 *
 * true только для:
 *  - iPhone (mobile Safari)
 *  - Android phone (mobile Chrome/Firefox)
 *
 * false для:
 *  - iPad (даже с iOS — без cellular tel:// открывает FaceTime который
 *    может быть не настроен, юзер видит ошибку)
 *  - iPad Pro которая в iOS 13+ маскируется под macOS — определяем
 *    по navigator.maxTouchPoints > 1 + macOS UA
 *  - macOS / Windows / Linux desktop / laptop
 *  - Android tablet (если UA не содержит "mobile")
 */
export function isMobilePhone(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const uaLower = ua.toLowerCase();

  // iPhone — гарантированно phone
  if (/iphone/.test(uaLower)) return true;

  // Android phone — UA содержит "mobile" если phone
  // (Android tablet содержит "android" но НЕ содержит "mobile")
  if (/android/.test(uaLower) && /mobile/.test(uaLower)) return true;

  // Windows Phone / прочие phone-class
  if (/windows phone|blackberry|bb10|nokia|webos/.test(uaLower)) return true;

  return false;
}

/**
 * Это планшет / iPad (включая «Mac»-маскированный iPad Pro)?
 * Используется для UI hints «возьмите смартфон» когда tel:// недоступен.
 */
export function isTablet(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const uaLower = ua.toLowerCase();

  // Явный iPad UA
  if (/ipad/.test(uaLower)) return true;

  // iPad Pro в desktop-mode (iOS 13+): маскируется под macOS, но имеет
  // touch points > 1 (Mac не имеет touch screen).
  if (/macintosh/.test(uaLower) && navigator.maxTouchPoints > 1) return true;

  // Android tablet — есть "android" но нет "mobile"
  if (/android/.test(uaLower) && !/mobile/.test(uaLower)) return true;

  // Generic tablet signal
  if (/tablet/.test(uaLower)) return true;

  return false;
}

/**
 * Это desktop / laptop (НЕ phone, НЕ tablet)?
 */
export function isDesktop(): boolean {
  return !isMobilePhone() && !isTablet();
}

/**
 * Краткое имя устройства для отображения юзеру / логов.
 */
export function describeDevice(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = (navigator.userAgent || "").toLowerCase();
  if (/iphone/.test(ua)) return "iPhone";
  if (/ipad/.test(ua)) return "iPad";
  if (/macintosh/.test(ua) && navigator.maxTouchPoints > 1) return "iPad";
  if (/android.*mobile/.test(ua)) return "Android phone";
  if (/android/.test(ua)) return "Android tablet";
  if (/macintosh/.test(ua)) return "macOS";
  if (/windows/.test(ua)) return "Windows";
  if (/linux/.test(ua)) return "Linux";
  return "unknown";
}
