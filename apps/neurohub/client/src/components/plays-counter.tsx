// Eugene 2026-05-21 Босс: «самый динамичный счётчик в мире — все 5 вариантов».
//
// Комбо:
// 1. Slot Machine — digits крутятся вертикально к новому значению
// 2. Cosmic Orbit — 3 планеты вращаются вокруг counter'а
// 3. Heartbeat Pulse — scale + glow каждые 600ms
// 4. Music Equalizer — 5 vertical bars играют ритм
// 5. Neon Sign — flicker + electric underline
//
// CSS-only (без heavy JS framers), GPU-accelerated (transform/opacity),
// prefers-reduced-motion safe.

import { useEffect, useState, useRef } from "react";

interface Stats {
  totalPlays: number;
  totalTracks: number;
}

// Single rolling digit (Slot Machine effect). Eugene 2026-05-21:
// - Явный color (override gradient clip от родителя)
// - Blink при изменении value (анимация + post-rocket fade-back)
// - Forwards ref для измерения позиции (для rocket launch)
const RollingDigit = ({ value, blinkPhase, lastInRow }: { value: number; blinkPhase: "idle" | "blink-pre" | "blink-post"; lastInRow?: boolean }) => {
  const safeValue = Math.max(0, Math.min(9, value));
  const blinkClass = blinkPhase !== "idle" ? "uc-digit-blink" : "";
  return (
    <span
      data-uc-digit={lastInRow ? "last" : undefined}
      className={`inline-block overflow-hidden align-baseline relative ${blinkClass}`}
      style={{
        width: "0.62em",
        height: "1em",
        lineHeight: "1em",
        color: "#fde68a",
        textShadow: "0 0 8px #f0abfc, 0 0 16px #67e8f9, 0 0 24px #c084fc",
        WebkitTextFillColor: "#fde68a",
      }}
    >
      <span
        className="block transition-transform duration-[1500ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]"
        style={{ transform: `translateY(-${safeValue}em)`, willChange: "transform" }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
          <span key={d} className="block text-center" style={{ height: "1em", lineHeight: "1em" }}>{d}</span>
        ))}
      </span>
    </span>
  );
};

// Number formatted with thousand separator, each digit as RollingDigit.
// blinkPhase передаётся для last digit (правый край — там «растёт» число).
function RollingNumber({ value, blinkPhase }: { value: number; blinkPhase: "idle" | "blink-pre" | "blink-post" }) {
  const formatted = value.toLocaleString("ru-RU");
  const chars = formatted.split("");
  // Найти индекс последней цифры (не разделитель)
  let lastDigitIdx = -1;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (Number.isFinite(parseInt(chars[i], 10))) { lastDigitIdx = i; break; }
  }
  return (
    <>
      {chars.map((ch, i) => {
        const digit = parseInt(ch, 10);
        if (Number.isFinite(digit)) {
          return <RollingDigit key={`${i}-${ch}`} value={digit} blinkPhase={i === lastDigitIdx ? blinkPhase : "idle"} lastInRow={i === lastDigitIdx} />;
        }
        return <span key={`${i}-sep`} className="inline-block">{ch}</span>;
      })}
    </>
  );
}

export function PlaysCounter({ className = "" }: { className?: string }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [tick, setTick] = useState(0); // для re-trigger flash при изменении
  // Eugene 2026-05-21 Босс «новая цифра моргает → ракета вылетает → моргает обратно».
  // blinkPhase: idle (нет события) | blink-pre (моргание перед launch) | blink-post (моргание после landing).
  const [blinkPhase, setBlinkPhase] = useState<"idle" | "blink-pre" | "blink-post">("idle");
  const prevTotalRef = useRef<number | null>(null);
  // Eugene 2026-05-21 Босс: «кнопка отключить анимации на 1 день. 3 дня
  // подряд = до явного включения. По IP». State от server.
  const [animEnabled, setAnimEnabled] = useState(true);
  const [permanentOff, setPermanentOff] = useState(false);

  useEffect(() => {
    const fetchStats = () => {
      fetch("/api/playlist/stats", { cache: "no-store" })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (j && typeof j.totalPlays === "number") {
            setStats(prev => {
              if (prev && prev.totalPlays !== j.totalPlays) {
                setTick(t => t + 1);
              }
              return j;
            });
          }
        })
        .catch(() => {});
    };
    fetchStats();
    const interval = setInterval(fetchStats, 60_000);

    // Eugene 2026-05-21 Босс: «появление новой цифры → blink → ракета → blink».
    // Listener на back-event от ракеты «landed» — повторяем blink.
    const onRocketLanded = () => setBlinkPhase("blink-post");
    window.addEventListener("muza:rocket-landed", onRocketLanded as EventListener);

    // Read animation preference (by IP, server-side)
    fetch("/api/user-preferences/anim-state", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (j) {
          setAnimEnabled(!!j.enabled);
          setPermanentOff(!!j.permanentOff);
        }
      })
      .catch(() => {});

    return () => {
      clearInterval(interval);
      window.removeEventListener("muza:rocket-landed", onRocketLanded as EventListener);
    };
  }, []);

  // Eugene 2026-05-21 Босс: «логика — новая цифра моргает, появляется ракета,
  // после взлёта моргает обратно». Sequence:
  // 1. totalPlays растёт → blink-pre (моргание) 600ms
  // 2. Через 600ms → dispatch 'muza:counter-up' с position last-digit (DOM rect)
  //    → RocketLaunch ловит и spawn'ит ракету из этой позиции
  // 3. Ракета летит (4-6 сек) → rocket-landed event back → blink-post 600ms
  // 4. blink-post → idle
  useEffect(() => {
    if (!animEnabled) return;
    if (stats == null) return;
    const prev = prevTotalRef.current;
    prevTotalRef.current = stats.totalPlays;
    if (prev == null || stats.totalPlays <= prev) return;

    // Phase 1: blink-pre
    setBlinkPhase("blink-pre");
    const t1 = setTimeout(() => {
      // Phase 2: spawn ракеты из позиции last-digit
      try {
        const lastDigit = document.querySelector('[data-uc-digit="last"]') as HTMLElement | null;
        if (lastDigit) {
          const rect = lastDigit.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          window.dispatchEvent(new CustomEvent("muza:counter-up", {
            detail: {
              x: cx,
              y: cy,
              delta: stats.totalPlays - (prev || 0),
            },
          }));
        }
      } catch {}
      setBlinkPhase("idle");
    }, 600);

    // Phase 3 (blink-post) приходит через listener на 'muza:rocket-landed'.
    // На случай если listener не сработает — auto-fallback через 7 сек.
    const t2 = setTimeout(() => {
      setBlinkPhase(prev => prev === "blink-post" ? "idle" : prev);
    }, 7000);

    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [stats?.totalPlays, animEnabled]);

  // Auto-fade blink-post через 600ms
  useEffect(() => {
    if (blinkPhase !== "blink-post") return;
    const t = setTimeout(() => setBlinkPhase("idle"), 600);
    return () => clearTimeout(t);
  }, [blinkPhase]);

  const toggleAnim = () => {
    const newState = !animEnabled;
    setAnimEnabled(newState);
    fetch("/api/user-preferences/anim-toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: newState }),
    })
      .then(r => r.json())
      .then(j => {
        if (j?.state) {
          setAnimEnabled(!!j.state.enabled);
          setPermanentOff(!!j.state.permanentOff);
        }
      })
      .catch(() => {});
  };

  if (!stats || stats.totalPlays === 0) return null;

  return (
    <>
      {/* === GLOBAL CSS (inline, scoped via unique class names) === */}
      <style>{`
        @keyframes uc-pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 24px rgba(124,58,237,0.35), 0 0 48px rgba(217,70,239,0.20); }
          50% { transform: scale(1.025); box-shadow: 0 0 36px rgba(124,58,237,0.55), 0 0 72px rgba(217,70,239,0.35); }
        }
        @keyframes uc-orbit {
          from { transform: rotate(0deg) translateX(var(--uc-radius)) rotate(0deg); }
          to { transform: rotate(360deg) translateX(var(--uc-radius)) rotate(-360deg); }
        }
        @keyframes uc-orbit-rev {
          from { transform: rotate(0deg) translateX(var(--uc-radius)) rotate(0deg); }
          to { transform: rotate(-360deg) translateX(var(--uc-radius)) rotate(360deg); }
        }
        @keyframes uc-eq-bar {
          0%, 100% { transform: scaleY(0.3); }
          50% { transform: scaleY(1); }
        }
        @keyframes uc-flicker {
          0%, 100% { opacity: 1; }
          7% { opacity: 0.88; }
          11% { opacity: 1; }
          19% { opacity: 0.94; }
          21% { opacity: 1; }
          47% { opacity: 0.97; }
          50% { opacity: 1; }
        }
        @keyframes uc-electric {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes uc-comet {
          0% { transform: translate(-120%, -60%) rotate(20deg) scale(0.6); opacity: 0; }
          15% { opacity: 1; }
          85% { opacity: 1; }
          100% { transform: translate(120%, 60%) rotate(20deg) scale(0.6); opacity: 0; }
        }
        @keyframes uc-spark {
          0% { transform: scale(0) translate(0, 0); opacity: 1; }
          100% { transform: scale(1.4) translate(var(--uc-sx), var(--uc-sy)); opacity: 0; }
        }
        @keyframes uc-digit-blink {
          0%, 100% { opacity: 1; transform: scale(1); filter: brightness(1); }
          25% { opacity: 0.3; transform: scale(1.15); filter: brightness(2); }
          50% { opacity: 1; transform: scale(1.2); filter: brightness(2.5); }
          75% { opacity: 0.4; transform: scale(1.1); filter: brightness(2); }
        }
        .uc-digit-blink {
          animation: uc-digit-blink 600ms ease-in-out;
        }
        .uc-pulse {
          animation: uc-pulse 1.4s ease-in-out infinite;
        }
        .uc-neon-text {
          background: linear-gradient(90deg, #c084fc, #f0abfc, #67e8f9, #f0abfc, #c084fc);
          background-size: 200% auto;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: uc-flicker 4s ease-in-out infinite, uc-electric 6s linear infinite;
          filter: drop-shadow(0 0 8px #d946ef) drop-shadow(0 0 16px #06b6d4);
        }
        .uc-underline {
          background: linear-gradient(90deg, transparent 0%, #d946ef 40%, #06b6d4 60%, transparent 100%);
          background-size: 200% 100%;
          animation: uc-electric 2.4s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .uc-pulse, .uc-neon-text, .uc-underline { animation: none !important; }
          .uc-orbit { animation: none !important; }
        }
      `}</style>

      <div
        className={`relative inline-flex items-center justify-center px-7 py-4 rounded-full ${animEnabled ? "uc-pulse" : ""} ${className}`}
        style={{
          background: "linear-gradient(135deg, rgba(124,58,237,0.18) 0%, rgba(217,70,239,0.14) 50%, rgba(6,182,212,0.18) 100%)",
          border: "1px solid rgba(217,70,239,0.40)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
        }}
        title={`${stats.totalTracks} треков`}
        aria-live="polite"
      >
        {/* === Cosmic Orbits — 3 planet'ы вокруг (only if anim enabled) === */}
        {animEnabled && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ "--uc-radius": "85px" } as any}
          >
            <span
              className="absolute top-1/2 left-1/2 w-1.5 h-1.5 rounded-full bg-fuchsia-400 shadow-[0_0_8px_#d946ef]"
              style={{ animation: "uc-orbit 9s linear infinite", marginLeft: "-3px", marginTop: "-3px" }}
              aria-hidden="true"
            />
            <span
              className="absolute top-1/2 left-1/2 w-1 h-1 rounded-full bg-cyan-300 shadow-[0_0_6px_#67e8f9]"
              style={{ animation: "uc-orbit-rev 6s linear infinite", marginLeft: "-2px", marginTop: "-2px", animationDelay: "-2s" }}
              aria-hidden="true"
            />
            <span
              className="absolute top-1/2 left-1/2 w-1 h-1 rounded-full bg-purple-300 shadow-[0_0_6px_#c084fc]"
              style={{ animation: "uc-orbit 13s linear infinite", marginLeft: "-2px", marginTop: "-2px", animationDelay: "-5s" }}
              aria-hidden="true"
            />
          </div>
        )}

        {/* === Comet — пролетает на каждом update (only if anim enabled) === */}
        {animEnabled && (
          <span
            key={`comet-${tick}`}
            className="absolute pointer-events-none top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] text-amber-300"
            style={{ animation: "uc-comet 1.6s ease-out forwards", filter: "drop-shadow(0 0 6px #fbbf24)" }}
            aria-hidden="true"
          >
            ✨
          </span>
        )}

        {/* === Music Equalizer Bars (left) — only if anim enabled === */}
        <div className="flex items-end gap-[2px] h-6 mr-3" aria-hidden="true">
          {[0, 1, 2, 3].map(i => (
            <span
              key={`eql-${i}`}
              className="w-[3px] bg-gradient-to-t from-purple-500 to-fuchsia-400 rounded-full origin-bottom"
              style={{
                height: animEnabled ? "100%" : "40%",
                animation: animEnabled ? `uc-eq-bar ${0.6 + i * 0.15}s ease-in-out infinite` : "none",
                animationDelay: `${i * 0.1}s`,
              }}
            />
          ))}
        </div>

        {/* === Slot Machine number — Neon glow === */}
        <span className="relative inline-flex items-center gap-2">
          <span className="text-2xl" aria-hidden="true">🎧</span>
          {/* Eugene 2026-05-21 fix: NO -webkit-text-fill-color:transparent —
              иначе RollingDigit children становятся invisible.
              Neon glow через text-shadow в самих digit'ах. */}
          <span
            className="font-mono text-2xl sm:text-3xl font-black tracking-tight leading-none"
            style={{ animation: animEnabled ? "uc-flicker 4s ease-in-out infinite" : "none" }}
          >
            <RollingNumber value={stats.totalPlays} blinkPhase={blinkPhase} />
          </span>
          {/* Electric underline */}
          <span
            className="uc-underline absolute -bottom-1 left-7 right-0 h-[2px] rounded-full opacity-80"
            aria-hidden="true"
          />
        </span>

        {/* === Music Equalizer Bars (right side) === */}
        <div className="flex items-end gap-[2px] h-6 ml-3" aria-hidden="true">
          {[0, 1, 2, 3].map(i => (
            <span
              key={`eqr-${i}`}
              className="w-[3px] bg-gradient-to-t from-cyan-500 to-purple-400 rounded-full origin-bottom"
              style={{
                height: animEnabled ? "100%" : "40%",
                animation: animEnabled ? `uc-eq-bar ${0.7 + i * 0.12}s ease-in-out infinite` : "none",
                animationDelay: `${0.2 + i * 0.13}s`,
              }}
            />
          ))}
        </div>

        {/* Label под counter'ом — Eugene 2026-05-21 Босс: убрано «обновлено» */}
        <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-widest text-white/50 font-semibold whitespace-nowrap">
          прослушиваний
        </span>

        {/* Eugene 2026-05-21 Босс: «кнопка mini отключить анимацию по смыслу
            в первом нижнем». Tracking по IP через server. 3 дня подряд →
            permanent off до явного включения. */}
        <button
          type="button"
          onClick={toggleAnim}
          aria-label={animEnabled ? "Отключить анимацию на день" : "Включить анимацию"}
          title={permanentOff
            ? "Анимация выключена постоянно (3 дня подряд). Жмите чтобы включить."
            : animEnabled
              ? "Отключить анимацию на 1 день"
              : "Включить анимацию"
          }
          className="absolute -bottom-5 right-2 w-5 h-5 rounded-full bg-white/8 hover:bg-white/15 border border-white/15 flex items-center justify-center text-[9px] transition-colors leading-none"
        >
          {animEnabled ? "✦" : "○"}
        </button>
      </div>
    </>
  );
}
