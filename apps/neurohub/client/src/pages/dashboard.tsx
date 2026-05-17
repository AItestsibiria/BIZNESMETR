import { registerAudio, pauseAllExcept } from "../lib/audio-bus";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { Generation, Transaction } from "@shared/schema";
import {
  LayoutDashboard, Plus, PenLine, Music, ImageIcon, CreditCard,
  ArrowUpRight, ArrowDownLeft, Clock, CheckCircle2, XCircle, Loader2, Download, Globe, Lock, RotateCcw,
  Share2, Users, Copy, TrendingUp, Eye, BarChart3, Pencil, ExternalLink, Trash2, ArchiveRestore,
  Play, Pause, SkipForward, SkipBack, RefreshCcw, ChevronDown, Repeat, Repeat1, Ticket, FastForward,
  AlertCircle, Wallet, Mic, Home, Maximize,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import GiftBadge from "@/components/gift-badge";
import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { KaraokeLyrics } from "@/components/karaoke-lyrics";
import { ExpandToggleButton } from "@/components/expand-toggle-button";
import { CoverDetailsModal } from "@/components/cover-details-modal";
import { VolumeSlider } from "@/components/volume-slider";
import { setLockScreenTrack, setLockScreenPlaybackState } from "@/lib/lockscreen";
import { muteBgMusic, unmuteBgMusic } from "@/components/background-music";

const typeIcons: Record<string, typeof PenLine> = {
  lyrics: PenLine,
  music: Music,
  cover: ImageIcon,
};

const typeLabels: Record<string, string> = {
  lyrics: "Текст",
  music: "Музыка",
  cover: "Обложка",
};

const statusConfig: Record<string, { label: string; icon: typeof Clock; color: string }> = {
  pending: { label: "Ожидание", icon: Clock, color: "text-yellow-400" },
  processing: { label: "Генерация", icon: Loader2, color: "text-blue-400" },
  done: { label: "Трек создан", icon: CheckCircle2, color: "text-green-400" },
  error: { label: "Ошибка", icon: XCircle, color: "text-red-400" },
};

// Eugene 2026-05-15 Босс: helper для confirm-modal смены стиля.
function labelForCategory(cat: string): string {
  switch (cat) {
    case "song": return "🎵 Песня";
    case "greeting": return "🎉 Поздравление";
    case "instrumental": return "🎶 Инструментальная";
    default: return cat;
  }
}

// Eugene 2026-05-15 Босс «фикс для объединения у кого ранее была почта».
// Banner на /dashboard для phone-only юзеров. Кликает «Связать» — открывает
// модалку с email/password → POST /api/auth/link-existing.
function LinkExistingBanner({ userId, userPhone, onDone }: { userId: number; userPhone?: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const { loginByToken } = useAuth();
  const [, navigate] = useLocation();

  const handleLink = async () => {
    setError(null);
    if (!email || !password) { setError("Заполните email и пароль"); return; }
    setLoading(true);
    try {
      const r = await apiRequest("POST", "/api/auth/link-existing", { email: email.trim(), password });
      const j = await r.json();
      if (j?.ok && j?.token) {
        await loginByToken(j.token, true);
        toast({ title: "✅ Аккаунты объединены", description: "Телефон привязан к email-аккаунту" });
        setOpen(false);
        navigate("/dashboard");
        onDone();
      } else {
        setError(j?.message || "Не удалось связать");
      }
    } catch (e: any) {
      setError(String(e?.message || "Ошибка"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="mb-4 p-3 rounded-xl border border-purple-400/30 bg-gradient-to-r from-purple-500/10 via-violet-500/8 to-blue-500/10 flex items-center gap-3">
        <div className="text-2xl">🔗</div>
        <div className="flex-1 text-sm">
          <p className="text-white font-medium">Был аккаунт по email?</p>
          <p className="text-xs text-muted-foreground mt-0.5">Свяжите его с этим телефоном — все ваши треки переедут сюда.</p>
        </div>
        <Button size="sm" className="btn-gradient" onClick={() => setOpen(true)}>Связать</Button>
        <button
          onClick={() => {
            try { localStorage.setItem(`linkBannerDismissed:${userId}`, "1"); } catch {}
            onDone();
          }}
          className="text-muted-foreground hover:text-white text-lg px-1"
          aria-label="Скрыть"
        >×</button>
      </div>

      <Dialog open={open} onOpenChange={(o) => { if (!o && !loading) setOpen(false); }}>
        <DialogContent className="glass-card border-purple-500/30 max-w-md">
          <DialogHeader>
            <DialogTitle className="gradient-text text-base flex items-center gap-2">
              🔗 Связать с email-аккаунтом
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground pt-2">
              Телефон <span className="text-white font-medium">{userPhone || ""}</span> привяжется к указанному email-аккаунту. Все треки phone-аккаунта переедут туда.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Email от существующего аккаунта</Label>
              <Input type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} className="bg-background/50 border-white/10" disabled={loading} autoComplete="email" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Пароль</Label>
              <Input type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} className="bg-background/50 border-white/10" disabled={loading} autoComplete="current-password" />
            </div>
            {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1 border-white/10" disabled={loading} onClick={() => setOpen(false)}>Отмена</Button>
              <Button className="flex-1 btn-gradient" disabled={loading || !email || !password} onClick={handleLink}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Связать"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TopGenStats() {
  const [genStats, setGenStats] = useState<any>(null);
  const [statPeriod, setStatPeriod] = useState('day');
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'activity' | 'downloads'>('activity');
  const [topDownloads, setTopDownloads] = useState<any>(null);
  useEffect(() => { apiRequest('GET', `/api/admin/gen-stats?period=${statPeriod}`).then(r => r.json()).then(setGenStats).catch(() => {}); }, [statPeriod]);
  useEffect(() => { if (activeTab === 'downloads') apiRequest('GET', `/api/admin/top-downloads?period=${statPeriod}`).then(r => r.json()).then(setTopDownloads).catch(() => {}); }, [activeTab, statPeriod]);
  useEffect(() => { if (detailId) apiRequest('GET', `/api/admin/gen-stats/${detailId}`).then(r => r.json()).then(setDetail).catch(() => {}); else setDetail(null); }, [detailId]);
  if (!genStats) return null;
  return (
    <div className="mt-3 glass-card rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-2">
          <button onClick={() => setActiveTab('activity')} className={`text-xs font-semibold px-2 py-1 rounded transition-colors ${activeTab === 'activity' ? 'bg-purple-500/20 text-purple-300' : 'text-muted-foreground hover:text-white'}`}>
            📊 Топ-10
          </button>
          <button onClick={() => setActiveTab('downloads')} className={`text-xs font-semibold px-2 py-1 rounded transition-colors ${activeTab === 'downloads' ? 'bg-blue-500/20 text-blue-300' : 'text-muted-foreground hover:text-white'}`}>
            ⬇ Топ-20 скачиваний
          </button>
        </div>
        <div className="flex gap-1">
          {(['yesterday','day','week','month','year','all'] as const).map(p => (
            <button key={p} onClick={() => setStatPeriod(p)} className={`text-[10px] px-2 py-0.5 rounded ${statPeriod === p ? 'bg-purple-500/20 text-purple-300' : 'text-muted-foreground hover:text-white'}`}>
              {p === 'yesterday' ? 'Вчера' : p === 'day' ? 'Сегодня' : p === 'week' ? 'Нед.' : p === 'month' ? 'Мес.' : p === 'year' ? 'Год' : 'Всё'}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'activity' && (
        <>
          {genStats.totals && <div className="flex gap-3 mb-3 text-[11px]"><span>▶{genStats.totals.plays||0}</span><span>⬇{genStats.totals.downloads||0}</span><span>📋{genStats.totals.copies||0}</span><span>↗{genStats.totals.shares||0}</span></div>}
          <div className="space-y-1">
            {genStats.top?.map((t: any, i: number) => (
              <div key={t.gen_id} className="flex items-center gap-2 py-1 text-[11px] cursor-pointer hover:bg-white/5 rounded px-1" onClick={() => setDetailId(detailId === t.gen_id ? null : t.gen_id)}>
                <span className="text-muted-foreground w-4">{i+1}</span>
                <span className="truncate flex-1 text-white">{t.display_title || (t.prompt||'').slice(0,30)}</span>
                <span className="text-muted-foreground text-[10px]">{t.type}</span>
                <span className="text-green-400 font-mono">▶{t.plays}</span>
                <span className="text-blue-400 font-mono">⬇{t.downloads}</span>
                <span className="text-purple-400 font-mono">↗{t.shares}</span>
              </div>
            ))}
          </div>
          {detail && (
            <div className="mt-2 p-2 rounded-lg bg-white/[0.03] border border-white/[0.06] text-[11px]">
              <p className="text-muted-foreground mb-1">Детали #{detailId}</p>
              <div className="flex gap-3 mb-2">{detail.byAction?.map((a: any) => <span key={a.action}>{a.action}: <span className="text-white font-medium">{a.c}</span></span>)}</div>
              {detail.byDay?.length > 0 && <div className="max-h-[100px] overflow-y-auto space-y-0.5">{detail.byDay.map((d: any, i: number) => <span key={i} className="block text-muted-foreground/70">{d.d} {d.action}: {d.c}</span>)}</div>}
            </div>
          )}
        </>
      )}

      {activeTab === 'downloads' && (
        <>
          {topDownloads && (
            <p className="text-[11px] text-muted-foreground mb-3">Всего скачиваний: <span className="text-blue-400 font-medium">{topDownloads.totalDownloads}</span></p>
          )}
          <div className="space-y-1">
            {topDownloads?.rows?.map((t: any, i: number) => (
              <div key={t.gen_id} className="flex items-center gap-2 py-1.5 text-[11px] hover:bg-white/5 rounded px-1">
                <span className="text-muted-foreground w-5 text-right">{i+1}.</span>
                <span className="truncate flex-1 text-white">{t.display_title || (t.prompt||'').slice(0,40)}</span>
                <span className="text-muted-foreground text-[10px]">{t.author_name}</span>
                <span className="text-blue-400 font-mono font-medium">⬇{t.downloads}</span>
              </div>
            ))}
            {topDownloads?.rows?.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">Нет скачиваний</p>}
          </div>
        </>
      )}
    </div>
  );
}

// Admin-only: попап с фильтром по периоду и списком прослушиваний с городами/IP
function GeoActivityDialog({ genId, open, onClose, title }: { genId: number | null; open: boolean; onClose: () => void; title: string }) {
  const [period, setPeriod] = useState<"yesterday" | "today" | "week" | "month" | "all">("week");
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAllIps, setShowAllIps] = useState(false);
  useEffect(() => {
    if (!genId || !open) return;
    setLoading(true);
    setShowAllIps(false);
    fetch(`/api/admin/gen-activity-geo/${genId}?period=${period}&_=${Date.now()}`, { credentials: "include", cache: "no-store" })
      .then(r => r.json())
      .then(j => { setData(j); setLoading(false); })
      .catch(() => { setData(null); setLoading(false); });
  }, [genId, open, period]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="dialog-geo-activity">
        <DialogHeader>
          <DialogTitle className="text-base">Прослушивания и география</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground line-clamp-1">{title}</DialogDescription>
        </DialogHeader>

        {/* Фильтр периода */}
        <div className="flex gap-1 mt-2">
          {[
            { v: "yesterday", label: "Вчера" },
            { v: "today", label: "Сегодня" },
            { v: "week",  label: "Неделя" },
            { v: "month", label: "Месяц" },
            { v: "all",   label: "Всё время" },
          ].map(p => (
            <button
              key={p.v}
              onClick={() => setPeriod(p.v as any)}
              className={`flex-1 text-xs py-1.5 rounded-lg transition-colors ${period === p.v ? "bg-primary text-primary-foreground font-medium" : "bg-white/5 hover:bg-white/10 text-muted-foreground"}`}
              data-testid={`btn-period-${p.v}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-center py-8 text-sm text-muted-foreground">Загрузка…</div>
        ) : !data ? (
          <div className="text-center py-8 text-sm text-muted-foreground">Нет данных</div>
        ) : (
          <div className="space-y-3 mt-3 max-h-[60vh] overflow-y-auto">
            {/* Итог */}
            <div className="flex items-center justify-between p-2 rounded-lg bg-white/5">
              <span className="text-xs text-muted-foreground">Всего прослушиваний</span>
              <span className="text-lg font-semibold tabular-nums">{data.total}</span>
            </div>

            {/* Список стран */}
            {data.byCountry && data.byCountry.length > 0 && (
              <div>
                <h4 className="text-[11px] uppercase text-muted-foreground mb-1">Страны</h4>
                <div className="space-y-0.5">
                  {data.byCountry.slice(0, 8).map((c: any, i: number) => (
                    <div key={i} className="flex items-center justify-between px-2 py-1 rounded bg-white/5 text-xs">
                      <span>{c.name}</span>
                      <span className="tabular-nums text-muted-foreground">{c.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Список городов */}
            {data.byCity && data.byCity.length > 0 && (
              <div>
                <h4 className="text-[11px] uppercase text-muted-foreground mb-1">Города</h4>
                <div className="space-y-0.5">
                  {data.byCity.slice(0, 12).map((c: any, i: number) => (
                    <div key={i} className="flex items-center justify-between px-2 py-1 rounded bg-white/5 text-xs">
                      <span className="truncate">{c.name}</span>
                      <span className="tabular-nums text-muted-foreground ml-2">{c.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Подменю: IP-адреса */}
            <div>
              <button
                onClick={() => setShowAllIps(v => !v)}
                className="w-full text-left text-[11px] uppercase text-muted-foreground hover:text-foreground transition-colors"
                data-testid="btn-toggle-ips"
              >
                {showAllIps ? "▼" : "▶"} Подробно: IP-адреса ({data.events?.length || 0})
              </button>
              {showAllIps && data.events && (
                <div className="mt-1 space-y-0.5 max-h-64 overflow-y-auto">
                  {data.events.slice(0, 200).map((e: any) => (
                    <div key={e.id} className="flex items-center justify-between px-2 py-1 rounded bg-white/5 text-[11px] gap-2">
                      <span className="font-mono tabular-nums">{e.ip || "—"}</span>
                      <span className="truncate flex-1 text-muted-foreground">
                        {e.city ? `${e.city}, ${e.country || ""}`.replace(/, $/, "") : (e.country || "—")}
                      </span>
                      <span className="text-muted-foreground/70 whitespace-nowrap">
                        {new Date(e.createdAt + "Z").toLocaleString("ru", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PendingPublications() {
  const [pending, setPending] = useState<any[]>([]);
  const [feedback, setFeedback] = useState<Record<number, string>>({});
  const [sending, setSending] = useState<number | null>(null);
  const { toast } = useToast();
  useEffect(() => {
    apiRequest('GET', '/api/admin/pending-publications').then(r => r.json()).then(setPending).catch(() => {});
  }, []);
  if (!pending.length) return null;

  const handleModerate = async (id: number, action: 'approve' | 'reject') => {
    try {
      await apiRequest('POST', `/api/admin/moderate/${id}`, { action });
      setPending(prev => prev.filter(p => p.id !== id));
      toast({ title: action === 'approve' ? 'Опубликовано' : 'Отклонено' });
    } catch { toast({ title: 'Ошибка', variant: 'destructive' }); }
  };

  const handleSendFeedback = async (p: any) => {
    const text = feedback[p.id]?.trim();
    if (!text) return;
    setSending(p.id);
    try {
      await apiRequest('POST', `/api/admin/moderate/${p.id}`, { action: 'feedback', message: text });
      setFeedback(prev => ({ ...prev, [p.id]: '' }));
      toast({ title: 'Рекомендация отправлена автору' });
    } catch { toast({ title: 'Ошибка отправки', variant: 'destructive' }); }
    setSending(null);
  };

  return (
    <div className="glass-card rounded-xl p-4 border border-yellow-500/20">
      <p className="text-sm font-semibold text-yellow-400 mb-4">⏳ Запросы на публикацию ({pending.length})</p>
      <div className="space-y-4">
        {pending.map((p: any) => (
          <div key={p.id} className="rounded-xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
            {/* Header */}
            <div className="p-3 flex items-start gap-3">
              {/* Cover thumbnail */}
              {p.type === 'music' && (
                <img src={`/api/cover/${p.id}.jpg?size=96`} alt="" className="w-14 h-14 rounded-lg object-cover flex-shrink-0" />
              )}
              {p.type === 'cover' && (
                <img src={`/api/stream/${p.id}`} alt="" className="w-14 h-14 rounded-lg object-cover flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{p.display_title || (p.prompt || '').slice(0, 50)}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{p.author_name || p.user_name} · {p.type} · #{p.id}</p>
                {p.user_email && <p className="text-[10px] text-muted-foreground/60">{p.user_email}</p>}
              </div>
            </div>
            {/* Audio player for music */}
            {p.type === 'music' && (
              <div className="px-3 pb-2">
                <audio src={`/api/stream/${p.id}`} controls className="w-full h-8" style={{ filter: 'invert(1) hue-rotate(180deg)', opacity: 0.7 }} />
              </div>
            )}
            {/* Full prompt */}
            {p.prompt && p.prompt.length > 50 && (
              <div className="px-3 pb-2">
                <p className="text-[11px] text-muted-foreground/70 max-h-16 overflow-y-auto leading-relaxed">{p.prompt}</p>
              </div>
            )}
            {/* Feedback input */}
            <div className="px-3 pb-2">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  placeholder="Рекомендация автору..."
                  value={feedback[p.id] || ''}
                  onChange={e => setFeedback(prev => ({ ...prev, [p.id]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') handleSendFeedback(p); }}
                  className="flex-1 h-7 px-2 text-xs rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-white/20 focus:outline-none focus:border-yellow-500/30"
                />
                <button
                  disabled={!feedback[p.id]?.trim() || sending === p.id}
                  onClick={() => handleSendFeedback(p)}
                  className="px-2 h-7 text-[10px] font-medium rounded-lg bg-yellow-600/80 text-white hover:bg-yellow-500 transition-colors disabled:opacity-30"
                >Отправить</button>
              </div>
            </div>
            {/* Action buttons */}
            <div className="flex border-t border-white/[0.06]">
              <button
                onClick={() => handleModerate(p.id, 'approve')}
                className="flex-1 py-2.5 text-xs font-medium text-green-400 hover:bg-green-500/10 transition-colors flex items-center justify-center gap-1.5"
              ><CheckCircle2 className="w-3.5 h-3.5" /> Одобрить</button>
              <div className="w-px bg-white/[0.06]" />
              <button
                onClick={() => handleModerate(p.id, 'reject')}
                className="flex-1 py-2.5 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors flex items-center justify-center gap-1.5"
              ><XCircle className="w-3.5 h-3.5" /> Отклонить</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminStats() {
  const [stats, setStats] = useState<any>(null);
  const [showAuthors, setShowAuthors] = useState(false);
  const [showVisitors, setShowVisitors] = useState(false);
  const [visitorStats, setVisitorStats] = useState<any>(null);
  const [visitorList, setVisitorList] = useState<any[]>([]);

  // Период для фильтра посетителей
  // Eugene 2026-05-08 «по умолчанию за день»
  const [visitorPeriod, setVisitorPeriod] = useState<"yesterday" | "today" | "week" | "month" | "all">("today");
  const [showAllIps, setShowAllIps] = useState(false);
  useEffect(() => {
    if (showVisitors) {
      setVisitorStats(null);
      apiRequest("GET", `/api/admin/visitor-stats?period=${visitorPeriod}`).then(r => r.json()).then(setVisitorStats).catch(() => {});
      apiRequest("GET", "/api/admin/visitors?page=1").then(r => r.json()).then(d => setVisitorList(d.visitors || [])).catch(() => {});
      setShowAllIps(false);
    }
  }, [showVisitors, visitorPeriod]);
  const [viewingUser, setViewingUser] = useState<any>(null);
  const [viewingGens, setViewingGens] = useState<any[]>([]);
  const [gptBalance, setGptBalance] = useState<{ available: boolean; balance?: number; currency?: string; reason?: string; suno?: { estimatedTracks: number; pricePerTrack: number } } | null>(null);
  const [yandexUsage, setYandexUsage] = useState<{ totalMinutes: number; estimatedSpentRub: number; total: number; configured: boolean } | null>(null);

  useEffect(() => {
    apiRequest("GET", "/api/admin/stats").then(r => r.json()).then(setStats).catch(() => {});
    // Подтягиваем баланс GPTunnel + usage Yandex (Eugene 13:38).
    const fetchBalance = () => {
      apiRequest("GET", "/api/admin/v304/gptunnel-balance").then(r => r.json()).then(j => setGptBalance(j.data)).catch(() => {});
      apiRequest("GET", "/api/admin/v304/yandex/status").then(r => r.json()).then(j => {
        const u = j.data?.usage;
        const stt = j.data?.services?.speechkit_stt;
        if (u) setYandexUsage({
          totalMinutes: u.totalMinutes || 0,
          estimatedSpentRub: u.estimatedSpentRub || 0,
          total: u.total || 0,
          configured: !!stt?.configured,
        });
      }).catch(() => {});
    };
    fetchBalance();
    const t = setInterval(fetchBalance, 60_000);
    return () => clearInterval(t);
  }, []);

  if (!stats) return <Skeleton className="h-24 mb-8" />;

  const balLow = gptBalance?.available && gptBalance.balance != null && gptBalance.balance < 750;
  const cards = [
    { icon: Users, label: "Авторы", value: stats.authors.total, sub: `+${stats.authors.today} сегодня, +${stats.authors.thisWeek} за неделю`, color: "text-purple-400", onClick: () => setShowAuthors(!showAuthors) },
    { icon: Eye, label: "Посетители", value: stats.visitors.today, sub: `${stats.visitors.total} всего IP`, color: "text-blue-400", onClick: () => setShowVisitors(!showVisitors) },
    { icon: Music, label: "Генерации", value: stats.generations.total, sub: `+${stats.generations.today} сегодня`, color: "text-green-400" },
    { icon: TrendingUp, label: "Выручка", value: `${stats.revenue} ₽`, sub: "оплаченные заказы", color: "text-yellow-400" },
    {
      icon: Wallet,
      label: "GPTunnel баланс",
      value: gptBalance?.available
        ? `${(gptBalance.balance ?? 0).toLocaleString("ru-RU")} ${gptBalance.currency ?? "₽"}`
        : "—",
      sub: gptBalance?.available
        ? (gptBalance.suno?.estimatedTracks != null
            ? `🎵 MuzaAi ≈ ${gptBalance.suno.estimatedTracks.toLocaleString("ru-RU")} треков (пары по 2 за запрос)${balLow ? " · ⚠ ниже 750" : ""}`
            : (balLow ? "⚠ ниже 750 — пополни" : "лимит ОК"))
        : (gptBalance?.reason ?? "недоступен"),
      color: !gptBalance?.available ? "text-rose-400" : balLow ? "text-amber-400" : "text-emerald-400",
    },
    {
      icon: Mic,
      label: "Яндекс STT",
      value: yandexUsage?.configured
        ? `${yandexUsage.estimatedSpentRub.toFixed(2)} ₽`
        : "нет ключа",
      sub: yandexUsage?.configured
        ? `${yandexUsage.total} вызовов · ≈${yandexUsage.totalMinutes.toFixed(1)} мин · ₽0.45/мин`
        : "Введите ключ в /admin → Секреты",
      color: !yandexUsage?.configured ? "text-rose-400" : "text-cyan-400",
    },
  ];

  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-purple-400" />
        Статистика
      </h2>
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        {cards.map((c, i) => (
          <div
            key={i}
            className={`glass-card rounded-xl p-4 ${c.onClick ? "cursor-pointer hover:bg-white/[0.03] transition-colors" : ""}`}
            onClick={c.onClick}
            data-testid={`stat-card-${c.label}`}
          >
            <div className="flex items-center gap-2 mb-2">
              <c.icon className={`w-4 h-4 ${c.color}`} />
              <span className="text-xs text-muted-foreground">{c.label}</span>
            </div>
            <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{c.sub}</p>
          </div>
        ))}
      </div>

      {/* Authors list dropdown */}
      {showAuthors && stats.authors.list && (
        <div className="mt-3 glass-card rounded-xl p-4 divide-y divide-white/[0.04]">
          <p className="text-xs text-muted-foreground pb-2 mb-2">Все авторы ({stats.authors.list.length})</p>
          {stats.authors.list.map((a: any) => (
            <div key={a.id} className={`flex items-center justify-between py-1.5 ${a.blocked ? "opacity-50" : ""}`}>
              <div className="flex items-center gap-2">
                <span className="text-xs text-purple-400 font-mono">#{a.id}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono min-w-[24px] text-center">{a.genCount || 0}</span>
                <span className="text-sm text-white">{a.name || "Без имени"}</span>
                {a.blocked ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">заблок.</span> : null}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground hidden sm:inline">{a.email}</span>
                <span className="text-[10px] text-muted-foreground">{a.createdAt?.slice(0, 10)}</span>
                <button
                  className="text-[10px] px-2 py-0.5 rounded-md border border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 transition-colors"
                  onClick={async () => {
                    try {
                      const res = await apiRequest("GET", `/api/admin/user/${a.id}/generations`);
                      const data = await res.json();
                      setViewingUser(data.user);
                      setViewingGens(data.generations || []);
                    } catch {}
                  }}
                >
                  Просм.
                </button>
                {a.email !== "egnovoselov@gmail.com" && (
                  <button
                    className={`text-[10px] px-2 py-0.5 rounded-md border transition-colors ${
                      a.blocked
                        ? "border-green-500/30 bg-green-500/10 text-green-400 hover:bg-green-500/20"
                        : "border-red-500/20 bg-red-500/5 text-red-400 hover:bg-red-500/10"
                    }`}
                    onClick={async () => {
                      try {
                        await apiRequest("POST", `/api/admin/block/${a.id}`, { blocked: !a.blocked });
                        setStats((prev: any) => ({
                          ...prev,
                          authors: {
                            ...prev.authors,
                            list: prev.authors.list.map((u: any) => u.id === a.id ? { ...u, blocked: a.blocked ? 0 : 1 } : u)
                          }
                        }));
                      } catch {}
                    }}
                  >
                    {a.blocked ? "Разблок." : "Блок."}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Admin: promo codes stats */}
      {showAuthors && stats.promoCodes && stats.promoCodes.length > 0 && (
        <div className="mt-2 glass-card rounded-xl p-3">
          <p className="text-xs text-muted-foreground pb-2 mb-2">🎟️ Промокоды</p>
          {stats.promoCodes.map((p: any) => (
            <div key={p.code} className="flex items-center justify-between py-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-purple-300">{p.code}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-300">{p.bonus}₽</span>
              </div>
              <span className="text-xs text-muted-foreground">{p.usedCount} использ. {p.maxUses ? `/ ${p.maxUses}` : ""}</span>
            </div>
          ))}
        </div>
      )}

      {/* Visitors panel — расширенная с фильтром периода */}
      {showVisitors && (
        <div className="mt-3 glass-card rounded-xl p-4">
          <p className="text-xs text-muted-foreground pb-2 mb-3 font-semibold">👁 Посетители</p>

          {/* Фильтр периода */}
          <div className="flex gap-1 mb-3">
            {[
              { v: "yesterday", label: "Вчера" },
              { v: "today", label: "Сегодня" },
              { v: "week",  label: "Неделя" },
              { v: "month", label: "Месяц" },
              { v: "all",   label: "Всё время" },
            ].map(p => (
              <button
                key={p.v}
                onClick={() => setVisitorPeriod(p.v as any)}
                className={`flex-1 text-xs py-1.5 rounded-lg transition-colors ${visitorPeriod === p.v ? "bg-primary text-primary-foreground font-medium" : "bg-white/5 hover:bg-white/10 text-muted-foreground"}`}
                data-testid={`btn-visitor-period-${p.v}`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {!visitorStats ? (
            <div className="text-center py-6 text-xs text-muted-foreground">Загрузка…</div>
          ) : (
            <>
              {/* Итог: уникальные и общие визиты за период */}
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="text-center p-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
                  <p className="text-lg font-bold text-blue-400 tabular-nums">{visitorStats.periodTotal}</p>
                  <p className="text-[10px] text-muted-foreground">Уникальных</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-purple-500/10 border border-purple-500/20">
                  <p className="text-lg font-bold text-purple-400 tabular-nums">{visitorStats.periodVisits}</p>
                  <p className="text-[10px] text-muted-foreground">Посещений всего</p>
                </div>
              </div>

              {/* Страны — Eugene 2026-05-15 Босс «клик в любом месте панели страны/города закрывает». */}
              {visitorStats.byCountry?.length > 0 && (
                <div
                  className="mb-3 cursor-pointer"
                  onClick={() => setShowVisitors(false)}
                  title="Нажмите чтобы закрыть"
                  data-testid="panel-countries-close"
                >
                  <p className="text-[10px] uppercase text-muted-foreground mb-1">🌍 Страны <span className="text-white/30 normal-case">(клик закроет)</span></p>
                  <div className="space-y-0.5 max-h-40 overflow-y-auto">
                    {visitorStats.byCountry.map((c: any) => (
                      <div key={c.country} className="flex items-center justify-between px-2 py-1 rounded bg-white/5 text-xs">
                        <span className="truncate">{c.country || "Неизвестно"}</span>
                        <span className="flex items-center gap-3 text-muted-foreground tabular-nums">
                          <span><span className="text-blue-300">{c.visitors}</span> уник.</span>
                          <span><span className="text-purple-300">{c.visits}</span> виз.</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Города */}
              {visitorStats.byCity?.length > 0 && (
                <div
                  className="mb-3 cursor-pointer"
                  onClick={() => setShowVisitors(false)}
                  title="Нажмите чтобы закрыть"
                  data-testid="panel-cities-close"
                >
                  <p className="text-[10px] uppercase text-muted-foreground mb-1">🏙 Города <span className="text-white/30 normal-case">(клик закроет)</span></p>
                  <div className="space-y-0.5 max-h-48 overflow-y-auto">
                    {visitorStats.byCity.map((c: any) => (
                      <div key={`${c.city}-${c.country}`} className="flex items-center justify-between px-2 py-1 rounded bg-white/5 text-xs">
                        <span className="truncate">{c.name?.replace(/, $/, "") || "Неизвестно"}</span>
                        <span className="flex items-center gap-3 text-muted-foreground tabular-nums">
                          <span><span className="text-blue-300">{c.visitors}</span> уник.</span>
                          <span><span className="text-purple-300">{c.visits}</span> виз.</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Подменю: IP-адреса */}
              {visitorStats.byIp?.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowAllIps(v => !v)}
                    className="w-full text-left text-[10px] uppercase text-muted-foreground hover:text-foreground transition-colors py-1"
                    data-testid="btn-toggle-visitor-ips"
                  >
                    {showAllIps ? "▼" : "▶"} Подробно: IP-адреса ({visitorStats.byIp.length})
                  </button>
                  {showAllIps && (
                    <div className="mt-1 space-y-0.5 max-h-72 overflow-y-auto">
                      {visitorStats.byIp.map((v: any) => (
                        <div key={v.ip} className="flex items-center justify-between px-2 py-1 rounded bg-white/5 text-[11px] gap-2">
                          <span className="font-mono tabular-nums shrink-0">{v.ip}</span>
                          <span className="truncate flex-1 text-muted-foreground">
                            {v.city ? `${v.city}, ${v.country || ""}`.replace(/, $/, "") : (v.country || "—")}
                          </span>
                          <span className="text-muted-foreground/70 whitespace-nowrap">{v.device === 'mobile' ? '📱' : '💻'} {v.browser || "—"}</span>
                          <span className="text-purple-400 font-mono shrink-0">×{v.visits}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Устройства */}
              {visitorStats.byDevice?.length > 0 && (
                <div className="mt-3 pt-3 border-t border-white/5 flex gap-3 flex-wrap">
                  {visitorStats.byDevice.map((d: any) => (
                    <span key={d.device} className="text-[10px] text-muted-foreground">{d.device === 'mobile' ? '📱' : d.device === 'desktop' ? '💻' : '📝'} {d.device}: <span className="text-white">{d.c}</span></span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Top-10 activity — disabled temporarily */}

      {/* Admin: viewing user's cabinet (readonly) */}
      {viewingUser && (
        <div className="mt-4 glass-card rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-bold text-white">Кабинет: {viewingUser.name || "Без имени"}</h3>
              <p className="text-[10px] text-muted-foreground">{viewingUser.email} · Баланс: {(viewingUser.balance / 100).toFixed(0)} ₽ · Треков: {viewingGens.length}</p>
            </div>
            <button
              className="text-xs px-3 py-1 rounded-lg border border-white/10 bg-white/5 text-muted-foreground hover:text-white transition-colors"
              onClick={() => { setViewingUser(null); setViewingGens([]); }}
            >
              Закрыть
            </button>
          </div>
          <div className="text-[10px] text-amber-400/80 mb-2 px-2 py-1 rounded bg-amber-500/10 border border-amber-500/20">
            🔒 Режим просмотра — изменения недоступны
          </div>
          <div className="divide-y divide-white/[0.04] max-h-[400px] overflow-y-auto">
            {viewingGens.map((g: any) => {
              const typeIcon = g.type === "music" ? "🎵" : g.type === "cover" ? "🖼" : "📝";
              const isDeleted = !!g.deletedAt;
              const isError = g.status === "error";
              return (
                <div key={g.id} className={`flex items-center gap-3 py-2 ${isDeleted ? "opacity-40" : isError ? "opacity-30" : ""}`}>
                  <span className="text-sm">{typeIcon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-white truncate">
                      {isDeleted && <span className="text-red-400">🗑 </span>}
                      {g.displayTitle || g.prompt?.slice(0, 50)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {isError ? "✗ ошибка" : g.status === "done" ? "✓" : "⏳"}
                      {isDeleted ? " · удалено " + (g.deletedAt?.slice(0, 10) || "") : ""}
                      {" · "}{g.createdAt?.slice(0, 10)}
                      {(() => { try { const m = JSON.parse((g as any).style || '{}'); if (m.style) return ` · Промт: ${m.style}`; } catch {} return ''; })()}
                      {" · "}{g.isPublic ? "🌐" : "🔒"}
                      {g.cost > 0 ? ` · ${(g.cost / 100).toFixed(0)}₽` : " · 🎁"}
                    </p>
                  </div>
                  {g.type === "music" && g.status === "done" && (
                    <a href={`/api/stream/${g.id}`} target="_blank" rel="noopener" className="text-[10px] text-blue-400 hover:text-blue-300">▶</a>
                  )}
                  {g.type === "cover" && g.status === "done" && (
                    <a href={`/api/stream/${g.id}?type=image`} target="_blank" rel="noopener" className="text-[10px] text-purple-400 hover:text-purple-300">🖼</a>
                  )}
                  {g.status === "done" && (
                    <button onClick={() => { const a = document.createElement('a'); a.href = `/api/download/${g.id}`; a.download = ''; document.body.appendChild(a); a.click(); document.body.removeChild(a); }} className="text-[10px] text-green-400 hover:text-green-300">⬇</button>
                  )}
                </div>
              );
            })}
            {viewingGens.length === 0 && <p className="text-xs text-muted-foreground py-4 text-center">Нет генераций</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function ReferralInfo() {
  const [info, setInfo] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    apiRequest("GET", "/api/referral/info").then(r => r.json()).then(setInfo).catch(() => {});
  }, []);

  if (!info) return <Skeleton className="h-8" />;

  const shortLink = `MuzaAi.ru/r/${info.referralCode}`;
  const fullLink = info.referralLink;

  const handleCopy = () => {
    navigator.clipboard.writeText(fullLink).then(() => {
      setCopied(true);
      toast({ title: "Ссылка скопирована" });
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 justify-between">
        <div className="flex items-center gap-2">
          <Share2 className="w-4 h-4 text-purple-400 shrink-0" />
          <span className="text-xs text-muted-foreground">Реферальная ссылка:</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-purple-300 font-mono">{shortLink}</span>
          <button
            onClick={handleCopy}
            className="px-2 py-1 rounded border border-white/10 bg-white/5 text-xs text-white hover:bg-white/10 transition-colors"
            data-testid="button-copy-referral"
          >
            {copied ? "✓" : <Copy className="w-3 h-3" />}
          </button>
        </div>
      </div>
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Users className="w-3 h-3" /> Приглашено: <b className="text-white">{info.referrals}</b>
        </span>
        <span className="flex items-center gap-1">
          🎵 Реферальные треки: <b className="text-green-400">{info.bonusTracks}</b>
        </span>
      </div>
      <p className="text-xs text-muted-foreground/60">Пригласите автора — оба получите трек в подарок</p>
    </div>
  );
}

// Eugene 2026-05-14 Босс «обложки видимые 7, остальные раскрываются».
function CoverPickerExpandable({ covers, selectedCoverId, onAttach }: { covers: any[]; selectedCoverId?: number | null; onAttach: (c: any) => void; }) {
  const [showAll, setShowAll] = useState(false);
  const [previewCover, setPreviewCover] = useState<any | null>(null);
  // Eugene 2026-05-16: B.8 — split layout «Текущая обложка | Новые варианты».
  // Текущая cover (selectedCoverId) выделяется amber-border-2, варианты слева.
  // Клик на любой — открывает Dialog с full-size + детали.
  const current = covers.find(c => c.id === selectedCoverId) || null;
  const variants = covers.filter(c => c.id !== selectedCoverId);
  const visibleVariants = showAll ? variants : variants.slice(0, 6);
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">Обложки трека:</p>
      <div className="grid md:grid-cols-2 gap-3">
        {/* Левая колонка — текущая обложка */}
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-amber-400/80 font-semibold">Текущая</p>
          {current ? (
            <button
              type="button"
              onClick={() => setPreviewCover(current)}
              className="block w-full aspect-square rounded-xl overflow-hidden border-2 border-amber-500 shadow-lg shadow-amber-500/20 hover:shadow-amber-500/40 transition-all"
              data-testid={`cover-current-${current.id}`}
            >
              <img src={`/api/stream/${current.id}`} alt="Текущая обложка" loading="lazy" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            </button>
          ) : (
            <div className="w-full aspect-square rounded-xl border-2 border-dashed border-amber-500/40 bg-amber-500/5 flex items-center justify-center text-amber-400/60 text-xs text-center px-3">
              Обложка не выбрана — кликните на вариант справа
            </div>
          )}
        </div>
        {/* Правая колонка — новые варианты */}
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-purple-300/80 font-semibold">Новые варианты ({variants.length})</p>
          {variants.length === 0 ? (
            <div className="w-full aspect-square rounded-xl border border-dashed border-white/10 bg-white/[0.02] flex items-center justify-center text-muted-foreground/60 text-xs text-center px-3">
              Других обложек нет — создайте через «Re Обложка»
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-1.5">
                {visibleVariants.map(cover => (
                  <button
                    key={cover.id}
                    type="button"
                    onClick={() => setPreviewCover(cover)}
                    className="aspect-square rounded-lg overflow-hidden border-2 border-transparent hover:border-purple-400/60 transition-colors group relative"
                    data-testid={`cover-variant-${cover.id}`}
                  >
                    <img src={`/api/stream/${cover.id}`} alt="" loading="lazy" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    <span className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                      <span className="text-[10px] text-white bg-purple-500/80 px-1.5 py-0.5 rounded">Открыть</span>
                    </span>
                  </button>
                ))}
              </div>
              {variants.length > 6 && (
                <button
                  type="button"
                  onClick={() => setShowAll(s => !s)}
                  className="mt-1 w-full text-[11px] text-purple-300 hover:text-purple-200 py-1.5 rounded-lg hover:bg-white/[0.04] transition-colors"
                  data-testid="btn-cover-toggle-all"
                >
                  {showAll ? `↑ Скрыть (${variants.length - 6})` : `↓ Показать ещё ${variants.length - 6}`}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Full-size preview Dialog с деталями + действиями */}
      <Dialog open={!!previewCover} onOpenChange={(o) => { if (!o) setPreviewCover(null); }}>
        <DialogContent className="glass-card border-purple-500/30 max-w-lg" data-testid="dialog-cover-preview">
          <DialogHeader>
            <DialogTitle className="gradient-text text-base flex items-center gap-2">
              <ImageIcon className="w-4 h-4" />
              Обложка #{previewCover?.id}
              {previewCover?.id === selectedCoverId && (
                <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 uppercase tracking-wider">Текущая</span>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {previewCover?.displayTitle || previewCover?.prompt?.slice(0, 100) || ""}
            </DialogDescription>
          </DialogHeader>
          {previewCover && (
            <div className="space-y-3">
              <img src={`/api/stream/${previewCover.id}`} alt="" className="w-full rounded-xl border border-white/10" />
              {previewCover.prompt && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Промт</p>
                  <p className="text-xs text-foreground/80 max-h-24 overflow-y-auto leading-relaxed">{previewCover.prompt}</p>
                </div>
              )}
              <div className="grid grid-cols-3 gap-1.5 text-[10px] text-muted-foreground">
                {previewCover.createdAt && (
                  <div>
                    <p className="uppercase tracking-wider text-[9px]">Дата</p>
                    <p className="text-white/80">{new Date(previewCover.createdAt).toLocaleDateString("ru")}</p>
                  </div>
                )}
                {previewCover.cost != null && (
                  <div>
                    <p className="uppercase tracking-wider text-[9px]">Стоимость</p>
                    <p className="text-white/80">{(previewCover.cost / 100).toFixed(0)} ₽</p>
                  </div>
                )}
              </div>
              <div className="flex gap-2 pt-2 border-t border-white/10">
                {previewCover.id !== selectedCoverId && (
                  <Button
                    className="flex-1 btn-gradient"
                    onClick={() => { onAttach(previewCover); setPreviewCover(null); }}
                    data-testid="btn-cover-attach"
                  >
                    Сделать текущей
                  </Button>
                )}
                <Button
                  variant="outline"
                  className="flex-1 border-white/10"
                  onClick={() => setPreviewCover(null)}
                  data-testid="btn-cover-close"
                >
                  Закрыть
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function getCoverUrl(gen: any): string {
  // Eugene 2026-05-09: единый endpoint /api/cover/<id>.jpg для всех обложек.
  // Раньше использовался /api/stream/:id?type=image — у него своя логика
  // resolveCoverPath, которая накопила баги (3 root cause подряд). Теперь
  // и плейлист, и cover-only генерации идут через /api/cover/.
  // ?v=<id> — cache-bust на случай если браузер закэшировал прошлый 404/fallback.
  const coverId = gen.coverGenId || gen.id;
  return `/api/cover/${coverId}.jpg?v=${gen.id}`;
}

function formatDur(seconds: number): string {
  if (!seconds || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function MyPlaylist({ generations, onUpdate }: { generations?: Generation[]; onUpdate?: () => void }) {
  const [, navigate] = useLocation();
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [trackDuration, setTrackDuration] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const expandedIdRef = useRef<number | null>(null);
  // Eugene 2026-05-16 Босс «кнопка раскрыть (expand) на плееры везде».
  // coverExpanded — column-layout активного плеера: cover full-width сверху,
  // controls под ним. False = row-layout (current default).
  const [coverExpanded, setCoverExpanded] = useState(false);
  // Eugene 2026-05-16 Босс «🔍 Детали» — full-screen cover modal в MyPlaylist.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Eugene 2026-05-17 Босс «стильный ползунок громкости в плеере».
  // Shared localStorage key `muzaai-volume` с landing player.
  const [volume, setVolume] = useState<number>(() => {
    try {
      const stored = localStorage.getItem("muzaai-volume");
      const v = stored ? parseFloat(stored) : NaN;
      return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.5;
    } catch { return 0.5; }
  });
  const volumeRef = useRef<number>(0.5);
  volumeRef.current = volume;
  const [showKaraoke, setShowKaraoke] = useState(false);
  const [lyricsSpeed, setLyricsSpeed] = useState(0);
  const [repeatMode, setRepeatMode] = useState<"off" | "all" | "one">("all"); // off=stop at end, all=loop playlist, one=loop single track
  const repeatModeRef = useRef(repeatMode);
  repeatModeRef.current = repeatMode;
  const [searchQuery, setSearchQuery] = useState("");
  const [showPrompts, setShowPrompts] = useState(false);
  // Admin-only: попап с географией прослушиваний
  const [geoDialog, setGeoDialog] = useState<{ open: boolean; genId: number | null; title: string }>({ open: false, genId: null, title: "" });
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.email === "egnovoselov@gmail.com";
  // Cover/Extend remix dialog (author-only, dashboard scope)
  const [remixDialog, setRemixDialog] = useState<{ open: boolean; mode: 'cover' | 'extend' | null; track: any | null }>({ open: false, mode: null, track: null });
  const [remixStyle, setRemixStyle] = useState("");
  const [remixContinueAt, setRemixContinueAt] = useState(180);
  const [remixLoading, setRemixLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const playingGenRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      audioRef.current?.pause();
    };
  }, []);
  // Eugene 2026-05-17 — sync volume → audioRef + persist в localStorage.
  useEffect(() => {
    try { localStorage.setItem("muzaai-volume", String(volume)); } catch {}
    if (audioRef.current) {
      try { audioRef.current.volume = volume; } catch {}
    }
  }, [volume]);

  // Keep ref in sync with state
  useEffect(() => { expandedIdRef.current = expandedId; }, [expandedId]);

  // Marquee title in browser tab while playing
  useEffect(() => {
    const originalTitle = 'MuzaAi — Личный кабинет';
    if (!playingId) {
      document.title = originalTitle;
      return;
    }
    const gen = (generations || []).find((g: any) => g.id === playingId);
    if (!gen) return;
    const title = gen.displayTitle || gen.prompt?.slice(0, 60) || 'MuzaAi';
    const author = gen.authorName || '';
    const text = `♫ ${title} — MuzaAi${author ? ' · ' + author : ''}    `;
    let offset = 0;
    const interval = setInterval(() => {
      const display = text.slice(offset) + text.slice(0, offset);
      document.title = display.slice(0, 60);
      offset = (offset + 1) % text.length;
    }, 350);
    return () => {
      clearInterval(interval);
      document.title = originalTitle;
    };
  }, [playingId, generations]);

  // Filter to done music tracks with localPath or fresh URL
  const sq = searchQuery.toLowerCase().trim();
  const matchesSearch = (g: any) => !sq ||
    g.prompt?.toLowerCase().includes(sq) ||
    g.displayTitle?.toLowerCase().includes(sq) ||
    g.authorName?.toLowerCase().includes(sq);

  const musicTracks = (generations || []).filter(
    g => g.type === "music" && g.status === "done" && g.resultUrl && !g.deletedAt && matchesSearch(g)
  );

  if (!generations) return <div className="mb-8"><p className="text-xs text-muted-foreground">Загрузка...</p></div>;
  if (musicTracks.length === 0) return null;

  const playTrack = (gen: Generation) => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.onloadedmetadata = null;
    }
    pauseAllExcept(null);
    const audio = new Audio(`/api/stream/${gen.id}`); registerAudio(audio);
    audio.volume = volumeRef.current;
    audioRef.current = audio;
    playingGenRef.current = gen;
    setCurrentTime(0);
    setTrackDuration(0);
    audio.onloadedmetadata = () => {
      if (audio.duration && isFinite(audio.duration)) setTrackDuration(audio.duration);
    };
    audio.onended = () => {
      if (audioRef.current !== audio) return;
      if (timerRef.current) clearInterval(timerRef.current);
      const mode = repeatModeRef.current;
      const cur = playingGenRef.current;
      if (mode === "one") {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        return;
      }
      const idx = cur ? musicTracks.findIndex(t => t.id === cur.id) : -1;
      if (mode === "all") {
        const next = (idx + 1) % musicTracks.length;
        playTrack(musicTracks[next]);
      } else {
        if (idx < musicTracks.length - 1) {
          playTrack(musicTracks[idx + 1]);
        } else {
          setPlayingId(null);
          unmuteBgMusic();
        }
      }
    };
    audio.onerror = () => {
      if (audioRef.current !== audio) return;
      if (timerRef.current) clearInterval(timerRef.current);
      setPlayingId(null);
      unmuteBgMusic();
    };
    audio.play().catch(() => {});
    setPlayingId(gen.id);
    muteBgMusic();
    if (expandedIdRef.current !== null) setExpandedId(gen.id);
    // Eugene 2026-05-17 (Босс «1% conversion plays/visits»): засчитываем play
    // только после 5 сек реального воспроизведения с elapsedSec=5 — backend
    // shouldCountPlay() правило применяется (раньше fetch без body → fallback).
    const _playGenId = gen.id;
    window.setTimeout(() => {
      if (audio && !audio.paused && audio.currentTime >= 5) {
        fetch(`/api/playlist/play/${_playGenId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ elapsedSec: 5 }),
          keepalive: true,
        }).catch(() => {});
      }
    }, 5000);
    timerRef.current = window.setInterval(() => {
      if (audio && !audio.paused) setCurrentTime(audio.currentTime);
    }, 250);

    // MediaSession lockscreen via helper (multi-size + pre-warm + iOS retry)
    setLockScreenTrack(
      {
        id: gen.id,
        title: gen.displayTitle || gen.prompt?.slice(0, 60) || 'MuzaAi',
        artist: gen.authorName ? `MuzaAi · ${gen.authorName}` : 'MuzaAi',
        album: 'MuzaAi',
      },
      {
        play: () => { audioRef.current?.play(); muteBgMusic(); },
        pause: () => { audioRef.current?.pause(); unmuteBgMusic(); },
        previoustrack: () => {
          const idx = musicTracks.findIndex(t => t.id === gen.id);
          const prev = idx > 0 ? idx - 1 : musicTracks.length - 1;
          playTrack(musicTracks[prev]);
        },
        nexttrack: () => {
          const idx = musicTracks.findIndex(t => t.id === gen.id);
          const next = (idx + 1) % musicTracks.length;
          playTrack(musicTracks[next]);
        },
        seekto: (time: number) => { if (audioRef.current) audioRef.current.currentTime = time; },
      },
      gen.id // cache-bust per track
    );
  };

  const togglePlay = (gen: Generation) => {
    if (playingId === gen.id) {
      if (audioRef.current?.paused) {
        audioRef.current.play().catch(() => {});
        muteBgMusic();
        timerRef.current = window.setInterval(() => {
          if (audioRef.current && !audioRef.current.paused) setCurrentTime(audioRef.current.currentTime);
        }, 250);
      } else {
        audioRef.current?.pause();
        if (timerRef.current) clearInterval(timerRef.current);
        unmuteBgMusic();
      }
    } else {
      playTrack(gen);
    }
  };

  const skipPrev = () => {
    if (musicTracks.length === 0) return;
    const idx = musicTracks.findIndex(t => t.id === playingId);
    const prev = (idx - 1 + musicTracks.length) % musicTracks.length;
    playTrack(musicTracks[prev]);
  };

  const skipNext = () => {
    if (musicTracks.length === 0) return;
    const idx = musicTracks.findIndex(t => t.id === playingId);
    const next = (idx + 1) % musicTracks.length;
    playTrack(musicTracks[next]);
  };

  const current = musicTracks.find(t => t.id === playingId) || musicTracks[0] || null;
  const progress = trackDuration > 0 ? (currentTime / trackDuration) * 100 : 0;

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-white flex items-center gap-2">
          <Music className="w-4 h-4 text-purple-400" />
          Мой плейлист
          <span className="text-xs text-muted-foreground font-normal">({musicTracks.length})</span>
        </h2>
        <button
          className={`text-[10px] px-2 py-1 rounded-lg border transition-colors ${showPrompts ? 'border-purple-500/30 bg-purple-500/10 text-purple-300' : 'border-white/10 bg-white/5 text-muted-foreground hover:text-white'}`}
          onClick={() => setShowPrompts(!showPrompts)}
        >Мои запросы</button>
      </div>

      {/* Мои запросы */}
      {showPrompts && (
        <div className="mb-4 max-h-60 overflow-y-auto space-y-1.5 p-2 rounded-xl bg-white/[0.02] border border-white/[0.06]">
          <p className="text-[10px] text-muted-foreground mb-2">Нажмите, чтобы скопировать и повторно сгенерировать</p>
          {(() => {
            const seen = new Set<string>();
            return (generations || []).filter(g => g.type === 'music' && g.prompt).map(g => {
              const key = g.prompt!.slice(0, 80);
              if (seen.has(key)) return null;
              seen.add(key);
              let styleLabel = '';
              try { const m = JSON.parse((g as any).style || '{}'); styleLabel = m.style || ''; } catch {}
              return (
                <button key={g.id} className="w-full text-left p-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors group"
                  onClick={() => {
                    navigator.clipboard.writeText(g.prompt || '');
                    toast({ title: 'Запрос скопирован', description: 'Вставьте в поле создания трека' });
                  }}>
                  <p className="text-xs text-white/80 truncate flex items-center gap-1.5">
                    <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-white/[0.05] text-muted-foreground tabular-nums shrink-0">#{g.id}</span>
                    <span className="truncate">{g.displayTitle || g.prompt?.slice(0, 60)}</span>
                  </p>
                  <p className="text-[10px] text-muted-foreground/50 flex items-center gap-2 mt-0.5">
                    {styleLabel && <span className="text-purple-400/50">{styleLabel}</span>}
                    <span>Нажмите чтобы скопировать</span>
                  </p>
                </button>
              );
            });
          })()}
        </div>
      )}
      <div className="mb-3 flex gap-2">
        <input
          className="flex-1 text-sm bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-white placeholder:text-muted-foreground/50 focus:outline-none focus:border-purple-500/30"
          placeholder="🔍 Поиск по названию, тексту..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button
            className="text-xs px-2 py-1 rounded-lg border border-white/10 bg-white/5 text-muted-foreground hover:text-white transition-colors"
            onClick={() => setSearchQuery("")}
          >
            ✕
          </button>
        )}
      </div>

      {/* Player */}
      {current && (
        <div className="glass-card rounded-2xl p-5 mb-4 border border-white/[0.06]">
          {/* Eugene 2026-05-16: expand работает только на desktop (md+).
              На mobile compact row-layout всегда (как до introducing expand). */}
          <div className={`flex gap-4 items-center ${coverExpanded ? "md:flex-col md:items-stretch" : ""}`}>
            <div
              className={`relative shrink-0 bg-gradient-to-br from-purple-500/30 to-blue-500/30 flex items-center justify-center cursor-pointer shadow-lg shadow-purple-500/10 overflow-hidden transition-all duration-300 w-20 h-20 sm:w-24 sm:h-24 rounded-xl ${
                coverExpanded ? "md:w-full md:h-auto md:aspect-square md:rounded-2xl" : ""
              }`}
              onClick={() => setExpandedId(expandedId === current.id ? null : current.id)}
            >
              <img src={getCoverUrl(current)} alt="" className="w-full h-full object-cover absolute inset-0 transition-all duration-500" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              <Music className={`text-white/10 w-8 h-8 ${coverExpanded ? "md:w-24 md:h-24" : ""}`} />
              <ExpandToggleButton
                expanded={coverExpanded}
                onToggle={() => setCoverExpanded(v => !v)}
                className="absolute top-2 right-2 z-10"
              />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base sm:text-lg font-bold text-white truncate">{current.prompt?.slice(0, 60)}</p>
              <p className="text-sm text-purple-300/80 mt-0.5">{current.authorName || ""}</p>
              <div className="flex items-center gap-2 mt-3">
                <span className="text-xs text-muted-foreground tabular-nums w-9">{formatDur(currentTime)}</span>
                <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden cursor-pointer"
                  onClick={(e) => {
                    if (!audioRef.current || !trackDuration) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pct = (e.clientX - rect.left) / rect.width;
                    audioRef.current.currentTime = pct * trackDuration;
                    setCurrentTime(pct * trackDuration);
                  }}
                >
                  <div className="h-full rounded-full bg-gradient-to-r from-purple-500 to-blue-500 transition-all duration-200" style={{ width: `${Math.min(progress, 100)}%` }} />
                </div>
                <span className="text-xs text-muted-foreground tabular-nums w-9 text-right">{formatDur(trackDuration)}</span>
              </div>
              <div className="flex items-center gap-3 mt-3">
                <button onClick={skipPrev} className="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition-colors">
                  <SkipBack className="w-4 h-4 text-muted-foreground" />
                </button>
                <button onClick={() => togglePlay(current)} className="w-11 h-11 rounded-full bg-purple-500/20 flex items-center justify-center hover:bg-purple-500/30 transition-colors border border-purple-500/30">
                  {audioRef.current?.paused ? <Play className="w-5 h-5 text-purple-300 ml-0.5" /> : <Pause className="w-5 h-5 text-purple-300" />}
                </button>
                <button onClick={skipNext} className="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition-colors">
                  <SkipForward className="w-4 h-4 text-muted-foreground" />
                </button>
                <button
                  className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                    repeatMode === "all" ? "bg-green-500/20 text-green-300" : "bg-white/5 text-muted-foreground hover:bg-white/10"
                  }`}
                  onClick={() => setRepeatMode(m => m === "all" ? "off" : "all")}
                  title="Плей по кругу"
                >
                  <Repeat className="w-4 h-4" />
                </button>
                <button
                  className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                    repeatMode === "one" ? "bg-blue-500/20 text-blue-300" : "bg-white/5 text-muted-foreground hover:bg-white/10"
                  }`}
                  onClick={() => setRepeatMode(m => m === "one" ? "all" : "one")}
                  title="Закольцевать трек"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12a7 7 0 1 0-3 5.7" /><polyline points="14 17 16 17.7 16.7 15.7" /><text x="12" y="15" textAnchor="middle" fontSize="9" fontWeight="700" stroke="none" fill="currentColor">1</text></svg>
                </button>
                {/* Eugene 2026-05-17 Босс «стильный ползунок громкости в плеере» — после Repeat */}
                <VolumeSlider
                  volume={volume}
                  onVolumeChange={setVolume}
                  className="w-[110px] sm:w-[140px]"
                />
                {/* Eugene 2026-05-16 Босс «🔍 Детали справа от Repeat» —
                    full-screen modal с обложкой 80% viewport, мета-блок. */}
                <button
                  className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-500/20 to-cyan-500/20 hover:from-purple-500/40 hover:to-cyan-500/40 flex items-center justify-center text-purple-200 hover:text-white transition-all border border-purple-400/30 shadow-[0_0_12px_rgba(168,85,247,0.3)] animate-details-pulse"
                  title="Детали обложки — свайпай ← → для смены трека"
                  aria-label="Открыть детали обложки"
                  onClick={() => setDetailsOpen(true)}
                  data-testid="btn-cover-details"
                >
                  <Maximize className="w-4 h-4" />
                </button>
                {/* Download + Share */}
                <button
                  className="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition-colors"
                  title="Скачать"
                  onClick={() => {
                    const a = document.createElement('a');
                    a.href = `/api/download/${current.id}`;
                    a.download = '';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                  }}
                >
                  <Download className="w-4 h-4 text-muted-foreground" />
                </button>
                <button
                  className="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition-colors"
                  title="Поделиться"
                  onClick={async () => {
                    const shareUrl = `https://muziai.ru/share/${current.id}`;
                    const title = current.displayTitle || current.prompt?.slice(0, 60) || 'MuzaAi';
                    if (navigator.share) {
                      try {
                        const coverUrl = `/api/cover/${current.id}.jpg?wm=1`;
                        const resp = await fetch(coverUrl).catch(() => null);
                        const blob = resp?.ok ? await resp.blob() : null;
                        const files = blob ? [new File([blob], 'MuzaAi-cover.jpg', { type: 'image/jpeg' })] : [];
                        await navigator.share({ title: `Послушай на MuzaAi.ru`, text: `${title}`, url: shareUrl, ...(files.length ? { files } : {}) });
                        return;
                      } catch {}
                    }
                    navigator.clipboard.writeText(`Послушай на MuzaAi.ru: ${title} ${shareUrl}`);
                    toast({ title: "Ссылка скопирована" });
                  }}
                >
                  <Share2 className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Expanded cover — standalone, outside track list */}
      {expandedId && (() => {
        const eGen = musicTracks.find(t => t.id === expandedId);
        if (!eGen) return null;
        const eActive = playingId === eGen.id;
        const isAnyPlaying = playingId !== null && audioRef.current && !audioRef.current.paused;
        const ePlaying = eActive && isAnyPlaying;
        const eDateStr = eGen.createdAt ? new Date(eGen.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }) : "";
        return (
          <div className="mb-4">
            <div className="relative rounded-2xl overflow-hidden shadow-2xl shadow-purple-500/20 animate-in fade-in zoom-in-95 duration-300">
              <div className="w-full aspect-[4/3] max-h-[50vh] bg-gradient-to-br from-purple-900 via-blue-900 to-black relative">
                <img key={getCoverUrl(eGen)} src={getCoverUrl(eGen)} alt="" className="w-full h-full object-cover absolute inset-0 animate-in fade-in duration-500" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                <div className="absolute inset-0 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" className="w-16 h-16 opacity-10" fill="none">
                    <path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                    <circle cx="6" cy="8" r="1" fill="rgba(255,255,255,0.5)" />
                    <circle cx="12" cy="6" r="1.2" fill="rgba(255,255,255,0.7)" />
                    <circle cx="18" cy="9" r="0.8" fill="rgba(255,255,255,0.4)" />
                    <path d="M6 8L12 6M12 6L18 9" stroke="rgba(255,255,255,0.3)" strokeWidth="0.5" />
                  </svg>
                </div>
                {/* Center play/pause */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-40">
                  <button className="pointer-events-auto w-16 h-16 rounded-full bg-white/20 flex items-center justify-center border border-white/30 hover:bg-white/30 transition-colors" onClick={() => togglePlay(eGen)}>
                    {ePlaying ? <Pause className="w-7 h-7 text-white" /> : <Play className="w-7 h-7 text-white ml-1" />}
                  </button>
                </div>
                {/* Collapse button — always visible top-right */}
                <button className="absolute top-3 left-3 w-8 h-8 rounded-full bg-black/60 flex items-center justify-center hover:bg-black/80 transition-colors z-50" onClick={() => setExpandedId(null)}>
                  <ChevronDown className="w-4 h-4 text-white/80" />
                </button>
                {/* Prev / Next */}
                {musicTracks.length > 1 && (
                  <>
                    <button className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/40 flex items-center justify-center hover:bg-black/60 transition-colors z-40" onClick={() => { const idx = musicTracks.findIndex(t => t.id === eGen.id); const prev = (idx - 1 + musicTracks.length) % musicTracks.length; setExpandedId(musicTracks[prev].id); playTrack(musicTracks[prev]); }}><SkipBack className="w-4 h-4 text-white" /></button>
                    <button className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/40 flex items-center justify-center hover:bg-black/60 transition-colors z-40" onClick={() => { const idx = musicTracks.findIndex(t => t.id === eGen.id); const next = (idx + 1) % musicTracks.length; setExpandedId(musicTracks[next].id); playTrack(musicTracks[next]); }}><SkipForward className="w-4 h-4 text-white" /></button>
                  </>
                )}
                {ePlaying && (
                  <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-black/60 rounded-full px-2.5 py-1 z-20">
                    <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" /><span className="text-[10px] text-white/80">playing</span>
                  </div>
                )}
              </div>
              {/* Info + progress */}
              <div className="bg-black/80 px-5 py-4 z-30">
                <p className="text-white font-bold text-base leading-snug">{eGen.prompt?.slice(0, 80)}</p>
                <p className="text-white/80 text-sm font-medium mt-1">{eGen.authorName || ""} <span className="text-white/50">· {eDateStr}</span></p>
                <div className="flex items-center gap-2 mt-3">
                  <span className="text-[10px] text-white/50 tabular-nums">{formatDur(eActive ? currentTime : 0)}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden cursor-pointer"
                    onClick={(e) => {
                      if (!audioRef.current || !trackDuration) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const pct = (e.clientX - rect.left) / rect.width;
                      audioRef.current.currentTime = pct * trackDuration;
                      setCurrentTime(pct * trackDuration);
                    }}
                  >
                    <div className="h-full rounded-full bg-white/40 transition-all duration-200" style={{ width: `${eActive && trackDuration > 0 ? Math.min((currentTime / trackDuration) * 100, 100) : 0}%` }} />
                  </div>
                  <span className="text-[10px] text-white/50 tabular-nums">{formatDur(eActive ? trackDuration : (eGen as any).duration || 0)}</span>
                </div>
                {/* Karaoke lyrics */}
                {eActive && showKaraoke && (() => {
                  try {
                    const d = JSON.parse(eGen.resultData || "{}");
                    const lyric = d.result?.[0]?.lyric;
                    if (lyric) return (
                      <div className="mt-3 animate-in fade-in duration-300">
                        <KaraokeLyrics lyrics={lyric} currentTime={currentTime} duration={trackDuration} isPlaying={!!ePlaying} offsetSec={lyricsSpeed} />
                      </div>
                    );
                  } catch {}
                  return null;
                })()}
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/10">
                  <div className="flex items-center gap-2">
                    <button className="flex items-center gap-1.5 text-xs text-purple-300 hover:text-purple-200 transition-colors" onClick={() => { (window as any).__coverForTrack = eGen.id; (window as any).__coverPrompt = eGen.prompt?.slice(0, 100) || ""; navigate("/covers"); }}>
                      <ImageIcon className="w-3.5 h-3.5" /> Обложка
                    </button>
                    <button
                      className={`text-[10px] px-2 py-0.5 rounded-md border transition-colors ${
                        showKaraoke
                          ? "border-purple-500/30 bg-purple-500/10 text-purple-300"
                          : "border-white/10 bg-white/5 text-muted-foreground"
                      }`}
                      onClick={() => setShowKaraoke(!showKaraoke)}
                    >
                      {showKaraoke ? "Текст ✓" : "Текст"}
                    </button>
                    {showKaraoke && (
                      <div className="flex items-center gap-1">
                        <button className="text-[10px] w-5 h-5 rounded bg-white/10 text-white/60 hover:bg-white/20 flex items-center justify-center" onClick={() => setLyricsSpeed(s => Math.max(s - 1, -10))}>−</button>
                        <span className="text-[9px] text-white/40 tabular-nums w-6 text-center">{lyricsSpeed > 0 ? "+" : ""}{lyricsSpeed}s</span>
                        <button className="text-[10px] w-5 h-5 rounded bg-white/10 text-white/60 hover:bg-white/20 flex items-center justify-center" onClick={() => setLyricsSpeed(s => Math.min(s + 1, 10))}>+</button>
                      </div>
                    )}
                    {/* Repeat buttons */}
                    <button
                      className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${repeatMode === "all" ? "bg-green-500/20 text-green-300" : "bg-white/5 text-muted-foreground hover:bg-white/10"}`}
                      onClick={() => setRepeatMode(m => m === "all" ? "off" : "all")}
                      title="Плей по кругу"
                    >
                      <Repeat className="w-4 h-4" />
                    </button>
                    <button
                      className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${repeatMode === "one" ? "bg-blue-500/20 text-blue-300" : "bg-white/5 text-muted-foreground hover:bg-white/10"}`}
                      onClick={() => setRepeatMode(m => m === "one" ? "all" : "one")}
                      title="Закольцевать трек"
                    >
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12a7 7 0 1 0-3 5.7" /><polyline points="14 17 16 17.7 16.7 15.7" /><text x="12" y="15" textAnchor="middle" fontSize="9" fontWeight="700" stroke="none" fill="currentColor">1</text></svg>
                    </button>
                    {/* Eugene 2026-05-17 Босс — ползунок громкости в expanded плеере */}
                    <VolumeSlider
                      volume={volume}
                      onVolumeChange={setVolume}
                      className="w-[100px] sm:w-[130px]"
                      showPercent={false}
                    />
                  </div>
                  <button className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center hover:bg-white/20 transition-colors" onClick={() => setExpandedId(null)}>
                    <ChevronDown className="w-4 h-4 text-white/70" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Track list */}
      <div className="glass-card rounded-xl overflow-hidden divide-y divide-white/[0.04] max-h-[400px] overflow-y-auto">
        {musicTracks.map((gen, idx) => {
          const isActive = playingId === gen.id;
          const isPlaying = isActive && audioRef.current && !audioRef.current.paused;
          const isExpanded = expandedId === gen.id;
          const dateStr = gen.createdAt ? new Date(gen.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }) : "";
          return (
            <div key={gen.id}>
              <div
                className={`flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-white/[0.03] ${
                  isActive ? "bg-purple-500/[0.08]" : ""
                }`}
              >
                {/* Номер трека (ТЗ Eugene 14:06: слева номер) */}
                <span className="w-7 text-right text-xs text-muted-foreground tabular-nums shrink-0 select-none" data-testid={`track-num-${gen.id}`}>
                  {idx + 1}
                </span>
                {/* Cover — click to expand */}
                <div
                  className="w-8 h-8 rounded-md overflow-hidden shrink-0 bg-gradient-to-br from-purple-500/20 to-blue-500/20 relative group flex items-center justify-center cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : gen.id)}
                >
                  <img
                    src={getCoverUrl(gen)}
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-cover absolute inset-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                  <Music className="w-3 h-3 text-purple-400/60" />
                  <div className={`absolute inset-0 flex items-center justify-center bg-black/40 transition-opacity ${isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                    {isPlaying ? <Pause className="w-3 h-3 text-white" /> : <Play className="w-3 h-3 text-white ml-0.5" />}
                  </div>
                </div>
                {/* Title — click to play only (no expand) */}
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => togglePlay(gen)}>
                  <p className={`text-xs font-medium truncate ${isActive ? "text-purple-300" : ""}`}>{gen.prompt?.slice(0, 45)}</p>
                  <p className="text-[10px] text-muted-foreground">{gen.authorName || ""}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      (window as any).__lyricsTransfer = gen.prompt || "";
                      (window as any).__styleTransfer = gen.style || "";
                      // ТЗ Eugene 2026-05-07: при повторе из dashboard
                      // переносим voiceType исходного трека (раньше терялся
                      // → /music дефолтил на female).
                      (window as any).__voiceTypeTransfer = (gen as any).voiceType || null;
                      try {
                        sessionStorage.setItem("__voiceTypeTransfer", String((gen as any).voiceType || ""));
                      } catch {}
                      navigate("/music");
                    }}
                  >
                    <RefreshCcw className="w-3 h-3" />
                  </button>
                  <button
                    className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
                      gen.isPublic ? "hover:bg-green-500/10" : "hover:bg-white/10"
                    }`}
                    title={gen.isPublic === 1 ? "Скрыть из плейлиста" : gen.isPublic === 2 ? "На модерации" : "Опубликовать в плейлисте"}
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        // isPublic=1 → unpublish (0), isPublic=0 → request (becomes 2 for non-admin), isPublic=2 → cancel (0)
                        const newPub = gen.isPublic === 0 ? true : false;
                        await apiRequest("POST", `/api/generations/${gen.id}/privacy`, { isPublic: newPub });
                        onUpdate?.();
                      } catch {}
                    }}
                  >
                    {gen.isPublic === 1 ? <Globe className="w-3 h-3 text-green-400" /> : gen.isPublic === 2 ? <Clock className="w-3 h-3 text-yellow-400" /> : <Lock className="w-3 h-3 text-muted-foreground/40" />}
                  </button>
                  {gen.type === "cover" && (
                  <button
                    className={`w-6 h-6 rounded flex items-center justify-center transition-colors text-[10px] ${(gen as any).priorityUntil && new Date((gen as any).priorityUntil) > new Date() ? "text-yellow-400" : "text-muted-foreground/30 hover:text-yellow-400"}`}
                    title="Приоритет 7 дней"
                    onClick={async (e) => {
                      e.stopPropagation();
                      await apiRequest("POST", `/api/generations/${gen.id}/priority`, { days: 7 });
                      onUpdate?.();
                    }}
                  >⭐</button>
                  )}
                  <button
                    className="w-6 h-6 rounded flex items-center justify-center hover:bg-white/10 transition-colors"
                    onClick={(e) => { e.stopPropagation(); const a = document.createElement('a'); a.href = `/api/download/${gen.id}`; a.download = ''; document.body.appendChild(a); a.click(); document.body.removeChild(a); }}
                  >
                    <Download className="w-3 h-3 text-muted-foreground" />
                  </button>
                  {/* Копировать промт (текст + стиль) в форму генерации */}
                  {gen.status === "done" && (
                  <button
                    className="w-6 h-6 rounded flex items-center justify-center hover:bg-purple-500/20 transition-colors"
                    title="Копировать промт (стиль+текст) и создать новый трек"
                    onClick={(e) => {
                      e.stopPropagation();
                      // Извлекаем стиль из gen.style (JSON)
                      let baseStyle = "pop";
                      let fullStyle = "";
                      try {
                        const m = JSON.parse((gen as any).style || "{}");
                        baseStyle = m.style || "pop";
                        fullStyle = m.fullStyle || m.style || "";
                      } catch {}
                      // Извлекаем текст песни из gen.resultData (Suno) или из первогоначального prompt
                      let lyrics = "";
                      try {
                        const data = JSON.parse((gen as any).resultData || "{}");
                        if (Array.isArray(data.result) && data.result[0]?.lyric) {
                          lyrics = data.result[0].lyric;
                        }
                      } catch {}
                      // Fallback — оригинальный промт автора (если Suno не вернул lyric)
                      if (!lyrics) lyrics = gen.prompt || "";

                      // Ставим всё в window-глобалы + sessionStorage (выживёт рефреш)
                      (window as any).__styleTransfer = baseStyle;
                      (window as any).__fullStyleTransfer = fullStyle;
                      (window as any).__lyricsTransfer = lyrics;
                      // ТЗ Eugene 2026-05-07 §5: voiceType должен браться
                      // из исходного трека, не угадываться.
                      const transferVT = (gen as any).voiceType || null;
                      (window as any).__voiceTypeTransfer = transferVT;
                      try {
                        sessionStorage.setItem("__styleTransfer", baseStyle);
                        sessionStorage.setItem("__fullStyleTransfer", fullStyle || "");
                        sessionStorage.setItem("__lyricsTransfer", lyrics);
                        sessionStorage.setItem("__voiceTypeTransfer", String(transferVT || ""));
                      } catch {}
                      // Дополнительно — в буфер обмена
                      try {
                        const text = `Стиль: ${fullStyle || baseStyle}\n\nТекст:\n${lyrics}`;
                        navigator.clipboard?.writeText(text).catch(() => {});
                      } catch {}
                      toast({ title: "Промт скопирован", description: "Открываю форму создания трека…" });
                      // Навигация через wouter (работает в SPA без релоада)
                      navigate("/music");
                      // Подстраховка: если по какой-то причине роутер не отреагировал, форсируем hash + событие
                      setTimeout(() => {
                        if (!window.location.hash.includes("/music")) {
                          window.location.hash = "/music";
                          window.dispatchEvent(new HashChangeEvent("hashchange"));
                        }
                      }, 50);
                    }}
                    data-testid={`btn-copy-prompt-${gen.id}`}
                  >
                    <Copy className="w-3 h-3 text-purple-400" />
                  </button>
                  )}
                  {/* Cover — сменить стиль (только для своих треков автора) */}
                  {gen.status === "done" && (
                  <button
                    className="w-6 h-6 rounded flex items-center justify-center hover:bg-amber-500/20 transition-colors"
                    title="Кавер — сменить стиль"
                    onClick={(e) => { e.stopPropagation(); setRemixDialog({ open: true, mode: 'cover', track: gen }); }}
                    data-testid={`btn-cover-${gen.id}`}
                  >
                    <Repeat className="w-3 h-3 text-amber-400" />
                  </button>
                  )}
                  {/* Extend — продлить (только для своих) */}
                  {gen.status === "done" && (
                  <button
                    className="w-6 h-6 rounded flex items-center justify-center hover:bg-emerald-500/20 transition-colors"
                    title="Продлить трек"
                    onClick={(e) => { e.stopPropagation(); setRemixDialog({ open: true, mode: 'extend', track: gen }); }}
                    data-testid={`btn-extend-${gen.id}`}
                  >
                    <FastForward className="w-3 h-3 text-emerald-400" />
                  </button>
                  )}
                  <button
                    className="w-6 h-6 rounded flex items-center justify-center hover:bg-white/10 transition-colors"
                    title="Поделиться"
                    onClick={async (e) => {
                      e.stopPropagation();
                      const shareUrl = `https://muziai.ru/share/${gen.id}`;
                      const t = (gen as any).displayTitle || gen.prompt?.slice(0, 50) || 'MuzaAi';
                      if (navigator.share) {
                        try { await navigator.share({ title: `Послушай на MuzaAi.ru`, text: t, url: shareUrl }); return; } catch {}
                      }
                      navigator.clipboard.writeText(shareUrl);
                      toast({ title: "Ссылка скопирована" });
                    }}
                  >
                    <Share2 className="w-3 h-3 text-muted-foreground" />
                  </button>
                </div>
              </div>

            </div>
          );
        })}
      </div>

      {/* Geo-activity dialog — админ видит географию слушателей */}
      <GeoActivityDialog
        genId={geoDialog.genId}
        open={geoDialog.open}
        onClose={() => setGeoDialog({ open: false, genId: null, title: "" })}
        title={geoDialog.title}
      />

      {/* Cover / Extend dialog — только для своих треков автора */}
      <Dialog open={remixDialog.open} onOpenChange={(o) => { if (!o) { setRemixDialog({ open: false, mode: null, track: null }); setRemixStyle(""); } }}>
        <DialogContent className="glass-card border-purple-500/20 max-w-md" data-testid="dialog-remix">
          <DialogHeader>
            <DialogTitle className="gradient-text text-lg flex items-center gap-2">
              {remixDialog.mode === 'cover' ? (<>⚡ Кавер — сменить стиль</>) : (<>⏩ Продлить трек</>)}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              {remixDialog.mode === 'cover'
                ? 'Та же мелодия, но в новом жанре. Например «джаз, медленный, женский вокал».'
                : 'Добавить куплет / припев / финал. Укажите время, с которого продолжить.'}
            </DialogDescription>
          </DialogHeader>

          {remixDialog.track && (
            <div className="py-2 space-y-3">
              <div className="text-xs text-muted-foreground">
                Исходный: <span className="text-foreground font-medium">{(remixDialog.track as any).displayTitle || remixDialog.track.prompt?.slice(0, 60)}</span>
              </div>

              {remixDialog.mode === 'cover' ? (
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Новый стиль</label>
                  <input
                    type="text"
                    value={remixStyle}
                    onChange={e => setRemixStyle(e.target.value)}
                    placeholder="jazz, slow, female vocal"
                    className="w-full bg-background/50 border border-white/10 rounded-lg px-3 py-2 text-sm focus:border-purple-500/50 outline-none"
                    data-testid="input-remix-style"
                  />
                  <div className="flex flex-wrap gap-1">
                    {['jazz, smooth, slow', 'rock, energetic', 'lo-fi, dreamy', 'classical, piano', 'reggae, relaxed'].map(s => (
                      <button key={s} onClick={() => setRemixStyle(s)} className="text-[10px] px-2 py-0.5 rounded-md bg-white/5 hover:bg-white/10 text-muted-foreground border border-white/10">
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Продолжить с (секунд)</label>
                  <input
                    type="number"
                    min={0}
                    max={300}
                    value={remixContinueAt}
                    onChange={e => setRemixContinueAt(parseInt(e.target.value) || 0)}
                    className="w-full bg-background/50 border border-white/10 rounded-lg px-3 py-2 text-sm focus:border-emerald-500/50 outline-none"
                    data-testid="input-remix-continue"
                  />
                  <label className="text-xs text-muted-foreground">Подсказка (чем продолжить)</label>
                  <input
                    type="text"
                    value={remixStyle}
                    onChange={e => setRemixStyle(e.target.value)}
                    placeholder="эпичный финал со струнными"
                    className="w-full bg-background/50 border border-white/10 rounded-lg px-3 py-2 text-sm focus:border-emerald-500/50 outline-none"
                    data-testid="input-remix-prompt"
                  />
                </div>
              )}

              <button
                disabled={remixLoading || (remixDialog.mode === 'cover' && remixStyle.length < 3)}
                onClick={async () => {
                  if (!remixDialog.track) return;
                  setRemixLoading(true);
                  try {
                    const endpoint = remixDialog.mode === 'cover' ? '/api/music/style-cover' : '/api/music/extend';
                    const body: any = { sourceId: remixDialog.track.id };
                    if (remixDialog.mode === 'cover') body.newStyle = remixStyle;
                    else { body.continueAt = remixContinueAt; if (remixStyle) body.prompt = remixStyle; }
                    const r = await apiRequest('POST', endpoint, body);
                    const j = await r.json();
                    toast({ title: remixDialog.mode === 'cover' ? 'Кавер запущен' : 'Продление запущено', description: j.message || 'Готовость — 1–2 минуты' });
                    setRemixDialog({ open: false, mode: null, track: null });
                    setRemixStyle("");
                    onUpdate?.();
                  } catch (e: any) {
                    let msg = e.message || "Ошибка";
                    try { const m = e.message?.match(/^\d+:\s*(.+)$/); if (m) { const p = JSON.parse(m[1]); msg = p.message || p.error || msg; } } catch {}
                    toast({ title: "Ошибка", description: msg, variant: "destructive" });
                  } finally { setRemixLoading(false); }
                }}
                className={`w-full py-2.5 rounded-xl text-white text-sm font-medium transition-all ${remixDialog.mode === 'cover' ? 'bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500' : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500'} disabled:opacity-50`}
                data-testid="btn-remix-submit"
              >
                {remixLoading ? 'Запуск…' : (remixDialog.mode === 'cover' ? 'Создать кавер (299 ₽)' : 'Продлить (299 ₽)')}
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {/* Eugene 2026-05-16 Босс «🔍 Детали» — full-screen modal обложки.
          Renders only when `current` exists; click anywhere → close. */}
      <CoverDetailsModal
        open={detailsOpen && !!current}
        onClose={() => setDetailsOpen(false)}
        onNext={skipNext}
        onPrev={skipPrev}
        track={current ? {
          id: current.id,
          imageUrl: getCoverUrl(current),
          displayTitle: (current as any).displayTitle,
          prompt: current.prompt,
          authorName: (current as any).authorName,
          createdAt: current.createdAt,
          styleInfo: null,
        } : null}
        // Eugene 2026-05-17 — full player controls внутри модалки.
        // isPlaying derived: audio экземпляр в parent — не remount.
        isPlaying={!!(audioRef.current && !audioRef.current.paused && playingId === current?.id)}
        onPlayPause={() => current && togglePlay(current)}
        currentTime={currentTime}
        duration={trackDuration}
        onSeek={(s) => {
          if (audioRef.current) {
            audioRef.current.currentTime = s;
            setCurrentTime(s);
          }
        }}
        volume={volume}
        onVolumeChange={setVolume}
        repeatMode={repeatMode}
        onRepeatToggle={() => setRepeatMode(m => m === "off" ? "all" : m === "all" ? "one" : "off")}
      />
    </div>
  );
}

function MyPlaylistWrapper() {
  const { data: myGens } = useQuery<Generation[]>({
    queryKey: ["/api/generations", "my-playlist"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/generations");
      return res.json();
    },
  });
  return <MyPlaylist generations={myGens} onUpdate={() => {
    // Принудительный refetch — invalidateQueries не работает с staleTime: Infinity
    queryClient.refetchQueries({ queryKey: ["/api/generations"] });
    queryClient.refetchQueries({ queryKey: ["/api/generations", "my-playlist"] });
  }} />;
}

// MyDraftsSection (Eugene 2026-05-11): сохранённые идеи/тексты будущих
// песен. Юзер редактирует здесь → нажимает «Сгенерировать» → откроется
// /music с pre-filled полями.
type SongDraft = {
  id: number;
  title: string | null;
  lyrics: string | null;
  prompt: string | null;
  style: string | null;
  voice: string | null;
  mood: string | null;
  tempo: string | null;
  bpm: number | null;
  source: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

function MyDraftsSection() {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<Partial<SongDraft>>({ title: "", lyrics: "", style: "pop", voice: "female", mood: "" });
  const [expanded, setExpanded] = useState(true);

  const { data, isLoading, refetch } = useQuery<{ data: SongDraft[] }>({
    queryKey: ["/api/drafts"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/drafts");
      return r.json();
    },
  });
  const drafts = data?.data || [];

  const save = async () => {
    try {
      const body = JSON.stringify({ ...form, source: "dashboard" });
      const url = editingId === "new" ? "/api/drafts" : `/api/drafts/${editingId}`;
      const method = editingId === "new" ? "POST" : "PUT";
      const r = await apiRequest(method, url, JSON.parse(body));
      if (!r.ok) throw new Error("save failed");
      toast({ title: "✓ Сохранено" });
      setEditingId(null);
      setForm({ title: "", lyrics: "", style: "pop", voice: "female", mood: "" });
      refetch();
    } catch {
      toast({ title: "Ошибка сохранения", variant: "destructive" });
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Удалить черновик?")) return;
    try {
      const r = await apiRequest("DELETE", `/api/drafts/${id}`);
      if (!r.ok) throw new Error("delete failed");
      refetch();
    } catch {
      toast({ title: "Ошибка удаления", variant: "destructive" });
    }
  };

  const generate = (d: SongDraft) => {
    const params = new URLSearchParams();
    if (d.lyrics && d.lyrics.length >= 50) {
      params.set("mode", "advanced");
      params.set("lyrics", d.lyrics);
    } else if (d.prompt) {
      params.set("mode", "basic");
      params.set("prompt", d.prompt);
    } else if (d.lyrics) {
      params.set("mode", "advanced");
      params.set("lyrics", d.lyrics);
    } else {
      params.set("mode", "advanced");
    }
    if (d.title) params.set("title", d.title);
    if (d.style) params.set("style", d.style);
    if (d.voice) params.set("voice", d.voice);
    if (d.mood) params.set("mood", d.mood);
    if (d.tempo) params.set("tempo", d.tempo);
    window.location.hash = `#/music?${params.toString()}`;
  };

  return (
    <div className="mb-6 rounded-2xl border border-white/[0.06] bg-gradient-to-br from-purple-500/[0.04] to-transparent">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-white hover:bg-white/[0.02] transition-colors rounded-2xl"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="flex items-center gap-2">
          📝 <span>Мои тексты <span className="text-muted-foreground font-normal">({drafts.length})</span></span>
        </span>
        <span className={`text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}>▾</span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-white/[0.04] pt-3">
          {isLoading && <p className="text-xs text-muted-foreground">Загружаю…</p>}
          {!isLoading && drafts.length === 0 && editingId === null && (
            <p className="text-xs text-muted-foreground">Сохраняйте идеи будущих песен — потом одним кликом превратите в трек.</p>
          )}
          {drafts.map(d => (
            <div key={d.id} className="rounded-xl border border-white/[0.06] bg-background/40 p-3">
              {editingId === d.id ? (
                <DraftForm form={form} setForm={setForm} onSave={save} onCancel={() => { setEditingId(null); setForm({}); }} />
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <p className="font-medium text-sm text-white truncate flex-1">{d.title || "Без названия"}</p>
                    <span className="text-[10px] text-muted-foreground/60 whitespace-nowrap">{d.updatedAt ? new Date(d.updatedAt).toLocaleDateString("ru-RU") : ""}</span>
                  </div>
                  {d.lyrics && <p className="text-xs text-muted-foreground line-clamp-2 mb-2 whitespace-pre-wrap">{d.lyrics.slice(0, 200)}{d.lyrics.length > 200 ? "…" : ""}</p>}
                  {!d.lyrics && d.prompt && <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{d.prompt}</p>}
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/80 mb-2">
                    {d.style && <span className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300/80">{d.style}</span>}
                    {d.voice && <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300/80">{d.voice === "female" ? "👩‍🎤" : d.voice === "male" ? "👨‍🎤" : d.voice === "duet" ? "👩‍🎤👨‍🎤" : "🎻"}</span>}
                    {d.mood && <span className="px-1.5 py-0.5 rounded bg-pink-500/10 text-pink-300/80">{d.mood}</span>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => generate(d)} className="text-xs px-3 py-1.5 rounded-lg btn-cosmic font-semibold text-white">
                      🎵 Сгенерировать
                    </button>
                    <button onClick={() => { setEditingId(d.id); setForm(d); }} className="text-xs px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-muted-foreground hover:text-white transition-colors">
                      ✏ Редактировать
                    </button>
                    <button onClick={() => remove(d.id)} className="text-xs px-3 py-1.5 rounded-lg border border-rose-500/20 bg-rose-500/5 text-rose-400/70 hover:text-rose-300 transition-colors">
                      🗑
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          {editingId === "new" ? (
            <div className="rounded-xl border border-purple-500/20 bg-purple-500/[0.04] p-3">
              <DraftForm form={form} setForm={setForm} onSave={save} onCancel={() => { setEditingId(null); setForm({}); }} />
            </div>
          ) : (
            <button
              onClick={() => { setEditingId("new"); setForm({ title: "", lyrics: "", style: "pop", voice: "female", mood: "" }); }}
              className="w-full text-xs px-3 py-2 rounded-lg border border-dashed border-white/15 text-muted-foreground hover:text-white hover:border-white/30 transition-colors"
            >
              ➕ Новый текст
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Eugene 2026-05-16 Босс «errored треки вниз + предложение удалить через 1/7/15/30 дней».
// Dropdown открывается над/под кнопкой, options закрепляют scheduled_delete_at
// через POST /api/generations/:id/schedule-delete. Если уже выставлен —
// показывает «🗑 Удалится через X · отменить».
function ScheduleDeleteDropdown({ gen, onUpdate }: { gen: Generation; onUpdate?: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const scheduled = (gen as any).scheduledDeleteAt as string | null | undefined;
  const scheduledMs = scheduled ? new Date(scheduled).getTime() : 0;
  const remainingDays = scheduledMs > 0 ? Math.max(0, Math.ceil((scheduledMs - Date.now()) / (24 * 60 * 60 * 1000))) : 0;

  const schedule = async (days: number) => {
    setBusy(true);
    setOpen(false);
    try {
      const res = await apiRequest("POST", `/api/generations/${gen.id}/schedule-delete`, { deleteAfterDays: days });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.message || "Не удалось");
      toast({
        title: `Будет удалено через ${days} ${days === 1 ? "день" : days < 5 ? "дня" : "дней"}`,
        description: "Можно восстановить из этой же кнопки до тех пор.",
      });
      onUpdate?.();
    } catch (e: any) {
      toast({ title: "Ошибка", description: String(e?.message || e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setOpen(false);
    try {
      const res = await apiRequest("POST", `/api/generations/${gen.id}/schedule-delete/cancel`, {});
      if (!res.ok) throw new Error("Не удалось");
      toast({ title: "Удаление отменено" });
      onUpdate?.();
    } catch (e: any) {
      toast({ title: "Ошибка", description: String(e?.message || e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative mt-2" onClick={(e) => e.stopPropagation()}>
      {scheduled && remainingDays > 0 ? (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-500/10 border border-orange-500/20">
          <Trash2 className="w-3.5 h-3.5 text-orange-400 shrink-0" />
          <p className="text-xs text-orange-200 flex-1 leading-tight">
            Будет удалено через {remainingDays} {remainingDays === 1 ? "день" : remainingDays < 5 ? "дня" : "дней"}
          </p>
          <button
            type="button"
            className="text-xs text-orange-300 hover:text-orange-200 underline disabled:opacity-50"
            onClick={cancel}
            disabled={busy}
            data-testid={`btn-schedule-delete-cancel-${gen.id}`}
          >
            Отменить
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300 hover:bg-red-500/15 hover:text-red-200 transition-colors disabled:opacity-50"
            onClick={() => setOpen(v => !v)}
            disabled={busy}
            data-testid={`btn-schedule-delete-${gen.id}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Удалить через…</span>
            <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
          {open && (
            <div className="absolute left-0 right-0 mt-1 z-30 rounded-lg bg-zinc-900 border border-white/10 shadow-xl shadow-black/40 overflow-hidden">
              {[1, 7, 15, 30].map(d => (
                <button
                  key={d}
                  type="button"
                  className="w-full px-3 py-2 text-left text-xs text-white/90 hover:bg-red-500/15 hover:text-red-200 transition-colors flex items-center justify-between"
                  onClick={() => schedule(d)}
                  disabled={busy}
                  data-testid={`btn-schedule-delete-${gen.id}-${d}`}
                >
                  <span>{d} {d === 1 ? "день" : d < 5 ? "дня" : "дней"}</span>
                  <span className="text-[10px] text-white/40">через {d}д</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DraftForm({ form, setForm, onSave, onCancel }: { form: Partial<SongDraft>; setForm: (f: Partial<SongDraft>) => void; onSave: () => void; onCancel: () => void }) {
  return (
    <div className="space-y-2">
      <input
        type="text"
        placeholder="Название (опционально)"
        value={form.title || ""}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
        className="w-full px-3 py-2 text-sm rounded-lg bg-background/50 border border-white/10 text-white"
      />
      <textarea
        placeholder="Текст песни или идея — что и для кого…"
        value={form.lyrics || ""}
        onChange={(e) => setForm({ ...form, lyrics: e.target.value })}
        rows={5}
        className="w-full px-3 py-2 text-sm rounded-lg bg-background/50 border border-white/10 text-white resize-none"
      />
      <div className="grid grid-cols-2 gap-2">
        <select value={form.style || ""} onChange={(e) => setForm({ ...form, style: e.target.value })} className="px-2 py-1.5 text-xs rounded-lg bg-background/50 border border-white/10 text-white">
          <option value="">Стиль…</option>
          <option value="pop">Поп</option>
          <option value="rock">Рок</option>
          <option value="lullaby">Колыбельная</option>
          <option value="chanson">Шансон</option>
          <option value="hiphop">Хип-хоп</option>
          <option value="electronic">Электронная</option>
          <option value="folk">Фолк</option>
          <option value="acoustic-guitar">Акустика</option>
          <option value="orchestral">Оркестровая</option>
          <option value="lounge">Лаундж</option>
        </select>
        <select value={form.voice || ""} onChange={(e) => setForm({ ...form, voice: e.target.value })} className="px-2 py-1.5 text-xs rounded-lg bg-background/50 border border-white/10 text-white">
          <option value="">Голос…</option>
          <option value="female">Женский</option>
          <option value="male">Мужской</option>
          <option value="duet">Дуэт</option>
          <option value="instrumental">Инструментал</option>
        </select>
      </div>
      <div className="flex gap-2 pt-1">
        <button onClick={onSave} className="flex-1 text-xs px-3 py-1.5 rounded-lg btn-cosmic font-semibold text-white">💾 Сохранить</button>
        <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-lg border border-white/10 text-muted-foreground hover:text-white transition-colors">Отмена</button>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { user, refreshUser, isLoading: authLoading } = useAuth();
  // Eugene 2026-05-15 hotfix: isAdmin + geoDialog были только в MyPlaylist
  // scope, но используются и в основном render DashboardPage (map треков).
  // Без них на prod — ReferenceError при рендере /dashboard.
  const isAdmin = user?.email === "egnovoselov@gmail.com";
  const [geoDialog, setGeoDialog] = useState<{ open: boolean; genId: number | null; title: string }>({ open: false, genId: null, title: "" });
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [toppingUp, setToppingUp] = useState(false);
  const [selectedGen, setSelectedGen] = useState<Generation | null>(null);
  // Eugene 2026-05-15 Босс «обязательно подтверждение автором смены стиля».
  const [pendingCategoryChange, setPendingCategoryChange] = useState<{ from: string; to: string; label: string } | null>(null);
  const [categoryChangeLoading, setCategoryChangeLoading] = useState(false);

  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  const startEditName = () => {
    setNameValue(user?.name || "");
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const saveName = async () => {
    if (!nameValue.trim()) { setEditingName(false); return; }
    try {
      const res = await apiRequest("POST", "/api/auth/update-name", { name: nameValue.trim() });
      const data = await res.json();
      if (data.pendingConfirmation) {
        toast({
          title: "Письмо отправлено",
          description: `Подтвердите смену имени по ссылке в письме на ${user?.email}. Имя изменится во всех плейлистах.`,
        });
      } else {
        toast({ title: "Имя не изменилось" });
      }
    } catch {
      toast({ title: "Ошибка", variant: "destructive" });
    }
    setEditingName(false);
  };

  // ВАЖНО (Eugene 2026-05-07 11:35): NO conditional returns here.
  // Все hooks должны вызываться в одном порядке (Rules of Hooks).
  // Auth-guard перенесён ВНИЗ — после всех хуков (см. ~line 1635).

  const [showAllGens, setShowAllGens] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [genTypeFilter, setGenTypeFilter] = useState<"all" | "music" | "cover" | "lyrics">("all");
  const [sortByPlays, setSortByPlays] = useState(false);
  const [genSearch, setGenSearch] = useState("");
  const [showTxns, setShowTxns] = useState(false);

  const { data: generations, isLoading: gensLoading } = useQuery<(Generation & { plays?: number })[]>({
    queryKey: ["/api/generations", showAllGens ? "all" : showDeleted ? "deleted" : "my", sortByPlays ? "plays" : ""],
    queryFn: async () => {
      const url = showAllGens && user?.role === "admin"
        ? `/api/generations?all=true${sortByPlays ? "&sort=plays" : ""}`
        : showDeleted
        ? "/api/generations?deleted=true"
        : "/api/generations";
      const res = await apiRequest("GET", url);
      return res.json();
    },
    // Eugene 2026-05-08: автоматически refetch'аем каждые 10 сек если есть
    // processing gens — статус-баннер обновится без F5.
    refetchInterval: (query) => {
      const data = query.state.data as any[] | undefined;
      const hasProcessing = (data || []).some((g) => g?.status === "processing");
      return hasProcessing ? 10_000 : false;
    },
  });
  // Активные processing gens — для статус-баннера.
  // Eugene 2026-05-14 Босс: фильтруем СВЕЖИЕ (< 60 мин). Старше — это
  // зависшие, баннер их не показывает. Backend cleanupStaleProcessing
  // закрывает >24ч + broken (no taskId) автоматически каждую минуту.
  const ACTIVE_BANNER_MAX_MIN = 60;
  const activeGens = (generations || []).filter((g) => {
    if (g.status !== "processing") return false;
    const ageMin = (Date.now() - new Date(g.createdAt || "").getTime()) / 60000;
    return ageMin < ACTIVE_BANNER_MAX_MIN;
  });

  const { data: txns, isLoading: txnsLoading } = useQuery<Transaction[]>({
    queryKey: ["/api/transactions"],
  });

  const [showTopup, setShowTopup] = useState(false);
  const topupAmounts = [
    { value: 99, label: "99 ₽", desc: "1 текст" },
    { value: 300, label: "300 ₽", desc: "3 текста или 1 музыка" },
    { value: 500, label: "500 ₽", desc: "2 музыки + текст" },
    { value: 1000, label: "1 000 ₽", desc: "5 музыки" },
  ];

  const handleTopup = async (amount: number) => {
    setToppingUp(true);
    try {
      const res = await apiRequest("POST", "/api/payment/create", { amount });
      const data = await res.json();
      if (data.paymentUrl) {
        // Redirect юзера в Robokassa. После оплаты:
        // - Robokassa делает server-to-server POST на /api/payment/result
        //   (signature verified Password2, баланс кредитуется, OK<InvId> в ответ)
        // - Robokassa редиректит юзера на /api/payment/success → /#/payment/success
        // См. docs/strategy/ROBOKASSA-INTEGRATION-PLAN.md
        window.location.href = data.paymentUrl;
        return;
      }
      // 503/4xx без paymentUrl — показываем понятную ошибку (раньше молча
      // снимали spinner и юзер ничего не видел).
      toast({
        title: "Не удалось создать платёж",
        description: data.message || "Попробуйте через минуту или напишите в поддержку.",
        variant: "destructive",
      });
    } catch (err: any) {
      toast({ title: "Ошибка", description: err.message || "Сетевая ошибка", variant: "destructive" });
    } finally {
      setToppingUp(false);
    }
  };

  // Promo code in dashboard
  const [promoCode, setPromoCode] = useState("");
  const [promoLoading, setPromoLoading] = useState(false);
  const [showPromoInput, setShowPromoInput] = useState(false);

  // ============================================================
  // Auth-guard перенесён сюда из верхушки (Eugene 2026-05-07 11:35)
  // — закрывает React #310 «больше hooks чем в предыдущем рендере».
  // Все hooks выше выполняются всегда, независимо от user-state.
  // ============================================================
  if (!authLoading && !user) {
    navigate("/login");
    return null;
  }
  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
      </div>
    );
  }

  const handleApplyPromo = async () => {
    if (!promoCode.trim()) return;
    setPromoLoading(true);
    try {
      const res = await apiRequest("POST", "/api/promo/apply", { code: promoCode.trim() });
      const data = await res.json();
      toast({ title: "Промокод активирован", description: data.message });
      setPromoCode("");
      setShowPromoInput(false);
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    } catch (err: any) {
      const msg = err.message || "Ошибка";
      toast({ title: "Ошибка", description: msg, variant: "destructive" });
    } finally {
      setPromoLoading(false);
    }
  };

  const formatBalance = (kopecks: number) => `${Math.floor(kopecks / 100)} ₽`;
  const formatDate = (d: string | null) => {
    if (!d) return "";
    const date = new Date(d);
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="min-h-screen pt-20 px-4 pb-12">
      {/* Eugene 2026-05-15 Босс «уменьшить рабочую часть на десктопе на 25%
          пропорционально, чтобы обложка с плеером была видна». На lg+
          max-w-5xl (1024px) → max-w-3xl (768px) = -25%. Mobile/tablet
          unchanged (там и так full-width до 5xl). */}
      <div className="max-w-5xl lg:max-w-3xl mx-auto">
        {/* Header */}
        {/* Eugene 2026-05-16 Босс «кнопка На главную вверху /dashboard».
            Размещена справа через ml-auto. На mobile (< sm) — компактная
            (только иконка + короткий лейбл), на desktop — полная. */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
            <LayoutDashboard className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold text-white" data-testid="text-dashboard-title">Личный кабинет</h1>
            <p className="text-sm text-muted-foreground flex items-center gap-1 flex-wrap">
              Привет,{" "}
              {editingName ? (
                <input
                  ref={nameInputRef}
                  className="bg-white/10 text-white text-sm rounded px-2 py-0.5 border border-purple-500/40 outline-none w-36"
                  value={nameValue}
                  onChange={e => setNameValue(e.target.value)}
                  onBlur={saveName}
                  onKeyDown={e => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }}
                  data-testid="input-edit-name"
                />
              ) : (
                <button
                  className="inline-flex items-center gap-1 text-white font-medium hover:text-purple-300 transition-colors group"
                  onClick={startEditName}
                  data-testid="button-edit-name"
                >
                  {user.name}
                  <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity text-purple-400" />
                </button>
              )}
              ! <span className="text-purple-400">Автор #{user.id}</span>
            </p>
          </div>
          <button
            onClick={() => navigate("/")}
            className="ml-auto shrink-0 inline-flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl border border-purple-400/40 bg-gradient-to-r from-purple-500/15 via-violet-500/10 to-blue-500/15 text-purple-100 hover:from-purple-500/25 hover:via-violet-500/20 hover:to-blue-500/25 hover:border-purple-300/60 transition-colors text-sm sm:text-base font-medium shadow-[0_0_16px_rgba(168,85,247,0.12)]"
            data-testid="button-go-home"
            aria-label="На главную"
            title="На главную"
          >
            <Home className="w-4 h-4 sm:w-5 sm:h-5" />
            <span className="hidden sm:inline">На главную</span>
            <span className="sm:hidden">Главная</span>
          </button>
        </div>

        {/* Eugene 2026-05-15 Босс «фикс для объединения у кого ранее была почта».
            Banner для phone-only юзеров (email = NNN@phone.muziai.ru placeholder).
            Кликабельный → открывает LinkExistingDialog. Dismissable через
            localStorage. */}
        {user?.email?.endsWith("@phone.muziai.ru") && !localStorage.getItem(`linkBannerDismissed:${user.id}`) && (
          <LinkExistingBanner userId={user.id} userPhone={(user as any).phone} onDone={() => refreshUser?.()} />
        )}

        {/* Admin Stats */}
        {user?.email === "egnovoselov@gmail.com" && (
          <>
            {/* v304 Admin Panel — кнопка-переход для админа */}
            <div className="mb-6 p-4 rounded-2xl border border-primary/40 bg-primary/5">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold">v304 Admin Panel</div>
                  <div className="text-sm text-muted-foreground">
                    Шаблоны, feature flags, лиды, audit log с restore.
                  </div>
                </div>
                <a
                  href="#/admin"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition"
                >
                  Открыть →
                </a>
              </div>
            </div>
            <AdminStats /><PendingPublications /><TopGenStats />
          </>
        )}


        {/* Balance Card */}
        <div className="gradient-border p-6 rounded-2xl mb-8">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className="text-sm text-muted-foreground mb-1">Баланс</p>
              <div className="flex items-baseline gap-3">
                <p className="text-3xl font-bold gradient-text" data-testid="text-balance">
                  {formatBalance(user.balance)}
                </p>
                {(user as any).bonusTracks > 0 && (
                  <GiftBadge count={(user as any).bonusTracks} size="md" label={(user as any).bonusTracks === 1 ? "трек в подарок" : "трека в подарок"} />
                )}
              </div>
              {(user.balance > 0 || (user as any).bonusTracks > 0) && (
                <p className="text-xs text-muted-foreground mt-1">
                  ≈ <span className="text-purple-300 font-medium">{Math.floor(user.balance / 29900) + ((user as any).bonusTracks || 0)}</span> {(() => { const n = Math.floor(user.balance / 29900) + ((user as any).bonusTracks || 0); const m = n % 10; const d = n % 100; if (d >= 11 && d <= 19) return "песен"; if (m === 1) return "песня"; if (m >= 2 && m <= 4) return "песни"; return "песен"; })()} {(user as any).bonusTracks > 0 ? <span className="text-green-400">({(user as any).bonusTracks} подарочн.)</span> : null} · <span className="text-blue-300 font-medium">{Math.floor(user.balance / 9900)}</span> {(() => { const n = Math.floor(user.balance / 9900); const m = n % 10; const d = n % 100; if (d >= 11 && d <= 19) return "текстов"; if (m === 1) return "текст"; if (m >= 2 && m <= 4) return "текста"; return "текстов"; })()} · <span className="text-cyan-300 font-medium">{Math.floor(user.balance / 9900)}</span> {(() => { const n = Math.floor(user.balance / 9900); const m = n % 10; const d = n % 100; if (d >= 11 && d <= 19) return "обложек"; if (m === 1) return "обложка"; if (m >= 2 && m <= 4) return "обложки"; return "обложек"; })()}
                </p>
              )}
            </div>
            <Button
              className="btn-gradient rounded-xl px-6"
              onClick={() => setShowTopup(true)}
              disabled={toppingUp}
              data-testid="button-topup"
            >
              {toppingUp ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <CreditCard className="w-4 h-4 mr-2" />
                  Пополнить баланс
                </>
              )}
            </Button>
          </div>
          {/* Promo code section */}
          <div className="mt-4 pt-4 border-t border-white/[0.06]">
            {!showPromoInput ? (
              <button
                onClick={() => setShowPromoInput(true)}
                className="flex items-center gap-2 text-xs text-purple-400 hover:text-purple-300 transition-colors"
                data-testid="button-show-promo"
              >
                <Ticket className="w-3.5 h-3.5" />
                У меня есть промокод
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={promoCode}
                  onChange={(e) => setPromoCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleApplyPromo()}
                  placeholder="Введите промокод"
                  className="flex-1 px-3 py-1.5 rounded-lg text-sm bg-white/5 border border-white/10 text-white placeholder:text-muted-foreground/50 focus:outline-none focus:border-purple-500/50"
                  autoFocus
                  data-testid="input-dashboard-promo"
                />
                <Button
                  size="sm"
                  className="btn-gradient rounded-lg px-4 h-8 text-xs"
                  onClick={handleApplyPromo}
                  disabled={promoLoading || !promoCode.trim()}
                  data-testid="button-apply-promo"
                >
                  {promoLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Применить"}
                </Button>
                <button
                  onClick={() => { setShowPromoInput(false); setPromoCode(""); }}
                  className="text-xs text-muted-foreground hover:text-white transition-colors"
                >
                  ×
                </button>
              </div>
            )}
          </div>

          {/* Referral section under balance */}
          <div className="mt-4 pt-4 border-t border-white/[0.06]">
            <ReferralInfo />
          </div>
        </div>

        {/* Topup Modal */}
        <Dialog open={showTopup} onOpenChange={setShowTopup}>
          <DialogContent className="glass-card border-purple-500/20 max-w-sm">
            <DialogHeader>
              <DialogTitle className="gradient-text text-lg">Пополнение баланса</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground mb-4">Выберите сумму. Оплата картой через Робокассу.</p>
            <div className="grid grid-cols-2 gap-3">
              {topupAmounts.map((item) => (
                <button
                  key={item.value}
                  className="glass-card rounded-xl p-4 text-center hover:border-purple-500/40 transition-colors cursor-pointer"
                  onClick={() => handleTopup(item.value)}
                  disabled={toppingUp}
                  data-testid={`topup-${item.value}`}
                >
                  <p className="text-lg font-bold gradient-text">{item.label}</p>
                  <p className="text-xs text-muted-foreground mt-1">{item.desc}</p>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground text-center mt-2">Карты МИР, Visa, MC • СБП • T-Pay</p>
          </DialogContent>
        </Dialog>

        {/* My Drafts — сохранённые идеи/тексты, готовые к генерации одним кликом */}
        <MyDraftsSection />

        {/* My Playlist — always uses own generations, not affected by deleted/all filters */}
        <MyPlaylistWrapper />

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Generations History */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Clock className="w-4 h-4 text-purple-400" />
                {showAllGens ? "Все генерации" : showDeleted ? "Удалённые" : "История генераций"}
              </h2>
              {/* Type filter tabs */}
              <div className="flex items-center gap-1">
                {(["all", "music", "cover", "lyrics"] as const).map(t => (
                  <button key={t} onClick={() => setGenTypeFilter(t)}
                    className={`text-[11px] px-2.5 py-1 rounded-lg transition-colors ${genTypeFilter === t ? "bg-purple-500/20 text-purple-300 border border-purple-500/30" : "text-muted-foreground hover:text-white border border-transparent"}`}
                  >{t === "all" ? "Все" : t === "music" ? "Музыка" : t === "cover" ? "Обложки" : "Тексты"}</button>
                ))}
                {user?.email === "egnovoselov@gmail.com" && genTypeFilter === "cover" && (
                  <button
                    className="text-[11px] px-2.5 py-1 rounded-lg bg-green-500/10 text-green-400 border border-green-500/30 hover:bg-green-500/20 transition-colors"
                    onClick={async () => {
                      await apiRequest("POST", "/api/admin/publish-all-covers", {});
                      queryClient.invalidateQueries();
                      toast({ title: "Все обложки опубликованы" });
                    }}
                  >Опубликовать всё</button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  className={`text-xs px-3 py-1 rounded-lg border transition-colors ${
                    showDeleted
                      ? "border-red-500/30 bg-red-500/10 text-red-400"
                      : "border-white/10 bg-white/5 text-muted-foreground hover:text-white"
                  }`}
                  onClick={() => { setShowDeleted(!showDeleted); setShowAllGens(false); }}
                  data-testid="button-toggle-deleted"
                >
                  <Trash2 className="w-3 h-3 inline mr-1" />
                  {showDeleted ? "Мои работы" : "Удалённые"}
                </button>
                {user?.email === "egnovoselov@gmail.com" && !showDeleted && (
                  <>
                    {user?.email === "egnovoselov@gmail.com" && (
                      <button
                        className={`text-xs px-3 py-1 rounded-lg border transition-colors ${
                          showAllGens
                            ? "border-purple-500/30 bg-purple-500/10 text-purple-400"
                            : "border-white/10 bg-white/5 text-muted-foreground hover:text-white"
                        }`}
                        onClick={() => { setShowAllGens(!showAllGens); if (!showAllGens) setSortByPlays(false); }}
                        data-testid="button-toggle-all-gens"
                      >
                        {showAllGens ? "Только мои" : "Все треки"}
                      </button>
                    )}
                    {showAllGens && (
                      <button
                        className={`text-xs px-3 py-1 rounded-lg border transition-colors ${
                          sortByPlays
                            ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
                            : "border-white/10 bg-white/5 text-muted-foreground hover:text-white"
                        }`}
                        onClick={() => setSortByPlays(!sortByPlays)}
                      >
                        🏆 Рейтинг
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Eugene 2026-05-08: статус «Идёт процесс генерации» если есть
                processing gens — обновляется каждые 10 сек */}
            {activeGens.length > 0 && (
              <div className="mb-3 rounded-xl border border-purple-500/30 bg-gradient-to-r from-purple-500/10 to-blue-500/10 p-3 flex items-center gap-3 animate-pulse">
                <div className="w-2 h-2 rounded-full bg-purple-400 animate-ping" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-purple-200">
                    🔄 Идёт процесс генерации: {activeGens.length} {activeGens.length === 1 ? "трек" : "трека"}
                  </p>
                  <p className="text-xs text-purple-300/70 truncate">
                    {activeGens.slice(0, 3).map((g) => (g as any).displayTitle || g.prompt?.slice(0, 40) || `#${g.id}`).join(" · ")}
                    {activeGens.length > 3 && ` · ещё ${activeGens.length - 3}`}
                  </p>
                </div>
              </div>
            )}

            {/* Search */}
            <div className="mb-3 flex gap-2">
              <input
                className="flex-1 text-sm bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-white placeholder:text-muted-foreground/50 focus:outline-none focus:border-purple-500/30"
                placeholder="🔍 Поиск..."
                value={genSearch}
                onChange={(e) => setGenSearch(e.target.value)}
              />
              {genSearch && (
                <button
                  className="text-xs px-2 py-1 rounded-lg border border-white/10 bg-white/5 text-muted-foreground hover:text-white transition-colors"
                  onClick={() => setGenSearch("")}
                >
                  ✕
                </button>
              )}
            </div>

            {gensLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 rounded-xl" />
                ))}
              </div>
            ) : !generations?.length ? (
              <div className="glass-card rounded-xl p-8 text-center">
                <p className="text-muted-foreground text-sm">Пока нет генераций</p>
                <Button
                  className="btn-gradient rounded-xl mt-4"
                  onClick={() => navigate("/music")}
                  data-testid="button-first-gen"
                >
                  Создать первый трек
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {(() => {
                  const gs = genSearch.toLowerCase().trim();
                  // Eugene 2026-05-08: errored gens ВКЛЮЧАЕМ в дашборд —
                  // юзер должен видеть ошибки и иметь возможность перегенерировать.
                  const filtered = generations.filter(g =>
                    (genTypeFilter === "all" || g.type === genTypeFilter) &&
                    (!gs ||
                    g.prompt?.toLowerCase().includes(gs) ||
                    (g as any).displayTitle?.toLowerCase().includes(gs) ||
                    (g as any).authorName?.toLowerCase().includes(gs)
                  ));
                  if (filtered.length === 0) return <p className="text-xs text-muted-foreground text-center py-4">{gs ? "Ничего не найдено" : "Нет генераций"}</p>;
                  // Eugene 2026-05-16 Босс: errored треки — в самый низ списка.
                  // Среди non-error и среди error отдельно — сортируем по дате DESC.
                  const isErr = (g: Generation) => g.status === "error" || (g.status as string) === "failed";
                  const ts = (g: Generation) => g.createdAt ? new Date(g.createdAt).getTime() : 0;
                  const sorted = [...filtered].sort((a, b) => {
                    const ea = isErr(a) ? 1 : 0;
                    const eb = isErr(b) ? 1 : 0;
                    if (ea !== eb) return ea - eb;          // не-error сначала
                    return ts(b) - ts(a);                    // внутри группы — по дате DESC
                  });
                  return sorted.map((gen) => {
                  const Icon = typeIcons[gen.type] || Music;
                  const statusCfg = statusConfig[gen.status] || statusConfig.pending;
                  const StatusIcon = statusCfg.icon;
                  const isError = gen.status === "error" || (gen.status as string) === "failed";
                  // Eugene 2026-05-16: C.10 — контуры по типу (left-border 4px).
                  // music=зелёный, cover=циан, lyrics=сиреневый. dark-friendly /60.
                  const typeBorder =
                    gen.type === "music" ? "border-l-4 border-l-green-500/60"
                    : gen.type === "cover" ? "border-l-4 border-l-cyan-500/60"
                    : gen.type === "lyrics" ? "border-l-4 border-l-violet-500/60"
                    : "border-l-4 border-l-white/10";
                  const title = (gen as any).displayTitle || gen.prompt || `Без названия`;
                  const titleTrim = title.length > 60 ? title.slice(0, 60) + "…" : title;
                  return (
                    <div
                      key={gen.id}
                      className={`glass-card rounded-xl p-4 cursor-pointer hover:border-purple-500/30 transition-colors ${typeBorder} ${isError ? "border-red-500/40 hover:border-red-500/60" : ""}`}
                      onClick={() => setSelectedGen(gen)}
                      data-testid={`gen-item-${gen.id}`}
                    >
                      {/* Eugene 2026-05-16: C.9 — порядок колонок слева направо:
                          1) #id монoшрифт  2) cover-thumbnail  3) title  4) status
                          5) plays counter  6) date  7) actions (handled via row click). */}
                      <div className="flex items-center gap-3">
                        {/* 1. № генерации */}
                        <span
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.05] text-muted-foreground tabular-nums shrink-0 self-start mt-1"
                          title="Номер генерации — для поиска в админке/логах"
                          data-testid={`gen-id-badge-${gen.id}`}
                        >
                          #{gen.id}
                        </span>

                        {/* 2. Обложка thumbnail. Eugene 2026-05-14 Босс «разделить
                             Suno и свои обложки». Для lyrics — иконка PenLine. */}
                        {gen.status === "done" && gen.type === "cover" && gen.resultUrl ? (
                          <div className="relative shrink-0">
                            <img src={`/api/stream/${gen.id}`} alt="" loading="lazy" className="w-10 h-10 rounded-lg object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                            <span className="absolute -bottom-1 -right-1 text-[8px] px-1 py-0.5 rounded-full bg-purple-500/80 text-white border border-purple-300/50" title="Своя обложка от автора">👤</span>
                          </div>
                        ) : gen.status === "done" && gen.type === "music" ? (
                          <div className="relative shrink-0">
                            <img src={`/api/cover/${(gen as any).coverGenId || gen.id}.jpg?v=${gen.id}`} alt="" loading="lazy" className="w-10 h-10 rounded-lg object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                            <span
                              className={`absolute -bottom-1 -right-1 text-[8px] px-1 py-0.5 rounded-full text-white border ${
                                (gen as any).coverGenId
                                  ? "bg-purple-500/80 border-purple-300/50"
                                  : "bg-cyan-500/80 border-cyan-300/50"
                              }`}
                              title={(gen as any).coverGenId ? "Своя обложка (создал автор)" : "Обложка от Suno (auto-generated)"}
                            >
                              {(gen as any).coverGenId ? "👤" : "🤖"}
                            </span>
                          </div>
                        ) : (
                          <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                            <Icon className="w-4 h-4 text-purple-400" />
                          </div>
                        )}

                        {/* 3. Title + 4. Status (под title как мета) */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-medium text-white truncate" data-testid={`gen-title-${gen.id}`}>
                              {titleTrim}
                            </span>
                            <StatusIcon className={`w-3 h-3 shrink-0 ${statusCfg.color} ${gen.status === "processing" ? "animate-spin" : ""}`} />
                            {showAllGens && (gen as any).authorName && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300 shrink-0">
                                #{(gen as any).userId} {(gen as any).authorName}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground/80 mt-0.5">
                            {typeLabels[gen.type] || gen.type}
                            {gen.status === "done" && (
                              <span className="ml-1 text-green-400/80">
                                · ✓ {gen.type === "cover" ? "Обложка" : gen.type === "lyrics" ? "Текст" : "Трек"}
                              </span>
                            )}
                          </p>
                        </div>

                        {/* 5. Plays counter (с иконкой ▶) */}
                        {((gen as any).plays > 0 || (gen as any).downloads > 0) && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400 tabular-nums flex items-center gap-1 shrink-0">
                            {(gen as any).plays > 0 && (
                              isAdmin ? (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setGeoDialog({ open: true, genId: gen.id, title: (gen as any).displayTitle || gen.prompt || "Трек" }); }}
                                  className="hover:underline cursor-pointer flex items-center gap-0.5"
                                  title="Показать географию слушателей"
                                  data-testid={`btn-geo-${gen.id}`}
                                >
                                  <Play className="w-2.5 h-2.5 inline" />{(gen as any).plays}
                                </button>
                              ) : (
                                <span className="flex items-center gap-0.5">
                                  <Play className="w-2.5 h-2.5 inline" />{(gen as any).plays}
                                </span>
                              )
                            )}
                            {(gen as any).downloads > 0 && (
                              <span className="text-blue-400 flex items-center gap-0.5">
                                <Download className="w-2.5 h-2.5" />{(gen as any).downloads}
                              </span>
                            )}
                          </span>
                        )}

                        {/* 6. Дата + цена + публичность */}
                        <div className="text-right shrink-0">
                          <p className="text-xs text-muted-foreground">{formatDate(gen.createdAt)}</p>
                          <p className="text-xs text-purple-400 font-medium">
                            {gen.cost === 0 ? "🎁 Бесплатно" : `-${formatBalance(gen.cost)}`}
                          </p>
                          {gen.status === "done" && (gen.type === "music" || gen.type === "cover") && (
                            <p className="text-[10px] text-muted-foreground flex items-center gap-1 justify-end mt-0.5">
                              {gen.isPublic === 1 ? <><Globe className="w-3 h-3 text-green-400" /> публ.</>
                                : gen.isPublic === 2 ? <><Clock className="w-3 h-3 text-yellow-400" /> модер.</>
                                : <><Lock className="w-3 h-3" /> приват</>}
                            </p>
                          )}
                        </div>
                      </div>
                      {isError && (
                        <div className="mt-3 pt-3 border-t border-red-500/20" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-start gap-2 mb-2">
                            <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold text-red-300">Ошибка генерации</p>
                              <p className="text-xs text-red-200/80 mt-0.5 leading-relaxed break-words">
                                {(gen as any).errorReason || "Превышен лимит ожидания. Средства возвращены на баланс."}
                              </p>
                            </div>
                          </div>
                          {gen.type === "music" && (
                            <Button
                              size="sm"
                              className="btn-gradient rounded-lg text-xs h-8 w-full"
                              onClick={(e) => {
                                e.stopPropagation();
                                // ТЗ Eugene 2026-05-08: переходим на /music с параметрами,
                                // юзер видит поля, кнопка моргает — клик создаёт.
                                let meta: any = {};
                                try { meta = JSON.parse(gen.style || "{}"); } catch {}
                                const payload = {
                                  prompt: gen.prompt || "",
                                  lyrics: meta.lyric || gen.prompt || "",
                                  style: meta.style || meta.tags || "",
                                  title: meta.title || "",
                                  voice: meta.voiceType === "duet" || meta.voiceType === "instrumental" ? "male" : (meta.voiceType || "male"),
                                  voiceType: meta.voiceType || "male",
                                  isDuet: meta.voiceType === "duet",
                                  instrumental: meta.voiceType === "instrumental",
                                  mode: meta.mode === "custom" ? "advanced" : "simple",
                                  fromGenId: gen.id,
                                };
                                try { sessionStorage.setItem("musicRegenerate", JSON.stringify(payload)); } catch {}
                                navigate("/music");
                              }}
                              data-testid={`btn-regenerate-${gen.id}`}
                            >
                              <RotateCcw className="w-3 h-3 mr-1.5" />
                              Перегенерировать (открыть форму)
                            </Button>
                          )}
                          {/* Eugene 2026-05-16 Босс: scheduled-delete dropdown
                              на errored карточках. POST /api/generations/:id/schedule-delete
                              {deleteAfterDays:1|7|15|30}. Soft-delete reversible
                              через /restore. */}
                          <ScheduleDeleteDropdown
                            gen={gen}
                            onUpdate={() => {
                              queryClient.refetchQueries({ queryKey: ["/api/generations"] });
                            }}
                          />
                        </div>
                      )}
                    </div>
                  );
                  });
                })()}
              </div>
            )}
          </div>

          {/* Transactions — collapsed by default */}
          <div>
            <button
              className="text-base font-semibold text-white mb-4 flex items-center gap-2 hover:text-purple-300 transition-colors w-full text-left"
              onClick={() => setShowTxns(!showTxns)}
            >
              <CreditCard className="w-4 h-4 text-blue-400" />
              Транзакции
              {txns?.length ? <span className="text-xs text-muted-foreground font-normal">({txns.length})</span> : null}
              <span className={`text-xs text-muted-foreground ml-auto transition-transform ${showTxns ? "rotate-180" : ""}`}>▼</span>
            </button>

            {!showTxns ? null : txnsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 rounded-xl" />
                ))}
              </div>
            ) : !txns?.length ? (
              <div className="glass-card rounded-xl p-6 text-center">
                <p className="text-muted-foreground text-sm">Нет транзакций</p>
              </div>
            ) : (
              <div className="space-y-2">
                {txns.slice(0, 15).map((txn) => (
                  <div key={txn.id} className="glass-card rounded-xl p-3 flex items-center gap-3" data-testid={`txn-item-${txn.id}`}>
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                      txn.amount > 0 ? "bg-green-500/10" : "bg-red-500/10"
                    }`}>
                      {txn.amount > 0 ? (
                        <ArrowDownLeft className="w-3.5 h-3.5 text-green-400" />
                      ) : (
                        <ArrowUpRight className="w-3.5 h-3.5 text-red-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white truncate">{txn.description || typeLabels[txn.type] || txn.type}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(txn.createdAt)}</p>
                    </div>
                    <span className={`text-xs font-semibold ${txn.amount > 0 ? "text-green-400" : "text-red-400"}`}>
                      {txn.amount > 0 ? "+" : ""}{formatBalance(txn.amount)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Eugene 2026-05-15 hotfix: GeoActivityDialog рендерится и в Dashboard
          (admin-клик на ▶N в основном списке треков). Был только в MyPlaylist. */}
      <GeoActivityDialog
        genId={geoDialog.genId}
        open={geoDialog.open}
        onClose={() => setGeoDialog({ open: false, genId: null, title: "" })}
        title={geoDialog.title}
      />

      {/* Eugene 2026-05-15 Босс «обязательно подтверждение автором смены стиля».
          Modal появляется при попытке смены category на отличную от текущей. */}
      <Dialog open={!!pendingCategoryChange} onOpenChange={(o) => { if (!o && !categoryChangeLoading) setPendingCategoryChange(null); }}>
        <DialogContent className="glass-card border-purple-500/30 max-w-md">
          <DialogHeader>
            <DialogTitle className="gradient-text text-base flex items-center gap-2">
              🎵 Сменить стиль трека?
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground pt-2">
              {pendingCategoryChange && (
                <>
                  Текущий стиль: <span className="text-white font-medium">{labelForCategory(pendingCategoryChange.from)}</span>
                  <br />
                  Новый стиль: <span className="text-purple-300 font-medium">{pendingCategoryChange.label}</span>
                  <br /><br />
                  После смены трек переедет в соответствующий фильтр на главной странице.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 mt-4">
            <Button
              variant="outline"
              className="flex-1 border-white/10"
              disabled={categoryChangeLoading}
              onClick={() => setPendingCategoryChange(null)}
            >
              Отмена
            </Button>
            <Button
              className="flex-1 btn-gradient"
              disabled={categoryChangeLoading}
              onClick={async () => {
                if (!selectedGen || !pendingCategoryChange) return;
                setCategoryChangeLoading(true);
                try {
                  const r = await apiRequest("POST", `/api/generations/${selectedGen.id}/category`, { category: pendingCategoryChange.to, confirmed: true });
                  const j = await r.json();
                  if (j.ok) {
                    let m: any = {}; try { m = JSON.parse((selectedGen as any).style || "{}"); } catch {}
                    m.category = pendingCategoryChange.to;
                    setSelectedGen({ ...selectedGen, style: JSON.stringify(m), voiceType: j.voiceType } as any);
                    queryClient.invalidateQueries();
                    toast({ title: `Стиль изменён: ${pendingCategoryChange.label}` });
                    setPendingCategoryChange(null);
                  } else {
                    toast({ title: j.message || "Ошибка", variant: "destructive" });
                  }
                } catch (e: any) {
                  toast({ title: e.message, variant: "destructive" });
                } finally {
                  setCategoryChangeLoading(false);
                }
              }}
            >
              {categoryChangeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Подтвердить смену"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Generation Detail Modal */}
      <Dialog open={!!selectedGen} onOpenChange={() => { setSelectedGen(null); setRenamingId(null); }}>
        <DialogContent className="glass-card border-purple-500/20 max-w-md sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="gradient-text text-lg flex items-center gap-2">
              {selectedGen && typeIcons[selectedGen.type] && (() => {
                const Icon = typeIcons[selectedGen.type];
                return <Icon className="w-5 h-5" />;
              })()}
              {selectedGen && (typeLabels[selectedGen.type] || selectedGen.type)}
              {/* Eugene 2026-05-15 Босс «реальные номера генерации в дашборде». */}
              {selectedGen && (
                <span
                  className="text-xs font-mono px-2 py-0.5 rounded bg-white/[0.05] text-muted-foreground tabular-nums ml-auto"
                  title="Номер генерации — для поиска в админке/логах"
                >
                  #{selectedGen.id}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          {selectedGen && (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="text-xs text-muted-foreground">Запрос</p>
                  {/* Eugene 2026-05-16: B.5 — копировать промт одной кнопкой.
                      Берёт полный prompt (а не displayTitle) — Босс может
                      переиспользовать его в /music. */}
                  <button
                    className="text-[11px] text-purple-300 hover:text-purple-100 transition-colors flex items-center gap-1 px-2 py-0.5 rounded hover:bg-purple-500/10"
                    onClick={() => {
                      const txt = selectedGen.prompt || selectedGen.displayTitle || "";
                      if (!txt) {
                        toast({ title: "Нечего копировать", variant: "destructive" });
                        return;
                      }
                      navigator.clipboard.writeText(txt).then(() => {
                        toast({ title: "Промт скопирован", description: `${txt.slice(0, 60)}${txt.length > 60 ? "…" : ""}` });
                      }).catch(() => {
                        toast({ title: "Не удалось скопировать", variant: "destructive" });
                      });
                    }}
                    data-testid="btn-copy-prompt-modal"
                  >
                    <Copy className="w-3 h-3" /> Скопировать промт
                  </button>
                </div>
                <p className="text-sm text-foreground/90 max-h-24 overflow-y-auto leading-relaxed">{selectedGen.displayTitle || selectedGen.prompt}</p>
                {(() => { try { const m = JSON.parse((selectedGen as any).style || '{}'); if (m.style) return <p className="text-[11px] text-purple-400/60 mt-1">Промт: {m.style}</p>; } catch {} return null; })()}
              </div>
              {/* Rename title */}
              {selectedGen.status === "done" && !renamingId && (
                <button
                  className="text-xs text-purple-300 hover:text-purple-200 transition-colors flex items-center gap-1"
                  onClick={() => setRenamingId(selectedGen.id)}
                >
                  <Pencil className="w-3 h-3" /> Переименовать
                </button>
              )}
              {selectedGen.status === "done" && renamingId === selectedGen.id && (
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1 text-sm bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-white placeholder:text-muted-foreground/50"
                    placeholder="Новое название"
                    defaultValue={selectedGen.displayTitle || selectedGen.prompt?.slice(0, 80) || ""}
                    id="rename-input"
                    data-testid="input-rename-title"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        (e.target as HTMLInputElement).blur();
                        document.getElementById("btn-rename-save")?.click();
                      }
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                  <button
                    id="btn-rename-save"
                    className="text-xs px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-blue-600 text-white hover:from-purple-500 hover:to-blue-500 transition-colors whitespace-nowrap"
                    onClick={async () => {
                      const input = document.getElementById("rename-input") as HTMLInputElement;
                      const newTitle = input?.value?.trim();
                      if (!newTitle) { toast({ title: "Введите название", variant: "destructive" }); return; }
                      // Кардинально: разделяем запрос и побочные эффекты. Ошибка в refetch или в toast
                      // БОЛЬШЕ НЕ будет показываться как «Ошибка» при успешном rename.
                      let resp: Response | null = null;
                      let data: any = null;
                      try {
                        resp = await apiRequest("POST", `/api/generations/${selectedGen.id}/rename`, { title: newTitle });
                        data = await resp.json();
                      } catch (err: any) {
                        // Сетевая ошибка или не-2xx ответ
                        let msg = err?.message || "Не удалось сохранить";
                        try { const m = err?.message?.match(/^\d+:\s*(.+)$/); if (m) { const p = JSON.parse(m[1]); msg = p.message || p.error || msg; } } catch {}
                        toast({ title: "Ошибка", description: msg, variant: "destructive" });
                        return;
                      }

                      // Успех — обновляем UI. Даже если refetch или toast бросят — это не «ошибка rename».
                      if (data?.direct) {
                        setSelectedGen({ ...selectedGen, displayTitle: newTitle });
                        try {
                          await queryClient.refetchQueries({ predicate: (q: any) => Array.isArray(q.queryKey) && q.queryKey[0] === "/api/generations" });
                        } catch (e) { console.error("refetch failed", e); }
                        try { onUpdate?.(); } catch {}
                        try { sessionStorage.setItem('playlistDirty', '1'); } catch {}
                        toast({ title: "Название изменено" });
                      } else {
                        toast({ title: "Письмо отправлено", description: "Подтвердите смену названия по ссылке в письме" });
                      }
                      setRenamingId(null);
                    }}
                    data-testid="button-rename-submit"
                  >
                    Сохранить
                  </button>
                  <button
                    className="text-xs px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:bg-white/10 transition-colors whitespace-nowrap"
                    onClick={() => setRenamingId(null)}
                  >
                    Отмена
                  </button>
                </div>
              )}
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <Badge variant="outline" className={statusConfig[selectedGen.status]?.color || ""}>
                  {/* Eugene 2026-05-14 Босс: подпись по типу для done — Обложка/Текст/Трек */}
                  {selectedGen.status === "done"
                    ? (selectedGen.type === "cover" ? "Обложка создана" : selectedGen.type === "lyrics" ? "Текст создан" : "Трек создан")
                    : (statusConfig[selectedGen.status]?.label || selectedGen.status)}
                </Badge>
                <span>{formatDate(selectedGen.createdAt)}</span>
                <span className="text-purple-400">{formatBalance(selectedGen.cost)}</span>
              </div>
              {/* Retry button for errors */}
              {selectedGen.status === "error" && (
                <div className="rounded-xl p-4 space-y-3 border border-red-500/30 bg-red-500/10">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-red-300">Генерация не удалась</p>
                      <p className="text-xs text-red-200/80 mt-1 leading-relaxed">
                        {(selectedGen as any).errorReason || "Превышен лимит ожидания. Средства возвращены на баланс."}
                      </p>
                    </div>
                  </div>
                  {selectedGen.type === "music" ? (
                    <Button
                      className="btn-gradient rounded-xl w-full"
                      onClick={() => {
                        let meta: any = {};
                        try { meta = JSON.parse(selectedGen.style || "{}"); } catch {}
                        const payload = {
                          prompt: selectedGen.prompt || "",
                          lyrics: meta.lyric || selectedGen.prompt || "",
                          style: meta.style || meta.tags || "",
                          title: meta.title || "",
                          voice: meta.voiceType === "duet" || meta.voiceType === "instrumental" ? "male" : (meta.voiceType || "male"),
                          voiceType: meta.voiceType || "male",
                          isDuet: meta.voiceType === "duet",
                          instrumental: meta.voiceType === "instrumental",
                          mode: meta.mode === "custom" ? "advanced" : "simple",
                          fromGenId: selectedGen.id,
                        };
                        try { sessionStorage.setItem("musicRegenerate", JSON.stringify(payload)); } catch {}
                        setSelectedGen(null);
                        navigate("/music");
                      }}
                      data-testid="button-regenerate-gen"
                    >
                      <RotateCcw className="w-4 h-4 mr-2" />
                      Перегенерировать (открыть форму)
                    </Button>
                  ) : (
                    <Button
                      className="btn-gradient rounded-xl w-full"
                      onClick={() => {
                        setSelectedGen(null);
                        const routes: Record<string, string> = { lyrics: "/lyrics", music: "/music", cover: "/covers" };
                        navigate(routes[selectedGen.type] || "/music");
                      }}
                      data-testid="button-retry-gen"
                    >
                      <RotateCcw className="w-4 h-4 mr-2" />
                      Попробовать снова
                    </Button>
                  )}
                </div>
              )}
              {selectedGen.status === "done" && selectedGen.resultUrl && (
                <div className="space-y-3">
                  {selectedGen.type === "lyrics" ? (
                    <div className="text-sm text-foreground/90 whitespace-pre-wrap font-mono bg-background/30 rounded-xl p-4 max-h-60 overflow-y-auto">
                      {selectedGen.resultUrl}
                    </div>
                  ) : selectedGen.type === "cover" ? (
                    <img src={`/api/stream/${selectedGen.id}`} alt="Обложка" className="w-full rounded-xl" />
                  ) : (
                    <audio src={`/api/stream/${selectedGen.id}`} controls className="w-full" />
                  )}
                  {/* Action buttons — compact grid for mobile */}
                  <div className="grid grid-cols-3 sm:flex sm:flex-wrap gap-1.5">
                    <button
                      className="inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap bg-gradient-to-r from-purple-600 to-blue-600 text-white hover:from-purple-500 hover:to-blue-500 transition-colors"
                      data-testid="button-download-result"
                      onClick={() => { const a = document.createElement('a'); a.href = `/api/download/${selectedGen.id}`; a.download = ''; document.body.appendChild(a); a.click(); document.body.removeChild(a); }}
                    >
                      <Download className="w-3 h-3" /> Скачать
                    </button>


                    {selectedGen.type === "music" && (
                      <button
                        className="inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap border border-white/10 bg-white/5 text-white hover:bg-white/10 transition-colors"
                        onClick={async () => {
                          const url = `https://muziai.ru/share/${selectedGen.id}`;
                          const title = selectedGen.displayTitle || selectedGen.prompt?.slice(0, 60) || 'MuzaAi';
                          if (navigator.share) {
                            try {
                              await navigator.share({ title: `Послушай на MuzaAi.ru`, text: title, url });
                              return;
                            } catch {}
                          }
                          navigator.clipboard.writeText(`Послушай на MuzaAi.ru: ${title} ${url}`).then(() => toast({ title: "Ссылка скопирована" }));
                        }}
                        data-testid="button-share-track"
                      >
                        <ExternalLink className="w-3 h-3" /> Поделиться
                      </button>
                    )}

                    {(selectedGen.type === "music" || selectedGen.type === "cover") && (
                      <button
                        className={`relative inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap border transition-colors overflow-visible ${
                          selectedGen.isPublic === 1
                            ? "border-green-500/40 bg-green-500/15 text-green-300 hover:bg-green-500/25 radio-air-active"
                            : selectedGen.isPublic === 2
                            ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
                            : "border-white/10 bg-white/5 text-muted-foreground hover:bg-white/10"
                        }`}
                        onClick={async () => {
                          const cur = selectedGen.isPublic;
                          // 1 (published) → 0 (unpublish), 2 (pending) → 0 (cancel), 0 (private) → request publish
                          const wantPublish = cur === 0;
                          try {
                            const resp = await apiRequest("POST", `/api/generations/${selectedGen.id}/privacy`, { isPublic: wantPublish });
                            const data = await resp.json();
                            if (data.pending) {
                              setSelectedGen({ ...selectedGen, isPublic: 2 });
                              toast({ title: "Запрос на публикацию отправлен", description: "Администратор рассмотрит запрос" });
                            } else {
                              setSelectedGen({ ...selectedGen, isPublic: wantPublish ? 1 : 0 });
                              toast({ title: wantPublish ? "Опубликовано" : "Скрыто из плейлиста" });
                            }
                            queryClient.invalidateQueries();
                          } catch { toast({ title: "Ошибка", variant: "destructive" }); }
                        }}
                        data-testid="button-toggle-public"
                      >
                        {selectedGen.isPublic === 1 ? <><Globe className="w-3 h-3" /> Публ.</> : selectedGen.isPublic === 2 ? <><Clock className="w-3 h-3" /> На модер.</> : <><Lock className="w-3 h-3" /> Опубл.</>}
                      </button>
                    )}

                    {selectedGen.type === "music" && (
                      <button
                        className="inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap border border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 transition-colors"
                        onClick={() => {
                          // Eugene 2026-05-14 Босс «связать стиль с окном
                          // корректировки + сверху зона какой текст и параметры».
                          (window as any).__coverForTrack = selectedGen.id;
                          (window as any).__coverPrompt = selectedGen.prompt?.slice(0, 100) || "";
                          // Передаём ВСЁ инфо трека для отображения в /covers
                          let trackStyle = "", trackMood = "";
                          try {
                            const m = JSON.parse((selectedGen as any).style || "{}");
                            trackStyle = m.style || "";
                          } catch {}
                          (window as any).__coverTrackInfo = {
                            title: (selectedGen as any).displayTitle || selectedGen.prompt?.slice(0, 80) || "",
                            authorName: (selectedGen as any).authorName || "",
                            style: trackStyle,
                            voiceType: (selectedGen as any).voiceType || "",
                            promptFull: selectedGen.prompt || "",
                          };
                          navigate("/covers");
                        }}
                      >
                        <ImageIcon className="w-3 h-3" /> Обложка
                      </button>
                    )}

                    {selectedGen.deletedAt ? (
                      <button
                        className="inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap border border-green-500/30 bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors"
                        onClick={async () => {
                          try {
                            await apiRequest("POST", `/api/generations/${selectedGen.id}/restore`);
                            queryClient.invalidateQueries();
                            toast({ title: "Восстановлено" });
                            setSelectedGen(null);
                          } catch { toast({ title: "Ошибка", variant: "destructive" }); }
                        }}
                        data-testid="button-restore-gen"
                      >
                        <ArchiveRestore className="w-3 h-3" /> Восст.
                      </button>
                    ) : (
                      <button
                        className="inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap border border-red-500/20 bg-red-500/5 text-red-400 hover:bg-red-500/10 transition-colors"
                        onClick={async () => {
                          try {
                            const resp = await apiRequest("POST", `/api/generations/${selectedGen.id}/delete`);
                            const data = await resp.json();
                            if (data.needConfirmation) {
                              toast({ title: data.message, description: "Нажмите ссылку в письме для подтверждения" });
                            }
                          } catch { toast({ title: "Ошибка", variant: "destructive" }); }
                        }}
                        data-testid="button-delete-gen"
                      >
                        <Trash2 className="w-3 h-3" /> Удалить
                      </button>
                    )}
                  </div>

                  {/* Eugene 2026-05-16: B.6+B.7 — Re-кнопки (Трек / Обложка / Текст).
                      Каждая ведёт в /music, /covers или /lyrics с предзаполненной
                      формой через sessionStorage 'musicRegenerate' (трек) или
                      window.__transfer* (обложка/текст). */}
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">🔄 Регенерация:</p>
                    <div className="grid grid-cols-3 gap-1.5" data-testid="re-buttons-row">
                      <button
                        className="inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-medium rounded-lg border border-green-500/30 bg-green-500/10 text-green-300 hover:bg-green-500/20 hover:border-green-500/50 transition-colors"
                        onClick={() => {
                          let meta: any = {};
                          try { meta = JSON.parse(selectedGen.style || "{}"); } catch {}
                          const payload = {
                            prompt: selectedGen.prompt || "",
                            lyrics: meta.lyric || (selectedGen.type === "lyrics" ? selectedGen.resultUrl : selectedGen.prompt) || "",
                            style: meta.style || meta.tags || "",
                            title: (selectedGen as any).displayTitle || meta.title || "",
                            voice: meta.voiceType === "duet" || meta.voiceType === "instrumental" ? "male" : (meta.voiceType || "male"),
                            voiceType: meta.voiceType || (selectedGen as any).voiceType || "male",
                            isDuet: meta.voiceType === "duet" || (selectedGen as any).voiceType === "duet",
                            instrumental: meta.voiceType === "instrumental" || (selectedGen as any).voiceType === "instrumental",
                            mode: meta.mode === "custom" ? "advanced" : "simple",
                            fromGenId: selectedGen.id,
                          };
                          try { sessionStorage.setItem("musicRegenerate", JSON.stringify(payload)); } catch {}
                          setSelectedGen(null);
                          navigate("/music");
                        }}
                        data-testid={`btn-re-track-${selectedGen.id}`}
                      >
                        <RotateCcw className="w-3 h-3" /> Re Трек
                      </button>
                      <button
                        className="inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-medium rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 hover:border-cyan-500/50 transition-colors"
                        onClick={() => {
                          // Передаём ВСЁ инфо в /covers — re-генерация обложки на основе текущего трека.
                          let trackStyle = "";
                          try { const m = JSON.parse((selectedGen as any).style || "{}"); trackStyle = m.style || ""; } catch {}
                          (window as any).__coverForTrack = selectedGen.id;
                          (window as any).__coverPrompt = selectedGen.prompt?.slice(0, 100) || "";
                          (window as any).__coverTrackInfo = {
                            title: (selectedGen as any).displayTitle || selectedGen.prompt?.slice(0, 80) || "",
                            authorName: (selectedGen as any).authorName || "",
                            style: trackStyle,
                            voiceType: (selectedGen as any).voiceType || "",
                            promptFull: selectedGen.prompt || "",
                          };
                          setSelectedGen(null);
                          navigate("/covers");
                        }}
                        data-testid={`btn-re-cover-${selectedGen.id}`}
                      >
                        <ImageIcon className="w-3 h-3" /> Re Обложка
                      </button>
                      <button
                        className="inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-medium rounded-lg border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 hover:border-violet-500/50 transition-colors"
                        onClick={() => {
                          // Передаём prompt/lyrics в /lyrics через sessionStorage transfer.
                          try {
                            const lyricsText = selectedGen.type === "lyrics" ? selectedGen.resultUrl || selectedGen.prompt
                              : ((() => { try { const m = JSON.parse(selectedGen.style || "{}"); return m.lyric || selectedGen.prompt; } catch { return selectedGen.prompt; } })());
                            sessionStorage.setItem("__lyricsTransfer", String(lyricsText || ""));
                            sessionStorage.setItem("__lyricsRegenerateFromGen", String(selectedGen.id));
                          } catch {}
                          setSelectedGen(null);
                          navigate("/lyrics");
                        }}
                        data-testid={`btn-re-lyrics-${selectedGen.id}`}
                      >
                        <PenLine className="w-3 h-3" /> Re Текст
                      </button>
                    </div>
                  </div>

                  {/* Eugene 2026-05-14 Босс «Песня/Поздравление/Инструментальная»
                      переключатель категории трека (только для music).
                      Eugene 2026-05-15 Босс «Обязательно подтверждение автором
                      смены стиля» — добавлен confirm-dialog перед сменой. */}
                  {selectedGen.type === "music" && (() => {
                    let curCat = "song";
                    try { const m = JSON.parse((selectedGen as any).style || "{}"); curCat = m.category || "song"; } catch {}
                    if ((selectedGen as any).voiceType === "instrumental") curCat = "instrumental";
                    const cats = [
                      { val: "song", label: "🎵 Песня", color: "purple" },
                      { val: "greeting", label: "🎉 Поздравление", color: "pink" },
                      { val: "instrumental", label: "🎶 Инструмент.", color: "cyan" },
                    ];
                    return (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1.5">Категория стиля музыки:</p>
                        <div className="grid grid-cols-3 gap-1.5">
                          {cats.map(c => (
                            <button
                              key={c.val}
                              className={`text-[11px] px-1.5 py-2 rounded-lg border transition-colors ${
                                curCat === c.val
                                  ? c.color === "pink" ? "border-pink-500/40 bg-pink-500/15 text-pink-300"
                                    : c.color === "cyan" ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-300"
                                    : "border-purple-500/40 bg-purple-500/15 text-purple-300"
                                  : "border-white/10 bg-white/5 text-muted-foreground hover:text-white"
                              }`}
                              onClick={() => {
                                if (curCat === c.val) return; // already this category
                                setPendingCategoryChange({ from: curCat, to: c.val, label: c.label });
                              }}
                            >{c.label}</button>
                          ))}
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-1.5">
                          После смены трек переедет в соответствующий фильтр на главной.
                        </p>
                      </div>
                    );
                  })()}

                  {/* Existing covers to attach. Eugene 2026-05-14 Босс
                      «обложки видимые 7, остальные раскрываются». */}
                  {selectedGen.type === "music" && generations && generations.filter(g => g.type === "cover" && g.status === "done" && !g.deletedAt).length > 0 && (
                    <CoverPickerExpandable
                      covers={generations.filter(g => g.type === "cover" && g.status === "done" && !g.deletedAt)}
                      selectedCoverId={selectedGen.coverGenId}
                      onAttach={async (cover) => {
                        try {
                          await apiRequest("POST", `/api/generations/${selectedGen.id}/cover`, { coverGenId: cover.id });
                          queryClient.invalidateQueries();
                          toast({ title: "Обложка привязана" });
                          setSelectedGen({ ...selectedGen, coverGenId: cover.id });
                        } catch { toast({ title: "Ошибка", variant: "destructive" }); }
                      }}
                    />
                  )}

                </div>
              )}
              {/* Eugene 2026-05-14 Босс «Сохранить и вернуться зелёная /
                  Отменить красная» — две кнопки в одной строке. */}
              <div className="grid grid-cols-2 gap-2 mt-3">
                <button
                  className="h-11 rounded-xl border-2 border-green-500/40 bg-green-500/15 text-green-300 text-sm font-semibold hover:bg-green-500/25 active:scale-[0.98] transition-all flex items-center justify-center gap-1"
                  onClick={() => setSelectedGen(null)}
                >
                  ✓ Сохранить и выйти
                </button>
                <button
                  className="h-11 rounded-xl border-2 border-red-500/40 bg-red-500/10 text-red-300 text-sm font-semibold hover:bg-red-500/20 active:scale-[0.98] transition-all flex items-center justify-center gap-1"
                  onClick={() => { setRenamingId(null); setSelectedGen(null); }}
                >
                  ✕ Отменить
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Support link */}
      <div className="mt-8 text-center">
        <a href="#" onClick={(e) => { e.preventDefault(); window.location.href = `mailto:${["Tis","san","21","@","gm","ail",".","com"].join("")}?subject=${encodeURIComponent("MuzaAi — обращение")}`; }} className="text-xs text-purple-400/60 hover:text-purple-300 transition-colors">Поддержка</a>
      </div>
    </div>
  );
}
