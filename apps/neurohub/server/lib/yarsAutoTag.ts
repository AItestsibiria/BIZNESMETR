// Eugene 2026-05-23 Босс «Жёсткий upgrade Yars system — auto-pull pipeline».
//
// Помечает свежевставленные chatbot_messages как Yars-команды если:
//   1. role === 'admin' | 'super_admin' (authentic admin/Босс)
//   2. text содержит case-insensitive «ярс» / «yars» / «оператор»
//
// При совпадении:
//   - is_yars_command = 1
//   - yars_category = classifyOperatorCommand(text).category
//   - yars_risk_level = risk-map (см. ниже)
//   - claude_review_decision = 'pending' (готово к pull'у Claude'ом)
//
// Risk-map (по Yars-admin-confirmation rule + audit ranking):
//   - low: news_post, kb_update, ui_text, persona_tweak — safe categories
//          (auto-apply через yarsExecutor возможен)
//   - medium: unknown — нужен человеческий review (Claude в чате)
//   - high: delete, secret, deploy — destructive, ОБЯЗАТЕЛЬНО confirm
//
// Sync, никогда не throw'ит наружу (tagging-failure не должен ломать chat-flow).
// Auto-detection — это улучшение audit, не блокер для основного pipeline.

import { sql } from "drizzle-orm";
import { db } from "../storage";
import { classifyOperatorCommand, type OperatorCommandCategory } from "./operatorAuth";

// Regex детектора Yars-команды. Matches «ярс», «yars», «оператор» в любом
// регистре. Слово «оператор» включено — Босс может писать «оператор: примени X».
// Word-boundary через lookbehind/lookahead (поддержка \p для кириллицы).
const YARS_COMMAND_REGEX = /(?:^|[^\p{L}\p{N}_])(ярс|yars|оператор)(?:$|[^\p{L}\p{N}_])/iu;

export type YarsRiskLevel = "low" | "medium" | "high";

/**
 * Маппинг category → risk_level.
 *
 * low → safe-категории, executeYarsCommand их auto-применяет
 * high → destructive, требуется ручное confirm Босса перед apply
 * medium → unknown категория, Claude должен изучить контекст
 */
export function categoryToRiskLevel(category: OperatorCommandCategory | string): YarsRiskLevel {
  const c = String(category || "").toLowerCase();
  if (c === "news_post" || c === "kb_update" || c === "ui_text" || c === "persona_tweak") {
    return "low";
  }
  if (c === "delete" || c === "secret" || c === "deploy") {
    return "high";
  }
  // unknown / любая нераспознанная категория — Claude reviews manually
  return "medium";
}

function isAdminRole(role?: string | null): boolean {
  const r = String(role || "").toLowerCase();
  return r === "admin" || r === "super_admin";
}

export interface TagYarsCommandInput {
  messageId: number | string | null | undefined;
  text: string;
  role: string | null | undefined;
}

export interface TagYarsCommandResult {
  tagged: boolean;
  category?: string;
  riskLevel?: YarsRiskLevel;
  reason?: string;
}

/**
 * Анализирует свежевставленный chatbot_messages row, и если это Yars-команда
 * от админа — UPDATE'ит yars-колонки в той же строке.
 *
 * Возвращает результат для caller'а (опционально логировать), но никогда не
 * throw'ит наружу.
 *
 * Usage:
 *   const inserted = db.insert(chatbotMessages).values({...}).returning({id:...}).get();
 *   tagYarsCommand({ messageId: inserted?.id, text, role: muzaRole });
 */
export function tagYarsCommand(input: TagYarsCommandInput): TagYarsCommandResult {
  try {
    if (!input.messageId) {
      return { tagged: false, reason: "no_message_id" };
    }
    if (!isAdminRole(input.role)) {
      return { tagged: false, reason: "not_admin" };
    }
    const text = String(input.text || "");
    if (!text || !YARS_COMMAND_REGEX.test(text)) {
      return { tagged: false, reason: "no_yars_marker" };
    }

    // classifyOperatorCommand — эвристика, sync, не throw'ит
    const cls = classifyOperatorCommand(text);
    const category = String(cls.category || "unknown");
    const riskLevel = categoryToRiskLevel(category);

    // UPDATE row через raw SQL (yars-колонки не в drizzle schema —
    // добавлены через auto-migrate ALTER TABLE в storage.ts bootstrap).
    db.run(sql`
      UPDATE chatbot_messages
      SET is_yars_command = 1,
          yars_category = ${category},
          yars_risk_level = ${riskLevel},
          claude_review_decision = ${"pending"}
      WHERE id = ${input.messageId as any}
    `);

    // Diagnostic log
    try {
      console.info?.("[YARS-AUTO-TAG]", JSON.stringify({
        messageId: input.messageId,
        category,
        riskLevel,
        textPreview: text.slice(0, 100),
      }));
    } catch {}

    return { tagged: true, category, riskLevel };
  } catch (e) {
    try { console.warn("[yarsAutoTag] failed:", (e as Error).message); } catch {}
    return { tagged: false, reason: "exception" };
  }
}
