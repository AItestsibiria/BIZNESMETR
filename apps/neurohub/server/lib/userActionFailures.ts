// Регистр неудачных действий юзера (Eugene 2026-05-15 Босс).
// Единая точка фиксации для ВСЕХ каналов: web, telegram, max, email, vk,
// api, webhook, future channels. Подключается всюду где user-action может
// провалиться — login, register, payment, generate, chat-reply, webhook
// handler error.
//
// Использование:
//   import { logUserActionFailure } from "@/server/lib/userActionFailures";
//   logUserActionFailure({
//     userId, channel: "telegram", action: "chat-reply",
//     errorCode: "llm_fallback", errorMessage: "Claude и GPTunnel оба упали",
//     context: { sessionId, lastUserText: text.slice(0, 100) },
//   });
//
// Хелпер sync, никогда не throw'ит — failure registration сам не должен
// ломать вызывающий код.

import { db } from "../storage";
import { userActionFailures } from "@shared/schema";

export type ChannelKind = "web" | "telegram" | "max" | "email" | "vk" | "api" | "webhook" | "cron" | string;

export interface UserActionFailureInput {
  userId?: number | null;
  channel: ChannelKind;
  action: string;                 // 'register' | 'login' | 'generate' | 'pay' | 'chat-reply' | ...
  statusCode?: number | null;
  errorCode?: string | null;      // нормализованный ключ — основа group_key
  errorMessage?: string | null;
  endpoint?: string | null;
  context?: any;                   // JSON-сериализуется, секреты сами вырезай
}

function normalizeKey(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9_:-]+/g, "_").slice(0, 80);
}

export function logUserActionFailure(input: UserActionFailureInput): void {
  try {
    const action = normalizeKey(input.action || "unknown");
    const errorCode = normalizeKey(input.errorCode || "unspecified");
    const groupKey = `${action}::${errorCode}`;
    let contextStr: string | null = null;
    if (input.context !== undefined && input.context !== null) {
      try {
        contextStr = typeof input.context === "string"
          ? input.context.slice(0, 2000)
          : JSON.stringify(input.context).slice(0, 2000);
      } catch { contextStr = null; }
    }
    db.insert(userActionFailures).values({
      userId: input.userId ?? null,
      channel: String(input.channel || "api").slice(0, 30),
      action,
      statusCode: input.statusCode ?? null,
      errorCode,
      errorMessage: input.errorMessage ? String(input.errorMessage).slice(0, 500) : null,
      endpoint: input.endpoint ? String(input.endpoint).slice(0, 200) : null,
      context: contextStr,
      groupKey,
    }).run();
  } catch {
    // Никогда не ломаем вызывающий код.
  }
}
