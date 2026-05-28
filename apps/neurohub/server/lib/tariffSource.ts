// Eugene 2026-05-28 Босс «тарифы Яндекса/TimeWeb на услуги проекта читать по API
// через сервисный ключ → Деньга берёт данные оттуда; нужно для стоимости трека».
//
// Слой LIVE-тарифов: периодически тянет реальные тарифы провайдера по API
// (сервисный ключ из env — Боссом ставится по SSH, в коде только process.env),
// кладёт в providerTariffs.setLiveTariff(). getTariffAt() предпочитает live,
// иначе статический каталог (надёжный fallback). Никогда не бросает.
//
// КОНФИГ (env на VPS, Never-leak-secrets rule — значения только в .env):
//   TARIFF_API_URL  — endpoint, возвращающий JSON-массив тарифов:
//                     [{ "provider": "...", "resource": "...", "costKopecks": N, "unit": "..." }]
//                     (можно указать агрегатор/прокси, который сам ходит в
//                      Yandex/TimeWeb billing API и приводит к этому формату).
//   TARIFF_API_KEY  — сервисный API-ключ (передаётся в Authorization).
//   TARIFF_API_AUTH_SCHEME — "Bearer" (default) | "Api-Key" | "raw" (без префикса).
//   TARIFF_API_REFRESH_MIN — период рефреша в минутах (default 360 = 6ч).
//
// Формат ответа (нормализуем устойчиво): принимаем массив или {items:[...]}.
// costKopecks — наш cost в КОПЕЙКАХ за unit. Если провайдер отдаёт рубли —
// агрегатор должен умножить на 100 до отдачи (или поле costRub → конвертим).

import { setLiveTariff, getLiveTariffOverrides } from "./providerTariffs";

let lastRefreshAt = 0;
let lastResult: { ok: boolean; count: number; error?: string; at: number } = { ok: false, count: 0, at: 0 };
let timer: NodeJS.Timeout | null = null;

function authHeader(): Record<string, string> {
  const key = (process.env.TARIFF_API_KEY || "").trim();
  if (!key) return {};
  const scheme = (process.env.TARIFF_API_AUTH_SCHEME || "Bearer").trim();
  if (scheme.toLowerCase() === "raw") return { Authorization: key };
  return { Authorization: `${scheme} ${key}` };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeRows(data: any): Array<{ provider: string; resource: string; costKopecks: number; unit?: string }> {
  const arr = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const out: Array<{ provider: string; resource: string; costKopecks: number; unit?: string }> = [];
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const provider = String(r.provider || "").trim();
    const resource = String(r.resource || "").trim();
    if (!provider || !resource) continue;
    let cost: number | null = null;
    if (typeof r.costKopecks === "number") cost = r.costKopecks;
    else if (typeof r.costRub === "number") cost = Math.round(r.costRub * 100);
    else if (typeof r.cost === "number") cost = Math.round(r.cost * 100); // предполагаем рубли
    if (cost == null || !(cost >= 0)) continue;
    out.push({ provider, resource, costKopecks: cost, unit: r.unit ? String(r.unit) : undefined });
  }
  return out;
}

/**
 * Один проход рефреша. Тянет тарифы по TARIFF_API_URL с сервисным ключом,
 * кладёт в live-override. Никогда не throw'ит.
 */
export async function refreshLiveTariffs(): Promise<{ ok: boolean; count: number; error?: string }> {
  const url = (process.env.TARIFF_API_URL || "").trim();
  if (!url) {
    lastResult = { ok: false, count: 0, error: "TARIFF_API_URL не задан (live-тарифы выключены, используется каталог)", at: Date.now() };
    return lastResult;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json", ...authHeader() } });
    clearTimeout(t);
    if (!r.ok) {
      lastResult = { ok: false, count: 0, error: `HTTP ${r.status}`, at: Date.now() };
      return lastResult;
    }
    const data = await r.json();
    const rows = normalizeRows(data);
    for (const row of rows) setLiveTariff(row.provider, row.resource, row.costKopecks, "api");
    lastRefreshAt = Date.now();
    lastResult = { ok: true, count: rows.length, at: lastRefreshAt };
    console.log(`[tariffSource] обновлено ${rows.length} тарифов по API`);
    return lastResult;
  } catch (e: any) {
    lastResult = { ok: false, count: 0, error: String(e?.message || e).slice(0, 200), at: Date.now() };
    console.warn("[tariffSource] refresh failed:", lastResult.error);
    return lastResult;
  }
}

/** Запуск фонового рефреша (на boot + по интервалу). Идемпотентно. */
export function startTariffRefresh(): void {
  if (timer) return;
  const min = Math.max(15, Number(process.env.TARIFF_API_REFRESH_MIN) || 360);
  // Первый проход — отложенно (не блокируем boot), затем по интервалу.
  setTimeout(() => { void refreshLiveTariffs(); }, 5000);
  timer = setInterval(() => { void refreshLiveTariffs(); }, min * 60 * 1000);
}

/** Статус для admin/диагностики (без секретов). */
export function tariffSourceStatus() {
  return {
    configured: !!(process.env.TARIFF_API_URL || "").trim(),
    hasKey: !!(process.env.TARIFF_API_KEY || "").trim(),
    lastRefreshAt,
    last: lastResult,
    liveOverrides: getLiveTariffOverrides(),
  };
}
