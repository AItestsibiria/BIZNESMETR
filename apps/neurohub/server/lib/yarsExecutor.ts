// Eugene 2026-05-18 Босс «Yars auto-apply pipeline для safe команд».
//
// Executor для команд оператора (Ярс через Музу). Принимает текст команды,
// классифицирует через `classifyOperatorCommand()`, и для **safe** категорий
// автоматически применяет изменения. Опасные категории всегда возвращают
// `ok=false` с пометкой «требуется ручное подтверждение» — фактическое
// действие не выполняется здесь, попадает в очередь admin-approval.
//
// Категории safe-actions:
//   - news_post     — INSERT в landing_news (видно сразу на главной)
//   - kb_update     — append в docs/strategy/KNOWLEDGE-BASE-BOT.md
//   - persona_tweak — пока log-only (требует git commit, admin review)
//   - ui_text       — пока log-only (нет live UI редактора)
//
// Прицип безопасности: даже safe-action пишет audit-snapshot в
// `admin_audit_log` (через raw INSERT, без before-state — это create-only)
// чтобы Босс при разборе видел кто/что/когда применил.

import * as fs from "node:fs";
import * as path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../storage";
import { classifyOperatorCommand } from "./operatorAuth";

export interface ExecutorResult {
  ok: boolean;
  category: string;
  applied: string[];
  error?: string;
  // ID связанного artifact'а (news.id / audit.id / ...) — для последующего
  // отображения в админ-UI.
  artifactId?: number | string;
}

export interface ExecutorOptions {
  adminUserId?: number;
  ip?: string;
  // sourceChatSession — пробрасывается из webhook'а, чтобы audit-log мог
  // связать применённое изменение с конкретной чат-сессией.
  sourceChatSession?: string | null;
}

// === Audit helper (sync raw SQL, не throw'ит) ===

function writeAudit(
  action: string,
  entity: string,
  entityKey: string,
  afterJson: Record<string, unknown>,
  options?: ExecutorOptions,
): number | null {
  try {
    const after = JSON.stringify(afterJson);
    const result: any = db.run(sql`
      INSERT INTO admin_audit_log (admin_user_id, admin_email, action, entity, entity_key,
                                   before_json, after_json, via_email_confirm, ip, user_agent)
      VALUES (${options?.adminUserId ?? null}, ${"yars-auto-apply"}, ${action},
              ${entity}, ${entityKey}, NULL, ${after}, 0, ${options?.ip ?? null}, ${"yars-executor"})
    `);
    return Number(result?.lastInsertRowid ?? 0) || null;
  } catch (e) {
    console.warn("[yarsExecutor] audit write failed:", (e as Error).message);
    return null;
  }
}

// === news_post handler ===
//
// Извлекаем текст новости из команды. Простая стратегия: берём всё после
// первой пары ключевых слов («новость:», «опубликуй:», «акция:»). Если не
// нашли — берём целиком первые 280 символов.
function extractNewsContent(text: string): { title: string; body: string } {
  const cleaned = text.trim().replace(/\s+/g, " ");
  // Попытка разделить «заголовок: тело»
  const colonIdx = cleaned.indexOf(":");
  let title = "";
  let body = "";
  if (colonIdx > 0 && colonIdx < 80) {
    title = cleaned.slice(0, colonIdx).trim();
    body = cleaned.slice(colonIdx + 1).trim();
  } else {
    title = cleaned.slice(0, 60).trim();
    body = cleaned.slice(0, 280).trim();
  }
  if (!title) title = "Новость от Ярса";
  if (!body) body = cleaned.slice(0, 280);
  return { title, body };
}

function handleNewsPost(text: string, options?: ExecutorOptions): ExecutorResult {
  try {
    const { title, body } = extractNewsContent(text);
    // INSERT через raw SQL — landing_news имеет defaults на большинство полей.
    const now = new Date().toISOString();
    const result: any = db.run(sql`
      INSERT INTO landing_news (category, title, body, body_html, icon_emoji,
                                badge_color, border_color, published_at,
                                position, sort_order, active, is_visible,
                                view_count, created_at, updated_at)
      VALUES (${"main"}, ${title}, ${body}, ${body}, ${"📢"},
              ${"amber"}, ${"amber"}, ${now},
              ${0}, ${100}, ${1}, ${1},
              ${0}, ${now}, ${now})
    `);
    const newsId = Number(result?.lastInsertRowid ?? 0) || 0;
    const auditId = writeAudit("create", "landing_news", String(newsId), { title, body }, options);
    return {
      ok: true,
      category: "news_post",
      applied: [`Создана новость #${newsId} «${title.slice(0, 40)}…»`],
      artifactId: newsId,
      ...(auditId ? { auditId } as any : {}),
    };
  } catch (e: any) {
    console.error("[yarsExecutor news_post]", e);
    return {
      ok: false,
      category: "news_post",
      applied: [],
      error: "Не удалось создать новость: " + (e?.message || "unknown"),
    };
  }
}

// === kb_update handler ===
//
// Append в KNOWLEDGE-BASE-BOT.md. Если файл не существует — log-only,
// чтобы не создавать неверный артефакт без человеческого ревью.
function handleKbUpdate(text: string, options?: ExecutorOptions): ExecutorResult {
  // Относительный путь от worktree-root. Если в проде структура другая —
  // KB_PATH env переопределяет.
  const kbPath =
    (process.env.KB_PATH || "").trim() ||
    path.join(process.cwd(), "docs", "strategy", "KNOWLEDGE-BASE-BOT.md");

  try {
    if (!fs.existsSync(kbPath)) {
      const auditId = writeAudit(
        "create",
        "kb_suggestion",
        "no-file",
        { text, kbPath },
        options,
      );
      return {
        ok: true,
        category: "kb_update",
        applied: [
          `KB-файл не найден (${kbPath}) — записал предложение в audit-log #${auditId ?? "?"}`,
        ],
        artifactId: auditId ?? undefined,
      };
    }
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const entry = `\n\n<!-- Ярс auto-append ${stamp} MSK -->\n${text.trim()}\n`;
    fs.appendFileSync(kbPath, entry, { encoding: "utf-8", mode: 0o644 });
    const auditId = writeAudit("update", "kb_file", kbPath, { appended: text }, options);
    return {
      ok: true,
      category: "kb_update",
      applied: [`Добавлено в KB (${path.basename(kbPath)})`],
      artifactId: auditId ?? undefined,
    };
  } catch (e: any) {
    console.error("[yarsExecutor kb_update]", e);
    return {
      ok: false,
      category: "kb_update",
      applied: [],
      error: "Не удалось обновить KB: " + (e?.message || "unknown"),
    };
  }
}

// === persona_tweak / ui_text — log-only ===
//
// Эти категории требуют ручного git commit'а в исходник (consultantPersona.ts,
// React-компоненты), поэтому в safe-режиме мы только пишем audit-snapshot
// чтобы Босс увидел suggestion и принял решение вручную.
function handleLogOnlySuggestion(
  category: "persona_tweak" | "ui_text",
  text: string,
  options?: ExecutorOptions,
): ExecutorResult {
  const auditId = writeAudit(
    "create",
    `${category}_suggestion`,
    `yars-${Date.now()}`,
    { text },
    options,
  );
  const label = category === "persona_tweak" ? "правки персоны" : "UI-текста";
  return {
    ok: true,
    category,
    applied: [`Записал предложение ${label} для admin review (audit #${auditId ?? "?"})`],
    artifactId: auditId ?? undefined,
  };
}

// === Main entrypoint ===

export async function executeYarsCommand(
  text: string,
  options?: ExecutorOptions,
): Promise<ExecutorResult> {
  const cls = classifyOperatorCommand(text);
  if (!cls.safe) {
    return {
      ok: false,
      category: cls.category,
      applied: [],
      error: "Dangerous category requires manual admin approval",
    };
  }
  switch (cls.category) {
    case "news_post":
      return handleNewsPost(text, options);
    case "kb_update":
      return handleKbUpdate(text, options);
    case "persona_tweak":
      return handleLogOnlySuggestion("persona_tweak", text, options);
    case "ui_text":
      return handleLogOnlySuggestion("ui_text", text, options);
    default:
      return {
        ok: false,
        category: cls.category,
        applied: [],
        error: "Unknown safe category",
      };
  }
}
