// Eugene 2026-05-17 Босс «iOS lock-screen показывает MuzaAi logo вместо
// реальной обложки трека». Корень: при saveGenFiles() мы кладём mp3 рядом
// с jpg, но в сам mp3-файл НЕ встраиваем APIC (cover art) frame. iOS
// читает ID3 напрямую из stream-байтов mp3 (особенно когда трек играет
// через Bluetooth/CarPlay/AirPlay или после refresh страницы) → APIC
// отсутствует → лок-скрин показывает дефолтную картинку приложения.
//
// Этот модуль — единая точка для встраивания ID3 (title/artist/album/
// comment + APIC) в mp3-файл. Используется:
//  1. saveGenFiles() (routes.ts:144) — при первом сохранении нового трека
//  2. backfill /api/admin/v304/id3-rebuild — переписывает все existing mp3
//  3. rename / cover-attach / author-rename (уже встроенные точки) — для
//     консистентности заменить на embedTrackId3({ keepImage: true }) с
//     явным указанием поля что меняется.
//
// Правила (см. MuzaAi.ru-since-150526 rule в CLAUDE.md):
//   - album   = "MuzaAi.ru"
//   - artist  = `MuzaAi · ${authorName}` (или просто "MuzaAi" если нет имени)
//   - comment = PUBLIC_URL
//   - title   = gen.displayTitle / prompt-fallback
//   - image   = APIC из реальной cover-jpg (gen_<id>.jpg, либо coverGenId)
//
// Если cover недоступен (файл отсутствует) — ID3 пишется БЕЗ APIC frame
// (не вписываем logo MuzaAi как fallback — это и было корнем бага). Это
// гарантирует что iOS либо покажет реальную обложку, либо вернётся к
// generic-логике (без приложения-специфичной заглушки).

import fs from "fs";
import path from "path";
import NodeID3 from "node-id3";
import { PUBLIC_URL } from "./publicUrl";

const AUTHORS_DIR = process.env.AUTHORS_DIR || path.join(process.cwd(), "authors");

export interface EmbedTrackId3Options {
  /** Полный путь к mp3-файлу (обязательно). */
  mp3Path: string;
  /** Название трека (TIT2). */
  title?: string | null;
  /** Имя автора (для artist=`MuzaAi · {authorName}`). Пустое → artist="MuzaAi". */
  authorName?: string | null;
  /**
   * Полный путь к cover-image (jpg/png) — будет встроен в APIC frame.
   * Если null/undefined/не существует — APIC не записывается, существующий
   * APIC (если был) сохраняется через keepExistingImage по умолчанию.
   */
  coverPath?: string | null;
  /**
   * Если true (default) и coverPath не указан — оставить существующий
   * APIC в mp3 без изменений. Если false — APIC будет очищен.
   */
  keepExistingImage?: boolean;
  /** Размер cover для resize через sharp (default 512×512). Если sharp не доступен — буфер пишется как есть. */
  resizeTo?: number;
  /**
   * Если true — при сжатии cover через sharp применять mode='cover' (crop
   * центром до квадрата). При false — 'inside' (не растягивать). Default true.
   */
  cropToSquare?: boolean;
}

export interface EmbedTrackId3Result {
  ok: boolean;
  mp3Path: string;
  /** Были ли установлены тэги (true если NodeID3.update вернул не-false). */
  tagsWritten: boolean;
  /** Был ли встроен новый APIC (cover image). */
  imageEmbedded: boolean;
  /** Источник cover ('argument' | 'sibling-jpg' | 'kept-existing' | 'none'). */
  coverSource: "argument" | "sibling-jpg" | "kept-existing" | "none";
  /** Размер APIC буфера в байтах (если imageEmbedded=true). */
  imageBytes?: number;
  /** Сообщение об ошибке (если ok=false). */
  error?: string;
}

/**
 * Найти sibling-jpg рядом с mp3-файлом (тот же путь, но расширение .jpg).
 * Возвращает абсолютный путь или null. Также пробует .jpeg / .png / .webp.
 */
export function findSiblingCover(mp3Path: string): string | null {
  for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
    const candidate = mp3Path.replace(/\.[^.]+$/, ext);
    if (candidate !== mp3Path && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Главная функция — встроить ID3 (title/artist/album/comment + APIC) в mp3.
 * НЕ ломает audio-data (NodeID3.update переписывает только метаданные).
 *
 * Безопасно вызывать многократно (idempotent): один и тот же APIC будет
 * перезаписан тем же буфером, audio-payload остаётся неизменным.
 */
export async function embedTrackId3(opts: EmbedTrackId3Options): Promise<EmbedTrackId3Result> {
  const { mp3Path } = opts;
  const result: EmbedTrackId3Result = {
    ok: false,
    mp3Path,
    tagsWritten: false,
    imageEmbedded: false,
    coverSource: "none",
  };

  if (!fs.existsSync(mp3Path)) {
    result.error = "mp3 file not found";
    return result;
  }

  try {
    const existing = (NodeID3.read(mp3Path) as Record<string, unknown>) || {};

    const title =
      (opts.title && opts.title.trim()) ||
      (typeof existing.title === "string" ? existing.title : null) ||
      "MuzaAi Track";

    const artist = opts.authorName && opts.authorName.trim()
      ? `MuzaAi · ${opts.authorName.trim()}`
      : "MuzaAi";

    const tags: Record<string, unknown> = {
      title,
      artist,
      album: "MuzaAi.ru",
      comment: { language: "rus", text: PUBLIC_URL },
    };

    // Determine cover source:
    //   1) explicit opts.coverPath if exists
    //   2) sibling jpg (same path, .jpg extension)
    //   3) keep existing APIC if keepExistingImage !== false
    //   4) none → omit image entry → existing APIC stays unchanged in
    //      NodeID3.update (update only changes provided fields)
    let coverBuf: Buffer | null = null;
    let coverSource: EmbedTrackId3Result["coverSource"] = "none";

    let coverCandidate: string | null = null;
    if (opts.coverPath && fs.existsSync(opts.coverPath)) {
      coverCandidate = opts.coverPath;
      coverSource = "argument";
    } else {
      const sibling = findSiblingCover(mp3Path);
      if (sibling) {
        coverCandidate = sibling;
        coverSource = "sibling-jpg";
      }
    }

    if (coverCandidate) {
      try {
        const raw = fs.readFileSync(coverCandidate);
        const targetSize = opts.resizeTo ?? 512;
        let processed = raw;
        try {
          // Resize through sharp to a square cover. iOS lockscreen prefers
          // square art at 512px; this also keeps APIC payload small (~80KB)
          // so mp3 metadata doesn't bloat by megabytes.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const sharp = require("sharp");
          const fit = opts.cropToSquare === false ? "inside" : "cover";
          processed = await sharp(raw)
            .resize(targetSize, targetSize, { fit })
            .jpeg({ quality: 90 })
            .toBuffer();
        } catch {
          // sharp not available or failed — use raw buffer; iOS still
          // accepts arbitrary jpg/png in APIC, just may be larger.
        }
        coverBuf = processed;
      } catch (e) {
        // cover read failed → fall back to kept-existing if allowed
        coverBuf = null;
        coverSource = "none";
      }
    }

    if (coverBuf) {
      tags.image = {
        mime: "image/jpeg",
        type: { id: 3, name: "front cover" },
        description: "Cover",
        imageBuffer: coverBuf,
      };
      result.imageEmbedded = true;
      result.imageBytes = coverBuf.length;
      result.coverSource = coverSource;
    } else if (opts.keepExistingImage !== false && (existing as { image?: unknown }).image) {
      // keep whatever APIC was already in the file
      tags.image = (existing as { image?: unknown }).image;
      result.coverSource = "kept-existing";
    }

    const updateResult = NodeID3.update(tags, mp3Path);
    result.tagsWritten = updateResult !== false;
    result.ok = result.tagsWritten;
    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }
}

/**
 * Convenience: embed ID3 for a generation row. Caller passes loaded `gen`
 * (from db.select().from(generations)) and optional cover override path.
 *
 * - mp3Path is derived from AUTHORS_DIR + gen.localPath
 * - coverPath default = sibling jpg next to mp3 (gen_<id>.jpg)
 */
export async function embedTrackId3ForGen(gen: {
  id: number;
  localPath?: string | null;
  displayTitle?: string | null;
  prompt?: string | null;
  authorName?: string | null;
  type?: string | null;
}, override?: { coverPath?: string | null; title?: string | null }): Promise<EmbedTrackId3Result> {
  if (!gen.localPath || gen.type !== "music") {
    return {
      ok: false,
      mp3Path: "",
      tagsWritten: false,
      imageEmbedded: false,
      coverSource: "none",
      error: "not a music gen with localPath",
    };
  }
  const mp3Path = path.join(AUTHORS_DIR, gen.localPath);
  const fallbackTitle = gen.displayTitle || (gen.prompt ? gen.prompt.slice(0, 80) : null);
  return embedTrackId3({
    mp3Path,
    title: override?.title ?? fallbackTitle,
    authorName: gen.authorName ?? null,
    coverPath: override?.coverPath ?? null,
    keepExistingImage: true,
  });
}
