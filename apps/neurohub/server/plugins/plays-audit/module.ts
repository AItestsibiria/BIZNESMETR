// v304 plugin: plays-audit (Eugene 2026-05-18 Босс «треки с 0 плеев — почему?»).
//
// Что делает:
//  - GET /api/admin/v304/plays-audit/:generationId — полный аудит одного трека:
//    счётчик meta.plays + ВСЕ записи gen_activity (play + play_rejected:*) +
//    breakdown по причинам отказа + human-readable diagnosis.
//  - GET /api/admin/v304/plays-audit/top-zero — топ-N треков где meta.plays=0
//    но в gen_activity много попыток (значит фильтр Play-counting rule всё
//    отбрасывает — типично author-self или admin).
//
// Зачем: Босс увидел в плейлисте 3 свежих трека с 0 плеев и не поверил что
// никто не слушал. Этот endpoint показывает СКОЛЬКО реальных попыток было
// и ПОЧЕМУ они не засчитались (5 категорий rejected из shouldCountPlay в
// routes.ts:8173 — author-self, admin, bot-ua, too-short, ip-dedup-1h).
//
// Безопасность: requireAdmin. Read-only — никаких изменений data.
//
// Pre-edit analysis:
//  - таблица gen_activity (shared/schema.ts:128) — action может быть
//    'play' | 'download' | 'copy' | 'share' | 'play_rejected:<reason>'
//  - generations.style (JSON string) содержит { plays, downloads, category }
//  - displayTitle опционально (NULL → используем первую строку promt'а)

import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../storage";
import { requireAdmin } from "../../core/adminAuth";
import type { Module } from "../../core";

const router = Router();

// === Helpers ===

interface RejectedBreakdown {
  [reason: string]: number;
}

interface ActivityRow {
  id: number;
  gen_id: number;
  action: string;
  ip: string | null;
  country: string | null;
  city: string | null;
  host: string | null;
  created_at: string;
}

interface GenerationRow {
  id: number;
  user_id: number;
  type: string;
  prompt: string | null;
  display_title: string | null;
  style: string | null;
  is_public: number;
  status: string;
  created_at: string | null;
}

interface UserLite {
  id: number;
  name: string | null;
  role: string | null;
}

function trackTitle(g: GenerationRow): string {
  if (g.display_title && g.display_title.trim()) return g.display_title.trim();
  const p = (g.prompt || "").trim();
  if (!p) return "(без названия)";
  return p.split("\n")[0].slice(0, 80);
}

function pickPlays(styleJson: string | null): number {
  try {
    const m = JSON.parse(styleJson || "{}");
    return Number(m?.plays || 0);
  } catch {
    return 0;
  }
}

function diagnose(metaPlays: number, totalAttempts: number, rejected: RejectedBreakdown): string {
  if (totalAttempts === 0) {
    return "В gen_activity нет ни одной записи — никто не нажимал play на этот трек.";
  }
  const succ = metaPlays;
  if (succ > 0 && totalAttempts > succ) {
    const ratio = Math.round(((totalAttempts - succ) / totalAttempts) * 100);
    return `Засчитано ${succ} из ${totalAttempts} попыток (${ratio}% отброшено). Основные причины: ${topReasonsHuman(rejected)}.`;
  }
  if (succ === 0 && totalAttempts > 0) {
    return `ВСЕ ${totalAttempts} попыток отброшены фильтром Play-counting rule. Причины: ${topReasonsHuman(rejected)}. См. apps/neurohub/server/routes.ts:8173 (shouldCountPlay).`;
  }
  return `Засчитано ${succ} попыток, отброшено 0.`;
}

function topReasonsHuman(rejected: RejectedBreakdown): string {
  const entries = Object.entries(rejected).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "нет";
  return entries.map(([r, n]) => `${humanReason(r)}=${n}`).join(", ");
}

function humanReason(reason: string): string {
  switch (reason) {
    case "author-self": return "автор слушал свой трек";
    case "admin": return "слушал админ";
    case "bot-ua": return "бот / краулер";
    case "too-short": return "<5 сек";
    case "ip-dedup-1h": return "повтор с одного IP в 10 мин";
    default: return reason;
  }
}

// Поиск имени автора + роли
function fetchUser(userId: number): UserLite | null {
  try {
    const u = db.get<UserLite>(sql`SELECT id, name, role FROM users WHERE id = ${userId} LIMIT 1`);
    return u || null;
  } catch {
    return null;
  }
}

// Map userIds → {name, role} batch (для last20)
function fetchUsers(userIds: number[]): Map<number, UserLite> {
  const map = new Map<number, UserLite>();
  if (userIds.length === 0) return map;
  try {
    // Drizzle sql template принимает только примитивы — собираем строку id'шек безопасно
    // (все userIds — number'ы, не строки, риска SQL injection нет)
    const safe = userIds.filter((n) => Number.isInteger(n)).join(",");
    if (!safe) return map;
    const rows = db.all<UserLite>(sql.raw(`SELECT id, name, role FROM users WHERE id IN (${safe})`));
    for (const r of rows) map.set(r.id, r);
  } catch {}
  return map;
}

// === Routes ===

// GET /api/admin/v304/plays-audit/top-zero?limit=20
// Треки где meta.plays=0 но totalRejected > 0 — кандидаты на расследование.
router.get("/top-zero", requireAdmin, (req, res) => {
  try {
    const limit = Math.min(Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20), 100);

    // Собираем gen_id'ы где есть >=1 запись play_rejected:*
    // и суммируем по причинам, сортируем DESC, фильтруем где meta.plays=0.
    type AggRow = {
      gen_id: number;
      total_rejected: number;
      total_play: number;
    };
    const rows = db.all<AggRow>(sql`
      SELECT gen_id,
             SUM(CASE WHEN action LIKE 'play_rejected:%' THEN 1 ELSE 0 END) AS total_rejected,
             SUM(CASE WHEN action = 'play' THEN 1 ELSE 0 END) AS total_play
        FROM gen_activity
        WHERE action = 'play' OR action LIKE 'play_rejected:%'
        GROUP BY gen_id
        HAVING total_rejected > 0
        ORDER BY total_rejected DESC
        LIMIT ${limit * 3}
    `);

    // Подтягиваем generations + meta.plays + topReason
    const out: any[] = [];
    for (const r of rows) {
      const g = db.get<GenerationRow>(sql`
        SELECT id, user_id, type, prompt, display_title, style, is_public, status, created_at
          FROM generations
          WHERE id = ${r.gen_id} AND deleted_at IS NULL
          LIMIT 1
      `);
      if (!g) continue;
      const metaPlays = pickPlays(g.style);
      if (metaPlays > 0) continue; // нас интересует ровно 0

      // Топ-причина
      type ReasonAgg = { reason: string; n: number };
      const reasons = db.all<ReasonAgg>(sql`
        SELECT REPLACE(action, 'play_rejected:', '') AS reason, COUNT(*) AS n
          FROM gen_activity
          WHERE gen_id = ${r.gen_id} AND action LIKE 'play_rejected:%'
          GROUP BY reason
          ORDER BY n DESC
          LIMIT 1
      `);
      const topReason = reasons[0]?.reason || "unknown";

      out.push({
        generationId: g.id,
        title: trackTitle(g),
        authorUserId: g.user_id,
        isPublic: g.is_public,
        createdAt: g.created_at,
        metaPlays,
        totalRejected: r.total_rejected,
        topReason,
      });
      if (out.length >= limit) break;
    }

    res.json({ data: out, error: null });
  } catch (e: any) {
    res.status(500).json({ data: null, error: String(e?.message || e).slice(0, 200) });
  }
});

// GET /api/admin/v304/plays-audit/:generationId
router.get("/:generationId", requireAdmin, (req, res) => {
  try {
    const genId = parseInt(String(req.params.generationId), 10);
    if (!Number.isFinite(genId) || genId <= 0) {
      return res.status(400).json({ data: null, error: "Неверный generationId" });
    }

    const g = db.get<GenerationRow>(sql`
      SELECT id, user_id, type, prompt, display_title, style, is_public, status, created_at
        FROM generations
        WHERE id = ${genId}
        LIMIT 1
    `);
    if (!g) {
      return res.status(404).json({ data: null, error: "Трек не найден" });
    }

    const author = fetchUser(g.user_id);
    const metaPlays = pickPlays(g.style);

    // Полный breakdown активности
    type AggRow = { action: string; n: number };
    const allActions = db.all<AggRow>(sql`
      SELECT action, COUNT(*) AS n
        FROM gen_activity
        WHERE gen_id = ${genId}
          AND (action = 'play' OR action LIKE 'play_rejected:%')
        GROUP BY action
    `);

    const rejected: RejectedBreakdown = {};
    let successful = 0;
    let totalAttempts = 0;
    for (const r of allActions) {
      totalAttempts += r.n;
      if (r.action === "play") {
        successful = r.n;
      } else if (r.action.startsWith("play_rejected:")) {
        const reason = r.action.slice("play_rejected:".length);
        rejected[reason] = (rejected[reason] || 0) + r.n;
      }
    }

    // Последние 20 активностей с гео + автор
    const last = db.all<ActivityRow>(sql`
      SELECT id, gen_id, action, ip, country, city, host, created_at
        FROM gen_activity
        WHERE gen_id = ${genId}
          AND (action = 'play' OR action LIKE 'play_rejected:%')
        ORDER BY id DESC
        LIMIT 20
    `);

    // Resolve user'ов по IP не делаем — gen_activity не хранит userId.
    // Но можем для каждой записи проверить — был ли автор подключён к этому IP
    // в окне (косвенно). Для MVP просто показываем IP+гео+UA pattern.
    const last20Activities = last.map((a) => ({
      ts: a.created_at,
      action: a.action,
      ip: a.ip || null,
      geo: a.country ? `${a.country}${a.city ? ` / ${a.city}` : ""}` : null,
      host: a.host || null,
    }));

    // Рекомендация Боссу
    const recommendations: string[] = [];
    const topRejected = Object.entries(rejected).sort((a, b) => b[1] - a[1])[0];
    const totalRejected = Object.values(rejected).reduce((s, n) => s + n, 0);
    if (topRejected && totalRejected > 0) {
      const [reason, count] = topRejected;
      const pct = Math.round((count / totalRejected) * 100);
      if (reason === "admin" && pct >= 50) {
        recommendations.push(
          `Топ причина — ${pct}% «слушал админ». Можно включить ADMIN_PLAYS_COUNT=1 в .env чтобы админ-плеи засчитывались в статистике (но не в bonus'ах). Это покажет реальную картину слушаний.`
        );
      } else if (reason === "author-self" && pct >= 50) {
        recommendations.push(
          `Топ причина — ${pct}% «автор слушал свой трек». Это нормально, защищает от накруток. Реальные слушатели приходят позже.`
        );
      } else if (reason === "ip-dedup-1h" && pct >= 50) {
        recommendations.push(
          `Топ причина — ${pct}% «повтор с одного IP в 10 мин». Возможно много заходов от одного мобильного оператора через NAT — это нормально, окно уже сжато с 60 до 10 мин.`
        );
      } else if (reason === "too-short" && pct >= 50) {
        recommendations.push(
          `Топ причина — ${pct}% «<5 сек». Юзеры не доhлушивают первые 5 секунд — стоит проверить обложку, превью, начало трека (нет ли громкого шума, медленного intro).`
        );
      } else if (reason === "bot-ua" && pct >= 30) {
        recommendations.push(
          `Топ причина — ${pct}% «бот / краулер». Это нормально, защищает счётчик от индексаторов.`
        );
      }
    }
    if (recommendations.length === 0 && totalAttempts === 0) {
      recommendations.push(
        "В gen_activity нет ни одной попытки play. Возможно трек только что опубликован и плеер ещё не вызывал /api/playlist/play/:id. Проверь что плеер передаёт POST после 5 сек воспроизведения."
      );
    }

    res.json({
      data: {
        generationId: g.id,
        title: trackTitle(g),
        authorName: author?.name || null,
        authorUserId: g.user_id,
        authorRole: author?.role || null,
        isPublic: g.is_public,
        status: g.status,
        createdAt: g.created_at,
        metaPlays,
        rawActivity: {
          totalAttempts,
          successful,
          rejected,
        },
        last20Activities,
        diagnosis: diagnose(metaPlays, totalAttempts, rejected),
        recommendations,
      },
      error: null,
    });
  } catch (e: any) {
    res.status(500).json({ data: null, error: String(e?.message || e).slice(0, 200) });
  }
});

// === Module export ===

const playsAuditModule: Module = {
  name: "plays-audit",
  version: "0.1.0",
  description:
    "Аудит счётчика прослушиваний треков — показывает успешные плеи и отброшенные попытки с разбивкой по причинам (Play-counting rule из routes.ts:8173).",
  routes: { prefix: "admin/v304/plays-audit", router },
  onLoad: async (ctx) => {
    ctx.logger.info(
      "plays-audit online — GET /api/admin/v304/plays-audit/:id, /top-zero"
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default playsAuditModule;
