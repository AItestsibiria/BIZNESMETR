// Eugene 2026-05-18 Босс «Robokassa техничка + правила сайта». Юридические
// реквизиты вынесены в один файл, чтобы при изменении ИНН/ОГРН/адреса не
// править разбросанные по UI/email/footer строки. Заполнить значения через
// ENV (на VPS в .env), либо отредактировать константы LEGAL_DEFAULT ниже
// и закоммитить (если реквизиты публично-публикуемые — обычно так и есть).
//
// Источник требований к составу: справка Robokassa
// «Требования для подключения приёма платежей» —
// https://robokassa.com/content/connection/ (WebSearch 2026-05-18):
//   «ИНН/ОГРН компании, данные самозанятого размещены в подвале сайта.
//    Электронная почта и телефон для связи есть на сайте, не скрыты
//    и доступны. Должно быть размещено актуальное описание товаров
//    и услуг, именно тех, которые вы будете продавать.»
//
// Дополнительно: ст. 9 ФЗ-152 «О персональных данных» требует Политики
// обработки ПДн; ст. 437 ГК РФ — публичной оферты для дистанционных услуг.

export interface LegalConfig {
  /** Краткое наименование исполнителя в footer (например «ИП Новосёлов Е.С.»). */
  entityName: string;
  /** Полное юр. наименование для оферты («Индивидуальный предприниматель Новосёлов Евгений Сергеевич»). */
  entityFullName: string;
  /** ИНН — 10 цифр (юрлицо) или 12 цифр (ИП/самозанятый). */
  inn: string;
  /** ОГРН (13 цифр) или ОГРНИП (15 цифр). Опционально для самозанятого (ИНН достаточно). */
  ogrn: string;
  /** Юр.адрес или адрес регистрации ИП (для оферты и чеков). */
  legalAddress: string;
  /** Контактный телефон, опубликованный на сайте (E.164 или городской). */
  phone: string;
  /** Контактный email (обращения, поддержка). */
  email: string;
  /** Доменное имя сервиса (без https://). */
  domain: string;
  /** Brand / название сервиса для оферты, чеков, footer. */
  brand: string;
  /**
   * Система налогообложения для Receipt 54-ФЗ (sno-поле):
   *   osn       — основная;
   *   usn_income — УСН Доход (6%);
   *   usn_income_outcome — УСН Доход-Расход (15%);
   *   patent    — патент;
   *   envd      — ЕНВД (упразднена с 2021, не использовать);
   *   esn       — ЕСН;
   *   npd       — НПД (самозанятый).
   *
   * Если у магазина ОДНА СНО (заведена в кабинете Robokassa) — sno можно
   * не передавать. Если несколько — указываем явно.
   */
  sno: "osn" | "usn_income" | "usn_income_outcome" | "patent" | "esn" | "npd" | null;
  /** Ставка НДС по умолчанию для услуги — см. Receipt 54-ФЗ. */
  defaultTax: "none" | "vat0" | "vat10" | "vat20" | "vat110" | "vat120";
}

/**
 * Дефолтные значения. Боссу: впиши свои ИНН/ОГРН/адрес в `.env` через
 *   `LEGAL_ENTITY_NAME`, `LEGAL_INN`, `LEGAL_OGRN`, `LEGAL_ADDRESS`,
 *   `LEGAL_PHONE`, `LEGAL_EMAIL`, `LEGAL_SNO`, `LEGAL_DEFAULT_TAX`.
 * Без этого в footer/оферте/чеке останутся placeholder-значения
 * 🔴ВПИШИ_...🔴, и Robokassa отклонит подключение.
 */
// Eugene 2026-05-18: реквизиты ЗАО «Инфолайн» (юр.лицо MuzaAi).
// Полный список банковских реквизитов хранится в docs/robokassa-package/05-contacts.md.
// В ENV можно переопределить любое поле через LEGAL_*.
const LEGAL_DEFAULT: LegalConfig = {
  entityName: "ЗАО «Инфолайн»",
  entityFullName: "Закрытое акционерное общество «Инфолайн»",
  inn: "7017236261",
  ogrn: "1097017005601",
  legalAddress: "634050, г. Томск, пр. Ленина, д. 151/1, корпус 1",
  phone: "+7 (3822) 50-36-70",
  email: "hello@muzaai.ru",
  domain: "muzaai.ru",
  brand: "MuzaAi",
  // ЗАО — общая система налогообложения (ОСН) с НДС 20% по умолчанию.
  sno: "osn",
  defaultTax: "vat20",
};

function envOr(key: string, fallback: string): string {
  const v = (process.env[key] || "").trim();
  return v || fallback;
}

export function getLegalConfig(): LegalConfig {
  return {
    entityName: envOr("LEGAL_ENTITY_NAME", LEGAL_DEFAULT.entityName),
    entityFullName: envOr("LEGAL_ENTITY_FULL_NAME", LEGAL_DEFAULT.entityFullName),
    inn: envOr("LEGAL_INN", LEGAL_DEFAULT.inn),
    ogrn: envOr("LEGAL_OGRN", LEGAL_DEFAULT.ogrn),
    legalAddress: envOr("LEGAL_ADDRESS", LEGAL_DEFAULT.legalAddress),
    phone: envOr("LEGAL_PHONE", LEGAL_DEFAULT.phone),
    email: envOr("LEGAL_EMAIL", LEGAL_DEFAULT.email),
    domain: envOr("LEGAL_DOMAIN", LEGAL_DEFAULT.domain),
    brand: envOr("LEGAL_BRAND", LEGAL_DEFAULT.brand),
    sno: (envOr("LEGAL_SNO", LEGAL_DEFAULT.sno || "") || null) as LegalConfig["sno"],
    defaultTax: (envOr("LEGAL_DEFAULT_TAX", LEGAL_DEFAULT.defaultTax) as LegalConfig["defaultTax"]) || "none",
  };
}

/**
 * Проверка что все обязательные поля заполнены (не содержат placeholder).
 * Используется в /api/legal/config endpoint + admin dashboard, чтобы видеть
 * статус готовности сайта к подключению Robokassa.
 */
export function isLegalConfigComplete(cfg: LegalConfig = getLegalConfig()): boolean {
  const requiredNonPlaceholder = [
    cfg.entityName, cfg.entityFullName, cfg.inn, cfg.legalAddress, cfg.phone, cfg.email,
  ];
  return requiredNonPlaceholder.every((v) => v && !v.includes("🔴"));
}
