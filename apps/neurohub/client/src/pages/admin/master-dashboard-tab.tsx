// v304 master-dashboard tab (Eugene 2026-05-17 Босс «главная аналитическая
// dashboard — точка сбора всей статистики проекта»).
//
// Содержит:
// 1) Light-status indicators (карточки по группам) — LLM, Generation, Auth,
//    Payments, Bots, DB, Disk. Auto-refresh каждые 30 сек.
//    Click на карточку → expand panel с деталями (drill-down).
// 2) Period pills (🟪 Вчера / 🟦 Сегодня / 🟩 Неделя / 🟨 Месяц / 📅 Другой период).
//    Click → instant refetch. 📅 раскрывает date-range picker (from/to).
// 3) Статистика по периоду — prosects, downloads, regs, gens, pays, visits.
//    Click на метрику → expand panel (by-day breakdown, top elements, etc).
// 4) Дизайнерские диаграммы Recharts с hover combined overlay.
//
// Источник данных:
//   GET /api/admin/v304/dashboard-summary?period=yesterday|today|7d|30d|all|custom&from=ISO&to=ISO
//   GET /api/admin/v304/dashboard-detail/:metric?period=... (drill-down)
//
// Стиль: glass-card + фирменные purple/cyan/amber/emerald gradient на dark bg.
// Mobile-friendly: 1col mobile, 2-3col desktop, pills wrap, expanded panel full-width.

import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { registerAudio } from "@/lib/audio-bus";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";

type Period = "yesterday" | "today" | "7d" | "30d" | "all" | "custom";

type StatusCard = {
  key: string;
  label: string;
  emoji: string;
  status: "green" | "yellow" | "red" | "unknown";
  metric: string;
  detail?: Record<string, unknown>;
};

type ClickStatRow = {
  page: string;
  elementKey: string;
  elementText: string | null;
  count: number;
  uniqueUsers: number;
};
type PageStatRow = {
  page: string;
  totalClicks: number;
  pageViews: number;
  avgTimeMs: number;
  bounceRate: number;
};
type ClickStats = {
  topClicks: ClickStatRow[];
  byPage: Record<string, PageStatRow>;
  topElements: ClickStatRow[];
  totalClicks: number;
  uniqueClickers: number;
  period: Period;
  since: string | null;
  generatedAt: string;
  fromCache?: boolean;
};

type DashboardSummary = {
  period: Period;
  since: string | null;
  generatedAt: string;
  cacheExpiresAt: string;
  fromCache?: boolean;
  statusCards: StatusCard[];
  metrics: {
    plays: { total: number; unique: number; rejected: number };
    downloads: { count: number };
    registrations: { total: number; byChannel: Array<{ channel: string; count: number }> };
    generations: {
      music: { done: number; error: number; processing: number };
      lyrics: { done: number; error: number };
      cover: { done: number; error: number };
    };
    payments: { count: number; sumKopecks: number };
    visitors: { unique: number; total: number };
  };
  charts: {
    timeline: Array<{
      date: string;
      plays: number;
      registrations: number;
      generations: number;
      payments: number;
      visitors: number;
    }>;
    registrationChannels: Array<{ name: string; value: number }>;
    topTracks: Array<{ id: number; title: string; plays: number }>;
    heatmap: Array<{ day: number; hour: number; plays: number }>;
    flow: { registrations: number; firstTrack: number; secondTrack: number };
  };
};

function fetcher<T>(url: string): Promise<T> {
  return fetch(url, { credentials: "include" }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    const j = await r.json();
    return j.data as T;
  });
}

const PERIOD_LABELS: Record<Period, string> = {
  yesterday: "Вчера",
  today: "Сегодня",
  "7d": "Неделя",
  "30d": "Месяц",
  all: "За всё время",
  custom: "Другой период",
};

const PERIOD_PILLS: Array<{
  id: Period;
  label: string;
  icon: string;
  active: string;  // tailwind gradient when active
  inactive: string;
  glow: string;
}> = [
  {
    id: "yesterday",
    label: "Вчера",
    icon: "🟪",
    active:
      "bg-gradient-to-br from-purple-500/40 via-fuchsia-500/30 to-purple-600/40 border-purple-400/60 text-white",
    inactive:
      "bg-white/5 border-white/10 text-muted-foreground hover:bg-white/[0.08] hover:border-purple-400/30",
    glow: "shadow-[0_0_24px_rgba(124,58,237,0.45)]",
  },
  {
    id: "today",
    label: "Сегодня",
    icon: "🟦",
    active:
      "bg-gradient-to-br from-cyan-500/40 via-blue-500/30 to-cyan-600/40 border-cyan-400/60 text-white",
    inactive:
      "bg-white/5 border-white/10 text-muted-foreground hover:bg-white/[0.08] hover:border-cyan-400/30",
    glow: "shadow-[0_0_24px_rgba(0,212,255,0.45)]",
  },
  {
    id: "7d",
    label: "Неделя",
    icon: "🟩",
    active:
      "bg-gradient-to-br from-emerald-500/40 via-green-500/30 to-emerald-600/40 border-emerald-400/60 text-white",
    inactive:
      "bg-white/5 border-white/10 text-muted-foreground hover:bg-white/[0.08] hover:border-emerald-400/30",
    glow: "shadow-[0_0_24px_rgba(57,255,20,0.4)]",
  },
  {
    id: "30d",
    label: "Месяц",
    icon: "🟨",
    active:
      "bg-gradient-to-br from-amber-500/40 via-yellow-500/30 to-amber-600/40 border-amber-400/60 text-white",
    inactive:
      "bg-white/5 border-white/10 text-muted-foreground hover:bg-white/[0.08] hover:border-amber-400/30",
    glow: "shadow-[0_0_24px_rgba(251,191,36,0.45)]",
  },
  {
    id: "custom",
    label: "Другой период",
    icon: "📅",
    active:
      "bg-gradient-to-br from-pink-500/40 via-fuchsia-500/30 to-purple-500/40 border-pink-400/60 text-white",
    inactive:
      "bg-white/5 border-white/10 text-muted-foreground hover:bg-white/[0.08] hover:border-pink-400/30",
    glow: "shadow-[0_0_24px_rgba(255,0,110,0.4)]",
  },
];

// "YYYY-MM-DD" → ISO для query-string. Берём начало дня MSK для from, конец для to.
function dateToIso(dateStr: string, endOfDay = false): string | null {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  // MSK = UTC+3. Начало дня MSK == 21:00 UTC предыдущего дня.
  // Чтобы не путаться: интерпретируем yyyy-mm-dd как локальный MSK день.
  const [y, m, d] = dateStr.split("-").map(n => parseInt(n, 10));
  // 00:00 MSK = UTC-3 → 21:00 предыдущего дня UTC, но Date.UTC проще:
  // строим UTC момент = yyyy-mm-dd 00:00 minus 3h (т.е. 21:00 предыдущего UTC дня).
  // Для endOfDay используем next day 00:00 MSK = yyyy-mm-(d+1) 00:00 MSK.
  const base = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  base.setUTCHours(base.getUTCHours() - 3); // → 21:00 предыдущего UTC дня
  if (endOfDay) {
    base.setUTCHours(base.getUTCHours() + 24); // следующий день 00:00 MSK
  }
  return base.toISOString();
}

// ---- цветовая палитра — единый источник для всех графиков ----
const COLORS = {
  plays: "#a78bfa",         // violet-400
  registrations: "#22d3ee", // cyan-400
  generations: "#fbbf24",   // amber-400
  payments: "#34d399",      // emerald-400
  visitors: "#f472b6",      // pink-400
};
const PIE_PALETTE = ["#a78bfa", "#22d3ee", "#fbbf24", "#34d399", "#f472b6", "#fb7185"];

// ============================================================
// Status card — лампочка-индикатор (clickable → expand details)
// ============================================================
function StatusLamp({
  card,
  expanded,
  loading,
  detail,
  detailError,
  onToggle,
}: {
  card: StatusCard;
  expanded: boolean;
  loading: boolean;
  detail: Record<string, unknown> | undefined;
  detailError: string | null;
  onToggle: () => void;
}) {
  const color =
    card.status === "green"
      ? "bg-emerald-400 ring-emerald-400/40 shadow-emerald-400/60"
      : card.status === "red"
      ? "bg-red-500 ring-red-500/40 shadow-red-500/60 animate-pulse"
      : card.status === "yellow"
      ? "bg-amber-400 ring-amber-400/40 shadow-amber-400/60"
      : "bg-slate-400 ring-slate-400/40";
  const borderClass =
    card.status === "green"
      ? "border-emerald-500/30 hover:border-emerald-500/50"
      : card.status === "red"
      ? "border-red-500/40 hover:border-red-500/60"
      : card.status === "yellow"
      ? "border-amber-500/30 hover:border-amber-500/50"
      : "border-slate-500/20 hover:border-slate-500/40";
  return (
    <div className="flex flex-col gap-0">
      <Card
        className={`glass-card rounded-2xl border ${borderClass} transition-all cursor-pointer ${
          expanded ? "ring-1 ring-purple-400/40 shadow-[0_0_20px_-10px_rgba(167,139,250,0.6)]" : ""
        }`}
        data-testid={`status-card-${card.key}`}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <CardContent className="p-4">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-3xl">{card.emoji}</span>
            <span className={`w-3 h-3 rounded-full ring-2 shadow-md ${color}`} />
            <div className="ml-auto text-[10px] uppercase text-muted-foreground tracking-wider">
              {card.label}
            </div>
          </div>
          <div className="text-sm font-medium text-white flex items-center justify-between gap-2">
            <span className="truncate">{card.metric}</span>
            <span
              aria-hidden
              className={`text-xs text-muted-foreground transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
            >
              ▾
            </span>
          </div>
        </CardContent>
      </Card>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="status-detail"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="mt-2 rounded-2xl border border-purple-400/30 bg-gradient-to-br from-[#1a0f2e]/80 via-[#0a0a17]/80 to-[#0f1830]/80 backdrop-blur p-4">
              <StatusDetailContent
                metric={card.key}
                loading={loading}
                detail={detail}
                error={detailError}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatusDetailContent({
  metric,
  loading,
  detail,
  error,
}: {
  metric: string;
  loading: boolean;
  detail: Record<string, unknown> | undefined;
  error: string | null;
}) {
  if (loading && !detail) {
    return <div className="text-xs text-muted-foreground">Загружаю детали…</div>;
  }
  if (error) {
    return (
      <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
        Ошибка: {error}
      </div>
    );
  }
  if (!detail) return null;
  return <StatusDetailBody metric={metric} detail={detail} />;
}

// Рендеринг конкретного status-detail (LLM/Generation/Auth/Payments/...)
function StatusDetailBody({
  metric,
  detail,
}: {
  metric: string;
  detail: Record<string, unknown>;
}) {
  if (metric === "llm") {
    const channels = (detail.channels as Array<{
      id: string;
      label: string;
      status: "ok" | "missing";
      label2?: string;
    }>) || [];
    return (
      <div className="space-y-2">
        <div className="text-[11px] uppercase text-muted-foreground tracking-wider">
          LLM-каналы
        </div>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {channels.map((c) => (
            <li
              key={c.id}
              className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs ${
                c.status === "ok"
                  ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
                  : "border-red-400/30 bg-red-500/10 text-red-100"
              }`}
            >
              <span className="font-medium">{c.label}</span>
              <span className="text-[10px] uppercase tracking-wider">
                {c.status === "ok" ? "✓ ok" : "× нет ключа"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (metric === "generation") {
    const last24h = (detail.last24h as {
      done: number;
      error: number;
      processing: number;
      total: number;
      successRate: number;
    }) || { done: 0, error: 0, processing: 0, total: 0, successRate: 0 };
    const topErrors = (detail.topErrors as Array<{ reason: string; count: number }>) || [];
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <DetailStat label="Успех" value={last24h.done} color="emerald" />
          <DetailStat label="Ошибки" value={last24h.error} color="red" />
          <DetailStat label="В работе" value={last24h.processing} color="amber" />
          <DetailStat
            label="Success rate"
            value={`${last24h.successRate}%`}
            color={last24h.successRate >= 95 ? "emerald" : last24h.successRate >= 90 ? "amber" : "red"}
          />
        </div>
        {topErrors.length > 0 && (
          <div>
            <div className="text-[11px] uppercase text-muted-foreground tracking-wider mb-1">
              Топ-5 ошибок (24ч)
            </div>
            <ul className="space-y-1 text-xs">
              {topErrors.map((e, i) => (
                <li
                  key={i}
                  className="flex justify-between gap-2 rounded border border-white/10 bg-white/[0.03] px-2 py-1"
                >
                  <span className="truncate text-red-200 max-w-[70%]" title={e.reason}>
                    {e.reason}
                  </span>
                  <span className="text-red-300 font-medium">{e.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
  if (metric === "auth") {
    const byChannel = (detail.byChannel as Array<{ channel: string; count: number }>) || [];
    const failedAttempts = (detail.failedAttempts as Array<{
      action: string;
      errorCode: string;
      count: number;
    }>) || [];
    const providers = (detail.providers as { sms: boolean; email: boolean; telegram: boolean }) || {
      sms: false,
      email: false,
      telegram: false,
    };
    return (
      <div className="space-y-3">
        <div>
          <div className="text-[11px] uppercase text-muted-foreground tracking-wider mb-1">
            Каналы регистрации
          </div>
          <ul className="flex flex-wrap gap-2 text-xs">
            {byChannel.map((c, i) => (
              <li
                key={i}
                className="rounded-full border border-cyan-400/30 bg-cyan-500/10 text-cyan-100 px-2.5 py-1"
              >
                {c.channel}: <span className="font-medium">{c.count}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          {(["sms", "email", "telegram"] as const).map((p) => (
            <div
              key={p}
              className={`rounded-lg border px-2 py-1.5 text-center ${
                providers[p]
                  ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
                  : "border-red-400/30 bg-red-500/10 text-red-100"
              }`}
            >
              <div className="text-[10px] uppercase text-muted-foreground">{p}</div>
              <div className="font-medium">{providers[p] ? "✓" : "×"}</div>
            </div>
          ))}
        </div>
        {failedAttempts.length > 0 && (
          <div>
            <div className="text-[11px] uppercase text-muted-foreground tracking-wider mb-1">
              Failed attempts (период)
            </div>
            <ul className="space-y-1 text-xs">
              {failedAttempts.slice(0, 8).map((f, i) => (
                <li
                  key={i}
                  className="flex justify-between gap-2 rounded border border-white/10 bg-white/[0.03] px-2 py-1"
                >
                  <span className="truncate text-red-200 max-w-[65%]" title={`${f.action} · ${f.errorCode}`}>
                    {f.action} · {f.errorCode}
                  </span>
                  <span className="text-red-300 font-medium">{f.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
  if (metric === "payments") {
    const data = (detail.since24h as {
      summary: Array<{ status: string; count: number; sumKopecks: number }>;
      recent: Array<{
        invId: number;
        amountKopecks: number;
        status: string;
        description: string | null;
        createdAt: string;
      }>;
    }) || { summary: [], recent: [] };
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2 text-xs">
          {data.summary.map((s, i) => (
            <div
              key={i}
              className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 text-emerald-100 px-2.5 py-1.5"
            >
              <span className="uppercase text-[10px] tracking-wider">{s.status}</span>
              {" · "}
              <span className="font-medium">{s.count}</span>
              {" · "}
              <span>{Math.round(s.sumKopecks / 100).toLocaleString("ru-RU")}₽</span>
            </div>
          ))}
        </div>
        {data.recent.length > 0 ? (
          <div>
            <div className="text-[11px] uppercase text-muted-foreground tracking-wider mb-1">
              Последние инвойсы (24ч)
            </div>
            <div className="max-h-56 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-black/40 backdrop-blur">
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Inv</th>
                    <th className="py-1 px-2 font-medium text-right">Сумма</th>
                    <th className="py-1 px-2 font-medium">Статус</th>
                    <th className="py-1 pl-2 font-medium">Время</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((p) => (
                    <tr
                      key={p.invId}
                      className="border-t border-white/[0.04]"
                    >
                      <td className="py-1.5 pr-2 font-mono text-white/80">{p.invId}</td>
                      <td className="py-1.5 px-2 text-right text-white">
                        {Math.round(p.amountKopecks / 100).toLocaleString("ru-RU")}₽
                      </td>
                      <td
                        className={`py-1.5 px-2 ${
                          p.status === "paid"
                            ? "text-emerald-300"
                            : p.status === "failed"
                            ? "text-red-300"
                            : "text-amber-300"
                        }`}
                      >
                        {p.status}
                      </td>
                      <td className="py-1.5 pl-2 text-muted-foreground font-mono text-[10px]">
                        {new Date(p.createdAt).toLocaleTimeString("ru-RU")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">Инвойсов за 24ч нет</div>
        )}
      </div>
    );
  }
  if (metric === "bots") {
    const channels = (detail.channels as Array<{
      id: string;
      configured: boolean;
      sessions24h: number;
    }>) || [];
    const failures = (detail.failures24h as Array<{
      channel: string;
      action: string;
      errorCode: string;
      count: number;
      lastAt: string;
    }>) || [];
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          {channels.map((c) => (
            <div
              key={c.id}
              className={`rounded-lg border px-3 py-2 ${
                c.configured
                  ? "border-emerald-400/30 bg-emerald-500/10"
                  : "border-red-400/30 bg-red-500/10"
              }`}
            >
              <div className="text-[10px] uppercase text-muted-foreground">{c.id}</div>
              <div className="text-white font-medium">
                {c.configured ? "✓ настроен" : "× нет токена"}
              </div>
              <div className="text-muted-foreground">сессий 24ч: {c.sessions24h}</div>
            </div>
          ))}
        </div>
        {failures.length > 0 && (
          <div>
            <div className="text-[11px] uppercase text-muted-foreground tracking-wider mb-1">
              Последние ошибки channel-handler'ов
            </div>
            <ul className="space-y-1 text-xs">
              {failures.map((f, i) => (
                <li
                  key={i}
                  className="flex justify-between gap-2 rounded border border-white/10 bg-white/[0.03] px-2 py-1"
                >
                  <span className="truncate text-red-200 max-w-[65%]">
                    [{f.channel}] {f.action} · {f.errorCode}
                  </span>
                  <span className="text-red-300 font-medium">{f.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
  if (metric === "db") {
    const integrity = String(detail.integrity || "unknown");
    const dbSizeMb = Number(detail.dbSizeMb || 0);
    const tables = (detail.tables as Array<{ name: string; rows: number }>) || [];
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <DetailStat
            label="PRAGMA integrity_check"
            value={integrity}
            color={integrity === "ok" ? "emerald" : "red"}
          />
          <DetailStat label="Размер БД" value={`${dbSizeMb} МБ`} color="amber" />
        </div>
        {tables.length > 0 && (
          <div>
            <div className="text-[11px] uppercase text-muted-foreground tracking-wider mb-1">
              Топ таблиц по объёму (rows)
            </div>
            <div className="max-h-56 overflow-y-auto">
              <table className="w-full text-xs">
                <tbody>
                  {tables.map((t) => (
                    <tr key={t.name} className="border-t border-white/[0.04]">
                      <td className="py-1 pr-2 text-white font-mono text-[11px]">{t.name}</td>
                      <td className="py-1 pl-2 text-right text-violet-300 font-medium">
                        {t.rows.toLocaleString("ru-RU")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }
  if (metric === "disk") {
    const dbSizeMb = Number(detail.dbSizeMb || 0);
    const backups = (detail.backups as Array<{
      name: string;
      size: number;
      mtime: string;
    }>) || [];
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <DetailStat label="data.db" value={`${dbSizeMb} МБ`} color="amber" />
          <DetailStat label="Бэкапов" value={backups.length} color="cyan" />
        </div>
        {backups.length > 0 ? (
          <div>
            <div className="text-[11px] uppercase text-muted-foreground tracking-wider mb-1">
              Последние backups
            </div>
            <ul className="space-y-1 text-xs max-h-48 overflow-y-auto">
              {backups.map((b, i) => (
                <li
                  key={i}
                  className="flex justify-between gap-2 rounded border border-white/10 bg-white/[0.03] px-2 py-1"
                >
                  <span className="truncate text-white font-mono text-[10px] max-w-[60%]" title={b.name}>
                    {b.name}
                  </span>
                  <span className="text-muted-foreground">
                    {Math.round(b.size / 1024 / 1024)} МБ ·{" "}
                    {new Date(b.mtime).toLocaleDateString("ru-RU")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            Бэкапы недоступны (нет {String(detail.backupDir || "/var/backups/neurohub-auto")})
          </div>
        )}
      </div>
    );
  }
  // Fallback — JSON для дебага
  return (
    <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
      {JSON.stringify(detail, null, 2)}
    </pre>
  );
}

function DetailStat({
  label,
  value,
  color = "violet",
}: {
  label: string;
  value: string | number;
  color?: "violet" | "cyan" | "amber" | "emerald" | "red" | "pink";
}) {
  const colorMap: Record<string, string> = {
    violet: "border-violet-400/30 bg-violet-500/10 text-violet-200",
    cyan: "border-cyan-400/30 bg-cyan-500/10 text-cyan-200",
    amber: "border-amber-400/30 bg-amber-500/10 text-amber-200",
    emerald: "border-emerald-400/30 bg-emerald-500/10 text-emerald-200",
    red: "border-red-400/30 bg-red-500/10 text-red-200",
    pink: "border-pink-400/30 bg-pink-500/10 text-pink-200",
  };
  return (
    <div className={`rounded-lg border ${colorMap[color]} px-2.5 py-1.5`}>
      <div className="text-[10px] uppercase text-muted-foreground tracking-wider">
        {label}
      </div>
      <div className="text-sm font-bold text-white mt-0.5">{value}</div>
    </div>
  );
}

// ============================================================
// Period pills (Eugene 2026-05-17 Босс): большие фирменные кнопки
// 🟪 Вчера / 🟦 Сегодня / 🟩 Неделя / 🟨 Месяц / 📅 Другой период.
// Click = instant refetch. Custom → раскрывает date-range picker.
// ============================================================
function PeriodSelector({
  period,
  onChange,
  customFrom,
  customTo,
  onCustomChange,
}: {
  period: Period;
  onChange: (p: Period) => void;
  customFrom: string;
  customTo: string;
  onCustomChange: (from: string, to: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 w-full sm:w-auto">
      <div className="flex flex-wrap gap-2">
        {PERIOD_PILLS.map(p => {
          const isActive = period === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange(p.id)}
              data-testid={`period-${p.id}`}
              className={`group relative inline-flex items-center gap-1.5 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full border text-xs sm:text-sm font-sans font-medium transition-all ${
                isActive ? `${p.active} ${p.glow}` : p.inactive
              }`}
            >
              <span className="text-base sm:text-lg leading-none">{p.icon}</span>
              <span>{p.label}</span>
              {isActive && (
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-full ring-1 ring-white/20 pointer-events-none"
                />
              )}
            </button>
          );
        })}
      </div>

      <AnimatePresence initial={false}>
        {period === "custom" && (
          <motion.div
            key="custom-range"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap items-end gap-2 pt-1 px-1">
              <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                с
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => onCustomChange(e.target.value, customTo)}
                  data-testid="period-custom-from"
                  className="bg-black/40 text-white text-xs px-2 py-1.5 rounded-lg border border-pink-400/30 hover:border-pink-400/60 focus:border-pink-400 focus:outline-none transition-colors"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                по
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => onCustomChange(customFrom, e.target.value)}
                  data-testid="period-custom-to"
                  className="bg-black/40 text-white text-xs px-2 py-1.5 rounded-lg border border-pink-400/30 hover:border-pink-400/60 focus:border-pink-400 focus:outline-none transition-colors"
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onChange("all")}
                data-testid="period-custom-clear"
                className="h-[34px]"
              >
                Сбросить
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ============================================================
// Metric box (компактная цифра + подпись)
// ============================================================
function MetricBox({
  label,
  value,
  hint,
  color = "violet",
}: {
  label: string;
  value: string | number;
  hint?: string;
  color?: "violet" | "cyan" | "amber" | "emerald" | "pink";
}) {
  const colorMap: Record<string, string> = {
    violet: "from-violet-500/15 to-transparent border-violet-500/30 text-violet-300",
    cyan: "from-cyan-500/15 to-transparent border-cyan-500/30 text-cyan-300",
    amber: "from-amber-500/15 to-transparent border-amber-500/30 text-amber-300",
    emerald: "from-emerald-500/15 to-transparent border-emerald-500/30 text-emerald-300",
    pink: "from-pink-500/15 to-transparent border-pink-500/30 text-pink-300",
  };
  return (
    <div
      className={`rounded-xl p-3 bg-gradient-to-br border ${colorMap[color]}`}
      data-testid={`metric-${label}`}
    >
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="text-2xl font-bold mt-1 text-white">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}

// ============================================================
// Combined hover overlay для line chart
// ============================================================
function CombinedTooltip({ active, payload, label }: any) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="glass-card rounded-lg p-3 border border-white/10 backdrop-blur-md text-xs">
      <div className="font-bold text-white mb-2">{label}</div>
      <div className="space-y-1">
        {payload.map((p: any) => (
          <div key={p.dataKey} className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: p.color }}
            />
            <span className="text-muted-foreground">{p.name}:</span>
            <span className="text-white font-medium">{p.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Heatmap (custom — без recharts heatmap, нативный grid)
// ============================================================
function Heatmap({ data }: { data: Array<{ day: number; hour: number; plays: number }> }) {
  const dayNames = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const d of data) {
    if (d.day >= 0 && d.day < 7 && d.hour >= 0 && d.hour < 24) {
      grid[d.day][d.hour] = d.plays;
      if (d.plays > max) max = d.plays;
    }
  }
  const intensity = (v: number) => {
    if (max === 0) return 0;
    return v / max;
  };
  return (
    <div className="overflow-x-auto">
      <div className="inline-block min-w-full">
        <div className="flex gap-1 mb-1 ml-8">
          {Array.from({ length: 24 }).map((_, h) => (
            <div
              key={h}
              className="w-6 text-[9px] text-center text-muted-foreground"
            >
              {h % 3 === 0 ? h : ""}
            </div>
          ))}
        </div>
        {dayNames.map((name, d) => (
          <div key={d} className="flex items-center gap-1 mb-1">
            <div className="w-7 text-[10px] text-muted-foreground text-right pr-1">
              {name}
            </div>
            {grid[d].map((v, h) => {
              const i = intensity(v);
              const bg =
                i === 0
                  ? "rgba(255,255,255,0.04)"
                  : `rgba(167, 139, 250, ${0.2 + i * 0.8})`;
              return (
                <div
                  key={h}
                  className="w-6 h-6 rounded text-[8px] flex items-center justify-center text-white/80"
                  style={{ background: bg }}
                  title={`${name} ${h}:00 — ${v} plays`}
                >
                  {v > 0 ? v : ""}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Sankey-style flow visualisation (упрощённый — горизонтальные бары)
// ============================================================
function FlowChart({ flow }: { flow: { registrations: number; firstTrack: number; secondTrack: number } }) {
  const total = Math.max(flow.registrations, 1);
  const w1 = 100;
  const w2 = Math.round((flow.firstTrack / total) * 100);
  const w3 = Math.round((flow.secondTrack / total) * 100);
  const stages = [
    { label: "Регистрации", value: flow.registrations, width: w1, color: "from-cyan-500 to-cyan-400" },
    { label: "Первый трек", value: flow.firstTrack, width: w2, color: "from-violet-500 to-violet-400" },
    { label: "Второй трек", value: flow.secondTrack, width: w3, color: "from-amber-500 to-amber-400" },
  ];
  return (
    <div className="space-y-3">
      {stages.map((s) => (
        <div key={s.label}>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-muted-foreground">{s.label}</span>
            <span className="text-white font-medium">
              {s.value}{" "}
              <span className="text-muted-foreground">
                ({s.width}%)
              </span>
            </span>
          </div>
          <div className="h-3 rounded-full bg-white/[0.04] overflow-hidden">
            <div
              className={`h-full bg-gradient-to-r ${s.color} transition-all`}
              style={{ width: `${s.width}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// ClickStats — топ-10 элементов bar chart + drawer + by-page таблица
// ============================================================

function formatMs(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} сек`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}м ${rs}с`;
}

function shortLabel(elem: ClickStatRow): string {
  const text = (elem.elementText || "").trim();
  if (text) return text.slice(0, 24);
  const key = (elem.elementKey || "").trim();
  return key.slice(0, 24) || "—";
}

function ClickStatsSection({
  clicks,
  isLoading,
}: {
  clicks: ClickStats | undefined;
  isLoading: boolean;
}) {
  const [drawerElem, setDrawerElem] = useState<ClickStatRow | null>(null);
  const top10 = (clicks?.topElements || []).slice(0, 10).map((r) => ({
    ...r,
    label: shortLabel(r),
  }));
  const pageRows = clicks
    ? Object.values(clicks.byPage).sort((a, b) => b.totalClicks - a.totalClicks)
    : [];

  if (isLoading && !clicks) {
    return (
      <section>
        <h3 className="text-sm font-bold text-white mb-2">
          🖱 Топ кликов — Агент Клик
        </h3>
        <div className="text-xs text-muted-foreground">Загружаю click-stats…</div>
      </section>
    );
  }

  if (!clicks || clicks.totalClicks === 0) {
    return (
      <section>
        <h3 className="text-sm font-bold text-white mb-2">
          🖱 Топ кликов — Агент Клик
        </h3>
        <Card className="glass-card rounded-2xl border border-violet-500/20">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">
              Пока нет кликов за выбранный период. Дождитесь активности юзеров
              или расширьте интервал.
            </div>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold text-white">
          🖱 Топ кликов — Агент Клик ·{" "}
          <span className="text-violet-300">{clicks.totalClicks}</span>{" "}
          <span className="text-muted-foreground">за период,</span>{" "}
          <span className="text-cyan-300">{clicks.uniqueClickers}</span>{" "}
          <span className="text-muted-foreground">уникальных</span>
        </h3>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Bar chart top-10 elements */}
        <Card className="glass-card rounded-2xl border border-violet-500/20">
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              Топ-10 элементов · клик → детали
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={top10}
                  layout="vertical"
                  margin={{ left: 10, right: 10 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="rgba(255,255,255,0.06)"
                  />
                  <XAxis
                    type="number"
                    stroke="rgba(255,255,255,0.4)"
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis
                    dataKey="label"
                    type="category"
                    stroke="rgba(255,255,255,0.4)"
                    tick={{ fontSize: 10 }}
                    width={140}
                  />
                  <Tooltip
                    content={({ active, payload }: any) => {
                      if (!active || !payload || !payload.length) return null;
                      const p = payload[0].payload as ClickStatRow & {
                        label: string;
                      };
                      return (
                        <div className="glass-card rounded-lg p-3 border border-white/10 backdrop-blur-md text-xs">
                          <div className="font-bold text-white mb-1">
                            {p.elementText || p.elementKey}
                          </div>
                          <div className="text-muted-foreground">
                            ключ: <span className="text-white">{p.elementKey}</span>
                          </div>
                          <div className="text-muted-foreground">
                            кликов:{" "}
                            <span className="text-violet-300 font-medium">
                              {p.count}
                            </span>
                          </div>
                          <div className="text-muted-foreground">
                            уникальных:{" "}
                            <span className="text-cyan-300 font-medium">
                              {p.uniqueUsers}
                            </span>
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Bar
                    dataKey="count"
                    fill={COLORS.plays}
                    onClick={(d: any) => setDrawerElem(d as ClickStatRow)}
                    cursor="pointer"
                  >
                    {top10.map((_, i) => (
                      <Cell
                        key={i}
                        fill={PIE_PALETTE[i % PIE_PALETTE.length]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* By-page table */}
        <Card className="glass-card rounded-2xl border border-cyan-500/20">
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              📊 По страницам · сортировка по кликам
            </div>
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-black/40 backdrop-blur">
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Страница</th>
                    <th className="py-1 px-2 font-medium text-right">Клики</th>
                    <th className="py-1 px-2 font-medium text-right">Время</th>
                    <th className="py-1 pl-2 font-medium text-right">Bounce</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.slice(0, 30).map((r) => (
                    <tr
                      key={r.page}
                      className="border-t border-white/[0.04] hover:bg-white/[0.02]"
                    >
                      <td
                        className="py-1.5 pr-2 text-white max-w-[180px] truncate"
                        title={r.page}
                      >
                        {r.page}
                      </td>
                      <td className="py-1.5 px-2 text-right text-violet-300 font-medium">
                        {r.totalClicks}
                      </td>
                      <td className="py-1.5 px-2 text-right text-muted-foreground">
                        {formatMs(r.avgTimeMs)}
                      </td>
                      <td
                        className={`py-1.5 pl-2 text-right ${
                          r.bounceRate > 0.7
                            ? "text-red-400"
                            : r.bounceRate > 0.4
                            ? "text-amber-300"
                            : "text-emerald-300"
                        }`}
                      >
                        {Math.round(r.bounceRate * 100)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pageRows.length === 0 && (
                <div className="text-muted-foreground text-xs py-4 text-center">
                  Нет данных по страницам
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Detail drawer (модалка) */}
      {drawerElem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setDrawerElem(null)}
        >
          <Card
            className="glass-card rounded-2xl border border-violet-500/40 max-w-lg w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <CardContent className="p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="text-xs uppercase text-muted-foreground">
                    Элемент
                  </div>
                  <div className="text-lg font-bold text-white">
                    {drawerElem.elementText || drawerElem.elementKey}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDrawerElem(null)}
                >
                  ✕
                </Button>
              </div>
              <div className="space-y-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Ключ:</span>{" "}
                  <span className="text-white font-mono text-xs">
                    {drawerElem.elementKey}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Кликов:</span>{" "}
                  <span className="text-violet-300 font-medium">
                    {drawerElem.count}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Уникальных юзеров:</span>{" "}
                  <span className="text-cyan-300 font-medium">
                    {drawerElem.uniqueUsers}
                  </span>
                </div>
                <div className="pt-3 border-t border-white/10 mt-3">
                  <div className="text-xs text-muted-foreground mb-2">
                    Страницы, где элемент встречается чаще всего:
                  </div>
                  <ul className="text-xs space-y-1">
                    {(clicks?.topClicks || [])
                      .filter((r) => r.elementKey === drawerElem.elementKey)
                      .slice(0, 8)
                      .map((r, i) => (
                        <li key={i} className="flex justify-between gap-2">
                          <span
                            className="text-white truncate max-w-[260px]"
                            title={r.page}
                          >
                            {r.page}
                          </span>
                          <span className="text-violet-300 font-medium">
                            {r.count}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );
}

// ============================================================
// 🎙 Муза доложит — TTS озвучка важной информации через Yandex SpeechKit
// (Eugene 2026-05-17 Босс). Кнопка большая, фирменная (purple→cyan gradient),
// breathing-animation во время play, текст-subtitle.
// ============================================================
type TtsVoice = "alena" | "jane" | "oksana";

const VOICE_OPTIONS: Array<{ key: TtsVoice; label: string; hint: string }> = [
  { key: "alena", label: "Алёна", hint: "молодая, нежная — Муза по умолчанию" },
  { key: "jane", label: "Джейн", hint: "постарше, бизнес-тон" },
  { key: "oksana", label: "Оксана", hint: "нейтральный" },
];

function MusaBriefing({ period }: { period: Period }) {
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState<TtsVoice>(() => {
    if (typeof window === "undefined") return "alena";
    const saved = window.localStorage.getItem("tts-voice");
    return (saved as TtsVoice) || "alena";
  });
  const [autoBriefing, setAutoBriefing] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("auto-briefing-on-mount") === "1";
  });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const autoFiredRef = useRef(false);

  const stop = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      } catch {}
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setPlaying(false);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const handleVoiceChange = (v: TtsVoice) => {
    setVoice(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("tts-voice", v);
    }
  };

  const handleAutoChange = (on: boolean) => {
    setAutoBriefing(on);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("auto-briefing-on-mount", on ? "1" : "0");
    }
  };

  const runBriefing = useCallback(async () => {
    if (loading || playing) return;
    setLoading(true);
    setError(null);
    setText(null);
    try {
      // 1) Берём текст доклада
      const briefingRes = await fetch(
        `/api/admin/v304/briefing-text?period=${period}`,
        { credentials: "include" },
      );
      if (!briefingRes.ok) {
        const tx = await briefingRes.text().catch(() => "");
        throw new Error(`briefing ${briefingRes.status}: ${tx.slice(0, 120)}`);
      }
      const briefingJson = await briefingRes.json();
      const briefingText: string =
        briefingJson?.data?.text || briefingJson?.text || "";
      if (!briefingText) throw new Error("Пустой текст доклада");
      setText(briefingText);

      // 2) Синтезируем mp3
      const ttsRes = await fetch(`/api/admin/v304/tts`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: briefingText, voice }),
      });
      if (!ttsRes.ok) {
        const tx = await ttsRes.text().catch(() => "");
        throw new Error(`tts ${ttsRes.status}: ${tx.slice(0, 120)}`);
      }
      const blob = await ttsRes.blob();

      // 3) Играем
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      const audio = new Audio(url);
      registerAudio(audio); // single-audio rule: pause других при play
      audioRef.current = audio;
      audio.onended = () => {
        setPlaying(false);
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
          blobUrlRef.current = null;
        }
      };
      audio.onerror = () => {
        setPlaying(false);
        setError("Ошибка воспроизведения mp3");
      };
      setPlaying(true);
      await audio.play();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPlaying(false);
    } finally {
      setLoading(false);
    }
  }, [period, voice, loading, playing]);

  // Auto-briefing on mount (если включён в localStorage)
  useEffect(() => {
    if (autoBriefing && !autoFiredRef.current) {
      autoFiredRef.current = true;
      // Небольшая задержка чтобы UI успел отрисоваться
      const t = setTimeout(() => {
        runBriefing().catch(() => {});
      }, 800);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [autoBriefing, runBriefing]);

  return (
    <section
      className="glass-card rounded-2xl p-4 border border-purple-500/30 hover:border-purple-500/50 transition-colors"
      data-testid="musa-briefing"
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 font-medium">
              Муза
            </span>
            <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 font-medium">
              TTS · Yandex
            </span>
          </div>
          <h3 className="text-lg font-sans font-bold text-white">
            <span className="bg-gradient-to-r from-purple-300 via-pink-300 to-cyan-300 bg-clip-text text-transparent">
              Муза доложит
            </span>
          </h3>
          <p className="text-sm font-sans text-muted-foreground leading-relaxed">
            Озвучит короткий доклад по dashboard за выбранный период.
          </p>
        </div>

        <div className="flex flex-col gap-2 shrink-0">
          {!playing ? (
            <Button
              size="lg"
              onClick={runBriefing}
              disabled={loading}
              data-testid="musa-briefing-play"
              className={`btn-cosmic text-white font-bold px-6 py-5 rounded-xl shadow-lg shadow-purple-500/30 ${
                loading ? "opacity-70" : "hover:scale-[1.02]"
              } transition-all`}
            >
              {loading ? "Готовлю доклад…" : "🎙 Муза доложит"}
            </Button>
          ) : (
            <Button
              size="lg"
              onClick={stop}
              data-testid="musa-briefing-stop"
              className="bg-red-500/80 hover:bg-red-500 text-white font-bold px-6 py-5 rounded-xl shadow-lg shadow-red-500/30 animate-pulse"
            >
              🔇 Замолчи
            </Button>
          )}

          <div className="flex items-center gap-2 text-[11px]">
            <label className="text-muted-foreground" htmlFor="musa-voice-pick">
              Голос:
            </label>
            <select
              id="musa-voice-pick"
              className="bg-black/40 text-white rounded px-2 py-1 border border-white/10 text-xs"
              value={voice}
              onChange={(e) => handleVoiceChange(e.target.value as TtsVoice)}
              disabled={playing || loading}
              data-testid="musa-voice-select"
            >
              {VOICE_OPTIONS.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.label} — {v.hint}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoBriefing}
              onChange={(e) => handleAutoChange(e.target.checked)}
              data-testid="musa-auto-briefing"
              className="rounded border-white/20"
            />
            Автодоклад при входе в admin
          </label>
        </div>
      </div>

      {error && (
        <div className="mt-3 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          Ошибка: {error}
        </div>
      )}

      {text && (
        <div
          className={`mt-3 text-sm text-white/90 bg-black/30 border border-white/10 rounded-lg px-3 py-2 leading-relaxed transition-all ${
            playing ? "ring-2 ring-purple-400/40 shadow-[0_0_30px_-10px_rgba(167,139,250,0.6)]" : ""
          }`}
          data-testid="musa-briefing-subtitle"
        >
          {text}
        </div>
      )}
    </section>
  );
}

// ============================================================
// Hook: fetch detail для expanded card. Кэширует через react-query, перезаливает
// при смене period. Если expandedKey=null — query disabled (нет запроса).
// ============================================================
function useExpandedDetail(
  expandedKey: string | null,
  period: Period,
  customFrom: string,
  customTo: string,
) {
  const url = expandedKey
    ? buildDashboardUrl(
        `/api/admin/v304/dashboard-detail/${encodeURIComponent(expandedKey)}`,
        period,
        customFrom,
        customTo,
      )
    : null;
  const customReady =
    period !== "custom" ||
    (Boolean(customFrom) && Boolean(customTo) && customFrom <= customTo);
  return useQuery<Record<string, unknown>>({
    queryKey: [url],
    queryFn: () => fetcher<Record<string, unknown>>(url as string),
    enabled: !!url && customReady,
    staleTime: 30_000,
  });
}

// ============================================================
// MAIN TAB
// ============================================================
function buildDashboardUrl(
  base: string,
  period: Period,
  customFrom: string,
  customTo: string,
): string {
  const params = new URLSearchParams({ period });
  if (period === "custom") {
    const fromIso = dateToIso(customFrom);
    const toIso = dateToIso(customTo, true);
    if (fromIso) params.set("from", fromIso);
    if (toIso) params.set("to", toIso);
  }
  return `${base}?${params.toString()}`;
}

export default function MasterDashboardTab() {
  const [period, setPeriod] = useState<Period>("7d");
  // Custom range — input value (YYYY-MM-DD). По умолчанию пусто; превращается
  // в ISO только когда оба поля заполнены и period === 'custom'.
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");

  // Дефолтные значения для date-pickers при первом открытии custom
  const handlePeriodChange = useCallback(
    (next: Period) => {
      setPeriod(next);
      if (next === "custom" && !customFrom && !customTo) {
        const today = new Date();
        const weekAgo = new Date(today.getTime() - 7 * 24 * 3600 * 1000);
        const fmt = (d: Date) =>
          `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
            d.getUTCDate(),
          ).padStart(2, "0")}`;
        setCustomFrom(fmt(weekAgo));
        setCustomTo(fmt(today));
      }
    },
    [customFrom, customTo],
  );

  // Custom enabled только когда оба поля заполнены — иначе шлём period=custom
  // без from/to и backend пускает в "all".
  const customReady =
    period !== "custom" ||
    (Boolean(customFrom) && Boolean(customTo) && customFrom <= customTo);

  const summaryUrl = buildDashboardUrl(
    "/api/admin/v304/dashboard-summary",
    period,
    customFrom,
    customTo,
  );
  const clicksUrl = buildDashboardUrl(
    "/api/admin/v304/click-stats",
    period,
    customFrom,
    customTo,
  );

  const { data, isLoading, refetch } = useQuery<DashboardSummary>({
    queryKey: [summaryUrl],
    queryFn: () => fetcher<DashboardSummary>(summaryUrl),
    refetchInterval: 30_000,
    enabled: customReady,
  });
  const { data: clickStats, isLoading: clicksLoading } = useQuery<ClickStats>({
    queryKey: [clicksUrl],
    queryFn: () => fetcher<ClickStats>(clicksUrl),
    refetchInterval: 60_000,
    enabled: customReady,
  });

  // Single-expanded model: только одна карточка раскрыта одновременно.
  // Ключ имеет префикс — status:<key> или metric:<key> — чтобы избежать коллизий
  // между статус-картами (например, key='payments') и period metric (тоже 'payments').
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  // Backend endpoint имена для drill-down. status-cards имеют key, для period
  // metric — наш собственный набор имён.
  const detailBackendKey = (() => {
    if (!expandedKey) return null;
    const [scope, key] = expandedKey.split(":");
    if (scope === "metric" && key === "payments") return "payments-period";
    return key;
  })();
  const expandedQuery = useExpandedDetail(
    detailBackendKey,
    period,
    customFrom,
    customTo,
  );

  if (isLoading && !data) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Загружаю сводку…
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-8 text-center text-red-400">
        Не удалось загрузить сводку.
        <Button onClick={() => refetch()} className="ml-3" size="sm">
          Повторить
        </Button>
      </div>
    );
  }

  const sumRub = Math.round(data.metrics.payments.sumKopecks / 100);

  // ---- helpers ----
  const copyJson = () => {
    const text = JSON.stringify(data, null, 2);
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header — period selector + actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">
            🧠 Сводка — главная аналитическая dashboard
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Точка сбора всей статистики проекта · фундамент Второго мозга ·
            обновление каждые 30 сек {data.fromCache && "· из кэша"}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <PeriodSelector
            period={period}
            onChange={handlePeriodChange}
            customFrom={customFrom}
            customTo={customTo}
            onCustomChange={(f, t) => {
              setCustomFrom(f);
              setCustomTo(t);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            data-testid="refresh-dashboard"
          >
            🔄 Обновить
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={copyJson}
            data-testid="copy-dashboard-json"
          >
            📋 Копировать JSON
          </Button>
        </div>
      </div>

      {/* 🎙 Муза доложит — TTS озвучка */}
      <MusaBriefing period={period} />

      {/* 1. Status cards — light-status indicators (click → expand details) */}
      <section>
        <h3 className="text-sm font-bold text-white mb-2">
          1. Лампочки статусов · {data.statusCards.length} групп · клик для деталей
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {data.statusCards.map((c) => {
            const scopedKey = `status:${c.key}`;
            const isExpanded = expandedKey === scopedKey;
            const detail = isExpanded
              ? ((expandedQuery.data as unknown as Record<string, unknown>) || undefined)
              : undefined;
            return (
              <StatusLamp
                key={c.key}
                card={c}
                expanded={isExpanded}
                loading={isExpanded && expandedQuery.isLoading}
                detail={detail}
                detailError={
                  isExpanded && expandedQuery.error
                    ? expandedQuery.error instanceof Error
                      ? expandedQuery.error.message
                      : String(expandedQuery.error)
                    : null
                }
                onToggle={() =>
                  setExpandedKey((cur) => (cur === scopedKey ? null : scopedKey))
                }
              />
            );
          })}
        </div>
      </section>

      {/* 2. Period metrics — boxes */}
      <section>
        <h3 className="text-sm font-bold text-white mb-2">
          2. Метрики · {PERIOD_LABELS[period]}
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <MetricBox
            label="Прослушивания"
            value={data.metrics.plays.total}
            hint={`${data.metrics.plays.unique} уник · ${data.metrics.plays.rejected} реджект`}
            color="violet"
          />
          <MetricBox
            label="Загрузки"
            value={data.metrics.downloads.count}
            color="cyan"
          />
          <MetricBox
            label="Регистрации"
            value={data.metrics.registrations.total}
            hint={data.metrics.registrations.byChannel
              .map((b) => `${b.channel}: ${b.count}`)
              .join(" · ")}
            color="emerald"
          />
          <MetricBox
            label="Генерации"
            value={
              data.metrics.generations.music.done +
              data.metrics.generations.lyrics.done +
              data.metrics.generations.cover.done
            }
            hint={`music ${data.metrics.generations.music.done}/${
              data.metrics.generations.music.error
            } ошибок`}
            color="amber"
          />
          <MetricBox
            label="Платежи"
            value={`${sumRub.toLocaleString("ru-RU")}₽`}
            hint={`${data.metrics.payments.count} оплат`}
            color="emerald"
          />
          <MetricBox
            label="Посетители"
            value={data.metrics.visitors.unique}
            hint={`${data.metrics.visitors.total} визитов`}
            color="pink"
          />
        </div>
      </section>

      {/* 2.5. Click-stats (Агент Клик) */}
      <ClickStatsSection clicks={clickStats} isLoading={clicksLoading} />

      {/* 3. Charts grid */}
      <section>
        <h3 className="text-sm font-bold text-white mb-2">
          3. Дизайнерские диаграммы
        </h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Timeline — combined hover */}
          <Card className="glass-card rounded-2xl border border-violet-500/20">
            <CardContent className="p-4">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                Линейный график · hover показывает все метрики
              </div>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.charts.timeline}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis
                      dataKey="date"
                      stroke="rgba(255,255,255,0.4)"
                      tick={{ fontSize: 10 }}
                    />
                    <YAxis stroke="rgba(255,255,255,0.4)" tick={{ fontSize: 10 }} />
                    <Tooltip content={<CombinedTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line
                      type="monotone"
                      dataKey="plays"
                      name="Прослушивания"
                      stroke={COLORS.plays}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="registrations"
                      name="Регистрации"
                      stroke={COLORS.registrations}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="generations"
                      name="Генерации"
                      stroke={COLORS.generations}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="payments"
                      name="Платежи"
                      stroke={COLORS.payments}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="visitors"
                      name="Посетители"
                      stroke={COLORS.visitors}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Pie — channels */}
          <Card className="glass-card rounded-2xl border border-cyan-500/20">
            <CardContent className="p-4">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                Каналы регистраций
              </div>
              <div className="h-72">
                {data.charts.registrationChannels.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                    Нет данных за период
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={data.charts.registrationChannels}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={90}
                        label={({ name, value }) => `${name}: ${value}`}
                      >
                        {data.charts.registrationChannels.map((_, i) => (
                          <Cell
                            key={i}
                            fill={PIE_PALETTE[i % PIE_PALETTE.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Bar — top tracks */}
          <Card className="glass-card rounded-2xl border border-amber-500/20">
            <CardContent className="p-4">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                Топ-10 треков по прослушиваниям
              </div>
              <div className="h-72">
                {data.charts.topTracks.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                    Нет прослушиваний за период
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={data.charts.topTracks}
                      layout="vertical"
                      margin={{ left: 10, right: 10 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="rgba(255,255,255,0.06)"
                      />
                      <XAxis
                        type="number"
                        stroke="rgba(255,255,255,0.4)"
                        tick={{ fontSize: 10 }}
                      />
                      <YAxis
                        dataKey="title"
                        type="category"
                        stroke="rgba(255,255,255,0.4)"
                        tick={{ fontSize: 10 }}
                        width={140}
                      />
                      <Tooltip />
                      <Bar dataKey="plays" fill={COLORS.generations}>
                        {data.charts.topTracks.map((_, i) => (
                          <Cell
                            key={i}
                            fill={PIE_PALETTE[i % PIE_PALETTE.length]}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Flow (sankey-style) */}
          <Card className="glass-card rounded-2xl border border-emerald-500/20">
            <CardContent className="p-4">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                Воронка: регистрации → первый трек → второй трек
              </div>
              <div className="py-6">
                <FlowChart flow={data.charts.flow} />
              </div>
              <div className="text-[10px] text-muted-foreground mt-2">
                {data.charts.flow.firstTrack > 0 &&
                data.charts.flow.registrations > 0
                  ? `Конверсия в первый трек: ${Math.round(
                      (data.charts.flow.firstTrack /
                        data.charts.flow.registrations) *
                        100,
                    )}%`
                  : "—"}
              </div>
            </CardContent>
          </Card>

          {/* Heatmap — full-width */}
          <Card className="glass-card rounded-2xl border border-pink-500/20 lg:col-span-2">
            <CardContent className="p-4">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-3">
                Heatmap активности · день недели × час
              </div>
              <Heatmap data={data.charts.heatmap} />
            </CardContent>
          </Card>
        </div>
      </section>

      <div className="text-[10px] text-muted-foreground text-center pt-4">
        Сгенерировано {new Date(data.generatedAt).toLocaleTimeString("ru-RU")}{" "}
        · кэш до{" "}
        {new Date(data.cacheExpiresAt).toLocaleTimeString("ru-RU")}
      </div>
    </div>
  );
}
