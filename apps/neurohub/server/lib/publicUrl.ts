// Eugene 2026-05-15 Босс «смена muziai.ru на muzaai.ru, провести ревизию
// проекта». Public URL домена для всех генерируемых ссылок (email-confirms,
// share-OG, referral, audio-URLs в Suno-callback и т.д.).
//
// Управляется через env BASE_DOMAIN (см. server/index.ts inline .env-loader).
// Backwards-compat: если BASE_DOMAIN не задан → fallback на "muziai.ru"
// (тогда старые ссылки в email-уведомлениях продолжат работать через
// nginx 301-redirect).
//
// После cutover на VPS:
//   echo "BASE_DOMAIN=muzaai.ru" >> /var/www/neurohub/.env
//   pm2 restart neurohub --update-env
//
// Без рестарта PUBLIC_URL не обновится — env читается на старте.

// Eugene 2026-05-15 Босс «правило: новая генерация с 15.05.2026 года
// использует MuzaAi.ru». PUBLIC_DOMAIN default — теперь "muzaai.ru".
// Старый "muziai.ru" остаётся только в CORS-origins (для cross-domain до
// nginx redirect) и в email-адресах (hello@muziai.ru — MX-записи там).

export const PUBLIC_DOMAIN: string = process.env.BASE_DOMAIN || "muzaai.ru";
export const PUBLIC_URL: string = `https://${PUBLIC_DOMAIN}`;

// Канонический список origin'ов для CORS / security-guard.
// Включает оба домена + www-варианты + localhost (dev). После cutover
// muzaai.ru будет primary, muziai.ru остаётся для 301-redirect внутри
// nginx (но также допустим в CORS — чтобы не ломать кросс-домены если
// юзер где-то на muziai.ru делает API-call до того как nginx redirect'нул).
export const PUBLIC_ORIGINS: string[] = [
  "https://muzaai.ru",
  "https://www.muzaai.ru",
  "https://muziai.ru",
  "https://www.muziai.ru",
  "https://clone.muziai.ru",
  "http://localhost:5173",
  "http://localhost:5000",
];
