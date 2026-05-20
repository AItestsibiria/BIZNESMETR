// Eugene 2026-05-20 Босс «Веди базу сообщений админа в боте Муза.
// Применяй немедленно то что написано как будто я в этом чате. Правило
// работает если авторизирован админ, с IP-адреса указанного на VPS как
// точка безопасности. Если не бьётся параметр — сообщи конкретно какой».
//
// Использование:
//   import { recordAdminMuzaMessage } from "./lib/adminChatRecorder";
//   const r = await recordAdminMuzaMessage({ sessionId, userId, channel,
//                                              text, ip, userAgent, role });
//   // r.recorded — true если admin (запись в admin_chat_messages)
//   // r.authorized — true если admin + ip ∈ ADMIN_TRUSTED_IPS
//   // r.mismatch — точный reason если authorized=false ('role:user',
//   //              'ip:1.2.3.4 not in trusted_set', 'env:ADMIN_TRUSTED_IPS_empty')
//   // r.applied — true если executor применил safe-команду
//   // r.appliedActions — список применённых действий (для UI)
//
// Sync-помощник, никогда не throw'ит наружу — recording-failure не должен
// ломать chat-pipeline.

import { sql } from "drizzle-orm";
import { db } from "../storage";
import { executeYarsCommand } from "./yarsExecutor";

export interface RecordAdminMessageInput {
  sessionId: string;
  userId: number | null;
  channel: "web" | "inject" | "telegram" | "max" | string;
  text: string;
  ip?: string | null;
  userAgent?: string | null;
  role?: string | null;
}

export interface RecordAdminMessageResult {
  recorded: boolean;
  authorized: boolean;
  mismatch?: string;
  applied: boolean;
  appliedActions: string[];
  artifactId?: number | string;
  appliedError?: string;
}

// === Trusted IPs (ADMIN_TRUSTED_IPS env, comma-separated) ===
//
// Парсится при каждом вызове — env может ротироваться без рестарта (хотя
// pm2 --update-env обычно нужен). Если env пуст — auto-apply ВЫКЛЮЧЕН
// (safe default).
function parseTrustedIps(): Set<string> {
  const raw = String(process.env.ADMIN_TRUSTED_IPS || "").trim();
  if (!raw) return new Set();
  return new Set(
    raw.split(",")
       .map(s => s.trim())
       .filter(Boolean)
  );
}

function isAdminRole(role?: string | null): boolean {
  const r = String(role || "").toLowerCase();
  return r === "admin" || r === "super_admin";
}

function maskIp(ip?: string | null): string {
  if (!ip) return "unknown";
  // Для IPv4 — оставляем целиком (короткий, не PII). Для IPv6 — обрезаем
  // до /64 префикса чтобы не светить device suffix в логах.
  if (ip.includes(":")) {
    const parts = ip.split(":");
    return parts.slice(0, 4).join(":") + "::/64";
  }
  return ip;
}

/**
 * Записывает admin-сообщение в `admin_chat_messages` и при выполнении
 * двух условий (role admin + ip ∈ trusted) auto-применяет safe-команды
 * через executeYarsCommand().
 *
 * Не-admin сообщения НЕ записываются здесь — они уже в `chatbot_messages`.
 */
export async function recordAdminMuzaMessage(
  input: RecordAdminMessageInput,
): Promise<RecordAdminMessageResult> {
  // === Gate 1: только admin/super_admin ===
  if (!isAdminRole(input.role)) {
    const r = String(input.role || "anonymous").toLowerCase();
    return {
      recorded: false,
      authorized: false,
      mismatch: `role:${r} (expected admin|super_admin)`,
      applied: false,
      appliedActions: [],
    };
  }

  // === Gate 2: IP ∈ ADMIN_TRUSTED_IPS ===
  const trustedIps = parseTrustedIps();
  let mismatch: string | undefined;
  let authorized = false;
  if (trustedIps.size === 0) {
    mismatch = "env:ADMIN_TRUSTED_IPS_empty (auto-apply disabled — set on VPS)";
  } else if (!input.ip) {
    mismatch = "ip:unknown (request has no IP)";
  } else if (!trustedIps.has(input.ip)) {
    mismatch = `ip:${maskIp(input.ip)} not in trusted_set (size=${trustedIps.size})`;
  } else {
    authorized = true;
  }

  // === Auto-apply через executeYarsCommand (только если authorized) ===
  let applied = false;
  let appliedActions: string[] = [];
  let artifactId: number | string | undefined;
  let appliedError: string | undefined;
  let appliedJson: string | null = null;

  if (authorized) {
    try {
      const result = await executeYarsCommand(input.text, {
        ip: input.ip ?? undefined,
        sourceChatSession: input.sessionId,
        adminUserId: input.userId ?? undefined,
      });
      if (result.ok) {
        applied = true;
        appliedActions = result.applied;
        artifactId = result.artifactId;
        appliedJson = JSON.stringify({
          ok: true,
          category: result.category,
          applied: result.applied,
          artifactId: result.artifactId ?? null,
        });
      } else {
        appliedError = result.error;
        appliedJson = JSON.stringify({
          ok: false,
          category: result.category,
          error: result.error,
        });
      }
    } catch (e) {
      appliedError = (e as Error)?.message || String(e);
      appliedJson = JSON.stringify({ ok: false, error: appliedError });
    }
  }

  // === Запись в admin_chat_messages ===
  try {
    db.run(sql`
      INSERT INTO admin_chat_messages
        (session_id, user_id, channel, text, ip, user_agent, role,
         authorized, authorization_mismatch, applied, applied_action)
      VALUES (
        ${String(input.sessionId).slice(0, 100)},
        ${input.userId ?? null},
        ${String(input.channel || "unknown").slice(0, 30)},
        ${String(input.text || "").slice(0, 4000)},
        ${input.ip ?? null},
        ${input.userAgent ? String(input.userAgent).slice(0, 300) : null},
        ${String(input.role || "").toLowerCase().slice(0, 20) || null},
        ${authorized ? 1 : 0},
        ${mismatch ?? null},
        ${applied ? 1 : 0},
        ${appliedJson}
      )
    `);
  } catch (e) {
    // Не throw'им — recording не должен ломать chat. Только warn.
    try { console.warn("[ADMIN-CHAT-RECORDER] insert failed:", (e as Error).message); } catch {}
  }

  // === Diagnostic log (виден в pm2 logs / dashboard) ===
  try {
    if (authorized) {
      console.info?.("[ADMIN-MUZA-MSG]", JSON.stringify({
        channel: input.channel,
        sessionId: input.sessionId,
        userId: input.userId,
        ip: maskIp(input.ip),
        applied,
        appliedActions: appliedActions.length,
        artifactId: artifactId ?? null,
      }));
    } else {
      console.warn?.("[ADMIN-MUZA-MSG mismatch]", JSON.stringify({
        channel: input.channel,
        sessionId: input.sessionId,
        userId: input.userId,
        ip: maskIp(input.ip),
        mismatch,
      }));
    }
  } catch {}

  return {
    recorded: true,
    authorized,
    mismatch,
    applied,
    appliedActions,
    artifactId,
    appliedError,
  };
}
