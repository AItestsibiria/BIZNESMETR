// Eugene 2026-05-23 Босс «API kie подключи — для генерации в админку».
// Minimal wrapper для kie.ai Suno API. Документация (CLAUDE.md
// Critical-nodes docs registry): https://docs.kie.ai/suno-api/generate-music
// Endpoints:
//   POST /api/v1/generate            — start music gen, returns {taskId}
//   GET  /api/v1/generate/record-info?taskId=X — poll status + result
// Auth: Authorization: Bearer KIE_API_KEY
// Retention upstream — 15 дней (vs GPTunnel cache 48ч). Этот wrapper —
// для admin-test использования через /api/admin/v304/kie/* endpoints.
// Боевая генерация юзеров по-прежнему идёт через GPTunnel (Reuse-working-
// solutions rule). Когда Босс протестит kie.ai — можем добавить fallback
// chain GPTunnel → kie.ai в /api/music/generate, но это отдельный rule.

const KIE_BASE_URL = (process.env.KIE_BASE_URL || "https://api.kie.ai").replace(/\/+$/, "");
const KIE_API_KEY = process.env.KIE_API_KEY || "";

const DEFAULT_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 15_000;

export type KieModel = "V3_5" | "V4" | "V4_5";

export type KieGenerateRequest = {
  prompt: string;
  style?: string;
  title?: string;
  customMode?: boolean;
  instrumental?: boolean;
  model?: KieModel;
  callBackUrl?: string;
  negativeTags?: string;
};

export type KieGenerateResult =
  | { ok: true; taskId: string; raw: any }
  | { ok: false; error: string; httpStatus?: number; raw?: any };

export type KieStatusEntry = {
  id: string;
  audioUrl?: string;
  imageUrl?: string;
  title?: string;
  tags?: string;
  modelName?: string;
  duration?: number;
  createTime?: string;
};

export type KieStatusResult =
  | {
      ok: true;
      status: string;
      sunoData: KieStatusEntry[];
      raw: any;
    }
  | { ok: false; error: string; httpStatus?: number; raw?: any };

export type KieKeyStatus = {
  configured: boolean;
  length: number;
  first8: string;
  baseUrl: string;
};

export function kieKeyStatus(): KieKeyStatus {
  return {
    configured: KIE_API_KEY.length > 0,
    length: KIE_API_KEY.length,
    first8: KIE_API_KEY.slice(0, 8),
    baseUrl: KIE_BASE_URL,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function kieGenerate(req: KieGenerateRequest): Promise<KieGenerateResult> {
  if (!KIE_API_KEY) return { ok: false, error: "KIE_API_KEY not configured — добавь в .env через SSH" };
  if (!req.prompt || typeof req.prompt !== "string") return { ok: false, error: "prompt required" };

  const body: Record<string, unknown> = {
    prompt: req.prompt.slice(0, 5000),
    customMode: !!req.customMode,
    instrumental: !!req.instrumental,
    model: req.model || "V3_5",
  };
  if (req.style) body.style = String(req.style).slice(0, 200);
  if (req.title) body.title = String(req.title).slice(0, 200);
  if (req.callBackUrl) body.callBackUrl = String(req.callBackUrl).slice(0, 500);
  if (req.negativeTags) body.negativeTags = String(req.negativeTags).slice(0, 500);

  try {
    const r = await fetchWithTimeout(
      `${KIE_BASE_URL}/api/v1/generate`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${KIE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      DEFAULT_TIMEOUT_MS,
    );
    let parsed: any = null;
    try { parsed = await r.json(); } catch {
      const text = await r.text().catch(() => "");
      return { ok: false, error: `non-JSON response: ${text.slice(0, 200)}`, httpStatus: r.status };
    }
    if (!r.ok) {
      return { ok: false, error: `HTTP ${r.status}: ${parsed?.msg || JSON.stringify(parsed).slice(0, 200)}`, httpStatus: r.status, raw: parsed };
    }
    if (parsed.code !== undefined && parsed.code !== 200) {
      return { ok: false, error: `code=${parsed.code} msg=${parsed.msg || ""}`, httpStatus: r.status, raw: parsed };
    }
    const taskId = parsed?.data?.taskId || parsed?.data?.task_id || parsed?.taskId;
    if (!taskId || typeof taskId !== "string") {
      return { ok: false, error: "no taskId in response", httpStatus: r.status, raw: parsed };
    }
    return { ok: true, taskId, raw: parsed };
  } catch (e: any) {
    if (e?.name === "AbortError") return { ok: false, error: "timeout (30s)" };
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function kieStatus(taskId: string): Promise<KieStatusResult> {
  if (!KIE_API_KEY) return { ok: false, error: "KIE_API_KEY not configured — добавь в .env через SSH" };
  if (!taskId) return { ok: false, error: "taskId required" };
  try {
    const url = `${KIE_BASE_URL}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`;
    const r = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: { "Authorization": `Bearer ${KIE_API_KEY}` },
      },
      STATUS_TIMEOUT_MS,
    );
    let parsed: any = null;
    try { parsed = await r.json(); } catch {
      const text = await r.text().catch(() => "");
      return { ok: false, error: `non-JSON response: ${text.slice(0, 200)}`, httpStatus: r.status };
    }
    if (!r.ok) {
      return { ok: false, error: `HTTP ${r.status}: ${parsed?.msg || JSON.stringify(parsed).slice(0, 200)}`, httpStatus: r.status, raw: parsed };
    }
    if (parsed.code !== undefined && parsed.code !== 200) {
      return { ok: false, error: `code=${parsed.code} msg=${parsed.msg || ""}`, httpStatus: r.status, raw: parsed };
    }
    const status = parsed?.data?.status || "UNKNOWN";
    const sunoData: KieStatusEntry[] = Array.isArray(parsed?.data?.response?.sunoData)
      ? parsed.data.response.sunoData
      : Array.isArray(parsed?.data?.sunoData)
        ? parsed.data.sunoData
        : [];
    return { ok: true, status: String(status), sunoData, raw: parsed.data };
  } catch (e: any) {
    if (e?.name === "AbortError") return { ok: false, error: "timeout (15s)" };
    return { ok: false, error: e?.message || String(e) };
  }
}
