// Eugene 2026-05-17 Босс: вкладка «🗺 Путь юзера» в /admin/v304.
//
// Аналитика user-journey: топ-страницы, exit-pages, conversion funnel,
// карта сессий с timeline. Данные с трёх endpoint'ов:
// - /api/admin/v304/journey-summary
// - /api/admin/v304/journey/sessions
// - /api/admin/v304/journey/:sessionKey
//
// Минимальный UI с фокусом на функциональность — Босс просил «лента
// последних сессий + timeline по клику + filter всё/конверсии/bounces».

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { ADMIN_PERIODS, type PeriodId, filterByPeriod, periodLabel } from "@/lib/adminPeriods";

type JourneySummary = {
  since: string;
  totals: { events: number; sessions: number; avgSessionMs: number };
  topPages: Array<{ page: string; views: number; uniqSessions: number }>;
  exitPages: Array<{ page: string; exits: number }>;
  funnel: { landing: number; register_page: number; form_focus: number; form_abandon: number };
  smart: {
    idleFires: Array<{ page: string; c: number }>;
    formAbandons: Array<{ page: string; c: number }>;
  };
};

type SessionRow = {
  sessionKey: string;
  userId: number | null;
  eventCount: number;
  pageViews: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  entryPage: string;
  exitPage: string;
  idleCount: number;
  abandonCount: number;
  converted: boolean;
  bounced: boolean;
};

type TimelineEvent = {
  id: number;
  eventType: string;
  page: string;
  meta: any;
  userId: number | null;
  createdAt: string;
};

function fmtMs(ms: number): string {
  if (!ms || ms < 1000) return `${Math.round(ms)} мс`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} сек`;
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}м ${ss}с`;
}

function fetcherRaw<T>(url: string): Promise<T> {
  return fetch(url, { credentials: "include" }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.data as T;
  });
}

const EVENT_EMOJI: Record<string, string> = {
  page_view: "📄",
  click: "👆",
  scroll_percent: "📜",
  idle_30s: "💤",
  form_focus: "✍️",
  form_abandon: "🚪",
  leave: "👋",
};

export function JourneyTab({ toast }: { toast?: any }) {
  const [filter, setFilter] = useState<"all" | "converted" | "bounced">("all");
  const [openSession, setOpenSession] = useState<string | null>(null);
  // Eugene 2026-05-30: канонический period selector (client-side фильтр endedAt).
  const [period, setPeriod] = useState<PeriodId>("today");

  const summaryQ = useQuery<JourneySummary>({
    queryKey: ["admin-journey-summary"],
    queryFn: () => fetcherRaw<JourneySummary>("/api/admin/v304/journey-summary"),
    refetchInterval: 60_000,
  });

  const sessionsQ = useQuery<{ count: number; sessions: SessionRow[]; since: string }>({
    queryKey: ["admin-journey-sessions"],
    queryFn: () => fetcherRaw<{ count: number; sessions: SessionRow[]; since: string }>(
      "/api/admin/v304/journey/sessions?limit=50"
    ),
    refetchInterval: 60_000,
  });

  const timelineQ = useQuery<{ sessionKey: string; count: number; events: TimelineEvent[] }>({
    queryKey: ["admin-journey-timeline", openSession],
    queryFn: async () => {
      if (!openSession) return { sessionKey: "", count: 0, events: [] };
      return fetcherRaw<{ sessionKey: string; count: number; events: TimelineEvent[] }>(
        `/api/admin/v304/journey/${encodeURIComponent(openSession)}`
      );
    },
    enabled: !!openSession,
  });

  const filteredSessions = useMemo(() => {
    const all = sessionsQ.data?.sessions || [];
    const byStatus = all.filter((s) => {
      if (filter === "converted") return s.converted;
      if (filter === "bounced") return s.bounced;
      return true;
    });
    return filterByPeriod(byStatus, period, (s) => s.endedAt);
  }, [sessionsQ.data, filter, period]);

  function copyAllReport() {
    const sum = summaryQ.data;
    const lines: string[] = [];
    lines.push(`🗺 Путь юзера — отчёт (${periodLabel(period)})`);
    lines.push(`🕐 ${new Date().toLocaleString("ru-RU")}`);
    if (sum) {
      lines.push("");
      lines.push(`Событий: ${sum.totals.events} · Сессий: ${sum.totals.sessions} · Средняя сессия: ${fmtMs(sum.totals.avgSessionMs)}`);
      lines.push("");
      lines.push(`Воронка: 🏠 ${sum.funnel.landing} → 📱 /register-phone: ${sum.funnel.register_page} → ✍️ focus: ${sum.funnel.form_focus} → 🚪 abandon: ${sum.funnel.form_abandon}`);
      lines.push("");
      lines.push(`Топ-страницы (${sum.topPages.length}):`);
      for (const p of sum.topPages.slice(0, 10)) lines.push(`  ${p.page} — views ${p.views} · uniqSessions ${p.uniqSessions}`);
      lines.push("");
      lines.push(`Куда уходят (${sum.exitPages.length}):`);
      for (const p of sum.exitPages.slice(0, 10)) lines.push(`  ${p.page} — exits ${p.exits}`);
    }
    lines.push("");
    lines.push(`Сессии в окне (${filteredSessions.length}):`);
    for (const s of filteredSessions.slice(0, 100)) {
      const flags = [
        s.userId ? `user:#${s.userId}` : "анон",
        s.converted ? "✅" : null,
        s.bounced ? "💨" : null,
      ].filter(Boolean).join(" ");
      lines.push(`  ${s.sessionKey.slice(0, 12)}… · ${flags} · pv ${s.pageViews} · ev ${s.eventCount} · ${fmtMs(s.durationMs)} · ${s.entryPage} → ${s.exitPage} · ${new Date(s.endedAt).toLocaleString("ru-RU")}`);
    }
    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      if (toast) toast({ title: "Скопировано", description: `${filteredSessions.length} сессий` });
    });
  }

  const summary = summaryQ.data;

  return (
    <div className="space-y-4">
      {/* Eugene 2026-05-30: canonical period chips + копировать ВСЕ */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {ADMIN_PERIODS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium border transition ${
                period === p.id
                  ? "bg-purple-500/20 text-purple-200 border-purple-400/50"
                  : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
              }`}
            >{p.label}</button>
          ))}
        </div>
        <button
          onClick={copyAllReport}
          className="text-[11px] px-2 py-1 rounded-md bg-fuchsia-500/15 border border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/25 ml-auto"
        >📋 Скопировать ВСЕ</button>
      </div>

      {/* === Summary card === */}
      <Card>
        <CardHeader>
          <CardTitle>🗺 Путь юзера — карта от захода до выхода</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Page views, clicks, scrolls, idle, form focus/abandon, leave. Сессии
            сохраняются в браузере (localStorage), живут между визитами. Sensitive
            страницы (/admin/*) не пишутся. Используется для (1) аналитики и
            (2) умных триггеров Музы (появление при долгом думании).
          </p>
        </CardHeader>
        <CardContent>
          {summaryQ.isLoading ? (
            <div className="text-xs text-cyan-300 flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Загрузка summary…
            </div>
          ) : summary ? (
            <div className="space-y-4">
              {/* Totals */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-white/[0.04] border border-white/[0.08]">
                  <div className="text-[10px] uppercase text-muted-foreground">События</div>
                  <div className="text-xl font-bold text-white">{summary.totals.events.toLocaleString("ru-RU")}</div>
                </div>
                <div className="p-3 rounded-lg bg-white/[0.04] border border-white/[0.08]">
                  <div className="text-[10px] uppercase text-muted-foreground">Сессии</div>
                  <div className="text-xl font-bold text-white">{summary.totals.sessions.toLocaleString("ru-RU")}</div>
                </div>
                <div className="p-3 rounded-lg bg-white/[0.04] border border-white/[0.08]">
                  <div className="text-[10px] uppercase text-muted-foreground">Средняя сессия</div>
                  <div className="text-xl font-bold text-white">{fmtMs(summary.totals.avgSessionMs)}</div>
                </div>
                <div className="p-3 rounded-lg bg-white/[0.04] border border-white/[0.08]">
                  <div className="text-[10px] uppercase text-muted-foreground">С</div>
                  <div className="text-[11px] text-white">{new Date(summary.since).toLocaleString("ru-RU")}</div>
                </div>
              </div>

              {/* Funnel */}
              <div className="p-3 rounded-lg bg-gradient-to-br from-purple-500/[0.06] to-blue-500/[0.04] border border-purple-500/20">
                <div className="text-xs text-white/80 font-medium mb-2">Воронка регистрации</div>
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="px-2 py-1 rounded bg-cyan-500/20 text-cyan-200">🏠 Landing: {summary.funnel.landing}</span>
                  <span className="text-white/40">→</span>
                  <span className="px-2 py-1 rounded bg-purple-500/20 text-purple-200">📱 /register-phone: {summary.funnel.register_page}</span>
                  <span className="text-white/40">→</span>
                  <span className="px-2 py-1 rounded bg-emerald-500/20 text-emerald-200">✍️ form_focus: {summary.funnel.form_focus}</span>
                  <span className="text-white/40">→</span>
                  <span className="px-2 py-1 rounded bg-rose-500/20 text-rose-200">🚪 form_abandon: {summary.funnel.form_abandon}</span>
                </div>
              </div>

              {/* Top + Exit pages side by side */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="p-3 rounded-lg bg-white/[0.04] border border-white/[0.08]">
                  <div className="text-xs text-white/80 font-medium mb-2">📈 Топ-страницы (page_view)</div>
                  <div className="space-y-1 text-[11px]">
                    {summary.topPages.slice(0, 10).map((p) => (
                      <div key={p.page} className="flex items-center gap-2">
                        <span className="text-cyan-300 font-mono truncate flex-1">{p.page}</span>
                        <span className="text-white/60">{p.views}</span>
                        <span className="text-white/40">({p.uniqSessions})</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-white/[0.04] border border-white/[0.08]">
                  <div className="text-xs text-white/80 font-medium mb-2">🚪 Куда уходят (exit-pages)</div>
                  <div className="space-y-1 text-[11px]">
                    {summary.exitPages.slice(0, 10).map((p) => (
                      <div key={p.page} className="flex items-center gap-2">
                        <span className="text-rose-300 font-mono truncate flex-1">{p.page}</span>
                        <span className="text-white/60">{p.exits}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Smart triggers stats */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="p-3 rounded-lg bg-white/[0.04] border border-amber-500/20">
                  <div className="text-xs text-white/80 font-medium mb-2">💤 idle_30s — где юзер залипает</div>
                  <div className="space-y-1 text-[11px]">
                    {summary.smart.idleFires.length === 0 ? (
                      <div className="text-white/50">Пока никто не залипал</div>
                    ) : summary.smart.idleFires.map((p) => (
                      <div key={p.page} className="flex items-center gap-2">
                        <span className="text-amber-200 font-mono truncate flex-1">{p.page}</span>
                        <span className="text-white/60">{p.c}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-white/[0.04] border border-rose-500/20">
                  <div className="text-xs text-white/80 font-medium mb-2">🚪 form_abandon — кто бросает форму</div>
                  <div className="space-y-1 text-[11px]">
                    {summary.smart.formAbandons.length === 0 ? (
                      <div className="text-white/50">Никто не бросает</div>
                    ) : summary.smart.formAbandons.map((p) => (
                      <div key={p.page} className="flex items-center gap-2">
                        <span className="text-rose-200 font-mono truncate flex-1">{p.page}</span>
                        <span className="text-white/60">{p.c}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Copy report button */}
              <button
                onClick={() => {
                  const txt = JSON.stringify(summary, null, 2);
                  navigator.clipboard.writeText(txt).then(() => {
                    if (toast) toast({ title: "Summary скопирован" });
                  });
                }}
                className="text-xs px-3 py-1 rounded-md bg-white/5 hover:bg-white/10"
              >📋 Копировать summary</button>
            </div>
          ) : (
            <div className="text-xs text-rose-300">Не удалось загрузить summary</div>
          )}
        </CardContent>
      </Card>

      {/* === Sessions list === */}
      <Card>
        <CardHeader>
          <CardTitle>Последние 50 сессий — за 7 дней</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">Клик на сессию → timeline всех событий</p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {(["all", "converted", "bounced"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-xs px-3 py-1 rounded-md transition-colors ${
                  filter === f ? "bg-primary text-primary-foreground" : "bg-white/5 hover:bg-white/10"
                }`}
              >
                {f === "all" ? "Все" : f === "converted" ? "✅ Конверсии" : "💨 Bounces"}
              </button>
            ))}
            <button
              onClick={() => sessionsQ.refetch()}
              className="text-xs px-3 py-1 rounded-md bg-white/5 hover:bg-white/10 ml-auto"
            >🔄 Обновить</button>
          </div>

          {sessionsQ.isLoading ? (
            <div className="text-xs text-cyan-300 flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Загрузка сессий…
            </div>
          ) : (
            <div className="space-y-2">
              {filteredSessions.length === 0 && (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  Сессий не найдено
                </div>
              )}
              {filteredSessions.map((s) => (
                <button
                  key={s.sessionKey}
                  onClick={() => setOpenSession(s.sessionKey)}
                  className="w-full text-left p-3 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.06] hover:border-purple-400/40 transition-colors"
                  data-track="journey-session-open"
                >
                  <div className="flex items-center gap-2 flex-wrap text-[11px]">
                    <span className="font-mono text-white/60 truncate max-w-[140px]" title={s.sessionKey}>
                      {s.sessionKey.slice(0, 12)}…
                    </span>
                    {s.userId && (
                      <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-200">user #{s.userId}</span>
                    )}
                    {s.converted && (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200">✅ converted</span>
                    )}
                    {s.bounced && (
                      <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-200">💨 bounce</span>
                    )}
                    {s.idleCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200">💤 {s.idleCount}</span>
                    )}
                    {s.abandonCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-200">🚪 {s.abandonCount}</span>
                    )}
                    <span className="text-white/40 ml-auto">{new Date(s.endedAt).toLocaleString("ru-RU")}</span>
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-[11px] text-white/70">
                    <span>📄 {s.pageViews} pv</span>
                    <span>· {s.eventCount} events</span>
                    <span>· {fmtMs(s.durationMs)}</span>
                    <span>· {s.entryPage} → {s.exitPage}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* === Timeline modal-card === */}
      {openSession && (
        <Card className="border-purple-500/40">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm">
                🕒 Timeline · <span className="font-mono text-xs text-purple-300">{openSession.slice(0, 16)}…</span>
              </CardTitle>
              <button
                onClick={() => setOpenSession(null)}
                className="text-xs px-2 py-1 rounded bg-white/5 hover:bg-white/10"
              >✕ Закрыть</button>
            </div>
          </CardHeader>
          <CardContent>
            {timelineQ.isLoading ? (
              <div className="text-xs text-cyan-300 flex items-center gap-2">
                <Loader2 className="w-3 h-3 animate-spin" /> Загрузка timeline…
              </div>
            ) : (
              <div className="space-y-1 max-h-[60dvh] overflow-y-auto">
                {(timelineQ.data?.events || []).map((e, idx, arr) => {
                  const prev = idx > 0 ? arr[idx - 1] : null;
                  const deltaMs = prev ? new Date(e.createdAt).getTime() - new Date(prev.createdAt).getTime() : 0;
                  return (
                    <div key={e.id} className="flex items-start gap-2 text-[11px] py-1 border-b border-white/[0.04]">
                      <span className="text-base shrink-0">{EVENT_EMOJI[e.eventType] || "•"}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-white font-medium">{e.eventType}</span>
                          <span className="text-cyan-300 font-mono">{e.page}</span>
                          {deltaMs > 0 && (
                            <span className="text-white/40 text-[10px]">+{fmtMs(deltaMs)}</span>
                          )}
                          <span className="text-white/40 text-[10px] ml-auto">{new Date(e.createdAt).toLocaleTimeString("ru-RU")}</span>
                        </div>
                        {e.meta && (
                          <div className="text-[10px] text-white/60 mt-0.5 font-mono">
                            {JSON.stringify(e.meta)}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {timelineQ.data?.count === 0 && (
                  <div className="text-center py-6 text-muted-foreground text-sm">Событий не найдено</div>
                )}
              </div>
            )}
            <div className="mt-3">
              <button
                onClick={() => {
                  const txt = JSON.stringify(timelineQ.data || {}, null, 2);
                  navigator.clipboard.writeText(txt).then(() => {
                    if (toast) toast({ title: "Timeline скопирован" });
                  });
                }}
                className="text-xs px-3 py-1 rounded-md bg-white/5 hover:bg-white/10"
              >📋 Копировать timeline</button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
