// Musa 3D-аватар generator — Eugene 2026-05-18 Босс «дожать
// девушку с обложки трека Муза, 3D, почти настоящая».
//
// Docs-first (Docs-first-always rule):
//   - GPTunnel позиционирует себя как unified gateway к ChatGPT, Claude,
//     Gemini, DALL-E, Midjourney, Stable Diffusion, Flux — с OpenAI-
//     compatible API. Существующие модули проекта используют:
//       POST https://gptunnel.ru/v1/audio/transcriptions   (Whisper)
//       POST https://gptunnel.ru/v1/chat/completions       (LLM)
//       POST https://gptunnel.ru/v1/media/create           (Suno)
//       GET  https://gptunnel.ru/v1/balance
//     Image generation следует OpenAI-схеме:
//       POST https://gptunnel.ru/v1/images/generations
//       body: { model, prompt, size, n, response_format }
//     Refs: https://www.gptunnel.ru/en/about
//           https://www.gptunnel.ru/en/blog/gpt-4o-v-gptunnel-prevrashchaem-tekst-v-potryasayushchie-izobrazheniya
//   - WebFetch на docs.gptunnel.ru возвращает 403 для unauth fetch;
//     Босс жмёт кнопку → backend пробует /v1/images/generations →
//     если 404/422 → fallback на иной model name (dall-e-3 / flux-pro
//     / midjourney). Полная trace + сохранение по факту в logs.
//
// Pipeline:
//   1. POST к GPTunnel image endpoint с brand-prompt (или custom).
//   2. Если ответ содержит URL — скачиваем; если base64 (b64_json) — декодим.
//   3. sharp → resize в 1024 / 512 / 256 (PNG + WebP).
//   4. Сохраняем в client/public/musa-3d-avatar/, обновляем mtime
//      — это автоматически инвалидирует cache в TG/Max ботах
//      (getConsultantPhotoVersion смотрит на mtime PNG).
//   5. Backup существующего consultant-avatar.svg → .svg.bak один раз.
//
// Reuse-working-solutions rule: gptKeyManager — общий ротатор GPTunnel
// ключей. Используем его (не process.env напрямую) для multi-key health
// rotation как остальные модули.

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import sharp from "sharp";
import { gptKeyManager } from "./gptKeyManager";

export interface GeneratedAvatarSizes {
  png1024: string;
  png512: string;
  png256: string;
  webp512: string;
  webp256: string;
}

export interface GenerateMusaResult {
  ok: boolean;
  files?: GeneratedAvatarSizes;
  /** Куда сохранены файлы относительно корня проекта (для url). */
  publicUrls?: { png1024: string; png512: string; png256: string; webp512: string; webp256: string };
  promptUsed?: string;
  modelTried?: string[];
  durationMs?: number;
  error?: string;
  errorDetails?: unknown;
}

export const DEFAULT_MUSA_PROMPT =
  "Photorealistic 3D portrait of a beautiful young woman with light blonde wavy hair, " +
  "warm friendly smile, wearing modern over-ear headphones, professional studio lighting " +
  "with soft purple (#7C3AED) and cyan (#00D4FF) rim glow, MuzaAi brand aesthetic " +
  "(violet, electric blue, neon green accents), looking directly at camera, " +
  "soft dark gradient background (deep space #0A0A17), high detail, 4K, octane render quality, " +
  "feminine confident expression, music industry vibe, transparent or subtle gradient backdrop";

const IMAGE_OUT_DIR = path.join(process.cwd(), "apps/neurohub/client/public/musa-3d-avatar");
const FALLBACK_OUT_DIR = path.join(process.cwd(), "client/public/musa-3d-avatar");
const SVG_SRC_DIR = path.join(process.cwd(), "apps/neurohub/client/public");
const SVG_FALLBACK_DIR = path.join(process.cwd(), "client/public");

function pickOutDir(): string {
  // На prod runtime cwd может быть /var/www/neurohub/, public живёт в dist/public
  // или client/public. Используем тот что существует; если ни одного — создаём
  // первый.
  for (const d of [IMAGE_OUT_DIR, FALLBACK_OUT_DIR]) {
    const parent = path.dirname(d);
    if (fsSync.existsSync(parent)) return d;
  }
  return IMAGE_OUT_DIR;
}

function pickSvgDir(): string {
  for (const d of [SVG_SRC_DIR, SVG_FALLBACK_DIR]) {
    if (fsSync.existsSync(d)) return d;
  }
  return SVG_SRC_DIR;
}

/** Backup существующего consultant-avatar.svg один раз (svg.bak). */
async function backupConsultantSvg(): Promise<void> {
  const dir = pickSvgDir();
  const src = path.join(dir, "consultant-avatar.svg");
  const dst = path.join(dir, "consultant-avatar.svg.bak");
  try {
    if (fsSync.existsSync(src) && !fsSync.existsSync(dst)) {
      await fs.copyFile(src, dst);
    }
  } catch {
    // best-effort
  }
}

/**
 * Скачать байты из result GPTunnel ответа. Поддерживает:
 *  - { data: [{ url: "https://..." }] }     — OpenAI стандарт
 *  - { data: [{ b64_json: "..." }] }        — OpenAI b64 ответ
 *  - { url: "..." } / { image: "..." }      — наблюдалось у части GPTunnel моделей
 */
async function downloadImageBytes(payload: unknown): Promise<Buffer | null> {
  const j = payload as Record<string, unknown> | null;
  if (!j) return null;
  const data = (j.data as unknown[]) ?? null;
  const first = data && data.length ? (data[0] as Record<string, unknown>) : null;
  const candidates: Array<string | undefined> = [
    (first?.url as string) ?? undefined,
    (first?.image_url as string) ?? undefined,
    (j.url as string) ?? undefined,
    (j.image as string) ?? undefined,
  ];
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
  for (const url of candidates) {
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

/** Список моделей которые GPTunnel proxies для image-gen, в порядке предпочтения. */
const MODEL_CANDIDATES = [
  "dall-e-3",
  "gpt-image-1",
  "flux-pro",
  "flux-1.1-pro",
  "midjourney",
  "stable-diffusion-xl",
];

interface GptunnelImageAttempt {
  model: string;
  endpoint: string;
  httpStatus?: number;
  ok: boolean;
  bodyPreview?: string;
  error?: string;
}

/**
 * Пытается сгенерировать image через GPTunnel /v1/images/generations.
 * Пробует несколько моделей подряд если первая возвращает 404/422 (model not found).
 */
async function tryGptunnelImage(
  prompt: string,
  refImageUrl: string | null,
): Promise<{ buffer: Buffer | null; attempts: GptunnelImageAttempt[]; modelTried: string[] }> {
  const apiKey = gptKeyManager.getActiveKey() || process.env.GPTUNNEL_API_KEY || "";
  const attempts: GptunnelImageAttempt[] = [];
  const modelTried: string[] = [];
  if (!apiKey) {
    attempts.push({ model: "n/a", endpoint: "", ok: false, error: "GPTUNNEL_API_KEY missing" });
    return { buffer: null, attempts, modelTried };
  }

  const endpoints = [
    "https://gptunnel.ru/v1/images/generations",
    // На случай если GPTunnel когда-то выкатит api-поддомен (по аналогии с
    // /v1/audio/transcriptions, где работают оба варианта).
    "https://api.gptunnel.ru/v1/images/generations",
  ];

  for (const model of MODEL_CANDIDATES) {
    modelTried.push(model);
    for (const endpoint of endpoints) {
      const body: Record<string, unknown> = {
        model,
        prompt,
        n: 1,
        size: "1024x1024",
        response_format: "url",
      };
      // image-to-image поддерживается не всеми моделями; передаём как hint,
      // безопасно игнорируется если модель не понимает.
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
        const attempt: GptunnelImageAttempt = {
          model,
          endpoint,
          httpStatus: r.status,
          ok: r.ok,
          bodyPreview: text.slice(0, 300),
        };
        attempts.push(attempt);
        if (!r.ok) {
          gptKeyManager.reportFailure(apiKey, `images/generations ${model}: ${r.status}`, r.status);
          // 401/403 → ключ невалиден, идём дальше может другой ключ выручит
          // 404/422 → модель не найдена, пробуем следующую
          // 5xx → пробуем следующий endpoint same model
          if (r.status === 404 || r.status === 422 || r.status === 400) break; // next model
          continue; // try next endpoint
        }
        const buf = await downloadImageBytes(parsed);
        if (buf && buf.length > 1024) {
          gptKeyManager.reportSuccess(apiKey);
          return { buffer: buf, attempts, modelTried };
        }
        attempts.push({
          model,
          endpoint,
          httpStatus: r.status,
          ok: false,
          error: "parsed OK but no image bytes",
          bodyPreview: text.slice(0, 300),
        });
      } catch (err) {
        attempts.push({
          model,
          endpoint,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { buffer: null, attempts, modelTried };
}

/**
 * Прямой fallback на OpenAI DALL-E 3 (если GPTunnel image-gen не поддержан).
 * Eugene 2026-05-18 Босс: GPTunnel вернул «Not allowed to POST on
 * /v1/images/generations» по всем моделям — нужен другой провайдер.
 * OpenAI DALL-E через прямой API с OPENAI_API_KEY из env.
 *
 * Согласно docs (https://platform.openai.com/docs/api-reference/images/create):
 *   POST https://api.openai.com/v1/images/generations
 *   body: { model: "dall-e-3", prompt, n: 1, size: "1024x1024", quality: "hd" }
 *   resp: { data: [{ url: "..." }] }
 */
async function tryOpenAIImage(prompt: string): Promise<{
  buffer: Buffer | null;
  attempt: GptunnelImageAttempt;
}> {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    return {
      buffer: null,
      attempt: { model: "dall-e-3 (openai)", endpoint: "n/a", ok: false, error: "OPENAI_API_KEY missing" },
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
        size: "1024x1024",
        quality: "hd",
        style: "natural",
        response_format: "url",
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await r.text().catch(() => "");
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    const attempt: GptunnelImageAttempt = {
      model: "dall-e-3 (openai)",
      endpoint,
      httpStatus: r.status,
      ok: r.ok,
      bodyPreview: text.slice(0, 300),
    };
    if (!r.ok) {
      return { buffer: null, attempt };
    }
    const buf = await downloadImageBytes(parsed);
    if (buf && buf.length > 1024) {
      return { buffer: buf, attempt };
    }
    return {
      buffer: null,
      attempt: { ...attempt, ok: false, error: "parsed OK but no image bytes" },
    };
  } catch (err) {
    return {
      buffer: null,
      attempt: {
        model: "dall-e-3 (openai)",
        endpoint,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Основная функция — вызывается из admin endpoint.
 */
export async function generateMusaAvatar3D(
  customPrompt?: string,
  refImageUrl?: string | null,
): Promise<GenerateMusaResult> {
  const startedAt = Date.now();
  const promptUsed = (customPrompt && customPrompt.trim().length >= 12)
    ? customPrompt.trim()
    : DEFAULT_MUSA_PROMPT;

  // 1. GPTunnel — docs.gptunnel.ru НЕ имеет /v1/images/generations endpoint.
  // Пропускаем (Eugene 2026-05-19 docs-research). Только OpenAI DALL-E 3.
  let buffer: Buffer | null = null;
  const modelTried: string[] = [];
  const allAttempts: any[] = [];

  // 2. OpenAI DALL-E 3 — единственный рабочий провайдер
  if (!buffer) {
    const openai = await tryOpenAIImage(promptUsed);
    allAttempts.push(openai.attempt);
    if (openai.buffer) {
      buffer = openai.buffer;
      modelTried.push("dall-e-3 (openai direct)");
    }
  }

  if (!buffer) {
    const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
    return {
      ok: false,
      promptUsed,
      modelTried,
      durationMs: Date.now() - startedAt,
      error: hasOpenAiKey
        ? "Image generation failed: OpenAI вернул ошибку"
        : "Image generation временно недоступен: не настроен OPENAI_API_KEY",
      errorDetails: allAttempts,
    };
  }

  await backupConsultantSvg();

  const outDir = pickOutDir();
  await fs.mkdir(outDir, { recursive: true });

  const png1024Path = path.join(outDir, "musa-3d-1024.png");
  const png512Path = path.join(outDir, "musa-3d-512.png");
  const png256Path = path.join(outDir, "musa-3d-256.png");
  const webp512Path = path.join(outDir, "musa-3d-512.webp");
  const webp256Path = path.join(outDir, "musa-3d-256.webp");

  // Generate all sizes
  await sharp(buffer).resize(1024, 1024, { fit: "cover" }).png({ quality: 92 }).toFile(png1024Path);
  await sharp(buffer).resize(512, 512, { fit: "cover" }).png({ quality: 92 }).toFile(png512Path);
  await sharp(buffer).resize(256, 256, { fit: "cover" }).png({ quality: 92 }).toFile(png256Path);
  await sharp(buffer).resize(512, 512, { fit: "cover" }).webp({ quality: 88 }).toFile(webp512Path);
  await sharp(buffer).resize(256, 256, { fit: "cover" }).webp({ quality: 88 }).toFile(webp256Path);

  return {
    ok: true,
    files: {
      png1024: png1024Path,
      png512: png512Path,
      png256: png256Path,
      webp512: webp512Path,
      webp256: webp256Path,
    },
    publicUrls: {
      png1024: "/musa-3d-avatar/musa-3d-1024.png",
      png512: "/musa-3d-avatar/musa-3d-512.png",
      png256: "/musa-3d-avatar/musa-3d-256.png",
      webp512: "/musa-3d-avatar/musa-3d-512.webp",
      webp256: "/musa-3d-avatar/musa-3d-256.webp",
    },
    promptUsed,
    modelTried,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * «Одобрить» сгенерированный аватар — copy hi-res 1024 → consultant-avatar.png
 * (формат который читает telegram-bot / max-bot через getConsultantPhotoVersion).
 *
 * mtime обновляется автоматически → бот в следующий раз заберёт свежий URL
 * (?v=mtime cache-bust) и обновит file_id в Telegram.
 */
export async function approveMusaAvatar(): Promise<{ ok: boolean; error?: string; copiedTo?: string }> {
  try {
    const outDir = pickOutDir();
    const src256 = path.join(outDir, "musa-3d-256.png");
    if (!fsSync.existsSync(src256)) {
      return { ok: false, error: "musa-3d-256.png not found — сначала запусти генерацию" };
    }
    // consultant-avatar.png лежит в client/public (или dist/public после build).
    const dstCandidates = [
      path.join(process.cwd(), "apps/neurohub/client/public/consultant-avatar.png"),
      path.join(process.cwd(), "client/public/consultant-avatar.png"),
      path.join(process.cwd(), "dist/public/consultant-avatar.png"),
    ];
    const copied: string[] = [];
    for (const dst of dstCandidates) {
      const parent = path.dirname(dst);
      if (!fsSync.existsSync(parent)) continue;
      await fs.copyFile(src256, dst);
      copied.push(dst);
    }
    if (copied.length === 0) {
      return { ok: false, error: "не найдено ни одной директории client/public или dist/public" };
    }
    return { ok: true, copiedTo: copied.join(", ") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Информация о текущем аватаре — exists / mtime / sizes. */
export async function describeCurrentMusaAvatar(): Promise<{
  has3d: boolean;
  has3dPng1024: boolean;
  has3dWebp256: boolean;
  consultantPngMtime: number | null;
  publicUrls: {
    consultantPng: string;
    musa3d1024: string;
    musa3d512: string;
    musa3d256: string;
    musa3dWebp512: string;
    musa3dWebp256: string;
  };
}> {
  const outDir = pickOutDir();
  const svgDir = pickSvgDir();
  const png1024 = path.join(outDir, "musa-3d-1024.png");
  const webp256 = path.join(outDir, "musa-3d-256.webp");
  const consultantPng = path.join(svgDir, "consultant-avatar.png");
  return {
    has3d: fsSync.existsSync(outDir),
    has3dPng1024: fsSync.existsSync(png1024),
    has3dWebp256: fsSync.existsSync(webp256),
    consultantPngMtime: fsSync.existsSync(consultantPng)
      ? Math.floor(fsSync.statSync(consultantPng).mtimeMs)
      : null,
    publicUrls: {
      consultantPng: "/consultant-avatar.png",
      musa3d1024: "/musa-3d-avatar/musa-3d-1024.png",
      musa3d512: "/musa-3d-avatar/musa-3d-512.png",
      musa3d256: "/musa-3d-avatar/musa-3d-256.png",
      musa3dWebp512: "/musa-3d-avatar/musa-3d-512.webp",
      musa3dWebp256: "/musa-3d-avatar/musa-3d-256.webp",
    },
  };
}
