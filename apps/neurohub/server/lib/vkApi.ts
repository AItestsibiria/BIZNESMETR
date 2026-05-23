// VK API wrapper (Eugene 2026-05-23, subagent vk-channel).
//
// Тонкая обёртка над api.vk.com для community-actions (messages.send,
// wall.post, groups.getById). Использует token из process.env.VK_ACCESS_TOKEN
// (community access token, scope: messages + wall + photos + docs).
//
// Жёсткие правила (CLAUDE.md):
// - Secrets-admin-only rule: значение токена НИКОГДА не пишется в logs/
//   response/audit. Только masked-status (length, first4).
// - Never-leak-secrets rule: timeout, sanitized errors.
// - Bot-webhook-dedup rule: dedup делается на уровне webhook handler
//   (см. vk-channel/module.ts).
//
// API docs: https://dev.vk.com/method
// Версия API: 5.199 (актуальная на 2026-05).

const VK_API_BASE = "https://api.vk.com/method";
const VK_API_VERSION = "5.199";
const VK_API_TIMEOUT_MS = 15_000;

function getToken(): string {
  return process.env.VK_ACCESS_TOKEN || "";
}

function maskToken(): string {
  const t = getToken();
  if (!t) return "MISSING";
  return `present (len=${t.length}, first4=${t.slice(0, 4)})`;
}

export interface VkApiError {
  ok: false;
  error: string;
  errorCode?: number;
  raw?: unknown;
}

export interface VkApiSuccess<T = any> {
  ok: true;
  data: T;
}

export type VkApiResult<T = any> = VkApiSuccess<T> | VkApiError;

/**
 * Низкоуровневый вызов VK API метода.
 * params — query-string параметры (без access_token и v — добавляются автоматически).
 * Никогда не логирует raw token / raw params (могут содержать PII).
 */
export async function vkApiCall<T = any>(
  method: string,
  params: Record<string, string | number | boolean> = {},
): Promise<VkApiResult<T>> {
  const token = getToken();
  if (!token) {
    return { ok: false, error: "VK_ACCESS_TOKEN not configured" };
  }

  const url = new URL(`${VK_API_BASE}/${method}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  url.searchParams.set("access_token", token);
  url.searchParams.set("v", VK_API_VERSION);

  try {
    const r = await fetch(url.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(VK_API_TIMEOUT_MS),
    });
    const json: any = await r.json().catch(() => null);
    if (!json) {
      return { ok: false, error: `VK API ${method}: invalid JSON (HTTP ${r.status})` };
    }
    if (json.error) {
      const code = Number(json.error.error_code);
      const msg = String(json.error.error_msg || "unknown").slice(0, 300);
      return {
        ok: false,
        error: `VK ${method} error ${code}: ${msg}`,
        errorCode: code,
        raw: { error_code: code, error_msg: msg },
      };
    }
    return { ok: true, data: json.response as T };
  } catch (e: any) {
    const msg = e?.name === "TimeoutError"
      ? `VK API ${method}: timeout after ${VK_API_TIMEOUT_MS / 1000}s`
      : `VK API ${method}: ${String(e?.message || e).slice(0, 200)}`;
    return { ok: false, error: msg };
  }
}

// ============================================================
//  High-level helpers
// ============================================================

export interface VkSendMessageInput {
  userId: number | string;
  text: string;
  attachments?: string; // "audio<owner_id>_<media_id>,wall<owner>_<post>"
  keepForwardMessages?: boolean;
}

/**
 * messages.send (https://dev.vk.com/method/messages.send).
 * VK требует random_id (idempotency на их стороне) — генерируем uuid-int.
 */
export async function vkSendMessage(input: VkSendMessageInput): Promise<VkApiResult<number>> {
  const text = String(input.text || "").slice(0, 4096); // VK limit для messages
  if (!text && !input.attachments) {
    return { ok: false, error: "messages.send: empty text and no attachments" };
  }
  const params: Record<string, string | number> = {
    user_id: String(input.userId),
    message: text,
    random_id: Math.floor(Math.random() * 2_147_483_647), // VK хочет int32
    dont_parse_links: 0,
  };
  if (input.attachments) params.attachment = input.attachments;
  return vkApiCall<number>("messages.send", params);
}

export interface VkWallPostInput {
  message: string;
  attachments?: string;
  fromGroup?: boolean; // default true (от имени группы)
  signed?: boolean;    // подпись автора (default false когда fromGroup)
}

/**
 * wall.post — публикация на стене сообщества.
 * owner_id = -VK_GROUP_ID (минус — обязателен для group walls).
 * docs: https://dev.vk.com/method/wall.post
 */
export async function vkPostWallGroup(input: VkWallPostInput): Promise<VkApiResult<{ post_id: number }>> {
  const groupId = process.env.VK_GROUP_ID;
  if (!groupId) {
    return { ok: false, error: "VK_GROUP_ID not configured" };
  }
  const message = String(input.message || "").slice(0, 16_000); // VK limit for wall
  if (!message && !input.attachments) {
    return { ok: false, error: "wall.post: empty message and no attachments" };
  }
  const params: Record<string, string | number> = {
    owner_id: `-${groupId}`,
    from_group: input.fromGroup === false ? 0 : 1,
    message,
    signed: input.signed ? 1 : 0,
  };
  if (input.attachments) params.attachments = input.attachments;
  return vkApiCall<{ post_id: number }>("wall.post", params);
}

export interface VkGroupInfo {
  id: number;
  name: string;
  screen_name: string;
  members_count?: number;
  type?: string;
  is_closed?: number;
  activity?: string;
  description?: string;
}

/**
 * groups.getById — info про сообщество (для admin diagnostics).
 * docs: https://dev.vk.com/method/groups.getById
 */
export async function vkGroupInfo(): Promise<VkApiResult<VkGroupInfo>> {
  const groupId = process.env.VK_GROUP_ID;
  if (!groupId) {
    return { ok: false, error: "VK_GROUP_ID not configured" };
  }
  const r = await vkApiCall<any>("groups.getById", {
    group_id: groupId,
    fields: "members_count,activity,description",
  });
  if (!r.ok) return r;
  // VK возвращает { groups: [{...}] } (v5.199) или массив (legacy).
  const raw = r.data;
  const item = Array.isArray(raw) ? raw[0] : raw?.groups?.[0];
  if (!item || typeof item !== "object") {
    return { ok: false, error: "groups.getById: empty/invalid response", raw };
  }
  return { ok: true, data: item as VkGroupInfo };
}

/**
 * Status helper для admin endpoint — никогда не возвращает raw token.
 */
export function vkConfigStatus(): {
  configured: boolean;
  groupId: string | null;
  hasAccessToken: boolean;
  accessTokenMask: string;
  hasConfirmationCode: boolean;
  hasSecret: boolean;
} {
  return {
    configured: !!(getToken() && process.env.VK_GROUP_ID && process.env.VK_CONFIRMATION_CODE),
    groupId: process.env.VK_GROUP_ID || null,
    hasAccessToken: !!getToken(),
    accessTokenMask: maskToken(),
    hasConfirmationCode: !!process.env.VK_CONFIRMATION_CODE,
    hasSecret: !!process.env.VK_SECRET,
  };
}
