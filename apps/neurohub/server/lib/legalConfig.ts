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
  /** КПП (9 цифр, только юрлица; у ИП/самозанятого нет). */
  kpp: string;
  /** Юр.адрес или адрес регистрации ИП (для оферты и чеков). */
  legalAddress: string;
  /** Фактический адрес (если отличается от юридического). */
  actualAddress: string;

  // ── Банковские реквизиты (для договоров и счетов юрлицам) ──────────────
  /** Расчётный счёт (20 цифр). */
  settlementAccount: string;
  /** Корреспондентский счёт банка (20 цифр). */
  corrAccount: string;
  /** БИК банка (9 цифр). */
  bik: string;
  /** Наименование банка. */
  bankName: string;
  /** ФИО руководителя (директора). */
  directorName: string;
  /** Основание полномочий руководителя (например «на основании Устава»). */
  directorBasis: string;
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

  // ── Оператор персональных данных (152-ФЗ) ──────────────────────────────
  // Eugene 2026-05-25 Босс: блок «оператор ПДн». С 01.09.2025 действует
  // обязательное отдельное согласие на обработку ПДн + уведомление РКН
  // о трансграничной передаче. Реестровый номер РКН вписывается Боссом
  // после регистрации (через ЭП) в env LEGAL_PD_OPERATOR_REG.
  /**
   * Реестровый номер оператора ПДн в реестре Роскомнадзора. Пусто/placeholder
   * до момента регистрации. После регистрации Босс впишет в env
   * LEGAL_PD_OPERATOR_REG (например «70-25-012345»).
   */
  pdOperatorRegNumber: string;
  /** URL страницы Политики обработки ПДн. */
  pdPolicyUrl: string;
  /** URL страницы отдельного Согласия на обработку ПДн. */
  pdConsentUrl: string;
  /**
   * Трансграничная передача ПДн осуществляется (true) — у нас в США
   * (Anthropic/Claude для функций Музы). Требует уведомления РКН (ч. 3
   * ст. 12 152-ФЗ) и отражения в Политике/Согласии.
   */
  transborderTransfer: boolean;
  /** Список стран трансграничной передачи (ISO-имена на русском). */
  transborderCountries: string[];
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
  kpp: "701701001",
  legalAddress: "634050, г. Томск, пр. Ленина, д. 151/1, корпус 1",
  actualAddress: "г. Томск, ул. Карла Маркса, д. 7, оф. 519",
  settlementAccount: "40702810464000007838",
  corrAccount: "30101810800000000606",
  bik: "046902606",
  bankName: "Томское ОСБ № 8616 ПАО Сбербанк, г. Томск",
  directorName: "Новосёлов Евгений Геннадьевич",
  directorBasis: "на основании Устава",
  phone: "+7 (3822) 50-36-70",
  email: "hello@muzaai.ru",
  domain: "muzaai.ru",
  brand: "MuzaAi",
  // ЗАО — общая система налогообложения (ОСН) с НДС 20% по умолчанию.
  sno: "osn",
  defaultTax: "vat20",
  // Оператор ПДн: рег-номер РКН Босс впишет после регистрации (placeholder).
  pdOperatorRegNumber: "",
  pdPolicyUrl: "/privacy",
  pdConsentUrl: "/consent",
  // Трансграничная передача в США (Anthropic/Claude — функции Музы).
  transborderTransfer: true,
  transborderCountries: ["США"],
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
    kpp: envOr("LEGAL_KPP", LEGAL_DEFAULT.kpp),
    legalAddress: envOr("LEGAL_ADDRESS", LEGAL_DEFAULT.legalAddress),
    actualAddress: envOr("LEGAL_ACTUAL_ADDRESS", LEGAL_DEFAULT.actualAddress),
    settlementAccount: envOr("LEGAL_RS", LEGAL_DEFAULT.settlementAccount),
    corrAccount: envOr("LEGAL_KS", LEGAL_DEFAULT.corrAccount),
    bik: envOr("LEGAL_BIK", LEGAL_DEFAULT.bik),
    bankName: envOr("LEGAL_BANK", LEGAL_DEFAULT.bankName),
    directorName: envOr("LEGAL_DIRECTOR", LEGAL_DEFAULT.directorName),
    directorBasis: envOr("LEGAL_DIRECTOR_BASIS", LEGAL_DEFAULT.directorBasis),
    phone: envOr("LEGAL_PHONE", LEGAL_DEFAULT.phone),
    email: envOr("LEGAL_EMAIL", LEGAL_DEFAULT.email),
    domain: envOr("LEGAL_DOMAIN", LEGAL_DEFAULT.domain),
    brand: envOr("LEGAL_BRAND", LEGAL_DEFAULT.brand),
    sno: (envOr("LEGAL_SNO", LEGAL_DEFAULT.sno || "") || null) as LegalConfig["sno"],
    defaultTax: (envOr("LEGAL_DEFAULT_TAX", LEGAL_DEFAULT.defaultTax) as LegalConfig["defaultTax"]) || "none",
    pdOperatorRegNumber: envOr("LEGAL_PD_OPERATOR_REG", LEGAL_DEFAULT.pdOperatorRegNumber),
    pdPolicyUrl: envOr("LEGAL_PD_POLICY_URL", LEGAL_DEFAULT.pdPolicyUrl),
    pdConsentUrl: envOr("LEGAL_PD_CONSENT_URL", LEGAL_DEFAULT.pdConsentUrl),
    transborderTransfer:
      (envOr("LEGAL_PD_TRANSBORDER", LEGAL_DEFAULT.transborderTransfer ? "1" : "0") || "0") !== "0",
    transborderCountries: (() => {
      const raw = envOr("LEGAL_PD_TRANSBORDER_COUNTRIES", LEGAL_DEFAULT.transborderCountries.join(","));
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    })(),
  };
}

/**
 * Зарегистрирован ли оператор в реестре РКН: рег-номер задан и не является
 * placeholder-маркером. До регистрации возвращает false — admin dashboard и
 * /api/legal/pd-operator показывают статус «не зарегистрирован».
 */
export function isPdOperatorRegistered(cfg: LegalConfig = getLegalConfig()): boolean {
  const n = (cfg.pdOperatorRegNumber || "").trim();
  return Boolean(n) && !n.includes("🔴") && !/placeholder|впиши/i.test(n);
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
