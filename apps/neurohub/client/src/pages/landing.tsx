import { registerAudio, pauseAllExcept } from "../lib/audio-bus";
import { useLocation, useRoute } from "wouter";
import { useAuth } from "@/lib/auth";
import { useFeatureEnabled } from "@/lib/featureToggles";
import { PenLine, Music, Image, Sparkles, ArrowRight, Zap, Download, Mic, Play, Pause, SkipForward, SkipBack, ChevronDown, ChevronUp, Share2, Repeat, Repeat1, Maximize } from "lucide-react";
import { StudioMicEq } from "@/components/studio-mic-eq";
import { ShareQRSection, TrackShareQR } from "@/components/share-qr";
import { KaraokeLyrics } from "@/components/karaoke-lyrics";
import { ExpandToggleButton } from "@/components/expand-toggle-button";
import { CoverDetailsModal } from "@/components/cover-details-modal";
import { VolumeSlider } from "@/components/volume-slider";
import { muteBgMusic, unmuteBgMusic } from "@/components/background-music";
import { setupMediaSessionForTrack, setLockScreenPlaybackState, setLockScreenPosition, loadTrackIntoPlayer, setPlayerVolume } from "@/lib/lockscreen";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
// Eugene 2026-05-21 Босс «panel перенесён в ЛК автора» — import не нужен в landing
// import { PlaysCounter } from "@/components/plays-counter";
import { RocketLaunch } from "@/components/rocket-launch";
import { Fireworks } from "@/components/fireworks";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { createPortal } from "react-dom";
import { motion, useAnimation, useDragControls } from "framer-motion";
import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";

// Deep space canvas: Milky Way, bright stars, planets, comets
function StarfieldCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Eugene 2026-05-20 (frontend-audit-N4): TS не сужает ctx через closures
    // (drawMilkyWay/etc), поэтому делаем explicit non-null binding после guard.
    const _ctx = canvas.getContext("2d");
    if (!_ctx) return;
    const ctx: CanvasRenderingContext2D = _ctx;

    let animId: number;
    let dpr = window.devicePixelRatio || 1;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.offsetWidth * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const debouncedResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    };
    window.addEventListener("resize", debouncedResize);

    const W = () => canvas.offsetWidth;
    const H = () => canvas.offsetHeight;
    let t = 0;

    // === STARS — warp-speed flight towards center ===
    const starColors = [
      [255, 255, 255], [200, 210, 255], [255, 220, 180],
      [180, 200, 255], [255, 200, 200], [220, 255, 255],
    ];
    function newStar() {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * 0.01 + 0.001; // starts near center
      const c = starColors[Math.floor(Math.random() * starColors.length)];
      return {
        angle,
        dist,
        speed: Math.random() * 0.0008 + 0.0002,
        r: Math.random() * 1.2 + 0.2,
        brightness: Math.random() * 0.5 + 0.3,
        pulse: Math.random() * Math.PI * 2,
        pulseSpeed: Math.random() * 0.03 + 0.005,
        color: c,
      };
    }
    const stars = Array.from({ length: 400 }, () => {
      const s = newStar();
      s.dist = Math.random() * 0.7; // spread initially
      return s;
    });

    // === MILKY WAY ===
    function drawMilkyWay(w: number, h: number) {
      ctx.save();
      ctx.globalAlpha = 0.12;
      const grad = ctx.createLinearGradient(0, h * 0.2, w, h * 0.7);
      grad.addColorStop(0, "rgba(80, 60, 140, 0)");
      grad.addColorStop(0.3, "rgba(100, 80, 180, 0.5)");
      grad.addColorStop(0.5, "rgba(140, 120, 200, 0.7)");
      grad.addColorStop(0.7, "rgba(100, 80, 180, 0.5)");
      grad.addColorStop(1, "rgba(60, 40, 120, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(w * 0.5, h * 0.45, w * 0.7, h * 0.12, -0.3, 0, Math.PI * 2);
      ctx.fill();
      // Dust clouds
      for (let i = 0; i < 40; i++) {
        const cx = w * (0.15 + Math.random() * 0.7);
        const cy = h * (0.35 + (Math.random() - 0.5) * 0.2);
        const r = Math.random() * 40 + 10;
        const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g2.addColorStop(0, `rgba(160, 140, 220, ${Math.random() * 0.15})`);
        g2.addColorStop(1, "rgba(100, 80, 180, 0)");
        ctx.fillStyle = g2;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
      ctx.restore();
    }

    // === PLANETS ===
    const planets = [
      { name: "Меркурий", dist: 0.08, size: 3, color: "#b0a090", speed: 0.0004, angle: Math.random() * Math.PI * 2 },
      { name: "Венера", dist: 0.12, size: 5, color: "#e8c870", speed: 0.00025, angle: Math.random() * Math.PI * 2 },
      { name: "Земля", dist: 0.17, size: 5.5, color: "#4488cc", speed: 0.0002, angle: Math.random() * Math.PI * 2 },
      { name: "Марс", dist: 0.22, size: 4, color: "#cc6644", speed: 0.00015, angle: Math.random() * Math.PI * 2 },
      { name: "Юпитер", dist: 0.3, size: 10, color: "#d4a870", speed: 0.00008, angle: Math.random() * Math.PI * 2 },
      { name: "Сатурн", dist: 0.38, size: 9, color: "#e8d090", speed: 0.00006, angle: Math.random() * Math.PI * 2, rings: true },
    ];

    // === COMETS (1 per ~60s) ===
    interface Comet {
      x: number; y: number; vx: number; vy: number;
      life: number; maxLife: number; tailLen: number;
    }
    const comets: Comet[] = [];
    let cometTimer = 0;
    const COMET_INTERVAL = 3600; // ~60s at 60fps

    function spawnComet(w: number, h: number) {
      const side = Math.floor(Math.random() * 4);
      let x = 0, y = 0, vx = 0, vy = 0;
      const speed = 2 + Math.random() * 3;
      if (side === 0) { x = -20; y = Math.random() * h * 0.5; vx = speed; vy = speed * (0.3 + Math.random() * 0.5); }
      else if (side === 1) { x = w + 20; y = Math.random() * h * 0.5; vx = -speed; vy = speed * (0.3 + Math.random() * 0.5); }
      else if (side === 2) { x = Math.random() * w; y = -20; vx = (Math.random() - 0.5) * speed; vy = speed; }
      else { x = Math.random() * w; y = h + 20; vx = (Math.random() - 0.5) * speed; vy = -speed; }
      comets.push({ x, y, vx, vy, life: 0, maxLife: 200 + Math.random() * 100, tailLen: 30 + Math.random() * 50 });
    }

    // === DRAW ===
    const draw = () => {
      try {
        const w = W();
        const h = H();
        if (w <= 0 || h <= 0) { animId = requestAnimationFrame(draw); return; }
        // Fill with solid dark background instead of clearRect to prevent flash
        ctx.fillStyle = "hsl(240, 10%, 4%)";
        ctx.fillRect(0, 0, w, h);
        t++;

        // Milky Way
        drawMilkyWay(w, h);

        // Stars — flying outward from center (warp effect)
        const cx = w * 0.5, cy = h * 0.5;
        for (const s of stars) {
          s.pulse += s.pulseSpeed;
          s.dist += s.speed * (1 + s.dist * 3); // accelerate as they get further
          if (s.dist > 0.8) { Object.assign(s, newStar()); } // respawn at center

          const sx = cx + Math.cos(s.angle) * s.dist * w;
          const sy = cy + Math.sin(s.angle) * s.dist * h;
          if (sx < -10 || sx > w + 10 || sy < -10 || sy > h + 10) { Object.assign(s, newStar()); continue; }

          // Size & brightness grow with distance (closer = bigger & brighter)
          const scale = s.dist * 4;
          const r = Math.max(0.2, (s.r + Math.sin(s.pulse) * 0.3) * (0.3 + scale));
          const a = Math.min(1, s.brightness * (0.3 + scale) * (0.6 + Math.sin(s.pulse) * 0.4));

          // Streak trail (motion blur)
          if (s.dist > 0.15) {
            const trailLen = s.dist * 12;
            const tx = sx - Math.cos(s.angle) * trailLen;
            const ty = sy - Math.sin(s.angle) * trailLen;
            const tg = ctx.createLinearGradient(sx, sy, tx, ty);
            tg.addColorStop(0, `rgba(${s.color[0]},${s.color[1]},${s.color[2]},${a * 0.5})`);
            tg.addColorStop(1, "rgba(0,0,0,0)");
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(tx, ty);
            ctx.strokeStyle = tg;
            ctx.lineWidth = Math.max(0.5, r * 0.6);
            ctx.stroke();
          }

          // Glow for big stars
          if (r > 1.5) {
            const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 2.5);
            grd.addColorStop(0, `rgba(${s.color[0]},${s.color[1]},${s.color[2]},${a * 0.25})`);
            grd.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = grd;
            ctx.fillRect(sx - r * 3, sy - r * 3, r * 6, r * 6);
          }
          // Core
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${s.color[0]},${s.color[1]},${s.color[2]},${a})`;
          ctx.fill();
        }

        // Planets orbiting a center "sun" (off-screen bottom-right)
        const sunX = w * 0.85, sunY = h * 1.1;
        for (const p of planets) {
          p.angle += p.speed;
          const orbitR = Math.min(w, h) * p.dist;
          const px = sunX + Math.cos(p.angle) * orbitR * 1.8;
          const py = sunY + Math.sin(p.angle) * orbitR * 0.6; // elliptical
          if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;
          // Planet glow
          const grd = ctx.createRadialGradient(px, py, 0, px, py, p.size * 2.5);
          grd.addColorStop(0, p.color + "60");
          grd.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = grd;
          ctx.fillRect(px - p.size * 3, py - p.size * 3, p.size * 6, p.size * 6);
          // Planet body
          ctx.beginPath();
          ctx.arc(px, py, p.size, 0, Math.PI * 2);
          ctx.fillStyle = p.color;
          ctx.fill();
          // Saturn rings
          if (p.rings) {
            ctx.beginPath();
            ctx.ellipse(px, py, p.size * 2.2, p.size * 0.5, 0.3, 0, Math.PI * 2);
            ctx.strokeStyle = p.color + "80";
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }

        // Comets
        cometTimer++;
        if (cometTimer >= COMET_INTERVAL) {
          cometTimer = 0;
          spawnComet(w, h);
        }
        // Also spawn first comet after 5 seconds
        if (t === 300) spawnComet(w, h);

        for (let i = comets.length - 1; i >= 0; i--) {
          const c = comets[i];
          c.x += c.vx;
          c.y += c.vy;
          c.life++;
          const alpha = Math.min(1, 1 - c.life / c.maxLife);
          // Tail
          const tailX = c.x - c.vx * c.tailLen;
          const tailY = c.y - c.vy * c.tailLen;
          const grad = ctx.createLinearGradient(c.x, c.y, tailX, tailY);
          grad.addColorStop(0, `rgba(200, 220, 255, ${alpha * 0.9})`);
          grad.addColorStop(0.3, `rgba(100, 150, 255, ${alpha * 0.4})`);
          grad.addColorStop(1, "rgba(60, 40, 180, 0)");
          ctx.beginPath();
          ctx.moveTo(c.x, c.y);
          ctx.lineTo(tailX, tailY);
          ctx.strokeStyle = grad;
          ctx.lineWidth = 2;
          ctx.stroke();
          // Head
          ctx.beginPath();
          ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(220, 240, 255, ${alpha})`;
          ctx.fill();
          // Glow
          const hg = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 8);
          hg.addColorStop(0, `rgba(150, 180, 255, ${alpha * 0.5})`);
          hg.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = hg;
          ctx.fillRect(c.x - 8, c.y - 8, 16, 16);

          if (c.life >= c.maxLife) comets.splice(i, 1);
        }

      } catch (e) { /* ignore */ }
      animId = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", debouncedResize);
      if (resizeTimer) clearTimeout(resizeTimer);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full pointer-events-none"
      style={{ zIndex: 0, background: "hsl(240, 10%, 4%)" }}
    />
  );
}

const services = [
  {
    icon: Music,
    title: "Музыка + Вокал",
    description: "Полноценная песня с музыкой и голосом на базе MuzaAi — готовый трек за минуты",
    price: "399 ₽",
    href: "/music",
    gradient: "from-blue-500/20 to-blue-900/20",
    iconBg: "from-blue-500 to-blue-700",
    star: true,
  },
  {
    icon: PenLine,
    title: "Текст песни",
    description: "AI напишет текст песни по вашему описанию — любой жанр, настроение и язык",
    price: "99 ₽",
    href: "/lyrics",
    gradient: "from-purple-500/20 to-purple-900/20",
    iconBg: "from-purple-500 to-purple-700",
  },
  {
    icon: Image,
    title: "Обложка альбома",
    description: "Уникальная обложка для вашего трека в любом стиле — от киберпанка до минимализма",
    price: "99 ₽",
    href: "/covers",
    gradient: "from-cyan-500/20 to-cyan-900/20",
    iconBg: "from-cyan-500 to-cyan-700",
  },
];

const steps = [
  {
    icon: Sparkles,
    title: "Опишите",
    description: "Расскажите AI, что вы хотите — тему, настроение, стиль",
  },
  {
    icon: Zap,
    title: "AI создаёт",
    description: "Нейросеть генерирует результат за считанные секунды",
  },
  {
    icon: Download,
    title: "Скачайте",
    description: "Получите готовый результат и используйте как угодно",
  },
];

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function PlaylistSection({ autoPlayId }: { autoPlayId?: number }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  // Eugene 2026-05-22 Босс «воспроизведение плейлиста не по правилам — скачет
  // на случайные». ROOT CAUSE: server при sort=random шафлил Math.random()
  // на каждом fetch → разный порядок → handleEnded next непредсказуем.
  // FIX: stable seed на сессию + server seeded shuffle через ?seed=N.
  const playlistSeedRef = useRef<string>("");
  if (!playlistSeedRef.current) {
    playlistSeedRef.current = String(Math.floor(Math.random() * 1_000_000));
  }
  // Eugene 2026-05-22 Босс: «при загрузке появляется загрузка фишек MuzaAi,
  // надо чтобы плеер сразу появлялся». ROOT CAUSE: initial tracks=[] до fetch.
  // FIX: instant render из localStorage cache (TTL 30 min, любая категория/sort
  // подойдёт для первого paint), потом fetch обновит свежими.
  const [tracks, setTracks] = useState<any[]>(() => {
    try {
      const raw = localStorage.getItem("pl:tracks:cache");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.tracks)) return [];
      // TTL 30 мин — после fetch перерисует свежими данными
      if (Date.now() - (parsed.savedAt || 0) > 30 * 60 * 1000) return [];
      return parsed.tracks;
    } catch { return []; }
  });
  // Eugene 2026-05-20 Босс «при login/logout choice плейлиста теряется».
  // ROOT CAUSE: pl_v2:<userId|guest>:<k> переключался по user.id —
  // на логин stale pl_v2:<id>:<k> перебивал свежий guest-выбор; на
  // logout state писался обратно в guest и при следующем входе опять
  // терялся. ФИКС: STABLE-ключ pl_v2:<k> — настройки плейлиста привязаны
  // к браузеру, а не к аккаунту. Legacy ключи мигрируются on-read once.
  const psKey = useCallback((k: string) => `pl_v2:${k}`, []);
  // readInitial — для useState-initializers: stable → legacy per-user
  // (если user.id уже резолвлен) → legacy guest. На hit мигрируем в stable.
  const readInitial = (k: string): string | null => {
    try {
      const stable = localStorage.getItem(`pl_v2:${k}`);
      if (stable !== null) return stable;
      const sources: string[] = [];
      if (user?.id != null) sources.push(`pl_v2:${user.id}:${k}`);
      sources.push(`pl_v2:guest:${k}`);
      for (const src of sources) {
        const v = localStorage.getItem(src);
        if (v !== null) { localStorage.setItem(`pl_v2:${k}`, v); return v; }
      }
    } catch {}
    return null;
  };
  // Persist playingId + currentTime в localStorage (а не sessionStorage —
  // переживёт закрытие вкладки).
  const [playingId, setPlayingId] = useState<number | null>(() => {
    const v = readInitial("trackId"); return v ? Number(v) : null;
  });
  const [currentTime, setCurrentTime] = useState<number>(() => {
    const v = readInitial("currentTime"); return v ? Number(v) : 0;
  });
  // Persist при изменении. Skip-first: не пишем default-state до того
  // как post-mount migration effect (внизу) успеет подхватить legacy
  // per-user данные — иначе default перебьёт миграцию.
  const playingIdDirty = useRef(false);
  useEffect(() => {
    if (!playingIdDirty.current) { playingIdDirty.current = true; return; }
    try { if (playingId) localStorage.setItem(psKey("trackId"), String(playingId)); else localStorage.removeItem(psKey("trackId")); } catch {}
  }, [playingId, psKey]);
  const [trackDuration, setTrackDuration] = useState(0);
  // Eugene 2026-05-14 Босс «играет, но кнопка пауза отражается». audioRef.paused —
  // прямое свойство, React не re-render. Делаем State + listeners на play/pause events.
  const [isPlayingState, setIsPlayingState] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // Eugene 2026-05-19 Босс «при случайном нажатии закрывается — добавь паузу».
  // Anti-accidental-collapse: 350ms cooldown после открытия expanded card.
  // Pointer-down → если прошло <350ms → ignore (anti-double-tap, anti-flicker).
  const expandedAtRef = useRef<number>(0);
  useEffect(() => {
    if (expandedId !== null) expandedAtRef.current = Date.now();
  }, [expandedId]);
  const expandedIdRef = useRef<number | null>(null);
  // Eugene 2026-05-16 Босс «кнопка раскрыть (expand) на плееры везде».
  // coverExpanded — column-layout активного плеера: cover full-width сверху,
  // controls под ним. False = row-layout (current default).
  const [coverExpanded, setCoverExpanded] = useState(false);
  // Eugene 2026-05-18 Босс «для десктопа добавь возможность менять размер
  // отображения обложки». 3 уровня: sm (75%) / md (100%) / lg (125%).
  // Persist в localStorage.
  const [coverSize, setCoverSize] = useState<"sm" | "md" | "lg">(() => {
    if (typeof window === "undefined") return "sm";
    const saved = window.localStorage.getItem("muzaai-cover-size");
    return saved === "md" || saved === "lg" ? saved : "sm";
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("muzaai-cover-size", coverSize);
  }, [coverSize]);
  // Eugene 2026-05-19 Босс «впиши на планшете, уменьши размер на 20% планшет
  // десктоп, пусть гибко можно менять». Scale на 20% меньше: sm=80, md=100, lg=125.
  // Mobile w-[88px] не трогаем (там и так компактно).
  const coverSizeClass = coverSize === "sm" ? "md:scale-[0.8]" : coverSize === "lg" ? "md:scale-125" : "md:scale-100";
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [expandedLyricId, setExpandedLyricId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Eugene 2026-05-19 — feature-toggle hooks (см. /lib/featureToggles).
  const coverHighlightEnabled = useFeatureEnabled("cover-highlight");
  const karaokeFeatureEnabled = useFeatureEnabled("karaoke");
  const [shareTrackId, setShareTrackId] = useState<number | null>(null);
  const [showKaraoke, setShowKaraoke] = useState(false);
  const [lyricsSpeed, setLyricsSpeed] = useState(0);
  const [repeatMode, setRepeatMode] = useState<"off" | "all" | "one">("all");
  // Eugene 2026-05-16 Босс «кнопка 🔍 Детали справа от Repeat — full-screen modal».
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Eugene 2026-05-17 Босс «стильный ползунок громкости в плеере».
  // Persist в localStorage пер-юзер (muzaai-volume).
  const [volume, setVolume] = useState<number>(() => {
    try {
      const stored = localStorage.getItem("muzaai-volume");
      const v = stored ? parseFloat(stored) : NaN;
      return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.5;
    } catch { return 0.5; }
  });
  // volumeRef — синхронная копия для использования в playTrack (immediate read).
  const volumeRef = useRef<number>(0.5);
  volumeRef.current = volume;
  const [countriesCount, setCountriesCount] = useState<number>(0);
  const [countriesList, setCountriesList] = useState<Array<{country:string;country_code:string;n:number}>>([]);
  const [showCountries, setShowCountries] = useState(false);
  // Eugene 2026-05-16 Босс: панель стран — drag (тап+движение), long-press
  // (~500ms) исчезает, release → snap обратно в исходное место (0,0).
  const countriesDragControls = useAnimation();
  // Eugene 2026-05-21 Босс: «список городов скроллим пальцем, panel на месте».
  // useDragControls + dragListener={false} → drag активируется ТОЛЬКО через
  // явный .start(e) из header'а. Body (ul со странами) получает native scroll.
  const countriesDragHandle = useDragControls();
  const countriesLongPressRef = useRef<number | null>(null);
  const startCountriesLongPress = useCallback(() => {
    if (countriesLongPressRef.current) window.clearTimeout(countriesLongPressRef.current);
    countriesLongPressRef.current = window.setTimeout(() => { setShowCountries(false); setShowCitiesPanel(false); }, 500);
  }, []);
  const cancelCountriesLongPress = useCallback(() => {
    if (countriesLongPressRef.current) { window.clearTimeout(countriesLongPressRef.current); countriesLongPressRef.current = null; }
  }, []);
  const [showCitiesPanel, setShowCitiesPanel] = useState(false);
  // Eugene 2026-05-14 Босс: «справа доп. панель с топом городов».
  const [topCities, setTopCities] = useState<Array<{city:string;country:string;country_code:string;n:number}>>([]);
  useEffect(() => {
    const load = () => fetch("/api/public/countries-count", { cache: "no-store" }).then(r => r.json()).then(d => { setCountriesCount(d.countries || 0); setCountriesList(d.list || []); }).catch(() => {});
    load();
    // Eugene 2026-05-21 Босс «приведи к 60 сек» — раз в час → раз в минуту,
    // чтобы 🌍 N на player card обновлялся в такт с counter panel (60 сек).
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);
  // Eugene 2026-05-22 Босс: inline счётчик прослушиваний рядом с 🌍 после
  // кнопки «Поделиться» в большом плеере. Источник /api/playlist/stats,
  // обновление каждые 60 сек (как countriesCount).
  const [totalPlays, setTotalPlays] = useState<number>(0);
  // Eugene 2026-05-22 Босс «нажатием на планетку панель не появляется,
  // должна быть открыта снизу вверх не перемещаться вниз плеера». Отдельный
  // state для player-anchored панели (не конфликтует с hero showCountries).
  const [showPlayerCountries, setShowPlayerCountries] = useState(false);
  // Eugene 2026-05-22 Босс «закрывания панель стран от нажатия на любую её
  // точку задержку поставь, панель испаряется как обложка». isClosing =
  // animate-out fade phase + 500ms cooldown anti-accidental tap.
  const [playerCountriesClosing, setPlayerCountriesClosing] = useState(false);
  const playerCountriesOpenedAtRef = useRef<number>(0);
  useEffect(() => {
    if (showPlayerCountries) playerCountriesOpenedAtRef.current = Date.now();
  }, [showPlayerCountries]);
  const closePlayerCountries = useCallback(() => {
    // Accidental-tap-protection rule (CLAUDE.md): 500ms cooldown после open
    if (Date.now() - playerCountriesOpenedAtRef.current < 500) return;
    if (playerCountriesClosing) return;
    setPlayerCountriesClosing(true);
    setTimeout(() => {
      setShowPlayerCountries(false);
      setPlayerCountriesClosing(false);
    }, 200);
  }, [playerCountriesClosing]);
  useEffect(() => {
    const load = () => fetch("/api/playlist/stats", { cache: "no-store" }).then(r => r.json()).then(d => { if (typeof d?.totalPlays === "number") setTotalPlays(d.totalPlays); }).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const load = () => fetch("/api/public/top-cities", { cache: "no-store" }).then(r => r.json()).then(d => setTopCities(d.list || [])).catch(() => {});
    load();
    const id = setInterval(load, 600000); // каждые 10 мин
    return () => clearInterval(id);
  }, []);
  const NAME_TO_CC: Record<string,string> = { "United States":"US","США":"US","Russia":"RU","Россия":"RU","Germany":"DE","Германия":"DE","United Kingdom":"GB","Великобритания":"GB","Netherlands":"NL","Нидерланды":"NL","Ukraine":"UA","Украина":"UA","Saudi Arabia":"SA","Молдова":"MD","Moldova":"MD","France":"FR","Франция":"FR","Italy":"IT","Италия":"IT","Spain":"ES","Испания":"ES","Poland":"PL","Польша":"PL","Belarus":"BY","Беларусь":"BY","Kazakhstan":"KZ","Казахстан":"KZ","Turkey":"TR","Турция":"TR","China":"CN","Китай":"CN","Japan":"JP","Япония":"JP","Korea":"KR","India":"IN","Индия":"IN","Brazil":"BR","Бразилия":"BR","Canada":"CA","Канада":"CA","Australia":"AU","Австралия":"AU","Israel":"IL","Израиль":"IL","UAE":"AE","ОАЭ":"AE","Georgia":"GE","Грузия":"GE","Armenia":"AM","Армения":"AM","Azerbaijan":"AZ","Азербайджан":"AZ","Uzbekistan":"UZ","Узбекистан":"UZ","Latvia":"LV","Lithuania":"LT","Estonia":"EE","Czech Republic":"CZ","Czechia":"CZ","Switzerland":"CH","Sweden":"SE","Norway":"NO","Finland":"FI","Denmark":"DK","Austria":"AT","Belgium":"BE","Greece":"GR","Portugal":"PT","Hungary":"HU","Romania":"RO","Bulgaria":"BG","Serbia":"RS","Croatia":"HR" };
  const flagOf = (cc: string, name?: string) => { const code = (cc && cc.length === 2 ? cc : (name && NAME_TO_CC[name])) || ""; return code ? String.fromCodePoint(...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : "🌐"; };
  // ТЗ Eugene 2026-05-07 12:18: фильтры плейлиста должны жёстко
  // удерживаться через сессии и навигацию. Используем localStorage.
  // Eugene 2026-05-15 Босс «2 плейлиста на главной + кнопки заметные».
  // playlistKind: 'main' = одобренный (default) | 'new' = новые авторы.
  // Eugene 2026-05-21 Босс: «правила плейлиста применить ко всем юзерам при
  // первом заходе, далее по выбору юзера». One-time migration: удаляем
  // сохранённые sortMode/category у всех уже-зашедших юзеров. На следующем
  // визите они получат default (категория 'song' + today's rotation sort).
  // Дальше их выбор персистится как обычно.
  // Migration flag — увеличиваем версию когда нужно ещё один reset.
  const PLAYLIST_DEFAULTS_RESET_VERSION = "v2026-05-21";
  if (typeof window !== "undefined") {
    try {
      const lastReset = localStorage.getItem("pl_defaults_reset_version");
      if (lastReset !== PLAYLIST_DEFAULTS_RESET_VERSION) {
        // Удаляем все варианты (legacy + per-user + guest)
        const allKeys = Object.keys(localStorage);
        for (const k of allKeys) {
          if (k.includes("sortMode") || k.includes(":category") || k.endsWith("category")) {
            // Только playlist-related ключи (не email, не имя — фильтрация по prefix)
            if (k.startsWith("pl_") || k.startsWith("pl_v2:") || k.startsWith("muzaai-pl-")) {
              localStorage.removeItem(k);
            }
          }
        }
        localStorage.setItem("pl_defaults_reset_version", PLAYLIST_DEFAULTS_RESET_VERSION);
      }
    } catch {}
  }

  const [playlistKind, setPlaylistKind] = useState<"main" | "new">(() => {
    const s = readInitial("kind"); return (s === "main" || s === "new") ? s : "main";
  });
  const [sortMode, setSortMode] = useState<"rating" | "date" | "random" | "top_month">(() => {
    const s = readInitial("sortMode");
    return (s === "rating" || s === "date" || s === "random" || s === "top_month") ? s : "date";
    // Initial — server default подгружается ниже useEffect'ом
  });
  // Eugene 2026-05-19 Босс «правило по умолчанию: по дате → рейтинг → случайно
  // (цикл по дням, админ меняет порядок)». При первой загрузке если у юзера
  // нет своего выбора в localStorage — спрашиваем server какой сегодня default.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("pl_v2:sortMode");
      if (saved) return; // у юзера уже свой выбор — не перебиваем
    } catch {}
    // Eugene 2026-05-21 Босс «какой параметр юзеры выбирают в Песни —
    // такой и по умолчанию». Передаём текущую категорию для frequency-default.
    const cat = (() => {
      try {
        const s = localStorage.getItem("pl_v2:category");
        return s || "song";
      } catch { return "song"; }
    })();
    fetch(`/api/playlist/sort-default?category=${encodeURIComponent(cat)}`, { cache: "no-store" })
      .then(r => r.json())
      .then((j) => {
        if (j?.mode && ["date", "rating", "random", "top_month"].includes(j.mode)) {
          setSortMode(j.mode);
        }
      })
      .catch(() => {});
  }, []);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => {
    const s = readInitial("sortDir"); return (s === "asc" || s === "desc") ? s : "asc";
  });
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'song' | 'greeting' | 'instrumental'>(() => {
    const s = readInitial("category");
    return (s === "all" || s === "song" || s === "greeting" || s === "instrumental") ? s : "song";
  });
  // Eugene 2026-05-20 — Auth резолвится async: при mount user?.id ещё
  // undefined, поэтому readInitial видит только guest-legacy. Когда
  // user.id появляется, проверяем legacy per-user ключи; если stable
  // ещё пуст (skip-first persist не дал записать default) — переносим
  // в state, persist ниже синкнет в stable.
  useEffect(() => {
    if (!user?.id) return;
    const uid = user.id;
    const tryMigrate = (k: string, apply: (v: string) => void) => {
      try {
        if (localStorage.getItem(`pl_v2:${k}`) !== null) return;
        const v = localStorage.getItem(`pl_v2:${uid}:${k}`);
        if (v !== null) apply(v);
      } catch {}
    };
    tryMigrate("kind", (v) => { if (v === "main" || v === "new") setPlaylistKind(v); });
    tryMigrate("sortMode", (v) => { if (v === "rating" || v === "date" || v === "random" || v === "top_month") setSortMode(v); });
    tryMigrate("sortDir", (v) => { if (v === "asc" || v === "desc") setSortDir(v); });
    tryMigrate("category", (v) => { if (v === "all" || v === "song" || v === "greeting" || v === "instrumental") setCategoryFilter(v); });
    tryMigrate("trackId", (v) => { const n = Number(v); if (n) setPlayingId(n); });
    tryMigrate("currentTime", (v) => { const n = Number(v); if (Number.isFinite(n) && n > 0) setCurrentTime(n); });
  }, [user?.id]);
  // Persist + skip-first (см. комментарий у playingId-persist выше).
  const sortModeDirty = useRef(false);
  useEffect(() => {
    if (!sortModeDirty.current) { sortModeDirty.current = true; return; }
    try { localStorage.setItem(psKey("sortMode"), sortMode); } catch {}
  }, [sortMode, psKey]);
  const sortDirDirty = useRef(false);
  useEffect(() => {
    if (!sortDirDirty.current) { sortDirDirty.current = true; return; }
    try { localStorage.setItem(psKey("sortDir"), sortDir); } catch {}
  }, [sortDir, psKey]);
  const categoryDirty = useRef(false);
  useEffect(() => {
    if (!categoryDirty.current) { categoryDirty.current = true; return; }
    try { localStorage.setItem(psKey("category"), categoryFilter); } catch {}
  }, [categoryFilter, psKey]);
  const [currentPage, setCurrentPage] = useState(1);
  const TRACKS_PER_PAGE = 20;
  const repeatModeRef = useRef(repeatMode);
  repeatModeRef.current = repeatMode;
  const [prevCoverUrl, setPrevCoverUrl] = useState<string | null>(null);
  const [coverFading, setCoverFading] = useState(false);
  // Глобальный singleton — keeps audio alive across navigation (Eugene 14:09).
  // На window.__muziaiAudio лежит orphan Audio element + meta. При unmount
  // НЕ паузим — пусть играет в фоне. На remount забираем оттуда.
  const audioRef = useRef<HTMLAudioElement | null>(
    (typeof window !== "undefined" ? (window as any).__muziaiAudio || null : null),
  );
  const timerRef = useRef<number | null>(null);
  const playingTrackRef = useRef<any>(
    (typeof window !== "undefined" ? (window as any).__muziaiTrack || null : null),
  );
  const tracksRef = useRef<any[]>([]);
  useEffect(() => { tracksRef.current = tracks; }, [tracks]);
  // Eugene 2026-05-17 — sync volume → audioRef + persist в localStorage.
  // Также применяется при каждом playTrack (audio.volume = 0.5 → перезапишется
  // из стейта сразу после создания через этот effect).
  useEffect(() => {
    try { localStorage.setItem("muzaai-volume", String(volume)); } catch {}
    // Eugene 2026-05-21 Босс: «регулировка громкости должна работать».
    // setPlayerVolume использует HTMLAudio.volume + Web Audio GainNode fallback
    // для iOS Safari (где audio.volume read-only system-only).
    if (audioRef.current) setPlayerVolume(audioRef.current, volume);
  }, [volume]);
  // Eugene 2026-05-10: ref для отфильтрованного списка (category+search).
  // handleEnded и skip-кнопки должны использовать ИМЕННО видимый юзеру
  // плейлист, иначе после конца трека выпадает не тот параметр.
  const filteredMusicRef = useRef<any[]>([]);
  // Eugene 2026-05-15 Босс «плейлист сам по себе меняется при random».
  // ROOT CAUSE: 5-min interval + visibilitychange + focus refetch'ат
  // /api/playlist?sort=random — сервер возвращает новый shuffle, мы делаем
  // setTracks(data) → весь порядок сменился под пользователем.
  // ФИКС: для random — merge by id, сохраняем существующий порядок,
  // только обновляем метаданные (plays, displayTitle, imageUrl).
  const sortModeRef = useRef(sortMode);
  useEffect(() => { sortModeRef.current = sortMode; }, [sortMode]);
  const mergePlaylist = useCallback((incoming: any[]) => {
    setTracks(prev => {
      if (sortModeRef.current !== "random") return incoming;
      const byId = new Map(incoming.map((t: any) => [t.id, t]));
      const seen = new Set<any>();
      const merged: any[] = [];
      for (const t of prev) {
        const fresh = byId.get(t.id);
        if (fresh) { merged.push(fresh); seen.add(t.id); }
      }
      for (const t of incoming) if (!seen.has(t.id)) merged.push(t);
      return merged;
    });
  }, []);

  // На mount если уже играет глобальный audio — восстанавливаем UI state
  useEffect(() => {
    const g: any = typeof window !== "undefined" ? window : null;
    if (g?.__muziaiAudio && !g.__muziaiAudio.paused && g.__muziaiTrack) {
      setPlayingId(g.__muziaiTrack.id);
      setCurrentTime(g.__muziaiAudio.currentTime || 0);
      setTrackDuration(g.__muziaiAudio.duration || 0);
      // Подписываемся на ongoing playback для UI-обновлений
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = window.setInterval(() => {
        if (g.__muziaiAudio && !g.__muziaiAudio.paused) {
          setCurrentTime(g.__muziaiAudio.currentTime);
        }
      }, 250);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      // НЕ паузим — глобальный audio продолжает играть на других страницах
    };
  }, []);

  // Keep ref in sync with state
  useEffect(() => { expandedIdRef.current = expandedId; }, [expandedId]);

  // Marquee title in browser tab while playing
  useEffect(() => {
    const originalTitle = 'MuzaAi — Создавай музыку с AI';
    if (!playingId) {
      document.title = originalTitle;
      return;
    }
    const track = tracks.find(t => t.id === playingId);
    if (!track) return;
    const title = track.displayTitle || track.prompt?.slice(0, 60) || 'MuzaAi';
    const author = track.authorName || '';
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
  }, [playingId, tracks]);

  // Eugene 2026-05-18 Босс «реши lock-screen на 100%». Guard на orphan playingId:
  // если playingId восстановлен из localStorage (или установлен programmatically),
  // но трек НЕ найден в tracks после загрузки — сбрасываем. Иначе плеер-блок
  // не рендерится (currentTrack=undefined) → playTrack никогда не вызывается →
  // setLockScreenTrackSync не выставляет metadata → iOS показывает MuzaAi logo.
  useEffect(() => {
    if (!playingId || !tracks.length) return;
    if (!tracks.find(t => t.id === playingId)) {
      setPlayingId(null);
    }
  }, [playingId, tracks]);

  useEffect(() => {
    fetch(`/api/playlist?status=${playlistKind}&sort=${sortMode}&dir=${sortDir}&seed=${playlistSeedRef.current}&_=${Date.now()}`, { cache: 'no-store' }).then(r => r.json()).then(data => {
      setTracks(data);
      // Eugene 2026-05-22 — кешируем для instant-paint при следующем визите.
      try {
        if (Array.isArray(data) && data.length > 0) {
          localStorage.setItem("pl:tracks:cache", JSON.stringify({ tracks: data, savedAt: Date.now() }));
        }
      } catch {}

      // Auto-play shared track from /play/:id route
      const autoTrack = autoPlayId ? data.find((t: any) => t.id === autoPlayId && t.type === 'music' && t.audioUrl) : null;

      if (autoTrack) {
        setTimeout(() => {
          playTrack(autoTrack);
          document.getElementById('playlist-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);
      } else if (typeof window !== "undefined" && (() => { try { return sessionStorage.getItem("scrollToPlaylist") === "1"; } catch { return false; } })()) {
        // User clicked the logo from another page — scroll to playlist after it renders
        try { sessionStorage.removeItem("scrollToPlaylist"); } catch {}
        setTimeout(() => {
          document.getElementById('playlist-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);
      } else {
        // Eugene 2026-05-14 Босс «после загрузки сайта стоит на паузе,
        // только переключение на другой трек и обратно срабатывает».
        // ROOT CAUSE: auto-init создавал new Audio() ВНЕ user-gesture.
        // На togglePlay → audio.play() reject от autoplay-policy.
        // ФИКС: НЕ создаём Audio на mount. Только set playingId + meta
        // для отображения большого плеера. Audio создаётся при первом
        // клике (в свежем gesture) — playTrack гарантированно работает.
        const hasGlobalAudio = typeof window !== "undefined" && (window as any).__muziaiAudio;
        if (!playingId && !hasGlobalAudio) {
          const firstMusic = data.find((t: any) => t.type === "music" && t.audioUrl);
          if (firstMusic) {
            setPlayingId(firstMusic.id);
            setTrackDuration(firstMusic.duration || 0);
            playingTrackRef.current = firstMusic;
            // НЕ создаём new Audio() здесь — только meta. Audio будет
            // создан в playTrack() при first click.
          }
        }
      }
    }).catch(() => {});

    // Refresh playlist every 5 minutes — keeps renames, plays, new tracks fresh.
    // Eugene 2026-05-15 Босс «плейлист сам по себе меняется» → используем
    // mergePlaylist, чтобы для random сохранять текущий порядок.
    // Eugene 2026-05-20: r.ok + Array.isArray guard (frontend-audit fix).
    const safeMergeRefresh = () => {
      fetch(`/api/playlist?sort=${sortModeRef.current}&dir=${sortDir}&seed=${playlistSeedRef.current}&_=${Date.now()}`, { cache: 'no-store' })
        .then(r => {
          if (!r.ok) throw new Error(`playlist HTTP ${r.status}`);
          return r.json();
        })
        .then(data => {
          if (Array.isArray(data)) mergePlaylist(data);
          else console.warn("[playlist refresh] non-array:", data);
        })
        .catch((e) => { console.warn("[playlist refresh] failed:", e?.message || e); });
    };
    const refreshInterval = setInterval(safeMergeRefresh, 5 * 60 * 1000);
    const refetch = safeMergeRefresh;
    const onVisibilityChange = () => { if (!document.hidden) refetch(); };
    const onFocus = () => refetch();
    const onPlaylistDirty = () => {
      try {
        if (sessionStorage.getItem('playlistDirty') === '1') {
          sessionStorage.removeItem('playlistDirty');
          refetch();
        }
      } catch {}
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);

    // Cross-tab refresh: when another tab confirms a rename via email link,
    // it writes to localStorage — we listen and refetch immediately.
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'muziai-playlist-dirty') refetch();
    };
    window.addEventListener('storage', onStorage);

    // BroadcastChannel — same-origin event bus, works across tabs/windows.
    let bc: any = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel('muziai-events');
        bc.onmessage = (msg: any) => {
          if (msg?.data?.type === 'rename') refetch();
        };
      }
    } catch {}

    // Check the dirty flag on mount in case user just navigated from dashboard
    onPlaylistDirty();

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      clearInterval(refreshInterval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('storage', onStorage);
      if (bc) try { bc.close(); } catch {}
      // НЕ паузим — global window.__muziaiAudio продолжает играть на других страницах (Eugene 14:09)
    };
  }, []);

  // Eugene 2026-05-11: featured-track auto-play «Встала страна» ОТКЛЮЧЁН.
  // Раньше через 5 сек автоматически стартовал этот трек на любой
  // загрузке лендинга. Теперь — ротация только по действиям юзера,
  // никакой приоритезации одной песни.

  // Re-fetch when sort mode changes.
  // Eugene 2026-05-20 (frontend-audit fix): добавлен r.ok check + Array.isArray
  // guard. Раньше при 500-ответе с {error: "..."} setTracks(data) ставил объект
  // → .map() ниже падал runtime'ом.
  useEffect(() => {
    fetch(`/api/playlist?status=${playlistKind}&sort=${sortMode}&dir=${sortDir}&seed=${playlistSeedRef.current}&_=${Date.now()}`, { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error(`playlist HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (!Array.isArray(data)) {
          console.warn("[playlist] non-array response:", data);
          return;
        }
        setTracks(data);
        setCurrentPage(1);
      })
      .catch((e) => { console.warn("[playlist] fetch failed:", e?.message || e); });
  }, [sortMode, sortDir, playlistKind]);

  // Eugene 2026-05-15: persist playlistKind. Skip-first — см. комментарий
  // у других persist-эффектов (избегаем default-pollution до migration).
  const playlistKindDirty = useRef(false);
  useEffect(() => {
    if (!playlistKindDirty.current) { playlistKindDirty.current = true; return; }
    try { localStorage.setItem(psKey("kind"), playlistKind); } catch {}
  }, [playlistKind, psKey]);

  // Reset page when search or category changes
  useEffect(() => { setCurrentPage(1); }, [searchQuery, categoryFilter]);

  // Auto-switch page when playing track is on a different page
  // Eugene 2026-05-15 Босс «не сохраняется визуальный выбранный плейлист
  // после перещелкивания треков». ROOT CAUSE: эффект игнорировал
  // categoryFilter и считал index трека в ПОЛНОМ списке музыки, а visible-
  // список — отфильтрован по категории. После переключения трека page
  // прыгал на позицию в чужом списке → юзера выкидывало с его страницы.
  // ФИКС:
  //   1. Используем тот же filteredMusic (category + search), что и UI.
  //   2. Если играющий трек ВНЕ фильтра — НЕ трогаем page, оставляем
  //      выбор юзера. Это и есть «сохраняется визуально».
  useEffect(() => {
    if (!playingId) return;
    const list = filteredMusicRef.current;
    if (!list || list.length === 0) return;
    const idx = list.findIndex(t => t.id === playingId);
    if (idx < 0) return;
    const targetPage = Math.floor(idx / TRACKS_PER_PAGE) + 1;
    setCurrentPage(p => p !== targetPage ? targetPage : p);
  }, [playingId]);

  const playTrack = (track: any) => {
    if (timerRef.current) clearInterval(timerRef.current);

    // Eugene 2026-05-14 Босс «правило: одновременно ИСКЛЮЧИТЕЛЬНО одна песня».
    // pauseAllExcept(audio) после получения persistent audio — pause всё
    // ОСИМ его (background-music, прочие <audio> на странице).
    // (см. ниже после getPersistentPlayerAudio).

    // Eugene 2026-05-18 9-я итерация — КАРДИНАЛЬНЫЙ fix LS prev/next:
    // ROOT CAUSE 8 итераций (по W3C MediaSession spec §3.3): playTrack
    // удалял старый <audio> из DOM ДО создания нового → iOS видел "no
    // active media element" → release NowPlaying ownership → отдавал её
    // чужому app (Apple Music / Spotify / Yandex Music).
    //
    // FIX: один persistent <audio data-muziai-player> в DOM на всю сессию.
    // Track change = audio.src=url + audio.load() (WebKit canonical pattern).
    // Element НЕ удаляется → iOS видит continuous playback session →
    // NowPlaying ownership сохраняется → prev/next не отдаёт чужому app.
    //
    // loadTrackIntoPlayer():
    //   - возвращает persistent audio (создаёт если ещё нет)
    //   - pause + detach old listeners + reset currentTime
    //   - audio.src = url + audio.load()
    //   - возвращает тот же element что и раньше (если уже был)
    const audio = loadTrackIntoPlayer(track.audioUrl);
    if (!audio) {
      // SSR / нет document — fallback на new Audio (UI без media-controls)
      console.warn("[PLAYER] loadTrackIntoPlayer вернул null — SSR?");
      return;
    }

    // Pause всех остальных audio (background-music, прочие treamers) —
    // оставляем играть только наш persistent player.
    pauseAllExcept(audio);

    audioRef.current = audio;

    // Eugene 2026-05-14 Босс: state-listeners для UI synchronization.
    // ВАЖНО: используем addEventListener (НЕ onfoo) чтобы не затереть
    // listeners от других модулей. Cleanup происходит сам при следующем
    // loadTrackIntoPlayer (он detach'ит .onfoo, addEventListener listeners
    // остаются — но они идемпотентны для нашего persistent element).
    // Дедуп: removeEventListener того же reference перед re-add.
    const onPlay = () => setIsPlayingState(true);
    const onPause = () => setIsPlayingState(false);
    const onEndedUi = () => setIsPlayingState(false);
    try { audio.removeEventListener("play", onPlay); } catch {}
    try { audio.removeEventListener("pause", onPause); } catch {}
    try { audio.removeEventListener("ended", onEndedUi); } catch {}
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEndedUi);

    // Eugene 2026-05-18 8-я итерация. ROOT-CAUSE-2: metadata должна
    // быть применена СИНХРОННО в одном tick с audio.play() — никаких
    // async вызовов между ними. setupMediaSessionForTrack делает
    // sync apply + параллельный prewarm artwork (не блокирует gesture).
    const msTitle = track.displayTitle || track.prompt?.slice(0, 60) || 'MuzaAi';
    const msArtist = track.authorName ? `MuzaAi · ${track.authorName}` : 'MuzaAi';
    const coverBust = (track as any).coverGenId || track.id;
    const lsHandlers = {
      play: () => {
        // Eugene 2026-05-18 Босс «прерывается через секунду» — root cause:
        // mediaSession 'play' handler срабатывал через ~200ms после
        // audio.play() в playTrack → второй audio.play() race condition
        // → браузер прерывал первый. NO-OP здесь: audio.play() уже был
        // вызван выше (line ~851). Handler только обновляет UI state.
        const a = audioRef.current;
        if (a && a.paused) {
          // Только если audio действительно paused (resume после pause кнопки)
          a.play().catch(() => {});
        }
        muteBgMusic();
        setLockScreenPlaybackState('playing');
      },
      pause: () => {
        audioRef.current?.pause();
        unmuteBgMusic();
        setLockScreenPlaybackState('paused');
      },
      previoustrack: () => {
        // Eugene 2026-05-19 «Playlist-strict-selection rule»: ТОЛЬКО filtered.
        const mt = filteredMusicRef.current || [];
        if (mt.length === 0) return;
        const cur = playingTrackRef.current;
        const curIdx = cur ? mt.findIndex(t => t.id === cur.id) : -1;
        const safeIdx = curIdx < 0 ? 0 : curIdx;
        const prev = mt[safeIdx > 0 ? safeIdx - 1 : mt.length - 1];
        if (prev) playTrack(prev);
      },
      nexttrack: () => {
        // Eugene 2026-05-19 «Playlist-strict-selection rule»: ТОЛЬКО filtered.
        const mt = filteredMusicRef.current || [];
        if (mt.length === 0) return;
        const cur = playingTrackRef.current;
        const curIdx = cur ? mt.findIndex(t => t.id === cur.id) : -1;
        const safeIdx = curIdx < 0 ? 0 : curIdx;
        const next = mt[(safeIdx + 1) % mt.length];
        if (next) playTrack(next);
      },
      seekto: (t: number) => {
        if (audioRef.current) audioRef.current.currentTime = t;
      },
    };

    // SYNC setup MediaSession ДО audio.play() — внутри user-gesture стэка.
    // Никаких await перед этой строкой и до audio.play() ниже!
    setupMediaSessionForTrack(
      { id: track.id, title: msTitle, artist: msArtist, album: 'MuzaAi' },
      lsHandlers,
      { coverBust, prewarm: true }
    );

    // iOS gesture budget — play() сразу после setupMediaSessionForTrack.
    const playPromise = audio.play();
    playPromise
      .then(() => {
        // playbackState='playing' ОБЯЗАТЕЛЬНО после успешного play() —
        // иначе iOS считает session paused и не показывает scrubber.
        setLockScreenPlaybackState('playing');
        setIsPlayingState(true);
      })
      .catch((err) => {
        console.warn("[PLAYER] audio.play() rejected (мобильный?):", err?.name, err?.message);
        setIsPlayingState(false);
      });

    registerAudio(audio);
    setPlayerVolume(audio, volumeRef.current);
    playingTrackRef.current = track;
    // Сохраняем в global для cross-page survival (Eugene 14:09)
    if (typeof window !== "undefined") {
      (window as any).__muziaiAudio = audio;
      (window as any).__muziaiTrack = track;
    }
    // Восстановление позиции — только если возвращаемся к ТОМУ ЖЕ треку
    // что был в session (Eugene 12:18 «без промедления продолжить»).
    let restoreTo = 0;
    try {
      const persistedId = Number(localStorage.getItem(psKey("trackId")) || "0");
      const persistedTime = Number(localStorage.getItem(psKey("currentTime")) || "0");
      if (persistedId === track.id && persistedTime > 0 && persistedTime < (track.duration || 9999) - 5) {
        restoreTo = persistedTime;
      }
    } catch {}
    setCurrentTime(restoreTo);
    if (restoreTo > 0) {
      audio.addEventListener("loadedmetadata", () => {
        try { audio.currentTime = restoreTo; } catch {}
      }, { once: true });
    }
    setTrackDuration(track.duration || 0);

    // Crossfade cover
    const oldTrack = tracks.find(t => t.id === playingId);
    if (oldTrack?.imageUrl && oldTrack.imageUrl !== track.imageUrl) {
      setPrevCoverUrl(oldTrack.imageUrl);
      setCoverFading(true);
      setTimeout(() => { setCoverFading(false); setPrevCoverUrl(null); }, 600);
    }

    audio.onloadedmetadata = () => {
      if (audio.duration && isFinite(audio.duration)) {
        setTrackDuration(audio.duration);
        // Eugene 2026-05-21 Босс: «проверяй продолжительность трека и отражай в плейлисте».
        // Если у трека в БД duration=0 (битый Suno metadata) — backfill через server.
        // Idempotent: сервер пишет только если existing < 1.
        if (track && (!track.duration || track.duration < 1)) {
          fetch(`/api/generations/${track.id}/duration`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ duration: Math.round(audio.duration) }),
            keepalive: true,
          }).catch(() => {});
        }
      }
    };

    const handleEnded = () => {
      if (audioRef.current !== audio) return;
      if (timerRef.current) clearInterval(timerRef.current);
      // Eugene 2026-05-21 Босс «при окончании трека — пролёт ракеты вверх».
      // Dispatch event → RocketLaunch компонент ловит и spawn'ит 1-3 ракет
      // с random траекторией. Listener в components/rocket-launch.tsx.
      try { window.dispatchEvent(new CustomEvent("muza:track-finished")); } catch {}
      const mode = repeatModeRef.current;
      const cur = playingTrackRef.current;
      // Eugene 2026-05-19 «Playlist-strict-selection rule»: ТОЛЬКО filtered
      // подборка юзера. Никакого fallback на полный tracksRef — это
      // создавало sneaky playback треков ВНЕ выбранной категории/поиска.
      // Если filtered пуст → останавливаемся (юзер сам разберётся).
      const musicTracks = filteredMusicRef.current || [];
      if (musicTracks.length === 0) {
        setPlayingId(null);
        unmuteBgMusic();
        return;
      }
      if (mode === "one") {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        return;
      }
      const curIdx = cur ? musicTracks.findIndex(t => t.id === cur.id) : -1;
      const safeIdx = curIdx < 0 ? 0 : curIdx;
      // mode="all" И mode="off" — continuous loop в рамках filtered подборки.
      const nextIdx = (safeIdx + 1) % musicTracks.length;
      playTrack(musicTracks[nextIdx]);
    };
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', () => {
      if (audioRef.current !== audio) return;
      if (timerRef.current) clearInterval(timerRef.current);
      setPlayingId(null);
      unmuteBgMusic();
    });


    // MediaSession уже настроена через setupMediaSessionForTrack SYNC выше —
    // duplicate async вызов не нужен (раньше был double-write workaround
    // для iOS first-write drop, который уже не воспроизводится с DOM-attached
    // audio + sync apply pattern).
    setPlayingId(track.id);
    muteBgMusic();

    // If cover is expanded, switch to new track's cover
    if (expandedIdRef.current !== null) {
      setExpandedId(track.id);
    }

    // Eugene 2026-05-17 (Босс «1% conversion plays/visits»): засчитываем
    // play только после 5 сек реального воспроизведения. Проверяем audio
    // НЕ paused через 5 сек и что текущая позиция >= 5. Передаём elapsedSec=5
    // чтобы backend shouldCountPlay() правило «5+ сек» применилось.
    const _playTrackId = track.id;
    window.setTimeout(() => {
      if (audio && !audio.paused && audio.currentTime >= 5) {
        fetch(`/api/playlist/play/${_playTrackId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ elapsedSec: 5 }),
          keepalive: true,
        }).catch(() => {});
      }
    }, 5000);

    // Update current time + lock-screen scrubber position.
    // setLockScreenPosition обязателен для iOS чтобы scrubber на lock-screen
    // работал (двигался + был draggable). Без него — застывает в начале.
    // Throttle 500ms — iOS docs рекомендуют не чаще раза в полсекунды.
    let lastPosUpdate = 0;
    // Eugene 2026-05-22 Босс «между треками задержку уменьши на 2 сек».
    // Prefetch URL следующего трека когда текущий проигран >70% — браузер
    // прогревает HTTP cache, при переключении audio.src = nextUrl стартует
    // мгновенно из cache, не ждёт network. Экономит ~1-2 сек на switch.
    let prefetchedForId: number | null = null;
    timerRef.current = window.setInterval(() => {
      if (audio && !audio.paused) {
        setCurrentTime(audio.currentTime);
        const now = Date.now();
        if (now - lastPosUpdate >= 500 && isFinite(audio.duration) && audio.duration > 0) {
          lastPosUpdate = now;
          setLockScreenPosition(audio.duration, audio.currentTime, audio.playbackRate || 1);
        }
        // Prefetch next track при >70% played (once per current track)
        if (isFinite(audio.duration) && audio.duration > 0 && audio.currentTime / audio.duration > 0.7) {
          const cur = playingTrackRef.current;
          if (cur && prefetchedForId !== cur.id) {
            const list = filteredMusicRef.current || [];
            const idx = list.findIndex(t => t.id === cur.id);
            const next = idx >= 0 ? list[(idx + 1) % list.length] : null;
            if (next?.audioUrl && next.id !== cur.id) {
              try {
                fetch(next.audioUrl, { method: "GET", credentials: "include", cache: "force-cache" }).catch(() => {});
                prefetchedForId = cur.id;
              } catch {}
            }
          }
        }
      }
    }, 250);
  };


  const togglePlay = (track: any) => {
    // Eugene 2026-05-10: deadzone последние 5 сек трека — не реагируем
    // на play-клик, ждём auto-next. Иначе юзер случайно перезапускает
    // и сбивает плейлист.
    if (audioRef.current && playingId === track.id) {
      const a = audioRef.current;
      if (a.duration && isFinite(a.duration) && a.duration - a.currentTime < 5) {
        return;
      }
    }
    if (playingId === track.id) {
      // Eugene 2026-05-14 Босс: если audioRef ещё не создан (mount без
      // auto-init) — playTrack создаст в свежем gesture.
      if (!audioRef.current) {
        playTrack(track);
        return;
      }
      if (audioRef.current?.paused) {
        // Eugene 2026-05-14 Босс «после загрузки сайта стоит на паузе, не
        // могу включить плей». ROOT CAUSE: audio был auto-prepared при
        // mount (preload="metadata"). На клик audioRef.current.play()
        // может reject из-за autoplay policy — silent catch скрывал
        // ошибку. КАРДИНАЛЬНО: если play() reject → пересоздаём через
        // playTrack (new Audio в same gesture, гарантированно работает).
        audioRef.current.play()
          .then(() => muteBgMusic())
          .catch((err) => {
            console.warn("[PLAYER] toggle-play() reject, force re-init:", err?.name, err?.message);
            // Force re-init — playTrack создаст новый Audio и play() в same tick'е gesture
            playTrack(track);
          });
        muteBgMusic();
        timerRef.current = window.setInterval(() => {
          if (audioRef.current && !audioRef.current.paused) {
            const t = audioRef.current.currentTime;
            setCurrentTime(t);
            try {
              if (Math.floor(t) % 2 === 0) localStorage.setItem(psKey("currentTime"), String(t));
            } catch {}
          }
        }, 250);
      } else {
        audioRef.current?.pause();
        if (timerRef.current) clearInterval(timerRef.current);
        unmuteBgMusic();
      }
    } else {
      playTrack(track);
    }
  };

  const skipNext = () => {
    // Eugene 2026-05-19 «Playlist-strict-selection rule»: ТОЛЬКО filtered.
    const musicTracks = filteredMusicRef.current || [];
    if (musicTracks.length === 0) return;
    const idx = musicTracks.findIndex(t => t.id === playingId);
    const nextIdx = idx >= 0 ? (idx + 1) % musicTracks.length : 0;
    if (musicTracks[nextIdx]) playTrack(musicTracks[nextIdx]);
  };

  // === Голосовое управление плеером (Eugene 2026-05-17 Босс) ===
  // Слушаем CustomEvent 'muza-player-action' который эмитит MusaVoiceFab
  // после tool-call. Reuse-working-solutions rule: используем существующие
  // playTrack / togglePlay / skipNext / setVolume / setRepeatMode /
  // setPlaylistKind — НЕ дублируем player state.
  //
  // Используем ref-pattern (playerActionsRef) — listener регистрируется
  // один раз, но всегда видит свежие функции/state через ref.current.
  const playerActionsRef = useRef({
    playTrack,
    togglePlay,
    skipNext,
    setPlayingId,
    setVolume,
    setRepeatMode,
    setPlaylistKind,
  });
  // Обновляем ref на каждый render — closure'ы внутри listener'а
  // всегда читают актуальные функции/setter'ы.
  playerActionsRef.current = {
    playTrack,
    togglePlay,
    skipNext,
    setPlayingId,
    setVolume,
    setRepeatMode,
    setPlaylistKind,
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ action?: string; payload?: any }>;
      const action = String(ce?.detail?.action || "");
      const payload = ce?.detail?.payload ?? null;
      const A = playerActionsRef.current;
      // Eugene 2026-05-21 Босс «КАРДИНАЛЬНО: связка чата с плеером». ACK для
      // ChatTrackCard fallback — если landing смонтирован, отправитель получит
      // подтверждение и НЕ запустит direct-play (избегаем double-trigger).
      try { window.dispatchEvent(new CustomEvent("muza-player-action-ack", { detail: { action } })); } catch {}
      try {
        switch (action) {
          case "play": {
            // Eugene 2026-05-21 Босс «связка с поиском в чате трека и запуском
            // его в плеере». payload может быть: id (number) ИЛИ полный track
            // object {id, audioUrl, displayTitle, ...} — из ChatTrackCard когда
            // Музa нашла трек вне filteredMusic. playTrack регистрирует audioRef
            // → handleEnded работает → autoplay-next из filteredMusic.
            if (payload && typeof payload === "object" && (payload as any).audioUrl) {
              A.playTrack(payload as any);
              break;
            }
            const id = Number(payload);
            if (!Number.isFinite(id) || id <= 0) return;
            const t = tracksRef.current.find((x: any) => x.id === id);
            if (t) A.playTrack(t);
            break;
          }
          case "resume": {
            // Eugene 2026-05-19 «Playlist-strict-selection rule»: ТОЛЬКО filtered.
            const list = filteredMusicRef.current || [];
            if (list.length === 0) return;
            const current = list.find((t: any) => t.id === playingIdRef.current) || list[0];
            if (current) A.togglePlay(current);
            break;
          }
          case "pause": {
            // Если играет — togglePlay сделает pause.
            if (audioRef.current && !audioRef.current.paused) {
              audioRef.current.pause();
            }
            break;
          }
          case "next": {
            A.skipNext();
            break;
          }
          case "prev": {
            // Eugene 2026-05-19 Playlist-strict-selection rule.
            const list = filteredMusicRef.current || [];
            if (list.length === 0) return;
            const idx = list.findIndex((t: any) => t.id === playingIdRef.current);
            const prev = idx > 0 ? idx - 1 : list.length - 1;
            if (list[prev]) A.playTrack(list[prev]);
            break;
          }
          case "volume": {
            const v = Number(payload);
            if (Number.isFinite(v)) {
              A.setVolume(Math.max(0, Math.min(1, v / 100)));
            }
            break;
          }
          case "volume_delta": {
            const d = Number(payload);
            if (Number.isFinite(d)) {
              A.setVolume((cur) => Math.max(0, Math.min(1, cur + d / 100)));
            }
            break;
          }
          case "repeat": {
            const m = String(payload || "").toLowerCase();
            if (m === "off" || m === "one" || m === "all") {
              A.setRepeatMode(m as "off" | "one" | "all");
            }
            break;
          }
          case "filter": {
            const t = String(payload || "").toLowerCase();
            if (t === "main" || t === "new") A.setPlaylistKind(t as "main" | "new");
            // 'my' для landing — только инфо. У landing нет «my» режима.
            break;
          }
          case "show_search": {
            // Поисковая выборка — opt в будущем. Сейчас оставляем no-op,
            // Муза уже текстом озвучила список.
            break;
          }
          default:
            break;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[landing] muza-player-action error:", err);
      }
    };
    window.addEventListener("muza-player-action", handler as EventListener);
    return () => window.removeEventListener("muza-player-action", handler as EventListener);
  }, []);

  // playingIdRef — синхронная копия для listener'а (closure-free).
  const playingIdRef = useRef<number | null>(null);
  playingIdRef.current = playingId;

  if (tracks.length === 0) return null;

  const currentTrack = tracks.find(t => t.id === playingId);
  const progress = trackDuration > 0 ? (currentTime / trackDuration) * 100 : 0;

  // Search filter
  const q = searchQuery.toLowerCase().trim();
  const matchesSearch = (t: any) => !q ||
    (t.prompt || "").toLowerCase().includes(q) ||
    (t.authorName || "").toLowerCase().includes(q);

  const musicTracks = tracks.filter(t => t.type === "music" && t.audioUrl);

  // Filter by category + search
  const categoryFiltered = categoryFilter === 'all' ? musicTracks : musicTracks.filter(t => (t.category || 'song') === categoryFilter);
  const filteredMusic = categoryFiltered.filter(matchesSearch);
  filteredMusicRef.current = filteredMusic;
  const totalPages = Math.max(1, Math.ceil(filteredMusic.length / TRACKS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const paginatedMusic = filteredMusic.slice((safePage - 1) * TRACKS_PER_PAGE, safePage * TRACKS_PER_PAGE);

  const skipPrev = () => {
    // Eugene 2026-05-19 «Playlist-strict-selection rule»: ТОЛЬКО filtered.
    const list = filteredMusicRef.current || [];
    if (list.length === 0) return;
    const idx = list.findIndex(t => t.id === playingId);
    const prev = idx > 0 ? idx - 1 : list.length - 1;
    if (list[prev]) playTrack(list[prev]);
  };

  // Navigate expanded cover to prev/next track.
  // Eugene 2026-05-15 Босс «воспроизведение не соответствует первоначальному
  // отражению» → используем filteredMusicRef (как skipPrev/skipNext/handleEnded),
  // чтобы стрелки в развёрнутом плеере не уводили за пределы выбранной
  // категории/поиска.
  // Eugene 2026-05-19 «Playlist-strict-selection rule»: expandPrev/Next тоже
  // только filtered подборка. Никакого fallback на musicTracks (full).
  const expandPrev = () => {
    const list = filteredMusicRef.current || [];
    if (list.length === 0) return;
    const idx = list.findIndex(t => t.id === expandedId);
    if (idx < 0) return;
    const prev = (idx - 1 + list.length) % list.length;
    const prevTrack = list[prev];
    setExpandedId(prevTrack.id);
    playTrack(prevTrack);
  };
  const expandNext = () => {
    const list = filteredMusicRef.current || [];
    if (list.length === 0) return;
    const idx = list.findIndex(t => t.id === expandedId);
    if (idx < 0) return;
    const next = (idx + 1) % list.length;
    const nextTrack = list[next];
    setExpandedId(nextTrack.id);
    playTrack(nextTrack);
  };

  return (<>
    {/* Eugene 2026-05-22 Босс: «при открытии главной юзер сразу видит основной
        плеер». Новый порядок секций — Плейлист первым, под CTA «Создать трек».
        Дальше: Муза (без gift-пилюль), Новости, Контакты. */}
    <section id="playlist-section" className="relative z-[1] pt-4 sm:pt-6 pb-10 sm:pb-12 px-4 border-t border-white/[0.04]">
      {/* Eugene 2026-05-22 Босс «на планшете и десктопе сократи ширину
          плейлиста за счёт пустого места, -25%». Mobile (<sm) — без изменений
          (max-w-5xl, clamps viewport ≤640). Tablet+desktop (sm+) — max-w-3xl
          (768px ≈ -25% от 1024). scale-jumps убраны — одинаковая ширина на
          всех breakpoint'ах ≥640px. */}
      <div className="max-w-5xl sm:max-w-3xl mx-auto">
        {/* Eugene 2026-05-22 Босс: «скомпонуй по-дизайнерски». Заголовок плеера
            подсвечен: маленький pill «✦ Live» сверху, font-display h2 +
            gradient-text, под ним подзаголовок с MuzaAi-логотипом. */}
        <div className="flex justify-center mb-3">
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 text-[11px] font-sans font-medium text-fuchsia-200 uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-400 animate-pulse" />
            Live · Плейлист
          </span>
        </div>
        <h2 className="text-2xl sm:text-3xl font-display font-bold text-center mb-3 tracking-tight">
          <span className="gradient-text">Плейлист сообщества</span>
        </h2>
        <p className="text-center text-sm sm:text-base font-sans text-muted-foreground mb-8 flex items-center justify-center gap-2 flex-wrap">Треки, созданные авторами <span className="inline-flex items-center gap-1"><span className="inline-block w-4 h-4 rounded bg-gradient-to-br from-purple-600 via-violet-500 to-blue-500 flex items-center justify-center"><svg viewBox="0 0 24 24" className="w-2.5 h-2.5" fill="none"><path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="white" strokeWidth="3" strokeLinecap="round" /></svg></span><span className="font-bold tracking-tight"><span className="bg-gradient-to-r from-purple-400 via-violet-300 to-blue-400 bg-clip-text text-transparent">Muza</span><span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">Ai</span></span></span></p>

        {/* Big player — full-width, visible details */}
        {currentTrack && (
          <div className="glass-card rounded-2xl p-5 mb-6 border border-white/[0.06] relative">
            {/* Eugene 2026-05-21 Босс: «Плей и S в наложении». S смещена дальше от
                края (top-3 right-3 = 12px) + меньше на mobile (w-9 h-9 vs sm:w-11 h-11).
                Применено в обоих местах S — main player FAB + inline expanded. */}
            <button
              className="absolute top-3 right-3 w-9 h-9 sm:w-11 sm:h-11 rounded-full bg-black/60 backdrop-blur-sm border border-white/20 hover:border-fuchsia-400/60 hover:bg-black/80 flex items-center justify-center hover:scale-110 active:scale-95 transition-all z-50 shadow-lg shadow-fuchsia-500/30"
              title="Свайп-режим — листай ← → большие обложки"
              aria-label="Свайп-режим"
              onClick={() => setDetailsOpen(true)}
              data-testid="btn-cover-s-top-right"
              data-musa-hint="📱 Свайп-режим — листай обложки большими карточками, удерживай для сохранения"
            >
              <span className="font-display font-black text-xl tracking-tight text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">S</span>
            </button>
            {/* Eugene 2026-05-16: expand работает только на desktop (md+).
                На mobile — всегда compact row-layout (как было до introducing
                expand button). Кнопка ExpandToggleButton также скрыта на
                mobile через `hidden md:flex` в её className. */}
            <div className={`flex gap-4 items-center ${coverExpanded ? "md:flex-col md:items-stretch" : ""}`}>
              {/* Eugene 2026-05-17 Босс «бутират свет вокруг обложки в фирменных
                  цветах пусть переливаются» — обёртка с animated brand aura
                  (purple→fuchsia→cyan→amber conic gradient + blur + slow spin
                  + pulse opacity). Обложка остаётся резкой внутри. */}
              {/* Eugene 2026-05-18 — обёртка cover+S; cover-square даёт фиксированный размер обложки, S-кнопка идёт после и не выпадает за wrapper. */}
              <div className={`relative shrink-0 flex flex-col ${coverExpanded ? "md:w-full" : "w-[88px] sm:w-[90px]"}`}>
                {/* Eugene 2026-05-18 Босс «обложка -25% базово + desktop resize».
                    Mobile: w-[60px] (было 80) / sm:w-[72px] (было 96). Desktop:
                    coverSize state управляет (75/100/125%). */}
                <div className={`relative ${coverExpanded ? "md:w-full md:aspect-square" : "w-[88px] h-[88px] sm:w-[90px] sm:h-[90px]"} ${!coverExpanded ? coverSizeClass : ""}`}>
                <div
                  aria-hidden="true"
                  className={`absolute -inset-2 rounded-2xl opacity-70 blur-2xl pointer-events-none cover-aura ${coverExpanded ? "md:-inset-3" : ""}`}
                />
              <div
                className={`relative bg-gradient-to-br from-purple-500/30 to-blue-500/30 flex items-center justify-center cursor-pointer shadow-lg shadow-purple-500/10 overflow-hidden transition-all duration-300 w-full h-full rounded-xl ${
                  coverExpanded ? "md:rounded-2xl" : ""
                }`}
                onClick={() => setExpandedId(expandedId === currentTrack.id ? null : currentTrack.id)}
                title={(currentTrack as any).hasCustomCover ? "Обложка создана автором" : undefined}
              >
                {/* Crossfade: old cover fading out */}
                {prevCoverUrl && coverFading && (
                  <img src={prevCoverUrl} alt="" className="w-full h-full object-cover absolute inset-0 transition-opacity duration-500 opacity-0" />
                )}
                {/* Current cover fading in */}
                {currentTrack.imageUrl && (
                  <img key={currentTrack.imageUrl} src={currentTrack.imageUrl} alt="" className="w-full h-full object-cover absolute inset-0 animate-in fade-in duration-500" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                )}
                <Music className={`text-white/10 w-8 h-8 ${coverExpanded ? "md:w-24 md:h-24" : ""}`} />
                {/* Eugene 2026-05-18 Босс «S не нравится на обложке» —
                    S убрана с обложки. Теперь S — в actions panel рядом
                    с Download/Share. */}
                {/* Expand toggle — top-right corner cover (desktop only — на mobile S там) */}
                <ExpandToggleButton
                  expanded={coverExpanded}
                  onToggle={() => setCoverExpanded(v => !v)}
                  className="hidden md:flex absolute top-2 right-2 z-10"
                />
              </div>
              </div>
              {/* Eugene 2026-05-18 Босс «desktop: размер обложки настраиваемый +
                  S под обложку». S-кнопка только на desktop (md+). На mobile S
                  уже в углу обложки. */}
              {/* Eugene 2026-05-18 Босс — S под обложкой больше не нужна,
                  перенесена в actions panel рядом с Download/Share. */}
              {/* Eugene 2026-05-18 Босс «desktop: возможность менять размер
                  отображения обложки». 3 кнопки S/M/L под S-свайпом, скрыты на
                  mobile. */}
              {!coverExpanded && (
                <div className="hidden md:flex mt-2 gap-1 self-center" data-testid="cover-size-toggle">
                  {[
                    { v: "sm", label: "—", size: "75%" },
                    { v: "md", label: "○", size: "100%" },
                    { v: "lg", label: "+", size: "125%" },
                  ].map(opt => (
                    <button
                      key={opt.v}
                      onClick={() => setCoverSize(opt.v as "sm" | "md" | "lg")}
                      className={`w-6 h-6 rounded-full text-xs font-mono transition-all ${coverSize === opt.v ? "bg-gradient-to-br from-purple-500 to-cyan-400 text-white shadow-[0_0_8px_rgba(217,70,239,0.6)]" : "bg-white/5 text-white/50 hover:bg-white/10"}`}
                      title={`Обложка ${opt.size}`}
                      aria-label={`Размер обложки ${opt.size}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
              </div>
              {/* Info + controls */}
              <div className="flex-1 min-w-0">
                <p className="text-base sm:text-lg font-bold text-white truncate">{currentTrack.displayTitle || currentTrack.prompt?.slice(0, 60)}</p>
                <p className="text-sm text-purple-300/80 mt-0.5">
                  {currentTrack.authorName}
                  {currentTrack.styleInfo && <span className="text-purple-300/40 ml-1">· Промт: {currentTrack.styleInfo}</span>}
                </p>
                {/* Progress bar */}
                <div className="flex items-center gap-2 mt-3">
                  <span className="text-xs text-muted-foreground tabular-nums w-9">{formatDuration(currentTime)}</span>
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
                  <span className="text-xs text-muted-foreground tabular-nums w-9 text-right">{formatDuration(trackDuration)}</span>
                </div>
                {/* Control buttons — Eugene 2026-05-18 Босс «кнопки вываливаются + громкость длинная» — flex-wrap + компактные icon-only + volume убран (остался в expanded modal + cover-details). */}
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <button onClick={skipPrev} aria-label="Предыдущий трек" className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/15 active:bg-white/20 transition-colors border border-white/10">
                    <SkipBack className="w-6 h-6 text-white/80" />
                  </button>
                  <button onClick={() => togglePlay(currentTrack)} aria-label="Воспроизведение/пауза" className="w-14 h-14 rounded-full bg-gradient-to-br from-purple-500/35 to-blue-500/30 flex items-center justify-center hover:from-purple-500/55 hover:to-blue-500/45 active:scale-95 transition-all border border-purple-500/40 shadow-lg shadow-purple-500/20">
                    {isPlayingState ? <Pause className="w-7 h-7 text-purple-100" /> : <Play className="w-7 h-7 text-purple-100 ml-0.5" />}
                  </button>
                  <button onClick={skipNext} aria-label="Следующий трек" className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/15 active:bg-white/20 transition-colors border border-white/10">
                    <SkipForward className="w-6 h-6 text-white/80" />
                  </button>
                  <button
                    className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${repeatMode === "all" ? "bg-green-500/20 text-green-300" : "bg-white/5 text-muted-foreground hover:bg-white/10"}`}
                    onClick={() => setRepeatMode(m => m === "all" ? "off" : "all")}
                    title="Плей по кругу"
                  >
                    <Repeat className="w-4 h-4" />
                  </button>
                  <button
                    className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${repeatMode === "one" ? "bg-blue-500/20 text-blue-300" : "bg-white/5 text-muted-foreground hover:bg-white/10"}`}
                    onClick={() => setRepeatMode(m => m === "one" ? "all" : "one")}
                    title="Закольцевать трек"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12a7 7 0 1 0-3 5.7" /><polyline points="14 17 16 17.7 16.7 15.7" /><text x="12" y="15" textAnchor="middle" fontSize="9" fontWeight="700" stroke="none" fill="currentColor">1</text></svg>
                  </button>
                  {/* Eugene 2026-05-18 — VolumeSlider убран с main плеера (вываливался + длинный).
                      Громкость остаётся доступной в CoverDetailsModal (свайп-режим) + в expanded мини-плеере. */}
                  <button
                    className="w-8 h-8 rounded-full bg-white/5 border border-purple-400/15 hover:border-purple-400/40 hover:bg-white/10 flex items-center justify-center transition-colors"
                    title="Скачать"
                    aria-label="Скачать"
                    onClick={() => {
                      const a = document.createElement('a');
                      a.href = `/api/download/${currentTrack.id}`;
                      a.download = '';
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                    }}
                  >
                    <Download className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                  <button
                    className="w-8 h-8 rounded-full bg-white/5 border border-purple-400/15 hover:border-purple-400/40 hover:bg-white/10 flex items-center justify-center transition-colors"
                    title="Поделиться"
                    aria-label="Поделиться"
                    onClick={async () => {
                      // Eugene 2026-05-18 Босс «при шаринге трека preview в TG/iMessage
                      // показывает MuzaAi logo вместо обложки трека». ROOT CAUSE:
                      // /#/track/N — hash route, crawlers (TelegramBot, facebookexternalhit)
                      // получают SPA index.html без OG meta tags. Fix — использовать
                      // /share/N (SSR endpoint с per-track <meta property="og:image">).
                      const url = `https://muzaai.ru/share/${currentTrack.id}`;
                      const title = currentTrack.displayTitle || currentTrack.prompt?.slice(0, 60) || 'MuzaAi';
                      if (navigator.share) {
                        try {
                          // Try sharing with cover image
                          const coverUrl = currentTrack.imageUrl || `/api/stream/${currentTrack.id}?image=1`;
                          const resp = await fetch(coverUrl).catch(() => null);
                          const blob = resp?.ok ? await resp.blob() : null;
                          const files = blob ? [new File([blob], 'cover.jpg', { type: blob.type })] : [];
                          await navigator.share({ title: `Послушай на MuzaAi.ru`, text: `Послушай на MuzaAi.ru: ${title}`, url, ...(files.length ? { files } : {}) });
                          return;
                        } catch {}
                      }
                      navigator.clipboard.writeText(`Послушай на MuzaAi.ru: ${title} ${url}`);
                      toast({ title: "Ссылка скопирована" });
                    }}
                  >
                    <Share2 className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                  {/* Eugene 2026-05-22 Босс «цифры стран чуть ниже при нажатии
                      на глобус панель со странами и флагами, нажатие на панель
                      её закрывает, пропорции ширин уравновесь, не выходи за
                      границы плеера». Структура inline:
                      [🌍-button + 24] [эквалайзер fixed-w] [🎧 7916] */}
                  <div className="flex items-center justify-between gap-2 ml-2 flex-1 min-w-0 max-w-[260px] sm:max-w-[300px] select-none" aria-label="Статистика плейлиста">
                    {/* Eugene 2026-05-22 Босс «нажатием на планетку либо цифры
                        стран раскрывает панель стран. Должна быть открыта снизу
                        вверх не перемещаться вниз плеера». Локальная панель
                        для player'а — anchored к 🌍-кнопке через relative
                        position + absolute panel (bottom-full = над кнопкой,
                        растёт вверх). НЕ общий с hero showCountries чтобы
                        две панели не конфликтовали. */}
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowPlayerCountries(v => !v); }}
                        className="flex flex-col items-center leading-none p-1 -m-1 hover:scale-110 active:scale-95 transition-transform cursor-pointer group"
                        title="Нас слушают (нажмите для списка стран)"
                        aria-label={`Стран слушают: ${countriesCount}. Нажмите для списка.`}
                        aria-expanded={showPlayerCountries}
                      >
                        <span className="text-base leading-none pointer-events-none group-hover:opacity-90">🌍</span>
                        <span className="text-[10px] tabular-nums text-muted-foreground mt-2 pointer-events-none group-hover:text-white/80 group-hover:underline underline-offset-2">{countriesCount}</span>
                      </button>
                      {showPlayerCountries && (
                        <>
                          {/* Backdrop — invisible. Click triggers closePlayerCountries
                              (с 500ms anti-tap cooldown + fade-out анимацией). */}
                          <div
                            className="fixed inset-0 z-[140]"
                            onClick={closePlayerCountries}
                            onPointerDown={closePlayerCountries}
                            aria-hidden="true"
                          />
                          {/* Panel anchored к 🌍 button. bottom-full + mb-2 =
                              над кнопкой с отступом 8px. left-1/2 -translate-x-1/2
                              = центрирована по кнопке. max-h-[60vh] + overflow-y-auto
                              чтобы не выходила за viewport. Растёт ВВЕРХ от anchor.
                              Eugene 2026-05-22 Босс «от нажатия на любую её точку
                              задержку поставь, панель испаряется как обложка»:
                              onClick на panel триггерит closePlayerCountries
                              (с cooldown), animate-out fade-out при isClosing. */}
                          <div
                            className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-[150] min-w-[200px] max-w-[280px] max-h-[60vh] glass-card rounded-2xl border border-purple-500/30 shadow-2xl shadow-purple-500/20 flex flex-col overflow-hidden ${playerCountriesClosing ? "animate-out fade-out duration-200" : "animate-in fade-in duration-150"}`}
                            onClick={closePlayerCountries}
                          >
                            <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5">
                              <p className="text-sm font-semibold text-white/95 m-0">Нас слушают</p>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); closePlayerCountries(); }}
                                className="text-white/50 hover:text-white text-xl leading-none px-1"
                                aria-label="Закрыть"
                              >×</button>
                            </div>
                            <ul className="overflow-y-auto p-3 m-0 list-none flex flex-col gap-1.5" style={{ touchAction: "pan-y", WebkitOverflowScrolling: "touch" }}>
                              {countriesList.length === 0 && (
                                <li className="text-xs text-white/40 text-center py-2">Пока нет данных</li>
                              )}
                              {countriesList.map(c => (
                                <li key={c.country_code || c.country} className="flex items-center gap-2 text-[13px] text-white/85 py-1">
                                  <span className="flex-1 break-words">{c.country}</span>
                                  <span className="text-[18px] shrink-0">{flagOf(c.country_code, c.country)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </>
                      )}
                    </div>
                    {/* Eugene 2026-05-22 Босс «зона эквалайзеров между нижней
                        точкой горизонта цифры стран и точкой горизонта над
                        землёй». 🌍-block: 🌍 (16px) + mt-2 (8px) + countries
                        text-[10px] (~12px) = ~36px total. Эквалайзер h-9 (36px)
                        = равна высоте 🌍-block. items-end на bars — растут
                        снизу-вверх. parent items-center → child эквалайзер
                        и 🌍-block оба центрированы по vertical → top of bars
                        max = top of 🌍, bottom of bars = bottom of countries. */}
                    {/* Eugene 2026-05-22 Босс «после скролла эквалайзеры без
                        движения». ROOT CAUSE: browser-ы (особенно WebKit/Safari)
                        throttle CSS animations на off-screen элементах — после
                        скролла back animation не resume'ится сама. FIX:
                        will-change: transform + GPU layer (translateZ(0)) —
                        bars становятся compositor layer'ами, anim не throttled.
                        Также height: '100%' explicitly (вместо undefined) —
                        чтобы при switch на play не оставалось '30%' от паузы. */}
                    <div className="flex-1 flex items-end gap-[2px] h-12 min-w-[60px] max-w-[130px]" aria-hidden="true" style={{ willChange: "transform" }}>
                      {Array.from({ length: 12 }).map((_, i) => (
                        <div
                          key={i}
                          className="flex-1 rounded-full bg-gradient-to-t from-purple-500 via-fuchsia-500 to-cyan-400 equalizer-bar"
                          style={{
                            animationDelay: `${(i * 0.08).toFixed(2)}s`,
                            animationDuration: `${(0.9 + (i % 3) * 0.15).toFixed(2)}s`,
                            animationPlayState: isPlayingState ? "running" : "paused",
                            height: isPlayingState ? "100%" : "30%",
                            opacity: isPlayingState ? 1 : 0.5,
                            willChange: "height, opacity",
                            transform: "translateZ(0)",
                          }}
                        />
                      ))}
                    </div>
                    {/* 🎧 + plays inline */}
                    <div className="flex items-center gap-1 shrink-0" title="Прослушиваний всего">
                      <span className="text-base leading-none">🎧</span>
                      <span className="text-xs tabular-nums text-muted-foreground">{totalPlays.toLocaleString("ru-RU")}</span>
                    </div>
                  </div>
                  {/* Eugene 2026-05-18 Босс «S в правый нижний угол» —
                      перенесена на absolute bottom-3 right-3 main player card. */}
                </div>
                {/* Создай в том же стиле */}
                {currentTrack.styleInfo && (
                  <button
                    className="w-full mt-2 py-1.5 rounded-lg bg-gradient-to-r from-purple-600/60 to-blue-600/60 text-white text-[10px] font-medium hover:from-purple-500/80 hover:to-blue-500/80 transition-all flex items-center justify-center gap-1.5"
                    onClick={() => {
                      (window as any).__styleTransfer = currentTrack.styleInfo?.split(' \u00b7 ')[0]?.toLowerCase() || 'pop';
                      (window as any).__lyricsTransfer = null;
                      (window as any).__fullStyleTransfer = currentTrack.styleInfo;
                      navigate('/music');
                    }}
                  >
                    <Sparkles className="w-3 h-3" /> Создай в том же стиле
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Eugene 2026-05-16 Босс «🔍 Детали» — full-screen modal обложки.
            Renders only when currentTrack is set; click anywhere → close. */}
        <CoverDetailsModal
          open={detailsOpen && !!currentTrack}
          onClose={() => setDetailsOpen(false)}
          onNext={skipNext}
          onPrev={skipPrev}
          track={currentTrack ? {
            id: currentTrack.id,
            imageUrl: currentTrack.imageUrl,
            hasCustomCover: (currentTrack as any).hasCustomCover,
            displayTitle: currentTrack.displayTitle,
            prompt: currentTrack.prompt,
            authorName: currentTrack.authorName,
            createdAt: currentTrack.createdAt,
            // Eugene 2026-05-17 Босс: дата публикации (не генерации).
            publishedAt: (currentTrack as any).publishedAt,
            styleInfo: currentTrack.styleInfo,
          } : null}
          // Eugene 2026-05-17 — full plyer controls внутри модалки.
          // Audio element остаётся в landing — не remount.
          isPlaying={isPlayingState}
          onPlayPause={() => currentTrack && togglePlay(currentTrack)}
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
          onSetRepeatMode={(m) => setRepeatMode(m)}
        />

        {/* Expanded cover rendered inline after selected track (see renderExpandedCover below) */}

        {/* Eugene 2026-05-15 Босс «кнопки основной плейлист и новые авторы
            сделать пополам по ширине рабочего поля + высоту +25% относительно
            Все/Песни/Поздравления/Инструментальная».
            Соседний category-filter: text-xs px-3 py-1.5 (~28px высота).
            Эти: text-sm px-3 py-2.5 (~36px = +25%). */}
        {/* Eugene 2026-05-22 Босс «плейлист часть попадает на обзор видимой
            части, смести чуть ниже плеера». Spacer между currentTrack big
            player и списком треков — чтобы список не лип к плееру и был
            явно ниже viewport-fold. */}
        <div className="mt-8 sm:mt-10" aria-hidden="true" />
        {/* Eugene 2026-05-16 Босс «убери из меню Новые авторы» — временно
            оставляем только основной плейлист. Backend endpoint остаётся,
            вернём когда исправим UI bug с пустым плейлистом. */}
        <div className="mb-3 grid grid-cols-1 gap-2" style={{ display: "none" }}>
          {(["main"] as const).map(kind => {
            const active = playlistKind === kind;
            const isMain = kind === "main";
            return (
              <button
                key={kind}
                onClick={() => setPlaylistKind(kind)}
                className={`flex items-center justify-center gap-1.5 text-sm px-3 py-2.5 rounded-lg border transition-colors ${
                  active
                    ? isMain
                      ? "border-purple-500/50 bg-purple-500/15 text-purple-200"
                      : "border-emerald-500/50 bg-emerald-500/15 text-emerald-200"
                    : "border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:bg-white/[0.07]"
                }`}
                data-testid={`pl-toggle-${kind}`}
              >
                <span className={active ? "" : "opacity-60"}>{isMain ? "🏆" : "✨"}</span>
                <span>{isMain ? "Основной плейлист" : "Новые авторы"}</span>
              </button>
            );
          })}
        </div>

        {/* Category filter (Eugene 2026-05-14 Босс: вернул Инструментальную) */}
        <div className="flex items-center gap-1.5 mb-3 flex-wrap">
          {([['all', 'Все'], ['song', '🎵 Песни'], ['greeting', '🎉 Поздравления'], ['instrumental', '🎶 Инструментальная']] as const).map(([val, label]) => (
            <button key={val}
              onClick={() => setCategoryFilter(val)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                categoryFilter === val
                  ? val === 'greeting' ? 'border-pink-500/30 bg-pink-500/15 text-pink-300'
                    : val === 'song' ? 'border-purple-500/30 bg-purple-500/15 text-purple-300'
                    : val === 'instrumental' ? 'border-cyan-500/30 bg-cyan-500/15 text-cyan-300'
                    : 'border-white/20 bg-white/10 text-white'
                  : 'border-white/10 bg-white/5 text-muted-foreground hover:text-white'
              }`}
            >{label}</button>
          ))}
        </div>

        {/* Sort toggle */}
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {(["date", "rating", "top_month", "random"] as const).map(mode => {
            const labels: Record<string, string> = { date: "По дате", rating: "По рейтингу", top_month: "Топ за месяц", random: "Случайно" };
            const active = sortMode === mode;
            // Eugene 2026-05-21 Босс «какой параметр юзеры выбирают — такой
            // и по умолчанию». Трекаем каждый explicit toggle юзера.
            const trackChoice = (newMode: string) => {
              try {
                fetch("/api/playlist/track-sort", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ category: categoryFilter, sortMode: newMode }),
                }).catch(() => {});
              } catch {}
            };
            return (
              <button key={mode}
                onClick={() => {
                  if (mode === "random") {
                    setSortMode("random");
                    trackChoice("random");
                    fetch(`/api/playlist?sort=random&dir=desc`).then(r => r.json()).then(setTracks).catch(() => {});
                  } else if (active) {
                    setSortDir(d => d === "asc" ? "desc" : "asc");
                  } else {
                    setSortMode(mode);
                    setSortDir("asc");
                    trackChoice(mode);
                  }
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 ${active ? "bg-purple-500/20 text-purple-300 border border-purple-500/30" : "text-muted-foreground hover:text-white border border-white/10"}`}
              >{labels[mode]}{active && mode !== "random" && <span className="text-[10px]">{sortDir === "desc" ? "▼" : "▲"}</span>}</button>
            );
          })}
        </div>

        {/* Search */}
        <div className="mb-4 flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск по названию, автору или словам..."
            className="flex-1 h-11 rounded-xl bg-white/5 border border-white/10 px-4 text-sm text-white placeholder:text-muted-foreground/50 focus:outline-none focus:border-purple-500/50 transition-colors"
            data-testid="input-playlist-search"
          />
          {searchQuery && (
            <button
              className="h-11 px-4 rounded-xl bg-white/10 text-sm text-muted-foreground hover:bg-white/20 hover:text-white transition-colors shrink-0 active:scale-95"
              onClick={() => setSearchQuery("")}
            >Сбросить</button>
          )}
        </div>

        {/* Eugene 2026-05-21 Босс «панель счётчик перенеси с главной в ЛК автора» —
            PlaysCounter удалён из landing, перенесён в dashboard.tsx. */}

        {/* Eugene 2026-05-21 Босс «ракета при окончании трека вверх под углом».
            Listener в компоненте на window event 'muza:track-finished'.
            Eugene 2026-05-22 Босс «убери ракету после воспроизведения» — disabled. */}
        {/* <RocketLaunch /> */}
        {/* Eugene 2026-05-21 Босс «на +1000 prosлушиваний фейерверк в стиле MuzaAi».
            Listener на 'muza:milestone-1000' — 8 brand ракет с brust искрами. */}
        <Fireworks />

        {/* Track count + page info */}
        {filteredMusic.length > 0 && (
          <div className="flex items-center justify-between text-xs text-muted-foreground px-1 mb-2">
            <span>Треков: {filteredMusic.length}</span>
            {totalPages > 1 && <span>Страница {safePage} из {totalPages}</span>}
          </div>
        )}

        {/* Eugene 2026-05-15 Босс «новые авторы поставь красивую заставку
            пока нет никого». Empty state когда выбран «Новые авторы» и
            нет треков is_public=2. */}
        {playlistKind === "new" && filteredMusic.length === 0 && (
          <div className="mb-4 p-8 rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-cyan-500/8 to-blue-500/10 text-center shadow-[0_0_32px_rgba(16,185,129,0.15)]">
            <div className="text-5xl mb-3">✨🎵🎙️</div>
            <h3 className="text-lg font-bold text-emerald-200 mb-2">Скоро здесь появятся новые авторы</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
              Пока никто не опубликовал свежие треки. Будь первым — создай и опубликуй свой,
              он появится сразу здесь.
            </p>
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                onClick={() => { if (user) navigate("/music"); else navigate("/register-phone"); }}
                className="btn-cosmic rounded-full px-5 py-2 text-sm h-auto"
              >
                🎵 Создать трек
              </button>
              <button
                onClick={() => setPlaylistKind("main")}
                className="text-xs px-3 py-2 rounded-lg border border-white/10 bg-white/[0.04] text-muted-foreground hover:text-white"
              >
                ← К основному плейлисту
              </button>
            </div>
          </div>
        )}

        {/* Track list (music only) */}
        <div className="glass-card rounded-xl overflow-hidden divide-y divide-white/[0.04]">
          {paginatedMusic.map((track, idx) => {
            const isMusic = true;
            const isCover = false;
            const isLyrics = false;
            const isActive = playingId === track.id;
            const isPlaying = isActive && isPlayingState;
            const isExpanded = expandedId === track.id;

            const TypeIcon = isLyrics ? PenLine : isCover ? Image : Music;
            const typeBg = isLyrics
              ? "from-cyan-500/20 to-blue-500/20"
              : isCover
              ? "from-pink-500/20 to-purple-500/20"
              : "from-purple-500/20 to-blue-500/20";
            const typeLabel = isLyrics ? "Текст" : isCover ? "Обложка" : null;
            // Eugene 2026-05-17 Босс: дата ПУБЛИКАЦИИ (когда трек появился в
            // плейлисте), а не дата генерации. Fallback на createdAt для
            // back-compat (треки до миграции / приватные).
            const dateSource = (track as any).publishedAt || track.createdAt;
            const dateStr = dateSource ? new Date(dateSource).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }) : "";

            return (
              <div key={track.id} data-testid={`button-play-track-${track.id}`}>
                <div
                  className={`flex items-center gap-3 px-4 py-5 transition-colors hover:bg-white/[0.03] ${
                    isMusic ? "cursor-pointer" : ""
                  } ${isActive ? "bg-purple-500/[0.08]" : ""}`}
                  data-track-card
                >
                  {/* Cover thumbnail — click to expand.
                      Eugene 2026-05-18 Босс: треки с custom-cover (автор сам
                      сгенерировал обложку, не Suno-default) подсвечиваем
                      subtle ring purple-fuchsia на 30% яркости — заметно,
                      но не вырывается из плеера. */}
                  <div
                    className={`w-10 h-10 rounded-lg overflow-hidden shrink-0 bg-gradient-to-br ${typeBg} relative group flex items-center justify-center cursor-pointer ${
                      coverHighlightEnabled && (track as any).hasCustomCover
                        ? "ring-1 ring-fuchsia-400/30 shadow-[0_0_10px_rgba(217,70,239,0.3)]"
                        : ""
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      // Eugene 2026-05-21 Босс: маленькая обложка → ПУСКАЕТ воспроизведение
                      // (не раскрытие). Раскрытие — на click по строке (title/author ниже).
                      // Если тот же трек уже играет — togglePlay (pause/resume).
                      if (!isMusic) return;
                      togglePlay(track);
                    }}
                  >
                    {track.imageUrl && (
                      <img
                        src={track.imageUrl}
                        alt=""
                        className="w-full h-full object-cover absolute inset-0"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    )}
                    <TypeIcon className="w-4 h-4 text-purple-400/60" />
                    {isMusic && (
                      <div className={`absolute inset-0 flex items-center justify-center bg-black/40 transition-opacity ${
                        isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                      }`}>
                        {isPlaying ? (
                          <Pause className="w-4 h-4 text-white" />
                        ) : (
                          <Play className="w-4 h-4 text-white ml-0.5" />
                        )}
                      </div>
                    )}
                  </div>

                  {/* Title + Author — click to EXPAND cover (Eugene 2026-05-21 Босс:
                      строка раскрывает обложку, маленькая обложка играет) */}
                  <div
                    className={`flex-1 min-w-0 ${isMusic ? "cursor-pointer" : ""}`}
                    onClick={(e) => {
                      if (!isMusic) return;
                      // Toggle expand: повторный клик по строке = свернуть
                      if (isExpanded) { setExpandedId(null); return; }
                      setExpandedId(track.id);
                      setTimeout(() => (e.currentTarget as HTMLElement)?.closest("[data-track-card]")?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      {typeLabel && (
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                          isLyrics ? "bg-cyan-500/10 text-cyan-400" : "bg-pink-500/10 text-pink-400"
                        }`}>{typeLabel}</span>
                      )}
                      <p className={`text-sm font-medium truncate ${isActive ? "text-purple-300" : ""}`}>
                        {track.displayTitle || track.prompt?.slice(0, 50)}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {track.authorName}
                      {track.styleInfo && <span className="text-purple-400/50 ml-1">· Промт: {track.styleInfo}</span>}
                    </p>
                  </div>

                  {/* Plays trend + Duration */}
                  {isMusic && (
                    <div className="flex items-center gap-1 shrink-0">
                      {(track.plays || 0) > 0 && (
                        <div className="flex items-center gap-0.5" title={`${track.plays} прослушиваний`}>
                          {(track.plays || 0) >= 5 ? (
                            <ChevronUp className="w-3 h-3 text-green-400" />
                          ) : (
                            <ChevronDown className="w-3 h-3 text-muted-foreground/40" />
                          )}
                          <span className={`text-[10px] tabular-nums ${(track.plays || 0) >= 5 ? "text-green-400/70" : "text-muted-foreground/40"}`}>{track.plays}</span>
                        </div>
                      )}
                      {(track.downloads || 0) > 0 && (
                        <span className="text-[10px] tabular-nums text-blue-400/60" title={`${track.downloads} скачиваний`}>⬇{track.downloads}</span>
                      )}
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatDuration(track.duration)}
                      </span>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {(track.audioUrl || track.imageUrl) && (
                      <button
                        className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-white/10 transition-colors"
                        onClick={(e) => { e.stopPropagation(); const a = document.createElement('a'); a.href = `/api/download/${track.id}`; a.download = ''; document.body.appendChild(a); a.click(); document.body.removeChild(a); }}
                        data-testid={`download-track-${track.id}`}
                      >
                        <Download className="w-3.5 h-3.5 text-muted-foreground" />
                      </button>
                    )}
                    <button
                      className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-white/10 transition-colors"
                      onClick={async (e) => {
                        e.stopPropagation();
                        const url = `https://muzaai.ru/share/${track.id}`;
                        const title = track.displayTitle || track.prompt?.slice(0, 60) || 'MuzaAi';
                        if (navigator.share) {
                          try {
                            await navigator.share({ title: `Послушай на MuzaAi.ru`, text: `${title}`, url });
                            fetch(`/api/playlist/activity/${track.id}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({action:'share'}) }).catch(() => {});
                            return;
                          } catch {}
                        }
                        setShareTrackId(track.id);
                      }}
                      data-testid={`share-track-${track.id}`}
                    >
                      <Share2 className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                  </div>
                </div>

                {/* Inline expanded cover — appears after selected track */}
                {isExpanded && (() => {
                  const eActive = playingId === track.id;
                  const ePlaying = eActive && isPlayingState;
                  // Eugene 2026-05-17 Босс: дата ПУБЛИКАЦИИ (fallback на createdAt).
                  const eDateSource = (track as any).publishedAt || track.createdAt;
                  const eDateStr = eDateSource ? new Date(eDateSource).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }) : "";
                  return (
                    <div className="px-2 pb-2 pt-1">
                      <div className="relative rounded-2xl overflow-hidden shadow-2xl shadow-purple-500/20 animate-in fade-in zoom-in-95 duration-300">
                        <div
                          className="w-full aspect-square bg-gradient-to-br from-purple-900 via-blue-900 to-black relative cursor-pointer"
                          /* Eugene 2026-05-21 Босс «замедли чувствительность —
                             хочу промотать, она закрывается». Раньше collapse
                             на onPointerDown — любое касание прогресс-бара
                             закрывало cover. Теперь pointerdown записывает
                             старт; pointerup проверяет: расстояние ≤8px,
                             длительность ≤350мс, cooldown после expand 700мс.
                             Drag/scrub/long-press НЕ закрывают cover. */
                          onPointerDown={(e) => {
                            const tgt = e.target as HTMLElement;
                            if (tgt.closest("button, a, [role=button], input, [data-no-collapse]")) return;
                            (e.currentTarget as any).__capX = e.clientX;
                            (e.currentTarget as any).__capY = e.clientY;
                            (e.currentTarget as any).__capAt = Date.now();
                          }}
                          onPointerUp={(e) => {
                            const ce = e.currentTarget as any;
                            const sx = ce.__capX;
                            const sy = ce.__capY;
                            const sat = ce.__capAt;
                            ce.__capX = ce.__capY = ce.__capAt = undefined;
                            if (sx == null || sat == null) return;
                            const tgt = e.target as HTMLElement;
                            if (tgt.closest("button, a, [role=button], input, [data-no-collapse]")) return;
                            const dx = Math.abs(e.clientX - sx);
                            const dy = Math.abs(e.clientY - sy);
                            const dt = Date.now() - sat;
                            if (dx > 8 || dy > 8) return; // drag/scrub — не collapse
                            if (dt > 350) return;          // long-press — не collapse
                            if (Date.now() - expandedAtRef.current < 700) return;
                            e.preventDefault();
                            setExpandedId(null);
                          }}
                          onPointerCancel={(e) => {
                            const ce = e.currentTarget as any;
                            ce.__capX = ce.__capY = ce.__capAt = undefined;
                          }}
                        >
                          {track.imageUrl && <img key={track.imageUrl} src={track.imageUrl} alt="" className="w-full h-full object-cover absolute inset-0 animate-in fade-in duration-500" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />}
                          {/* Eugene 2026-05-19 Босс «S на большой обложке».
                              Eugene 2026-05-21 Босс «Плей и S в наложении»:
                              S меньше на mobile (w-9 h-9) + смещена top-3 right-3
                              (12px от края) — увеличенное расстояние от центральной Play. */}
                          <button
                            className="absolute top-3 right-3 w-9 h-9 sm:w-11 sm:h-11 rounded-full bg-black/60 backdrop-blur-sm border border-white/20 hover:border-fuchsia-400/60 hover:bg-black/80 flex items-center justify-center hover:scale-110 active:scale-95 transition-all z-50 shadow-lg shadow-fuchsia-500/30"
                            title="Свайп-режим — листай ← → большие обложки"
                            aria-label="Свайп-режим"
                            onClick={(e) => {
                              e.stopPropagation();
                              // Если кликнули S на expanded трек, который НЕ
                              // currentTrack — делаем его current чтобы swipe-modal
                              // показывал ИМЕННО его обложку. Без auto-play —
                              // Player-expand-no-restart rule сохраняется.
                              if (playingId !== track.id) setPlayingId(track.id);
                              setDetailsOpen(true);
                            }}
                            data-no-collapse
                          >
                            <span className="font-display font-black text-xl tracking-tight text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">S</span>
                          </button>
                          <div className="absolute inset-0 flex items-center justify-center">
                            <svg viewBox="0 0 24 24" className="w-16 h-16 opacity-10" fill="none">
                              <path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                              <circle cx="6" cy="8" r="1" fill="rgba(255,255,255,0.5)" />
                              <circle cx="12" cy="6" r="1.2" fill="rgba(255,255,255,0.7)" />
                              <circle cx="18" cy="9" r="0.8" fill="rgba(255,255,255,0.4)" />
                              <path d="M6 8L12 6M12 6L18 9" stroke="rgba(255,255,255,0.3)" strokeWidth="0.5" />
                            </svg>
                          </div>
                          <div className="absolute bottom-1 left-1/2 -translate-x-1/2 z-10">
                            <span className="inline-flex items-center gap-1 text-white/20 drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]"><svg viewBox="0 0 24 24" className="w-3 h-3" fill="none"><path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg><span className="text-[10px] whitespace-nowrap">MuzaAi.ru</span></span>
                          </div>
                          {/* Eugene 2026-05-21 Босс «раздвинь Play и S элегантно».
                              Play смещён вниз 4% от центра (mt-[4%]) — освобождает
                              верх обложки для S-кнопки. + frosted ring вокруг Play
                              для визуального separation от фона. */}
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-40 mt-[4%]">
                            <button className="pointer-events-auto w-16 h-16 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center border-2 border-white/40 hover:bg-white/30 hover:scale-105 active:scale-95 transition-all shadow-[0_4px_20px_rgba(0,0,0,0.4)]" onClick={() => togglePlay(track)}>
                              {ePlaying ? <Pause className="w-7 h-7 text-white" /> : <Play className="w-7 h-7 text-white ml-1" />}
                            </button>
                          </div>
                          {musicTracks.length > 1 && (
                            <>
                              {/* Стрелки раскрытой обложки — увеличены до 56px и сдвинуты ~10% к центру (Eugene 12:18) */}
                              <button
                                aria-label="Предыдущий трек"
                                className="absolute left-[10%] top-1/2 -translate-y-1/2 w-14 h-14 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center hover:bg-black/75 active:scale-95 transition-all z-40 border border-white/20 shadow-lg"
                                onClick={() => expandPrev()}
                              >
                                <SkipBack className="w-6 h-6 text-white" />
                              </button>
                              <button
                                aria-label="Следующий трек"
                                className="absolute right-[10%] top-1/2 -translate-y-1/2 w-14 h-14 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center hover:bg-black/75 active:scale-95 transition-all z-40 border border-white/20 shadow-lg"
                                onClick={() => expandNext()}
                              >
                                <SkipForward className="w-6 h-6 text-white" />
                              </button>
                            </>
                          )}
                          {ePlaying && (
                            /* Eugene 2026-05-21 Босс «Плей и S в наложении» — live-индикатор
                               playing перенесён top-3 LEFT-3 (раньше right-3 — overlap с S). */
                            <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-black/60 rounded-full px-2.5 py-1 z-20">
                              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" /><span className="text-[10px] text-white/80">playing</span>
                            </div>
                          )}
                          {/* Eugene 2026-05-18 Босс «S не на обложке» —
                              expanded view тоже без S на cover. Доступ к
                              swipe-modal через main player S в actions panel. */}
                        </div>
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/70 to-transparent px-5 pb-5 pt-24 z-30">
                          <p className="text-white font-bold text-base leading-snug">{track.displayTitle || track.prompt?.slice(0, 80)}</p>
                          <p className="text-white/80 text-sm font-medium mt-1">{track.authorName} <span className="text-white/50">· {eDateStr}</span></p>
                          {/* Eugene 2026-05-19 Босс «убери описание промта в границах обложки».
                              Промт-строка («Промт: Рок · быстрый…») убрана — теперь только
                              title + author + date в overlay. Кнопка «Создать» ниже остаётся. */}
                          <div className="flex items-center gap-2 mt-2">
                            <span className="text-[10px] text-white/50 tabular-nums">{formatDuration(eActive ? currentTime : 0)}</span>
                            <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden cursor-pointer" onClick={(e) => { if (!audioRef.current || !trackDuration) return; const rect = e.currentTarget.getBoundingClientRect(); const pct = (e.clientX - rect.left) / rect.width; audioRef.current.currentTime = pct * trackDuration; setCurrentTime(pct * trackDuration); }}>
                              <div className="h-full rounded-full bg-white/40 transition-all duration-200" style={{ width: `${eActive ? Math.min(progress, 100) : 0}%` }} />
                            </div>
                            <span className="text-[10px] text-white/50 tabular-nums">{formatDuration(eActive ? trackDuration : (track.duration || 0))}</span>
                          </div>
                          {karaokeFeatureEnabled && track.lyric && eActive && showKaraoke && (
                            <div className="mt-3 animate-in fade-in duration-300">
                              <KaraokeLyrics lyrics={track.lyric} currentTime={currentTime} duration={trackDuration} isPlaying={!!ePlaying} offsetSec={lyricsSpeed} />
                            </div>
                          )}
                          <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/10">
                            <div className="flex items-center gap-3">
                              <span className="text-purple-300 text-xs font-semibold tracking-wide">MuzaAi.ru</span>
                              {track.lyric && (
                                <button className={`text-[10px] px-2 py-0.5 rounded-md border transition-colors ${showKaraoke ? "border-purple-500/30 bg-purple-500/10 text-purple-300" : "border-white/10 bg-white/5 text-muted-foreground"}`} onClick={() => setShowKaraoke(!showKaraoke)}>
                                  {showKaraoke ? "Текст ✓" : "Текст"}
                                </button>
                              )}
                              {showKaraoke && (
                                <div className="flex items-center gap-1">
                                  <button className="text-[10px] w-5 h-5 rounded bg-white/10 text-white/60 hover:bg-white/20 flex items-center justify-center" onClick={() => setLyricsSpeed(s => Math.max(s - 1, -10))}>−</button>
                                  <span className="text-[9px] text-white/40 tabular-nums w-6 text-center">{lyricsSpeed > 0 ? "+" : ""}{lyricsSpeed}s</span>
                                  <button className="text-[10px] w-5 h-5 rounded bg-white/10 text-white/60 hover:bg-white/20 flex items-center justify-center" onClick={() => setLyricsSpeed(s => Math.min(s + 1, 10))}>+</button>
                                </div>
                              )}
                              <>
                                <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowCountries(v => !v); }} className="text-[10px] px-2 py-1 rounded-full bg-white/5 text-white/60 border border-white/10 hover:bg-white/10 hover:text-white/90 transition-colors cursor-pointer" title="Нас слушают">🌍 {countriesCount}</button>
                                {showCountries && createPortal(
                                  /* Eugene 2026-05-21 Босс (final): spring-back + close на tap вне panel.
                                     Backdrop transparent (видимости не надо) + onPointerDown/onClick с
                                     target===currentTarget — закрывает только при касании самого backdrop,
                                     не bubbled events от panel. */
                                  <div
                                    onPointerDown={(e) => { if (e.target === e.currentTarget) { setShowCountries(false); setShowCitiesPanel(false); } }}
                                    onClick={(e) => { if (e.target === e.currentTarget) { setShowCountries(false); setShowCitiesPanel(false); } }}
                                    style={{position:'fixed',inset:0,zIndex:99999,background:'transparent',display:'flex',alignItems:'flex-end',justifyContent:'center',padding:'16px'}}
                                  >
                                    <motion.div
                                      drag
                                      dragListener={false}
                                      dragControls={countriesDragHandle}
                                      dragMomentum={false}
                                      dragElastic={0.15}
                                      animate={countriesDragControls}
                                      onDragEnd={() => countriesDragControls.start({ x: 0, y: 0, transition: { type: "spring", stiffness: 300, damping: 25 } })}
                                      onPointerDown={(e) => { e.stopPropagation(); }}
                                      onClick={(e) => e.stopPropagation()}
                                      style={{width:'auto',minWidth:'200px',maxWidth:'min(400px,calc(100vw-32px))',maxHeight:'70vh',display:'flex',flexDirection:'column',borderRadius:'16px',background:'rgba(18,18,22,0.72)',backdropFilter:'blur(40px) saturate(180%)',WebkitBackdropFilter:'blur(40px) saturate(180%)',border:'1px solid rgba(168,85,247,0.3)',boxShadow:'0 2px 16px rgba(0,0,0,0.3), 0 25px 50px -12px rgba(124,58,237,0.25), inset 0 0.5px 0 rgba(255,255,255,0.06)',pointerEvents:'auto'}}>
                                      {/* Drag-handle: header. PointerDown активирует drag panel.
                                          Eugene 2026-05-21 Босс: «скроллим список пальцем, panel на месте».
                                          Скролл — отдельно ниже, drag — только тут. */}
                                      <div
                                        onPointerDown={(e) => { startCountriesLongPress(e); countriesDragHandle.start(e); }}
                                        onPointerUp={cancelCountriesLongPress}
                                        onPointerLeave={cancelCountriesLongPress}
                                        onPointerCancel={cancelCountriesLongPress}
                                        style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'14px 16px 10px',borderBottom:'1px solid rgba(255,255,255,0.06)',cursor:'grab',touchAction:'none',userSelect:'none'}}
                                      >
                                        <p style={{fontSize:'14px',fontWeight:600,color:'rgba(255,255,255,0.95)',margin:0}}>Нас слушают</p>
                                        <button onClick={(e) => { e.stopPropagation(); setShowCountries(false); setShowCitiesPanel(false); }} onPointerDown={(e) => e.stopPropagation()} style={{background:'none',border:'none',color:'rgba(255,255,255,0.5)',fontSize:'20px',cursor:'pointer',padding:'0 8px'}}>×</button>
                                      </div>
                                      {/* Scrollable body — pan-y разрешает вертикальный native scroll,
                                          drag panel (горизонталь+вертикаль через handle) уже отключён здесь. */}
                                      <div style={{flex:1,overflowY:'auto',padding:'12px 16px 16px',touchAction:'pan-y',WebkitOverflowScrolling:'touch'}}>
                                      <ul style={{listStyle:'none',padding:0,margin:0,display:'flex',flexDirection:'column',gap:'6px'}}>
                                        {countriesList.map(c => <li key={c.country_code || c.country} style={{display:'flex',alignItems:'center',gap:'8px',fontSize:'13px',color:'rgba(255,255,255,0.85)',padding:'4px 0'}}><span style={{flex:1,wordBreak:'break-word'}}>{c.country}</span><span style={{fontSize:'18px',flexShrink:0}}>{flagOf(c.country_code, c.country)}</span></li>)}
                                        {countriesList.length === 0 && <li style={{fontSize:'12px',color:'rgba(255,255,255,0.4)'}}>Пока нет данных</li>}
                                      </ul>
                                      {/* Eugene 2026-05-15 Босс: «панель городов раздвигается
                                          из меню стран, количество убрать». Toggle. */}
                                      {topCities.length > 0 && (
                                        <>
                                          <div style={{borderTop:'1px solid rgba(255,255,255,0.08)',margin:'14px 0 10px'}} />
                                          <button
                                            type="button"
                                            onClick={() => setShowCitiesPanel(v => !v)}
                                            style={{
                                              width:'100%',display:'flex',alignItems:'center',justifyContent:'space-between',
                                              background:'none',border:'none',cursor:'pointer',padding:'4px 0',
                                              fontSize:'12px',fontWeight:600,color:'rgba(255,255,255,0.85)',
                                              letterSpacing:'0.04em',textTransform:'uppercase'
                                            }}
                                            aria-expanded={showCitiesPanel}
                                          >
                                            <span>Города</span>
                                            <span style={{
                                              fontSize:'14px',color:'rgba(255,255,255,0.5)',
                                              transition:'transform 0.2s ease',
                                              transform: showCitiesPanel ? 'rotate(180deg)' : 'rotate(0deg)',
                                              display:'inline-block'
                                            }}>▾</span>
                                          </button>
                                          {showCitiesPanel && (
                                            <ul style={{listStyle:'none',padding:'4px 0 0',margin:0,display:'flex',flexDirection:'column',gap:'4px'}}>
                                              {topCities.map((c, i) => (
                                                <li key={`${c.city}-${c.country_code}-${i}`} style={{display:'flex',alignItems:'center',gap:'8px',fontSize:'12px',color:'rgba(255,255,255,0.8)',padding:'2px 0'}}>
                                                  <span style={{fontSize:'16px',flexShrink:0}}>{flagOf(c.country_code, c.country)}</span>
                                                  <span style={{flex:1,wordBreak:'break-word'}} title={`${c.city}, ${c.country}`}>{c.city}</span>
                                                </li>
                                              ))}
                                            </ul>
                                          )}
                                        </>
                                      )}
                                      </div> {/* /scrollable body */}
                                    </motion.div>
                                  </div>,
                                  document.body
                                )}
                              </>
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

                          {/* Создай в том же стиле */}
                          {track.styleInfo && (
                            <button
                              className="w-full mt-3 py-2 rounded-xl bg-gradient-to-r from-purple-600/80 to-blue-600/80 text-white text-xs font-medium hover:from-purple-500 hover:to-blue-500 transition-all flex items-center justify-center gap-2"
                              onClick={() => {
                                // Parse style and transfer to music page
                                (window as any).__styleTransfer = track.styleInfo?.split(' \u00b7 ')[0]?.toLowerCase() || 'pop';
                                (window as any).__lyricsTransfer = null;
                                (window as any).__fullStyleTransfer = track.styleInfo;
                                navigate('/music');
                              }}
                            >
                              <Sparkles className="w-3.5 h-3.5" /> Создай в том же стиле · {track.styleInfo}
                            </button>
                          )}


                        </div>
                      </div>
                    </div>
                  );
                })()}

              </div>
            );
          })}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (() => {
          const goTo = (p: number) => { setCurrentPage(p); document.getElementById('playlist-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
          // Build page numbers: always show first, last, and 2 around current
          const pages: (number | '...')[] = [];
          for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= safePage - 1 && i <= safePage + 1)) {
              pages.push(i);
            } else if (pages[pages.length - 1] !== '...') {
              pages.push('...');
            }
          }
          return (
            <div className="flex items-center justify-center gap-1.5 mt-4">
              <button
                disabled={safePage <= 1}
                onClick={() => goTo(safePage - 1)}
                className="h-9 px-3 rounded-lg bg-white/10 text-sm text-white/70 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed active:scale-95"
              >
                ←
              </button>
              {pages.map((page, i) =>
                page === '...' ? (
                  <span key={`dots-${i}`} className="h-9 w-6 flex items-center justify-center text-white/30 text-sm">…</span>
                ) : (
                  <button
                    key={page}
                    onClick={() => goTo(page)}
                    className={`h-9 w-9 rounded-lg text-sm font-medium transition-colors active:scale-95 ${
                      page === safePage
                        ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/25'
                        : 'bg-white/10 text-white/70 hover:bg-white/20 hover:text-white'
                    }`}
                  >
                    {page}
                  </button>
                )
              )}
              <button
                disabled={safePage >= totalPages}
                onClick={() => goTo(safePage + 1)}
                className="h-9 px-3 rounded-lg bg-white/10 text-sm text-white/70 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed active:scale-95"
              >
                →
              </button>
            </div>
          );
        })()}

        {/* Covers mosaic */}
        {tracks.filter(t => t.type === "cover" && t.imageUrl && matchesSearch(t)).length > 0 && (
          <div className="mt-10">
            <h3 className="text-lg font-bold text-center mb-4">
              <span className="gradient-text">Обложки авторов</span>
            </h3>
            <div className="columns-2 sm:columns-3 gap-3 space-y-3">
              {tracks.filter(t => t.type === "cover" && t.imageUrl && matchesSearch(t)).map(cover => (
                <div
                  key={cover.id}
                  className="break-inside-avoid rounded-xl overflow-hidden relative group cursor-pointer"
                  onClick={() => {
                    window.open(`/api/download/${cover.id}`, "_blank");
                  }}
                >
                  <img
                    src={cover.imageUrl}
                    alt=""
                    className="w-full object-cover rounded-xl"
                    onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = "none"; }}
                  />
                  <div className="absolute bottom-0.5 left-1/2 -translate-x-1/2 z-10">
                    <span className="inline-flex items-center gap-0.5 text-white/20 drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]"><svg viewBox="0 0 24 24" className="w-2.5 h-2.5" fill="none"><path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg><span className="text-[9px] whitespace-nowrap">MuzaAi.ru</span></span>
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-xl flex flex-col justify-end p-3">
                    <p className="text-white text-xs font-medium truncate">{cover.prompt?.slice(0, 40)}</p>
                    <p className="text-white/60 text-[10px]">{cover.authorName}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Lyrics section */}
        {tracks.filter(t => t.type === "lyrics" && matchesSearch(t)).length > 0 && (
          <div className="mt-10">
            <button
              className="text-lg font-bold text-center mb-4 w-full flex items-center justify-center gap-2 hover:opacity-80 transition-opacity"
              onClick={() => setLyricsOpen(!lyricsOpen)}
            >
              <PenLine className="w-4 h-4 text-cyan-400" />
              <span className="gradient-text">Тексты авторов</span>
              <span className="text-xs text-muted-foreground font-normal">({tracks.filter(t => t.type === "lyrics" && matchesSearch(t)).length})</span>
              <span className={`text-xs text-muted-foreground transition-transform ${lyricsOpen ? "rotate-180" : ""}`}>▼</span>
            </button>
            {lyricsOpen && (
              <div className="glass-card rounded-xl overflow-hidden divide-y divide-white/[0.04]">
                {tracks.filter(t => t.type === "lyrics" && matchesSearch(t)).map(lyric => (
                  <div key={lyric.id}>
                    <div
                      className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-white/[0.03] transition-colors"
                      onClick={() => setExpandedLyricId(expandedLyricId === lyric.id ? null : lyric.id)}
                    >
                      <div className="w-10 h-10 rounded-lg shrink-0 bg-gradient-to-br from-cyan-500/20 to-blue-500/20 flex items-center justify-center">
                        <PenLine className="w-4 h-4 text-cyan-400/60" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{lyric.prompt?.slice(0, 50)}</p>
                        <p className="text-xs text-muted-foreground">{lyric.authorName}</p>
                      </div>
                      <span className={`text-xs text-muted-foreground transition-transform ${expandedLyricId === lyric.id ? "rotate-180" : ""}`}>▼</span>
                    </div>
                    {expandedLyricId === lyric.id && (
                      <div className="px-4 pb-4 pt-1">
                        <div className="text-sm text-foreground/80 whitespace-pre-wrap bg-white/[0.02] rounded-lg p-3 max-h-48 overflow-y-auto">
                          {lyric.prompt}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>

    {/* Eugene 2026-05-15 Босс «Музу в топ рейтинга до понедельника» —
        большая Муза-секция в landing (SEO + visibility). H1/H2 содержит
        «Муза», «MuzaAi», ключевики. Структурированная для Schema.org.
        Eugene 2026-05-22 — секция переехала под плеер. */}
    <section id="muza-section" className="relative z-[1] py-10 sm:py-12 px-4 border-t border-white/[0.04] bg-gradient-to-b from-transparent via-purple-500/[0.03] to-transparent">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-col md:flex-row items-center gap-8">
          <div className="w-32 h-32 sm:w-40 sm:h-40 shrink-0 rounded-2xl bg-gradient-to-br from-purple-500/30 via-violet-500/25 to-blue-500/25 border-2 border-purple-300/40 flex items-center justify-center shadow-[0_0_48px_rgba(168,85,247,0.3)] relative overflow-hidden">
            <span className="absolute inset-0 bg-gradient-to-br from-purple-500/20 to-blue-500/20 blur-xl" aria-hidden="true" />
            <div className="relative z-10 text-7xl">✨</div>
          </div>
          <div className="flex-1 text-center md:text-left">
            <h2 className="text-3xl sm:text-4xl font-bold mb-3 leading-tight">
              <span className="bg-gradient-to-r from-purple-300 via-violet-200 to-blue-300 bg-clip-text text-transparent">Муза</span>
              {" "}— твой ИИ-помощник
            </h2>
            <p className="text-base sm:text-lg text-muted-foreground mb-4 leading-relaxed max-w-2xl">
              Виртуальная Муза помогает создать песню, обложку и текст за минуту.
              Опишите событие — Муза предложит стиль, голос, настроение и сгенерирует трек.
              Поп, рок, рэп, классика, шансон, инди — все жанры на MuzaAi.
            </p>
            {/* Eugene 2026-05-22 Босс: gift-пилюли убраны вместе с блоком «1 трек в подарок». */}
            <div className="flex flex-wrap items-center gap-2 justify-center md:justify-start">
              <span className="text-xs px-3 py-1.5 rounded-full bg-purple-500/15 border border-purple-500/30 text-purple-200">🎵 Музыка с ИИ</span>
              <span className="text-xs px-3 py-1.5 rounded-full bg-cyan-500/15 border border-cyan-500/30 text-cyan-200">📝 Текст и обложка</span>
              <span className="text-xs px-3 py-1.5 rounded-full bg-fuchsia-500/15 border border-fuchsia-500/30 text-fuchsia-200">✨ Жанры на любой вкус</span>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3 justify-center md:justify-start">
              <button
                onClick={() => { if (user) navigate("/music"); else navigate("/register-phone"); }}
                className="btn-cosmic rounded-full px-7 py-3 text-base h-auto"
              >
                ♪ Создать с Музой
              </button>
              <a
                href="https://t.me/Muziaipodari_bot"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm px-5 py-3 rounded-full border border-white/15 bg-white/[0.04] text-white/80 hover:bg-white/[0.08] hover:text-white inline-flex items-center gap-2"
              >
                📱 Муза в Telegram
              </a>
            </div>
          </div>
        </div>

        {/* Eugene 2026-05-22 Босс: «за 99₽» переехало из hero под Музу.
            Pricing-pills row — компактный info-блок в brand-палитре. */}
        <div className="mt-8 pt-6 border-t border-white/[0.05] flex flex-wrap items-center justify-center gap-3 text-xs sm:text-sm font-sans">
          <span className="px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-200">
            <span className="font-bold">от 99 ₽</span> за генерацию
          </span>
          <span className="px-3 py-1.5 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-200">
            3 AI-сервиса
          </span>
          <span className="px-3 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-200">
            ~30 сек на трек
          </span>
        </div>
      </div>
    </section>

    {/* News section — Eugene 2026-05-22 переехала под Музу */}
    <section className="relative z-[1] py-10 px-4 border-t border-white/[0.04]">
      <div className="max-w-2xl mx-auto space-y-4">
        {/* 9 мая 2026 — Музыка под событие */}
        {/* 12 мая 2026 — друг компании / помощница (Eugene 2026-05-12).
            При клике скроллит к нижнему углу и открывает меню floating-
            consultant. Никаких внешних ссылок — юзер сам выбирает что
            делать через её меню. */}
        <button
          type="button"
          onClick={() => {
            try {
              window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
              setTimeout(() => window.dispatchEvent(new Event("open-consultant")), 500);
            } catch {}
          }}
          className="block w-full text-left glass-card rounded-2xl p-6 border border-pink-500/30 hover:border-pink-500/50 transition-colors cursor-pointer"
        >
          <div className="flex items-start gap-3">
            <div className="w-14 shrink-0 flex items-start justify-center">
              {/* Eugene 2026-05-18: 3D-аватар через consultant-avatar.png
                  (после approve в админке — hi-res 3D PNG), SVG fallback. */}
              <img
                src="/consultant-avatar.png"
                alt="Муза"
                className="w-14 h-20 sm:w-14 sm:h-20 object-contain"
                draggable={false}
                onError={(e) => { (e.target as HTMLImageElement).src = "/consultant-avatar.svg"; }}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-300 font-medium">Новости</span>
                <span className="text-[10px] font-sans text-muted-foreground">12 мая 2026</span>
              </div>
              <h3 className="text-lg font-sans font-bold text-white mb-2">У нас появилась <span className="bg-gradient-to-r from-pink-400 via-purple-400 to-blue-400 bg-clip-text text-transparent">Муза</span></h3>
              <p className="text-sm font-sans text-muted-foreground leading-relaxed">
                Пройдёт с вами весь путь — от идеи до готового трека. Поможет с регистрацией, поможет создать текст песни. <span className="text-pink-300 font-medium">Нажмите — поговорите →</span>
              </p>
            </div>
          </div>
        </button>

        {/* Eugene 2026-05-17 Босс «убери новость про регистрацию по телефону» —
            скрыто пока reverse-flashcall flow не до отшлифован. */}

      </div>
    </section>

    {/* Contacts */}
    <section className="relative z-[1] py-4 px-4">
      <div className="max-w-2xl mx-auto text-center">
        <p className="text-xs text-muted-foreground/40">
          Контакты: <a href="#" onClick={openMail} className="hover:text-purple-300 transition-colors">написать нам</a>
        </p>
      </div>
    </section>

  </>);
}

function EqualizerDecor() {
  return (
    <div className="flex items-end gap-[3px] h-8 opacity-30">
      {[0.3, 0.7, 0.5, 1, 0.4, 0.8, 0.6, 0.9, 0.3, 0.7, 0.5, 0.8].map((delay, i) => (
        <div
          key={i}
          className="w-[3px] rounded-full bg-gradient-to-t from-purple-500 to-cyan-400 equalizer-bar"
          style={{
            height: `${delay * 100}%`,
            animationDelay: `${i * 0.1}s`,
            animationDuration: `${0.8 + delay * 0.8}s`,
          }}
        />
      ))}
    </div>
  );
}

function HeroEqualizer() {
  const bars = [
    0.2, 0.5, 0.8, 0.4, 1, 0.6, 0.9, 0.3, 0.7, 1, 0.5, 0.8, 0.4, 0.9, 0.6, 1, 0.3, 0.7, 0.5, 0.8,
    0.4, 0.9, 0.7, 1, 0.5, 0.3, 0.8, 0.6, 0.9, 0.4, 0.7, 1, 0.5, 0.8, 0.3, 0.6
  ];
  return (
    <div className="flex items-end justify-center gap-[2px] sm:gap-[3px] h-16 sm:h-24 w-full max-w-md mx-auto">
      {bars.map((h, i) => {
        const fromCenter = Math.abs(i - bars.length / 2) / (bars.length / 2);
        const scale = 1 - fromCenter * 0.5;
        return (
          <div
            key={i}
            className="rounded-full equalizer-bar"
            style={{
              width: "clamp(2px, 1vw, 5px)",
              height: `${h * scale * 100}%`,
              background: `linear-gradient(to top, rgba(147,51,234,${0.6 + scale * 0.4}), rgba(6,182,212,${0.4 + scale * 0.4}))`,
              animationDelay: `${i * 0.05}s`,
              animationDuration: `${0.6 + h * 0.8}s`,
              filter: `blur(${fromCenter > 0.7 ? 1 : 0}px)`,
            }}
          />
        );
      })}
    </div>
  );
}

// Obfuscated email — assembled at click time, invisible to bots
function openMail(e: React.MouseEvent) {
  e.preventDefault();
  const p = ["tis","san","20","21","@","gm","ail",".","com"];
  const addr = p.join("");
  window.location.href = `mailto:${addr}?subject=${encodeURIComponent("MuzaAi — обращение")}`;
}

export default function LandingPage() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showInstallGuide, setShowInstallGuide] = useState<"ios" | "android" | null>(null);
  // Eugene 2026-05-22 Босс «скролл страницы вниз зависает». ROOT CAUSE:
  // дубликат body.overflow=hidden в CoverDetailsModal оставлял body
  // залоченным после закрытия swipe-modal. Safety net — при mount/visibility
  // change LandingPage гарантирует что body.overflow сброшен.
  useEffect(() => {
    const reset = () => {
      if (document.body.style.overflow === "hidden") {
        document.body.style.overflow = "";
        document.body.style.paddingRight = "";
      }
    };
    reset();
    document.addEventListener("visibilitychange", reset);
    return () => document.removeEventListener("visibilitychange", reset);
  }, []);
  // Eugene 2026-05-22 Босс: «блок 1 трек в подарок убран» — gift state и
  // модалка удалены, плеер поднят сразу под CTA «Создать трек».
  const [, playParams] = useRoute("/play/:id");
  const autoPlayId = playParams?.id ? parseInt(playParams.id) : undefined;

  const handleServiceClick = (href: string) => {
    if (!user) {
      setShowAuthModal(true);
      return;
    }
    navigate(href);
  };

  return (
    <div className="min-h-screen relative">
      {/* Global starfield background — fixed behind everything */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <StarfieldCanvas />
      </div>

      {/* Hero Section.
          Eugene 2026-05-17 — добавлен scan-line класс: animated 2px cyan
          scan-полоса сверху вниз раз в 4 сек, hi-tech акцент поверх hero.
          Eugene 2026-05-22 — Босс: «плеер сразу виден без скролла». Hero
          компактнее: pt-20→pt-12 sm:pt-16, убран minHeight 100vh, убран
          HeroEqualizer (mt-8 → 0), уменьшен h1, убран «Узнать больше»
          (переехал под плеер), убран stats-блок с «от 99₽» (переехал под
          Музу как pricing-pill). */}
      <section className="relative z-[1] pt-12 sm:pt-16 pb-6 sm:pb-8 px-4 overflow-hidden hero-gradient scan-line">

        {/* Decorative equalizer elements */}
        <div className="absolute top-20 left-10 opacity-20 hidden lg:block z-[1]">
          <EqualizerDecor />
        </div>
        <div className="absolute top-40 right-16 opacity-20 hidden lg:block z-[1]">
          <EqualizerDecor />
        </div>

        <div className="max-w-4xl mx-auto text-center relative z-10">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-purple-500/20 bg-purple-500/5 mb-4">
            <StudioMicEq size="xs" color="text-purple-400" eqColor="bg-purple-400" />
            <span className="text-sm text-purple-300 font-medium">Нейросети для музыки</span>
          </div>

          {/* Eugene 2026-05-15 Босс «Музу в топ рейтинга». H1 содержит
              «Муза» + «MuzaAi» — критичный SEO-сигнал для Яндекс/Google.
              Eugene 2026-05-22 — h1 уменьшен (text-3xl sm:text-4xl lg:text-5xl)
              чтобы плеер влез в первый экран. */}
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-display font-bold mb-4 leading-tight tracking-tight" data-testid="text-hero-title">
            <span className="bg-gradient-to-r from-purple-400 via-violet-300 to-blue-400 bg-clip-text text-transparent neon-text">Muza</span><span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent neon-text">Ai</span>
            <span className="text-foreground"> · создай песню с ИИ за минуту</span>
          </h1>

          <p className="text-sm sm:text-base text-muted-foreground max-w-xl mx-auto mb-5 leading-relaxed">
            Создай за 1 минуту уникальную Песню для себя или в Подарок
          </p>

          {/* Eugene 2026-05-22 Босс: только основной CTA в hero. «Узнать
              больше» переехало под плеер. Никаких stats/gift-блоков —
              плеер ниже должен быть виден в первый экран. */}
          <div className="flex items-center justify-center">
            <Button
              size="lg"
              className="btn-cosmic rounded-full px-8 py-3 text-base sm:text-lg h-auto"
              onClick={() => {
                if (user) navigate("/music");
                else navigate("/register-phone");
              }}
              data-testid="button-hero-cta"
              data-musa-hint="🎵 Нажми — создадим твою первую песню за 2 минуты"
            >
              <span className="text-xl mr-2">♪</span>
              Создать трек
              <ArrowRight className="w-5 h-5 ml-2" />
            </Button>
          </div>
        </div>
      </section>

      {/* Community Playlist - right after price stats */}
      <PlaylistSection autoPlayId={autoPlayId} />

      {/* Eugene 2026-05-22 Босс: «Узнать больше» сместить под плеер.
          Secondary CTA в brand-стиле (border-purple-400/30 + glass) —
          скроллит к Муза-секции. */}
      <div className="flex justify-center mt-2 mb-8 px-4">
        <button
          type="button"
          onClick={() => {
            document.getElementById("muza-section")?.scrollIntoView({ behavior: "smooth" });
          }}
          className="text-sm font-sans px-6 py-2.5 rounded-full bg-white/5 border border-purple-400/30 text-white/80 hover:bg-white/10 hover:border-purple-400/50 hover:text-white transition-colors inline-flex items-center gap-2"
          data-testid="button-learn-more"
        >
          Узнать больше
          <span className="text-purple-300">↓</span>
        </button>
      </div>

      {/* Services Grid */}
      <section id="services" className="relative z-[1] py-20 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-2xl sm:text-3xl font-bold mb-4" data-testid="text-services-title">
              <span className="gradient-text">Три мощных инструмента</span>
            </h2>
            <p className="text-muted-foreground max-w-xl mx-auto">
              Всё, что нужно для создания музыки — от текста до готового трека с обложкой
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {services.map((service) => (
              <div
                key={service.title}
                className={`p-6 rounded-2xl cursor-pointer group relative transition-transform hover:scale-[1.02] ${
                  service.star ? "card-cosmic md:-translate-y-4 md:scale-105" : "gradient-border"
                }`}
                onClick={() => handleServiceClick(service.href)}
                data-testid={`card-service-${service.title}`}
              >
                {service.star && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 btn-cosmic text-xs px-3 py-1 rounded-full">
                    ♪ Главный AI инструмент
                  </div>
                )}
                <div
                  className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${
                    service.star ? "btn-cosmic" : `bg-gradient-to-br ${service.iconBg}`
                  }`}
                >
                  <service.icon className="w-6 h-6 text-white" />
                </div>
                <h3 className={`text-lg font-semibold mb-2 ${service.star ? "text-white text-xl" : "text-white"}`}>
                  {service.star && <span className="mr-1">♪</span>}
                  {service.title}
                </h3>
                <p className="text-sm text-muted-foreground mb-4 leading-relaxed">{service.description}</p>
                <div className="flex items-center justify-between">
                  <span className="price-badge" data-testid={`badge-price-${service.title}`}>{service.price}</span>
                  {service.star ? (
                    <span className="btn-cosmic text-sm font-bold px-4 py-1.5 rounded-full flex items-center gap-1 group-hover:scale-105 transition-transform">
                      ♪ Создать трек <ArrowRight className="w-3 h-3" />
                    </span>
                  ) : (
                    <span className="text-sm text-purple-400 font-medium group-hover:translate-x-1 transition-transform flex items-center gap-1">
                      Создать <ArrowRight className="w-3 h-3" />
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="relative z-[1] py-20 px-4 border-t border-white/[0.04]">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-2xl sm:text-3xl font-bold mb-4">
              <span className="gradient-text">Как это работает</span>
            </h2>
            <p className="text-muted-foreground">Три простых шага до результата</p>
          </div>

          <div className="grid sm:grid-cols-3 gap-8">
            {steps.map((step, i) => (
              <div key={step.title} className="text-center" data-testid={`step-${i + 1}`}>
                <div className="w-16 h-16 rounded-2xl glass-card mx-auto mb-4 flex items-center justify-center relative">
                  <step.icon className="w-7 h-7 text-purple-400" />
                  <span className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 text-white text-xs font-bold flex items-center justify-center">
                    {i + 1}
                  </span>
                </div>
                <h3 className="text-base font-semibold text-white mb-2">{step.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{step.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Share QR */}
      <ShareQRSection />

      {/* CTA — Eugene 2026-05-22 Босс: «блок 1 трек в подарок убран».
          Оставляем generic CTA + установочные кнопки iPhone/Android. */}
      <section className="relative z-[1] py-20 px-4 border-t border-white/[0.04]">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-2xl sm:text-3xl font-bold mb-4">
            <span className="gradient-text">Готовы создать свой первый трек?</span>
          </h2>
          <p className="text-muted-foreground mb-8">
            Откройте Музу — она поможет с идеей, текстом и обложкой
          </p>
          <Button
            size="lg"
            className="btn-cosmic rounded-full px-10 py-3 text-base h-auto"
            onClick={() => {
              if (user) navigate("/music");
              else navigate("/register-phone");
            }}
            data-testid="button-cta-bottom"
          >
            <span className="text-lg mr-2">♪</span>
            Создать трек
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>

          {/* App store style buttons */}
          <div className="mt-6 flex items-center justify-center gap-3">
            {/* MuzaAi full logo (icon + text) */}
            <div className="flex items-center gap-2">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-600 via-violet-500 to-blue-500 flex items-center justify-center shadow-lg shadow-purple-500/20">
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                  <path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="white" strokeWidth="2" strokeLinecap="round" />
                  <circle cx="6" cy="8" r="1" fill="rgba(255,255,255,0.5)" />
                  <circle cx="12" cy="6" r="1.2" fill="rgba(255,255,255,0.7)" />
                  <circle cx="18" cy="9" r="0.8" fill="rgba(255,255,255,0.4)" />
                </svg>
              </div>
              <span className="text-lg font-bold tracking-tight"><span className="bg-gradient-to-r from-purple-400 via-violet-300 to-blue-400 bg-clip-text text-transparent">Muza</span><span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">Ai</span></span>
            </div>

            {/* iPhone button */}
            <button
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 hover:bg-white/[0.1] transition-colors"
              onClick={async () => {
                if (navigator.share) {
                  try { await navigator.share({ title: 'MuzaAi', text: 'Создавай музыку с AI → Нажмите «На экран Домой»', url: 'https://muzaai.ru' }); return; } catch {}
                }
                setShowInstallGuide("ios");
              }}
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5 text-white" fill="currentColor">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
              </svg>
              <div className="text-left">
                <div className="text-[9px] text-white/50 leading-none">Скачать в</div>
                <div className="text-sm text-white font-medium leading-tight">iPhone</div>
              </div>
            </button>

            {/* Android button */}
            <button
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 hover:bg-white/[0.1] transition-colors"
              onClick={async () => {
                const prompt = (window as any).__pwaInstallPrompt;
                if (prompt) { prompt.prompt(); const r = await prompt.userChoice; if (r.outcome === 'accepted') (window as any).__pwaInstallPrompt = null; return; }
                if (navigator.share) {
                  try { await navigator.share({ title: 'MuzaAi', text: 'Создавай музыку с AI → Нажмите «Добавить на главный экран»', url: 'https://muzaai.ru' }); return; } catch {}
                }
                setShowInstallGuide("android");
              }}
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5 text-white" fill="currentColor">
                <path d="M17.523 2.418l1.493-2.655a.403.403 0 00-.7-.396L16.793 2.06a8.44 8.44 0 00-4.793-1.398 8.44 8.44 0 00-4.793 1.398L5.684-.633a.403.403 0 00-.7.396l1.493 2.655C3.184 4.467 1.078 8.04 1.078 12.123h21.844c0-4.083-2.106-7.656-5.399-9.705zM7.32 9.051a1.147 1.147 0 110-2.294 1.147 1.147 0 010 2.294zm9.36 0a1.147 1.147 0 110-2.294 1.147 1.147 0 010 2.294zM1.078 12.936v8.239c0 1.168.949 2.117 2.117 2.117h1.129v3.281c0 1.17.949 2.119 2.117 2.119s2.117-.949 2.117-2.119v-3.281h4.883v3.281c0 1.17.949 2.119 2.117 2.119s2.117-.949 2.117-2.119v-3.281h1.129c1.168 0 2.117-.949 2.117-2.117v-8.239H1.078zm-3.192 0c-1.168 0-2.117.949-2.117 2.117v5.762c0 1.168.949 2.117 2.117 2.117s2.117-.949 2.117-2.117v-5.762c0-1.168-.949-2.117-2.117-2.117zm20.227 0c-1.168 0-2.117.949-2.117 2.117v5.762c0 1.168.949 2.117 2.117 2.117s2.117-.949 2.117-2.117v-5.762c0-1.168-.949-2.117-2.117-2.117z" transform="scale(0.8) translate(3,0)"/>
              </svg>
              <div className="text-left">
                <div className="text-[9px] text-white/50 leading-none">Скачать в</div>
                <div className="text-sm text-white font-medium leading-tight">Android</div>
              </div>
            </button>
          </div>
        </div>
      </section>

      {/* Footer — содержит юр.реквизиты (требование Robokassa: ИНН/ОГРН,
          контакты, ссылки на оферту/политику/возврат). Данные подгружаются
          из /api/legal/config — обновляются через ENV без релиза. */}
      <LandingFooter onMail={openMail} />

      {/* Auth Required Modal */}
      <Dialog open={showAuthModal} onOpenChange={setShowAuthModal}>
        <DialogContent className="glass-card border-purple-500/20 max-w-sm">
          <DialogHeader>
            <DialogTitle className="gradient-text text-lg">Нужна регистрация</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Зарегистрируйтесь, чтобы создавать музыку, тексты и обложки с AI
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 mt-4">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => { setShowAuthModal(false); navigate("/login"); }}
              data-testid="button-modal-login"
            >
              Войти
            </Button>
            <Button
              className="flex-1 btn-gradient"
              onClick={() => { setShowAuthModal(false); navigate("/register"); }}
              data-testid="button-modal-register"
            >
              Регистрация
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Install guide modal */}
      <Dialog open={!!showInstallGuide} onOpenChange={() => setShowInstallGuide(null)}>
        <DialogContent className="glass-card border-purple-500/20 max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-600 via-violet-500 to-blue-500 flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none">
                  <path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="white" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              <span className="font-bold tracking-tight"><span className="bg-gradient-to-r from-purple-400 via-violet-300 to-blue-400 bg-clip-text text-transparent">Muza</span><span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">Ai</span></span>
            </DialogTitle>
          </DialogHeader>
          {showInstallGuide === "ios" ? (
            <div className="space-y-4 mt-2">
              <p className="text-sm text-muted-foreground">Установите MuzaAi на iPhone:</p>
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <span className="w-7 h-7 rounded-full bg-purple-500/20 text-purple-300 flex items-center justify-center text-sm font-bold shrink-0">1</span>
                  <p className="text-sm text-white/80 pt-1">Нажмите <span className="inline-block px-1.5 py-0.5 rounded bg-white/10 text-white text-xs">↑ Поделиться</span> внизу экрана Safari</p>
                </div>
                <div className="flex items-start gap-3">
                  <span className="w-7 h-7 rounded-full bg-purple-500/20 text-purple-300 flex items-center justify-center text-sm font-bold shrink-0">2</span>
                  <p className="text-sm text-white/80 pt-1">Пролистайте вниз и нажмите <span className="inline-block px-1.5 py-0.5 rounded bg-white/10 text-white text-xs">На экран Домой</span></p>
                </div>
                <div className="flex items-start gap-3">
                  <span className="w-7 h-7 rounded-full bg-green-500/20 text-green-300 flex items-center justify-center text-sm font-bold shrink-0">✓</span>
                  <p className="text-sm text-white/80 pt-1">MuzaAi появится как приложение на вашем домашнем экране</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4 mt-2">
              <p className="text-sm text-muted-foreground">Установите MuzaAi на Android:</p>
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <span className="w-7 h-7 rounded-full bg-purple-500/20 text-purple-300 flex items-center justify-center text-sm font-bold shrink-0">1</span>
                  <p className="text-sm text-white/80 pt-1">Нажмите <span className="inline-block px-1.5 py-0.5 rounded bg-white/10 text-white text-xs">⋮</span> в правом верхнем углу Chrome</p>
                </div>
                <div className="flex items-start gap-3">
                  <span className="w-7 h-7 rounded-full bg-purple-500/20 text-purple-300 flex items-center justify-center text-sm font-bold shrink-0">2</span>
                  <p className="text-sm text-white/80 pt-1">Выберите <span className="inline-block px-1.5 py-0.5 rounded bg-white/10 text-white text-xs">Добавить на главный экран</span></p>
                </div>
                <div className="flex items-start gap-3">
                  <span className="w-7 h-7 rounded-full bg-green-500/20 text-green-300 flex items-center justify-center text-sm font-bold shrink-0">✓</span>
                  <p className="text-sm text-white/80 pt-1">MuzaAi появится как приложение на вашем домашнем экране</p>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Eugene 2026-05-18 Robokassa правила сайта: footer обязан содержать
// ИНН/ОГРН + контакты + ссылки на оферту, политику, возврат, контакты.
// Реквизиты подгружаются из /api/legal/config (server/lib/legalConfig.ts).
interface LegalFooterData {
  entityName?: string;
  inn?: string;
  ogrn?: string;
  phone?: string;
  email?: string;
  domain?: string;
}

function LandingFooter({ onMail }: { onMail: (e: any) => void }) {
  const [legal, setLegal] = useState<LegalFooterData | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/legal/config")
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setLegal(data); })
      .catch(() => { /* silent — footer без реквизитов лучше чем sentry-spam */ });
    return () => { cancelled = true; };
  }, []);

  const hasInn = legal?.inn && !legal.inn.includes("🔴");
  const hasOgrn = legal?.ogrn && !legal.ogrn.includes("🔴");
  const hasPhone = legal?.phone && !legal.phone.includes("🔴");

  return (
    <footer className="relative z-[1] border-t border-white/[0.06] py-8 px-4">
      <div className="max-w-6xl mx-auto space-y-5">
        {/* Top row — лого + основные ссылки */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-purple-600 via-violet-500 to-blue-500 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none">
                <path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            </div>
            <span className="text-sm font-bold tracking-tight">
              <span className="bg-gradient-to-r from-purple-400 via-violet-300 to-blue-400 bg-clip-text text-transparent">Muza</span>
              <span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">Ai</span>
            </span>
          </div>
          <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
            <a href="#/oferta" className="text-muted-foreground hover:text-purple-300 transition-colors">Оферта</a>
            <a href="#/privacy" className="text-muted-foreground hover:text-purple-300 transition-colors">Политика конф.</a>
            <a href="#/refund" className="text-muted-foreground hover:text-purple-300 transition-colors">Возврат</a>
            <a href="#/contacts" className="text-muted-foreground hover:text-purple-300 transition-colors">Контакты</a>
            <a href="#" onClick={onMail} className="text-muted-foreground hover:text-purple-300 transition-colors">Поддержка</a>
          </nav>
        </div>

        {/* Legal row — ИНН/ОГРН/email/телефон (Robokassa требует видимость
            в подвале сайта). Если ENV не заполнен — показываем только
            email/copyright, не плодим placeholder-маркеры пользователю. */}
        <div className="border-t border-white/[0.04] pt-4 flex flex-col items-center gap-2 text-[11px] text-muted-foreground font-mono">
          {legal?.entityName && !legal.entityName.includes("🔴") && (
            <p className="text-center">{legal.entityName}</p>
          )}
          <p className="text-center flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            {hasInn && <span>ИНН: <span className="text-white/80">{legal!.inn}</span></span>}
            {hasOgrn && <span>ОГРН: <span className="text-white/80">{legal!.ogrn}</span></span>}
            {hasPhone && (
              <span>
                Тел.:{" "}
                <a href={`tel:${legal!.phone}`} className="text-white/80 hover:text-purple-300">
                  {legal!.phone}
                </a>
              </span>
            )}
            <span>
              Email:{" "}
              <a href={`mailto:${legal?.email || "hello@muzaai.ru"}`} className="text-white/80 hover:text-purple-300">
                {legal?.email || "hello@muzaai.ru"}
              </a>
            </span>
          </p>
          <p className="text-center text-muted-foreground/60 mt-1">
            © 2026 MuzaAi. Создавай музыку с искусственным интеллектом. Оплата через{" "}
            <span className="text-white/70">Робокасса</span> (карты Visa/MC/МИР, СБП).
          </p>
        </div>
      </div>
    </footer>
  );
}
