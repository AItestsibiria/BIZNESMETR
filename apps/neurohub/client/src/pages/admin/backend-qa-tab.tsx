// Eugene 2026-05-25 Босс «создай агента "Бэк" — бэкенд-аналог Фрона». Выделенная
// admin-вкладка «🚨 Бэк» (агент Бэк): русский ИТОГ + находки бэкенда (дубли
// маршрутов/функций, лишнее, техдолг) сгруппированы по темам + кнопки
// «Исправлено»/«Скрыть» + кнопка «Прогнать скан».
//
// Источник данных (envelope {data,error}):
//   GET  /api/admin/v304/backend-qa/report      → последний отчёт
//   POST /api/admin/v304/backend-qa/scan-now     → запустить бэкенд-аудит
//   POST /api/admin/v304/backend-qa/:id/mark {status}
//
// КРИТИЧНО: «Исправлено»/«Скрыть» меняют ТОЛЬКО статус находки. Код не правится
// — удаление дублей/мёртвого кода делает разработчик после ревью.
//
// Brand-style: glass-card + brand gradient. Всё по-русски (Бэк-агент rule).

import { useEffect, useState } from "react";

type Severity = "critical" | "high" | "medium" | "low";

interface QaItem {
  id: number | null;
  kind: string;
  theme: string;
  title: string;
  detail: string;
  severity: Severity;
  status: string;
  count: number;
  firstSeen: number | null;
  lastSeen: number | null;
}

interface QaReport {
  generatedAt: string;
  openCount: number;
  bySeverity: Record<Severity, number>;
  themes: Array<{ theme: string; count: number }>;
  items: QaItem[];
  summaryRu: string;
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
const KIND_LABEL: Record<string, string> = {
  "duplicate-endpoint": "дубль маршрута",
  "duplicate-symbol": "дубль функции",
  "possibly-dead-export": "лишнее (мёртвый код)",
  "tech-debt": "техдолг",
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

export default function BackendQaTab() {
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
      const d = await fetchJson<QaReport>("/api/admin/v304/backend-qa/report");
      setReport(d);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  async function runScan() {
    if (scanning) return;
    setScanning(true);
    setToast("Бэкенд-аудит запущен — сканирую код…");
    try {
      const d = await fetchJson<QaReport>("/api/admin/v304/backend-qa/scan-now", { method: "POST" });
      setReport(d);
      setToast(`Готово: открытых находок ${d.openCount} (важных ${d.bySeverity.high}, критич ${d.bySeverity.critical})`);
    } catch (e: any) {
      setToast(`Ошибка скана: ${e?.message || e}`);
    } finally {
      setScanning(false);
    }
  }

  async function mark(id: number | null, status: string) {
    if (id == null || busyId === id) return;
    setBusyId(id);
    try {
      await fetchJson(`/api/admin/v304/backend-qa/${id}/mark`, {
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
          <h2 className="text-xl font-display font-bold gradient-text">🚨 Бэк (бэкенд-аудит)</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Дубли маршрутов/функций, лишнее (мёртвый код), техдолг — сгруппировано по темам. Только детект и предложение, удаление — после ревью.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={runScan}
            disabled={scanning}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_16px_rgba(124,58,237,0.4)] disabled:opacity-50"
          >
            {scanning ? "Сканирую…" : "🔍 Прогнать скан"}
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
          <button onClick={copySummary} className="text-[11px] px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-white/60 hover:bg-white/10">📋 Копировать</button>
        </div>
        <pre className="text-[13px] text-white/80 whitespace-pre-wrap font-sans leading-relaxed">
          {loading ? "Загружаю…" : err ? `Ошибка: ${err}` : (report?.summaryRu || "Пока нет данных — нажми «Прогнать скан».")}
        </pre>
        {report ? (
          <div className="flex flex-wrap gap-3 mt-3 text-xs text-white/50">
            <span>Открытых: <b className="text-white/80">{report.openCount}</b></span>
            <span>Критич: <b className="text-red-300">{report.bySeverity.critical}</b></span>
            <span>Важных: <b className="text-amber-300">{report.bySeverity.high}</b></span>
            <span>Обновлено: {new Date(report.generatedAt).toLocaleString("ru-RU")}</span>
          </div>
        ) : null}
      </div>

      {/* Группировка по темам */}
      {report && report.themes.length ? (
        <div className="glass-card rounded-2xl p-4 border border-purple-500/20">
          <span className="text-sm font-bold text-white">🗂 По темам бэкенда</span>
          <div className="flex flex-wrap gap-2 mt-2">
            {report.themes.map((t) => (
              <span key={t.theme} className="text-[11px] px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-200 border border-purple-500/30 font-mono">
                {t.theme} <b className="text-white/80">{t.count}</b>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* Список находок */}
      <div className="space-y-2">
        {report && report.items.length === 0 && !loading ? (
          <div className="glass-card rounded-xl p-6 text-center text-emerald-300 text-sm">
            Находок нет — бэкенд чист (дублей и мёртвого кода не найдено). ✅
          </div>
        ) : null}
        {report?.items.map((it, i) => (
          <div key={it.id ?? i} className="glass-card rounded-xl p-3 border border-white/10">
            <div className="flex items-start gap-2 flex-wrap">
              <span className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${SEV_CLASS[it.severity]}`}>
                {SEV_LABEL[it.severity]}
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/40 border border-white/10 shrink-0">
                {KIND_LABEL[it.kind] || it.kind}
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-200/70 border border-purple-500/20 shrink-0 font-mono">
                {it.theme}
              </span>
              <span className="text-[10px] text-white/40 shrink-0">×{it.count}</span>
              <span className="text-[10px] text-white/30 ml-auto shrink-0">{fmtAgo(it.lastSeen)}</span>
            </div>
            <div className="text-[13px] text-white/85 mt-1.5 break-words font-medium">{it.title}</div>
            <div className="text-[12px] text-white/55 mt-1 break-words leading-relaxed">{it.detail}</div>
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
