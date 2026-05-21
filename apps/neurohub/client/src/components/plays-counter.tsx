// Eugene 2026-05-21 Босс «дизайн счётчика: deep space #070812 + violet #8B5CF6 +
// cyan #22D3EE + gold #FBBF24. Glass-card, мягкие скругления, glow. Сайт живой:
// пульс, онлайн, рост». Реализовано на базе MuzaAiVisitCounter (Boss spec).
//
// Связка с существующим backend:
// - GET /api/playlist/stats — {totalPlays, totalTracks, todayPlays, onlineNow}
// - SSE /api/playlist/stats/stream — push при каждом play через broadcastPlaysStats
// - POST /api/star-suggestions/vote — голосование за мировую звезду
// - GET  /api/star-suggestions/top — топ рейтинг
// - POST /api/user-preferences/anim-toggle — toggle анимаций (по IP)
// - GET  /api/user-preferences/anim-state — текущее состояние

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Sparkles } from "lucide-react";

// Eugene 2026-05-21 Босс «вместо глаза поставь планету» + «крутиться плавно
// в направлении научном». Saturn с кольцом, brand cyan/violet gradient.
// Научное направление prograde = против часовой стрелки если смотреть с
// северного полюса (как Земля, Юпитер, Сатурн etc, кроме Венеры/Урана).
// CSS rotate(-360deg) = counterclockwise = prograde.
function PlanetIcon({ className = "" }: { className?: string }) {
  const uid = String(Math.random()).slice(2, 8);
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={`pl-${uid}`} cx="0.35" cy="0.35" r="0.7">
          <stop offset="0%" stopColor="#A78BFA" />
          <stop offset="50%" stopColor="#8B5CF6" />
          <stop offset="100%" stopColor="#22D3EE" />
        </radialGradient>
        <style>{`
          @keyframes planet-spin-${uid} {
            from { transform: rotate(0deg); }
            to { transform: rotate(-360deg); }
          }
          .planet-body-${uid} {
            transform-origin: 16px 16px;
            animation: planet-spin-${uid} 14s linear infinite;
          }
          @media (prefers-reduced-motion: reduce) {
            .planet-body-${uid} { animation: none; }
          }
        `}</style>
      </defs>
      {/* Ring back-half (behind planet) — static */}
      <ellipse cx="16" cy="16" rx="13" ry="3.5" stroke="rgba(251,191,36,0.7)" strokeWidth="1.2" fill="none" transform="rotate(-22 16 16)" strokeDasharray="6 4" />
      {/* Planet body + highlight — rotate group prograde (counterclockwise) */}
      <g className={`planet-body-${uid}`}>
        <circle cx="16" cy="16" r="8" fill={`url(#pl-${uid})`} />
        <circle cx="13" cy="13" r="2" fill="rgba(255,255,255,0.45)" />
        {/* Surface dots для визуального вращения (без них шар крутится «неподвижно») */}
        <circle cx="19" cy="18" r="0.9" fill="rgba(255,255,255,0.25)" />
        <circle cx="14" cy="19.5" r="0.7" fill="rgba(255,255,255,0.2)" />
        <circle cx="17.5" cy="14" r="0.6" fill="rgba(255,255,255,0.3)" />
      </g>
      {/* Ring front-half (overlaps planet) — static */}
      <path d="M3.5 18.5 Q16 23 28.5 13.5" stroke="rgba(251,191,36,0.85)" strokeWidth="1.4" fill="none" strokeLinecap="round" transform="rotate(-22 16 16)" />
    </svg>
  );
}

interface Stats {
  totalPlays: number;
  totalTracks: number;
  todayPlays?: number;
  onlineNow?: number;
}

function HeartIcon({ filled, className = "" }: { filled?: boolean; className?: string }) {
  if (filled) {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
    </svg>
  );
}

// === Slot Machine digits — 6-padded 000000 style, dim leading zeros ===
const RollingDigit = ({ value, dimmed }: { value: number; dimmed?: boolean }) => {
  const safeValue = Math.max(0, Math.min(9, value));
  return (
    <span
      className="inline-block overflow-hidden align-baseline relative"
      style={{
        width: "0.62em",
        height: "1em",
        lineHeight: "1em",
        color: dimmed ? "rgba(139,92,246,0.22)" : undefined,
        WebkitTextFillColor: dimmed ? "rgba(139,92,246,0.22)" : undefined,
        opacity: dimmed ? 0.6 : 1,
      }}
      data-active={!dimmed ? "1" : undefined}
    >
      {/* Eugene 2026-05-21 Босс «цифра должна поворачиваться снизу вверх медленно».
          Strip 0-9 ↓, translateY(-Nem) показывает digit N — изменение N→N+1
          двигает strip ВВЕРХ → digit «вылезает» снизу.
          Slow: 3500ms (было 1500). Smoother: ease-out без spring-overshoot. */}
      <span
        className="block transition-transform duration-[3500ms] ease-[cubic-bezier(0.22,0.61,0.36,1)]"
        style={{ transform: `translateY(-${safeValue}em)`, willChange: "transform" }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
          <span key={d} className="block text-center" style={{ height: "1em", lineHeight: "1em" }}>{d}</span>
        ))}
      </span>
    </span>
  );
};

function RollingNumber({ value }: { value: number }) {
  const safeValue = Math.max(0, Math.min(999999, Math.floor(value)));
  const padded = safeValue.toString().padStart(6, "0");
  let firstNonZero = padded.search(/[1-9]/);
  if (firstNonZero < 0) firstNonZero = padded.length - 1;
  return (
    <span className="inline-flex" style={{ letterSpacing: "0.02em" }}>
      {padded.split("").map((ch, i) => (
        <RollingDigit key={i} value={parseInt(ch, 10)} dimmed={i < firstNonZero} />
      ))}
    </span>
  );
}

export function PlaysCounter({ className = "" }: { className?: string }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [bumped, setBumped] = useState(0); // tick для growth-arrow анимации
  const prevTotalRef = useRef<number | null>(null);
  const [animEnabled, setAnimEnabled] = useState(true);
  const [permanentOff, setPermanentOff] = useState(false);
  // Eugene 2026-05-21 Босс: эквалайзеры реагируют на playback
  const [audioState, setAudioState] = useState<{ playing: boolean; tempoCls: "fast" | "medium" | "slow" }>({ playing: false, tempoCls: "medium" });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const findAudio = (): HTMLAudioElement | null => {
      try {
        return (window as any).__muziaiAudio || document.querySelector("audio[data-muziai-player]") || null;
      } catch { return null; }
    };
    let audio: HTMLAudioElement | null = findAudio();
    const update = () => {
      const a = findAudio();
      audio = a;
      const playing = !!(a && !a.paused && (a.currentTime > 0 || a.readyState >= 2));
      const dur = a?.duration && isFinite(a.duration) ? a.duration : 0;
      const tempoCls: "fast" | "medium" | "slow" = !playing ? "medium"
        : dur > 0 && dur < 150 ? "fast"
        : dur > 240 ? "slow" : "medium";
      setAudioState(s => (s.playing === playing && s.tempoCls === tempoCls) ? s : { playing, tempoCls });
    };
    update();
    const interval = window.setInterval(update, 1500);
    const attach = (a: HTMLAudioElement) => {
      a.addEventListener("play", update);
      a.addEventListener("pause", update);
      a.addEventListener("loadedmetadata", update);
      a.addEventListener("ended", update);
    };
    if (audio) attach(audio);
    const mo = new MutationObserver(() => {
      const a = findAudio();
      if (a && a !== audio) { audio = a; attach(a); update(); }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.clearInterval(interval);
      mo.disconnect();
      if (audio) {
        try {
          audio.removeEventListener("play", update);
          audio.removeEventListener("pause", update);
          audio.removeEventListener("loadedmetadata", update);
          audio.removeEventListener("ended", update);
        } catch {}
      }
    };
  }, []);
  const eqBaseSec = !audioState.playing ? 0
    : audioState.tempoCls === "fast" ? 0.28
    : audioState.tempoCls === "slow" ? 0.9 : 0.6;

  // === Star modal state ===
  const [showInfo, setShowInfo] = useState(false);
  // Eugene 2026-05-21 Босс «по нажатии на планету страны/города».
  const [showGeo, setShowGeo] = useState(false);
  const [geoData, setGeoData] = useState<{
    countries: Array<{ code: string; name: string; visits: number }>;
    cities: Array<{ city: string; code: string; visits: number }>;
    totalVisits: number;
  } | null>(null);
  const loadGeo = () => {
    fetch("/api/playlist/geo-top", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j) setGeoData(j); })
      .catch(() => {});
  };
  // Когда любая модалка открыта — паузим walking-musa тур.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const anyOpen = showInfo || showGeo;
    window.dispatchEvent(new CustomEvent(anyOpen ? "musa-chat-open" : "musa-chat-close"));
  }, [showInfo, showGeo]);
  const [showRating, setShowRating] = useState(false);
  const [starInput, setStarInput] = useState("");
  const [starUrlInput, setStarUrlInput] = useState("");
  const [starSubmitting, setStarSubmitting] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [starMsg, setStarMsg] = useState<string | null>(null);
  const [starTop, setStarTop] = useState<Array<{ name: string; url: string | null; votes: number }>>([]);

  const loadStarRating = () => {
    fetch("/api/star-suggestions/top?limit=10", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (j?.top) setStarTop(j.top.map((r: any) => ({ name: r.name_display, url: r.profile_url || null, votes: r.votes })));
      })
      .catch(() => {});
  };
  const voteForExisting = (name: string) => {
    fetch("/api/star-suggestions/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
      .then(r => r.json())
      .then(j => {
        if (j?.ok) { setStarMsg(`Сердечко поставлено ${name} ⭐`); loadStarRating(); }
        else if (j?.alreadyVoted) setStarMsg(`Голос за «${name}» учтён ранее`);
        else setStarMsg(j?.error || "Ошибка");
      })
      .catch(() => setStarMsg("Сеть недоступна"));
  };
  const submitStar = (e: React.FormEvent) => {
    e.preventDefault();
    const name = starInput.trim();
    const url = starUrlInput.trim();
    if (name.length < 2) { setStarMsg("Имя минимум 2 символа"); return; }
    if (!url) { setStarMsg("Ссылка на Instagram обязательна"); return; }
    setStarSubmitting(true);
    setStarMsg(null);
    fetch("/api/star-suggestions/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, profileUrl: url }),
    })
      .then(r => r.json())
      .then(j => {
        if (j?.ok) { setStarMsg(`Голос за «${name}» учтён ⭐`); setStarInput(""); setStarUrlInput(""); loadStarRating(); }
        else setStarMsg(j?.error || "Ошибка");
      })
      .catch(() => setStarMsg("Сеть недоступна"))
      .finally(() => setStarSubmitting(false));
  };

  // === SSE + initial fetch + anim-preference ===
  useEffect(() => {
    const applyStats = (j: any) => {
      if (j && typeof j.totalPlays === "number") {
        setStats(prev => {
          if (prev && prev.totalPlays !== j.totalPlays) setBumped(t => t + 1);
          return {
            totalPlays: j.totalPlays,
            totalTracks: j.totalTracks,
            todayPlays: typeof j.todayPlays === "number" ? j.todayPlays : prev?.todayPlays,
            onlineNow: typeof j.onlineNow === "number" ? j.onlineNow : prev?.onlineNow,
          };
        });
      }
    };
    const fetchStats = () => {
      fetch("/api/playlist/stats", { cache: "no-store" })
        .then(r => r.ok ? r.json() : null)
        .then(applyStats)
        .catch(() => {});
    };
    let es: EventSource | null = null;
    let pollInterval: any = null;
    if (typeof EventSource !== "undefined") {
      try {
        es = new EventSource("/api/playlist/stats/stream");
        es.addEventListener("stats", (ev: MessageEvent) => {
          try { applyStats(JSON.parse(ev.data)); } catch {}
        });
        pollInterval = setInterval(fetchStats, 120_000);
      } catch {
        fetchStats();
        pollInterval = setInterval(fetchStats, 60_000);
      }
    } else {
      fetchStats();
      pollInterval = setInterval(fetchStats, 60_000);
    }
    fetch("/api/user-preferences/anim-state", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j) { setAnimEnabled(!!j.enabled); setPermanentOff(!!j.permanentOff); } })
      .catch(() => {});
    return () => {
      if (pollInterval) clearInterval(pollInterval);
      if (es) { try { es.close(); } catch {} }
    };
  }, []);

  // === Milestone +1000 detection ===
  useEffect(() => {
    if (!animEnabled || stats == null) return;
    const prev = prevTotalRef.current;
    prevTotalRef.current = stats.totalPlays;
    if (prev == null || stats.totalPlays <= prev) return;
    try {
      const prevK = Math.floor(prev / 1000);
      const newK = Math.floor(stats.totalPlays / 1000);
      if (newK > prevK && newK > 0) {
        window.dispatchEvent(new CustomEvent("muza:milestone-1000", { detail: { milestone: newK * 1000 } }));
      }
    } catch {}
  }, [stats?.totalPlays, animEnabled]);

  const toggleAnim = () => {
    const newState = !animEnabled;
    setAnimEnabled(newState);
    fetch("/api/user-preferences/anim-toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: newState }),
    })
      .then(r => r.json())
      .then(j => { if (j?.state) { setAnimEnabled(!!j.state.enabled); setPermanentOff(!!j.state.permanentOff); } })
      .catch(() => {});
  };

  if (!stats || stats.totalPlays === 0) return null;

  const total = stats.totalPlays;
  const fmt = (n: number) => n.toLocaleString("ru-RU");

  return (
    <section
      className={`relative overflow-hidden rounded-[28px] border border-purple-500/20 p-5 ${className} ${animEnabled ? "uc-card-pulse" : ""}`}
      style={{
        // Eugene 2026-05-21 Босс «цвета в стиле основного плеера» — glass-card
        // как у playlist (мягкий violet+cyan tint, не deep-space pure).
        background: "linear-gradient(135deg, rgba(26,15,46,0.72) 0%, rgba(15,24,48,0.68) 50%, rgba(20,12,38,0.72) 100%)",
        backdropFilter: "blur(16px) saturate(140%)",
        WebkitBackdropFilter: "blur(16px) saturate(140%)",
        boxShadow: "0 0 40px rgba(139,92,246,0.18), 0 8px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)",
      }}
    >
      <style>{`
        @keyframes uc-card-pulse {
          0%, 100% { box-shadow: 0 0 60px rgba(139,92,246,0.18), 0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06); }
          50% { box-shadow: 0 0 80px rgba(139,92,246,0.35), 0 0 32px rgba(34,211,238,0.18), 0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.10); }
        }
        .uc-card-pulse { animation: uc-card-pulse 2.4s ease-in-out infinite; }
        @keyframes uc-num-bump {
          0% { transform: translateY(0) scale(1); filter: brightness(1); }
          30% { transform: translateY(-3px) scale(1.04); filter: brightness(1.4) drop-shadow(0 0 12px #FBBF24); }
          100% { transform: translateY(0) scale(1); filter: brightness(1); }
        }
        .uc-num-bump { animation: uc-num-bump 700ms ease-out; }
        @keyframes uc-growth-arrow {
          0% { transform: translateY(8px); opacity: 0; }
          40% { transform: translateY(-4px); opacity: 1; }
          100% { transform: translateY(-18px); opacity: 0; }
        }
        @keyframes uc-live-ping {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(2.8); opacity: 0; }
        }
        @keyframes uc-eq-bar { 0%, 100% { transform: scaleY(0.3); } 50% { transform: scaleY(1); } }
        /* Активные цифры — цикл brand-цветов violet → gold → cyan → violet */
        @keyframes uc-color-cycle {
          0%   { color: #C4B5FD; text-shadow: 0 0 6px #8B5CF6, 0 0 14px #A78BFA; }
          33%  { color: #FDE68A; text-shadow: 0 0 6px #FBBF24, 0 0 14px #FDE68A; }
          66%  { color: #67E8F9; text-shadow: 0 0 6px #22D3EE, 0 0 14px #67E8F9; }
          100% { color: #C4B5FD; text-shadow: 0 0 6px #8B5CF6, 0 0 14px #A78BFA; }
        }
        [data-active="1"] { animation: uc-color-cycle 6s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .uc-card-pulse, .uc-num-bump, [data-active="1"] { animation: none !important; }
        }
      `}</style>

      {/* Glow blobs — violet (top-right) + cyan (bottom-left) */}
      <div className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full bg-violet-500/20 blur-3xl" aria-hidden="true" />
      <div className="pointer-events-none absolute -bottom-20 -left-10 h-48 w-48 rounded-full bg-cyan-400/10 blur-3xl" aria-hidden="true" />

      {/* ===== Top row: badge + heading + big number + live eye ===== */}
      <div className="relative flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-white/60">
            <Sparkles className="h-3.5 w-3.5 text-[#FBBF24]" />
            Live pulse MuzaAi
          </div>

          <h3 className="text-sm font-medium tracking-wide text-white/70">Прослушивания</h3>

          <div className="mt-2 flex items-end gap-2 relative">
            {/* Eugene 2026-05-21 Босс «счётчик 000000 + эквалайзеры слева и справа
                как на главной». 6-digit padded, dim leading zeros (violet@0.22),
                bright active digits с цветовым циклом violet→gold→cyan. */}
            <div className="flex items-end gap-2">
              {/* Equalizer left */}
              <div className="flex items-end gap-[2px] h-7 pb-1" aria-hidden="true">
                {[0, 1, 2, 3].map(i => {
                  const playingAnim = animEnabled && audioState.playing && eqBaseSec > 0;
                  return (
                    <span
                      key={`eql-${i}`}
                      className="w-[2px] bg-gradient-to-t from-[#8B5CF6] via-[#A78BFA] to-[#22D3EE] rounded-full origin-bottom"
                      style={{
                        height: animEnabled ? "100%" : "40%",
                        animation: playingAnim
                          ? `uc-eq-bar ${eqBaseSec + i * 0.04}s ease-in-out infinite`
                          : animEnabled
                            ? `uc-eq-bar ${0.9 + i * 0.12}s ease-in-out infinite`
                            : "none",
                        animationDelay: `${i * 0.08}s`,
                      }}
                    />
                  );
                })}
              </div>

              <div
                key={`bump-${bumped}`}
                className={`font-mono text-4xl font-semibold tracking-tight ${bumped > 0 ? "uc-num-bump" : ""}`}
              >
                <RollingNumber value={total} />
              </div>

              {/* Equalizer right (mirror) */}
              <div className="flex items-end gap-[2px] h-7 pb-1" aria-hidden="true">
                {[3, 2, 1, 0].map(i => (
                  <span
                    key={`eqr-${i}`}
                    className="w-[2px] bg-gradient-to-t from-[#8B5CF6] via-[#A78BFA] to-[#22D3EE] rounded-full origin-bottom"
                    style={{
                      height: animEnabled ? "100%" : "40%",
                      animation: animEnabled ? `uc-eq-bar ${0.6 + i * 0.12}s ease-in-out infinite` : "none",
                      animationDelay: `${i * 0.1}s`,
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="mb-1 text-xs text-white/40">всего</div>
            {/* Growth arrow — fires on counter bump */}
            {bumped > 0 && animEnabled && (
              <span
                key={`arrow-${bumped}`}
                className="absolute -top-2 left-0 text-[#FBBF24] text-sm font-bold pointer-events-none"
                style={{ animation: "uc-growth-arrow 1.8s ease-out forwards", textShadow: "0 0 8px #FBBF24" }}
                aria-hidden="true"
              >
                ↑
              </span>
            )}
          </div>
        </div>

        {/* Planet — clickable button (rotating prograde, opens geo modal) */}
        <button
          type="button"
          onClick={() => { setShowGeo(true); loadGeo(); }}
          aria-label="Откуда слушают — страны и города"
          title="Откуда слушают"
          className="relative flex h-20 w-20 items-center justify-center flex-shrink-0 rounded-full hover:scale-105 active:scale-95 transition-transform z-10"
        >
          <div className="absolute inset-0 rounded-full border border-violet-400/20" />
          <div className="absolute inset-2 rounded-full border border-cyan-300/20" />
          <div
            className="absolute h-2 w-2 rounded-full bg-[#22D3EE]"
            style={{ boxShadow: "0 0 18px rgba(34,211,238,0.9)" }}
            aria-hidden="true"
          >
            <span
              className="absolute inset-0 rounded-full bg-[#22D3EE]"
              style={{ animation: animEnabled ? "uc-live-ping 1.8s ease-out infinite" : "none" }}
            />
          </div>
          <PlanetIcon className="relative h-12 w-12" />
        </button>
      </div>

      {/* Eugene 2026-05-21 Босс «убери сегодня и онлайн» — bottom grid удалён.
          todayPlays/onlineNow остаются в payload (для admin / future tabs),
          но не рендерятся в card. */}

      {/* ===== Buttons: i (info) + ✦/○ (anim toggle) ===== */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setShowInfo(v => !v); if (!showInfo) { setShowRating(true); loadStarRating(); } }}
        aria-label="Информация"
        title="Что будет после 1 000 000?"
        className="absolute top-3 right-3 w-6 h-6 rounded-full bg-white/8 hover:bg-white/15 border border-white/15 flex items-center justify-center text-[11px] italic font-bold text-white/70 hover:text-white transition-colors z-10"
      >
        i
      </button>

      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); toggleAnim(); }}
        aria-label={animEnabled ? "Отключить анимацию" : "Включить анимацию"}
        title={permanentOff ? "Анимация выключена постоянно. Жми чтобы включить." : animEnabled ? "Отключить на 1 день" : "Включить анимацию"}
        className="absolute bottom-3 right-3 w-5 h-5 rounded-full bg-white/8 hover:bg-white/15 border border-white/15 flex items-center justify-center text-[10px] text-white/60 hover:text-white transition-colors z-10"
      >
        {animEnabled ? "✦" : "○"}
      </button>

      {/* ===== Geo modal (portal to body) — Eugene 2026-05-21 Босс ===== */}
      {showGeo && typeof document !== "undefined" && createPortal(
        <>
          <div className="fixed inset-0 bg-black/75 z-[10000] animate-in fade-in duration-200"
            onClick={() => setShowGeo(false)} aria-hidden="true" />
          <div
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-5 py-4 rounded-3xl text-[13px] text-white z-[10001] animate-in fade-in zoom-in-95 duration-200"
            style={{
              width: "min(440px, calc(100vw - 24px))",
              maxHeight: "calc(100vh - 40px)",
              overflowY: "auto",
              background: "linear-gradient(135deg, rgba(7,8,18,0.92) 0%, rgba(20,16,44,0.88) 50%, rgba(12,30,76,0.92) 100%)",
              border: "1px solid rgba(139,92,246,0.25)",
              boxShadow: "0 32px 80px rgba(139,92,246,0.5), 0 0 60px rgba(34,211,238,0.18), inset 0 1px 0 rgba(255,255,255,0.10)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <h3 className="text-[15px] font-display font-bold flex items-center gap-2">
                  🌍 <span className="bg-gradient-to-r from-[#A78BFA] to-[#22D3EE] bg-clip-text text-transparent">Откуда слушают</span>
                </h3>
                <p className="text-[11px] text-white/55 mt-1">Последние 30 дней · {geoData ? geoData.totalVisits.toLocaleString("ru-RU") : "—"} визитов</p>
              </div>
              <button onClick={() => setShowGeo(false)} className="text-white/70 hover:text-white text-[20px] leading-none">×</button>
            </div>

            {!geoData ? (
              <div className="text-center py-6 text-white/50 text-[12px]">Загружаю…</div>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-[#FBBF24] mb-2 font-semibold flex items-center gap-1">
                    <span>🏳️</span> Топ стран
                  </div>
                  {geoData.countries.length === 0 ? (
                    <div className="text-[11px] text-white/40">Нет данных за период</div>
                  ) : (
                    <ol className="space-y-1.5 list-none">
                      {geoData.countries.map((c, i) => {
                        const pct = geoData.totalVisits > 0 ? Math.round((c.visits / geoData.totalVisits) * 100) : 0;
                        return (
                          <li key={c.code} className="flex items-center gap-2 text-[12px]">
                            <span className="text-white/50 w-5 font-mono">{i + 1}.</span>
                            <span className="text-white/85 flex-1 truncate">{c.name}</span>
                            <span className="text-white/60 font-mono text-[11px]">{c.visits.toLocaleString("ru-RU")}</span>
                            <span className="text-[#22D3EE] font-mono text-[10px] w-10 text-right">{pct}%</span>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>

                <div>
                  <div className="text-[11px] uppercase tracking-wider text-[#A78BFA] mb-2 font-semibold flex items-center gap-1">
                    <span>📍</span> Топ городов
                  </div>
                  {geoData.cities.length === 0 ? (
                    <div className="text-[11px] text-white/40">Нет данных за период</div>
                  ) : (
                    <ol className="space-y-1.5 list-none">
                      {geoData.cities.map((c, i) => (
                        <li key={`${c.city}-${c.code}`} className="flex items-center gap-2 text-[12px]">
                          <span className="text-white/50 w-5 font-mono">{i + 1}.</span>
                          <span className="text-white/85 flex-1 truncate">{c.city} <span className="text-white/40 text-[10px]">{c.code}</span></span>
                          <span className="text-white/60 font-mono text-[11px]">{c.visits.toLocaleString("ru-RU")}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            )}
          </div>
        </>,
        document.body
      )}

      {/* ===== Star modal (portal to body) ===== */}
      {showInfo && typeof document !== "undefined" && createPortal(
        <>
          {/* Eugene 2026-05-21 Босс «размазано при нажатии на и» — backdrop без
              blur (только тёмная заливка) + z-index выше walking-musa (z=9998),
              чтобы Музa с bubble не перекрывала модалку. */}
          <div
            className="fixed inset-0 bg-black/75 z-[10000] animate-in fade-in duration-200"
            onClick={() => setShowInfo(false)}
            aria-hidden="true"
          />
          <div
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-5 py-4 rounded-3xl text-[13px] text-white z-[10001] animate-in fade-in zoom-in-95 duration-200"
            style={{
              width: "min(440px, calc(100vw - 24px))",
              maxHeight: "calc(100vh - 40px)",
              overflowY: "auto",
              background: "linear-gradient(135deg, rgba(7,8,18,0.92) 0%, rgba(20,16,44,0.88) 50%, rgba(12,30,76,0.92) 100%)",
              backdropFilter: "blur(40px) saturate(180%)",
              WebkitBackdropFilter: "blur(40px) saturate(180%)",
              border: "1px solid rgba(139,92,246,0.25)",
              boxShadow: "0 32px 80px rgba(139,92,246,0.5), 0 8px 24px rgba(0,0,0,0.45), 0 0 60px rgba(34,211,238,0.18), inset 0 1px 0 rgba(255,255,255,0.10)",
              position: "relative",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Glass highlights */}
            <div aria-hidden="true" style={{ position: "absolute", top: 0, left: 0, right: 0, height: "45%", background: "linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.02) 60%, transparent 100%)", pointerEvents: "none", borderRadius: "24px 24px 0 0" }} />
            <div aria-hidden="true" style={{ position: "absolute", top: "-30%", right: "-20%", width: "70%", height: "70%", background: "radial-gradient(circle, rgba(34,211,238,0.22) 0%, transparent 70%)", pointerEvents: "none" }} />
            <div aria-hidden="true" style={{ position: "absolute", bottom: "-30%", left: "-20%", width: "70%", height: "70%", background: "radial-gradient(circle, rgba(139,92,246,0.28) 0%, transparent 70%)", pointerEvents: "none" }} />

            <div style={{ position: "relative", zIndex: 1 }}>
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="text-[14px] font-semibold leading-relaxed">
                  ✨ Когда наш плейлист дойдёт до <b className="font-mono text-[#FBBF24] text-[15px]">1 000 000</b> прослушиваний — маякнём{" "}
                  <button type="button" onClick={() => { setShowRating(v => !v); if (!showRating) loadStarRating(); }}
                    className="underline decoration-wavy decoration-[#FBBF24] hover:no-underline font-bold text-[#FDE68A]">мировой звезде</button>!
                  <div className="mt-1.5 text-[11px] text-white/75 font-normal leading-relaxed">
                    Кого предложишь? Голосуем кто заслуживает услышать наших авторов. За одно имя — один голос с твоего IP.
                  </div>
                </div>
                <button onClick={() => setShowInfo(false)} className="text-white/70 hover:text-white text-[20px] leading-none flex-shrink-0" aria-label="Закрыть">×</button>
              </div>

              {showRating && starTop.length > 0 && (
                <div className="mb-3 bg-black/25 rounded-xl p-3 border border-white/10">
                  <div className="text-[11px] uppercase tracking-wider text-white/70 mb-2 font-semibold">🏆 Топ рейтинг</div>
                  <ol className="space-y-1.5 list-none">
                    {starTop.map((s, i) => (
                      <li key={s.name} className="flex items-center justify-between gap-2 text-[12px]">
                        <span className="text-white/60 w-5 font-mono">{i + 1}.</span>
                        {s.url ? (
                          <a href={s.url} target="_blank" rel="noopener noreferrer"
                            className="flex-1 truncate text-white hover:text-[#22D3EE] underline decoration-dotted hover:no-underline transition-colors">{s.name}</a>
                        ) : (<span className="flex-1 truncate text-white/80">{s.name}</span>)}
                        <button type="button" onClick={() => voteForExisting(s.name)}
                          className="flex items-center gap-1 text-[#FBBF24] font-bold hover:scale-110 active:scale-95 transition-transform">
                          <HeartIcon filled className="w-4 h-4" />
                          <span className="font-mono text-[12px]">{s.votes}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {!showAddForm ? (
                <>
                  <button type="button" onClick={() => setShowAddForm(true)}
                    className="w-full py-2.5 rounded-lg bg-white/95 hover:bg-white text-[#070812] border border-white/30 text-[13px] font-semibold transition-all flex items-center justify-center gap-2 hover:scale-[1.01] active:scale-95 shadow-md">
                    <span className="text-[16px] leading-none font-bold">＋</span>
                    <span>Добавить свою звезду</span>
                  </button>
                  {starMsg && <div className="text-[12px] text-[#FBBF24] mt-2 text-center">{starMsg}</div>}
                </>
              ) : (
                <form onSubmit={submitStar} className="space-y-2">
                  <div className="text-[12px] text-white/85 font-semibold flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <HeartIcon filled className="w-3.5 h-3.5 text-[#FBBF24]" />
                      <span>Добавляем звезду</span>
                    </span>
                    <button type="button" onClick={() => { setShowAddForm(false); setStarInput(""); setStarUrlInput(""); setStarMsg(null); }}
                      className="text-white/60 hover:text-white text-[16px] leading-none">×</button>
                  </div>
                  <input type="text" value={starInput} onChange={(e) => setStarInput(e.target.value)}
                    placeholder="Имя звезды (например Beyoncé)" maxLength={60} autoFocus
                    className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/20 text-[13px] text-white placeholder:text-white/40 focus:outline-none focus:border-[#8B5CF6]" />
                  <input type="url" value={starUrlInput} onChange={(e) => setStarUrlInput(e.target.value)}
                    placeholder="Instagram URL (обязательно)" maxLength={120}
                    className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/20 text-[13px] text-white placeholder:text-white/40 focus:outline-none focus:border-[#8B5CF6]" />
                  <button type="submit" disabled={starSubmitting}
                    className={`w-full py-2 rounded-lg disabled:opacity-50 border text-[13px] font-semibold transition-all flex items-center justify-center gap-2 ${starSubmitting ? "bg-white/15 border-white/20" : "bg-[#8B5CF6]/30 hover:bg-[#8B5CF6]/50 border-[#8B5CF6]/40 hover:scale-[1.01] active:scale-95"}`}>
                    {starSubmitting ? "Проверяем аккаунт..." : (<><HeartIcon filled className="w-4 h-4 text-[#FBBF24]" /><span>Добавить и поставить ❤</span></>)}
                  </button>
                  {starMsg && <div className="text-[12px] text-[#FBBF24] leading-relaxed">{starMsg}</div>}
                  <div className="text-[10px] text-white/55 leading-snug">Проверим что аккаунт существует. Сердечко поставится автоматом.</div>
                </form>
              )}
            </div>
          </div>
        </>,
        document.body
      )}
    </section>
  );
}
