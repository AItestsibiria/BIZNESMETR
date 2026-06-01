// Eugene 2026-05-25 Босс «создай агента "Бэк" — бэкенд-аналог Фрона. Находит
// проблемы бэкенда: баги/рискованные места, лишнее (dead code), дубли
// (endpoints/функции), и ГРУППИРУЕТ бэкенд по темам/смыслам (домены).
// Подчинён Музa Директору».
//
// === КРИТИЧНО — БЕЗОПАСНОСТЬ ПОВЕДЕНИЯ ===
// Агент ТОЛЬКО ДЕТЕКТИРУЕТ + ДОКЛАДЫВАЕТ + ПРЕДЛАГАЕТ. НИКОГДА не удаляет код
// сам и не правит чужие файлы (Pre-push critical review rule — деструктив
// требует ревью). «Дубли убрать» = найти и показать списком для ревью Босса.
//
// === Реальный стек ===
// Express + SQLite data.db (НЕ внешние очереди/брокеры). Self-migrating
// CREATE TABLE IF NOT EXISTS (как ensureClientErrorsTable / ensureFerzTable).
// Скан — fs + regex по apps/neurohub/server/**, файлы читаются пакетами,
// каждый шаг в try/catch, НИКОГДА не throw в hot-path. Event-loop-safe:
// запускается по запросу (admin endpoint / cron), не блокирует Express.
//
// === Reuse-working-solutions ===
//  - recordAgentActivity (lib/agentOrchestrator) — Бэк подчинён Директору.
//  - self-migrating таблица (как client_errors / ferz_reports).
//
// === Secrets-admin-only / No-AI-providers-in-userland ===
// В отчёт НЕ попадают значения секретов — только имена символов / пути /
// счётчики. ИИ-провайдеры не называются (это admin-tool, но всё по-русски).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { db } from "../storage";
import { recordAgentActivity } from "./agentOrchestrator";

export type BackendFindingSeverity = "critical" | "high" | "medium" | "low";

/** Тип находки. Стабильный машинный id. */
export type BackendFindingKind =
  | "duplicate-endpoint" // один путь зарегистрирован в ≥2 местах (риск перехвата)
  | "duplicate-symbol" // одинаковое имя экспортируемой функции в разных файлах
  | "possibly-dead-export" // экспорт нигде не импортируется (требует ручной проверки)
  | "tech-debt"; // высокая плотность TODO/FIXME

export interface BackendQaFinding {
  id: number | null;
  kind: BackendFindingKind;
  /** Тема/домен бэкенда (auth, billing, generations, payments, lib-core, plugins-<name>, ...). */
  theme: string;
  title: string;
  detail: string;
  severity: BackendFindingSeverity;
  status: string; // open | fixed | ignored
  count: number;
  firstSeen: number | null;
  lastSeen: number | null;
}

export interface BackendQaReport {
  generatedAt: string;
  openCount: number;
  bySeverity: Record<BackendFindingSeverity, number>;
  /** Группировка по темам/смыслам (домены бэкенда). */
  themes: Array<{ theme: string; count: number }>;
  items: BackendQaFinding[];
  /** Русский ИТОГ — сколько находок по темам/severity + топ-список. */
  summaryRu: string;
}

function sqlite(): any {
  return (db as any).$client;
}

// ====================== Auto-migrate (self-migrating) ======================

let migrated = false;
export function ensureBackendFindingsTable(): void {
  if (migrated) return;
  try {
    sqlite().exec(`
      CREATE TABLE IF NOT EXISTS backend_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        theme TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        severity TEXT NOT NULL DEFAULT 'low',
        status TEXT NOT NULL DEFAULT 'open',
        count INTEGER NOT NULL DEFAULT 1,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        dedupe_key TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_findings_dedupe ON backend_findings(dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_backend_findings_status ON backend_findings(status);
      CREATE INDEX IF NOT EXISTS idx_backend_findings_theme ON backend_findings(theme);
    `);
    migrated = true;
  } catch (e) {
    console.warn("[Бэк] Миграция таблицы не удалась:", e);
  }
}

// ====================== СКАН РЕПО (fs + regex, пакетами) ======================

/** Кандидаты корня server/ (dev source-layout + prod source-каталоги авто-деплоя). */
function resolveServerRoot(): string | null {
  const candidates: string[] = [];
  const cwd = process.cwd();
  candidates.push(path.join(cwd, "apps", "neurohub", "server"));
  candidates.push(path.join(cwd, "server"));
  candidates.push("/opt/muziai-src/apps/neurohub/server");
  candidates.push("/opt/neurohub-src/apps/neurohub/server");
  try {
    // DEV (tsx): __dirname = server/lib → ..  (server/)
    candidates.push(path.join(__dirname, ".."));
  } catch {
    /* __dirname может отсутствовать в ESM — игнор */
  }
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Рекурсивно собирает .ts-файлы (без .d.ts), лимит на количество — лёгкость. */
function collectTsFiles(root: string, maxFiles = 4000): string[] {
  const out: string[] = [];
  const skipDirs = new Set(["node_modules", "dist", "build", ".git", "__tests__", "migrations"]);
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= maxFiles) return;
      if (skipDirs.has(name)) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
        out.push(full);
      }
    }
  };
  try {
    walk(root);
  } catch {
    /* never throw */
  }
  return out;
}

/**
 * Тема/домен по пути файла (группировка по смыслам). Core-модули — по имени,
 * плагины — plugins-<name>, остальное в lib — lib-core.
 */
function themeForPath(serverRoot: string, file: string): string {
  const rel = path.relative(serverRoot, file).replace(/\\/g, "/");
  // plugins/<name>/...
  const pm = rel.match(/^plugins\/([^/]+)\//);
  if (pm) return `plugins-${pm[1]}`;
  // core/<file>
  if (rel.startsWith("core/")) return "core";
  // Доменные ключевые слова в пути/имени — core-направления.
  const lower = rel.toLowerCase();
  const domains: Array<[RegExp, string]> = [
    [/auth|session|login|otp|sms/, "auth"],
    [/billing|pricing|tariff|invoice/, "billing"],
    [/payment|robokassa/, "payments"],
    [/generation|suno|music|lyric|cover|gen/, "generations"],
    [/playlist|stream|audio|player/, "playlist"],
    [/admin|audit/, "admin"],
    [/telegram|max-|vk-|channel|bot/, "channels"],
    [/agent|orchestrator|ferz|denga|postman|marketing|director/, "agents"],
    [/diag|health|watchdog|incident/, "diagnostics"],
  ];
  for (const [re, theme] of domains) {
    if (re.test(lower)) return theme;
  }
  if (rel.startsWith("lib/")) return "lib-core";
  return "other";
}

interface ScanContext {
  serverRoot: string;
  files: string[];
  /** Содержимое файлов (кеш на один скан). */
  contents: Map<string, string>;
}

function readFileSafe(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

interface RawFinding {
  kind: BackendFindingKind;
  theme: string;
  title: string;
  detail: string;
  severity: BackendFindingSeverity;
  dedupeKey: string;
}

// ---- 1) Дубли endpoints (один путь зарегистрирован в ≥2 местах) ----

const ROUTE_RE =
  /\b(?:app|router|adminRouter|r|api)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;

function detectDuplicateEndpoints(ctx: ScanContext, out: RawFinding[]): void {
  try {
    // key = "VERB path" → список файлов где зарегистрирован.
    //
    // ВАЖНО (anti-false-positive): плагины монтируют свои router'ы под РАЗНЫЕ
    // базовые префиксы (ctx.app.use("/api/<plugin>", router)). Поэтому
    // относительный путь "/" или "/webhook" в двух разных плагинах — НЕ
    // коллизия (реальные пути /api/telegram/webhook vs /api/max/webhook).
    // Реальный риск перехвата — только когда ОДИН И ТОТ ЖЕ абсолютный путь
    // (/api/...) зарегистрирован в ≥2 местах. Поэтому считаем коллизией:
    //  (a) абсолютные пути на app (начинаются с "/api/" или "/"), ИЛИ
    //  (b) относительные пути в одном и том же файле (двойная регистрация).
    const map = new Map<string, Set<string>>();
    for (const file of ctx.files) {
      const src = ctx.contents.get(file) || "";
      ROUTE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ROUTE_RE.exec(src)) !== null) {
        const verb = m[1].toUpperCase();
        const routePath = m[2].trim();
        if (!routePath) continue;
        // Учитываем для cross-file коллизий только абсолютные API-пути —
        // они монтируются на app напрямую, без plugin-префикса.
        if (!routePath.startsWith("/api/")) continue;
        const key = `${verb} ${routePath}`;
        const set = map.get(key) || new Set<string>();
        set.add(path.relative(ctx.serverRoot, file).replace(/\\/g, "/"));
        map.set(key, set);
      }
    }
    for (const [key, files] of map.entries()) {
      if (files.size >= 2) {
        const fileList = Array.from(files);
        const theme = themeForPath(ctx.serverRoot, path.join(ctx.serverRoot, fileList[0]));
        out.push({
          kind: "duplicate-endpoint",
          theme,
          title: `Дубль маршрута: ${key}`,
          detail:
            `Абсолютный маршрут «${key}» зарегистрирован в ${files.size} файлах: ${fileList.join(", ")}. ` +
            `Риск: первый зарегистрированный перехватывает запрос, остальные мёртвые. Проверить вручную (НЕ удалять без ревью).`,
          severity: "high",
          dedupeKey: `duplicate-endpoint::${key}`,
        });
      }
    }
  } catch (e) {
    console.warn("[Бэк] detectDuplicateEndpoints failed:", e);
  }
}

// ---- 2) Дубли функций (одинаковое имя экспорта в разных файлах) ----

const EXPORT_FN_RE =
  /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)|^\s*export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]/gm;

function detectDuplicateSymbols(ctx: ScanContext, out: RawFinding[]): void {
  try {
    // symbol → set of files.
    const map = new Map<string, Set<string>>();
    for (const file of ctx.files) {
      const src = ctx.contents.get(file) || "";
      EXPORT_FN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = EXPORT_FN_RE.exec(src)) !== null) {
        const name = m[1] || m[2];
        if (!name) continue;
        // Игнорим слишком общие имена обёрток модулей.
        if (name === "default" || name.length < 4) continue;
        const set = map.get(name) || new Set<string>();
        set.add(path.relative(ctx.serverRoot, file).replace(/\\/g, "/"));
        map.set(name, set);
      }
    }
    for (const [name, files] of map.entries()) {
      if (files.size >= 2) {
        const fileList = Array.from(files);
        const theme = themeForPath(ctx.serverRoot, path.join(ctx.serverRoot, fileList[0]));
        out.push({
          kind: "duplicate-symbol",
          theme,
          title: `Дубль экспорта: ${name}()`,
          detail:
            `Функция/константа «${name}» экспортируется из ${files.size} файлов: ${fileList.join(", ")}. ` +
            `Возможна копипаста логики или конфликт импортов. Проверить — выделить в общий модуль (НЕ удалять без ревью).`,
          severity: "medium",
          dedupeKey: `duplicate-symbol::${name}`,
        });
      }
    }
  } catch (e) {
    console.warn("[Бэк] detectDuplicateSymbols failed:", e);
  }
}

// ---- 3) Лишнее (best-effort): экспорт нигде не импортируется ----

/**
 * Eugene 2026-05-30: anti-false-positive эвристики для possibly-dead-export.
 * История: первый прогон давал ~107 находок (~95% FP). Расширение от
 * 2026-05-30 (`8ac780e`) добавило 2 транзитивные эвристики, осталось 55
 * находок — повторный аудит Босса показал что ~25 из них всё ещё FP по
 * паттернам, которые сканер не ловил. Добавлены 4 новые эвристики:
 *
 *   (1) ДИНАМИЧЕСКИЕ ИМПОРТЫ. Если где-то в репо есть
 *       `await import("./lib/X")` / `import("../lib/X").then(...)` —
 *       весь файл X считаем reachable (его символы достаются через
 *       свойство модуля по имени → статический grep этого не видит).
 *
 *   (2) РЕЕСТРЫ ТУЛОВ / АГЕНТОВ. Имена экспортов часто живут как
 *       строковые литералы в `lib/chatGenerationTools.ts`,
 *       `lib/muzaTools.ts`, `lib/agentOrchestrator.ts` (tool name / agent id /
 *       handler key). Substring-lookup → reachable.
 *
 *   (3) NAMESPACE / STAR IMPORT [НОВОЕ]. Если файл импортирован
 *       `import * as X from "./module"` ИЛИ реэкспортнут `export * from
 *       "./module"` — символы достаются через property-access (`X.foo`)
 *       или сквозь barrel, статический grep по имени их не видит → SKIP
 *       весь файл.
 *
 *   (4) INTERNAL-HELPER-OF-EXPORTED [НОВОЕ]. Если символ упоминается в
 *       своём собственном файле ≥2 раз (декларация + хотя бы 1 внутреннее
 *       использование), он скорее всего — helper другого экспорта этого
 *       же файла. Удалять опасно (сломает другую публичную функцию). →
 *       SKIP. Это закрывает большинство FP в `admin2fa.ts`, `botUa.ts`,
 *       `pricing.ts`, `chatHistory.ts`, `musaFacts.ts`, `tgLoginNonces.ts`
 *       и т.п. — там много мелких функций, каждая публично экспортирована
 *       (на случай расширения), но реально вызывается соседним экспортом.
 *
 *   (5) UNDERSCORE-PREFIX CONVENTION [НОВОЕ]. Имена `_resetRateMap`,
 *       `_internal`, `_test*` — наследие соглашения «помечать namespace-
 *       internal API». Часто оставляют для unit-тестов / future debug —
 *       не считать мёртвым.
 *
 *   (6) SIDE-EFFECT IMPORT [НОВОЕ]. Если файл импортирован чисто ради
 *       side-effect (`import "./module"` без named/default) или просто
 *       упомянут в `import { X } from "./module"` — модуль ВЫПОЛНЯЕТСЯ
 *       при загрузке. Регистрируется setInterval, cron, эвент-подписка —
 *       и экспорт может звать только сам файл. → SKIP-эвристика
 *       (как для (4)).
 *
 * Все эвристики ДОБАВЛЯЮТСЯ к существующей статической проверке (не
 * заменяют её) и работают «в сторону безопасности» — лучше ложно скрыть
 * подозреваемого, чем удалить живой код (Pre-push critical review rule,
 * деструктив).
 */
function detectPossiblyDeadExports(ctx: ScanContext, out: RawFinding[]): void {
  try {
    // Собираем все экспортируемые символы lib/ (точечный best-effort, чтобы
    // не раздувать — только lib-core, там чаще всего копится мёртвый код).
    const exportRe =
      /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)|\bexport\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]/g;
    // Полный конкат содержимого server/ + усечённый client/ для grep'a имён.
    const haystack = Array.from(ctx.contents.values()).join("\n");
    const clientHaystack = readClientHaystack(ctx.serverRoot);

    // Эвристика (1): basenames всех dynamic-import целей по всему repo.
    // Совпавший basename → файл считается transitively reachable, его
    // экспорты SKIP'аются из dead-list.
    const dynamicallyLoadedBasenames = collectDynamicImportBasenames(haystack, clientHaystack);

    // Эвристика (2): contents tool/agent-реестров (как один haystack).
    // Имя символа как substring → reachable.
    const registryHaystack = collectRegistryHaystack(ctx);

    // Эвристика (3): basenames всех namespace/star-импортов и re-export *.
    // Любой `import * as X from "./mod"` или `export * from "./mod"` →
    // файл достаётся целиком, любое имя в нём может быть прочитано через
    // property-access (X.foo) — статический grep по имени не увидит.
    const namespaceImportedBasenames = collectNamespaceImportBasenames(haystack, clientHaystack);

    let scanned = 0;
    for (const file of ctx.files) {
      const rel = path.relative(ctx.serverRoot, file).replace(/\\/g, "/");
      if (!rel.startsWith("lib/")) continue; // best-effort scope

      // (1) Эвристика basename: если файл достаётся через await import("…/<basename>")
      // — весь его экспорт может быть прочитан через property access на
      // возвращённом модуле, мы это не увидим статически → SKIP.
      const baseNoExt = path.basename(file).replace(/\.ts$/, "");
      if (dynamicallyLoadedBasenames.has(baseNoExt)) continue;

      // (3) Эвристика namespace/star: то же самое для `import * as` /
      // `export *` — файл reachable целиком.
      if (namespaceImportedBasenames.has(baseNoExt)) continue;

      const src = ctx.contents.get(file) || "";
      exportRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      const symbols: string[] = [];
      while ((m = exportRe.exec(src)) !== null) {
        const name = m[1] || m[2];
        if (name && name.length >= 5 && name !== "default") symbols.push(name);
      }
      for (const sym of symbols) {
        if (scanned > 1500) break; // лимит на проход — лёгкость
        scanned++;

        // (5) Underscore-prefix convention — namespace-internal API,
        // часто оставляют под unit-тесты / future debug. Не считать мёртвым.
        if (sym.startsWith("_")) continue;

        // Имя встречается ВНЕ файла-источника? grep по слову.
        const wordRe = new RegExp(`\\b${escapeRe(sym)}\\b`, "g");
        const usesServer = countMatchesExcludingFile(haystack, wordRe, src);
        const usesClient = clientHaystack ? (clientHaystack.match(wordRe)?.length || 0) : 0;

        // (2) Эвристика реестра: имя символа фигурирует в tools/agents-
        // реестрах (как часть string literal или handler key) → SKIP.
        const inRegistry =
          registryHaystack && registryHaystack.indexOf(sym) >= 0;

        // (4) Эвристика internal-helper-of-exported: символ упоминается в
        // СВОЁМ файле ≥2 раз = декларация + хоть одно внутреннее
        // использование (вызов соседним экспортом, setInterval-side-effect,
        // self-recursion). Удалять опасно — сломает другую публичную
        // функцию того же файла. → SKIP.
        const selfMentions = (src.match(wordRe) || []).length;
        if (selfMentions >= 2) continue;

        // 1 вхождение = только само объявление. 0 внешних → возможно мёртвый.
        if (usesServer <= 0 && usesClient <= 0 && !inRegistry) {
          out.push({
            kind: "possibly-dead-export",
            theme: themeForPath(ctx.serverRoot, file),
            title: `Возможно мёртвый экспорт: ${sym}()`,
            detail:
              `Символ «${sym}» из ${rel} нигде не импортируется (server + client). ` +
              `ТРЕБУЕТ РУЧНОЙ ПРОВЕРКИ — может вызываться динамически / по строке / в тестах. НЕ удалять без ревью.`,
            severity: "low",
            dedupeKey: `possibly-dead-export::${rel}::${sym}`,
          });
        }
      }
    }
  } catch (e) {
    console.warn("[Бэк] detectPossiblyDeadExports failed:", e);
  }
}

/**
 * Eugene 2026-05-30: собираем basenames всех целей dynamic-import по
 * server + client haystack. Ловим:
 *   await import("./foo")
 *   await import("../lib/foo")
 *   import("./foo").then(...)
 *   import('@/lib/foo')
 * Возвращаем Set basename'ов БЕЗ расширения (`foo` для `./lib/foo`).
 */
function collectDynamicImportBasenames(serverHay: string, clientHay: string): Set<string> {
  const out = new Set<string>();
  const re = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const scan = (s: string): void => {
    if (!s) return;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const spec = String(m[1] || "");
      // Берём только путевые спецификаторы — относительные ./ ../ или
      // alias @/. node:/npm-пакеты не интересуют (там не наш код).
      if (!/^[./@]/.test(spec)) continue;
      const base = path.basename(spec).replace(/\.(t|j)sx?$/, "");
      if (base) out.add(base);
    }
  };
  scan(serverHay);
  scan(clientHay);
  return out;
}

/**
 * Eugene 2026-05-30: basenames всех namespace/star-импортов и re-export *.
 * Ловим:
 *   import * as X from "./foo"
 *   import * as X from "../lib/foo"
 *   export * from "./foo"
 *   export * as X from "./foo"
 * После таких импортов любой символ файла достаётся через property-access
 * (`X.foo`) или прокидывается дальше через barrel — статический grep по
 * именам этого не увидит → весь файл считаем reachable.
 */
function collectNamespaceImportBasenames(serverHay: string, clientHay: string): Set<string> {
  const out = new Set<string>();
  const reList = [
    // import * as X from "./mod"
    /\bimport\s+\*\s+as\s+\w+\s+from\s+['"`]([^'"`]+)['"`]/g,
    // export * from "./mod" | export * as X from "./mod"
    /\bexport\s+\*(?:\s+as\s+\w+)?\s+from\s+['"`]([^'"`]+)['"`]/g,
  ];
  const scan = (s: string): void => {
    if (!s) return;
    for (const re of reList) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) {
        const spec = String(m[1] || "");
        // Только path-спецификаторы (./ ../ @/).
        if (!/^[./@]/.test(spec)) continue;
        const base = path.basename(spec).replace(/\.(t|j)sx?$/, "");
        if (base) out.add(base);
      }
    }
  };
  scan(serverHay);
  scan(clientHay);
  return out;
}

/**
 * Eugene 2026-05-30: реестры тулов/агентов — `chatGenerationTools.ts`,
 * `muzaTools.ts`, `agentOrchestrator.ts`. Имена handler'ов / tool-name /
 * agent-id живут в этих файлах как property keys / string literals.
 * Конкатенируем их содержимое в один haystack и потом делаем substring-
 * lookup для каждого подозреваемого символа.
 */
function collectRegistryHaystack(ctx: ScanContext): string {
  const targets = ["lib/chatGenerationTools.ts", "lib/muzaTools.ts", "lib/agentOrchestrator.ts"];
  const parts: string[] = [];
  for (const rel of targets) {
    const full = path.join(ctx.serverRoot, rel);
    const cached = ctx.contents.get(full);
    if (typeof cached === "string" && cached.length > 0) {
      parts.push(cached);
    }
  }
  return parts.join("\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Считает вхождения regex в haystack, исключая вхождения которые есть только в
 * src (файле-источнике). Грубо: total matches − matches внутри src. Если src
 * объявляет символ один раз — total>1 означает использование снаружи.
 */
function countMatchesExcludingFile(haystack: string, re: RegExp, src: string): number {
  const total = (haystack.match(re) || []).length;
  const inSrc = (src.match(re) || []).length;
  return total - inSrc;
}

/** Конкат усечённого client/src содержимого (для grep имён экспортов). */
function readClientHaystack(serverRoot: string): string {
  try {
    const clientRoot = path.join(serverRoot, "..", "client", "src");
    if (!existsSync(clientRoot)) return "";
    const files = collectClientFiles(clientRoot, 2500);
    const parts: string[] = [];
    for (const f of files) {
      parts.push(readFileSafe(f).slice(0, 40000));
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

function collectClientFiles(root: string, maxFiles: number): string[] {
  const out: string[] = [];
  const skipDirs = new Set(["node_modules", "dist", "build", ".git"]);
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= maxFiles) return;
      if (skipDirs.has(name)) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

// ---- 4) Tech-debt (плотность TODO/FIXME по файлам) ----

function detectTechDebt(ctx: ScanContext, out: RawFinding[]): void {
  try {
    // Eugene 2026-05-30: self-skip + строки/комментарии-документация о
    // паттернах TODO/FIXME не считаются техдолгом. Сам сканер описывает
    // FP-эвристики через слово TODO в jsdoc → ловил сам себя. Решение:
    // (a) явный self-skip для backendQaAgent.ts; (b) повысить порог до 12.
    for (const file of ctx.files) {
      const src = ctx.contents.get(file) || "";
      const rel = path.relative(ctx.serverRoot, file).replace(/\\/g, "/");
      // (a) Сам сканер / QA-агенты — мета-комментарии, не техдолг.
      if (/lib\/(backendQaAgent|frontendQaAgent|ferzAgent)\.ts$/.test(rel)) continue;
      const count = (src.match(/\b(?:TODO|FIXME|HACK|XXX)\b/g) || []).length;
      if (count >= 12) {
        out.push({
          kind: "tech-debt",
          theme: themeForPath(ctx.serverRoot, file),
          title: `Высокая плотность TODO/FIXME: ${rel}`,
          detail: `В файле ${rel} ${count} меток TODO/FIXME/HACK. Кандидат на разбор техдолга.`,
          severity: "low",
          dedupeKey: `tech-debt::${rel}`,
        });
      }
    }
  } catch (e) {
    console.warn("[Бэк] detectTechDebt failed:", e);
  }
}

// ====================== UPSERT находки (дедуп по dedupe_key) ======================

function upsertFinding(f: RawFinding): void {
  try {
    const now = Date.now();
    const s = sqlite();
    const existing = s
      .prepare(`SELECT id FROM backend_findings WHERE dedupe_key = ? LIMIT 1`)
      .get(f.dedupeKey) as { id: number } | undefined;
    if (existing) {
      s.prepare(
        `UPDATE backend_findings
           SET count = count + 1, last_seen = ?, title = ?, detail = ?, theme = ?, severity = ?,
               status = CASE WHEN status = 'fixed' THEN 'open' ELSE status END
         WHERE id = ?`,
      ).run(now, f.title, f.detail, f.theme, f.severity, existing.id);
    } else {
      s.prepare(
        `INSERT INTO backend_findings
           (kind, theme, title, detail, severity, status, count, first_seen, last_seen, dedupe_key)
         VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?, ?)`,
      ).run(f.kind, f.theme, f.title, f.detail, f.severity, now, now, f.dedupeKey);
    }
  } catch (e) {
    console.warn("[Бэк] upsertFinding failed:", e);
  }
}

/**
 * Авторазрешение: открытые находки с dedupe_key, которых НЕТ в свежем скане,
 * помечаем 'fixed' (исправлено/устранено). Делаем по полному набору ключей
 * текущего прогона.
 */
function autoResolveMissing(seenKeys: Set<string>): void {
  try {
    const s = sqlite();
    const rows = s
      .prepare(`SELECT id, dedupe_key FROM backend_findings WHERE status = 'open'`)
      .all() as Array<{ id: number; dedupe_key: string | null }>;
    for (const r of rows) {
      if (r.dedupe_key && !seenKeys.has(r.dedupe_key)) {
        s.prepare(`UPDATE backend_findings SET status = 'fixed', last_seen = ? WHERE id = ?`).run(Date.now(), r.id);
      }
    }
  } catch (e) {
    console.warn("[Бэк] autoResolveMissing failed:", e);
  }
}

// ====================== ИТОГ ПО-РУССКИ ======================

const SEVERITY_RU: Record<BackendFindingSeverity, string> = {
  critical: "критические",
  high: "важные",
  medium: "средние",
  low: "мелкие",
};
const KIND_RU: Record<BackendFindingKind, string> = {
  "duplicate-endpoint": "дубли маршрутов",
  "duplicate-symbol": "дубли функций",
  "possibly-dead-export": "лишнее (мёртвый код)",
  "tech-debt": "техдолг",
};

function buildBackendSummaryRu(items: BackendQaFinding[], themes: Array<{ theme: string; count: number }>): string {
  if (!items.length) {
    return "Бэкенд чист — дублей маршрутов, дублей функций и явного мёртвого кода не найдено. ✅";
  }
  const bySeverity: Record<BackendFindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const byKind: Record<string, number> = {};
  for (const it of items) {
    bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1;
    byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  }
  const sevParts = (["critical", "high", "medium", "low"] as BackendFindingSeverity[])
    .filter((s) => bySeverity[s] > 0)
    .map((s) => `${bySeverity[s]} ${SEVERITY_RU[s]}`);
  const kindParts = (Object.keys(byKind) as BackendFindingKind[]).map(
    (k) => `${KIND_RU[k] || k}: ${byKind[k]}`,
  );
  const lines: string[] = [];
  lines.push(`Найдено наблюдений: ${items.length} (${sevParts.join(", ")}).`);
  lines.push(`По типам — ${kindParts.join("; ")}.`);
  if (themes.length) {
    const topThemes = themes.slice(0, 6).map((t) => `${t.theme} (${t.count})`);
    lines.push(`По темам: ${topThemes.join(", ")}.`);
  }
  // Топ-5 находок (приоритет critical/high).
  const top = items.slice(0, 5);
  for (const it of top) {
    lines.push(`• [${SEVERITY_RU[it.severity]}] ${it.theme} — ${String(it.title).slice(0, 160)}`);
  }
  if (items.length > top.length) {
    lines.push(`…и ещё ${items.length - top.length} — полный список в админке (🚨 Бэк). Удаление — только после ревью.`);
  }
  return lines.join("\n");
}

// ====================== SEVERITY ORDER ======================

const SEVERITY_ORDER: Record<BackendFindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function mapRow(r: any): BackendQaFinding {
  return {
    id: Number(r.id),
    kind: (r.kind || "tech-debt") as BackendFindingKind,
    theme: r.theme || "other",
    title: r.title || "",
    detail: r.detail || "",
    severity: (r.severity || "low") as BackendFindingSeverity,
    status: r.status || "open",
    count: Number(r.count || 1),
    firstSeen: r.first_seen ?? null,
    lastSeen: r.last_seen ?? null,
  };
}

function loadOpenFindings(): BackendQaFinding[] {
  try {
    const rows = sqlite()
      .prepare(
        `SELECT id, kind, theme, title, detail, severity, status, count, first_seen, last_seen
         FROM backend_findings
         WHERE status = 'open'
         ORDER BY (CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END),
                  last_seen DESC
         LIMIT 200`,
      )
      .all() as any[];
    return rows.map(mapRow);
  } catch (e) {
    console.warn("[Бэк] loadOpenFindings failed:", e);
    return [];
  }
}

function buildReport(items: BackendQaFinding[]): BackendQaReport {
  const bySeverity: Record<BackendFindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const themeMap = new Map<string, number>();
  for (const it of items) {
    bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1;
    themeMap.set(it.theme, (themeMap.get(it.theme) || 0) + 1);
  }
  const themes = Array.from(themeMap.entries())
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => b.count - a.count);
  // Сортировка items по severity (уже отсортированы SQL'ем, перестрахуемся).
  const sorted = [...items].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    generatedAt: new Date().toISOString(),
    openCount: sorted.length,
    bySeverity,
    themes,
    items: sorted,
    summaryRu: buildBackendSummaryRu(sorted, themes),
  };
}

// ====================== ENTRY POINTS ======================

/**
 * Полный бэкенд-аудит: скан репо (дубли endpoints/функций, мёртвый код,
 * техдолг), группировка по темам, persist в backend_findings (дедуп),
 * авторазрешение исчезнувших находок. Никогда не throw'ит.
 */
export async function runBackendQaScan(): Promise<BackendQaReport> {
  ensureBackendFindingsTable();

  const serverRoot = resolveServerRoot();
  if (!serverRoot) {
    console.warn("[Бэк] Каталог server/ не найден — возвращаю последний отчёт");
    return buildReport(loadOpenFindings());
  }

  const files = collectTsFiles(serverRoot);
  const contents = new Map<string, string>();
  // Eugene 2026-05-30: лимит 300 КБ оказался слишком жёстким — routes.ts
  // в проекте ~800 КБ, dynamic-import'ы во второй половине обрезались и
  // эвристика basename их не видела (FP по userMemory / emailSender и др.).
  // Подняли до 1.2 МБ — покрывает текущий routes.ts с запасом, и всё ещё
  // лёгкость (общий haystack ≤ ~50 МБ при 4000 файлов).
  for (const f of files) {
    try {
      contents.set(f, readFileSafe(f).slice(0, 1_200_000));
    } catch {
      /* skip */
    }
  }
  const ctx: ScanContext = { serverRoot, files, contents };

  const raw: RawFinding[] = [];
  detectDuplicateEndpoints(ctx, raw);
  detectDuplicateSymbols(ctx, raw);
  detectPossiblyDeadExports(ctx, raw);
  detectTechDebt(ctx, raw);

  // Persist + дедуп.
  const seenKeys = new Set<string>();
  for (const f of raw) {
    seenKeys.add(f.dedupeKey);
    upsertFinding(f);
  }
  // Авторазрешение находок которых больше нет.
  autoResolveMissing(seenKeys);

  const items = loadOpenFindings();
  const report = buildReport(items);

  // Бэк подчинён Директору — отмечаем активность (never throws).
  try {
    recordAgentActivity("back-qa", {
      action: "qa_scan",
      open: report.openCount,
      filesScanned: files.length,
      critical: report.bySeverity.critical,
      high: report.bySeverity.high,
    });
  } catch {
    /* never throw */
  }

  return report;
}

/** Последний отчёт без запуска скана — быстрый read из БД. */
export function getLatestBackendQaReport(): BackendQaReport {
  ensureBackendFindingsTable();
  return buildReport(loadOpenFindings());
}

/** Сменить статус находки (open|fixed|ignored). Returns true если обновлено. */
export function markBackendFinding(id: number, status: string): boolean {
  ensureBackendFindingsTable();
  const allowed = ["open", "fixed", "ignored"];
  if (!allowed.includes(status)) return false;
  try {
    const info = sqlite().prepare(`UPDATE backend_findings SET status = ? WHERE id = ?`).run(status, id);
    return Number(info?.changes || 0) > 0;
  } catch (e) {
    console.warn("[Бэк] Не удалось обновить статус находки:", e);
    return false;
  }
}

/** Health probe для orchestrator.register healthCheck. */
export function backendQaHealth(): { ok: boolean; details: unknown } {
  try {
    ensureBackendFindingsTable();
    const open = Number(
      (sqlite().prepare(`SELECT COUNT(*) AS c FROM backend_findings WHERE status='open'`).get() as any)?.c || 0,
    );
    return { ok: true, details: { openFindings: open } };
  } catch (e: any) {
    return { ok: false, details: { error: e?.message || String(e) } };
  }
}
