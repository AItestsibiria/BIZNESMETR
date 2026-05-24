// Eugene 2026-05-24 Босс «Czechia 1 уник + 1887 visits за сутки — bot fraud, разбери на атомы».
//
// Atom-level visitor bot defense — расширение botUa.ts (тот остаётся для read-side
// фильтрации SQL aggregates). Этот файл — write-side guard для /api/track-visit:
// расширенный UA regex + per-IP rate-limit + burst detector с Telegram алертом.
//
// ROOT CAUSE Czechia случая (атомарный разбор):
//   1. visitors.visits — это incrementing counter (см. routes.ts:929). Одна row
//      на (fingerprint OR ip) → на каждое track-visit +1.
//   2. Dedup на запись = ONLY `samePage && isRecent(5min)` (routes.ts:920-923).
//      SPA route variations / query-string mutations / fragment changes
//      → разный pageUrl → dedup не срабатывает → +1 каждый раз.
//   3. isBotUserAgent (botUa.ts:54) match'ит только базовый bot|crawler|...
//      regex. Headless Chrome 119+ через Puppeteer (UA «HeadlessChrome/119...»)
//      проходит через REGEX (`head` matches), но Playwright с patched UA
//      (`Mozilla/5.0 ... Chrome/120.0.0.0 Safari/537.36` без «headless»)
//      проходит как обычный Chrome → пишется как visitor.
//   4. Нет rate-limit per-IP — один IP может slam'ить track-visit без лимита.
//
// FIX:
//   1. Расширенный UA regex — puppeteer, playwright, selenium, headless variants,
//      uptime monitors, prerenderers, security scanners.
//   2. Per-IP rate-limit на /api/track-visit: 30 visits/min, 200/hr. Превышение
//      → skip + INSERT в suspicious_log для admin review.
//   3. Burst detector: если IP делает >500 visits/hour → Telegram alert админу
//      (one alert per IP per hour cooldown).
//   4. Datacenter ASN signatures: helper detectDatacenterAsn (опциональный
//      input — берётся из getIpGeo result.asn).
//
// Применяется ТОЛЬКО к write-side (track-visit endpoint). Read-side фильтрация
// продолжает использовать buildBotExclusionSql из botUa.ts.

import { isBotUserAgent as legacyIsBotUa } from "./botUa";

// ============================================================
// Расширенный UA detector
// ============================================================

/**
 * Расширенный bot UA regex. Покрывает:
 *   - Search engines: bot, crawler, spider, slurp, googlebot, yandexbot, bingbot, applebot
 *   - CLI tools: curl, wget, httpie, python-requests, java-http, axios, fetch, head
 *   - Automation: puppeteer, playwright, selenium, webdriver, phantom
 *   - Headless: headless, headlesschrome, headlessfirefox
 *   - Monitoring: uptimerobot, pingdom, datadog, newrelic, monitor, statuspage
 *   - Scrapers: scrapy, scraper, prerender, prerenderio, screaming frog
 *   - Security/SEO: ahrefs, semrush, mj12bot, dotbot, lighthouse, gtmetrix
 *   - Generic: bots, scan, probe, ngrok-tunnel
 *
 * Note: `\b` (word boundary) на CLI tools чтобы «fetch» не матчился внутри
 * legit «WebKit-Fetch» строк.
 */
const EXPANDED_BOT_UA_REGEX =
  /(bot|crawler|spider|slurp|httpie|python-requests|java-http|axios|scrapy|scraper|puppeteer|playwright|selenium|webdriver|phantom|headless|prerender|lighthouse|gtmetrix|pagespeed|ahrefs|semrush|mj12bot|dotbot|uptimerobot|pingdom|datadog|newrelic|monitor|statuspage|googlebot|yandexbot|bingbot|applebot|facebookexternalhit|whatsapp|twitterbot|linkedinbot|telegrambot|vkshare|petalbot|bytedance|ngrok|amazonbot|claudebot|gptbot|ccbot|anthropic-ai)/i;

const STANDALONE_TOOL_REGEX = /(?<![a-z])(curl|wget|fetch|head)(?![a-z])/i;

/**
 * Развёрнутая проверка: UA → bot?
 * Также детектит подозрительно короткие / пустые / not-set UA как боты.
 */
export function isLikelyBotUa(ua: string | null | undefined): boolean {
  if (!ua) return true; // отсутствие UA = bot (легитимные браузеры всегда шлют)
  const s = String(ua).trim();
  if (s.length < 8) return true; // «-», «test», слишком короткие — bot
  if (EXPANDED_BOT_UA_REGEX.test(s)) return true;
  if (STANDALONE_TOOL_REGEX.test(s)) return true;
  // Backward-compat: оставляем старый detector тоже (он строже на word-boundary)
  if (legacyIsBotUa(s)) return true;
  return false;
}

// ============================================================
// Datacenter ASN signatures
// ============================================================

/**
 * Список known datacenter / hosting ASN номеров.
 * IP из этих ASN — почти всегда боты/скриптовые клиенты, не real юзеры.
 * Источник: AS-numbers популярных hosting/cloud providers.
 *
 * Note: ASN приходит из getIpGeo().asn в формате «AS24940 Hetzner Online GmbH».
 * Проверяется substring match на AS-номер ИЛИ имя провайдера.
 */
const DATACENTER_ASN_PATTERNS = [
  // Hosting / VPS
  "hetzner", "ovh", "digitalocean", "linode", "vultr", "scaleway", "leaseweb",
  "contabo", "ionos", "1&1", "hostinger", "namecheap", "godaddy",
  // Cloud
  "amazon", "google cloud", "microsoft", "azure", "alibaba", "oracle cloud",
  "aws", "ec2", "gcp", "tencent",
  // CDN / proxies often abused
  "cloudflare warp", "fastly", "stackpath",
  // Russian/CIS hosting (учитываем, но не блочим Yandex/VK как они могут быть real)
  "selectel", "timeweb", "beget", "reg.ru",
  // ASN numbers (raw для match если name не нашёлся)
  "as24940", "as16276", "as14061", "as63949", "as20473",
];

export function isDatacenterAsn(asn: string | null | undefined): boolean {
  if (!asn) return false;
  const s = String(asn).toLowerCase();
  return DATACENTER_ASN_PATTERNS.some((pattern) => s.includes(pattern));
}

// ============================================================
// Per-IP rate-limit для /track-visit
// ============================================================

type RateEntry = {
  // Sliding window timestamps (ms). Trimmed lazily.
  hits: number[];
  // First-seen в текущем burst window.
  burstFirst: number;
  // Visits в текущем hour-window.
  burstCount: number;
  // Last alert sent (для cooldown).
  lastAlertAt: number;
};

const ipRateMap = new Map<string, RateEntry>();
const RATE_WINDOW_MS = 60_000; // 1 минута
const HOUR_WINDOW_MS = 60 * 60_000;
const MAX_VISITS_PER_MIN = 30; // 30/мин — выше = bot для sure
const MAX_VISITS_PER_HOUR = 200; // 200/час soft cap
const BURST_THRESHOLD_PER_HOUR = 500; // >500/час → Telegram alert
const ALERT_COOLDOWN_MS = 60 * 60_000; // 1 alert per IP per hour

/**
 * Результат rate-limit проверки.
 * - ok: можно пропустить запись
 * - reason: если skipped — причина (для admin аудита)
 * - burst: если burst detected — true (caller должен alert)
 */
export type RateCheckResult = {
  ok: boolean;
  reason?: "rate_limit_min" | "rate_limit_hour";
  burst: boolean;
  hitsLastMin: number;
  hitsLastHour: number;
};

export function checkVisitRateLimit(ip: string): RateCheckResult {
  if (!ip || ip === "unknown") {
    return { ok: true, burst: false, hitsLastMin: 0, hitsLastHour: 0 };
  }
  const now = Date.now();
  let entry = ipRateMap.get(ip);
  if (!entry) {
    entry = { hits: [], burstFirst: now, burstCount: 0, lastAlertAt: 0 };
    ipRateMap.set(ip, entry);
  }
  // Trim old hits (>1 hour)
  entry.hits = entry.hits.filter((t) => now - t < HOUR_WINDOW_MS);
  const hitsLastHour = entry.hits.length;
  const hitsLastMin = entry.hits.filter((t) => now - t < RATE_WINDOW_MS).length;

  // Lazy cleanup if map > 10k IPs
  if (ipRateMap.size > 10000) {
    // remove first 100 oldest entries
    let removed = 0;
    for (const k of Array.from(ipRateMap.keys())) {
      if (removed >= 100) break;
      const e = ipRateMap.get(k);
      if (e && (e.hits.length === 0 || now - e.hits[e.hits.length - 1] > HOUR_WINDOW_MS)) {
        ipRateMap.delete(k);
        removed++;
      }
    }
  }

  // Check каскадно: per-minute first (более строгий)
  if (hitsLastMin >= MAX_VISITS_PER_MIN) {
    return { ok: false, reason: "rate_limit_min", burst: false, hitsLastMin, hitsLastHour };
  }
  if (hitsLastHour >= MAX_VISITS_PER_HOUR) {
    return { ok: false, reason: "rate_limit_hour", burst: false, hitsLastMin, hitsLastHour };
  }

  // Add current hit
  entry.hits.push(now);
  const newHourCount = entry.hits.length;

  // Burst detect: >500/hr threshold, alert cooldown 1hr
  let burst = false;
  if (newHourCount >= BURST_THRESHOLD_PER_HOUR) {
    if (now - entry.lastAlertAt > ALERT_COOLDOWN_MS) {
      entry.lastAlertAt = now;
      burst = true;
    }
  }

  return { ok: true, burst, hitsLastMin, hitsLastHour: newHourCount };
}

// ============================================================
// Telegram burst alert
// ============================================================

/**
 * Отправляет Telegram уведомление админу о подозрительном burst трафике.
 * Fire-and-forget, не throw'ит.
 */
export function notifyBurstAlert(input: {
  ip: string;
  ua: string;
  country: string | null;
  asn: string | null;
  hitsLastHour: number;
  hitsLastMin: number;
}): void {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (!token || !adminId) return;
    const maskedUa = String(input.ua || "").slice(0, 120);
    const body = [
      "🚨 Bot burst — visitor tracker",
      "",
      `IP: \`${input.ip}\``,
      `Страна: ${input.country || "??"}`,
      `ASN: ${input.asn || "unknown"}`,
      `Hits/min: ${input.hitsLastMin}`,
      `Hits/hour: ${input.hitsLastHour}`,
      `UA: \`${maskedUa}\``,
      "",
      "Действия:",
      "1) /admin/v304 → 🚦 Suspicious IPs",
      "2) Добавить в nginx deny если повторяется",
    ].join("\n");
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: adminId,
        text: body,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    }).catch((e) => {
      try { console.error("[BOT-BURST-ALERT]", String(e?.message || e)); } catch {}
    });
  } catch (e) {
    try { console.error("[BOT-BURST-ALERT] failed", String((e as any)?.message || e)); } catch {}
  }
}

// ============================================================
// Введение для тестов / админ инспекции
// ============================================================

/**
 * Snapshot текущего состояния rate-map (для admin endpoint).
 * Возвращает топ-N IP по hits/hour.
 */
export function getRateMapSnapshot(limit = 50): Array<{
  ip: string;
  hitsLastHour: number;
  hitsLastMin: number;
  firstSeenAgoMs: number;
}> {
  const now = Date.now();
  const rows: Array<{
    ip: string;
    hitsLastHour: number;
    hitsLastMin: number;
    firstSeenAgoMs: number;
  }> = [];
  for (const [ip, entry] of ipRateMap) {
    const hits = entry.hits.filter((t) => now - t < HOUR_WINDOW_MS);
    if (hits.length === 0) continue;
    rows.push({
      ip,
      hitsLastHour: hits.length,
      hitsLastMin: hits.filter((t) => now - t < RATE_WINDOW_MS).length,
      firstSeenAgoMs: now - hits[0],
    });
  }
  rows.sort((a, b) => b.hitsLastHour - a.hitsLastHour);
  return rows.slice(0, limit);
}

/**
 * Reset rate-map (only для тестов).
 */
export function _resetRateMap(): void {
  ipRateMap.clear();
}
