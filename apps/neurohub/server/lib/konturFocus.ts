// Eugene 2026-05-26 Босс «регистрация ЮЛ по ИНН или названию — подтянуть все
// данные с базы по API Контур.Фокус». Клиент к Контур.Фокус (focus-api.kontur.ru).
//
// Секрет KONTUR_FOCUS_API_KEY ставит Босс на VPS (Never-leak-secrets rule) —
// в коде только process.env. Без ключа lookup возвращает null (вызывающий код
// предлагает ручной ввод), КРОМЕ известного ИНН ЗАО «Инфолайн» — он отдаётся
// из legalConfig (seed), чтобы демо-кабинет работал без ключа.
//
// Docs Контур.Фокус: https://focus-api.kontur.ru/ (метод /api3/req?key=&inn=).

import { getLegalConfig } from "./legalConfig";

export interface CompanyData {
  kind: "ul" | "ip";
  inn: string;
  kpp?: string;
  ogrn?: string;
  name: string;
  fullName?: string;
  legalAddress?: string;
  directorName?: string;
  phone?: string;
  email?: string;
  source: "kontur_focus" | "seed" | "manual";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw?: any;
}

const KONTUR_BASE = "https://focus-api.kontur.ru/api3";

function normInn(s: string): string {
  const v = (s || "").replace(/\s/g, "");
  return /^\d{10}$|^\d{12}$/.test(v) ? v : "";
}

export function konturConfigured(): boolean {
  return !!(process.env.KONTUR_FOCUS_API_KEY || "").trim();
}

/** Поиск компании по ИНН или названию. null = не найдено / нет ключа / ошибка. */
export async function lookupCompany(query: string): Promise<CompanyData | null> {
  const q = (query || "").trim();
  if (!q) return null;
  const inn = normInn(q);

  // Известный ИНН ЗАО «Инфолайн» — отдаём из legalConfig (seed), даже без ключа.
  const cfg = getLegalConfig();
  if (inn && inn === cfg.inn) {
    return {
      kind: "ul",
      inn: cfg.inn,
      kpp: cfg.kpp,
      ogrn: cfg.ogrn,
      name: cfg.entityName,
      fullName: cfg.entityFullName,
      legalAddress: cfg.legalAddress,
      directorName: cfg.directorName,
      phone: cfg.phone,
      email: cfg.email,
      source: "seed",
    };
  }

  const key = (process.env.KONTUR_FOCUS_API_KEY || "").trim();
  if (!key) return null; // ключа нет → ручной ввод (решает вызывающий код)

  try {
    const url = inn
      ? `${KONTUR_BASE}/req?key=${encodeURIComponent(key)}&inn=${encodeURIComponent(inn)}`
      : `${KONTUR_BASE}/req?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) {
      console.warn("[konturFocus] HTTP", r.status);
      return null;
    }
    const data = await r.json();
    return parseKonturReq(data);
  } catch (e) {
    console.warn("[konturFocus] lookup failed:", e);
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseKonturReq(data: any): CompanyData | null {
  const item = Array.isArray(data) ? data[0] : data?.items?.[0] || data;
  if (!item) return null;
  const ul = item.UL || item.ul;
  const ip = item.IP || item.ip;

  if (ul) {
    const name =
      ul.legalName?.short || ul.legalName?.shortName || ul.legalNameShort ||
      ul.legalName?.full || ul.legalName?.fullName || item.inn || "Юрлицо";
    return {
      kind: "ul",
      inn: ul.inn || item.inn || "",
      kpp: ul.kpp || "",
      ogrn: ul.ogrn || "",
      name,
      fullName: ul.legalName?.full || ul.legalName?.fullName || name,
      legalAddress:
        ul.legalAddress?.readableAddress || ul.legalAddress?.address ||
        ul.legalAddress?.parsedAddressRF?.readableAddress || "",
      directorName:
        (ul.heads && ul.heads[0] && (ul.heads[0].fio || ul.heads[0].name)) ||
        ul.head?.fio || "",
      source: "kontur_focus",
      raw: item,
    };
  }
  if (ip) {
    const fio = ip.fio || ip.name || "";
    return {
      kind: "ip",
      inn: ip.inn || item.inn || "",
      ogrn: ip.ogrnip || ip.ogrn || "",
      name: fio || "ИП",
      fullName: `Индивидуальный предприниматель ${fio}`.trim(),
      legalAddress: ip.address?.readableAddress || "",
      source: "kontur_focus",
      raw: item,
    };
  }
  return null;
}
