// musaKnowledgeLoader.ts — Eugene 2026-05-18 Босс «Муза изучает проект как мы».
//
// Lightweight project-knowledge loader для Музы. Каждый chat-call buildPersonaSystem
// получает дополнительный блок ADDITIONAL PROJECT CONTEXT — Муза видит:
//   • CLAUDE.md (правила + персонажи + паттерны проекта)
//   • docs/strategy/KNOWLEDGE-BASE-BOT.md (client-facing KB — уже грузится через loadKB,
//     дублировать не будем — но KB остаётся primary source-of-truth для клиентов)
//   • docs/strategy/PITFALLS.md (анти-паттерны, что НЕ делать)
//   • docs/strategy/MUZA-MEMORY-DESIGN-180526.md (memory architecture)
//   • docs/robokassa-package/04-description.md (тарифы)
//   • docs/robokassa-package/03-refund.md (возвраты)
//   • последние 50 commit messages (git log)
//
// Cache:
//   • TTL 60 минут — по умолчанию
//   • mtime-based invalidation на каждом файле (если файл изменился —
//     перечитываем сразу, не ждём TTL)
//
// Лимит размера: каждый файл → max ~15 KB (отрезаем хвост), общий блок ≤ 80 KB.
// Это lightweight memory — полный full-context архитектуре будет в Memory System
// (см. MUZA-MEMORY-DESIGN-180526.md), отдельной большой задачей.

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 минут
const MAX_FILE_BYTES = 15 * 1024;    // 15 KB на файл
const MAX_TOTAL_BYTES = 80 * 1024;   // 80 KB общий лимит

type CacheEntry = {
  text: string;
  loadedAt: number;
  // map filename → mtimeMs, для invalidation
  mtimes: Record<string, number>;
  // последний прочитанный git HEAD SHA (commit messages — invalidate'им
  // если HEAD сменился)
  gitHead: string | null;
};

let cache: CacheEntry | null = null;

// Кандидаты путей к репо/файлам. Чтобы работало и на VPS (/var/www/neurohub,
// /opt/muziai-src) и локально (process.cwd()).
function candidateRoots(): string[] {
  return [
    "/opt/muziai-src",
    "/var/www/neurohub",
    process.cwd(),
    path.join(process.cwd(), "../.."),
    path.join(process.cwd(), "../../.."),
  ];
}

function findFile(relPath: string): string | null {
  for (const root of candidateRoots()) {
    try {
      const p = path.join(root, relPath);
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function readFileSafe(absPath: string, maxBytes: number = MAX_FILE_BYTES): string {
  try {
    const buf = fs.readFileSync(absPath);
    if (buf.byteLength <= maxBytes) return buf.toString("utf-8");
    return buf.subarray(0, maxBytes).toString("utf-8") + "\n…[truncated]";
  } catch {
    return "";
  }
}

function getMtimeMs(absPath: string): number {
  try {
    return fs.statSync(absPath).mtimeMs;
  } catch {
    return 0;
  }
}

function readGitHead(): string | null {
  for (const root of candidateRoots()) {
    try {
      const head = execSync("git rev-parse HEAD", {
        cwd: root,
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString("utf-8").trim();
      if (head && head.length >= 7) return head;
    } catch {}
  }
  return null;
}

function readRecentCommits(limit: number = 50): string {
  for (const root of candidateRoots()) {
    try {
      const out = execSync(
        `git log --pretty=format:"%h %s" -${limit}`,
        { cwd: root, timeout: 2500, stdio: ["ignore", "pipe", "ignore"] },
      ).toString("utf-8").trim();
      if (out) return out;
    } catch {}
  }
  return "";
}

// Список загружаемых файлов с относительным путём в репо.
const FILES_TO_LOAD: Array<{ rel: string; label: string }> = [
  { rel: "CLAUDE.md", label: "CLAUDE.md — rules + patterns" },
  { rel: "docs/strategy/PITFALLS.md", label: "PITFALLS — анти-паттерны" },
  { rel: "docs/strategy/MUZA-MEMORY-DESIGN-180526.md", label: "MUZA-MEMORY-DESIGN — architecture" },
  { rel: "docs/robokassa-package/04-description.md", label: "ROBOKASSA description — тарифы" },
  { rel: "docs/robokassa-package/03-refund.md", label: "ROBOKASSA refund — возвраты" },
];

/**
 * Загружает project knowledge для Музы.
 *
 * Возвращает concatenated text (или пустую строку если ничего не нашлось).
 * Cache 60 мин + mtime-based invalidation на каждом файле + git HEAD diff.
 *
 * Использование: buildPersonaSystem() аппендит этот текст как ADDITIONAL KNOWLEDGE
 * блок в system prompt. Чтобы Муза при каждом chat call видела свежий project
 * knowledge — без раздувания base persona prompt.
 */
export function loadProjectKnowledge(): string {
  const now = Date.now();

  // Файл-кандидаты + mtimeMs
  const resolved: Array<{ rel: string; label: string; abs: string; mtime: number }> = [];
  for (const f of FILES_TO_LOAD) {
    const abs = findFile(f.rel);
    if (!abs) continue;
    resolved.push({ ...f, abs, mtime: getMtimeMs(abs) });
  }
  const currentMtimes: Record<string, number> = {};
  for (const r of resolved) currentMtimes[r.abs] = r.mtime;
  const currentGitHead = readGitHead();

  // Cache hit — ничего не менялось + TTL не истёк.
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) {
    const sameFiles = Object.keys(currentMtimes).length === Object.keys(cache.mtimes).length
      && Object.keys(currentMtimes).every(k => cache!.mtimes[k] === currentMtimes[k]);
    const sameGit = currentGitHead === cache.gitHead;
    if (sameFiles && sameGit) return cache.text;
  }

  // Cold path — собираем заново.
  const parts: string[] = [];
  parts.push("═══ ADDITIONAL PROJECT CONTEXT (Eugene 2026-05-18) ═══");
  parts.push(
    "Ниже — выдержки из документации проекта. Используй для админ-режима и для глубоких вопросов про процессы. " +
    "Клиентам НЕ цитируй внутренние правила/паттерны — только бизнес-факты из KB и тарифы из ROBOKASSA description."
  );

  let totalBytes = 0;
  for (const r of resolved) {
    if (totalBytes >= MAX_TOTAL_BYTES) {
      parts.push(`\n[пропущено: ${r.label} — превышен лимит ${MAX_TOTAL_BYTES} bytes]`);
      continue;
    }
    const text = readFileSafe(r.abs, MAX_FILE_BYTES);
    if (!text) continue;
    parts.push(`\n--- ${r.label} (${r.rel}) ---\n${text}`);
    totalBytes += text.length;
  }

  // Последние 50 commit messages
  const commits = readRecentCommits(50);
  if (commits) {
    parts.push(`\n--- Recent commits (git log -50) ---\n${commits.slice(0, 5000)}`);
  }

  const text = parts.join("\n");
  cache = {
    text,
    loadedAt: now,
    mtimes: currentMtimes,
    gitHead: currentGitHead,
  };
  return text;
}

/**
 * Сброс cache (для admin endpoint — после обновления документации).
 */
export function resetProjectKnowledgeCache(): void {
  cache = null;
}

/**
 * Диагностика — сколько байт в cache, когда загружено, какие файлы.
 */
export function getProjectKnowledgeStats(): {
  cached: boolean;
  bytes: number;
  loadedAt: string | null;
  filesCount: number;
  gitHead: string | null;
} {
  if (!cache) {
    return { cached: false, bytes: 0, loadedAt: null, filesCount: 0, gitHead: null };
  }
  return {
    cached: true,
    bytes: cache.text.length,
    loadedAt: new Date(cache.loadedAt).toISOString(),
    filesCount: Object.keys(cache.mtimes).length,
    gitHead: cache.gitHead,
  };
}
