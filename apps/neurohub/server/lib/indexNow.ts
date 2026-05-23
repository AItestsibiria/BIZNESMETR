// Eugene 2026-05-23 marketing/SEO: IndexNow protocol helper.
//
// IndexNow (https://www.indexnow.org/) — открытый стандарт от Microsoft и
// Yandex для мгновенного уведомления поисковиков об обновлении URL'ов.
// Поддерживают: Bing, Yandex, Seznam, Naver. Google НЕ участвует (у них
// свой Indexing API для job-postings/live-streams).
//
// Setup:
// 1. Создать api-key (UUID или 32+ hex символа). Готовая команда на VPS:
//      openssl rand -hex 32
// 2. Положить файл `<key>.txt` в `apps/neurohub/client/public/` с содержимым
//    самого ключа (это ownership-verification).
// 3. Добавить env INDEXNOW_KEY в /var/www/neurohub/.env.
// 4. Дёргать `submitIndexNow(["https://muzaai.ru/#/track/123"])` после
//    публикации нового трека / news post / большого изменения контента.
//
// Жёсткие правила (по IndexNow spec):
// - URLs должны быть на ТОМ ЖЕ host что указан в keyLocation.
// - keyLocation должен быть доступен публично (GET 200 OK с key content).
// - Batch до 10000 URLs за раз — используем единый endpoint api.indexnow.org
//   который раздаёт всем участникам автоматически.
//
// Errors не throw'ятся — IndexNow ping advisory, не должен ломать flow.

import { PUBLIC_URL } from "./publicUrl";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/IndexNow";

export interface IndexNowResult {
  ok: boolean;
  status: number;
  message: string;
  submittedCount: number;
}

/**
 * Submit batch URLs to IndexNow.
 * No-op (returns ok=false, status=0) if INDEXNOW_KEY env не настроен.
 */
export async function submitIndexNow(urls: string[]): Promise<IndexNowResult> {
  const key = process.env.INDEXNOW_KEY || "";
  if (!key) {
    return {
      ok: false,
      status: 0,
      message: "INDEXNOW_KEY env не настроен — pinger отключён",
      submittedCount: 0,
    };
  }
  if (!urls || urls.length === 0) {
    return { ok: false, status: 0, message: "urls пустой массив", submittedCount: 0 };
  }
  // Sanity: все URL'ы должны быть на нашем домене (IndexNow требует
  // одинаковый host для всех URL в batch'е и для keyLocation).
  const host = new URL(PUBLIC_URL).host;
  const validUrls = urls.filter((u) => {
    try {
      return new URL(u).host === host;
    } catch {
      return false;
    }
  });
  if (validUrls.length === 0) {
    return {
      ok: false,
      status: 0,
      message: `Все URL вне host=${host} — IndexNow требует одинаковый host`,
      submittedCount: 0,
    };
  }
  const body = {
    host,
    key,
    keyLocation: `${PUBLIC_URL}/${key}.txt`,
    urlList: validUrls.slice(0, 10000), // лимит спецификации
  };
  try {
    const r = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      // Не ждём бесконечно — IndexNow быстро отвечает (обычно <2 сек).
      signal: AbortSignal.timeout(10000),
    });
    const ok = r.status >= 200 && r.status < 300;
    return {
      ok,
      status: r.status,
      message: ok
        ? `OK: отправлено ${validUrls.length} URL`
        : `IndexNow вернул HTTP ${r.status}`,
      submittedCount: validUrls.length,
    };
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      message: `IndexNow fetch error: ${e?.message || String(e)}`,
      submittedCount: 0,
    };
  }
}

/**
 * Ping search engines с обновлённой sitemap.xml.
 *
 * Yandex: https://webmaster.yandex.com/ping?sitemap=<URL>
 * Google: устарел с июня 2023 (https://developers.google.com/search/blog/2023/06/sitemaps-lastmod-ping)
 *   → теперь только через Search Console UI или robots.txt → автоматическое
 *     обнаружение через краулинг. Оставляем заглушку для будущего.
 * Bing: устарел в 2023, заменён IndexNow.
 *
 * Возвращает массив результатов по каждому provider.
 */
export interface SitemapPingResult {
  provider: string;
  ok: boolean;
  status: number;
  message: string;
}

export async function pingSitemap(): Promise<SitemapPingResult[]> {
  const sitemapUrl = `${PUBLIC_URL}/sitemap.xml`;
  const results: SitemapPingResult[] = [];

  // Yandex — единственный поисковик который ещё поддерживает sitemap ping
  // (по состоянию на 2025-2026). https://yandex.com/support/webmaster/indexing-options/sitemap.html
  try {
    const yandexUrl = `https://webmaster.yandex.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`;
    const r = await fetch(yandexUrl, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });
    results.push({
      provider: "yandex",
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      message: `Yandex sitemap ping → HTTP ${r.status}`,
    });
  } catch (e: any) {
    results.push({
      provider: "yandex",
      ok: false,
      status: 0,
      message: `Yandex sitemap ping error: ${e?.message || String(e)}`,
    });
  }

  // Google sitemap ping deprecated June 2023 — оставляем informational.
  results.push({
    provider: "google",
    ok: false,
    status: 410,
    message:
      "Google sitemap ping endpoint deprecated с июня 2023 — submit через Search Console UI или ждать auto-crawl через robots.txt",
  });

  // Bing — теперь только через IndexNow (Microsoft консолидировали).
  results.push({
    provider: "bing",
    ok: false,
    status: 0,
    message:
      "Bing sitemap ping deprecated — используй submitIndexNow() для мгновенного notify",
  });

  return results;
}
