// Eugene 2026-05-17 Босс «Cookies надо собирать и привязывать к профилю
// автора только у админа доступ». Вкладка «👤 Профили» в /admin/v304.
//
// Список user_profiles (visitor cookies + IP geo + identifying):
//  - Фильтры: страна, hasUser (registered/anonymous/all), search (IP/userId)
//  - Click row → expand с deталью: cookieData JSON, devices, sessions
//  - Brand-style: glass-card, font-mono для дат/IP, gradient-text title
//  - Copy-reports-button (см. правило).
//
// API: /api/admin/v304/user-profiles (admin-only, requireAdmin guard).

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { ADMIN_PERIODS, type PeriodId, filterByPeriod, periodLabel } from "@/lib/adminPeriods";

type ProfileRow = {
  id: number;
  userId: number | null;
  visitorId: string;
  cookieData: Record<string, unknown> | null;
  ip: string | null;
  ipCountry: string | null;
  ipCity: string | null;
  ipRegion: string | null;
  ipAsn: string | null;
  userAgent: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  firstSeen: string;
  lastSeen: string;
  visitCount: number;
  isExistingAuthor: number;
  deletedAt: string | null;
  userName: string | null;
  userEmail: string | null;
  userPhone: string | null;
};

type ListResponse = { total: number; items: ProfileRow[] };

function fetcherRaw<T>(url: string): Promise<T> {
  return fetch(url, { credentials: "include" }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.data as T;
  });
}

function fmtDate(s: string): string {
  try {
    return new Date(s).toLocaleString("ru-RU");
  } catch {
    return s;
  }
}

function copyJson(obj: unknown, toast?: (o: { title: string }) => void) {
  try {
    const txt = JSON.stringify(obj, null, 2);
    navigator.clipboard.writeText(txt).then(() => {
      toast?.({ title: "Скопировано" });
    });
  } catch {}
}

export function UserProfilesTab({ toast }: { toast?: any }) {
  const [country, setCountry] = useState<string>("");
  const [hasUser, setHasUser] = useState<"all" | "yes" | "no">("all");
  const [search, setSearch] = useState<string>("");
  const [openId, setOpenId] = useState<number | null>(null);
  // Eugene 2026-05-30: canonical period chips по lastSeen.
  const [period, setPeriod] = useState<PeriodId>("today");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (country) params.set("country", country);
    if (hasUser !== "all") params.set("hasUser", hasUser);
    if (search.trim()) params.set("search", search.trim());
    params.set("limit", "100");
    return params.toString();
  }, [country, hasUser, search]);

  const listQ = useQuery<ListResponse>({
    queryKey: ["admin-user-profiles", query],
    queryFn: () => fetcherRaw<ListResponse>(`/api/admin/v304/user-profiles?${query}`),
    refetchInterval: 60_000,
  });

  const itemsInPeriod = useMemo(
    () => filterByPeriod(listQ.data?.items ?? [], period, (it) => it.lastSeen),
    [listQ.data, period],
  );

  function copyAllProfiles() {
    const lines: string[] = [];
    lines.push(`👤 Профили (last seen ${periodLabel(period)})`);
    lines.push(`🕐 ${new Date().toLocaleString("ru-RU")}`);
    lines.push(`Записей: ${itemsInPeriod.length}`);
    for (const p of itemsInPeriod) {
      lines.push("");
      lines.push(`#${p.id} · visitorId ${p.visitorId.slice(0, 12)}… · ${p.userId ? `user:#${p.userId}` : "анон"}`);
      if (p.userName || p.userEmail || p.userPhone) {
        lines.push(`  👤 ${p.userName || "—"} · ${p.userEmail || "—"} · ${p.userPhone || "—"}`);
      }
      lines.push(`  🌍 ${p.ipCountry || "—"}${p.ipCity ? ` / ${p.ipCity}` : ""}${p.ipRegion ? ` (${p.ipRegion})` : ""} · IP ${p.ip || "—"}${p.ipAsn ? ` · ASN ${p.ipAsn}` : ""}`);
      lines.push(`  🖥 ${p.device || "—"} · ${p.os || "—"} · ${p.browser || "—"}`);
      lines.push(`  Визитов: ${p.visitCount} · первый ${fmtDate(p.firstSeen)} · последний ${fmtDate(p.lastSeen)}`);
    }
    navigator.clipboard?.writeText(lines.join("\n")).then(() => toast?.({ title: "Скопировано", description: `${itemsInPeriod.length} профилей` }));
  }

  return (
    <div className="space-y-4">
      <Card className="glass-card border-purple-500/20">
        <CardHeader>
          <CardTitle className="font-display gradient-text">
            👤 Профили авторов — cookies + IP geo + identifying
          </CardTitle>
          <p className="text-xs font-sans text-muted-foreground mt-1">
            Единый профиль visitor (анонимный) или authed user. Cookies, гео
            по IP, browser/OS, история визитов. Доступ — только админ.
          </p>
        </CardHeader>
        <CardContent>
          {/* === Filters === */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <input
              type="text"
              placeholder="Страна (RU, US, ...)"
              value={country}
              onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 3))}
              className="text-xs font-mono px-3 py-1.5 rounded-md bg-white/5 border border-purple-400/20 text-white focus:outline-none focus:border-purple-400/60 w-32"
            />
            {(["all", "yes", "no"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setHasUser(f)}
                className={`text-xs font-sans px-3 py-1.5 rounded-md transition-colors ${
                  hasUser === f
                    ? "bg-gradient-to-r from-purple-500 to-blue-500 text-white shadow-[0_0_16px_rgba(124,58,237,0.3)]"
                    : "bg-white/5 hover:bg-white/10 text-white/80"
                }`}
              >
                {f === "all" ? "Все" : f === "yes" ? "🔐 Авторы" : "👻 Анонимы"}
              </button>
            ))}
            <input
              type="text"
              placeholder="Поиск IP / userId"
              value={search}
              onChange={(e) => setSearch(e.target.value.slice(0, 100))}
              className="text-xs font-sans px-3 py-1.5 rounded-md bg-white/5 border border-cyan-400/20 text-white focus:outline-none focus:border-cyan-400/60 flex-1 min-w-[160px]"
            />
            <button
              onClick={() => listQ.refetch()}
              className="text-xs font-sans px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/80"
            >
              🔄 Обновить
            </button>
            <button
              onClick={copyAllProfiles}
              className="text-xs font-sans px-3 py-1.5 rounded-md bg-fuchsia-500/15 border border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/25"
            >
              📋 Скопировать ВСЕ
            </button>
            <button
              onClick={() => copyJson(listQ.data, toast)}
              className="text-xs font-sans px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/80"
            >
              📋 JSON
            </button>
          </div>
          {/* Eugene 2026-05-30 canonical period chips (по last seen) */}
          <div className="flex flex-wrap items-center gap-1 mb-3">
            <span className="text-[10px] text-white/50 font-semibold">Last seen:</span>
            {ADMIN_PERIODS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPeriod(p.id)}
                className={`text-[11px] px-2.5 py-1 rounded-md border ${
                  period === p.id
                    ? "bg-purple-500/20 text-purple-200 border-purple-400/50"
                    : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
                }`}
              >{p.label}</button>
            ))}
          </div>

          {/* === Summary === */}
          {listQ.data ? (
            <div className="text-[11px] font-sans text-muted-foreground mb-3">
              Найдено: <span className="text-white font-mono">{listQ.data.total}</span> · Показано:{" "}
              <span className="text-white font-mono">{listQ.data.items.length}</span>
            </div>
          ) : null}

          {/* === Table === */}
          {listQ.isLoading ? (
            <div className="text-xs text-cyan-300 flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Загрузка профилей…
            </div>
          ) : listQ.error ? (
            <div className="text-xs text-rose-300">Ошибка: {String(listQ.error)}</div>
          ) : listQ.data && itemsInPeriod.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] font-sans">
                <thead>
                  <tr className="border-b border-white/10 text-white/60">
                    <th className="text-left py-2 pr-3">User</th>
                    <th className="text-left py-2 pr-3">Visitor</th>
                    <th className="text-left py-2 pr-3">Имя</th>
                    <th className="text-left py-2 pr-3">Гео</th>
                    <th className="text-left py-2 pr-3">IP</th>
                    <th className="text-left py-2 pr-3">Brwsr/OS</th>
                    <th className="text-left py-2 pr-3">Визиты</th>
                    <th className="text-left py-2 pr-3">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {itemsInPeriod.map((p) => {
                    const isOpen = openId === p.id;
                    return (
                      <>
                        <tr
                          key={p.id}
                          onClick={() => setOpenId(isOpen ? null : p.id)}
                          className="border-b border-white/[0.04] hover:bg-purple-500/5 cursor-pointer transition-colors"
                        >
                          <td className="py-1.5 pr-3 font-mono text-purple-300">
                            {p.userId ?? <span className="text-white/40">—</span>}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-white/50 truncate max-w-[80px]" title={p.visitorId}>
                            {p.visitorId.slice(0, 8)}…
                          </td>
                          <td className="py-1.5 pr-3 text-white/90">
                            {p.userName || <span className="text-white/40">—</span>}
                          </td>
                          <td className="py-1.5 pr-3 text-cyan-200">
                            {p.ipCity ? `${p.ipCity}, ` : ""}
                            {p.ipCountry || "—"}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-white/70">{p.ip || "—"}</td>
                          <td className="py-1.5 pr-3 text-white/70">
                            {p.browser || "—"} / {p.os || "—"}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-amber-200">{p.visitCount}</td>
                          <td className="py-1.5 pr-3 font-mono text-white/60">{fmtDate(p.lastSeen)}</td>
                        </tr>
                        {isOpen ? (
                          <tr key={`${p.id}-detail`}>
                            <td colSpan={8} className="bg-white/[0.02] border-b border-purple-500/20">
                              <div className="p-4 space-y-3">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  <div className="p-3 rounded-lg glass-card border border-purple-400/20">
                                    <div className="text-[10px] uppercase font-sans text-white/50 mb-2">
                                      Идентификация
                                    </div>
                                    <div className="space-y-1 text-[11px] font-sans">
                                      <div>
                                        userId: <span className="font-mono text-purple-300">{p.userId ?? "—"}</span>
                                      </div>
                                      <div>
                                        Email:{" "}
                                        <span className="font-mono text-white/80">
                                          {p.userEmail || "—"}
                                        </span>
                                      </div>
                                      <div>
                                        Phone:{" "}
                                        <span className="font-mono text-white/80">
                                          {p.userPhone || "—"}
                                        </span>
                                      </div>
                                      <div>
                                        visitorId:{" "}
                                        <span className="font-mono text-white/50 break-all">{p.visitorId}</span>
                                      </div>
                                      <div>
                                        Автор:{" "}
                                        <span className="text-amber-200">
                                          {p.isExistingAuthor ? "да" : "нет"}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="p-3 rounded-lg glass-card border border-cyan-400/20">
                                    <div className="text-[10px] uppercase font-sans text-white/50 mb-2">
                                      Гео / тех.
                                    </div>
                                    <div className="space-y-1 text-[11px] font-sans">
                                      <div>
                                        IP: <span className="font-mono text-white/80">{p.ip || "—"}</span>
                                      </div>
                                      <div>
                                        Страна:{" "}
                                        <span className="font-mono text-cyan-200">
                                          {p.ipCountry || "—"}
                                        </span>
                                      </div>
                                      <div>
                                        Город:{" "}
                                        <span className="font-mono text-cyan-200">
                                          {p.ipCity || "—"}
                                        </span>
                                      </div>
                                      <div>
                                        Регион:{" "}
                                        <span className="font-mono text-white/70">
                                          {p.ipRegion || "—"}
                                        </span>
                                      </div>
                                      <div>
                                        ASN:{" "}
                                        <span className="font-mono text-white/70">{p.ipAsn || "—"}</span>
                                      </div>
                                      <div>
                                        Device:{" "}
                                        <span className="text-white/80">
                                          {p.device || "—"} · {p.browser || "—"} · {p.os || "—"}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                <div className="p-3 rounded-lg glass-card border border-amber-400/20">
                                  <div className="text-[10px] uppercase font-sans text-white/50 mb-2">
                                    Cookies / UTM / Referrer
                                  </div>
                                  <pre className="text-[10px] font-mono text-white/80 whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
{p.cookieData ? JSON.stringify(p.cookieData, null, 2) : "—"}
                                  </pre>
                                </div>
                                <div className="text-[10px] font-sans text-white/40">
                                  Первый визит:{" "}
                                  <span className="font-mono text-white/60">{fmtDate(p.firstSeen)}</span>
                                  {" · "}Визитов:{" "}
                                  <span className="font-mono text-amber-200">{p.visitCount}</span>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  <button
                                    onClick={() => copyJson(p, toast)}
                                    className="text-[11px] font-sans px-3 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/80"
                                  >
                                    📋 Копировать профиль
                                  </button>
                                  <a
                                    href={`/api/admin/v304/user-profiles/${p.userId ?? ""}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className={`text-[11px] font-sans px-3 py-1 rounded-md transition-colors ${
                                      p.userId
                                        ? "bg-purple-500/20 hover:bg-purple-500/30 text-purple-200"
                                        : "bg-white/5 text-white/40 pointer-events-none"
                                    }`}
                                  >
                                    🔍 JSON автора
                                  </a>
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-xs font-sans text-white/50">Профилей нет.</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default UserProfilesTab;
