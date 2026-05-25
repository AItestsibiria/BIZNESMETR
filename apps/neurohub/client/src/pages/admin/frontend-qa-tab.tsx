// Eugene 2026-05-25 Босс «Фрон вкладки нет» — выделенная admin-вкладка
// «🚨 Фронт-тестер» (агент Фрон): русский ИТОГ + список багов фронта со
// ссылками + предложенным фиксом + кнопка «Прогнать» (с повторной проходкой).
//
// Источник данных (envelope {data,error}):
//   GET  /api/admin/v304/frontend-qa/report        → последний отчёт
//   POST /api/admin/v304/frontend-qa/scan-cycle     → прогон + повторная проходка + итог
//   POST /api/admin/v304/frontend-qa/scan-now       → одиночный прогон
//   POST /api/admin/v304/frontend-qa/:id/mark {status}
//
// Brand-style: glass-card + brand gradient. Всё по-русски (Фрон-агент rule).

import { useEffect, useState } from "react";

type Severity = "critical" | "high" | "medium" | "low";

interface QaItem {
  id: number | null;
  message: string;
  page: string;
  pageUrl: string;
  count: number;
  severity: Severity;
  status: string;
  fixProposal: string | null;
  firstSeen: number | null;
  lastSeen: number | null;
  source: "client" | "synthetic" | "playwright";
}

interface QaReport {
  generatedAt: string;
  openCount: number;
  criticalCount: number;
  items: QaItem[];
  summaryRu: string;
  rescanned?: boolean;
}

const SEV_LABEL: Record<Severity, string> = {
  critical: "критич",
  high: "важн",
  medium: "средн",
  low: "мелк",
};
const SEV_CLASS: Record<Severity, string> = {
  critical: "bg-red-500/20 text-red-300 border-red-500/40",
  high: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  medium: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
  low: "bg-white/10 text-white/50 border-white/20",
};
const SOURCE_LABEL: Record<string, string> = {
  playwright: "реал-браузер",
  synthetic: "синтетика",
  client: "телеметрия",
};

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

function fmtAgo(ms: number | null): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн назад`;
}

export default function FrontendQaTab() {
  const [report, setReport] = useState<QaReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const d = await fetchJson<QaReport>("/api/admin/v304/frontend-qa/report");
      setReport(d);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, []);

  async function runScan(cycle: boolean) {
    if (scanning) return;
    setScanning(true);
    setToast(cycle ? "Прогон + повторная проходка запущены (до ~3 мин)…" : "Прогон запущен…");
    try {
      const d = await fetchJson<QaReport>(
        `/api/admin/v304/frontend-qa/${cycle ? "scan-cycle" : "scan-now"}`,
        { method: "POST" },
      );
      setReport(d);
      setToast(`Готово: открытых багов ${d.openCount} (критич ${d.criticalCount})`);
    } catch (e: any) {
      setToast(`Ошибка прогона: ${e?.message || e}`);
    } finally {
      setScanning(false);
    }
  }

  async function mark(id: number | null, status: string) {
    if (id == null || busyId === id) return;
    setBusyId(id);
    try {
      await fetchJson(`/api/admin/v304/frontend-qa/${id}/mark`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      setToast(status === "fixed" ? "Отмечено как исправлено ✓" : "Скрыто");
      await load();
    } catch (e: any) {
      setToast(`Ошибка: ${e?.message || e}`);
    } finally {
      setBusyId(null);
    }
  }

  function copySummary() {
    if (!report?.summaryRu) return;
    navigator.clipboard?.writeText(report.summaryRu).then(
      () => setToast("Итог скопирован 📋"),
      () => setToast("Не удалось скопировать"),
    );
  }

  return (
    <div className="space-y-4">
      {/* Заголовок + действия */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-display font-bold gradient-text">🚨 Фронт-тестер (Фрон)</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Баги фронта глазами юзера — реальный браузер по разным устройствам + синтетика + телеметрия. Всё по-русски.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => runScan(true)}
            disabled={scanning}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_16px_rgba(124,58,237,0.4)] disabled:opacity-50"
          >
            {scanning ? "Гоняю…" : "🔁 Прогнать + повторная проходка"}
          </button>
          <button
            onClick={() => runScan(false)}
            disabled={scanning}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 border border-purple-400/20 hover:bg-white/10 text-white/80 disabled:opacity-50"
          >
            Одиночный прогон
          </button>
          <button
            onClick={load}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 border border-white/10 hover:bg-white/10 text-white/70"
          >
            ↻ Обновить
          </button>
        </div>
      </div>

      {/* ИТОГ по-русски */}
      <div className="glass-card rounded-2xl p-4 border border-fuchsia-500/30">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-bold text-white">📋 Итог</span>
          <div className="flex items-center gap-2">
            {report?.rescanned ? (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">повторная проходка</span>
            ) : null}
            <button onClick={copySummary} className="text-[11px] px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-white/60 hover:bg-white/10">📋 Копировать</button>
          </div>
        </div>
        <pre className="text-[13px] text-white/80 whitespace-pre-wrap font-sans leading-relaxed">
          {loading ? "Загружаю…" : err ? `Ошибка: ${err}` : (report?.summaryRu || "Пока нет данных — нажми «Прогнать».")}
        </pre>
        {report ? (
          <div className="flex flex-wrap gap-3 mt-3 text-xs text-white/50">
            <span>Открытых: <b className="text-white/80">{report.openCount}</b></span>
            <span>Критичных: <b className="text-red-300">{report.criticalCount}</b></span>
            <span>Обновлено: {new Date(report.generatedAt).toLocaleString("ru-RU")}</span>
          </div>
        ) : null}
      </div>

      {/* Список багов */}
      <div className="space-y-2">
        {report && report.items.length === 0 && !loading ? (
          <div className="glass-card rounded-xl p-6 text-center text-emerald-300 text-sm">
            Багов нет — фронт чист на всех устройствах. ✅
          </div>
        ) : null}
        {report?.items.map((it, i) => (
          <div key={it.id ?? i} className="glass-card rounded-xl p-3 border border-white/10">
            <div className="flex items-start gap-2">
              <span className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${SEV_CLASS[it.severity]}`}>
                {SEV_LABEL[it.severity]}
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/40 border border-white/10 shrink-0">
                {SOURCE_LABEL[it.source] || it.source}
              </span>
              <span className="text-[10px] text-white/40 shrink-0">×{it.count}</span>
              <span className="text-[10px] text-white/30 ml-auto shrink-0">{fmtAgo(it.lastSeen)}</span>
            </div>
            <div className="text-[13px] text-white/85 mt-1.5 break-words">{it.message}</div>
            <a
              href={it.pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-cyan-300 hover:underline font-mono break-all"
            >
              {it.page}
            </a>
            {it.fixProposal ? (
              <div className="text-[12px] text-fuchsia-200/80 mt-1.5 bg-fuchsia-500/5 rounded-lg px-2 py-1.5 border border-fuchsia-500/15">
                💡 {it.fixProposal}
              </div>
            ) : null}
            {it.id != null ? (
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => mark(it.id, "fixed")}
                  disabled={busyId === it.id}
                  className="text-[11px] px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-50"
                >
                  ✓ Исправлено
                </button>
                <button
                  onClick={() => mark(it.id, "ignored")}
                  disabled={busyId === it.id}
                  className="text-[11px] px-2 py-0.5 rounded-md bg-white/5 text-white/50 border border-white/10 hover:bg-white/10 disabled:opacity-50"
                >
                  Скрыть
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {toast ? (
        <div
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-[#1a0f2e] border border-purple-500/40 text-sm text-white shadow-[0_0_24px_rgba(124,58,237,0.4)] cursor-pointer"
          onClick={() => setToast(null)}
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
