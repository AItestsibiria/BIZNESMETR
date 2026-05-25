// Eugene 2026-05-25 security hardening (LOW-RISK approved set).
//
// App-level авто-бэкап SQLite. Делает КОНСИСТЕНТНЫЙ снапшот data.db через
// better-sqlite3 `.backup()` API (online backup без блокировки писателей),
// gzip'ит, складывает в BACKUP_DIR с именем по Backup-naming rule
// (MuzaAi-Triumph-DDMMYY-HHMM.tar.gz). Логирует успех/ошибку в self-migrating
// таблицу `backup_log`.
//
// === Reuse-working-solutions ===
//  - (db as any).$client — better-sqlite3 handle (как в ferzAgent / storage).
//  - сам процесс делает .backup() в свой data.db (онлайн, консистентно).
//
// === Defensive ===
// Всё в try/catch, НИКОГДА не throw'ит — падение бэкапа не должно ронять cron.
//
// === Secrets-admin-only ===
// .env / секреты в бэкап НЕ включаются (только data.db [+ authors при full]).

import { db } from "../storage";
import { sanitizeError } from "./sanitizeSecrets";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execFileSync } from "child_process";

function sqlite(): any {
  return (db as any).$client;
}

const DB_FILE = process.env.DATABASE_FILE || "data.db";
const BACKUP_DIR = process.env.BACKUP_DIR || "/var/backups/neurohub-app";
const AUTHORS_DIR = process.env.AUTHORS_DIR || "authors";

export interface BackupResult {
  ok: boolean;
  error?: string;
  path?: string;
  sizeBytes?: number;
  sha256?: string;
  kind?: "db" | "full";
  createdAt?: number;
}

// ====================== Auto-migrate ======================

let migrated = false;
function ensureBackupLogTable(): void {
  if (migrated) return;
  try {
    sqlite().exec(`
      CREATE TABLE IF NOT EXISTS backup_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        kind TEXT,
        path TEXT,
        size_bytes INTEGER,
        sha256 TEXT,
        ok INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_backup_log_created ON backup_log(created_at DESC);
    `);
    migrated = true;
  } catch (e) {
    console.warn("[auto-backup] migration failed:", sanitizeError(e));
  }
}

function recordBackupLog(r: BackupResult): void {
  try {
    ensureBackupLogTable();
    sqlite()
      .prepare(
        `INSERT INTO backup_log (created_at, kind, path, size_bytes, sha256, ok, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.createdAt || Date.now(),
        r.kind || "db",
        r.path || null,
        r.sizeBytes || null,
        r.sha256 || null,
        r.ok ? 1 : 0,
        r.error ? sanitizeError(r.error).slice(0, 500) : null,
      );
  } catch (e) {
    console.warn("[auto-backup] recordBackupLog failed:", sanitizeError(e));
  }
}

// ====================== Имя по Backup-naming rule ======================

function backupBaseName(now: Date): string {
  // MuzaAi-Triumph-DDMMYY-HHMM (.tar.gz добавляется снаружи).
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `MuzaAi-Triumph-${dd}${mm}${yy}-${hh}${min}`;
}

function sha256File(file: string): string {
  try {
    const buf = fs.readFileSync(file);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return "";
  }
}

// ====================== Retention ======================

// Хранение: 14 daily (DB-only) + 8 weekly (full). Имена сортируемы по mtime.
function pruneOldBackups(): void {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("MuzaAi-Triumph-") && f.endsWith(".tar.gz"))
      .map((f) => {
        const full = path.join(BACKUP_DIR, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {}
        return { f, full, mtime, isFull: f.includes("-full") };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const daily = files.filter((x) => !x.isFull);
    const weekly = files.filter((x) => x.isFull);

    const toDelete = [...daily.slice(14), ...weekly.slice(8)];
    for (const x of toDelete) {
      try {
        fs.unlinkSync(x.full);
      } catch (e) {
        console.warn("[auto-backup] prune unlink failed:", x.f, sanitizeError(e));
      }
    }
  } catch (e) {
    console.warn("[auto-backup] pruneOldBackups failed:", sanitizeError(e));
  }
}

// ====================== Основной бэкап ======================

/**
 * Делает консистентный снапшот data.db (better-sqlite3 .backup() — online).
 * gzip → tar.gz в BACKUP_DIR. При withAuthors:true дополнительно архивирует
 * authors/ (mp3 + обложки) — weekly full. Никогда не throw'ит.
 */
export async function runDbBackup(opts?: { withAuthors?: boolean }): Promise<BackupResult> {
  const withAuthors = opts?.withAuthors === true;
  const now = new Date();
  const createdAt = now.getTime();
  const kind: "db" | "full" = withAuthors ? "full" : "db";

  let tmpSnapshot: string | null = null;
  try {
    // mkdir -p BACKUP_DIR с mode 700.
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(BACKUP_DIR, 0o700);
    } catch {
      /* mode best-effort */
    }

    const base = backupBaseName(now) + (withAuthors ? "-full" : "");
    const archivePath = path.join(BACKUP_DIR, `${base}.tar.gz`);

    // 1) Консистентный online-снапшот data.db во временный файл.
    tmpSnapshot = path.join(os.tmpdir(), `${base}-snapshot.db`);
    const handle = sqlite();
    if (handle && typeof handle.backup === "function") {
      // better-sqlite3 .backup() — async (возвращает Promise).
      await handle.backup(tmpSnapshot);
    } else {
      // Fallback: WAL checkpoint + file copy (если .backup недоступен).
      try {
        handle?.pragma?.("wal_checkpoint(TRUNCATE)");
      } catch {
        /* checkpoint best-effort */
      }
      fs.copyFileSync(DB_FILE, tmpSnapshot);
    }

    // 2) tar.gz: снапшот БД (+ authors/ при full). Используем системный tar
    //    (он есть на VPS; на проде это стандарт). -C для коротких путей внутри.
    const snapDir = path.dirname(tmpSnapshot);
    const snapName = path.basename(tmpSnapshot);
    const tarArgs = ["-czf", archivePath, "-C", snapDir, snapName];

    if (withAuthors) {
      const authorsAbs = path.resolve(AUTHORS_DIR);
      if (fs.existsSync(authorsAbs)) {
        tarArgs.push("-C", path.dirname(authorsAbs), path.basename(authorsAbs));
      } else {
        console.warn("[auto-backup] authors dir not found, skipping:", authorsAbs);
      }
    }

    execFileSync("tar", tarArgs, { stdio: "ignore" });

    // 3) Метаданные.
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(archivePath).size;
    } catch {}
    const sha256 = sha256File(archivePath);
    try {
      fs.chmodSync(archivePath, 0o600);
    } catch {
      /* mode best-effort */
    }

    const result: BackupResult = {
      ok: true,
      path: archivePath,
      sizeBytes,
      sha256,
      kind,
      createdAt,
    };
    recordBackupLog(result);
    pruneOldBackups();
    return result;
  } catch (e) {
    const error = sanitizeError(e);
    console.error("[auto-backup] runDbBackup failed:", error);
    const result: BackupResult = { ok: false, error, kind, createdAt };
    recordBackupLog(result);
    return result;
  } finally {
    // Чистим временный снапшот.
    if (tmpSnapshot) {
      try {
        if (fs.existsSync(tmpSnapshot)) fs.unlinkSync(tmpSnapshot);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Последний УСПЕШНЫЙ бэкап из backup_log (или null). Используется
 * securityAgent для проверки свежести бэкапа.
 */
export function getLastBackup(): BackupResult | null {
  try {
    ensureBackupLogTable();
    const row = sqlite()
      .prepare(`SELECT * FROM backup_log WHERE ok = 1 ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get() as
      | {
          created_at: number;
          kind: string | null;
          path: string | null;
          size_bytes: number | null;
          sha256: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      ok: true,
      createdAt: Number(row.created_at || 0),
      kind: (row.kind as "db" | "full") || "db",
      path: row.path || undefined,
      sizeBytes: row.size_bytes != null ? Number(row.size_bytes) : undefined,
      sha256: row.sha256 || undefined,
    };
  } catch (e) {
    console.warn("[auto-backup] getLastBackup failed:", sanitizeError(e));
    return null;
  }
}
