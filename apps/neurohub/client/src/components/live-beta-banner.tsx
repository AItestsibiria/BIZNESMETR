// Eugene 2026-05-23 Босс «добавь место live на главной — Live плейлист,
// ДВД-логот. Платформа находится на тестировании на английском тоже».
// Classic DVD-screensaver bouncing logo (Win98/2000 nostalgia) — MuzaAi
// логотип отскакивает от краёв bounded box, меняет цвет на каждом отскоке.
// Bilingual badge — на русском + английском.

import { useEffect, useRef, useState } from "react";

const BRAND_COLORS = [
  "#7C3AED", // Cyber Violet
  "#FF006E", // Hot Magenta
  "#00D4FF", // Electric Blue
  "#FBBF24", // Amber Glow
  "#39FF14", // Neon Green
];

export function LiveBetaBanner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number | null>(null);
  const stateRef = useRef({
    x: 20,
    y: 20,
    vx: 1.2,
    vy: 0.9,
    colorIdx: 0,
  });
  const [color, setColor] = useState(BRAND_COLORS[0]);
  const [blinkLive, setBlinkLive] = useState(true);

  useEffect(() => {
    const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return; // accessibility

    const tick = () => {
      const c = containerRef.current;
      const l = logoRef.current;
      if (!c || !l) {
        animRef.current = requestAnimationFrame(tick);
        return;
      }
      const cw = c.clientWidth;
      const ch = c.clientHeight;
      const lw = l.clientWidth;
      const lh = l.clientHeight;
      const s = stateRef.current;
      s.x += s.vx;
      s.y += s.vy;
      let bounced = false;
      if (s.x <= 0) { s.x = 0; s.vx = Math.abs(s.vx); bounced = true; }
      if (s.x + lw >= cw) { s.x = cw - lw; s.vx = -Math.abs(s.vx); bounced = true; }
      if (s.y <= 0) { s.y = 0; s.vy = Math.abs(s.vy); bounced = true; }
      if (s.y + lh >= ch) { s.y = ch - lh; s.vy = -Math.abs(s.vy); bounced = true; }
      if (bounced) {
        s.colorIdx = (s.colorIdx + 1) % BRAND_COLORS.length;
        setColor(BRAND_COLORS[s.colorIdx]);
      }
      l.style.transform = `translate3d(${s.x}px, ${s.y}px, 0)`;
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, []);

  useEffect(() => {
    const iv = window.setInterval(() => setBlinkLive(v => !v), 900);
    return () => window.clearInterval(iv);
  }, []);

  return (
    <div className="relative w-full max-w-4xl mx-auto px-4 mt-6 mb-2">
      {/* Bilingual heading */}
      <div className="flex items-center justify-center gap-2 mb-3 flex-wrap">
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/15 border border-red-500/40 text-[11px] font-bold uppercase tracking-wider"
          style={{
            color: blinkLive ? "#fca5a5" : "#fef2f2",
            transition: "color 0.5s ease",
          }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full bg-red-500"
            style={{ opacity: blinkLive ? 1 : 0.3, transition: "opacity 0.5s ease" }}
          />
          LIVE
        </span>
        <span className="text-[11px] sm:text-[12px] font-sans text-white/70">
          Платформа на тестировании · Platform in beta
        </span>
      </div>

      {/* Bounded box with bouncing DVD logo */}
      <div
        ref={containerRef}
        className="relative w-full h-32 sm:h-40 rounded-2xl border border-white/10 overflow-hidden bg-gradient-to-br from-[#0a0a17] via-[#1a0f2e] to-[#0a0a17]"
        aria-label="Live DVD-style bouncing MuzaAi logo"
        role="img"
      >
        {/* Subtle grid background — hi-tech feel */}
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage: "linear-gradient(rgba(124,58,237,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(124,58,237,0.15) 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }}
        />
        {/* Bouncing logo */}
        <div
          ref={logoRef}
          className="absolute will-change-transform"
          style={{
            left: 0,
            top: 0,
            transform: "translate3d(20px, 20px, 0)",
          }}
        >
          <div
            className="font-display font-black text-2xl sm:text-3xl tracking-tighter px-3 py-1 select-none"
            style={{
              color,
              textShadow: `0 0 18px ${color}, 0 0 36px ${color}66`,
              transition: "color 0.4s ease, text-shadow 0.4s ease",
            }}
          >
            MuzaAi
          </div>
        </div>
        {/* Corner labels (legacy DVD-player style) */}
        <div className="absolute top-1.5 left-2 text-[9px] font-mono text-white/30 tracking-wider">
          v304 · BETA
        </div>
        <div className="absolute bottom-1.5 right-2 text-[9px] font-mono text-white/30 tracking-wider">
          muzaai.ru
        </div>
      </div>

      {/* Sub-line — bilingual */}
      <p className="text-center text-[11px] sm:text-[12px] text-white/40 mt-2 font-sans">
        Активное прослушивание · Live listening · 24/7
      </p>
    </div>
  );
}
