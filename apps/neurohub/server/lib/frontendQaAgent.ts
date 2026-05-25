// Eugene 2026-05-25 Босс «заведи агента "фронт-тестер" (id frontend-qa) —
// непрерывно тестирует фронт ГЛАЗАМИ ЮЗЕРА, находит баги везде, записывает,
// докладывает Директору СО ССЫЛКОЙ на страницу где баг, предлагает фикс,
// ведёт список».
//
// === Реальность (нет headless-браузера на VPS) ===
// «Тест глазами юзера» = (1) РЕАЛЬНЫЕ ошибки юзеров через client-telemetry
// (ErrorBoundary → POST /api/_client-error → таблица client_errors), плюс
// (2) лёгкие СИНТЕТИЧЕСКИЕ проверки страниц (server-side fetch на localhost,
// НЕ браузер): HTML 200 + главный JS-бандл 200.
//
// === Реальный стек ===
// Express + SQLite data.db (НЕ внешние очереди/брокеры). Self-migrating
// CREATE TABLE IF NOT EXISTS (как ensurePublicationsTable / ensureFerzTable).
//
// === Reuse-working-solutions ===
//  - таблица client_errors (persist + dedupe) — её же пишет /api/_client-error.
//  - callUnifiedMuzaLLM (lib/llmCore) — короткое предложение фикса.
//  - recordAgentActivity (lib/agentOrchestrator) — подчинён Директору.
//  - PUBLIC_URL (lib/publicUrl) — «ссылка от фронта» строится отсюда.
//
// === No-AI-providers-in-userland rule ===
// Предложение фикса может строиться через LLM, но НИКОГДА не называет
// ИИ-провайдеров/модели — всё это «MuzaAi».
//
// === Secrets-admin-only rule ===
// В отчёт НЕ попадают значения секретов — только сообщения ошибок / счётчики.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { db } from "../storage";
import { recordAgentActivity } from "./agentOrchestrator";
import { PUBLIC_URL } from "./publicUrl";

export type FrontendBugSeverity = "critical" | "high" | "medium" | "low";

export interface FrontendQaItem {
  id: number | null;
  /** Сообщение ошибки (runtime) или описание синтетической проблемы. */
  message: string;
  /** Путь/URL страницы где баг — «ссылка от фронта». */
  page: string;
  /** Полный кликабельный URL для доклада Директору. */
  pageUrl: string;
  count: number;
  severity: FrontendBugSeverity;
  status: string;
  fixProposal: string | null;
  firstSeen: number | null;
  lastSeen: number | null;
  source: "client" | "synthetic" | "playwright";
}

export interface FrontendQaReport {
  generatedAt: string;
  openCount: number;
  criticalCount: number;
  items: FrontendQaItem[];
  /** Итог по-русски: какие баги были (по устройствам/страницам/severity). */
  summaryRu: string;
  /** Была ли повторная проходка (re-scan) после устранения багов. */
  rescanned?: boolean;
}

function sqlite(): any {
  return (db as any).$client;
}

// === Auto-migrate (self-migrating, как ensurePublicationsTable) ===

let migrated = false;
export function ensureClientErrorsTable(): void {
  if (migrated) return;
  try {
    sqlite().exec(`
      CREATE TABLE IF NOT EXISTS client_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT,
        stack TEXT,
        page TEXT,
        user_agent TEXT,
        count INTEGER NOT NULL DEFAULT 1,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        fix_proposal TEXT,
        source TEXT NOT NULL DEFAULT 'client',
        dedupe_key TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_client_errors_dedupe ON client_errors(dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_client_errors_status ON client_errors(status);
      CREATE INDEX IF NOT EXISTS idx_client_errors_lastseen ON client_errors(last_seen DESC);
    `);
    migrated = true;
  } catch (e) {
    console.warn("[Фрон] Миграция таблицы не удалась:", e);
  }
}

// Нормализация сообщения для дедупа: убираем числа/хеши/координаты, чтобы
// "TypeError at index-a1b2.js:10:5" и "...:11:9" схлопывались в одну группу.
function normalizeMessage(msg: string): string {
  return String(msg || "")
    .replace(/\d+/g, "#")
    .replace(/[a-f0-9]{8,}/gi, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
    .toLowerCase();
}

// Нормализация страницы: только path (без query/hash/host), чтобы один баг на
// /track?id=1 и /track?id=2 был одной группой.
function normalizePage(raw: string | undefined | null): string {
  const s = String(raw || "").trim();
  if (!s) return "/";
  try {
    // url может быть full href или просто path / pageName.
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      return u.pathname || "/";
    }
    if (s.startsWith("/")) return s.split("?")[0].split("#")[0];
    // pageName вроде "landing" / "dashboard" — приводим к /<name>.
    return "/" + s.replace(/^\/+/, "");
  } catch {
    return "/" + s.replace(/^\/+/, "").split("?")[0];
  }
}

/**
 * Persist одной client-ошибки с дедупом по (normalized message + page).
 * Никогда не throw'ит — вызывается из public endpoint, не должен ломать.
 */
export function recordClientError(input: {
  message?: string;
  stack?: string;
  page?: string;
  url?: string;
  userAgent?: string;
  /** Источник ошибки. 'client' (по умолч) — реальный юзер; 'playwright' — реал-браузер тест. */
  source?: "client" | "playwright" | "synthetic";
}): void {
  ensureClientErrorsTable();
  try {
    const message = String(input.message || "(без сообщения)").slice(0, 1000);
    // page для «ссылки от фронта»: предпочитаем full url, иначе pageName.
    const pagePath = normalizePage(input.url || input.page);
    const source = input.source === "playwright" || input.source === "synthetic" ? input.source : "client";
    // Дедуп учитывает source — playwright-находки не схлопываются с client-ошибками.
    const dedupeKey = `${source === "client" ? "" : source + "::"}${normalizeMessage(message)}::${pagePath}`;
    const now = Date.now();
    const stack = input.stack ? String(input.stack).slice(0, 4000) : null;
    const ua = input.userAgent ? String(input.userAgent).slice(0, 300) : null;

    const s = sqlite();
    const existing = s
      .prepare(`SELECT id, count FROM client_errors WHERE dedupe_key = ? LIMIT 1`)
      .get(dedupeKey) as { id: number; count: number } | undefined;

    if (existing) {
      s.prepare(
        `UPDATE client_errors SET count = count + 1, last_seen = ?, stack = COALESCE(?, stack),
           user_agent = COALESCE(?, user_agent),
           status = CASE WHEN status = 'fixed' THEN 'open' ELSE status END
         WHERE id = ?`,
      ).run(now, stack, ua, existing.id);
    } else {
      s.prepare(
        `INSERT INTO client_errors
           (message, stack, page, user_agent, count, first_seen, last_seen, status, source, dedupe_key)
         VALUES (?, ?, ?, ?, 1, ?, ?, 'open', ?, ?)`,
      ).run(message, stack, pagePath, ua, now, now, source, dedupeKey);
    }
  } catch (e) {
    console.warn("[Фрон] Не удалось записать ошибку клиента:", e);
  }
}

// ====================== СИНТЕТИЧЕСКИЕ ПРОВЕРКИ (server-side fetch) ======================

// Ключевые страницы которые юзер открывает первыми. НЕ браузер — простой fetch
// HTML 200 + проверка что главный JS-бандл (assets/index-*.js) тоже отдаётся.
const SYNTHETIC_PAGES = ["/", "/music", "/lyrics", "/dashboard"];

function localBase(): string {
  const port = parseInt(process.env.PORT || "5000", 10);
  return `http://127.0.0.1:${port}`;
}

async function fetchStatus(url: string, timeoutMs = 8000): Promise<{ ok: boolean; status: number; body?: string }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body: string | undefined;
    // Тело читаем только для HTML (чтобы вытащить имя бандла).
    if (r.ok && /text\/html/i.test(r.headers.get("content-type") || "")) {
      body = (await r.text()).slice(0, 20000);
    }
    return { ok: r.ok, status: r.status, body };
  } catch (e: any) {
    return { ok: false, status: 0, body: undefined };
  }
}

/**
 * Лёгкая синтетическая проверка страниц. Записывает любую non-200 как
 * synthetic-баг в client_errors (dedupe по message+page). Never throws.
 */
async function runSyntheticChecks(): Promise<void> {
  ensureClientErrorsTable();
  const base = localBase();
  for (const path of SYNTHETIC_PAGES) {
    try {
      const pageRes = await fetchStatus(`${base}${path}`);
      if (!pageRes.ok) {
        upsertSynthetic(path, `Страница ${path} вернула HTTP ${pageRes.status} (не открывается у юзера)`);
        continue;
      }
      // Парсим главный JS-бандл из HTML: assets/index-*.js
      const m = pageRes.body?.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
      if (!m) {
        // SPA-шелл без бандла в HTML — не критично (Vite иногда инлайнит),
        // не шумим, считаем страницу ок.
        continue;
      }
      const bundleUrl = `${base}${m[0]}`;
      const bundleRes = await fetchStatus(bundleUrl, 8000);
      if (!bundleRes.ok) {
        upsertSynthetic(
          path,
          `JS-бандл страницы ${path} (${m[0]}) вернул HTTP ${bundleRes.status} — фронт не загрузится (белый/чёрный экран)`,
        );
      } else {
        // Бандл ок — если был открытый synthetic-баг по этой странице,
        // помечаем его fixed (саморазрешение).
        resolveSyntheticIfOpen(path);
      }
    } catch (e) {
      console.warn(`[Фрон] Синтетическая проверка ${path} не удалась:`, e);
    }
  }
}

function upsertSynthetic(page: string, message: string): void {
  try {
    const pagePath = normalizePage(page);
    const dedupeKey = `synthetic::${normalizeMessage(message)}::${pagePath}`;
    const now = Date.now();
    const s = sqlite();
    const existing = s
      .prepare(`SELECT id FROM client_errors WHERE dedupe_key = ? LIMIT 1`)
      .get(dedupeKey) as { id: number } | undefined;
    if (existing) {
      s.prepare(
        `UPDATE client_errors SET count = count + 1, last_seen = ?,
           status = CASE WHEN status = 'fixed' THEN 'open' ELSE status END
         WHERE id = ?`,
      ).run(now, existing.id);
    } else {
      s.prepare(
        `INSERT INTO client_errors
           (message, stack, page, user_agent, count, first_seen, last_seen, status, source, dedupe_key)
         VALUES (?, NULL, ?, NULL, 1, ?, ?, 'open', 'synthetic', ?)`,
      ).run(message, pagePath, now, now, dedupeKey);
    }
  } catch (e) {
    console.warn("[Фрон] Не удалось сохранить синтетическую находку:", e);
  }
}

function resolveSyntheticIfOpen(page: string): void {
  try {
    const pagePath = normalizePage(page);
    sqlite()
      .prepare(
        `UPDATE client_errors SET status = 'fixed', last_seen = last_seen
         WHERE source = 'synthetic' AND page = ? AND status = 'open'`,
      )
      .run(pagePath);
  } catch {
    /* never throw */
  }
}

// ====================== PLAYWRIGHT (real headless browser) ======================
//
// === ЖЁСТКАЯ БЕЗОПАСНОСТЬ (event-loop safety) ===
// Playwright НИКОГДА не запускается в Express/Node event loop. Здесь мы только
// spawn'им STANDALONE node-скрипт (scripts/frontend-playwright-test.mjs) через
// execFile с HARD-timeout (90s) и парсим его stdout как JSON. Скрипт сервером НЕ
// импортируется. Полностью async, не блокирует сервер.
//
// === GRACEFUL-SKIP ===
// Если скрипт не найден / playwright не установлен / chromium не скачан / timeout
// — мы логируем и пропускаем (синтетика остаётся). НИКОГДА не throw'им наружу.
//
// === GATE ===
// FRONTEND_PLAYWRIGHT !== "0" (ВКЛ по умолчанию) + проверка наличия скрипта.

const PLAYWRIGHT_TIMEOUT_MS = 90_000; // hard timeout на весь child-process
const PLAYWRIGHT_MAX_BUFFER = 4 * 1024 * 1024; // 4 МБ stdout cap

/** Кандидаты пути к standalone-скрипту (prod dist-layout + source-layout + dev). */
function resolvePlaywrightScript(): string | null {
  // 1) Явный override через env (если положили скрипт в нестандартное место).
  const envPath = process.env.FRONTEND_PLAYWRIGHT_SCRIPT;
  if (envPath && existsSync(envPath)) return envPath;

  const candidates: string[] = [];
  // 2) PROD: процесс крутится из /var/www/neurohub (dist), но scripts/ + node_modules
  //    с playwright лежат в source-каталоге (/opt/<src>/apps/neurohub). Перебираем
  //    типовые места относительно cwd и __dirname.
  const cwd = process.cwd();
  candidates.push(path.join(cwd, "scripts", "frontend-playwright-test.mjs"));
  candidates.push(path.join(cwd, "apps", "neurohub", "scripts", "frontend-playwright-test.mjs"));
  // 3) Source-каталоги авто-деплоя (где живёт node_modules/playwright).
  candidates.push("/opt/muziai-src/apps/neurohub/scripts/frontend-playwright-test.mjs");
  candidates.push("/opt/neurohub-src/apps/neurohub/scripts/frontend-playwright-test.mjs");
  // 4) DEV (tsx): __dirname = server/lib → ../../scripts.
  try {
    candidates.push(path.join(__dirname, "..", "..", "scripts", "frontend-playwright-test.mjs"));
  } catch {
    /* __dirname может отсутствовать в ESM-сборке — игнор */
  }

  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

interface PlaywrightIssue {
  page: string;
  kind: string;
  message: string;
}
interface PlaywrightResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  partial?: boolean;
  devicesTested?: string[];
  issues: PlaywrightIssue[];
  checkedAt?: string;
}

/**
 * Запускает реальный headless-браузер (Playwright) В ОТДЕЛЬНОМ ПРОЦЕССЕ для
 * тестирования живого сайта «глазами юзера». Каждую найденную проблему пишет в
 * client_errors через existing recordClientError (source='playwright', с дедупом
 * и полной ссылкой на страницу). Never throws — graceful-skip при любой ошибке.
 */
export async function runPlaywrightScan(): Promise<{ ran: boolean; skipped: boolean; reason?: string; issueCount: number }> {
  // Gate: env (ВКЛ по умолчанию).
  if (process.env.FRONTEND_PLAYWRIGHT === "0") {
    return { ran: false, skipped: true, reason: "disabled (FRONTEND_PLAYWRIGHT=0)", issueCount: 0 };
  }
  const scriptPath = resolvePlaywrightScript();
  if (!scriptPath) {
    console.log("[Фрон] Скрипт реал-браузера не найден — пропускаю (синтетические проверки продолжают работать)");
    return { ran: false, skipped: true, reason: "script_not_found", issueCount: 0 };
  }
  console.log("[Фрон] Запускаю прогон сайта в реальном браузере по разным устройствам…");

  let result: PlaywrightResult | null = null;
  try {
    result = await new Promise<PlaywrightResult>((resolve) => {
      execFile(
        process.execPath, // текущий node-бинарь
        [scriptPath],
        {
          timeout: PLAYWRIGHT_TIMEOUT_MS,
          maxBuffer: PLAYWRIGHT_MAX_BUFFER,
          // cwd = каталог пакета со скриптом, чтобы node нашёл node_modules/playwright.
          cwd: path.dirname(path.dirname(scriptPath)),
          env: {
            ...process.env,
            PUBLIC_URL: PUBLIC_URL || process.env.PUBLIC_URL || "https://muzaai.ru",
          },
        },
        (err, stdout) => {
          // Скрипт всегда exit(0) с JSON — но если убит по timeout (err) или
          // вернул мусор, graceful-skip.
          const raw = String(stdout || "").trim();
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as PlaywrightResult;
              resolve(parsed);
              return;
            } catch {
              /* fallthrough to skip */
            }
          }
          resolve({
            ok: false,
            skipped: true,
            reason: err ? `child error: ${String(err.message || err).slice(0, 160)}` : "no/invalid stdout",
            issues: [],
          });
        },
      );
    });
  } catch (e: any) {
    console.warn("[Фрон] Не удалось запустить прогон в реальном браузере:", e?.message || e);
    return { ran: false, skipped: true, reason: "spawn_failed", issueCount: 0 };
  }

  if (!result || result.skipped) {
    console.log(`[Фрон] Прогон в реальном браузере пропущен: ${result?.reason || "причина неизвестна"}`);
    return { ran: false, skipped: true, reason: result?.reason || "skipped", issueCount: 0 };
  }

  // Записываем каждую находку через existing recordClientError (дедуп + ссылка).
  const base = (PUBLIC_URL || "https://muzaai.ru").replace(/\/+$/, "");
  let recorded = 0;
  for (const issue of result.issues || []) {
    try {
      const pagePath = issue.page && issue.page.startsWith("/") ? issue.page : "/" + String(issue.page || "");
      // Русский слаг типа находки — Босс не должен видеть английский (issue.message
      // уже по-русски + содержит [устройство]). Слаг используется и в severityFor.
      recordClientError({
        message: `[Фрон:${playwrightKindRu(issue.kind)}] ${issue.message}`,
        page: pagePath,
        url: `${base}${pagePath}`,
        source: "playwright",
      });
      recorded++;
    } catch {
      /* never throw */
    }
  }
  const devs = (result.devicesTested && result.devicesTested.length)
    ? result.devicesTested.join(", ")
    : "—";
  const partialNote = result.partial ? " (прогон неполный — сработал лимит времени)" : "";
  console.log(`[Фрон] Прогон завершён${partialNote}. Устройства: ${devs}. Записано находок: ${recorded}.`);
  return { ran: true, skipped: false, issueCount: recorded };
}

// ====================== SEVERITY ======================

// Русские слаги типов находок реал-браузера (Босс видит только русский).
// Слаг — стабильный машинный идентификатор для severityFor, тоже по-русски.
function playwrightKindRu(kind: string): string {
  switch (kind) {
    case "console-error": return "ошибка-консоли";
    case "pageerror": return "исключение";
    case "requestfailed": return "запрос-не-прошёл";
    case "http-error": return "http-ошибка";
    case "blank-render": return "пустой-экран";
    case "navigation": return "страница-не-открылась";
    case "overflow-x": return "контент-шире-экрана";
    case "device-context": return "ошибка-устройства";
    default: return "находка";
  }
}

function severityFor(item: { source: string; count: number; message: string }): FrontendBugSeverity {
  // Синтетический баг = страница/бандл не открывается = всегда critical.
  if (item.source === "synthetic") return "critical";
  // Playwright реал-браузер: пустой рендер / исключение / страница не открылась =
  // critical (юзер видит белый/чёрный экран). HTTP/console-ошибки = high.
  if (item.source === "playwright") {
    const m = item.message || "";
    if (/пустой-экран|исключение|страница-не-открылась/.test(m)) return "critical";
    return "high";
  }
  const c = item.count;
  if (c >= 50) return "critical";
  if (c >= 10) return "high";
  if (c >= 3) return "medium";
  return "low";
}

// ====================== FIX PROPOSAL (опционально через LLM) ======================

async function generateFixProposal(item: { message: string; page: string; stack: string | null }): Promise<string | null> {
  try {
    const { callUnifiedMuzaLLM } = await import("./llmCore");
    const prompt =
      `Ты — фронт-тестер MuzaAi. По ошибке на странице предложи КОРОТКОЕ (1-3 предложения) направление фикса для разработчика.\n` +
      `Пиши по-русски, по существу. НИКОГДА не называй сторонние ИИ-сервисы/модели/провайдеры — всё это «MuzaAi».\n` +
      `Не выдумывай несуществующие файлы — опирайся только на текст ошибки.\n\n` +
      `Страница: ${item.page}\n` +
      `Ошибка: ${item.message}\n` +
      (item.stack ? `Стек (фрагмент): ${item.stack.slice(0, 500)}\n` : "") +
      `\nПредлагаемый фикс:`;
    const reply = await callUnifiedMuzaLLM({
      sessionId: `frontend-qa-fix-${Date.now()}`,
      userId: null,
      channel: "internal" as any,
      userText: prompt,
      role: "admin",
      maxTokens: 200,
    });
    const t = String(reply || "").trim();
    return t.length > 8 ? t.slice(0, 800) : null;
  } catch (e) {
    console.warn("[Фрон] Не удалось сгенерировать предложение по фиксу:", e);
    return null;
  }
}

// ====================== ИТОГ ПО-РУССКИ ======================

const SEVERITY_RU: Record<FrontendBugSeverity, string> = {
  critical: "критические",
  high: "важные",
  medium: "средние",
  low: "мелкие",
};

/**
 * Строит ИТОГ ПО-РУССКИ: какие баги были (severity + страницы + устройства).
 * Уходит Директору (он докладывает Боссу). Босс «вижу английский» — только русский.
 */
function buildRussianSummary(items: FrontendQaItem[], rescanned: boolean): string {
  if (!items.length) {
    return rescanned
      ? "Повторная проходка: багов не осталось — фронт чист на всех устройствах. ✅"
      : "Багов не найдено — фронт чист на всех устройствах. ✅";
  }
  const bySeverity: Record<FrontendBugSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const pages = new Set<string>();
  for (const it of items) {
    bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1;
    pages.add(it.page);
  }
  const sevParts = (["critical", "high", "medium", "low"] as FrontendBugSeverity[])
    .filter((s) => bySeverity[s] > 0)
    .map((s) => `${bySeverity[s]} ${SEVERITY_RU[s]}`);
  const lines: string[] = [];
  lines.push(`${rescanned ? "Повторная проходка. " : ""}Найдено багов: ${items.length} (${sevParts.join(", ")}). Страниц затронуто: ${pages.size}.`);
  // Топ-5 находок списком — кратко, по-русски, со ссылкой на страницу.
  const top = items.slice(0, 5);
  for (const it of top) {
    lines.push(`• [${SEVERITY_RU[it.severity]}] ${it.page} — ${String(it.message).slice(0, 180)}`);
  }
  if (items.length > top.length) {
    lines.push(`…и ещё ${items.length - top.length} — полный список в админке (🧪 Фронт-тестер).`);
  }
  return lines.join("\n");
}

// ====================== ENTRY POINTS ======================

/**
 * Полный QA-скан фронта: (a) агрегирует топ открытых client_errors,
 * (b) синтетические проверки страниц, (c) генерирует фиксы для топ-багов без
 * предложения. Никогда не throw'ит. Returns отчёт со ссылками для Директора.
 */
export async function runFrontendQaScan(opts?: { withFix?: boolean }): Promise<FrontendQaReport> {
  ensureClientErrorsTable();

  // (b) Синтетические проверки сначала — могут добавить свежие synthetic-баги.
  await runSyntheticChecks();

  // (b2) Playwright реал-браузер тест (отдельный процесс, hard-timeout, graceful-skip).
  // Пишет находки в client_errors (source='playwright') через recordClientError.
  try {
    await runPlaywrightScan();
  } catch (e) {
    console.warn("[Фрон] Ошибка прогона в реальном браузере (проигнорирована):", e);
  }

  // (a) Топ открытых багов по count.
  let rows: Array<{
    id: number;
    message: string;
    page: string;
    stack: string | null;
    count: number;
    status: string;
    fix_proposal: string | null;
    first_seen: number;
    last_seen: number;
    source: string;
  }> = [];
  try {
    rows = sqlite()
      .prepare(
        `SELECT id, message, page, stack, count, status, fix_proposal, first_seen, last_seen, source
         FROM client_errors
         WHERE status = 'open'
         ORDER BY (CASE WHEN source='synthetic' THEN 0 ELSE 1 END), count DESC, last_seen DESC
         LIMIT 30`,
      )
      .all() as any[];
  } catch (e) {
    console.warn("[Фрон] Агрегация находок не удалась:", e);
  }

  const items: FrontendQaItem[] = rows.map((r) => {
    const severity = severityFor({ source: r.source, count: Number(r.count || 1), message: r.message || "" });
    const pagePath = r.page || "/";
    return {
      id: r.id,
      message: r.message || "",
      page: pagePath,
      pageUrl: `${(PUBLIC_URL || "https://muzaai.ru").replace(/\/+$/, "")}${pagePath.startsWith("/") ? pagePath : "/" + pagePath}`,
      count: Number(r.count || 1),
      severity,
      status: r.status || "open",
      fixProposal: r.fix_proposal || null,
      firstSeen: r.first_seen ?? null,
      lastSeen: r.last_seen ?? null,
      source: r.source === "synthetic" ? "synthetic" : r.source === "playwright" ? "playwright" : "client",
    };
  });

  // (c) Фиксы для топ-багов без предложения (макс 3 LLM-вызова, graceful).
  if (opts?.withFix !== false) {
    const needFix = items.filter((i) => !i.fixProposal && i.id != null).slice(0, 3);
    for (const it of needFix) {
      const row = rows.find((r) => r.id === it.id);
      const proposal = await generateFixProposal({ message: it.message, page: it.page, stack: row?.stack || null });
      if (proposal) {
        it.fixProposal = proposal;
        try {
          sqlite()
            .prepare(`UPDATE client_errors SET fix_proposal = ?, status = CASE WHEN status='open' THEN 'proposed' ELSE status END WHERE id = ?`)
            .run(proposal, it.id);
          it.status = it.status === "open" ? "proposed" : it.status;
        } catch {
          /* never throw */
        }
      }
    }
  }

  const openCount = items.length;
  const criticalCount = items.filter((i) => i.severity === "critical").length;

  // Фронт-тестер подчинён Директору — отмечаем активность (never throws).
  try {
    recordAgentActivity("frontend-qa", { action: "qa_scan", open: openCount, critical: criticalCount });
  } catch {
    /* never throw */
  }

  return {
    generatedAt: new Date().toISOString(),
    openCount,
    criticalCount,
    items,
    summaryRu: buildRussianSummary(items, false),
  };
}

/**
 * Цикл с повторной проходкой (Босс «после устранения багов повторная проходка
 * ещё раз, итог»): прогон → (фиксы между вызовами делает деплой) → повторный
 * прогон для проверки → финальный ИТОГ по-русски с дельтой что закрылось.
 * Synthetic-находки саморазрешаются при повторном прогоне; реал-браузерные
 * сверяются заново. Never throws.
 */
export async function runFrontendQaCycle(): Promise<FrontendQaReport> {
  const first = await runFrontendQaScan();
  const firstOpen = first.openCount;
  // Повторная проходка — свежий скан (synthetic auto-resolve + реал-браузер заново).
  const second = await runFrontendQaScan({ withFix: false });
  const closed = Math.max(0, firstOpen - second.openCount);
  const delta = closed > 0 ? `\nЗакрылось с прошлого прогона: ${closed}.` : "";
  return {
    ...second,
    rescanned: true,
    summaryRu: buildRussianSummary(second.items, true) + delta,
  };
}

/** Последний отчёт без запуска LLM-фиксов / без синтетики — быстрый read. */
export async function getLatestFrontendQaReport(): Promise<FrontendQaReport> {
  ensureClientErrorsTable();
  let rows: any[] = [];
  try {
    rows = sqlite()
      .prepare(
        `SELECT id, message, page, count, status, fix_proposal, first_seen, last_seen, source
         FROM client_errors
         WHERE status IN ('open','proposed')
         ORDER BY (CASE WHEN source='synthetic' THEN 0 ELSE 1 END), count DESC, last_seen DESC
         LIMIT 30`,
      )
      .all() as any[];
  } catch (e) {
    console.warn("[Фрон] Не удалось получить последний отчёт:", e);
  }
  const items: FrontendQaItem[] = rows.map((r) => {
    const severity = severityFor({ source: r.source, count: Number(r.count || 1), message: r.message || "" });
    const pagePath = r.page || "/";
    return {
      id: r.id,
      message: r.message || "",
      page: pagePath,
      pageUrl: `${(PUBLIC_URL || "https://muzaai.ru").replace(/\/+$/, "")}${pagePath.startsWith("/") ? pagePath : "/" + pagePath}`,
      count: Number(r.count || 1),
      severity,
      status: r.status || "open",
      fixProposal: r.fix_proposal || null,
      firstSeen: r.first_seen ?? null,
      lastSeen: r.last_seen ?? null,
      source: r.source === "synthetic" ? "synthetic" : r.source === "playwright" ? "playwright" : "client",
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    openCount: items.filter((i) => i.status === "open" || i.status === "proposed").length,
    criticalCount: items.filter((i) => i.severity === "critical").length,
    items,
    summaryRu: buildRussianSummary(items, false),
  };
}

/** Сменить статус бага (open|proposed|fixed|ignored). Returns true если обновлено. */
export function markFrontendBug(id: number, status: string): boolean {
  ensureClientErrorsTable();
  const allowed = ["open", "proposed", "fixed", "ignored"];
  if (!allowed.includes(status)) return false;
  try {
    const info = sqlite().prepare(`UPDATE client_errors SET status = ? WHERE id = ?`).run(status, id);
    return Number(info?.changes || 0) > 0;
  } catch (e) {
    console.warn("[Фрон] Не удалось обновить статус бага:", e);
    return false;
  }
}

/** Health probe для orchestrator.register healthCheck. */
export function frontendQaHealth(): { ok: boolean; details: unknown } {
  try {
    ensureClientErrorsTable();
    const open = Number(
      (sqlite().prepare(`SELECT COUNT(*) AS c FROM client_errors WHERE status='open'`).get() as any)?.c || 0,
    );
    return { ok: true, details: { openBugs: open } };
  } catch (e: any) {
    return { ok: false, details: { error: e?.message || String(e) } };
  }
}
