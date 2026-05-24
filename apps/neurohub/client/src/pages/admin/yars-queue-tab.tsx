// Eugene 2026-05-23 Босс «правило ярс в админке дублируется оставь одно
// прокачай его навык». Consolidated Yars admin tab — единственная точка
// мониторинга всех Yars-команд (web/TG/Max/inject). Заменяет 🔐 Operator
// и встроенный yars-rules блок мастер-дашборда.
//
// Источник правды: chatbot_messages WHERE is_yars_command=1 (см. CLAUDE.md
// Yars-admin-confirmation rule + Yars-messenger-no-autoapply rule).
// Apply/reject — только через Claude chat (claude.ai/code). Этот tab —
// read-only обзор с прокачанным навыком: фильтры, поиск, экспорт, статистика.
//
// Brand-style: glass-card / font-display / font-mono для IDs и SHA.
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface YarsQueueItem {
  id: number;
  sessionId?: string | null;
  userId?: number | null;
  text: string;
  role: string;
  yarsCategory: string | null;
  yarsRiskLevel: "low" | "medium" | "high" | null;
  claudeReviewDecision: "pending" | "applied" | "rejected" | "auto_applied" | null;
  claudeReviewAt: number | null;
  claudeReviewCommitSha: string | null;
  claudeReviewNotes: string | null;
  createdAt: number | string;
  channel?: string;
}

interface YarsQueueResponse {
  ok: boolean;
  queue: YarsQueueItem[];
  summary: { total: number; byRisk: Record<string, number>; byCategory: Record<string, number> };
  hint?: string;
}

interface YarsRulesResponse {
  ok: boolean;
  total: number;
  byChannel: Record<string, number>;
  rules: Array<{ id: number; channel: string; sessionId: string; rule: string; createdAt: number }>;
  hint?: string;
}

const RISK_STYLE: Record<string, string> = {
  low: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  medium: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  high: "bg-red-500/15 text-red-300 border-red-500/40",
};

const RISK_EMOJI: Record<string, string> = { low: "🟢", medium: "🟡", high: "🔴" };

const DECISION_LABEL: Record<string, { txt: string; color: string }> = {
  pending: { txt: "⏳ Ждёт", color: "text-amber-300" },
  applied: { txt: "✅ Применено", color: "text-emerald-300" },
  auto_applied: { txt: "⚡ Auto-applied", color: "text-cyan-300" },
  rejected: { txt: "❌ Отклонено", color: "text-red-300" },
};

const CATEGORY_STYLE: Record<string, string> = {
  news_post: "bg-purple-500/15 text-purple-300 border-purple-500/30",
  ui_text: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  kb_update: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  persona_tweak: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
  feature_toggle: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  code_change: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  db_migration: "bg-red-500/15 text-red-300 border-red-500/40",
  endpoint_add: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  endpoint_remove: "bg-red-500/15 text-red-300 border-red-500/40",
  schema_change: "bg-red-500/15 text-red-300 border-red-500/40",
  plugin_install: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  plugin_remove: "bg-red-500/15 text-red-300 border-red-500/40",
  core_change: "bg-red-500/15 text-red-300 border-red-500/40",
  dependency_change: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  secret_change: "bg-red-500/15 text-red-300 border-red-500/40",
  prod_deploy: "bg-red-500/15 text-red-300 border-red-500/40",
  delete: "bg-red-500/15 text-red-300 border-red-500/40",
};

const SAFE_CATEGORIES = new Set(["news_post", "kb_update", "persona_tweak", "ui_text", "feature_toggle"]);

type DateRange = "24h" | "7d" | "30d" | "all";
type SortMode = "created_desc" | "risk_desc" | "category_asc";

function categoryClass(cat: string | null): string {
  if (!cat) return "bg-white/5 text-white/60 border border-white/15";
  return CATEGORY_STYLE[cat] || "bg-white/5 text-white/60 border border-white/15";
}

function toMs(value: number | string | null | undefined): number {
  if (!value) return 0;
  if (typeof value === "number") return value;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function fmtTime(value: number | string | null | undefined): string {
  const ms = toMs(value);
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

function csvEscape(v: any): string {
  const s = String(v ?? "");
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export default function YarsQueueTab({ toast }: { toast?: any }) {
  const [statusFilter, setStatusFilter] = useState<"pending" | "all" | "applied" | "rejected" | "auto_applied">("pending");
  const [riskFilter, setRiskFilter] = useState<"" | "low" | "medium" | "high">("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [channelFilter, setChannelFilter] = useState<string>("");
  // Eugene 2026-05-24 Босс «По умолчанию все данные в админ-панели — сегодня».
  const [dateRange, setDateRange] = useState<DateRange>("24h");
  const [sortMode, setSortMode] = useState<SortMode>("created_desc");
  const [search, setSearch] = useState<string>("");

  // Основная очередь Yars-команд (источник правды: chatbot_messages).
  const { data, isLoading, isError, refetch } = useQuery<YarsQueueResponse>({
    queryKey: ["/api/admin/v304/yars-queue", statusFilter, riskFilter, channelFilter],
    queryFn: async () => {
      const qs = new URLSearchParams();
      qs.set("status", statusFilter);
      qs.set("limit", "200");
      if (riskFilter) qs.set("risk", riskFilter);
      if (channelFilter) qs.set("channel", channelFilter);
      const r = await fetch(`/api/admin/v304/yars-queue?${qs.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });

  // Дополнительный pool правил от Ярса (агрегат из user-сообщений по ключу
  // «Ярс»). Раньше жил в master-dashboard — переехал сюда.
  const { data: rulesData } = useQuery<YarsRulesResponse>({
    queryKey: ["/api/admin/v304/yars-rules"],
    refetchInterval: 60_000,
  });

  // Дата-фильтр + поиск + сортировка применяются на клиенте поверх ответа.
  const filteredQueue = useMemo<YarsQueueItem[]>(() => {
    if (!data?.queue) return [];
    const now = Date.now();
    const windowMs = dateRange === "24h" ? 24 * 3600 * 1000
      : dateRange === "7d" ? 7 * 24 * 3600 * 1000
      : dateRange === "30d" ? 30 * 24 * 3600 * 1000
      : Infinity;
    const needle = search.trim().toLowerCase();
    const items = data.queue.filter((it) => {
      if (categoryFilter && it.yarsCategory !== categoryFilter) return false;
      if (windowMs !== Infinity) {
        const ms = toMs(it.createdAt);
        if (!ms || now - ms > windowMs) return false;
      }
      if (needle) {
        const hay = `${it.text} ${it.yarsCategory ?? ""} ${it.channel ?? ""} ${it.userId ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    const sorted = [...items];
    if (sortMode === "risk_desc") {
      const order = { high: 3, medium: 2, low: 1, "": 0 } as any;
      sorted.sort((a, b) => (order[b.yarsRiskLevel || ""] || 0) - (order[a.yarsRiskLevel || ""] || 0) || toMs(b.createdAt) - toMs(a.createdAt));
    } else if (sortMode === "category_asc") {
      sorted.sort((a, b) => (a.yarsCategory || "zz").localeCompare(b.yarsCategory || "zz") || toMs(b.createdAt) - toMs(a.createdAt));
    } else {
      sorted.sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
    }
    return sorted;
  }, [data, dateRange, search, categoryFilter, sortMode]);

  // Локальная аналитика: counts по decision, среднее время до apply.
  const analytics = useMemo(() => {
    const list = data?.queue || [];
    const byDecision: Record<string, number> = { pending: 0, applied: 0, auto_applied: 0, rejected: 0 };
    const applyTimes: number[] = [];
    for (const it of list) {
      const dec = it.claudeReviewDecision || "pending";
      byDecision[dec] = (byDecision[dec] || 0) + 1;
      if ((dec === "applied" || dec === "auto_applied") && it.claudeReviewAt) {
        const created = toMs(it.createdAt);
        const reviewed = toMs(it.claudeReviewAt);
        if (created && reviewed && reviewed >= created) applyTimes.push(reviewed - created);
      }
    }
    const avgApplyMs = applyTimes.length
      ? Math.round(applyTimes.reduce((a, b) => a + b, 0) / applyTimes.length)
      : 0;
    const safeCount = list.filter((it) => SAFE_CATEGORIES.has(it.yarsCategory || "")).length;
    return { byDecision, avgApplyMs, safeCount };
  }, [data]);

  // Категории найденные в текущей выборке — для chip-фильтра.
  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const it of data?.queue || []) {
      if (it.yarsCategory) set.add(it.yarsCategory);
    }
    return Array.from(set).sort();
  }, [data]);

  function exportCsv() {
    const rows = [
      ["id", "createdAt", "channel", "userId", "category", "risk", "decision", "reviewedAt", "commitSha", "text"],
      ...filteredQueue.map((it) => [
        it.id,
        new Date(toMs(it.createdAt)).toISOString(),
        it.channel ?? "",
        it.userId ?? "",
        it.yarsCategory ?? "",
        it.yarsRiskLevel ?? "",
        it.claudeReviewDecision ?? "pending",
        it.claudeReviewAt ? new Date(toMs(it.claudeReviewAt)).toISOString() : "",
        it.claudeReviewCommitSha ?? "",
        it.text,
      ]),
    ];
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `yars-queue-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast?.({ title: "Экспорт CSV", description: `${filteredQueue.length} строк сохранено` });
  }

  function copyReport() {
    const lines: string[] = [];
    lines.push(`Yars-очередь · ${new Date().toLocaleString("ru-RU")}`);
    lines.push(`Всего pending: ${analytics.byDecision.pending} · applied: ${analytics.byDecision.applied} · auto: ${analytics.byDecision.auto_applied} · rejected: ${analytics.byDecision.rejected}`);
    if (analytics.avgApplyMs) {
      const mins = Math.round(analytics.avgApplyMs / 60000);
      lines.push(`Среднее время до apply: ${mins} мин`);
    }
    lines.push("");
    for (const it of filteredQueue.slice(0, 50)) {
      lines.push(`#${it.id} · ${it.yarsRiskLevel || "?"} · ${it.yarsCategory || "?"} · ${it.channel || "?"} · ${fmtTime(it.createdAt)}`);
      lines.push(`  ${it.text.slice(0, 200).replace(/\s+/g, " ")}`);
    }
    const text = lines.join("\n");
    navigator.clipboard.writeText(text).then(
      () => toast?.({ title: "Скопировано", description: `${filteredQueue.length} записей в буфере` }),
      () => toast?.({ title: "Ошибка", description: "Не удалось скопировать", variant: "destructive" }),
    );
  }

  return (
    <div className="space-y-4">
      {/* Заголовок + workflow-предупреждение */}
      <Card className="glass-card border-purple-500/20">
        <CardHeader className="pb-3">
          <CardTitle className="font-display font-bold gradient-text text-2xl">
            🚨 Ярс — единая очередь
          </CardTitle>
          <p className="text-sm font-sans text-muted-foreground">
            Все operator-команды из всех каналов (web · TG · Max · admin inject) в одном месте.
            Это read-only обзор — apply / reject решает Claude в claude.ai/code после явного «да» от Босса.
          </p>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            <div className="font-semibold mb-1">Правила (Yars-admin + Yars-messenger):</div>
            Low-risk content (news_post · kb_update · persona_tweak · ui_text · feature_toggle) применяется
            автоматически через <span className="font-mono">yarsExecutor</span>. Всё остальное (code_change,
            db_migration, endpoint_*, schema_change, secret_change, prod_deploy) — НЕ auto-apply, ждёт review
            в Claude chat. Из мессенджеров любые destructive команды блокируются вне зависимости от категории.
          </div>
        </CardContent>
      </Card>

      {/* KPI-карточки: pending / applied / auto / rejected / avg time / safe-share */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-xl p-3 bg-gradient-to-br from-amber-500/[0.08] to-purple-500/[0.05] border border-amber-400/30">
          <div className="text-[10px] text-amber-200/70">⏳ Pending review</div>
          <div className="text-2xl font-display font-bold text-amber-200">{analytics.byDecision.pending}</div>
          <div className="text-[10px] text-white/40">ждут Claude</div>
        </div>
        <div className="rounded-xl p-3 bg-gradient-to-br from-emerald-500/[0.08] to-cyan-500/[0.05] border border-emerald-400/30">
          <div className="text-[10px] text-emerald-200/70">✅ Applied</div>
          <div className="text-2xl font-display font-bold text-emerald-200">{analytics.byDecision.applied}</div>
          <div className="text-[10px] text-white/40">manual после review</div>
        </div>
        <div className="rounded-xl p-3 bg-gradient-to-br from-cyan-500/[0.08] to-blue-500/[0.05] border border-cyan-400/30">
          <div className="text-[10px] text-cyan-200/70">⚡ Auto-applied</div>
          <div className="text-2xl font-display font-bold text-cyan-200">{analytics.byDecision.auto_applied}</div>
          <div className="text-[10px] text-white/40">safe categories</div>
        </div>
        <div className="rounded-xl p-3 bg-gradient-to-br from-red-500/[0.08] to-fuchsia-500/[0.05] border border-red-400/30">
          <div className="text-[10px] text-red-200/70">❌ Rejected</div>
          <div className="text-2xl font-display font-bold text-red-200">{analytics.byDecision.rejected}</div>
          <div className="text-[10px] text-white/40">отказ / опасные</div>
        </div>
        <div className="rounded-xl p-3 bg-gradient-to-br from-purple-500/[0.08] to-fuchsia-500/[0.05] border border-purple-400/30">
          <div className="text-[10px] text-purple-200/70">⏱ Avg время → apply</div>
          <div className="text-2xl font-display font-bold text-purple-200 font-mono">
            {analytics.avgApplyMs ? Math.round(analytics.avgApplyMs / 60000) + " м" : "—"}
          </div>
          <div className="text-[10px] text-white/40">safe-доля: {analytics.safeCount}</div>
        </div>
      </div>

      {/* Action-bar: refresh / copy / csv */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => refetch()}
          className="px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-purple-400/30 text-purple-200 hover:bg-purple-500/15 transition"
        >
          ↻ Обновить
        </button>
        <button
          onClick={copyReport}
          className="px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-cyan-400/30 text-cyan-200 hover:bg-cyan-500/15 transition"
        >
          📋 Скопировать отчёт
        </button>
        <button
          onClick={exportCsv}
          className="px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-fuchsia-400/30 text-fuchsia-200 hover:bg-fuchsia-500/15 transition"
        >
          ⬇ Экспорт CSV ({filteredQueue.length})
        </button>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Поиск по тексту / каналу / userId…"
          className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg text-xs bg-white/[0.04] border border-white/10 text-white placeholder:text-white/40 focus:border-purple-400/60 focus:outline-none transition"
        />
      </div>

      {/* Filter chips: status / risk / date / sort / channel */}
      <div className="glass-card rounded-2xl border border-white/10 p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-white/50 font-semibold uppercase tracking-wider w-16">Статус:</span>
          {(["pending", "applied", "auto_applied", "rejected", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 rounded-full text-[11px] border transition ${
                statusFilter === s
                  ? "bg-gradient-to-r from-purple-500/30 via-fuchsia-500/20 to-blue-500/30 border-purple-400/60 text-white"
                  : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
              }`}
            >
              {s === "pending" ? "⏳ Ждут" : s === "applied" ? "✅ Applied" : s === "auto_applied" ? "⚡ Auto" : s === "rejected" ? "❌ Rejected" : "Все"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-white/50 font-semibold uppercase tracking-wider w-16">Риск:</span>
          {(["", "low", "medium", "high"] as const).map((r) => (
            <button
              key={r || "all"}
              onClick={() => setRiskFilter(r)}
              className={`px-2.5 py-1 rounded-full text-[11px] border transition ${
                riskFilter === r
                  ? "bg-gradient-to-r from-purple-500/30 via-fuchsia-500/20 to-blue-500/30 border-purple-400/60 text-white"
                  : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
              }`}
            >
              {r === "" ? "Все" : `${RISK_EMOJI[r]} ${r}`}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-white/50 font-semibold uppercase tracking-wider w-16">Канал:</span>
          {(["", "web", "telegram", "max"] as const).map((c) => (
            <button
              key={c || "all"}
              onClick={() => setChannelFilter(c)}
              className={`px-2.5 py-1 rounded-full text-[11px] border transition ${
                channelFilter === c
                  ? "bg-gradient-to-r from-purple-500/30 via-fuchsia-500/20 to-blue-500/30 border-purple-400/60 text-white"
                  : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
              }`}
            >
              {c === "" ? "Все" : c}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-white/50 font-semibold uppercase tracking-wider w-16">Период:</span>
          {(["24h", "7d", "30d", "all"] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDateRange(d)}
              className={`px-2.5 py-1 rounded-full text-[11px] border transition ${
                dateRange === d
                  ? "bg-gradient-to-r from-purple-500/30 via-fuchsia-500/20 to-blue-500/30 border-purple-400/60 text-white"
                  : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
              }`}
            >
              {d === "24h" ? "24 часа" : d === "7d" ? "7 дней" : d === "30d" ? "30 дней" : "Всё время"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-white/50 font-semibold uppercase tracking-wider w-16">Сортировка:</span>
          {(["created_desc", "risk_desc", "category_asc"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSortMode(s)}
              className={`px-2.5 py-1 rounded-full text-[11px] border transition ${
                sortMode === s
                  ? "bg-gradient-to-r from-purple-500/30 via-fuchsia-500/20 to-blue-500/30 border-purple-400/60 text-white"
                  : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
              }`}
            >
              {s === "created_desc" ? "🕐 Новые" : s === "risk_desc" ? "🔴 Риск ↓" : "📂 Категория"}
            </button>
          ))}
        </div>
        {availableCategories.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] text-white/50 font-semibold uppercase tracking-wider w-16">Кат-я:</span>
            <button
              onClick={() => setCategoryFilter("")}
              className={`px-2.5 py-1 rounded-full text-[11px] border transition ${
                !categoryFilter
                  ? "bg-gradient-to-r from-purple-500/30 via-fuchsia-500/20 to-blue-500/30 border-purple-400/60 text-white"
                  : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
              }`}
            >
              Все
            </button>
            {availableCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`px-2.5 py-1 rounded-full text-[11px] border transition ${
                  categoryFilter === cat
                    ? "ring-1 ring-purple-400/60 " + categoryClass(cat)
                    : categoryClass(cat) + " opacity-70 hover:opacity-100"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Summary aggregate badges */}
      {data?.summary && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="px-2 py-1 rounded-lg bg-white/[0.05] border border-white/10 text-white/80">
            Всего в очереди: <b className="font-mono">{data.summary.total}</b>
          </span>
          {Object.entries(data.summary.byRisk).map(([r, n]) => (
            <span key={r} className={`px-2 py-1 rounded-lg border ${RISK_STYLE[r] || "bg-white/5 text-white/70 border-white/10"}`}>
              {RISK_EMOJI[r] || "•"} {r}: <b className="font-mono">{n}</b>
            </span>
          ))}
          {Object.entries(data.summary.byCategory).slice(0, 8).map(([c, n]) => (
            <span key={c} className={`px-2 py-1 rounded-lg ${categoryClass(c)}`}>
              {c}: <b className="font-mono">{n}</b>
            </span>
          ))}
        </div>
      )}

      {/* List */}
      {isLoading && <div className="text-sm text-muted-foreground py-4">Загрузка…</div>}
      {isError && <div className="text-sm text-red-400 py-4">Ошибка загрузки очереди</div>}
      {data && filteredQueue.length === 0 && !isLoading && (
        <div className="glass-card rounded-2xl border border-white/10 p-8 text-center">
          <div className="text-3xl mb-2">📭</div>
          <div className="text-sm text-white/70 mb-1">Очередь пуста для текущих фильтров</div>
          <div className="text-xs text-white/40">
            Попробуй ослабить фильтры или сменить период
          </div>
        </div>
      )}

      <div className="space-y-2">
        {filteredQueue.map((item) => {
          const dec = item.claudeReviewDecision || "pending";
          const decMeta = DECISION_LABEL[dec] || DECISION_LABEL.pending;
          const risk = item.yarsRiskLevel || "medium";
          const isSafe = SAFE_CATEGORIES.has(item.yarsCategory || "");
          return (
            <div
              key={item.id}
              className={`glass-card rounded-xl p-3 space-y-2 border transition ${
                dec === "pending"
                  ? risk === "high"
                    ? "border-red-400/40 hover:border-red-400/60"
                    : "border-amber-400/30 hover:border-amber-400/50"
                  : "border-white/10 hover:border-white/20"
              }`}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={`px-2 py-0.5 rounded text-[10px] border ${RISK_STYLE[risk]}`}>
                    {RISK_EMOJI[risk]} {risk}
                  </span>
                  {item.yarsCategory && (
                    <span className={`px-2 py-0.5 rounded text-[10px] border ${categoryClass(item.yarsCategory)}`}>
                      {item.yarsCategory}
                    </span>
                  )}
                  {isSafe && (
                    <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-300/80 border border-emerald-500/30">
                      safe
                    </span>
                  )}
                  {item.channel && (
                    <span className="px-2 py-0.5 rounded text-[10px] bg-purple-500/15 text-purple-200 border border-purple-400/30">
                      {item.channel}
                    </span>
                  )}
                  <span className={`text-[11px] ${decMeta.color}`}>{decMeta.txt}</span>
                </div>
                <div className="text-[10px] text-muted-foreground tabular-nums font-mono">
                  #{item.id}
                  {item.userId ? ` · u${item.userId}` : ""}
                  {" · "}
                  {fmtTime(item.createdAt)}
                </div>
              </div>
              <div className="text-sm text-white/90 whitespace-pre-wrap break-words leading-relaxed">
                {item.text}
              </div>
              {(item.claudeReviewCommitSha || item.claudeReviewNotes) && (
                <div className="flex flex-wrap items-center gap-3 text-[10px] pt-1 border-t border-white/5">
                  {item.claudeReviewCommitSha && (
                    <span className="text-cyan-300 font-mono">
                      SHA: {item.claudeReviewCommitSha.slice(0, 12)}
                    </span>
                  )}
                  {item.claudeReviewAt && (
                    <span className="text-white/40 font-mono">
                      reviewed: {fmtTime(item.claudeReviewAt)}
                    </span>
                  )}
                  {item.claudeReviewNotes && (
                    <span className="text-white/60 italic">«{item.claudeReviewNotes}»</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Правила от Ярса — переехало из master-dashboard. Eugene 2026-05-14
          «отчёт по Ярс — собирай и анализируй». */}
      {rulesData?.ok && rulesData.total > 0 && (
        <Card className="glass-card border-purple-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px] font-bold text-white flex items-baseline justify-between">
              <span>🎯 Правила от Ярса <span className="text-[11px] text-purple-300/70 font-normal">({rulesData.total})</span></span>
              <span className="text-[10px] text-white/40 font-normal">из user-сообщений по ключу «Ярс»</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
              {Object.entries(rulesData.byChannel || {}).map(([ch, n]: any) => (
                <span key={ch} className="px-2 py-0.5 rounded-full bg-white/[0.06] text-white/70 border border-white/[0.08]">
                  {ch}: {n}
                </span>
              ))}
            </div>
            <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
              {rulesData.rules.slice(0, 30).map((r) => (
                <div key={r.id} className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.05]">
                  <div className="flex items-baseline gap-2 mb-1 flex-wrap">
                    <span className="text-[9px] text-purple-300/60 uppercase tracking-wider">{r.channel}</span>
                    <span className="text-[9px] text-white/30 font-mono">{r.sessionId}</span>
                    <span className="text-[9px] text-white/30 ml-auto font-mono">{fmtTime(r.createdAt)}</span>
                  </div>
                  <div className="text-[12px] text-white/90 leading-relaxed whitespace-pre-wrap">{r.rule}</div>
                </div>
              ))}
              {rulesData.rules.length > 30 && (
                <div className="text-[10px] text-white/40 text-center py-2">… ещё {rulesData.rules.length - 30}</div>
              )}
            </div>
            {rulesData.hint && (
              <p className="text-[10px] text-white/40 leading-relaxed">💡 {rulesData.hint}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
