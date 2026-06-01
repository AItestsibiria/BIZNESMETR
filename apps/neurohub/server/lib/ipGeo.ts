// Eugene 2026-05-17 Босс «cookies + IP geo + identifying автор/первое
// посещение». IP → geo lookup для user_profiles.
//
// Используется через ip-api.com (free, 45 req/min, без ключа). Cache 24ч
// per IP in-memory. На fail → graceful fallback { country:'XX' }.
//
// Поля совпадают с user_profiles.ip_* колонками: country, city, region, asn.
// X-Country-Code header (если CDN добавляет) — приоритетный shortcut
// перед HTTP-запросом.
//
// Reuse-working-solutions rule: routes.ts уже имеет `getGeo(ip)` (только
// country/city/region, без asn). Этот файл — расширение с asn для
// user_profiles. Кэш отдельный — invalidate независимо если потребуется.

type GeoInfo = {
  country: string;
  city: string | null;
  region: string | null;
  asn: string | null;
};

const FALLBACK: GeoInfo = { country: "XX", city: null, region: null, asn: null };
const LOCAL: GeoInfo = { country: "Local", city: null, region: null, asn: null };

type CacheEntry = { value: GeoInfo; ts: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

function cleanIp(raw: string): string {
  if (!raw) return "";
  return raw.replace(/^::ffff:/, "").trim();
}

function isLocal(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "unknown" || ip === "";
}

/**
 * Получить geo по IP. Если CDN добавляет `X-Country-Code` header — берём
 * его без сетевого запроса. Иначе делаем cache → ip-api.com → fallback.
 * Никогда не throw'ит. На любую ошибку — `FALLBACK` ({ country:'XX' }).
 */
export async function getIpGeo(
  ip: string,
  headers?: Record<string, string | string[] | undefined>,
): Promise<GeoInfo> {
  const c = cleanIp(ip);
  if (isLocal(c)) return LOCAL;

  // CDN shortcut: некоторые edge-прокси добавляют X-Country-Code
  // (Cloudflare CF-IPCountry / Vercel x-vercel-ip-country / ...).
  // Используем как hint, но всё равно делаем кэш-lookup на city/asn.
  let cdnCountry: string | null = null;
  if (headers) {
    const h = (key: string): string | null => {
      const v = headers[key] || headers[key.toLowerCase()];
      if (!v) return null;
      const s = Array.isArray(v) ? v[0] : String(v);
      return s && s.length === 2 ? s.toUpperCase() : null;
    };
    cdnCountry =
      h("x-country-code") ||
      h("cf-ipcountry") ||
      h("x-vercel-ip-country") ||
      null;
  }

  // Cache hit
  const cached = cache.get(c);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return cached.value;
  }

  // ip-api.com lookup (free, 45 req/min, no key). Lang=en для единообразных
  // названий стран — Россия → Russia (см. Country grouping rule).
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(c)}?fields=country,countryCode,city,regionName,as&lang=en`,
      { signal: ctrl.signal },
    ).catch(() => null);
    clearTimeout(t);
    if (!res || !res.ok) {
      const out = cdnCountry ? { ...FALLBACK, country: cdnCountry } : FALLBACK;
      cache.set(c, { value: out, ts: Date.now() });
      return out;
    }
    const data: any = await res.json().catch(() => ({}));
    const out: GeoInfo = {
      country: (data.countryCode || cdnCountry || "XX").toString().toUpperCase(),
      city: data.city ? String(data.city) : null,
      region: data.regionName ? String(data.regionName) : null,
      asn: data.as ? String(data.as) : null,
    };
    cache.set(c, { value: out, ts: Date.now() });
    // LRU-ish — урезаем когда переваливает за 5000 ключей
    if (cache.size > 5000) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
    return out;
  } catch {
    const out = cdnCountry ? { ...FALLBACK, country: cdnCountry } : FALLBACK;
    cache.set(c, { value: out, ts: Date.now() });
    return out;
  }
}

export type { GeoInfo };
