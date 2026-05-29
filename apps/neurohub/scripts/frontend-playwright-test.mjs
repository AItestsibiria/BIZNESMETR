#!/usr/bin/env node
// Eugene 2026-05-25 — Playwright real-headless-browser движок для Фронт-тестера.
//
// === МУЛЬТИ-УСТРОЙСТВА (Eugene 2026-05-25 «пусть прогонит Фронт через разные устройства») ===
// Прогон каждой страницы под несколькими device-профилями (desktop, mobile
// portrait/landscape, tablet) — viewport + UA + touch как у реального гаджета.
// Так ловим device-specific баги (обрезка под notch, overlap FAB, iOS-рендер,
// см. Device-fit-100 + Layout-fit-no-overlap rules). Имя устройства — в message.
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
// === WALL-CLOCK BUDGET ===
// Матрица device×path может быть большой. Перед каждой страницей проверяем
// бюджет (78s < child-timeout 90s) — при превышении останавливаемся и отдаём
// то, что успели собрать (partial:true). Браузер всегда закрывается в finally.
//
// Печатает в stdout ровно ОДНУ строку JSON:
//   { ok, skipped, partial?, reason?, devicesTested, issues: [{page, kind, message}], checkedAt }
// Всегда exit(0).

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Eugene 2026-05-29 (предложение #3 из аудита): версия chromium на VPS может не
// совпадать с версией пакета playwright → default launch падает, реальный прогон
// молча пропускается. Ищем ЛЮБОЙ установленный chromium и запускаем через
// executablePath, чтобы Фрон-агент прогонялся даже при рассинхроне версий.
function findInstalledChromium() {
  try {
    const roots = [];
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
    roots.push(join(homedir(), ".cache", "ms-playwright"));
    for (const root of roots) {
      if (!existsSync(root)) continue;
      const dirs = readdirSync(root).filter((d) => d.startsWith("chromium")).sort().reverse();
      for (const d of dirs) {
        for (const c of [
          join(root, d, "chrome-linux", "chrome"),
          join(root, d, "chrome-linux", "headless_shell"),
        ]) {
          if (existsSync(c)) return c;
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

const BASE_URL = String(process.env.PUBLIC_URL || "https://muzaai.ru").replace(/\/+$/, "");
// Все окна генерации (Босс 2026-05-28 «пусть Фронт проверит все окна генерации»):
// режимы /music (basic/audio/advanced) + /lyrics. ?voice=female форсирует
// открытие расширенной панели (prefilled → showAdvanced) — проверяем её структуру.
const PATHS = [
  "/",
  "/music?tab=basic",
  "/music?tab=audio",
  "/music?tab=advanced&voice=female",
  "/lyrics",
  "/dashboard",
];

// Лимиты — чтобы скрипт не висел дольше child-process timeout (90s) на стороне агента.
const NAV_TIMEOUT_MS = 15000; // на одну страницу
const POST_LOAD_WAIT_MS = 1200; // дать времени React смонтироваться + ошибкам всплыть
const MAX_ISSUES = 300; // защита от бесконечного списка
const BUDGET_MS = 78000; // общий бюджет на весь прогон (< child-timeout 90s)
const QA_UA_MARKER = " MuzaAi-FrontendQA"; // метка QA-трафика, добавляется к UA устройства

const startedAt = Date.now();
const elapsed = () => Date.now() - startedAt;

function out(obj) {
  // Одна строка JSON в stdout — сервер парсит её. Никаких других print'ов в stdout.
  process.stdout.write(JSON.stringify({ checkedAt: new Date().toISOString(), ...obj }));
}

// Строим список device-профилей. Используем встроенные playwright `devices`
// где доступны (реальные UA/viewport/dpr), с ручным fallback если имя в данной
// версии playwright отсутствует — никогда не падаем из-за отсутствия профиля.
function buildDeviceProfiles(devices) {
  const pick = (name, fallback) => {
    const d = devices && devices[name] ? { ...devices[name] } : null;
    return d || fallback;
  };
  const profiles = [
    {
      label: "Десктоп 1280",
      ctx: {
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    },
    {
      label: "iPhone SE портрет",
      ctx: pick("iPhone SE", {
        viewport: { width: 375, height: 667 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
      }),
    },
    {
      label: "iPhone 14 Pro Max портрет",
      ctx: pick("iPhone 14 Pro Max", {
        viewport: { width: 430, height: 932 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
      }),
    },
    {
      label: "iPhone альбомная",
      ctx: pick("iPhone 13 landscape", {
        viewport: { width: 844, height: 390 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
      }),
    },
    {
      label: "iPad портрет",
      ctx: pick("iPad (gen 7)", {
        viewport: { width: 768, height: 1024 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
      }),
    },
    // Eugene 2026-05-29 (предложение #4): реальный Android-профиль + альбомный планшет.
    {
      label: "Pixel 7 (Android)",
      ctx: pick("Pixel 7", {
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2.625,
        isMobile: true,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      }),
    },
    {
      label: "iPad альбомная",
      ctx: pick("iPad (gen 7) landscape", {
        viewport: { width: 1024, height: 768 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
      }),
    },
  ];
  // Добавляем QA-метку к UA каждого профиля (чтобы сервер мог отличить QA-трафик).
  for (const p of profiles) {
    try {
      p.ctx.ignoreHTTPSErrors = true;
      p.ctx.userAgent = String(p.ctx.userAgent || "").concat(QA_UA_MARKER);
    } catch {
      /* ignore */
    }
  }
  return profiles;
}

async function main() {
  // 1) Динамический импорт playwright — если не установлен, graceful-skip.
  let chromium, devices;
  try {
    ({ chromium, devices } = await import("playwright"));
  } catch (e) {
    out({ ok: true, skipped: true, reason: "playwright_not_installed", devicesTested: [], issues: [] });
    return;
  }

  // 2) Запуск браузера — если chromium не скачан, graceful-skip.
  let browser = null;
  const issues = [];
  const pushIssue = (device, page, kind, message) => {
    if (issues.length >= MAX_ISSUES) return;
    // Имя устройства — внутри message (контракт JSON {page,kind,message} не меняем,
    // сервер парсит как раньше; устройство видно в отчёте Директора).
    issues.push({
      page,
      kind,
      message: `[${device}] ${String(message || "").slice(0, 560)}`,
    });
  };

  const launchOpts = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  };
  try {
    browser = await chromium.launch(launchOpts);
  } catch (e) {
    // Версия chromium рассинхронена с пакетом → пробуем найти установленный и
    // запустить через executablePath (предложение #3).
    const alt = findInstalledChromium();
    if (alt) {
      try {
        browser = await chromium.launch({ ...launchOpts, executablePath: alt });
      } catch (e2) {
        out({
          ok: true,
          skipped: true,
          reason: "chromium_launch_failed (alt): " + String(e2?.message || e2).slice(0, 180),
          devicesTested: [],
          issues: [],
        });
        return;
      }
    }
  }
  if (!browser) {
    out({
      ok: true,
      skipped: true,
      reason: "chromium_launch_failed (no browser/executable found)",
      devicesTested: [],
      issues: [],
    });
    return;
  }

  const profiles = buildDeviceProfiles(devices);
  const devicesTested = [];
  let partial = false;

  try {
    for (const profile of profiles) {
      // Бюджет: если времени почти не осталось — останавливаемся (partial).
      if (elapsed() > BUDGET_MS) {
        partial = true;
        break;
      }
      let context = null;
      try {
        context = await browser.newContext(profile.ctx);
      } catch (e) {
        pushIssue(profile.label, "/", "device-context", `Не удалось создать контекст устройства: ${String(e?.message || e).slice(0, 150)}`);
        continue;
      }
      devicesTested.push(profile.label);

      for (const pth of PATHS) {
        if (elapsed() > BUDGET_MS) {
          partial = true;
          break;
        }
        const fullUrl = `${BASE_URL}${pth}`;
        let page = null;
        try {
          page = await context.newPage();

          // Слушатели до навигации — ловим всё с момента загрузки.
          page.on("console", (msg) => {
            try {
              if (msg.type() === "error") {
                pushIssue(profile.label, pth, "console-error", `Ошибка в консоли браузера: ${msg.text()}`);
              }
            } catch {
              /* ignore */
            }
          });
          page.on("pageerror", (err) => {
            pushIssue(profile.label, pth, "pageerror", `Необработанное исключение на странице: ${err?.message || String(err)}`);
          });
          page.on("requestfailed", (req) => {
            try {
              const f = req.failure();
              pushIssue(profile.label, pth, "requestfailed", `Запрос не выполнен: ${req.method()} ${req.url()} — ${f?.errorText || "причина неизвестна"}`);
            } catch {
              /* ignore */
            }
          });
          page.on("response", (resp) => {
            try {
              const st = resp.status();
              if (st >= 400) {
                pushIssue(profile.label, pth, "http-error", `Ответ сервера HTTP ${st}: ${resp.url()}`);
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
              pushIssue(profile.label, pth, "blank-render", `Нет элемента #root на странице (фронт не смонтировался)`);
            } else if (rootChildren === 0) {
              pushIssue(profile.label, pth, "blank-render", `#root пуст (белый/чёрный экран — React не отрендерил контент)`);
            }
          } catch (e) {
            pushIssue(profile.label, pth, "blank-render", `Не удалось проверить #root: ${String(e?.message || e).slice(0, 150)}`);
          }

          // Горизонтальный overflow: контент шире вьюпорта = что-то вылезает за
          // края (Layout-fit-no-overlap rule). Допуск 2px на скроллбар/округление.
          try {
            const overflowPx = await page.evaluate(() => {
              const de = document.documentElement;
              return Math.max(0, (de.scrollWidth || 0) - (de.clientWidth || 0));
            });
            if (overflowPx > 2) {
              pushIssue(profile.label, pth, "overflow-x", `Горизонтальный overflow ${overflowPx}px (контент шире экрана — что-то вылезает за края)`);
            }
          } catch {
            /* ignore */
          }
        } catch (e) {
          // Навигация упала (timeout / net) — это findable баг страницы.
          pushIssue(profile.label, pth, "navigation", `Страница не открылась: ${String(e?.message || e).slice(0, 200)}`);
        } finally {
          try {
            if (page) await page.close();
          } catch {
            /* ignore */
          }
        }
      }

      try {
        if (context) await context.close();
      } catch {
        /* ignore */
      }
    }

    out({ ok: true, skipped: false, partial, devicesTested, issues });
  } catch (e) {
    // Любая непредвиденная ошибка — отдаём то что собрали, не крашим.
    out({ ok: false, skipped: false, partial, devicesTested, reason: String(e?.message || e).slice(0, 200), issues });
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
      out({ ok: false, skipped: true, reason: "fatal: " + String(e?.message || e).slice(0, 200), devicesTested: [], issues: [] });
    } catch {
      /* ignore */
    }
  })
  .finally(() => {
    // Гарантированно завершаем процесс (Playwright может держать handles).
    process.exit(0);
  });
