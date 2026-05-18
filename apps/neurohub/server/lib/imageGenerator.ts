// General-purpose image generator — Eugene 2026-05-18 Босс
// «настроить admin-генератор изображений по запросу для разных задач компании».
//
// Расширение generateMusaAvatar.ts на любые категории изображений:
// avatar / cover / banner / logo / product / custom.
//
// Pipeline (тот же что для Musa avatar — Reuse-working-solutions rule):
//   1) GPTunnel /v1/images/generations (несколько моделей)
//   2) Fallback на OpenAI DALL-E 3 напрямую (через OPENAI_API_KEY)
//   3) Сохранение PNG-файла в client/public/generated/{YYYY-MM-DD}/{uuid}.png
//   4) Запись в БД generated_files (id, type, prompt, file_path, provider, ...)
//
// Все секреты — только через process.env (Never-leak-secrets rule).
// gptKeyManager — общий ротатор GPTunnel ключей (как в generateMusaAvatar).

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { gptKeyManager } from "./gptKeyManager";

export type ImagePreset =
  | "avatar"
  | "cover"
  | "banner"
  | "logo"
  | "product"
  | "custom";

export type ImageSize = "1024x1024" | "1792x1024" | "1024x1792";

export interface GenerateImageOptions {
  prompt: string;
  presetCategory?: ImagePreset;
  refImageUrl?: string | null;
  /** Если задан — сохраняем туда (относительный путь от client/public/). */
  savePath?: string;
  size?: ImageSize;
}

export interface ImageGenAttempt {
  provider: string;
  model: string;
  endpoint: string;
  httpStatus?: number;
  ok: boolean;
  bodyPreview?: string;
  error?: string;
}

export interface GenerateImageResult {
  ok: boolean;
  /** Относительный URL в client/public (e.g. "/generated/2026-05-18/abc.png"). */
  fileUrl?: string;
  /** Абсолютный путь на диске. */
  filePath?: string;
  fileSizeBytes?: number;
  width?: number;
  height?: number;
  provider?: string;
  model?: string;
  modelTried: string[];
  promptUsed: string;
  durationMs: number;
  attempts: ImageGenAttempt[];
  error?: string;
}

const PUBLIC_BASE_CANDIDATES = [
  path.join(process.cwd(), "apps/neurohub/client/public"),
  path.join(process.cwd(), "client/public"),
  path.join(process.cwd(), "dist/public"),
];

function pickPublicDir(): string {
  for (const d of PUBLIC_BASE_CANDIDATES) {
    if (fsSync.existsSync(d)) return d;
  }
  // Fallback — создадим первый
  return PUBLIC_BASE_CANDIDATES[0];
}

const MODEL_CANDIDATES = [
  "dall-e-3",
  "gpt-image-1",
  "flux-pro",
  "flux-1.1-pro",
  "midjourney",
  "stable-diffusion-xl",
];

const GPTUNNEL_ENDPOINTS = [
  "https://gptunnel.ru/v1/images/generations",
  "https://api.gptunnel.ru/v1/images/generations",
];

/** Bytes-извлекатель — поддерживает url / b64_json формы ответа. */
async function downloadImageBytes(payload: unknown): Promise<Buffer | null> {
  const j = payload as Record<string, unknown> | null;
  if (!j) return null;
  const data = (j.data as unknown[]) ?? null;
  const first = data && data.length ? (data[0] as Record<string, unknown>) : null;
  const b64Candidates: Array<string | undefined> = [
    (first?.b64_json as string) ?? undefined,
    (first?.b64 as string) ?? undefined,
    (j.b64_json as string) ?? undefined,
  ];
  for (const b64 of b64Candidates) {
    if (b64 && typeof b64 === "string" && b64.length > 64) {
      try {
        return Buffer.from(b64.replace(/^data:image\/[a-z]+;base64,/, ""), "base64");
      } catch {
        // try next
      }
    }
  }
  const urlCandidates: Array<string | undefined> = [
    (first?.url as string) ?? undefined,
    (first?.image_url as string) ?? undefined,
    (j.url as string) ?? undefined,
    (j.image as string) ?? undefined,
  ];
  for (const url of urlCandidates) {
    if (url && typeof url === "string" && /^https?:\/\//i.test(url)) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!r.ok) continue;
        const ab = await r.arrayBuffer();
        return Buffer.from(ab);
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function tryGptunnel(
  prompt: string,
  size: ImageSize,
  refImageUrl: string | null,
): Promise<{ buffer: Buffer | null; modelUsed: string | null; attempts: ImageGenAttempt[]; modelTried: string[] }> {
  const apiKey = gptKeyManager.getActiveKey() || process.env.GPTUNNEL_API_KEY || "";
  const attempts: ImageGenAttempt[] = [];
  const modelTried: string[] = [];
  if (!apiKey) {
    attempts.push({
      provider: "gptunnel",
      model: "n/a",
      endpoint: "",
      ok: false,
      error: "GPTUNNEL_API_KEY missing",
    });
    return { buffer: null, modelUsed: null, attempts, modelTried };
  }

  for (const model of MODEL_CANDIDATES) {
    modelTried.push(model);
    for (const endpoint of GPTUNNEL_ENDPOINTS) {
      const body: Record<string, unknown> = {
        model,
        prompt,
        n: 1,
        size,
        response_format: "url",
      };
      if (refImageUrl) {
        body.image = refImageUrl;
        body.reference_image = refImageUrl;
      }
      try {
        const r = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
        const text = await r.text().catch(() => "");
        let parsed: unknown = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        const attempt: ImageGenAttempt = {
          provider: "gptunnel",
          model,
          endpoint,
          httpStatus: r.status,
          ok: r.ok,
          bodyPreview: text.slice(0, 300),
        };
        attempts.push(attempt);
        if (!r.ok) {
          gptKeyManager.reportFailure(apiKey, `images/generations ${model}: ${r.status}`, r.status);
          if (r.status === 404 || r.status === 422 || r.status === 400) break; // next model
          continue; // try next endpoint same model
        }
        const buf = await downloadImageBytes(parsed);
        if (buf && buf.length > 1024) {
          gptKeyManager.reportSuccess(apiKey);
          return { buffer: buf, modelUsed: `gptunnel/${model}`, attempts, modelTried };
        }
        attempts.push({
          provider: "gptunnel",
          model,
          endpoint,
          httpStatus: r.status,
          ok: false,
          error: "parsed OK but no image bytes",
        });
      } catch (err) {
        attempts.push({
          provider: "gptunnel",
          model,
          endpoint,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { buffer: null, modelUsed: null, attempts, modelTried };
}

async function tryOpenAI(
  prompt: string,
  size: ImageSize,
): Promise<{ buffer: Buffer | null; attempt: ImageGenAttempt }> {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    return {
      buffer: null,
      attempt: {
        provider: "openai",
        model: "dall-e-3",
        endpoint: "n/a",
        ok: false,
        error: "OPENAI_API_KEY missing",
      },
    };
  }
  const endpoint = "https://api.openai.com/v1/images/generations";
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "dall-e-3",
        prompt: prompt.slice(0, 4000),
        n: 1,
        size,
        quality: "hd",
        style: "natural",
        response_format: "url",
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await r.text().catch(() => "");
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    const attempt: ImageGenAttempt = {
      provider: "openai",
      model: "dall-e-3",
      endpoint,
      httpStatus: r.status,
      ok: r.ok,
      bodyPreview: text.slice(0, 300),
    };
    if (!r.ok) return { buffer: null, attempt };
    const buf = await downloadImageBytes(parsed);
    if (buf && buf.length > 1024) return { buffer: buf, attempt };
    return {
      buffer: null,
      attempt: { ...attempt, ok: false, error: "parsed OK but no image bytes" },
    };
  } catch (err) {
    return {
      buffer: null,
      attempt: {
        provider: "openai",
        model: "dall-e-3",
        endpoint,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function parseSize(s?: ImageSize): { width: number; height: number; size: ImageSize } {
  if (s === "1792x1024") return { width: 1792, height: 1024, size: s };
  if (s === "1024x1792") return { width: 1024, height: 1792, size: s };
  return { width: 1024, height: 1024, size: "1024x1024" };
}

function buildSavePath(presetCategory: ImagePreset, customSavePath?: string): { absPath: string; relUrl: string } {
  const publicDir = pickPublicDir();
  if (customSavePath) {
    const rel = customSavePath.startsWith("/") ? customSavePath.slice(1) : customSavePath;
    return {
      absPath: path.join(publicDir, rel),
      relUrl: "/" + rel.replace(/\\/g, "/"),
    };
  }
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const uid = randomBytes(6).toString("hex");
  const fname = `${presetCategory}-${uid}.png`;
  const rel = path.posix.join("generated", date, fname);
  return {
    absPath: path.join(publicDir, "generated", date, fname),
    relUrl: "/" + rel,
  };
}

/**
 * Главная функция — генерирует одно изображение и сохраняет на диск.
 * Возвращает result с fileUrl / filePath / size + список attempts для аудита.
 *
 * НЕ пишет в БД сама — это делает caller (image-gen plugin endpoint).
 * Так lib переиспользуется в других контекстах без db dependency.
 */
export async function generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
  const startedAt = Date.now();
  const preset = opts.presetCategory || "custom";
  const promptUsed = (opts.prompt || "").trim();
  const { size, width, height } = parseSize(opts.size);

  if (!promptUsed || promptUsed.length < 4) {
    return {
      ok: false,
      promptUsed,
      modelTried: [],
      durationMs: 0,
      attempts: [],
      error: "Prompt is empty or too short (min 4 chars)",
    };
  }

  // 1) GPTunnel
  const g = await tryGptunnel(promptUsed, size, opts.refImageUrl ?? null);
  let buffer = g.buffer;
  let provider: string | null = g.modelUsed ? "gptunnel" : null;
  let model: string | null = g.modelUsed ? g.modelUsed.replace(/^gptunnel\//, "") : null;
  const allAttempts: ImageGenAttempt[] = [...g.attempts];
  const modelTried: string[] = [...g.modelTried];

  // 2) Fallback OpenAI
  if (!buffer) {
    const o = await tryOpenAI(promptUsed, size);
    allAttempts.push(o.attempt);
    if (o.buffer) {
      buffer = o.buffer;
      provider = "openai";
      model = "dall-e-3";
      modelTried.push("dall-e-3 (openai direct)");
    }
  }

  if (!buffer) {
    return {
      ok: false,
      promptUsed,
      modelTried,
      durationMs: Date.now() - startedAt,
      attempts: allAttempts,
      error: "Image generation failed: GPTunnel + OpenAI fallback both failed",
    };
  }

  // 3) Save file
  const { absPath, relUrl } = buildSavePath(preset, opts.savePath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, buffer);
  const stat = await fs.stat(absPath);

  return {
    ok: true,
    fileUrl: relUrl,
    filePath: absPath,
    fileSizeBytes: stat.size,
    width,
    height,
    provider: provider ?? undefined,
    model: model ?? undefined,
    modelTried,
    promptUsed,
    durationMs: Date.now() - startedAt,
    attempts: allAttempts,
  };
}

/**
 * Ориентировочная стоимость генерации в рублях (для UI отображения).
 * Точные цены меняются у провайдеров — это эмпирическая оценка.
 */
export function estimateCostRub(provider?: string, model?: string): number {
  if (provider === "openai" && model === "dall-e-3") return 8; // ~$0.08 HD 1024
  if (provider === "gptunnel") {
    if (model?.includes("dall-e")) return 7;
    if (model?.includes("midjourney")) return 12;
    if (model?.includes("flux")) return 5;
    return 6;
  }
  return 5;
}
