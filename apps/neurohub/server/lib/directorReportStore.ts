// Eugene 2026-05-25 Босс «если нажал озвучь итоги и не прослушал — продолжай
// формировать аудио, позже прослушаю; сохраняй итоги аудио 7 дней; могу из
// админки прослушать».
//
// Аудио-доклады Директора (text + TTS mp3 base64) сохраняются в БД на 7 дней.
// Генерация на сервере завершается независимо от того, слушал ли клиент —
// поэтому достаточно ПЕРСИСТИТЬ результат: позже прослушаешь из админки.
//
// Хранилище: self-migrating таблица director_voice_reports. Cleanup >7 дней
// при каждом сохранении. Audio как base64 (≈80KB/доклад, ~20 докладов = ~1.6MB).

import { db } from "../storage";

const TTL_MS = 7 * 24 * 3600_000;
let migrated = false;

function ensureTable(): void {
  if (migrated) return;
  try {
    (db as any).$client.exec(`
      CREATE TABLE IF NOT EXISTS director_voice_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period TEXT,
        period_label TEXT,
        text_summary TEXT,
        audio_base64 TEXT,
        audio_content_type TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dvr_created ON director_voice_reports(created_at DESC);
    `);
    migrated = true;
  } catch (e) {
    console.warn("[directorReportStore] migration failed:", e);
  }
}

function cleanupOld(): void {
  try {
    (db as any).$client.prepare(`DELETE FROM director_voice_reports WHERE created_at < ?`).run(Date.now() - TTL_MS);
  } catch {}
}

export function saveDirectorReport(r: {
  period?: string; periodLabel?: string; text?: string;
  audioBase64?: string | null; audioContentType?: string | null;
}): number | null {
  ensureTable();
  try {
    const res: any = (db as any).$client.prepare(
      `INSERT INTO director_voice_reports (period, period_label, text_summary, audio_base64, audio_content_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      r.period || null, r.periodLabel || null, (r.text || "").slice(0, 8000),
      r.audioBase64 || null, r.audioContentType || null, Date.now(),
    );
    cleanupOld();
    return Number(res?.lastInsertRowid || 0);
  } catch (e) {
    console.warn("[directorReportStore] save failed:", e);
    return null;
  }
}

export function listDirectorReports(): Array<{
  id: number; period: string | null; periodLabel: string | null;
  createdAt: number; hasAudio: boolean; preview: string;
}> {
  ensureTable();
  cleanupOld();
  try {
    const rows: any[] = (db as any).$client.prepare(
      `SELECT id, period, period_label, text_summary, audio_base64, created_at
       FROM director_voice_reports ORDER BY created_at DESC LIMIT 50`
    ).all();
    return rows.map(r => ({
      id: r.id, period: r.period, periodLabel: r.period_label,
      createdAt: Number(r.created_at), hasAudio: !!r.audio_base64,
      preview: String(r.text_summary || "").slice(0, 160),
    }));
  } catch { return []; }
}

export function getDirectorReport(id: number): {
  id: number; period: string | null; periodLabel: string | null;
  text: string; audioBase64: string | null; audioContentType: string | null; createdAt: number;
} | null {
  ensureTable();
  try {
    const r: any = (db as any).$client.prepare(
      `SELECT * FROM director_voice_reports WHERE id = ?`
    ).get(id);
    if (!r) return null;
    return {
      id: r.id, period: r.period, periodLabel: r.period_label,
      text: r.text_summary || "", audioBase64: r.audio_base64 || null,
      audioContentType: r.audio_content_type || null, createdAt: Number(r.created_at),
    };
  } catch { return null; }
}
