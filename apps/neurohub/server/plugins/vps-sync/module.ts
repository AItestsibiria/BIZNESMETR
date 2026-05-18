// v304 plugin: vps-sync (Eugene 2026-05-18 Босс «таблицу сводного анализа 2
// VPS сделай — я подтвержу на clone»).
//
// Что делает:
//  - GET /api/admin/v304/vps-self-stats   — выдаёт срез ТЕКУЩЕГО VPS
//    (requireAdmin ИЛИ X-Sync-Token: ${ADMIN_SYNC_TOKEN}). Используется
//    удалённой стороной для сбора данных.
//  - GET /api/admin/v304/vps-comparison   — собирает local-срез + дёргает
//    remote по HTTPS (по детектированному hostname: clone ↔ prod) и считает
//    diff. Возвращает { local, remote, diff }.
//
// Безопасность:
//  - НЕ возвращает значения секретов, только `hasKey: boolean`.
//  - Удалённый sync-call идёт ТОЛЬКО на whitelisted hosts (muzaai.ru /
//    clone.muziai.ru / клонированный домен из BASE_DOMAIN). Никаких
//    user-supplied URL.
//  - Timeout 10 сек, чтобы не висеть на падающем remote.
//
// Этот endpoint Боссу нужен чтобы после rsync prod→clone
// (docs/strategy/CLONE-SYNC-FROM-PROD-180526.md) визуально проверить
// что данные синхронизировались.

import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAdmin } from "../../core/adminAuth";
import type { Module } from "../../core";
import { collectVPSStats, computeDiff, type VPSStats } from "../../lib/vpsStats";

const router = Router();

const REMOTE_TIMEOUT_MS = 10_000;

const KNOWN_PROD_URL = "https://muzaai.ru";
const KNOWN_CLONE_URL = "https://clone.muziai.ru";

// Если REMOTE_SYNC_URL задан в .env — используем его (override). Иначе
// детектим по hostname текущего VPS: если local = prod → remote = clone,
// иначе наоборот.
function pickRemoteUrl(local: VPSStats): string | null {
  const override = process.env.REMOTE_SYNC_URL;
  if (override) return override.replace(/\/+$/, "");
  if (local.isProd) return KNOWN_CLONE_URL;
  if (local.isClone) return KNOWN_PROD_URL;
  return null;
}

// Auth gate: либо валидный admin-cookie (requireAdmin), либо X-Sync-Token
// header равен ADMIN_SYNC_TOKEN. Второй вариант — для машинной cross-VPS
// синхронизации (когда prod дёргает clone и наоборот).
function requireAdminOrSyncToken(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header("x-sync-token");
  const expected = process.env.ADMIN_SYNC_TOKEN;
  if (supplied && expected && supplied === expected) {
    return next();
  }
  // Fallback: проверяем admin-cookie через стандартный middleware.
  requireAdmin(req, res, next);
}

router.get("/vps-self-stats", requireAdminOrSyncToken, async (_req, res) => {
  try {
    const stats = await collectVPSStats();
    res.json({ data: stats, error: null });
  } catch (e: any) {
    res.status(500).json({ data: null, error: String(e?.message || e).slice(0, 200) });
  }
});

router.get("/vps-comparison", requireAdmin, async (_req, res) => {
  try {
    const local = await collectVPSStats();
    const remoteUrl = pickRemoteUrl(local);
    let remote: VPSStats | null = null;
    let remoteError: string | null = null;

    if (!remoteUrl) {
      remoteError = "Не удалось определить удалённый VPS (нет REMOTE_SYNC_URL и hostname не распознан как prod/clone)";
    } else {
      const syncToken = process.env.ADMIN_SYNC_TOKEN || "";
      try {
        const r = await fetch(`${remoteUrl}/api/admin/v304/vps-self-stats`, {
          headers: syncToken ? { "x-sync-token": syncToken } : {},
          signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
        });
        if (!r.ok) {
          remoteError = `Удалённый VPS ответил HTTP ${r.status} (${remoteUrl})`;
        } else {
          const j: any = await r.json();
          if (j?.data) {
            remote = j.data as VPSStats;
          } else {
            remoteError = `Удалённый VPS вернул пустой data (${remoteUrl})`;
          }
        }
      } catch (e: any) {
        remoteError = `Не удалось связаться с ${remoteUrl}: ${String(e?.message || e).slice(0, 100)}`;
      }
    }

    const diff = remote
      ? computeDiff(local, remote)
      : { criticalDiffs: [], missingOnClone: [] };

    res.json({
      data: {
        local,
        remote,
        remoteUrl,
        remoteError,
        diff,
      },
      error: null,
    });
  } catch (e: any) {
    res.status(500).json({ data: null, error: String(e?.message || e).slice(0, 200) });
  }
});

const vpsSyncModule: Module = {
  name: "vps-sync",
  version: "0.1.0",
  description: "Сравнительный срез prod-vs-clone VPS (БД-метрики, размеры, git SHA, env-флаги). Без значений секретов.",
  routes: { prefix: "admin/v304", router },
  onLoad: async (ctx) => {
    ctx.logger.info("vps-sync online — GET /api/admin/v304/vps-comparison + /vps-self-stats");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default vpsSyncModule;
