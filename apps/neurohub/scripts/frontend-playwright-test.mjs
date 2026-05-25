#!/usr/bin/env node
// Eugene 2026-05-25 — Playwright real-headless-browser движок для Фронт-тестера.
//
// === ЖЁСТКАЯ БЕЗОПАСНОСТЬ (event-loop safety) ===
// Этот скрипт — STANDALONE node-процесс (ESM). Сервер НИКОГДА его НЕ импортирует
// — только spawn'ит через child_process с hard-timeout и читает stdout как JSON.
// Поэтому запуск Playwright (тяжёлый, блокирующий I/O) идёт В ОТДЕЛЬНОМ процессе
// и НИКОГДА не висит в Express/Node event loop.
//
// === GRACEFUL-SKIP ===
// Если пакет `playwright` не установлен ИЛИ chromium.launch() падает (браузер не
// скачан на VPS), скрипт выходит с кодом 0 и печатает {skipped:true, reason}.
// Сервер логирует и пропускает Playwright-движок — синтетические fetch-проверки
// Фронт-тестера продолжают работать. НИКОГДА не крашит агента/сервер.
//
// Печатает в stdout ровно ОДНУ строку JSON:
//   { ok, skipped, reason?, issues: [{page, kind, message}], checkedAt }
// Всегда exit(0). Браузер закрывается в finally.

const BASE_URL = String(process.env.PUBLIC_URL || "https://muzaai.ru").replace(/\/+$/, "");
const PATHS = ["/", "/music", "/lyrics", "/dashboard"];

// Лимиты — чтобы скрипт не висел дольше child-process timeout (90s) на стороне агента.
const NAV_TIMEOUT_MS = 15000; // на одну страницу
const POST_LOAD_WAIT_MS = 1500; // дать времени React смонтироваться + ошибкам всплыть
const MAX_ISSUES = 200; // защита от бесконечного списка

function out(obj) {
  // Одна строка JSON в stdout — сервер парсит её. Никаких других print'ов в stdout.
  process.stdout.write(JSON.stringify({ checkedAt: new Date().toISOString(), ...obj }));
}

async function main() {
  // 1) Динамический импорт playwright — если не установлен, graceful-skip.
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (e) {
    out({ ok: true, skipped: true, reason: "playwright_not_installed", issues: [] });
    return;
  }

  // 2) Запуск браузера — если chromium не скачан, graceful-skip.
  let browser = null;
  const issues = [];
  const pushIssue = (page, kind, message) => {
    if (issues.length >= MAX_ISSUES) return;
    issues.push({ page, kind, message: String(message || "").slice(0, 600) });
  };

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (e) {
    out({
      ok: true,
      skipped: true,
      reason: "chromium_launch_failed: " + String(e?.message || e).slice(0, 200),
      issues: [],
    });
    return;
  }

  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: "MuzaAi-FrontendQA-Playwright/1.0",
    });

    for (const path of PATHS) {
      const fullUrl = `${BASE_URL}${path}`;
      let page = null;
      try {
        page = await context.newPage();

        // Слушатели до навигации — ловим всё с момента загрузки.
        page.on("console", (msg) => {
          try {
            if (msg.type() === "error") {
              pushIssue(path, "console-error", `Console error: ${msg.text()}`);
            }
          } catch {
            /* ignore */
          }
        });
        page.on("pageerror", (err) => {
          pushIssue(path, "pageerror", `Uncaught: ${err?.message || String(err)}`);
        });
        page.on("requestfailed", (req) => {
          try {
            const f = req.failure();
            pushIssue(path, "requestfailed", `Request failed: ${req.method()} ${req.url()} — ${f?.errorText || "unknown"}`);
          } catch {
            /* ignore */
          }
        });
        page.on("response", (resp) => {
          try {
            const st = resp.status();
            if (st >= 400) {
              pushIssue(path, "http-error", `HTTP ${st}: ${resp.url()}`);
            }
          } catch {
            /* ignore */
          }
        });

        await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        // Дать React смонтироваться + асинхронным ошибкам всплыть.
        await page.waitForTimeout(POST_LOAD_WAIT_MS);

        // Детект пустого/чёрного рендера: #root без дочерних узлов.
        try {
          const rootChildren = await page.evaluate(() => {
            const r = document.getElementById("root");
            return r ? r.childElementCount : -1;
          });
          if (rootChildren === -1) {
            pushIssue(path, "blank-render", `Нет элемента #root на странице (фронт не смонтировался)`);
          } else if (rootChildren === 0) {
            pushIssue(path, "blank-render", `#root пуст (белый/чёрный экран — React не отрендерил контент)`);
          }
        } catch (e) {
          pushIssue(path, "blank-render", `Не удалось проверить #root: ${String(e?.message || e).slice(0, 150)}`);
        }
      } catch (e) {
        // Навигация упала (timeout / net) — это findable баг страницы.
        pushIssue(path, "navigation", `Страница не открылась: ${String(e?.message || e).slice(0, 200)}`);
      } finally {
        try {
          if (page) await page.close();
        } catch {
          /* ignore */
        }
      }
    }

    out({ ok: true, skipped: false, issues });
  } catch (e) {
    // Любая непредвиденная ошибка — отдаём то что собрали, не крашим.
    out({ ok: false, skipped: false, reason: String(e?.message || e).slice(0, 200), issues });
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      /* ignore */
    }
  }
}

// Глобальная защита: при любой ошибке/таймауте — exit(0) с graceful JSON.
main()
  .catch((e) => {
    try {
      out({ ok: false, skipped: true, reason: "fatal: " + String(e?.message || e).slice(0, 200), issues: [] });
    } catch {
      /* ignore */
    }
  })
  .finally(() => {
    // Гарантированно завершаем процесс (Playwright может держать handles).
    process.exit(0);
  });
