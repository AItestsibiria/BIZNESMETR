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

// Eugene 2026-05-21 Босс «направление и скорость по науке. Точка обзора
// центральная это экватор. Добавь луну слева вверху по научному».
//
// Earth: 3D rotateY вокруг полярной оси (вертикальная). Скорость 60s/оборот
// (real Earth 24h — visual scale ×1440). Направление positive rotateY =
// surface drifts LEFT — соответствует виду с восточной стороны (где Африка
// уезжает на наш запад = влево).
//
// Moon: орбита prograde (counterclockwise от north pole, same as Earth's
// rotation). Старт в top-left как просил Boss. Период real ~27 days,
// visual 90s. Размер ~27% от Earth (real 1737km / Earth 6371km = 27.3%).
// Eugene 2026-05-21 Босс «глянцевая насыщенная Земля как привыкли видеть.
// Географически правильные континенты учитывая угол поворота, делай 3d».
//
// View: Africa-centric (как 🌍 emoji + NASA Blue Marble Atlantic-facing).
// Visible: Greenland (top-left edge), Europe, North Africa, Sahara, sub-Saharan,
//   Madagascar, Arabian peninsula (right), partial India (right edge),
//   partial South America (left edge), Antarctic ice cap hint (bottom edge).
//
// 3D depth: multi-stop radial gradient ocean + atmospheric rim (Fresnel) +
//   strong specular highlight top-left + terminator shadow bottom-right +
//   edge darkening для sphere illusion.
function PlanetIcon({ size = 80 }: { size?: number }) {
  const uid = String(Math.random()).slice(2, 8);
  const earthSize = Math.round(size * 0.92);
  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        width: `${size}px`,
        height: `${size}px`,
      }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 100 100"
        width={earthSize}
        height={earthSize}
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          filter: "drop-shadow(0 4px 12px rgba(0,0,0,0.5)) drop-shadow(0 0 10px rgba(56,189,248,0.35))",
        }}
      >
        <defs>
          {/* Глянцевый океан — глубокий насыщенный синий с яркими highlights */}
          <radialGradient id={`ocean-${uid}`} cx="0.33" cy="0.27" r="0.85">
            <stop offset="0%" stopColor="#B3E5FC" />
            <stop offset="18%" stopColor="#4FC3F7" />
            <stop offset="42%" stopColor="#0288D1" />
            <stop offset="72%" stopColor="#01579B" />
            <stop offset="100%" stopColor="#062043" />
          </radialGradient>
          {/* Континенты — насыщенный saturated green to sand */}
          <linearGradient id={`land-${uid}`} x1="0" y1="0" x2="0.2" y2="1">
            <stop offset="0%" stopColor="#A8E063" />
            <stop offset="40%" stopColor="#56AB2F" />
            <stop offset="75%" stopColor="#7BAE54" />
            <stop offset="100%" stopColor="#C7A437" />
          </linearGradient>
          {/* Sand/desert gradient для Сахары/Аравии */}
          <linearGradient id={`sand-${uid}`} x1="0" y1="0" x2="0.1" y2="1">
            <stop offset="0%" stopColor="#E8C674" />
            <stop offset="100%" stopColor="#B8893A" />
          </linearGradient>
          {/* Ice/polar — для Антарктики и Гренландии */}
          <radialGradient id={`ice-${uid}`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="100%" stopColor="#D8E8F0" />
          </radialGradient>
          {/* Atmosphere — толстый cyan halo для glossy feel */}
          <radialGradient id={`atmos-${uid}`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="83%" stopColor="rgba(135,206,250,0)" />
            <stop offset="93%" stopColor="rgba(135,206,250,0.55)" />
            <stop offset="98%" stopColor="rgba(135,206,250,0.25)" />
            <stop offset="100%" stopColor="rgba(135,206,250,0)" />
          </radialGradient>
          {/* Terminator + edge darkening — сильный 3D shadow */}
          <radialGradient id={`shadow-${uid}`} cx="0.75" cy="0.8" r="0.65">
            <stop offset="0%" stopColor="rgba(0,0,0,0.45)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </radialGradient>
          {/* Fresnel rim — тёмный edge для sphere depth */}
          <radialGradient id={`rim-${uid}`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="82%" stopColor="rgba(0,0,0,0)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.45)" />
          </radialGradient>
          {/* Glossy specular highlight */}
          <radialGradient id={`spec-${uid}`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="rgba(255,255,255,0.55)" />
            <stop offset="60%" stopColor="rgba(255,255,255,0.1)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </radialGradient>
          <clipPath id={`clip-${uid}`}>
            <circle cx="50" cy="50" r="47" />
          </clipPath>
        </defs>

        {/* Atmosphere halo (cyan glow snaружи) */}
        <circle cx="50" cy="50" r="50" fill={`url(#atmos-${uid})`} />

        {/* Ocean base */}
        <circle cx="50" cy="50" r="47" fill={`url(#ocean-${uid})`} />

        {/* Континенты — clipped круг, географически верные */}
        <g clipPath={`url(#clip-${uid})`}>
          {/* === Antarctica (ice cap, bottom edge) === */}
          <path d="M10 88 Q30 92 50 92 Q70 92 90 88 Q80 96 50 96 Q20 96 10 88 Z" fill={`url(#ice-${uid})`} opacity="0.85" />

          {/* === Greenland (top-left edge, ice) === */}
          <path d="M14 18 Q18 14 24 18 Q26 24 22 28 Q16 26 14 22 Z" fill={`url(#ice-${uid})`} stroke="#A8C8E0" strokeWidth="0.3" />

          {/* === South America fragment (left edge, partial) === */}
          <g fill={`url(#land-${uid})`} stroke="#2E5C18" strokeWidth="0.4">
            <path d="M6 50 Q4 56 6 62 Q10 70 12 72 Q14 70 12 60 Q10 52 8 50 Z" />
          </g>

          {/* === North America fragment (top-left edge, partial) === */}
          <g fill={`url(#land-${uid})`} stroke="#2E5C18" strokeWidth="0.4">
            <path d="M8 28 Q6 32 8 38 Q12 42 14 38 Q16 32 12 28 Z" />
          </g>

          {/* === Iceland === */}
          <ellipse cx="30" cy="20" rx="2.5" ry="1.5" fill={`url(#land-${uid})`} />

          {/* === Europe (Iberian, France, Italy, Scandinavia hints) === */}
          <g fill={`url(#land-${uid})`} stroke="#2E5C18" strokeWidth="0.35">
            <path d="M30 28 Q34 26 38 28 Q40 32 36 34 Q32 33 30 30 Z" />
            <path d="M40 24 Q46 22 50 26 Q49 30 44 30 Q41 28 40 25 Z" />
            <path d="M44 32 L46 36 L48 33 Z" />
          </g>

          {/* === Africa — точный силуэт (boot + horn) === */}
          <g fill={`url(#land-${uid})`} stroke="#2E5C18" strokeWidth="0.4">
            <path d="M36 38 Q31 40 30 46 Q29 52 32 58 Q34 64 38 70 Q42 76 48 77 Q55 76 58 70 Q62 62 62 54 Q62 46 58 40 Q52 36 44 36 Q40 36 36 38 Z" />
            {/* Sahara desert overlay */}
            <path d="M36 40 Q43 38 52 40 Q55 44 52 47 Q44 47 38 45 Z" fill={`url(#sand-${uid})`} stroke="none" opacity="0.85" />
          </g>

          {/* === Madagascar === */}
          <path d="M65 64 Q67 62 68 66 Q67 71 65 71 Z" fill={`url(#land-${uid})`} stroke="#2E5C18" strokeWidth="0.3" />

          {/* === Arabian peninsula === */}
          <g fill={`url(#sand-${uid})`} stroke="#7A5520" strokeWidth="0.35">
            <path d="M60 32 Q66 30 72 33 Q74 38 70 41 Q64 40 60 36 Z" />
          </g>

          {/* === India fragment (right edge, partial) === */}
          <g fill={`url(#land-${uid})`} stroke="#2E5C18" strokeWidth="0.4">
            <path d="M80 36 Q86 34 88 40 Q86 46 82 46 Q78 42 80 38 Z" />
          </g>

          {/* === Asia/Russia fragment (top-right edge) === */}
          <g fill={`url(#land-${uid})`} stroke="#2E5C18" strokeWidth="0.4">
            <path d="M70 20 Q80 18 88 22 Q92 26 90 30 Q82 28 74 26 Q70 24 70 20 Z" />
          </g>

          {/* Subtle cloud wisps (white, transparent) для глянца */}
          <g fill="white" opacity="0.12">
            <ellipse cx="25" cy="50" rx="8" ry="2" />
            <ellipse cx="70" cy="60" rx="6" ry="1.5" />
            <ellipse cx="55" cy="80" rx="10" ry="2" />
          </g>
        </g>

        {/* Terminator shadow (внутри диска) */}
        <circle cx="50" cy="50" r="47" fill={`url(#shadow-${uid})`} />

        {/* Fresnel rim (edge darkening) */}
        <circle cx="50" cy="50" r="47" fill={`url(#rim-${uid})`} />

        {/* Glossy specular highlight (sphere shine) */}
        <ellipse cx="32" cy="28" rx="20" ry="13" fill={`url(#spec-${uid})`} />
        <ellipse cx="28" cy="22" rx="6" ry="3.5" fill="white" opacity="0.55" />
      </svg>
    </span>
  );
}

interface Stats {
  totalPlays: number;
  totalTracks: number;
  todayPlays?: number;
  onlineNow?: number;
}

// Eugene 2026-05-21 Босс «страны на английском с флагами везде».
// ISO 3166-1 alpha-2 country code → emoji flag (regional indicator letters).
function codeToFlag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return "🏳️";
  try {
    const cc = code.toUpperCase();
    return String.fromCodePoint(...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
  } catch {
    return "🏳️";
  }
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
    totalCountries: number;
  } | null>(null);
  // Eugene 2026-05-21 Босс «количество стран с одной точки сбора, совпадать с
  // планетой на плеере». /api/public/countries-count — тот же endpoint что
  // landing.tsx player (🌍 N). Single source of truth.
  const [countriesCount, setCountriesCount] = useState<number>(0);
  const loadGeo = () => {
    fetch("/api/playlist/geo-top", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j) setGeoData(j); })
      .catch(() => {});
  };
  useEffect(() => {
    // Eugene 2026-05-21 Босс «количество визитов обновляй 1 раз в минуту на
    // панели стран» — countries-count + geoData polling = 60s (было 30s).
    // Real-time enough для «живой» панели, но не дёргаем БД каждые 30 сек
    // (учитывая что P2 индексы ещё не применены и COUNT FROM visitors — full scan).
    const refresh = () => {
      fetch("/api/public/countries-count", { cache: "no-store" })
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j && typeof j.countries === "number") setCountriesCount(j.countries); })
        .catch(() => {});
      loadGeo();
    };
    refresh();
    const interval = setInterval(refresh, 60_000);
    return () => clearInterval(interval);
  }, []);
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
      // Eugene 2026-05-21 Босс «стилизуй под панель плеера + кнопка справа внизу
      // включает подсветку как на основном плеере». glass-card + brand glow когда
      // animEnabled=true (как btn-cosmic shimmer на CTA), off — простой glass.
      className={`relative overflow-hidden glass-card rounded-2xl border ${animEnabled ? "border-purple-400/30 uc-active-glow" : "border-white/[0.06]"} p-5 transition-all duration-500 ${className}`}
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
        /* Eugene 2026-05-21 Босс «кнопка справа внизу включает подсветку как
           на основном плеере». Brand-glow violet+cyan, дышит 3s. Toggle через
           animEnabled (✦/○ кнопка). */
        @keyframes uc-active-glow {
          0%, 100% { box-shadow: 0 0 20px rgba(139,92,246,0.25), 0 0 40px rgba(34,211,238,0.10), inset 0 1px 0 rgba(255,255,255,0.06); }
          50% { box-shadow: 0 0 32px rgba(139,92,246,0.45), 0 0 60px rgba(34,211,238,0.22), inset 0 1px 0 rgba(255,255,255,0.10); }
        }
        .uc-active-glow { animation: uc-active-glow 3s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .uc-active-glow { animation: none; }
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

      {/* Eugene 2026-05-21 Босс «Live отцентруй» — badge на отдельной строке,
          центр всей card'ы (а не left-aligned в первой колонке). */}
      <div className="relative flex justify-center mb-3">
        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-sans text-white/60">
          <Sparkles className="h-3.5 w-3.5 text-[#FBBF24]" />
          Live pulse MuzaAi
        </div>
      </div>

      {/* ===== Main row: heading + number + planet ===== */}
      <div className="relative flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0 flex flex-col items-center">
          <div className="flex items-end gap-2 relative">
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

              {/* Eugene 2026-05-21 Босс «🎧 центр 6 условных цифр» — 🎧 в одной
                  колонке с цифрами (flex-col items-center), eq-bars flanking
                  эту колонку. Центрирование 🎧 строго над 6-digit number. */}
              <div className="flex flex-col items-center">
                <span className="text-xl leading-none mb-0.5" aria-hidden="true">🎧</span>
                <div
                  key={`bump-${bumped}`}
                  className={`font-display font-bold text-4xl tracking-tight ${bumped > 0 ? "uc-num-bump" : ""}`}
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  <RollingNumber value={total} />
                </div>
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
            <div className="mb-1 text-xs font-sans text-white/40">всего</div>
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

        {/* Eugene 2026-05-21 Босс «страны над планетой, визиты под планетой».
            Layout: [N стран] / 🌍 / [M визитов] — flex-col items-center. */}
        <div className="relative flex flex-col items-center flex-shrink-0 z-10">
          {/* Сверху над планетой: страны (countriesCount из /api/public/countries-count) */}
          {countriesCount > 0 && (() => {
            const mod10 = countriesCount % 10;
            const mod100 = countriesCount % 100;
            let word: string;
            if (mod100 >= 11 && mod100 <= 14) word = "стран";
            else if (mod10 === 1) word = "страна";
            else if (mod10 >= 2 && mod10 <= 4) word = "страны";
            else word = "стран";
            return (
              <div className="mb-1 text-[10px] text-white/65 font-sans whitespace-nowrap">
                <span className="text-[#22D3EE] font-semibold" style={{ fontVariantNumeric: "tabular-nums" }}>{countriesCount}</span>
                <span className="text-white/45"> {word}</span>
              </div>
            );
          })()}

          <button
            type="button"
            onClick={() => { setShowGeo(true); loadGeo(); }}
            aria-label="Откуда слушают — страны и города"
            title="Откуда слушают"
            className="relative flex h-20 w-20 items-center justify-center rounded-full hover:scale-105 active:scale-95 transition-transform"
          >
            <PlanetIcon size={80} />
          </button>

          {/* Снизу под планетой: визиты (geoData.totalVisits за 30 дней) */}
          {geoData && geoData.totalVisits > 0 && (() => {
            const n = geoData.totalVisits;
            const mod10 = n % 10;
            const mod100 = n % 100;
            let word: string;
            if (mod100 >= 11 && mod100 <= 14) word = "визитов";
            else if (mod10 === 1) word = "визит";
            else if (mod10 >= 2 && mod10 <= 4) word = "визита";
            else word = "визитов";
            return (
              <div className="mt-1 text-[10px] text-white/65 font-sans whitespace-nowrap">
                <span className="text-[#FBBF24] font-semibold" style={{ fontVariantNumeric: "tabular-nums" }}>{n.toLocaleString("ru-RU")}</span>
                <span className="text-white/45"> {word}</span>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Eugene 2026-05-21 Босс «убери сегодня и онлайн» — bottom grid удалён.
          todayPlays/onlineNow остаются в payload (для admin / future tabs),
          но не рендерятся в card. */}

      {/* Eugene 2026-05-21 Босс «убери i и другую внизу справа кнопки с
          панели» — i (info) + ✦/○ (anim toggle) удалены. Star modal
          по-прежнему доступен через клик на цифру/планету (если потребуется
          вернём триггер). animEnabled остаётся state'ом но не toggleable. */}

      {/* ===== Geo modal (portal to body) — Eugene 2026-05-21 Босс ===== */}
      {showGeo && typeof document !== "undefined" && createPortal(
        <>
          <div className="fixed inset-0 bg-black/75 z-[10000] animate-in fade-in duration-200"
            onClick={() => setShowGeo(false)} aria-hidden="true" />
          {/* Eugene 2026-05-21 Босс «при нажатии i расплывается опять».
              ROOT CAUSE: glass-card имеет backdrop-filter blur(40px), который
              compound'ит с blur counter card'ы сзади = размазывание.
              FIX: solid deep-space фон без backdrop-filter, border/shadow в духе
              player panel вручную. */}
          <div
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-5 py-4 rounded-2xl border border-white/[0.08] text-[13px] text-white z-[10001] animate-in fade-in zoom-in-95 duration-200"
            style={{
              width: "min(440px, calc(100vw - 24px))",
              maxHeight: "calc(100vh - 40px)",
              overflowY: "auto",
              background: "#0F0A28",
              boxShadow: "0 24px 48px rgba(0,0,0,0.6), 0 0 32px rgba(139,92,246,0.18), inset 0 0.5px 0 rgba(255,255,255,0.08)",
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
                      {/* Eugene 2026-05-21 Босс «при равенстве округлённых % Россия выше».
                          Post-process: считаем pct, сортируем по pct DESC + RU-first tie-break.
                          Stable sort (sort с numeric compare) сохраняет server-order для не-RU ties. */}
                      {(() => {
                        const withPct = geoData.countries.map(c => ({
                          ...c,
                          pct: geoData.totalVisits > 0 ? Math.round((c.visits / geoData.totalVisits) * 100) : 0,
                        }));
                        withPct.sort((a, b) => {
                          if (b.pct !== a.pct) return b.pct - a.pct;
                          // Тiе по %: Russia первая
                          if (a.code === "RU" && b.code !== "RU") return -1;
                          if (b.code === "RU" && a.code !== "RU") return 1;
                          // Иначе сохраняем server-order (по visits DESC)
                          return b.visits - a.visits;
                        });
                        return withPct.map((c, i) => (
                          <li key={c.code} className="flex items-center gap-2 text-[12px]">
                            <span className="text-white/50 w-5 font-mono">{i + 1}.</span>
                            <span className="text-base leading-none">{codeToFlag(c.code)}</span>
                            <span className="text-white/85 flex-1 truncate">{c.name}</span>
                            <span className="text-[#22D3EE] font-mono text-[12px] w-12 text-right font-semibold">{c.pct}%</span>
                          </li>
                        ));
                      })()}
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
                      {/* Eugene 2026-05-21 Босс «города без счётчика + флаги» */}
                      {geoData.cities.map((c, i) => (
                        <li key={`${c.city}-${c.code}`} className="flex items-center gap-2 text-[12px]">
                          <span className="text-white/50 w-5 font-mono">{i + 1}.</span>
                          <span className="text-base leading-none">{codeToFlag(c.code)}</span>
                          <span className="text-white/85 flex-1 truncate">{c.city}</span>
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
          {/* Eugene 2026-05-21 Босс «при нажатии i расплывается опять» fix — без
              glass-card (его backdrop-blur compound'ил с card'ой сзади). Solid bg. */}
          <div
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-5 py-4 rounded-2xl border border-white/[0.08] text-[13px] text-white z-[10001] animate-in fade-in zoom-in-95 duration-200"
            style={{
              width: "min(440px, calc(100vw - 24px))",
              maxHeight: "calc(100vh - 40px)",
              overflowY: "auto",
              background: "#0F0A28",
              boxShadow: "0 24px 48px rgba(0,0,0,0.6), 0 0 32px rgba(139,92,246,0.18), inset 0 0.5px 0 rgba(255,255,255,0.08)",
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
