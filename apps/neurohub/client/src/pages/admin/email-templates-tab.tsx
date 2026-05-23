// Eugene 2026-05-23 Босс «интерактивный дизайн писем от Музы».
//
// Admin-вкладка «✉️ Письма Музы»:
//   - Список всех templates (welcome, welcome_gift, gift_certificate,
//     track_ready, payment_receipt, password_reset, email_change_confirm)
//   - Preview каждого через iframe sandboxed (рендер HTML с sample context)
//   - Send-test → отправляет на введённый email (с custom context override)
//   - Список log отправлений (last 100) с фильтром по template/status
//   - Stats: total / sent / failed за 7 дней + по templates
//
// Brand-style: glass-card + brand gradient (purple → fuchsia → cyan).

import { useEffect, useState, useMemo } from "react";

interface TemplateMeta {
  name: string;
  label: string;
}

interface LogEntry {
  id: number;
  userId: number | null;
  template: string;
  toEmail: string;
  subject: string;
  status: string;
  error: string | null;
  provider: string | null;
  messageId: string | null;
  sentAt: number;
}

interface Stats {
  total: number;
  sent: number;
  failed: number;
  byTemplate: Array<{ template: string; sent: number; failed: number }>;
}

interface PreviewData {
  subject: string;
  html: string;
  text: string;
  context: Record<string, unknown>;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("token") || "";
  const r = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => "")}`);
  return r.json();
}

function statusBadge(status: string) {
  if (status === "sent") return { label: "🟢 отправлено", cls: "text-emerald-300 bg-emerald-500/10 border-emerald-400/30" };
  if (status === "failed") return { label: "🔴 ошибка", cls: "text-red-300 bg-red-500/10 border-red-400/30" };
  return { label: status, cls: "text-white/50 bg-white/5 border-white/10" };
}

function formatTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

export default function EmailTemplatesTab({ toast }: { toast?: any }) {
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("welcome");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [contextJson, setContextJson] = useState<string>("");

  const [log, setLog] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [logFilterTemplate, setLogFilterTemplate] = useState<string>("");
  const [logFilterStatus, setLogFilterStatus] = useState<string>("");

  const [testEmail, setTestEmail] = useState<string>("");
  const [sending, setSending] = useState(false);

  // Load templates list once
  useEffect(() => {
    api<{ ok: boolean; templates: TemplateMeta[] }>("/api/admin/v304/email-templates")
      .then((r) => {
        if (r.ok) setTemplates(r.templates);
      })
      .catch((e) => console.warn("[email-templates] load failed:", e));
  }, []);

  // Load preview when template changes
  useEffect(() => {
    if (!selectedTemplate) return;
    setPreviewLoading(true);
    const ctxParam = contextJson.trim() ? `?ctx=${encodeURIComponent(contextJson)}` : "";
    api<{ ok: boolean } & PreviewData>(`/api/admin/v304/email-templates/${selectedTemplate}/preview${ctxParam}`)
      .then((r) => {
        if (r.ok) {
          setPreview({ subject: r.subject, html: r.html, text: r.text, context: r.context });
          if (!contextJson.trim()) {
            setContextJson(JSON.stringify(r.context, null, 2));
          }
        }
      })
      .catch((e) => {
        console.warn("[email-preview] failed:", e);
        toast?.({ title: "Ошибка preview", description: String(e?.message || e), variant: "destructive" });
      })
      .finally(() => setPreviewLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplate]);

  // Load log
  const loadLog = () => {
    const params = new URLSearchParams();
    if (logFilterTemplate) params.set("template", logFilterTemplate);
    if (logFilterStatus) params.set("status", logFilterStatus);
    params.set("limit", "100");
    api<{ ok: boolean; log: LogEntry[]; stats: Stats }>(`/api/admin/v304/email-templates/log?${params}`)
      .then((r) => {
        if (r.ok) {
          setLog(r.log);
          setStats(r.stats);
        }
      })
      .catch((e) => console.warn("[email-log] failed:", e));
  };

  useEffect(() => {
    loadLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logFilterTemplate, logFilterStatus]);

  const refreshPreview = () => {
    setPreviewLoading(true);
    const ctxParam = contextJson.trim() ? `?ctx=${encodeURIComponent(contextJson)}` : "";
    api<{ ok: boolean } & PreviewData>(`/api/admin/v304/email-templates/${selectedTemplate}/preview${ctxParam}`)
      .then((r) => {
        if (r.ok) setPreview({ subject: r.subject, html: r.html, text: r.text, context: r.context });
      })
      .catch((e) => toast?.({ title: "Ошибка", description: String(e?.message || e), variant: "destructive" }))
      .finally(() => setPreviewLoading(false));
  };

  const sendTest = async () => {
    if (!testEmail || !testEmail.includes("@")) {
      toast?.({ title: "Введи email", description: "Адрес для тестовой отправки", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      let context: Record<string, unknown> | undefined;
      if (contextJson.trim()) {
        try { context = JSON.parse(contextJson); } catch { /* use sample */ }
      }
      const r = await api<{ ok: boolean; error?: string; provider?: string }>(
        `/api/admin/v304/email-templates/${selectedTemplate}/test`,
        { method: "POST", body: JSON.stringify({ to: testEmail, context }) },
      );
      if (r.ok) {
        toast?.({ title: "✓ Отправлено", description: `Через ${r.provider || "?"} на ${testEmail}` });
        loadLog();
      } else {
        toast?.({ title: "Ошибка отправки", description: r.error || "?", variant: "destructive" });
      }
    } catch (e: any) {
      toast?.({ title: "Ошибка", description: String(e?.message || e), variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const selectedLabel = useMemo(
    () => templates.find((t) => t.name === selectedTemplate)?.label || selectedTemplate,
    [templates, selectedTemplate],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-2xl p-5 bg-gradient-to-br from-purple-500/10 via-fuchsia-500/8 to-cyan-500/10 border border-purple-400/25">
        <h2 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
          ✉️ Письма Музы
        </h2>
        <p className="text-xs text-muted-foreground">
          Интерактивный дизайн email-templates с placeholder подстановкой, auto-attachments,
          логированием каждой отправки. Brand-style: фирменные цвета, gradient logo,
          контакты Музы во footer'е.
        </p>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl p-4 bg-white/5 border border-white/10">
            <div className="text-xs text-white/50 uppercase tracking-wider mb-1">Всего за 7 дней</div>
            <div className="text-2xl font-bold text-white tabular-nums">{stats.total}</div>
          </div>
          <div className="rounded-xl p-4 bg-emerald-500/8 border border-emerald-400/25">
            <div className="text-xs text-emerald-200 uppercase tracking-wider mb-1">Отправлено</div>
            <div className="text-2xl font-bold text-emerald-300 tabular-nums">{stats.sent}</div>
          </div>
          <div className="rounded-xl p-4 bg-red-500/8 border border-red-400/25">
            <div className="text-xs text-red-200 uppercase tracking-wider mb-1">Ошибок</div>
            <div className="text-2xl font-bold text-red-300 tabular-nums">{stats.failed}</div>
          </div>
        </div>
      )}

      {/* Two-pane: list + preview */}
      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        {/* Template list */}
        <div className="space-y-2">
          <div className="text-xs text-white/60 uppercase tracking-wider mb-2 px-1">Шаблоны</div>
          {templates.map((t) => (
            <button
              key={t.name}
              onClick={() => {
                setSelectedTemplate(t.name);
                setContextJson(""); // reset to default sample
              }}
              className={`w-full text-left px-4 py-3 rounded-lg border transition-all ${
                selectedTemplate === t.name
                  ? "bg-gradient-to-r from-purple-500/30 via-fuchsia-500/20 to-cyan-500/20 border-purple-400/50 text-white shadow-[0_0_16px_rgba(124,58,237,0.25)]"
                  : "bg-white/3 border-white/10 text-white/75 hover:bg-white/8 hover:border-white/20"
              }`}
            >
              <div className="text-sm font-medium">{t.label}</div>
              <div className="text-[10px] text-white/40 font-mono mt-0.5">{t.name}</div>
            </button>
          ))}
        </div>

        {/* Preview + controls */}
        <div className="space-y-4">
          {/* Preview */}
          <div className="rounded-2xl border border-purple-400/25 bg-white/3 overflow-hidden">
            <div className="px-4 py-3 border-b border-white/10 bg-gradient-to-r from-purple-500/10 to-fuchsia-500/10">
              <div className="text-xs text-white/50 mb-1">Subject:</div>
              <div className="text-sm font-medium text-white">
                {previewLoading ? "..." : preview?.subject || "—"}
              </div>
            </div>
            <div className="bg-[#0a0a17] min-h-[480px]">
              {previewLoading ? (
                <div className="p-8 text-center text-white/50 text-sm">Загрузка preview...</div>
              ) : preview ? (
                <iframe
                  srcDoc={preview.html}
                  title={`preview-${selectedTemplate}`}
                  sandbox=""
                  className="w-full"
                  style={{ height: 720, border: "none", display: "block" }}
                />
              ) : (
                <div className="p-8 text-center text-white/50 text-sm">Нет preview</div>
              )}
            </div>
          </div>

          {/* Context editor */}
          <div className="rounded-xl p-4 bg-white/3 border border-white/10">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-white/60 uppercase tracking-wider">
                Context (JSON) — sample/override
              </label>
              <button
                onClick={refreshPreview}
                className="text-[10px] px-3 py-1 rounded-md bg-purple-500/20 border border-purple-400/40 text-purple-200 hover:bg-purple-500/30"
              >
                🔄 Обновить preview
              </button>
            </div>
            <textarea
              value={contextJson}
              onChange={(e) => setContextJson(e.target.value)}
              rows={8}
              spellCheck={false}
              className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/15 text-white/85 text-xs font-mono focus:border-purple-400/60 focus:outline-none"
            />
          </div>

          {/* Send test */}
          <div className="rounded-xl p-4 bg-gradient-to-br from-amber-500/8 to-purple-500/8 border border-amber-400/25">
            <div className="text-xs text-amber-200 uppercase tracking-wider mb-2">
              📤 Тестовая отправка: {selectedLabel}
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="test@example.com"
                className="flex-1 px-3 py-2 rounded-lg bg-black/40 border border-white/15 text-white text-sm focus:border-amber-400/60 focus:outline-none"
              />
              <button
                onClick={sendTest}
                disabled={sending || !testEmail.includes("@")}
                className="px-5 py-2 rounded-lg bg-gradient-to-r from-purple-500 via-fuchsia-500 to-cyan-500 text-white font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-[0_0_20px_rgba(217,70,239,0.4)] transition-shadow"
              >
                {sending ? "Отправляю..." : "✉️ Отправить тест"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Log */}
      <div className="rounded-2xl border border-white/10 bg-white/3 overflow-hidden">
        <div className="px-4 py-3 border-b border-white/10 bg-gradient-to-r from-white/3 to-purple-500/8 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
          <div className="text-sm font-medium text-white">📋 Лог отправок (последние 100)</div>
          <div className="flex flex-wrap gap-2 text-xs">
            <select
              value={logFilterTemplate}
              onChange={(e) => setLogFilterTemplate(e.target.value)}
              className="px-2 py-1 rounded bg-black/40 border border-white/15 text-white"
            >
              <option value="">Все шаблоны</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name}>{t.label}</option>
              ))}
            </select>
            <select
              value={logFilterStatus}
              onChange={(e) => setLogFilterStatus(e.target.value)}
              className="px-2 py-1 rounded bg-black/40 border border-white/15 text-white"
            >
              <option value="">Все статусы</option>
              <option value="sent">🟢 Отправлено</option>
              <option value="failed">🔴 Ошибка</option>
            </select>
            <button
              onClick={loadLog}
              className="px-3 py-1 rounded bg-purple-500/20 border border-purple-400/40 text-purple-200 hover:bg-purple-500/30"
            >
              🔄
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          {log.length === 0 ? (
            <div className="p-8 text-center text-white/40 text-sm">Нет записей</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-white/50 text-[10px] uppercase tracking-wider border-b border-white/10">
                  <th className="text-left px-3 py-2">Время</th>
                  <th className="text-left px-3 py-2">Шаблон</th>
                  <th className="text-left px-3 py-2">Кому</th>
                  <th className="text-left px-3 py-2">Тема</th>
                  <th className="text-left px-3 py-2">Статус</th>
                  <th className="text-left px-3 py-2">Провайдер</th>
                </tr>
              </thead>
              <tbody>
                {log.map((entry) => {
                  const badge = statusBadge(entry.status);
                  return (
                    <tr key={entry.id} className="border-b border-white/5 hover:bg-white/3">
                      <td className="px-3 py-2 text-white/60 font-mono whitespace-nowrap">
                        {formatTime(entry.sentAt)}
                      </td>
                      <td className="px-3 py-2 text-white/80 font-mono">{entry.template}</td>
                      <td className="px-3 py-2 text-white/70">{entry.toEmail}</td>
                      <td className="px-3 py-2 text-white/70 max-w-[280px] truncate" title={entry.subject}>
                        {entry.subject}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] border ${badge.cls}`}>
                          {badge.label}
                        </span>
                        {entry.error && (
                          <div className="text-[10px] text-red-300/70 mt-0.5 max-w-[200px] truncate" title={entry.error}>
                            {entry.error}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-white/50 font-mono text-[10px]">{entry.provider || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
