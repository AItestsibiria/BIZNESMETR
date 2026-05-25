// Eugene 2026-05-24 Босс «В админке его пропиши, собирай туда ошибки генерации
// + отчёт агента + возможность дожать в ручном режиме».
//
// Admin tab «🚨 Ошибки генерации» — live list of failed generations + manual
// retry/refund/resolve actions + full event timeline drawer.
//
// Источник данных:
//   GET  /api/admin/v304/gen-errors?period=X&type=Y&status=Z&limit=N
//   GET  /api/admin/v304/gen-errors/stats?period=X
//   GET  /api/admin/v304/gen-errors/:id/report → events timeline
//   POST /api/admin/v304/gen-errors/:id/retry
//   POST /api/admin/v304/gen-errors/:id/refund   {confirm:true}
//   POST /api/admin/v304/gen-errors/:id/resolve  {notes?}
//   POST /api/admin/v304/gen-errors/scan-stuck
//
// Brand-style: glass-card + brand gradient palette из CLAUDE.md.
// Live-update: refetchInterval 15 сек.

import { useEffect, useMemo, useState } from "react";

interface GenError {
  id: number;
  userId: number;
  type: string;
  status: string;
  cost: number;
  errorReason: string | null;
  errorClass: string;
  createdAt: string;
  displayTitle: string | null;
  attemptCount: number;
  lastEvent: string | null;
  isEscalated: boolean;
  isRefunded: boolean;
  adminResolved: boolean;
  canRetry: boolean;
}

interface GenErrorStats {
  period: string;
  totalErrors: number;
  recovered: number;
  escalated: number;
  pendingManual: number;
  agentStats: {
    totalTracked: number;
    recovered: number;
    escalated: number;
    manualRetries: number;
    manualRefunds: number;
    lastScanAt: number | null;
    lastError: string | null;
  };
}

interface LifecycleEvent {
  type: string;
  ts: number;
  genId: number;
  userId?: number;
  payload?: Record<string, unknown>;
}

interface GenReport {
  genId: number;
  status: string;
  attemptCount: number;
  events: LifecycleEvent[];
  generation: any;
}

const PERIODS: Array<{ id: string; label: string }> = [
  { id: "today", label: "Сегодня" },
  { id: "yesterday", label: "Вчера" },
  { id: "week", label: "Неделя" },
  { id: "month", label: "Месяц" },
  { id: "all", label: "Всё" },
];

const TYPES: Array<{ id: string; label: string }> = [
  { id: "", label: "Все типы" },
  { id: "music", label: "🎵 Музыка" },
  { id: "lyrics", label: "📝 Текст" },
  { id: "cover", label: "🎨 Обложка" },
];

const STATUSES: Array<{ id: string; label: string; color: string }> = [
  { id: "all", label: "Все", color: "text-white/70" },
  { id: "pending", label: "⏳ Ждут действия", color: "text-amber-300" },
  { id: "escalated", label: "🚨 Эскалированы", color: "text-red-300" },
  { id: "recovered", label: "✅ Восстановлены", color: "text-emerald-300" },
];

function eventTypeBadge(t: string): { emoji: string; cls: string; label: string } {
  const map: Record<string, { emoji: string; cls: string; label: string }> = {
    started: { emoji: "🚀", cls: "text-blue-300 bg-blue-500/10", label: "started" },
    suno_called: { emoji: "📤", cls: "text-cyan-300 bg-cyan-500/10", label: "suno_called" },
    suno_failed: { emoji: "❌", cls: "text-red-300 bg-red-500/10", label: "suno_failed" },
    stuck_processing: { emoji: "⏰", cls: "text-amber-300 bg-amber-500/10", label: "stuck" },
    retrying: { emoji: "🔄", cls: "text-purple-300 bg-purple-500/10", label: "retrying" },
    done: { emoji: "✅", cls: "text-emerald-300 bg-emerald-500/10", label: "done" },
    errored: { emoji: "💥", cls: "text-red-400 bg-red-500/20", label: "errored" },
    refunded: { emoji: "💰", cls: "text-fuchsia-300 bg-fuchsia-500/10", label: "refunded" },
    manual_retry: { emoji: "🔧", cls: "text-purple-200 bg-purple-500/20", label: "manual_retry" },
    manual_refund: { emoji: "💸", cls: "text-fuchsia-200 bg-fuchsia-500/20", label: "manual_refund" },
    manual_resolve: { emoji: "✔️", cls: "text-emerald-200 bg-emerald-500/20", label: "manual_resolve" },
    escalated: { emoji: "🚨", cls: "text-red-200 bg-red-500/30", label: "escalated" },
  };
  return map[t] || { emoji: "•", cls: "text-white/60 bg-white/5", label: t };
}

function errorClassBadge(cls: string): { label: string; color: string } {
  const map: Record<string, { label: string; color: string }> = {
    moderation: { label: "🛡 Модерация", color: "bg-red-500/20 text-red-300" },
    invalid_key: { label: "🔑 Ключ", color: "bg-red-500/20 text-red-300" },
    bad_lyric: { label: "📝 Текст", color: "bg-amber-500/20 text-amber-300" },
    timeout: { label: "⏱ Timeout", color: "bg-amber-500/20 text-amber-300" },
    network: { label: "🌐 Network", color: "bg-amber-500/20 text-amber-300" },
    low_balance: { label: "💰 Баланс", color: "bg-red-500/20 text-red-300" },
    audio_unavailable: { label: "🔇 Аудио", color: "bg-amber-500/20 text-amber-300" },
    suno_transient: { label: "🔄 Suno", color: "bg-purple-500/20 text-purple-300" },
    rate_limit: { label: "🚦 Rate", color: "bg-amber-500/20 text-amber-300" },
    other: { label: "❓ Прочее", color: "bg-white/10 text-white/60" },
  };
  return map[cls] || { label: cls, color: "bg-white/10 text-white/60" };
}

function relTime(iso: string): string {
  try {
    const t = new Date(iso.includes("T") ? iso : iso + "Z").getTime();
    if (!Number.isFinite(t)) return iso;
    const sec = Math.floor((Date.now() - t) / 1000);
    if (sec < 60) return `${sec} сек`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} мин`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} ч`;
    return `${Math.floor(hr / 24)} д`;
  } catch { return iso; }
}

function fmtKopecks(k: number): string {
  return `${Math.round(k / 100)} ₽`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("auth_token") || "";
  const r = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j.data as T;
}

export default function GenErrorsTab() {
  const [period, setPeriod] = useState<string>("today");
  const [type, setType] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [items, setItems] = useState<GenError[]>([]);
  const [stats, setStats] = useState<GenErrorStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openReport, setOpenReport] = useState<number | null>(null);
  const [reportData, setReportData] = useState<GenReport | null>(null);
  const [actionBusy, setActionBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function loadItems() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ period, status: statusFilter, limit: "100" });
      if (type) params.set("type", type);
      const d = await fetchJson<{ items: GenError[]; total: number }>(`/api/admin/v304/gen-errors?${params}`);
      setItems(d.items || []);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadStats() {
    try {
      const d = await fetchJson<GenErrorStats>(`/api/admin/v304/gen-errors/stats?period=${period}`);
      setStats(d);
    } catch {}
  }

  useEffect(() => {
    loadItems();
    loadStats();
    const id = setInterval(() => { loadItems(); loadStats(); }, 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, type, statusFilter]);

  async function openDrawer(genId: number) {
    setOpenReport(genId);
    setReportData(null);
    try {
      const d = await fetchJson<GenReport>(`/api/admin/v304/gen-errors/${genId}/report`);
      setReportData(d);
    } catch (e: any) {
      setToast(`Ошибка отчёта: ${e?.message || e}`);
    }
  }

  async function handleRetry(genId: number) {
    if (actionBusy === genId) return;
    setActionBusy(genId);
    try {
      const r = await fetchJson<any>(`/api/admin/v304/gen-errors/${genId}/retry`, { method: "POST" });
      setToast(r.result?.ok ? `🔄 Retry #${genId} запущен (attempt ${r.attempt})` : `❌ Retry failed: ${r.result?.error || "unknown"}`);
      await loadItems();
    } catch (e: any) {
      setToast(`Ошибка: ${e?.message || e}`);
    } finally {
      setActionBusy(null);
    }
  }

  async function handleRefund(genId: number, cost: number) {
    if (actionBusy === genId) return;
    if (!confirm(`Refund #${genId} на ${fmtKopecks(cost)}? Юзер получит деньги обратно.`)) return;
    setActionBusy(genId);
    try {
      const r = await fetchJson<any>(`/api/admin/v304/gen-errors/${genId}/refund`, {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      setToast(`💰 Refund #${genId} OK: ${fmtKopecks(r.refundedKopecks)}`);
      await loadItems();
    } catch (e: any) {
      setToast(`Ошибка refund: ${e?.message || e}`);
    } finally {
      setActionBusy(null);
    }
  }

  async function handleResolve(genId: number) {
    if (actionBusy === genId) return;
    setActionBusy(genId);
    try {
      const notes = prompt("Заметка (опционально):") || undefined;
      await fetchJson<any>(`/api/admin/v304/gen-errors/${genId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ notes }),
      });
      setToast(`✔️ #${genId} помечена resolved`);
      await loadItems();
    } catch (e: any) {
      setToast(`Ошибка resolve: ${e?.message || e}`);
    } finally {
      setActionBusy(null);
    }
  }

  async function handleScanStuck() {
    try {
      const r = await fetchJson<{ scanned: number; resumed: number; escalated: number }>(
        `/api/admin/v304/gen-errors/scan-stuck`, { method: "POST" },
      );
      setToast(`🔬 Скан: ${r.scanned} stuck, ${r.escalated} эскалированы`);
      await loadItems();
      await loadStats();
    } catch (e: any) {
      setToast(`Ошибка scan: ${e?.message || e}`);
    }
  }

  function copyReport() {
    const txt = JSON.stringify({ stats, items }, null, 2);
    navigator.clipboard.writeText(txt).then(() => setToast("📋 Скопировано"));
  }

  const successRate = useMemo(() => {
    if (!stats || stats.totalErrors === 0) return null;
    const success = stats.recovered;
    return Math.round((success / Math.max(1, stats.totalErrors)) * 100);
  }, [stats]);

  return (
    <div className="space-y-4">
      {/* Toast */}
      {toast && (
        <div
          className="fixed bottom-4 right-4 z-50 px-4 py-2 rounded-lg bg-purple-900/90 backdrop-blur border border-purple-400/40 text-sm text-white shadow-lg cursor-pointer"
          onClick={() => setToast(null)}
        >
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="p-4 rounded-2xl border border-red-500/20 bg-gradient-to-br from-red-500/[0.05] via-amber-500/[0.04] to-purple-500/[0.05] glass-card">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-white mb-1">🚨 Ошибки генерации — лайф-цикл агент</h2>
            <p className="text-xs text-muted-foreground">
              Агент отслеживает генерации от старта до done/errored. Auto-retry transient, эскалация неразрешимых.
              Eugene 2026-05-24 Босс: «продавливать Suno до генерации».
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleScanStuck}
              className="text-xs px-3 py-1.5 rounded-md bg-purple-500/10 hover:bg-purple-500/20 text-purple-200 border border-purple-400/30"
            >🔬 Скан stuck сейчас</button>
            <button
              onClick={() => { loadItems(); loadStats(); }}
              className="text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 border border-white/10"
            >🔄 Обновить</button>
            <button
              onClick={copyReport}
              className="text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 border border-white/10"
            >📋 Копировать</button>
          </div>
        </div>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3 rounded-xl glass-card border border-red-500/20 bg-red-500/[0.04]">
            <div className="text-[10px] uppercase tracking-wider text-red-300/80">Ошибок ({stats.period})</div>
            <div className="text-2xl font-mono font-bold text-red-300 mt-1">{stats.totalErrors}</div>
          </div>
          <div className="p-3 rounded-xl glass-card border border-emerald-500/20 bg-emerald-500/[0.04]">
            <div className="text-[10px] uppercase tracking-wider text-emerald-300/80">Auto-recovered</div>
            <div className="text-2xl font-mono font-bold text-emerald-300 mt-1">{stats.recovered}</div>
            {successRate !== null && (
              <div className="text-[10px] text-emerald-200/60 mt-0.5">{successRate}% от ошибок</div>
            )}
          </div>
          <div className="p-3 rounded-xl glass-card border border-amber-500/20 bg-amber-500/[0.04]">
            <div className="text-[10px] uppercase tracking-wider text-amber-300/80">Ждут вручную</div>
            <div className="text-2xl font-mono font-bold text-amber-300 mt-1">{stats.pendingManual}</div>
          </div>
          <div className="p-3 rounded-xl glass-card border border-red-500/30 bg-red-500/[0.08]">
            <div className="text-[10px] uppercase tracking-wider text-red-200/80">🚨 Эскалированы</div>
            <div className="text-2xl font-mono font-bold text-red-200 mt-1">{stats.escalated}</div>
          </div>
        </div>
      )}

      {/* Agent meta */}
      {stats?.agentStats && (
        <div className="p-3 rounded-xl glass-card border border-purple-500/20 bg-purple-500/[0.03]">
          <div className="text-xs text-purple-300/90 mb-2">🤖 Агент gen-lifecycle (in-memory)</div>
          <div className="flex flex-wrap gap-3 text-xs">
            <span className="text-white/70">Tracked: <span className="font-mono text-white">{stats.agentStats.totalTracked}</span></span>
            <span className="text-white/70">Recovered: <span className="font-mono text-emerald-300">{stats.agentStats.recovered}</span></span>
            <span className="text-white/70">Escalated: <span className="font-mono text-red-300">{stats.agentStats.escalated}</span></span>
            <span className="text-white/70">Manual retries: <span className="font-mono text-purple-300">{stats.agentStats.manualRetries}</span></span>
            <span className="text-white/70">Manual refunds: <span className="font-mono text-fuchsia-300">{stats.agentStats.manualRefunds}</span></span>
            {stats.agentStats.lastScanAt && (
              <span className="text-white/70">Last scan: <span className="font-mono text-white/90">{relTime(new Date(stats.agentStats.lastScanAt).toISOString())} назад</span></span>
            )}
            {stats.agentStats.lastError && (
              <span className="text-red-300">⚠ {stats.agentStats.lastError}</span>
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {PERIODS.map(p => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              className={`text-xs px-3 py-1 rounded-md transition-colors ${
                period === p.id
                  ? "bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_12px_rgba(124,58,237,0.4)]"
                  : "bg-white/5 hover:bg-white/10 text-white/70"
              }`}
            >{p.label}</button>
          ))}
        </div>
        <div className="flex gap-1 ml-2">
          {TYPES.map(t => (
            <button
              key={t.id || "all"}
              onClick={() => setType(t.id)}
              className={`text-xs px-3 py-1 rounded-md transition-colors ${
                type === t.id
                  ? "bg-cyan-500/30 text-cyan-100 border border-cyan-400/40"
                  : "bg-white/5 hover:bg-white/10 text-white/70"
              }`}
            >{t.label}</button>
          ))}
        </div>
        <div className="flex gap-1 ml-2">
          {STATUSES.map(s => (
            <button
              key={s.id}
              onClick={() => setStatusFilter(s.id)}
              className={`text-xs px-3 py-1 rounded-md transition-colors ${
                statusFilter === s.id
                  ? `bg-white/15 ${s.color} border border-white/20`
                  : "bg-white/5 hover:bg-white/10 text-white/60"
              }`}
            >{s.label}</button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-2xl glass-card border border-white/10 overflow-hidden">
        {err && <div className="p-3 text-xs text-red-300 bg-red-500/10">⚠ {err}</div>}
        {loading && items.length === 0 ? (
          <div className="p-8 text-center text-white/50 text-sm">Загрузка…</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-emerald-300/80 text-sm">
            🎉 Никаких ошибок генерации {period === "today" ? "сегодня" : "в этот период"}!
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-white/60 border-b border-white/10 bg-white/[0.02]">
                <tr>
                  <th className="text-left py-2 pl-3">#ID</th>
                  <th className="text-left py-2">Тип</th>
                  <th className="text-left py-2">Название</th>
                  <th className="text-left py-2">User</th>
                  <th className="text-left py-2">Класс</th>
                  <th className="text-left py-2">Причина</th>
                  <th className="text-right py-2">Попыток</th>
                  <th className="text-right py-2">Стоимость</th>
                  <th className="text-left py-2">Создано</th>
                  <th className="text-left py-2">Статус</th>
                  <th className="text-right py-2 pr-3">Действия</th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => {
                  const cls = errorClassBadge(it.errorClass);
                  const busy = actionBusy === it.id;
                  return (
                    <tr
                      key={it.id}
                      className="border-b border-white/5 hover:bg-white/[0.03] cursor-pointer"
                      onClick={() => openDrawer(it.id)}
                    >
                      <td className="py-2 pl-3 font-mono text-white/90">#{it.id}</td>
                      <td className="py-2 text-white/70">{it.type}</td>
                      <td className="py-2 max-w-[180px] truncate text-white/90" title={it.displayTitle || ""}>
                        {it.displayTitle || "—"}
                      </td>
                      <td className="py-2 font-mono text-white/70">u{it.userId}</td>
                      <td className="py-2">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls.color}`}>{cls.label}</span>
                      </td>
                      <td className="py-2 max-w-[220px] truncate text-white/60" title={it.errorReason || ""}>
                        {it.errorReason || "—"}
                      </td>
                      <td className="py-2 text-right font-mono text-white/80">{it.attemptCount}</td>
                      <td className="py-2 text-right font-mono text-white/80">{fmtKopecks(it.cost)}</td>
                      <td className="py-2 text-white/60">{relTime(it.createdAt)}</td>
                      <td className="py-2">
                        {it.adminResolved && <span className="text-emerald-300 text-[11px]">✔️ resolved</span>}
                        {!it.adminResolved && it.isEscalated && <span className="text-red-300 text-[11px]">🚨 escalated</span>}
                        {!it.adminResolved && !it.isEscalated && it.isRefunded && <span className="text-fuchsia-300 text-[11px]">💰 refunded</span>}
                        {!it.adminResolved && !it.isEscalated && !it.isRefunded && <span className="text-amber-300 text-[11px]">⏳ pending</span>}
                      </td>
                      <td className="py-2 pr-3 text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1 justify-end">
                          {it.canRetry && !it.adminResolved && (
                            <button
                              onClick={() => handleRetry(it.id)}
                              disabled={busy}
                              className="text-[10px] px-2 py-1 rounded bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 border border-purple-400/30 disabled:opacity-50"
                              title="Manual retry — продавить Suno"
                            >🔄 Дожать</button>
                          )}
                          {!it.isRefunded && it.cost > 0 && (
                            <button
                              onClick={() => handleRefund(it.id, it.cost)}
                              disabled={busy}
                              className="text-[10px] px-2 py-1 rounded bg-fuchsia-500/20 hover:bg-fuchsia-500/30 text-fuchsia-200 border border-fuchsia-400/30 disabled:opacity-50"
                              title="Refund баланса"
                            >💰 Refund</button>
                          )}
                          {!it.adminResolved && (
                            <button
                              onClick={() => handleResolve(it.id)}
                              disabled={busy}
                              className="text-[10px] px-2 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border border-emerald-400/30 disabled:opacity-50"
                              title="Mark resolved (без refund)"
                            >✔️ OK</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Drawer — full report */}
      {openReport !== null && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => { setOpenReport(null); setReportData(null); }}
        >
          <div
            className="max-w-3xl w-full max-h-[88dvh] overflow-y-auto rounded-2xl glass-card border border-purple-500/30 bg-gradient-to-br from-[#1a0f2e]/95 via-[#0a0a17]/95 to-[#0f1830]/95 p-5"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-lg font-bold text-white">📋 Отчёт агента — gen #{openReport}</h3>
                {reportData?.generation && (
                  <p className="text-xs text-white/60 mt-1">
                    {reportData.generation.type} · u{reportData.generation.userId} · {fmtKopecks(reportData.generation.cost)} ·{" "}
                    {reportData.generation.displayTitle || "—"}
                  </p>
                )}
              </div>
              <button
                onClick={() => { setOpenReport(null); setReportData(null); }}
                className="text-white/60 hover:text-white text-xl leading-none"
              >✕</button>
            </div>

            {!reportData ? (
              <div className="text-center text-white/50 py-8">Загрузка…</div>
            ) : reportData.events.length === 0 ? (
              <div className="text-center text-white/50 py-8">Нет событий в истории. Возможно, gen создана до запуска агента.</div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 mb-4 text-xs">
                  <span className="px-2 py-1 rounded bg-white/5 text-white/70">Статус: <span className="text-white font-mono">{reportData.status}</span></span>
                  <span className="px-2 py-1 rounded bg-white/5 text-white/70">Попыток: <span className="text-white font-mono">{reportData.attemptCount}</span></span>
                  <span className="px-2 py-1 rounded bg-white/5 text-white/70">Событий: <span className="text-white font-mono">{reportData.events.length}</span></span>
                </div>

                <div className="space-y-2">
                  {reportData.events.map((e, i) => {
                    const b = eventTypeBadge(e.type);
                    return (
                      <div key={i} className="flex items-start gap-3 p-2 rounded-lg bg-white/[0.02] border border-white/5">
                        <div className={`text-lg ${b.cls.split(" ").find(c => c.startsWith("text-")) || ""}`}>{b.emoji}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${b.cls}`}>{b.label}</span>
                            <span className="text-[10px] text-white/40 font-mono">{new Date(e.ts).toLocaleString("ru-RU")}</span>
                          </div>
                          {e.payload && (
                            <pre className="text-[10px] text-white/60 bg-black/40 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                              {JSON.stringify(e.payload, null, 2)}
                            </pre>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 pt-4 border-t border-white/10 flex gap-2 justify-end">
                  <button
                    onClick={() => {
                      const txt = JSON.stringify(reportData, null, 2);
                      navigator.clipboard.writeText(txt).then(() => setToast("📋 Отчёт скопирован"));
                    }}
                    className="text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/80 border border-white/10"
                  >📋 Копировать отчёт</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
