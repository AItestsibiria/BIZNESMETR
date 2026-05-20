// Playlist sort rotation — Eugene 2026-05-19 «Поставь правило по умолчанию
// по дате, через день рейтинг, через день случайно. Цикл повторяется,
// в панели порядок можно менять».
//
// Цикл сортировок [date, rating, random] (по умолчанию) ротируется по дням.
// Цикл хранится в JSON-файле — admin может изменить через endpoint.
// Юзер видит «сегодняшний» дефолт; может override через UI (localStorage).

import fs from "node:fs";
import path from "node:path";

export type SortMode = "date" | "rating" | "random" | "top_month";

const ALLOWED_MODES: SortMode[] = ["date", "rating", "random", "top_month"];
// Eugene 2026-05-21 Босс: полный цикл по умолчанию — все 4 режима.
// «От даты до случайно поочерёдно» — date → rating → random → top_month → date → ...
// Админ может урезать цикл через POST /api/admin/v304/playlist-sort-rotation.
const DEFAULT_CYCLE: SortMode[] = ["date", "rating", "random", "top_month"];
const CONFIG_FILE = path.join(process.cwd(), "data", "playlist-sort-rotation.json");

interface RotationConfig {
  cycle: SortMode[];
  startDate: string; // ISO дата начала цикла (для расчёта day-index)
  updatedAt: string;
}

let cached: RotationConfig | null = null;

function ensureDir(): void {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn("[playlist-rotation] mkdir failed:", (e as any)?.message);
  }
}

function readConfig(): RotationConfig {
  if (cached) return cached;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf8");
      const parsed = JSON.parse(raw) as RotationConfig;
      if (Array.isArray(parsed.cycle) && parsed.cycle.length > 0) {
        cached = parsed;
        return parsed;
      }
    }
  } catch (e) {
    console.warn("[playlist-rotation] read failed:", (e as any)?.message);
  }
  // Default
  const def: RotationConfig = {
    cycle: DEFAULT_CYCLE,
    startDate: "2026-05-19",
    updatedAt: new Date().toISOString(),
  };
  cached = def;
  return def;
}

function writeConfig(cfg: RotationConfig): void {
  ensureDir();
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
    cached = cfg;
  } catch (e) {
    console.warn("[playlist-rotation] write failed:", (e as any)?.message);
  }
}

// Eugene 2026-05-21 Босс: cut-off ротации = 00:00 МСК, НЕ UTC.
// Раньше cycle сменялся в 00:00 UTC (= 03:00 МСК) — Босс хочет 00:00 МСК.
// Решение: сдвигаем now на +3 часа (МСК = UTC+3) — тогда floor div by day
// даёт правильный MSK day-index. startDate тоже трактуется как MSK midnight.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

function dayIndexFrom(startDate: string): number {
  try {
    // startDate "2026-05-19" → trat как 00:00 МСК = 21:00 UTC предыдущего дня.
    // Парсим как UTC midnight, потом сдвигаем (== прибавляем 0 на shifted-scale).
    const startUtcMs = Date.parse(startDate + "T00:00:00Z");
    if (!isFinite(startUtcMs)) return 0;
    // Shifted-scale: now += 3h, start без сдвига (UTC midnight == MSK midnight на shifted-scale).
    const nowShiftedMs = Date.now() + MSK_OFFSET_MS;
    return Math.max(0, Math.floor((nowShiftedMs - startUtcMs) / 86_400_000));
  } catch { return 0; }
}

export function getTodayDefaultSort(): { mode: SortMode; cycle: SortMode[]; dayIndex: number; startDate: string } {
  const cfg = readConfig();
  const dayIdx = dayIndexFrom(cfg.startDate);
  const mode = cfg.cycle[dayIdx % cfg.cycle.length] || "date";
  return { mode, cycle: cfg.cycle, dayIndex: dayIdx, startDate: cfg.startDate };
}

export function setRotationCycle(cycle: string[]): { ok: boolean; error?: string; cycle?: SortMode[] } {
  const filtered = cycle
    .map(c => String(c).toLowerCase().trim())
    .filter(c => (ALLOWED_MODES as string[]).includes(c)) as SortMode[];
  if (filtered.length === 0) return { ok: false, error: "Cycle empty after validation" };
  const cfg: RotationConfig = {
    cycle: filtered,
    startDate: readConfig().startDate,
    updatedAt: new Date().toISOString(),
  };
  writeConfig(cfg);
  return { ok: true, cycle: filtered };
}

export function setRotationStartDate(startDate: string): { ok: boolean; error?: string } {
  // YYYY-MM-DD only
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return { ok: false, error: "startDate must be YYYY-MM-DD" };
  }
  const cfg: RotationConfig = {
    cycle: readConfig().cycle,
    startDate,
    updatedAt: new Date().toISOString(),
  };
  writeConfig(cfg);
  return { ok: true };
}

export function getRotationConfig(): RotationConfig {
  return readConfig();
}
