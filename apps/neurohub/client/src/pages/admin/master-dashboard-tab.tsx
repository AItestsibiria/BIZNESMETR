// v304 master-dashboard tab (Eugene 2026-05-17 Босс «главная аналитическая
// dashboard — точка сбора всей статистики проекта»).
//
// Содержит:
// 1) Light-status indicators (карточки по группам) — LLM, Generation, Auth,
//    Payments, Bots, DB, Disk. Auto-refresh каждые 30 сек.
// 2) Date-range picker (Сегодня / 7 дней / 30 дней / За всё время)
// 3) Статистика по периоду — prosects, downloads, regs, gens, pays, visits.
// 4) Дизайнерские диаграммы Recharts с hover combined overlay.
//
// Источник данных:
//   GET /api/admin/v304/dashboard-summary?period=today|7d|30d|all
//
// Стиль: glass-card + фирменные purple/cyan/amber/emerald gradient на dark bg.
// Mobile-friendly: 1col mobile, 2-3col desktop.

import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { registerAudio } from "@/lib/audio-bus";
import {
  AdminConfirmAction,
  detectPendingConfirm,
  type PendingConfirmInfo,
} from "@/components/admin-confirm-action";
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

// Eugene 2026-05-17 Босс: расширенный period selector — cut-off 20:00 МСК
// (см. Period-20-MSK rule в CLAUDE.md). Все варианты в одном типе для UI и
// для query-параметра /api/admin/v304/dashboard-summary?period=...
type Period =
  | "today" | "yesterday"
  | "7d" | "30d" | "365d" | "all"
  | "month-1" | "month-2" | "month-3" | "month-4"
  | "month-5" | "month-6" | "month-7" | "month-8"
  | "month-9" | "month-10" | "month-11" | "month-12";

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

// Eugene 2026-05-17 Босс: per-domain трекинг (muzaai.ru / muziai.ru /
// podaripesnu.ru / other). 'all' — без фильтра.
type DomainBucket = "all" | "muzaai.ru" | "muziai.ru" | "podaripesnu.ru" | "other";

type DomainMetrics = {
  visitors: number;
  plays: number;
  registrations: number;
  payments: { count: number; rub: number };
};

type DashboardSummary = {
  period: Period;
  since: string | null;
  domain?: string | null;
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
  today: "Сегодня",
  yesterday: "Вчера",
  "7d": "Неделя",
  "30d": "Месяц",
  "365d": "Год",
  all: "Всё время",
  "month-1": "Январь",
  "month-2": "Февраль",
  "month-3": "Март",
  "month-4": "Апрель",
  "month-5": "Май",
  "month-6": "Июнь",
  "month-7": "Июль",
  "month-8": "Август",
  "month-9": "Сентябрь",
  "month-10": "Октябрь",
  "month-11": "Ноябрь",
  "month-12": "Декабрь",
};

const MONTH_SHORT_LABELS: Array<{ key: Period; label: string }> = [
  { key: "month-1", label: "Янв" },
  { key: "month-2", label: "Фев" },
  { key: "month-3", label: "Мар" },
  { key: "month-4", label: "Апр" },
  { key: "month-5", label: "Май" },
  { key: "month-6", label: "Июн" },
  { key: "month-7", label: "Июл" },
  { key: "month-8", label: "Авг" },
  { key: "month-9", label: "Сен" },
  { key: "month-10", label: "Окт" },
  { key: "month-11", label: "Ноя" },
  { key: "month-12", label: "Дек" },
];

// Eugene 2026-05-17 Босс: domain selector — глобальный фильтр на dashboard.
const DOMAIN_LABELS: Record<DomainBucket, string> = {
  all: "Все",
  "muzaai.ru": "MuzaAi.ru",
  "muziai.ru": "MuziAi.ru",
  "podaripesnu.ru": "podaripesnu.ru",
  other: "Прочие",
};

const DOMAIN_OPTIONS: Array<{ key: DomainBucket; label: string }> = [
  { key: "all", label: "Все" },
  { key: "muzaai.ru", label: "MuzaAi.ru" },
  { key: "muziai.ru", label: "MuziAi.ru" },
  { key: "podaripesnu.ru", label: "podaripesnu.ru" },
  { key: "other", label: "Прочие" },
];

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
// Status card — лампочка-индикатор
// ============================================================
function StatusLamp({ card }: { card: StatusCard }) {
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

  // Eugene 2026-05-17 — hi-tech accent: красные карточки получают вращающийся
  // animated-border, чтобы привлечь внимание админа без кричащих эффектов.
  // Жёлтые/зелёные/unknown — обычная статичная рамка (правило subtle, не overkill).
  const innerCard = (
    <Card
      className={`glass-card rounded-2xl border ${borderClass} transition-colors`}
      data-testid={`status-card-${card.key}`}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-3xl">{card.emoji}</span>
          <span className={`w-3 h-3 rounded-full ring-2 shadow-md ${color}`} />
          <div className="ml-auto text-[10px] uppercase text-muted-foreground tracking-wider">
            {card.label}
          </div>
        </div>
        <div className="text-sm font-medium text-white">{card.metric}</div>
      </CardContent>
    </Card>
  );

  if (card.status === "red") {
    return (
      <div className="animated-border rounded-2xl">
        {innerCard}
      </div>
    );
  }
  return innerCard;
}

// ============================================================
// Date-range picker (Eugene 2026-05-17 Босс «расширенный period selector»)
// Row 1: Сегодня / Вчера / Неделя / Месяц / Год / Всё время
// Row 2 (по клику «Месяцы ▾»): Янв..Дек текущего года
// ============================================================
function PeriodSelector({
  period,
  onChange,
}: {
  period: Period;
  onChange: (p: Period) => void;
}) {
  const [monthsOpen, setMonthsOpen] = useState(false);
  const primaryButtons: Array<{ key: Period; label: string }> = [
    { key: "today", label: "Сегодня" },
    { key: "yesterday", label: "Вчера" },
    { key: "7d", label: "Неделя" },
    { key: "30d", label: "Месяц" },
    { key: "365d", label: "Год" },
    { key: "all", label: "Всё время" },
  ];
  const isMonthActive = period.startsWith("month-");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 items-center">
        {primaryButtons.map((b) => (
          <Button
            key={b.key}
            variant={period === b.key ? "default" : "outline"}
            size="sm"
            onClick={() => onChange(b.key)}
            data-testid={`period-${b.key}`}
          >
            {b.label}
          </Button>
        ))}
        <Button
          variant={isMonthActive ? "default" : "outline"}
          size="sm"
          onClick={() => setMonthsOpen((v) => !v)}
          data-testid="period-months-toggle"
          aria-expanded={monthsOpen}
        >
          {isMonthActive ? PERIOD_LABELS[period] : "Месяцы"} {monthsOpen ? "▴" : "▾"}
        </Button>
      </div>
      {monthsOpen && (
        <div
          className="flex flex-wrap gap-2 p-3 rounded-xl border border-purple-500/20 bg-purple-500/5"
          data-testid="period-months-row"
        >
          {MONTH_SHORT_LABELS.map((b) => (
            <Button
              key={b.key}
              variant={period === b.key ? "default" : "outline"}
              size="sm"
              onClick={() => onChange(b.key)}
              data-testid={`period-${b.key}`}
            >
              {b.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Domain selector (Eugene 2026-05-17 Босс «per-domain трекинг»)
// Глобальный фильтр сверху dashboard: Все / MuzaAi.ru / MuziAi.ru /
// podaripesnu.ru / Прочие. Передаётся как `?domain=...` во все
// аналитические endpoint'ы.
// Brand-style: glass-card, gradient на active, font-mono для пилюль.
// ============================================================
function DomainSelector({
  domain,
  onChange,
}: {
  domain: DomainBucket;
  onChange: (d: DomainBucket) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-sans text-muted-foreground select-none">
        🌐 Домен:
      </span>
      {DOMAIN_OPTIONS.map((o) => (
        <Button
          key={o.key}
          variant={domain === o.key ? "default" : "outline"}
          size="sm"
          onClick={() => onChange(o.key)}
          data-testid={`domain-${o.key}`}
          className={
            domain === o.key
              ? "bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 shadow-[0_0_16px_rgba(124,58,237,0.4)] border-transparent text-white"
              : "border-purple-400/20 hover:bg-purple-500/10 text-white/80"
          }
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

// ============================================================
// By-Domain breakdown (Eugene 2026-05-17 Босс): таблица всех 4 bucket'ов
// (3 known + other) × 4 метрики (visitors / plays / regs / payments).
// Источник — /api/admin/v304/brain-export → data.byDomain.
// ============================================================
function ByDomainSection() {
  const { data, isLoading, refetch } = useQuery<{ byDomain?: Record<string, DomainMetrics> }>({
    queryKey: ["/api/admin/v304/brain-export"],
    queryFn: () =>
      fetcher<{ byDomain?: Record<string, DomainMetrics> }>("/api/admin/v304/brain-export"),
    refetchInterval: 120_000,
  });

  const buckets: DomainBucket[] = ["muzaai.ru", "muziai.ru", "podaripesnu.ru", "other"];
  const byDomain = data?.byDomain || {};

  const copyTable = () => {
    const rows = [
      ["Метрика", ...buckets.map(b => DOMAIN_LABELS[b])].join("\t"),
      ["Visitors (уник)", ...buckets.map(b => byDomain[b]?.visitors ?? 0)].join("\t"),
      ["Plays (30д)", ...buckets.map(b => byDomain[b]?.plays ?? 0)].join("\t"),
      ["Регистрации", ...buckets.map(b => byDomain[b]?.registrations ?? 0)].join("\t"),
      ["Платежи (#)", ...buckets.map(b => byDomain[b]?.payments.count ?? 0)].join("\t"),
      ["Сумма (₽)", ...buckets.map(b => byDomain[b]?.payments.rub ?? 0)].join("\t"),
    ].join("\n");
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(rows);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold text-white">
          🌐 По доменам · 30 дней
          <span className="ml-2 text-[11px] font-sans text-muted-foreground">
            (best-effort first-touch domain для users / payments)
          </span>
        </h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={copyTable} data-testid="copy-bydomain-table">
            📋 Копировать
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="refresh-bydomain">
            🔄
          </Button>
        </div>
      </div>
      <div className="glass-card rounded-2xl p-4 border border-purple-500/20 overflow-x-auto">
        {isLoading && !data ? (
          <div className="text-xs font-sans text-muted-foreground py-4 text-center">
            Загружаю byDomain breakdown…
          </div>
        ) : (
          <table className="w-full text-xs font-sans">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground border-b border-purple-500/20">
                <th className="py-2 pr-3">Метрика</th>
                {buckets.map(b => (
                  <th key={b} className="py-2 px-3 text-right">
                    {DOMAIN_LABELS[b]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-white/90">
              <ByDomainRow label="Visitors (уник)" buckets={buckets} byDomain={byDomain}
                getValue={m => m.visitors} />
              <ByDomainRow label="Plays" buckets={buckets} byDomain={byDomain}
                getValue={m => m.plays} />
              <ByDomainRow label="Регистрации" buckets={buckets} byDomain={byDomain}
                getValue={m => m.registrations} />
              <ByDomainRow label="Платежи (#)" buckets={buckets} byDomain={byDomain}
                getValue={m => m.payments.count} />
              <ByDomainRow label="Сумма (₽)" buckets={buckets} byDomain={byDomain}
                getValue={m => m.payments.rub} highlight />
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function ByDomainRow({
  label,
  buckets,
  byDomain,
  getValue,
  highlight = false,
}: {
  label: string;
  buckets: DomainBucket[];
  byDomain: Record<string, DomainMetrics>;
  getValue: (m: DomainMetrics) => number;
  highlight?: boolean;
}) {
  return (
    <tr className="border-b border-purple-500/10 last:border-b-0">
      <td className="py-2 pr-3 font-sans text-white/80">{label}</td>
      {buckets.map(b => {
        const m = byDomain[b];
        const v = m ? getValue(m) : 0;
        return (
          <td
            key={b}
            className={`py-2 px-3 text-right font-mono ${
              highlight ? "text-emerald-300 font-bold" : "text-cyan-300"
            }`}
          >
            {v.toLocaleString("ru-RU")}
          </td>
        );
      })}
    </tr>
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
// 🎤 Сказать Музе — голосовая команда Админ ↔ Муза
// (Eugene 2026-05-17 Босс). MediaRecorder → POST /voice-command (audio webm)
// → transcript + Муза-response + executed actions + optional TTS.
//
// UX:
//  - Большая круглая кнопка purple→cyan с микрофоном
//  - Pulsing ring во время записи
//  - Auto-stop через 60 сек (cost cap)
//  - Permission denied → toast
//  - Loading state: «Слушает... Распознаёт... Думает...»
//  - Result panel: transcript + response + actions, auto-play TTS
//  - История последних 5 команд (collapsible)
// ============================================================

type VoiceAction = { tool: string; input: any; result: string };

type VoiceCommandResult = {
  transcript: string;
  response: string;
  actions: VoiceAction[];
  audioBase64?: string;
  audioContentType?: string;
  meta?: {
    durationMs: number;
    usage?: { inputTokens: number; outputTokens: number };
    ttsRequested?: boolean;
  };
};

type RecentVoiceItem = {
  id: number;
  adminUserId: number | null;
  createdAt: string;
  transcript: string;
  response: string;
  actions: VoiceAction[];
  durationMs?: number;
};

function base64ToBlob(b64: string, contentType: string): Blob {
  const byteChars = atob(b64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: contentType });
}

function MusaVoiceCommand() {
  const [state, setState] = useState<"idle" | "recording" | "uploading" | "thinking" | "playing">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VoiceCommandResult | null>(null);
  const [history, setHistory] = useState<RecentVoiceItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [autoTts, setAutoTts] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("voice-command-tts") !== "0";
  });
  // Email-2FA pending confirm — Eugene 2026-05-17 Босс.
  // Когда tool возвращает requiresEmailConfirm=true в result.actions[*].result,
  // показываем модалку. После confirm — callback фактически только закрывает
  // модалку (saved actionId записан в admin_pending_actions со status=confirmed
  // → Босс повторяет ту же голосовую команду, на этот раз require2FA()
  // resolveит через getConfirmedAction).
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmInfo | null>(null);
  const [pendingConfirmOpen, setPendingConfirmOpen] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const autoStopTimerRef = useRef<number | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/v304/voice-command/recent?limit=5", {
        credentials: "include",
      });
      if (!r.ok) return;
      const j = await r.json();
      setHistory(j?.data?.items || []);
    } catch {}
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {}
      streamRef.current = null;
    }
    if (autoStopTimerRef.current) {
      window.clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
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
    if (state === "playing") setState("idle");
  }, [state]);

  useEffect(() => {
    return () => {
      cleanupStream();
      stopPlayback();
    };
  }, [cleanupStream, stopPlayback]);

  const handleAutoTtsChange = (on: boolean) => {
    setAutoTts(on);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("voice-command-tts", on ? "1" : "0");
    }
  };

  const startRecording = useCallback(async () => {
    setError(null);
    setResult(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Браузер не поддерживает запись микрофона.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const msg =
        e instanceof Error && e.name === "NotAllowedError"
          ? "Разреши доступ к микрофону (значок 🎤 в адресной строке)."
          : e instanceof Error
          ? e.message
          : String(e);
      setError(msg);
      return;
    }
    streamRef.current = stream;
    // MediaRecorder в webm/opus — Yandex STT перепакует через ffmpeg.
    let recorder: MediaRecorder;
    try {
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      recorder = new MediaRecorder(stream, { mimeType: mime });
    } catch {
      recorder = new MediaRecorder(stream);
    }
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      cleanupStream();
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      chunksRef.current = [];
      if (blob.size < 500) {
        setError("Запись слишком короткая — попробуй ещё раз (минимум 1 сек).");
        setState("idle");
        return;
      }
      await uploadAudio(blob);
    };
    recorder.start();
    setState("recording");
    // Auto-stop через 60 сек (cost cap)
    autoStopTimerRef.current = window.setTimeout(() => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
    }, 60_000);
  }, [cleanupStream]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      // setState переключится в uploadAudio
      setState("uploading");
    }
  }, []);

  const uploadAudio = useCallback(
    async (blob: Blob) => {
      setState("uploading");
      try {
        const fd = new FormData();
        fd.append("audio", blob, "voice.webm");
        const url = `/api/admin/v304/voice-command${autoTts ? "?tts=1" : ""}`;
        const r = await fetch(url, {
          method: "POST",
          credentials: "include",
          body: fd,
        });
        if (!r.ok) {
          const tx = await r.text().catch(() => "");
          let err = tx.slice(0, 200);
          try {
            const j = JSON.parse(tx);
            if (j?.error) err = j.error;
          } catch {}
          throw new Error(`${r.status}: ${err}`);
        }
        setState("thinking");
        const j = await r.json();
        const data: VoiceCommandResult = j.data;
        setResult(data);
        // Detect requiresEmailConfirm в actions[*].result (Eugene 2026-05-17 Босс)
        if (data.actions && data.actions.length > 0) {
          for (const a of data.actions) {
            const pending = detectPendingConfirm(a.result);
            if (pending) {
              setPendingConfirm(pending);
              setPendingConfirmOpen(true);
              break;
            }
          }
        }
        // History refresh
        loadHistory();
        // Auto-play TTS
        if (data.audioBase64 && data.audioContentType) {
          const audioBlob = base64ToBlob(data.audioBase64, data.audioContentType);
          if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
          const audioUrl = URL.createObjectURL(audioBlob);
          blobUrlRef.current = audioUrl;
          const audio = new Audio(audioUrl);
          registerAudio(audio);
          audioRef.current = audio;
          audio.onended = () => {
            setState("idle");
            if (blobUrlRef.current) {
              URL.revokeObjectURL(blobUrlRef.current);
              blobUrlRef.current = null;
            }
          };
          audio.onerror = () => {
            setState("idle");
            setError("Ошибка воспроизведения mp3");
          };
          setState("playing");
          await audio.play().catch((e) => {
            console.warn("auto-play blocked", e);
            setState("idle");
          });
        } else {
          setState("idle");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState("idle");
      }
    },
    [autoTts, loadHistory],
  );

  const onMicClick = () => {
    if (state === "idle") {
      startRecording();
    } else if (state === "recording") {
      stopRecording();
    } else if (state === "playing") {
      stopPlayback();
    }
  };

  const stateLabel =
    state === "recording"
      ? "🔴 Слушает... (нажми чтобы остановить)"
      : state === "uploading"
      ? "📤 Распознаёт..."
      : state === "thinking"
      ? "🧠 Думает..."
      : state === "playing"
      ? "🔊 Озвучивает (нажми чтобы остановить)"
      : "🎤 Сказать Музе";

  return (
    <>
    <section
      className="glass-card rounded-2xl p-4 border border-cyan-500/30 hover:border-cyan-500/50 transition-colors"
      data-testid="musa-voice-command"
    >
      <div className="flex items-start gap-3">
        <span className="text-3xl">🎙</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 font-medium">
              Голос
            </span>
            <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 font-medium">
              Admin · Tools
            </span>
            <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">
              Yandex STT/TTS
            </span>
          </div>
          <h3 className="text-lg font-sans font-bold text-white mb-2">
            <span className="bg-gradient-to-r from-purple-300 via-cyan-300 to-emerald-300 bg-clip-text text-transparent">
              Сказать Музе
            </span>
          </h3>
          <p className="text-sm font-sans text-muted-foreground leading-relaxed">
            Нажми кнопку, проговори команду — Муза распознает, выполнит и озвучит ответ.
            Доступны admin-tools: метрики, поиск юзеров, инциденты, платежи, перезагрузка KB.
            Лимит: 30 команд в час, до 60 сек на запись.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onMicClick}
              disabled={state === "uploading" || state === "thinking"}
              data-testid="musa-voice-mic"
              className={`relative w-20 h-20 rounded-full font-bold text-2xl flex items-center justify-center transition-all
                ${
                  state === "recording"
                    ? "bg-gradient-to-br from-red-500 via-pink-500 to-purple-500 shadow-[0_0_40px_rgba(239,68,68,0.7)] animate-pulse"
                    : state === "playing"
                    ? "bg-gradient-to-br from-emerald-500 via-cyan-500 to-blue-500 shadow-[0_0_40px_rgba(34,211,238,0.5)]"
                    : state === "idle"
                    ? "bg-gradient-to-br from-purple-500 via-fuchsia-500 to-cyan-500 shadow-[0_0_32px_rgba(124,58,237,0.5)] hover:scale-110"
                    : "bg-white/10 opacity-70 cursor-wait"
                }`}
              aria-label={stateLabel}
              title={stateLabel}
            >
              {state === "recording" && (
                <span className="absolute inset-0 rounded-full ring-4 ring-red-400/40 animate-ping" />
              )}
              <span className="relative z-10">
                {state === "recording" ? "⏹" : state === "playing" ? "🔇" : "🎤"}
              </span>
            </button>

            <div className="flex flex-col gap-1 text-xs">
              <div className="font-medium text-white">{stateLabel}</div>
              <label className="flex items-center gap-1 text-muted-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoTts}
                  onChange={(e) => handleAutoTtsChange(e.target.checked)}
                  className="rounded border-white/20"
                  data-testid="musa-voice-tts-toggle"
                />
                Озвучивать ответ
              </label>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-3 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          Ошибка: {error}
        </div>
      )}

      {result && (
        <div className="mt-3 space-y-2" data-testid="musa-voice-result">
          <div className="bg-black/30 border border-white/10 rounded-lg px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Распознано
            </div>
            <div className="text-sm text-white/90">{result.transcript}</div>
          </div>
          <div
            className={`bg-gradient-to-br from-purple-500/10 to-cyan-500/10 border rounded-lg px-3 py-2 transition-all ${
              state === "playing"
                ? "border-cyan-400/60 ring-2 ring-cyan-400/40 shadow-[0_0_24px_rgba(34,211,238,0.4)]"
                : "border-purple-500/20"
            }`}
          >
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Муза ответила
            </div>
            <div className="text-sm text-white whitespace-pre-wrap">{result.response}</div>
          </div>
          {result.actions && result.actions.length > 0 && (
            <details className="bg-black/30 border border-amber-500/20 rounded-lg px-3 py-2" open>
              <summary className="text-[11px] uppercase tracking-wider text-amber-300 cursor-pointer">
                Выполненные действия ({result.actions.length})
              </summary>
              <ul className="mt-2 space-y-1 text-xs">
                {result.actions.map((a, i) => (
                  <li key={i} className="border-l-2 border-amber-500/40 pl-2">
                    <div className="text-amber-300 font-mono">
                      {a.tool}({JSON.stringify(a.input).slice(0, 80)})
                    </div>
                    <div className="text-white/70 whitespace-pre-wrap">
                      {String(a.result).slice(0, 400)}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {result.meta && (
            <div className="text-[10px] text-muted-foreground font-mono">
              {result.meta.durationMs}ms · tokens in/out{" "}
              {result.meta.usage?.inputTokens ?? 0}/{result.meta.usage?.outputTokens ?? 0}
              {result.meta.ttsRequested && " · TTS ✓"}
            </div>
          )}
        </div>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          className="text-[11px] text-muted-foreground hover:text-white transition-colors"
          data-testid="musa-voice-history-toggle"
        >
          {historyOpen ? "▼" : "▶"} История ({history.length})
        </button>
        {historyOpen && (
          <div className="mt-2 space-y-2">
            {history.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">Ещё нет команд.</div>
            ) : (
              history.map((h) => (
                <div
                  key={h.id}
                  className="bg-black/20 border border-white/[0.06] rounded-lg px-3 py-2 text-xs"
                >
                  <div className="text-[10px] text-muted-foreground font-mono mb-1">
                    #{h.id} · {new Date(h.createdAt).toLocaleString("ru-RU")}
                    {h.durationMs ? ` · ${h.durationMs}ms` : ""}
                  </div>
                  <div className="text-white/80">
                    <span className="text-cyan-300">→</span> {h.transcript}
                  </div>
                  <div className="text-white/60 mt-1">
                    <span className="text-purple-300">←</span> {h.response.slice(0, 200)}
                    {h.response.length > 200 ? "…" : ""}
                  </div>
                  {h.actions && h.actions.length > 0 && (
                    <div className="text-[10px] text-amber-300/70 mt-1 font-mono">
                      {h.actions.map((a) => a.tool).join(", ")}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </section>
    <AdminConfirmAction
      open={pendingConfirmOpen}
      pending={pendingConfirm}
      authToken={typeof window !== "undefined" ? localStorage.getItem("token") || undefined : undefined}
      onConfirmed={() => {
        setPendingConfirmOpen(false);
        // Auto-toast — code accepted, Босс может повторить голосовую команду
        // (с этим же intent — но Муза снова вызовет tool и теперь require2FA
        // resolveит через getConfirmedAction, action выполнится).
        if (typeof window !== "undefined") {
          // Use existing toast if available, otherwise console
          console.info("[admin-2fa] code accepted. Повтори команду — действие выполнится.");
        }
      }}
      onCancel={() => setPendingConfirmOpen(false)}
    />
    </>
  );
}

// ============================================================
// MAIN TAB
// ============================================================
// Eugene 2026-05-17 Босс «по умолчанию параметры в проекте везде сегодня».
// localStorage 'admin-period' — синхронизированный выбор period на все вкладки
// админки (Period-20-MSK rule cut-off 20:00 МСК).
function readDefaultPeriod(): Period {
  if (typeof window === "undefined") return "today";
  const saved = window.localStorage.getItem("admin-period");
  if (saved && (saved === "today" || saved === "yesterday" || saved === "7d" || saved === "30d" || saved === "365d" || saved === "all" || saved.startsWith("month-") || saved === "custom")) {
    return saved as Period;
  }
  return "today";
}

export default function MasterDashboardTab() {
  const [period, setPeriodState] = useState<Period>(readDefaultPeriod());
  const setPeriod = (p: Period) => {
    setPeriodState(p);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("admin-period", p);
      window.dispatchEvent(new CustomEvent("admin-period-change", { detail: p }));
    }
  };
  // Eugene 2026-05-17 Босс «per-domain трекинг».
  // 'all' = без фильтра, не передаём ?domain= в URL чтобы не дробить кэш.
  const [domain, setDomain] = useState<DomainBucket>("all");
  const domainQ = domain !== "all" ? `&domain=${domain}` : "";
  const { data, isLoading, refetch } = useQuery<DashboardSummary>({
    queryKey: [`/api/admin/v304/dashboard-summary?period=${period}${domainQ}`],
    queryFn: () =>
      fetcher<DashboardSummary>(`/api/admin/v304/dashboard-summary?period=${period}${domainQ}`),
    refetchInterval: 30_000,
  });
  const { data: clickStats, isLoading: clicksLoading } = useQuery<ClickStats>({
    queryKey: [`/api/admin/v304/click-stats?period=${period}${domainQ}`],
    queryFn: () =>
      fetcher<ClickStats>(`/api/admin/v304/click-stats?period=${period}${domainQ}`),
    refetchInterval: 60_000,
  });

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
    <div className="space-y-6 cyber-grid -m-2 p-2 sm:-m-4 sm:p-4 rounded-2xl">
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
        <div className="flex flex-wrap items-center gap-2">
          <PeriodSelector period={period} onChange={setPeriod} />
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

      {/* 🌐 Domain selector — глобальный per-domain фильтр */}
      <DomainSelector domain={domain} onChange={setDomain} />

      {/* 🎙 Муза доложит — TTS озвучка */}
      <MusaBriefing period={period} />

      {/* 🎤 Сказать Музе — голосовой диалог Админ ↔ Муза */}
      <MusaVoiceCommand />

      {/* 🌐 By-Domain breakdown — отдельная секция от brain-export */}
      <ByDomainSection />

      {/* 1. Status cards — light-status indicators */}
      <section>
        <h3 className="text-sm font-bold text-white mb-2">
          1. Лампочки статусов · {data.statusCards.length} групп
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {data.statusCards.map((c) => (
            <StatusLamp key={c.key} card={c} />
          ))}
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
