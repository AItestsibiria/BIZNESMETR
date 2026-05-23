import express, { type Express } from "express";
import fs from "fs";
import path from "path";

// Eugene 2026-05-23 marketing/SEO: server-side substitution YM counter
// в noscript-fallback (см. client/index.html). Если YM_COUNTER_ID нет в
// env — заменяем placeholder на "0" → IMG никогда не загрузится, что
// эквивалентно отсутствию counter'а (ничего не ломает). Не использует
// VITE_* env — сервер сам подставляет в HTML на ответе.
const YM_COUNTER_ID = String(process.env.YM_COUNTER_ID || "0");
function injectMarketingPlaceholders(html: string): string {
  return html.replaceAll("__YM_COUNTER_ID__", YM_COUNTER_ID);
}

// Eugene 2026-05-18 Босс «реши на 100% lock-screen и запомни правило когда
// влёт результат». Root cause stale assets: serveStatic отдавал index.html
// без Cache-Control → iOS Safari агрессивно кэшировал HTML со ссылками на
// старые assets/index-XXX.js (с hash в имени, vite default). Юзер открывал
// muzaai.ru → Safari подтягивал CACHED index.html → ссылка на старый JS →
// playTrack() из старой версии без setLockScreenTrackSync вызова.
//
// Fix policy:
// - /assets/* (hashed имена от vite, immutable) — public, max-age=1y, immutable
// - index.html и SPA fallback — no-store + must-revalidate (всегда свежий)
// - всё остальное (favicon, manifest, sw) — без кэша на всякий случай
export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(
    express.static(distPath, {
      // index:false — index.html отдаём через fall-through-handler ниже
      // чтобы прогнать через injectMarketingPlaceholders (YM_COUNTER_ID).
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          // hashed assets — immutable forever (имя меняется при rebuild)
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
          res.setHeader("Pragma", "no-cache");
        } else {
          // manifest.json, favicon.svg, sw.js — короткий cache
          res.setHeader("Cache-Control", "public, max-age=300");
        }
      },
    }),
  );

  // fall through to index.html if the file doesn't exist (SPA route)
  app.use("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    try {
      const indexPath = path.resolve(distPath, "index.html");
      const raw = fs.readFileSync(indexPath, "utf-8");
      const html = injectMarketingPlaceholders(raw);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (e: any) {
      res.status(500).send(`<!-- index.html error: ${e?.message || e} -->`);
    }
  });
}
