// Eugene 2026-05-18 Босс «таблицу сводного анализа 2 VPS сделай — я подтвержу
// на clone». Собирает срез данных текущего VPS (БД-метрики, размеры
// директорий, git SHA, env-флаги) — для side-by-side сравнения prod vs clone
// в admin-вкладке «🖥 VPS».
//
// NEVER-LEAK-SECRETS rule: ключи только как `hasKey: boolean`, никогда
// значения / даже first8. Согласно Secrets-admin-only rule §1.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { sql } from "drizzle-orm";
import { db } from "../storage";

const KNOWN_PROD_HOSTS = new Set(["muzaai.ru", "muziai.ru", "www.muzaai.ru", "www.muziai.ru"]);
const KNOWN_CLONE_HOSTS = new Set(["clone.muziai.ru", "clone.muzaai.ru"]);

export interface VPSDatabaseStats {
  usersTotal: number;
  usersActive7d: number;
  generationsTotal: number;
  generationsLast24h: number;
  generationsLast7d: number;
  paymentsTotal: number;
  paymentsLast7dSum: number;
  chatSessions: number;
  chatMessages: number;
  userLyricDrafts: number;
  coverFiles: number;
}

export interface VPSDiskStats {
  dataDbSizeBytes: number;
  authorsDirSizeBytes: number;
  uploadsDirSizeBytes: number;
  diskFreePercent: number | null;
}

export interface VPSUptimeStats {
  processUptimeSec: number;
  bootTimeIso: string;
}

export interface VPSVersionStats {
  gitSha: string | null;
  gitBranch: string | null;
  buildTime: string | null;
}

export interface VPSEnvStats {
  nodeEnv: string;
  hasGptunnel: boolean;
  hasOpenai: boolean;
  hasYandex: boolean;
  hasAnthropic: boolean;
  hasRobokassa: boolean;
  hasSmtp: boolean;
  hasTelegram: boolean;
  hasSmsRu: boolean;
  hasOperatorAuth: boolean;
  hasSessionSecret: boolean;
  hasSignedUrlSecret: boolean;
  publicDomain: string;
}

export interface VPSStats {
  hostname: string;
  isProd: boolean;
  isClone: boolean;
  collectedAt: string;
  database: VPSDatabaseStats;
  disk: VPSDiskStats;
  uptime: VPSUptimeStats;
  version: VPSVersionStats;
  env: VPSEnvStats;
}

function countSafe(query: any): number {
  try {
    const r = db.get<{ c: number }>(query);
    return r?.c ?? 0;
  } catch {
    return 0;
  }
}

function sumSafe(query: any): number {
  try {
    const r = db.get<{ s: number | null }>(query);
    return Math.round((r?.s ?? 0) as number);
  } catch {
    return 0;
  }
}

function readGitInfo(repoRoot: string): { sha: string | null; branch: string | null } {
  // .git/HEAD → если "ref: refs/heads/<branch>" — читаем sha из этого ref-файла.
  // Иначе HEAD сам содержит detached SHA.
  try {
    const headPath = path.join(repoRoot, ".git", "HEAD");
    if (!fs.existsSync(headPath)) return { sha: null, branch: null };
    const head = fs.readFileSync(headPath, "utf-8").trim();
    if (head.startsWith("ref: ")) {
      const ref = head.slice(5);
      const branch = ref.replace(/^refs\/heads\//, "");
      const refPath = path.join(repoRoot, ".git", ref);
      if (fs.existsSync(refPath)) {
        const sha = fs.readFileSync(refPath, "utf-8").trim();
        return { sha: sha.slice(0, 12), branch };
      }
      // packed-refs fallback
      const packedPath = path.join(repoRoot, ".git", "packed-refs");
      if (fs.existsSync(packedPath)) {
        const packed = fs.readFileSync(packedPath, "utf-8");
        for (const line of packed.split("\n")) {
          if (line.endsWith(" " + ref)) {
            return { sha: line.slice(0, 12), branch };
          }
        }
      }
      return { sha: null, branch };
    }
    return { sha: head.slice(0, 12), branch: null };
  } catch {
    return { sha: null, branch: null };
  }
}

function safeStatSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function dirSizeBytes(dir: string, maxEntries: number = 50_000): number {
  // Non-recursive estimate: считает прямой размер всех записей + рекурсивно
  // спускается до лимита. Для крупных authors/ это даёт O(N) с потолком.
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  let count = 0;
  const stack: string[] = [dir];
  try {
    while (stack.length > 0 && count < maxEntries) {
      const cur = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        count++;
        if (count >= maxEntries) break;
        const full = path.join(cur, e.name);
        try {
          if (e.isDirectory()) {
            stack.push(full);
          } else if (e.isFile()) {
            const st = fs.statSync(full);
            total += st.size;
          }
        } catch {
          // skip permission errors
        }
      }
    }
  } catch {
    // swallow — частичный результат тоже OK
  }
  return total;
}

function diskFreePercent(targetPath: string): number | null {
  // Node нативно не даёт df. Используем `statfs` (Node 18+). Fallback null.
  try {
    const sf = (fs as any).statfsSync?.(targetPath);
    if (!sf) return null;
    const total = sf.blocks * sf.bsize;
    const free = sf.bavail * sf.bsize;
    if (total === 0) return null;
    return Math.round((free / total) * 100);
  } catch {
    return null;
  }
}

function detectHostname(): { hostname: string; isProd: boolean; isClone: boolean } {
  const fromEnv = (process.env.BASE_DOMAIN || process.env.PUBLIC_DOMAIN || "").trim();
  const hostname = fromEnv || os.hostname() || "unknown";
  const lower = hostname.toLowerCase();
  const isClone = KNOWN_CLONE_HOSTS.has(lower) || lower.includes("clone.");
  const isProd = !isClone && (KNOWN_PROD_HOSTS.has(lower) || lower === "muzaai.ru" || lower === "muziai.ru");
  return { hostname, isProd, isClone };
}

export async function collectVPSStats(): Promise<VPSStats> {
  const { hostname, isProd, isClone } = detectHostname();
  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const database: VPSDatabaseStats = {
    usersTotal: countSafe(sql`SELECT count(*) as c FROM users`),
    usersActive7d: countSafe(sql`SELECT count(DISTINCT user_id) as c FROM generations WHERE created_at >= ${since7d}`),
    generationsTotal: countSafe(sql`SELECT count(*) as c FROM generations WHERE deleted_at IS NULL`),
    generationsLast24h: countSafe(sql`SELECT count(*) as c FROM generations WHERE deleted_at IS NULL AND created_at >= ${since24h}`),
    generationsLast7d: countSafe(sql`SELECT count(*) as c FROM generations WHERE deleted_at IS NULL AND created_at >= ${since7d}`),
    paymentsTotal: countSafe(sql`SELECT count(*) as c FROM payments WHERE status='paid'`),
    paymentsLast7dSum: sumSafe(sql`SELECT COALESCE(sum(amount), 0) as s FROM payments WHERE status='paid' AND created_at >= ${since7d}`),
    chatSessions: countSafe(sql`SELECT count(*) as c FROM chatbot_sessions`),
    chatMessages: countSafe(sql`SELECT count(*) as c FROM chatbot_messages`),
    userLyricDrafts: countSafe(sql`SELECT count(*) as c FROM song_drafts`),
    coverFiles: countSafe(sql`SELECT count(*) as c FROM generations WHERE cover_url IS NOT NULL AND deleted_at IS NULL`),
  };

  const dbFile = process.env.DATABASE_FILE || "data.db";
  const dbPath = path.isAbsolute(dbFile) ? dbFile : path.resolve(process.cwd(), dbFile);
  const authorsDir = process.env.AUTHORS_DIR || path.resolve(process.cwd(), "authors");
  const uploadsDir = process.env.UPLOADS_DIR || "/var/www/neurohub/uploads";

  const disk: VPSDiskStats = {
    dataDbSizeBytes: safeStatSize(dbPath),
    authorsDirSizeBytes: dirSizeBytes(authorsDir),
    uploadsDirSizeBytes: dirSizeBytes(uploadsDir),
    diskFreePercent: diskFreePercent(process.cwd()),
  };

  const uptime: VPSUptimeStats = {
    processUptimeSec: Math.round(process.uptime()),
    bootTimeIso: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };

  const gitInfo = readGitInfo(process.cwd());
  let buildTime: string | null = null;
  try {
    // dist/index.cjs mtime (если есть собранный bundle) — это и есть «build time».
    const distPath = path.resolve(process.cwd(), "dist", "index.cjs");
    if (fs.existsSync(distPath)) {
      buildTime = fs.statSync(distPath).mtime.toISOString();
    }
  } catch {
    // ignore
  }
  const version: VPSVersionStats = {
    gitSha: gitInfo.sha,
    gitBranch: gitInfo.branch,
    buildTime,
  };

  const env: VPSEnvStats = {
    nodeEnv: process.env.NODE_ENV || "development",
    hasGptunnel: !!process.env.GPTUNNEL_API_KEY,
    hasOpenai: !!process.env.OPENAI_API_KEY,
    hasYandex: !!process.env.YANDEX_SPEECHKIT_API_KEY,
    hasAnthropic: !!process.env.ANTHROPIC_API_KEY,
    hasRobokassa:
      !!process.env.ROBO_PASSWORD_1 && !!process.env.ROBO_PASSWORD_2 && !!process.env.ROBOKASSA_LOGIN,
    hasSmtp: !!process.env.GMAIL_APP_PASSWORD || !!process.env.SMTP_PASS,
    hasTelegram: !!process.env.TELEGRAM_BOT_TOKEN,
    hasSmsRu: !!process.env.SMSRU_API_ID,
    hasOperatorAuth: !!process.env.COMMAND_OPERATOR_HASH,
    hasSessionSecret: !!process.env.SESSION_SECRET,
    hasSignedUrlSecret: !!process.env.SIGNED_URL_SECRET,
    publicDomain: process.env.BASE_DOMAIN || process.env.PUBLIC_DOMAIN || "muzaai.ru",
  };

  return {
    hostname,
    isProd,
    isClone,
    collectedAt: new Date().toISOString(),
    database,
    disk,
    uptime,
    version,
    env,
  };
}

// === Diff helper ===

export type Severity = "low" | "medium" | "high";

export interface CriticalDiff {
  field: string;
  local: unknown;
  remote: unknown;
  severity: Severity;
  note?: string;
}

function diffEnvKeys(local: VPSEnvStats, remote: VPSEnvStats, out: CriticalDiff[]): void {
  const envKeys: Array<keyof VPSEnvStats> = [
    "hasGptunnel", "hasOpenai", "hasYandex", "hasAnthropic",
    "hasRobokassa", "hasSmtp", "hasTelegram", "hasSmsRu",
    "hasOperatorAuth", "hasSessionSecret", "hasSignedUrlSecret",
  ];
  for (const k of envKeys) {
    if (local[k] !== remote[k]) {
      out.push({
        field: `env.${k}`,
        local: local[k],
        remote: remote[k],
        severity: k === "hasGptunnel" || k === "hasRobokassa" ? "high" : "medium",
        note: "Ключ присутствует только на одной стороне",
      });
    }
  }
  if (local.nodeEnv !== remote.nodeEnv) {
    out.push({
      field: "env.nodeEnv",
      local: local.nodeEnv,
      remote: remote.nodeEnv,
      severity: "low",
      note: "Разные NODE_ENV — норма для prod vs clone",
    });
  }
}

export function computeDiff(local: VPSStats, remote: VPSStats): { criticalDiffs: CriticalDiff[]; missingOnClone: string[] } {
  const criticalDiffs: CriticalDiff[] = [];
  const missingOnClone: string[] = [];

  if (local.version.gitSha && remote.version.gitSha && local.version.gitSha !== remote.version.gitSha) {
    criticalDiffs.push({
      field: "version.gitSha",
      local: local.version.gitSha,
      remote: remote.version.gitSha,
      severity: "high",
      note: "Разные сборки — один из VPS отстаёт",
    });
  }
  if (local.version.gitBranch && remote.version.gitBranch && local.version.gitBranch !== remote.version.gitBranch) {
    criticalDiffs.push({
      field: "version.gitBranch",
      local: local.version.gitBranch,
      remote: remote.version.gitBranch,
      severity: "medium",
      note: "Разные ветки auto-deploy",
    });
  }

  const numDiff = (field: string, lv: number, rv: number, severityThresholdPct: number = 10): void => {
    if (lv === 0 && rv === 0) return;
    const base = Math.max(lv, rv, 1);
    const pct = Math.abs(lv - rv) / base * 100;
    if (pct >= severityThresholdPct) {
      criticalDiffs.push({
        field,
        local: lv,
        remote: rv,
        severity: pct >= 50 ? "high" : pct >= 25 ? "medium" : "low",
        note: `Разница ${pct.toFixed(0)}%`,
      });
    }
  };
  numDiff("database.usersTotal", local.database.usersTotal, remote.database.usersTotal, 5);
  numDiff("database.generationsTotal", local.database.generationsTotal, remote.database.generationsTotal, 5);
  numDiff("database.paymentsTotal", local.database.paymentsTotal, remote.database.paymentsTotal, 5);

  diffEnvKeys(local.env, remote.env, criticalDiffs);

  // missingOnClone: env-keys которые есть на prod но нет на clone (типичный
  // случай — clone не имеет реальных payment-passwords / SMS).
  const cloneStats = local.isClone ? local : remote.isClone ? remote : null;
  const prodStats = local.isProd ? local : remote.isProd ? remote : null;
  if (cloneStats && prodStats) {
    const envKeys: Array<keyof VPSEnvStats> = [
      "hasGptunnel", "hasOpenai", "hasYandex", "hasAnthropic",
      "hasRobokassa", "hasSmtp", "hasTelegram", "hasSmsRu",
      "hasOperatorAuth",
    ];
    for (const k of envKeys) {
      if (prodStats.env[k] && !cloneStats.env[k]) {
        missingOnClone.push(k);
      }
    }
  }

  return { criticalDiffs, missingOnClone };
}
