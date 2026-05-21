// FloatingConsultant (Eugene 2026-05-11 v4): деловой стиль —
// менеджер 25-30 в пиджаке, с планшетом (намёк на работу/консультацию).
// Pastel MuzaAi gradient. Открытые глаза, закрытый рот, прямая осанка.
// Минимум нот вокруг (1 акцентная) — для связи с музыкой.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { playMuzaChime, playMuzaTick, playMuzaSparkle } from "../lib/muza-sounds";
import { useFeatureEnabled } from "@/lib/featureToggles";
import { onJourneyEvent } from "../lib/user-journey";
import { getPersistentPlayerAudio } from "../lib/lockscreen";
import { SupportModal } from "./support-modal";
import { ChatTrackCard, type ChatTrackCardData } from "./chat-track-card";
// Eugene 2026-05-21 Босс Chat-tool-calling MVP: approval-карточка + job-карточка
// для chat-tool результатов (generate_lyrics / create_music_job / publish_asset).
import { ChatApprovalCard, ChatJobCard } from "./chat-tool-cards";
import { clampToViewport, readPos, writePos } from "@/lib/clampViewport";

// Eugene 2026-05-14 Босс: «после 1 dismiss через 1 мин, если ещё раз — 1 час».
const REAPPEAR_MS_FIRST = 60_000;     // 1 минута после первого dismiss
const REAPPEAR_MS_SECOND = 3_600_000; // 1 час после второго
const APPEAR_DELAY_MS = 2500;
const MAX_DISMISS = 3;
const SS_KEY = "_helperDismissed";
const SCROLL_VELOCITY_THRESHOLD = 60; // px между двумя scroll-events за <100ms = «резкий»

// Eugene 2026-05-11: трекинг вовлечения. POST /api/engagement/track
// для admin-дашборда (📊 Воронка). Не блокирует UI — fire-and-forget.
function trackEngagement(
  event: "consultant_impression" | "consultant_open" | "consultant_action",
  meta?: Record<string, any>
) {
  try {
    let sid = sessionStorage.getItem("_engagementSid");
    if (!sid) { sid = Math.random().toString(36).slice(2, 14); sessionStorage.setItem("_engagementSid", sid); }
    fetch("/api/engagement/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, sessionId: sid, meta }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

// Reactions при клике (Eugene 2026-05-12): игровой деловой стиль,
// разные фразы каждый раз. Циклично прокручиваются по нажатиям.
const CLICK_REACTIONS = [
  "Я тут, к делу 🎵",
  "Слушаю внимательно",
  "Чем помочь?",
  "Есть идея для трека?",
  "Готова обсудить",
  "Привет! О чём поговорим?",
  "Что у нас сегодня?",
  "Какой повод думаете?",
  "Я в проекте, спрашивайте",
  "Подберу под событие",
];

// Eugene 2026-05-14 Босс «вверху ответа Музы напиши её имя в цвет образа».
// Eugene 2026-05-18 Босс «в чате выводим только аватар Музы — другие имена это
// характеры (внутренняя стратегия Музы), не показываем юзеру». chatPersona-state
// удалён, в UI везде «Муза» + единый /consultant-avatar.png. Сами psychotype/tone
// продолжают применяться в server-side system prompt (см. consultantPersona.ts).
// Mapping имени персоны на цвет — психотип определяет тон. (legacy)
// warm = pink (тёплые), energetic = amber (искра), analytical = cyan (точно),
// calm = emerald (спокойствие). Применяется как text-color в name-bage.
const PERSONA_COLOR: Record<string, string> = {
  // adult warm
  "Аня": "text-pink-300",     "Михаил": "text-pink-300",
  // adult energetic
  "Татьяна": "text-amber-300","Дмитрий": "text-amber-300",
  // adult analytical
  "Мария": "text-cyan-300",   "Алексей": "text-cyan-300",
  // adult calm
  "Ольга": "text-emerald-300","Андрей": "text-emerald-300",
  // teens
  "Лиза": "text-pink-300",    "Полина": "text-amber-300",
  "Кирилл": "text-amber-300", "Артём": "text-pink-300",
  // kids
  "Маша": "text-pink-300",    "Лёша": "text-amber-300",
};

// Eugene 2026-05-14 Босс: inline-чат с Музой на сайте + cross-channel pair-code.
// quickReplies — 2-3 кнопки-варианта после bot-message, клик = auto-send.
type BackupChannel = { id: string; name: string; url: string; hint: string };
// Eugene 2026-05-18 Босс «чат → окно генерации». payload приходит от
// /api/muza/chat когда Муза вставила [PROPOSE_GEN:...] маркер.
type ProposedGeneration = {
  mode: "audio" | "simple" | "full";
  style?: string;
  voice?: "female" | "male" | "duet" | "instrumental";
  lyrics?: string;
  reason: string;
};
// Eugene 2026-05-18 Босс «Муза сохраняет тексты — если не залогинен, предлагает
// регистрацию». Бэкенд парсит [PROPOSE_REGISTER:reason=X] из реплики Музы
// и кладёт payload сюда. Если save_user_lyrics ранее вернул needsAuth — title/
// text идут вместе с reason (сессионный pending).
type ProposedRegistration = {
  reason: "save_lyrics" | "save_draft" | "view_my_tracks" | "history";
  lyricsTitle?: string;
  lyricsText?: string;
  message?: string;
};
// Eugene 2026-05-21 Босс Chat-tool-calling MVP. pendingApproval — LLM вызвал
// платный tool (generate_lyrics / create_music_job и т.п.) без confirm_spend;
// backend вернул approval_required. Фронт рендерит карточку «Стоит X ₽,
// подтвердить?» + кнопки [Да] / [Отмена]. По «Да» — клиент шлёт «Да,
// подтверждаю генерацию» и LLM повторяет tool с confirm_spend=true.
type PendingApproval = {
  tool: string;
  estimated_cost_kopecks: number;
  estimated_cost_label: string;
  user_balance_label?: string;
  user_bonus_tracks?: number;
  params_preview?: any;
  message: string;
};
// attachedJob — генерация юзера (music/lyrics/cover) созданная через chat-tool.
// Если type='music' и status='processing' — frontend polling GET
// /api/generations/:id/status каждые 7 сек до status='done' или 'error'.
// Когда done — показываем audio_url + cover.
type AttachedJob = {
  jobId: number;
  type: "music" | "lyrics" | "cover" | string;
  status: "processing" | "done" | "error" | "cancelled" | string;
  title: string;
  audioUrl: string | null;
  coverUrl: string | null;
  lyricsPreview: string | null;
  durationSec: number;
  errorReason: string | null;
};
type ChatMessage = {
  role: "user" | "bot";
  text: string;
  quickReplies?: string[];
  // Eugene 2026-05-17 Босс «резервные каналы». Если LLM упал, бот ставит
  // backupChannels в последнее сообщение, фронт рендерит баннер под текстом.
  backupChannels?: BackupChannel[];
  // Eugene 2026-05-18 Босс «чат → окно генерации с 3 кнопками».
  proposedGeneration?: ProposedGeneration;
  // Eugene 2026-05-18 Босс «inline-карточка регистрации» — Войти / Регистрация /
  // Дать email. Возникает когда Муза предложила сохранить текст анонимному юзеру.
  proposedRegistration?: ProposedRegistration;
  // Eugene 2026-05-20 Босс «мини-плеер в чате». Когда Муза вызвала
  // find_public_track и tool вернул hint=playNow:<id> — backend прикрепляет
  // attachedTrack к ответу. Фронт рендерит inline ChatTrackCard под текстом.
  attachedTrack?: ChatTrackCardData;
  // Eugene 2026-05-21 Босс Chat-tool-calling MVP.
  pendingApproval?: PendingApproval;
  attachedJob?: AttachedJob;
};

// Quick-reply chips — типичные первые сообщения чтобы юзер не залипал
// на пустом инпуте. Сменяются после первой реплики.
const CHAT_SUGGESTIONS = [
  "У меня день рождения у мамы 🎂",
  "Хочу песню в подарок другу",
  "Не знаю с чего начать",
  "Покажи примеры",
];

// Сериализация диалога для share-переслать другу.
function serializeChatForShare(msgs: ChatMessage[]): string {
  const lines = msgs.map(m => {
    const who = m.role === "user" ? "Я" : "🎀 Муза";
    return `${who}: ${m.text}`;
  });
  return `Разговор с Музой (MuzaAi)\n${"━".repeat(20)}\n${lines.join("\n\n")}\n${"━".repeat(20)}\n\nХочешь продолжить? Открой https://muzaai.ru и кликни на Музу.`;
}

// Linkify — превращает голые URL в кликабельные ссылки внутри текста.
function linkify(text: string): Array<{ text: string; href?: string }> {
  const parts: Array<{ text: string; href?: string }> = [];
  const re = /(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: m[0], href: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

function ensureClientSessionId(): string {
  try {
    let id = sessionStorage.getItem("_muzaChatSid") || localStorage.getItem("_muzaChatSid");
    if (!id) {
      id = Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
      sessionStorage.setItem("_muzaChatSid", id);
      localStorage.setItem("_muzaChatSid", id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 14);
  }
}

// Eugene 2026-05-18 Босс «мини-плеер в чат — управление треком прямо из чата».
// Использует existing persistent <audio> singleton (Persistent-audio-only rule
// в CLAUDE.md). Источник track-меты — window.__muziaiTrack, которую landing.tsx
// устанавливает в playTrack() (см. landing.tsx:866). Контролы prev/next эмитят
// CustomEvent 'muza-player-action' — landing.tsx уже слушает (см. landing.tsx:1075).
// Не нарушает single-audio rule (audio-bus продолжает работать) и
// persistent-audio-only rule (мы НЕ создаём new Audio — только читаем singleton).
type MiniPlayerTrack = {
  id?: number | string;
  title?: string;
  authorName?: string;
  imageUrl?: string;
  displayTitle?: string;
  prompt?: string;
};

function ChatMiniPlayer() {
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [track, setTrack] = useState<MiniPlayerTrack | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("muza-chat-mini-player-collapsed") === "1"; } catch { return false; }
  });

  // Attach к persistent <audio> singleton. Polling каждые 500мс для подхвата
  // случая когда audio создаётся ПОСЛЕ открытия чата (юзер запускает трек
  // когда мини-плеер уже отрендерен).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const tryAttach = () => {
      const a = getPersistentPlayerAudio();
      const t = ((window as any).__muziaiTrack || null) as MiniPlayerTrack | null;
      if (a) {
        setAudio(a);
        setPlaying(!a.paused);
        setCurrentTime(a.currentTime || 0);
        setDuration(a.duration || 0);
      }
      if (t) setTrack(t);
    };
    tryAttach();
    const iv = window.setInterval(tryAttach, 1000);
    return () => window.clearInterval(iv);
  }, []);

  // Subscribe к audio events (play/pause/timeupdate/loadedmetadata).
  useEffect(() => {
    if (!audio) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setCurrentTime(audio.currentTime || 0);
    const onMeta = () => setDuration(audio.duration || 0);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
    };
  }, [audio]);

  const togglePlay = useCallback(() => {
    if (!audio) return;
    try {
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    } catch {}
  }, [audio]);

  const dispatchAction = useCallback((action: "prev" | "next") => {
    try {
      window.dispatchEvent(new CustomEvent("muza-player-action", {
        detail: { action, payload: null },
      }));
    } catch {}
    // Eugene 2026-05-18 Босс «в чате плеер не переключает треки» — fallback
    // для страниц без landing/dashboard listener (например /admin, /music,
    // /track/:id). Eugene 2026-05-18 audit: race fix — сначала fetch (может
    // быть медленным), потом проверка audio.src (listener мог сработать за
    // время fetch). Это надёжнее фиксированного setTimeout 500ms.
    try {
      const a = audio;
      if (!a || !a.src) return;
      const startSrc = a.src;
      (async () => {
        try {
          // Дать time для listener'а на landing/dashboard сначала (250ms)
          await new Promise(r => setTimeout(r, 250));
          if (a.src !== startSrc) return; // listener уже сработал
          const r = await fetch('/api/playlist?status=main&sort=date&dir=desc&_=' + Date.now(), { cache: 'no-store' });
          // Повторно проверить после fetch (listener мог сработать за это время)
          if (a.src !== startSrc) return;
          const data = await r.json();
          const list = (Array.isArray(data) ? data : []).filter((t: any) => t.type === 'music' && t.audioUrl);
          if (list.length === 0) return;
          const idx = list.findIndex((t: any) =>
            startSrc.includes(t.audioUrl) || startSrc.endsWith(`/api/stream/${t.id}`)
          );
          const safeIdx = idx < 0 ? 0 : idx;
          const targetIdx = action === "next"
            ? (safeIdx + 1) % list.length
            : (safeIdx > 0 ? safeIdx - 1 : list.length - 1);
          const target = list[targetIdx];
          if (target?.audioUrl && a.src === startSrc) {
            // Final check перед switch — listener мог сработать
            const mod = await import("@/lib/lockscreen");
            mod.loadTrackIntoPlayer(a, target.audioUrl);
            a.play().catch(() => {});
          }
        } catch {}
      })();
    } catch {}
  }, [audio]);

  const onSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!audio || !duration) return;
    try {
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * duration;
      setCurrentTime(audio.currentTime);
    } catch {}
  }, [audio, duration]);

  const toggleCollapse = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("muza-chat-mini-player-collapsed", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  if (!track) return null;
  const title = track.displayTitle || track.title || track.prompt?.slice(0, 60) || "Без названия";
  const author = track.authorName || "";
  const cover = track.imageUrl;
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Collapsed mode — маленький badge «▶ Сейчас играет».
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggleCollapse}
        className="flex items-center gap-2 px-3 py-1.5 border-t border-white/[0.06] bg-background/40 shrink-0 hover:bg-white/[0.04] transition-colors text-left w-full"
        title="Развернуть мини-плеер"
        aria-label="Развернуть мини-плеер"
      >
        <span className={`text-[12px] ${playing ? "text-fuchsia-300" : "text-white/60"}`}>
          {playing ? "▶" : "⏸"}
        </span>
        <span className="text-[11px] text-white/70 truncate flex-1">
          {playing ? "Сейчас играет: " : "Пауза: "}{title}
        </span>
        <span className="text-[10px] text-white/40 shrink-0">▾</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-t border-white/[0.06] bg-background/40 shrink-0" role="region" aria-label="Мини-плеер">
      {cover ? (
        <img src={cover} alt="" className="w-9 h-9 rounded-md object-cover shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
      ) : (
        <div className="w-9 h-9 rounded-md bg-gradient-to-br from-purple-500/30 to-blue-500/20 shrink-0 flex items-center justify-center text-[14px]">🎵</div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-white/85 truncate font-medium">{title}</div>
        {author && <div className="text-[9px] text-white/40 truncate">{author}</div>}
        <div
          className="h-1 bg-white/10 rounded-full mt-1 cursor-pointer hover:bg-white/15 transition-colors"
          onClick={onSeek}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={duration || 100}
          aria-valuenow={currentTime}
          title={duration ? `${Math.floor(currentTime)} / ${Math.floor(duration)} сек` : undefined}
        >
          <div className="h-full bg-gradient-to-r from-fuchsia-400/70 to-purple-400/70 rounded-full transition-all" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <button
        type="button"
        onClick={() => dispatchAction("prev")}
        className="w-7 h-7 rounded-full hover:bg-white/[0.08] text-white/70 hover:text-white text-[12px] flex items-center justify-center shrink-0"
        title="Предыдущий"
        aria-label="Предыдущий трек"
      >⏮</button>
      <button
        type="button"
        onClick={togglePlay}
        className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500/30 to-blue-500/20 hover:from-purple-500/50 hover:to-blue-500/40 border border-purple-400/30 text-white text-[12px] flex items-center justify-center shrink-0"
        title={playing ? "Пауза" : "Воспроизведение"}
        aria-label={playing ? "Пауза" : "Воспроизведение"}
      >{playing ? "⏸" : "▶"}</button>
      <button
        type="button"
        onClick={() => dispatchAction("next")}
        className="w-7 h-7 rounded-full hover:bg-white/[0.08] text-white/70 hover:text-white text-[12px] flex items-center justify-center shrink-0"
        title="Следующий"
        aria-label="Следующий трек"
      >⏭</button>
      <button
        type="button"
        onClick={toggleCollapse}
        className="w-6 h-6 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/70 text-[10px] flex items-center justify-center shrink-0"
        title="Свернуть мини-плеер"
        aria-label="Свернуть мини-плеер"
      >▴</button>
    </div>
  );
}

export function FloatingConsultant() {
  // Eugene 2026-05-19 — global feature toggle (см. /lib/featureToggles).
  // ВАЖНО: hook вызываем безусловно (React hooks rule), а ранний return
  // делаем после остальных state — иначе порядок hooks меняется между renders.
  const featureEnabled = useFeatureEnabled("floating-consultant");
  // Eugene 2026-05-19 Босс «не должно быть 2 одновременно». Когда маленькая
  // Муза-mouse-follow активна — большая FAB прячется.
  const [mouseFollowActive, setMouseFollowActive] = useState(false);
  useEffect(() => {
    const onStart = () => setMouseFollowActive(true);
    const onEnd = () => setMouseFollowActive(false);
    window.addEventListener("musa-mouse-follow-start", onStart as EventListener);
    window.addEventListener("musa-mouse-follow-end", onEnd as EventListener);
    return () => {
      window.removeEventListener("musa-mouse-follow-start", onStart as EventListener);
      window.removeEventListener("musa-mouse-follow-end", onEnd as EventListener);
    };
  }, []);
  // Eugene 2026-05-20 Босс: универсальное позиционирование Музы.
  // - Реальные размеры (96×144 mobile, 112×192 desktop) — изображение не обрезалось
  // - iOS safe-area-inset-bottom (home indicator)
  // - При открытом чате на mobile — поднимаемся над окном чата
  // - Recompute при resize / orientationchange / chatOpen toggle
  const getFabSize = () => {
    const isMobile = typeof window !== "undefined" && window.innerWidth < 640;
    return { w: isMobile ? 96 : 112, h: isMobile ? 144 : 192 };
  };
  const FAB_DRAG_KEY = "consultant-fab-position";
  const userPositionedRef = useRef<boolean>(typeof window !== "undefined" && readPos(FAB_DRAG_KEY) !== null);
  const computeFabPos = () => {
    if (typeof window === "undefined") return { x: 100, y: 100 };
    const { w: fabW, h: fabH } = getFabSize();
    // Если юзер уже двигал — используем сохранённую позицию (clamped в viewport).
    const saved = readPos(FAB_DRAG_KEY);
    if (saved) return clampToViewport(saved.x, saved.y, fabW, fabH);
    const isMobile = window.innerWidth < 640;
    // iOS safe-area через probe-element + env(safe-area-inset-bottom)
    let safeBottom = 16;
    try {
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;bottom:0;padding-bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none;";
      document.body.appendChild(probe);
      const pad = parseInt(getComputedStyle(probe).paddingBottom, 10) || 0;
      safeBottom = Math.max(16, pad + 8);
      document.body.removeChild(probe);
    } catch {}
    // chatOpen+mobile: chat drawer занимает ~60vh снизу — поднимаем Музу над ним
    const isChatOpen = (window as any).__muzaChatOpen === true;
    const chatLifted = isChatOpen && isMobile ? Math.round(window.innerHeight * 0.62) : 0;
    const x = Math.max(8, window.innerWidth - fabW - 8);
    const y = Math.max(8, window.innerHeight - fabH - safeBottom - chatLifted);
    return { x, y };
  };
  const [fabPos, setFabPos] = useState(computeFabPos);
  // Eugene 2026-05-21 Босс «куклу можно перемещать пальцем + соображает,
  // убегает если мешает полю юзера». Long-press 350ms → drag-mode.
  // touch-action: none во время drag (W3C Pointer Events Level 2 §6).
  const [dragMode, setDragMode] = useState(false);
  const dragModeRef = useRef(false);
  const fabDragStartRef = useRef<{ px: number; py: number; fx: number; fy: number; pointerId: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  // Eugene 2026-05-21 Босс — auto-avoidance. При overlap с focused input/textarea
  // Музa убегает в свободный угол. autoMoved=true чтобы не перетирать user position
  // когда юзер ушёл с поля (через 5 сек возвращаемся).
  const lastAutoMoveRef = useRef<number>(0);
  const userPositionBeforeAutoMoveRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onResize = () => setFabPos(computeFabPos());
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  // Eugene 2026-05-21: автоматическое уворачивание от focused input.
  // Раз в 500ms проверяем — если активный элемент это input/textarea/contenteditable
  // И Музa overlap'ает с его расширенным рамкой rect — летим в дальний свободный угол.
  // После того как юзер ушёл с поля (no focus), через 5 сек возвращаемся обратно.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const interval = setInterval(() => {
      if (dragModeRef.current) return; // юзер тащит — не вмешиваемся
      const { w: fabW, h: fabH } = getFabSize();
      const active = document.activeElement as HTMLElement | null;
      const isInputLike = !!active && active !== document.body && (
        active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.tagName === "SELECT" ||
        active.getAttribute("contenteditable") === "true" ||
        active.getAttribute("role") === "textbox"
      );
      if (!isInputLike) {
        // Никто не редактирует — если мы автомувнули раньше, возвращаемся к юзер-позиции
        if (userPositionBeforeAutoMoveRef.current && Date.now() - lastAutoMoveRef.current > 5000) {
          const back = userPositionBeforeAutoMoveRef.current;
          userPositionBeforeAutoMoveRef.current = null;
          setFabPos(clampToViewport(back.x, back.y, fabW, fabH));
        }
        return;
      }
      const activeRect = active!.getBoundingClientRect();
      // Игнорируем крошечные элементы (likely невидимый focus)
      if (activeRect.width < 40 || activeRect.height < 16) return;
      const margin = 32;
      const expanded = {
        left: activeRect.left - margin,
        top: activeRect.top - margin,
        right: activeRect.right + margin,
        bottom: activeRect.bottom + margin,
      };
      const musaRect = {
        left: fabPos.x, top: fabPos.y,
        right: fabPos.x + fabW, bottom: fabPos.y + fabH,
      };
      const overlaps = !(
        musaRect.right < expanded.left ||
        musaRect.left > expanded.right ||
        musaRect.bottom < expanded.top ||
        musaRect.top > expanded.bottom
      );
      if (!overlaps) return;
      // Найти свободный угол — дальше всего от центра active rect и не overlap.
      const cx = (activeRect.left + activeRect.right) / 2;
      const cy = (activeRect.top + activeRect.bottom) / 2;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const candidates = [
        { x: 8, y: 8 },                              // top-left
        { x: W - fabW - 8, y: 8 },                   // top-right
        { x: 8, y: H - fabH - 8 },                   // bottom-left
        { x: W - fabW - 8, y: H - fabH - 8 },        // bottom-right
      ];
      const freeCorners = candidates
        .map(c => ({
          ...c,
          dist: Math.hypot(c.x + fabW / 2 - cx, c.y + fabH / 2 - cy),
          free: !(
            c.x + fabW < expanded.left || c.x > expanded.right ||
            c.y + fabH < expanded.top || c.y > expanded.bottom
          ),
        }))
        .filter(c => c.free)
        .sort((a, b) => b.dist - a.dist);
      const target = freeCorners[0] || candidates[3];
      // Запоминаем текущую (юзер-) позицию для возврата после
      if (!userPositionBeforeAutoMoveRef.current) {
        userPositionBeforeAutoMoveRef.current = { ...fabPos };
      }
      lastAutoMoveRef.current = Date.now();
      const clamped = clampToViewport(target.x, target.y, fabW, fabH);
      setFabPos(clamped);
    }, 500);
    return () => clearInterval(interval);
  }, [fabPos.x, fabPos.y]);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Eugene 2026-05-20 Босс: pinch-to-expand + drag-to-expand на Музе.
  // Pinch (2 пальца раздвигаются ≥50px) → expand. Drag (1 палец/курсор
  // от FAB на ≥60px) → expand. Возврат жеста — collapse. Click тоже работает.
  const pinchStartDistRef = useRef<number | null>(null);
  const expandDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragExpandedRef = useRef(false);
  const [reaction, setReaction] = useState<string | null>(null);
  const reactionIdxRef = useRef(0);
  const reactionTimerRef = useRef<number | null>(null);
  const dismissedRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  // === Inline chat (Eugene 2026-05-14 Босс) ===
  const [chatOpen, setChatOpen] = useState(false);
  // Eugene 2026-05-18 Босс «Муза ходит по сайту». Шлём событие в окно когда
  // chat-pane открыт/закрыт — WalkingMusa компонент слушает и не запускает
  // тур пока пользователь в чате. Простой event-bus через window CustomEvent
  // (без зависимостей).
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(chatOpen ? "musa-chat-open" : "musa-chat-close"));
    // Eugene 2026-05-20 Босс: при открытии чата на mobile поднять Музу над окном.
    // Используем global flag — computeFabPos читает его при пересчёте.
    (window as any).__muzaChatOpen = chatOpen;
    setFabPos(computeFabPos());
    // Eugene 2026-05-20 Босс «когда чат раскрывается на смартфоне облачко
    // убирай одновременно» — force collapse expanded когда chat открывается.
    // Гарантия что меню-облачко не перекрывает chat drawer (любой путь
    // открытия, не только openChat()).
    if (chatOpen) setExpanded(false);
  }, [chatOpen]);
  const [chatMsgs, setChatMsgs] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  // Eugene 2026-05-18 Босс «убери облака с подсказками, но оставь в чате
  // кнопку с возможностью их появления». Default false — пустой чат без
  // подсказок. Юзер нажимает «💡 Подсказки» — появляются 4-5 chips.
  const [showSuggestions, setShowSuggestions] = useState(false);
  // Eugene 2026-05-18 Босс «в чате только аватар Музы». chatPersona не отображается
  // в UI (имя/avatar персоны = внутренняя стратегия), но state сохраняем для совместимости
  // с историческими сессиями — никакой setter'ный код в UI его не читает.
  const [chatPersona, _setChatPersona] = useState<{ name: string; avatar: string } | null>(null);
  void chatPersona;
  const setChatPersona = _setChatPersona;
  const [chatPaired, setChatPaired] = useState<{ channel: string } | null>(null);
  // Eugene 2026-05-14 Босс «таблица с автором характеристик над чатом».
  // Хранит memory extracted backend'ом (имя/повод/кому/стиль/голос/настроение).
  const [chatMemo, setChatMemo] = useState<Record<string, string | undefined>>({});
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatInitialized = useRef(false);
  // Eugene 2026-05-14 Босс «3-4 сообщения видны + кнопка раскрыть 2+ раз».
  // visibleCount растёт пошагово при клике «показать больше».
  const [visibleCount, setVisibleCount] = useState(4);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  // Eugene 2026-05-14 Босс «зарегистрироваться открывает меню».
  const [registerMenuOpen, setRegisterMenuOpen] = useState(false);
  // Eugene 2026-05-17 Босс «кнопка техподдержка → муза бот».
  const [supportOpen, setSupportOpen] = useState(false);
  // Eugene 2026-05-14 Босс «при нажатии на левую часть по вертикали можно
  // перемещать. Углы возвращают в центр». Snap-positions для chat drawer.
  const [drawerSnap, setDrawerSnap] = useState<"br" | "bl" | "tr" | "tl" | "center">("br");
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  // Eugene 2026-05-18 Босс «звук сообщения в чате» — toggle 🔔/🔕 в header.
  // Минимальная реализация через Web Audio API oscillator (не нагружает
  // сеть, не зависит от mp3-файлов). Beep 800Hz × 100ms для нового сообщения
  // от Музы; 2-нотный chime (600→800Hz × 200ms) при первом open чата.
  // Persistent-audio-only rule: эти one-shot beeps не претендуют на
  // MediaSession (как TTS Музы и admin-preview audio), поэтому AudioContext
  // создаётся локально и не нарушает persistent player ownership.
  const SOUND_KEY = "muza-chat-sound";
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem(SOUND_KEY) === "1"; } catch { return false; }
  });
  const audioCtxRef = useRef<AudioContext | null>(null);
  const prevChatMsgsLenRef = useRef(0);
  const chatOpenSoundPlayedRef = useRef(false);

  function getAudioCtx(): AudioContext | null {
    try {
      if (!audioCtxRef.current) {
        const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
        if (!Ctor) return null;
        audioCtxRef.current = new Ctor();
      }
      return audioCtxRef.current;
    } catch { return null; }
  }

  function playBeep(freq: number, durationSec: number, startOffsetSec = 0) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime + startOffsetSec;
      gain.gain.setValueAtTime(0.08, t0);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + durationSec);
      osc.start(t0);
      osc.stop(t0 + durationSec);
    } catch { /* ignore */ }
  }

  function playMessageBeep() { playBeep(800, 0.12); }
  function playChatOpenChime() {
    playBeep(600, 0.14, 0);
    playBeep(800, 0.18, 0.12);
  }

  // Persist toggle to localStorage
  useEffect(() => {
    try { localStorage.setItem(SOUND_KEY, soundEnabled ? "1" : "0"); } catch {}
  }, [soundEnabled]);

  // Eugene 2026-05-18 Босс «диагональная стрелка resize, гибко без фиксированных
  // размеров, ~50% screen. Mobile — не нужно». Custom resize пользователем,
  // сохраняется в localStorage (TTL 30 дней). null → responsive default.
  // На mobile (max-width 640px) — resize отключён, размеры контролит CSS.
  const CHAT_SIZE_KEY = "muza-chat-size";
  const CHAT_SIZE_TTL_MS = 30 * 24 * 3_600_000;
  const [chatSize, setChatSize] = useState<{ w: number; h: number } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  // visible snap-target during resize (для glow на handle при близости к 30/50/70%)
  const [resizeSnapTarget, setResizeSnapTarget] = useState<number | null>(null);
  const resizeStartRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  // mobile detector — recheck on resize так как iPad может крутиться
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return window.matchMedia("(max-width: 640px)").matches; } catch { return false; }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 640px)");
    const onChange = () => setIsMobile(mql.matches);
    try { mql.addEventListener("change", onChange); } catch { mql.addListener(onChange); }
    return () => {
      try { mql.removeEventListener("change", onChange); } catch { mql.removeListener(onChange); }
    };
  }, []);
  // Hydrate from localStorage on first chat open. TTL 30 дней — устаревший
  // снапшот считаем дефолтом (юзер давно не пользовался).
  useEffect(() => {
    if (!chatOpen || chatSize !== null || isMobile) return;
    try {
      const raw = localStorage.getItem(CHAT_SIZE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { w?: number; h?: number; ts?: number };
      if (!parsed?.w || !parsed?.h) return;
      if (parsed.ts && Date.now() - parsed.ts > CHAT_SIZE_TTL_MS) {
        try { localStorage.removeItem(CHAT_SIZE_KEY); } catch {}
        return;
      }
      // Clamp по текущему viewport (если экран стал меньше с прошлой сессии)
      const maxW = Math.floor(window.innerWidth * 0.9);
      const maxH = Math.floor(window.innerHeight * 0.85);
      setChatSize({
        w: Math.min(Math.max(320, parsed.w), maxW),
        h: Math.min(Math.max(400, parsed.h), maxH),
      });
    } catch {}
  }, [chatOpen, chatSize, isMobile]);

  // Resize pointer handlers — drag from верхне-левого угла chat panel.
  // delta = startPos - currentPos (resize к верхне-левому → drag влево/вверх увеличивает).
  // Snap zones 30% / 50% / 70% (магнит ±20px по ширине).
  const handleResizeMove = useCallback((e: PointerEvent) => {
    const start = resizeStartRef.current;
    if (!start) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minW = 320, minH = 400;
    const maxW = Math.floor(vw * 0.9);
    const maxH = Math.floor(vh * 0.85);
    let newW = start.w + (start.x - e.clientX);
    let newH = start.h + (start.y - e.clientY);
    // Snap по ширине — близость к 30/50/70% viewport.
    const targets = [0.3, 0.5, 0.7];
    let snappedTarget: number | null = null;
    for (const t of targets) {
      const target = vw * t;
      if (Math.abs(newW - target) < 20) {
        newW = target;
        snappedTarget = t;
        break;
      }
    }
    newW = Math.max(minW, Math.min(maxW, newW));
    newH = Math.max(minH, Math.min(maxH, newH));
    setChatSize({ w: Math.round(newW), h: Math.round(newH) });
    setResizeSnapTarget(snappedTarget);
  }, []);
  const handleResizeEnd = useCallback((e: PointerEvent) => {
    setIsResizing(false);
    setResizeSnapTarget(null);
    resizeStartRef.current = null;
    try { (e.target as Element)?.releasePointerCapture?.(e.pointerId); } catch {}
    window.removeEventListener("pointermove", handleResizeMove);
    window.removeEventListener("pointerup", handleResizeEnd);
    window.removeEventListener("pointercancel", handleResizeEnd);
    // Persist
    try {
      // setChatSize is async but the latest value is in state; read fresh from DOM via
      // setChatSize wrapper inside move. Здесь читаем актуальное значение через
      // setChatSize(prev => prev) trick.
      setChatSize((prev) => {
        if (prev) {
          try {
            localStorage.setItem(CHAT_SIZE_KEY, JSON.stringify({ w: prev.w, h: prev.h, ts: Date.now() }));
          } catch {}
        }
        return prev;
      });
    } catch {}
  }, [handleResizeMove]);
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    if (isMobile) return;
    e.preventDefault();
    e.stopPropagation();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Если ещё нет custom size — стартуем с фактических габаритов panel.
    // Для desktop default ~50% × 60%, для iPad ~70% × 70%.
    const baseW = chatSize?.w ?? (vw >= 1024 ? Math.floor(vw * 0.5) : Math.floor(vw * 0.7));
    const baseH = chatSize?.h ?? (vw >= 1024 ? Math.floor(vh * 0.6) : Math.floor(vh * 0.7));
    resizeStartRef.current = { x: e.clientX, y: e.clientY, w: baseW, h: baseH };
    setIsResizing(true);
    try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch {}
    window.addEventListener("pointermove", handleResizeMove);
    window.addEventListener("pointerup", handleResizeEnd);
    window.addEventListener("pointercancel", handleResizeEnd);
  }, [chatSize, isMobile, handleResizeMove, handleResizeEnd]);

  // Eugene 2026-05-17 Босс: smart-триггер Музы по journey-событиям.
  // Когда юзер «долго думает» (idle 30 сек, form_abandon, scroll и не клик'нул
  // CTA на лендинге) — Муза появляется со speech-bubble подсказкой,
  // соответствующей контексту страницы.
  // smartBubbleText — кастомный текст подсказки (вместо стандартного «Заходи в
  // чат — креативить»). smartHighlight — анимация attention (slight bounce +
  // glow) если Муза уже видна.
  const [smartBubbleText, setSmartBubbleText] = useState<string | null>(null);
  const [smartHighlight, setSmartHighlight] = useState(false);
  // Once-per-session флаги для каждого триггера (не спамим юзера).
  const smartFiredRef = useRef<Set<string>>(new Set());
  // Время старта сессии на текущей странице — для «90 сек без play» триггера.
  const pageEnteredAtRef = useRef<number>(Date.now());
  const pageHadPlayRef = useRef<boolean>(false);

  // Авто-скролл вниз при новом сообщении
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMsgs.length]);

  // Eugene 2026-05-18 Босс «звук сообщения» — beep при новом bot-сообщении
  // если soundEnabled и chat открыт. Сравниваем длину с предыдущей, чтобы
  // beep'ом не было на каждый mount/initial-load.
  useEffect(() => {
    const prevLen = prevChatMsgsLenRef.current;
    const curLen = chatMsgs.length;
    if (soundEnabled && chatOpen && curLen > prevLen && curLen > 0) {
      const last = chatMsgs[curLen - 1];
      if (last && last.role === "bot") {
        playMessageBeep();
      }
    }
    prevChatMsgsLenRef.current = curLen;
    // playMessageBeep — stable function (closure over refs); soundEnabled
    // intentionally в deps чтобы при toggle beep сразу заработал/перестал.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMsgs, soundEnabled, chatOpen]);

  // Chime при первом open чата (один раз за session).
  useEffect(() => {
    if (chatOpen && soundEnabled && !chatOpenSoundPlayedRef.current) {
      chatOpenSoundPlayedRef.current = true;
      playChatOpenChime();
    }
    if (!chatOpen) chatOpenSoundPlayedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen, soundEnabled]);

  const initChatSession = useCallback(async () => {
    try {
      const sid = ensureClientSessionId();
      // Eugene 2026-05-21 Босс «изучи документацию, реши 100%»:
      // Через wouter hash-router URL формата https://muzaai.ru/#/pair/CODE
      // (hash НЕ отправляется на сервер — 100% gardener'я от 404).
      // Reading: window.location.hash → "#/pair/CODE" → match.
      // Backward-compat: ?pair= в search тоже читаем (legacy ссылки).
      let pairCode: string | undefined;
      try {
        const hashMatch = window.location.hash.match(/^#\/pair\/([\w-]{3,32})/);
        if (hashMatch && hashMatch[1]) {
          pairCode = hashMatch[1];
          // Чистим hash чтобы повторный F5 не дёргал pair заново
          window.history.replaceState({}, "", window.location.pathname + window.location.search + "#/");
        } else {
          const params = new URLSearchParams(window.location.search);
          const p = params.get("pair");
          if (p && p.length >= 3 && p.length <= 32) {
            pairCode = p;
            params.delete("pair");
            const newQuery = params.toString();
            const newUrl = window.location.pathname + (newQuery ? "?" + newQuery : "") + window.location.hash;
            window.history.replaceState({}, "", newUrl);
          }
        }
      } catch {}
      const r = await fetch("/api/muza/chat/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, ...(pairCode ? { pairCode } : {}) }),
      });
      const j = await r.json();
      if (j?.ok) {
        if (j.persona) setChatPersona(j.persona);
        if (j.paired) setChatPaired({ channel: j.pairedFromChannel });
        const hist: ChatMessage[] = Array.isArray(j.history)
          ? j.history.map((h: any) => {
              const msg: ChatMessage = { role: h.role === "bot" ? "bot" : "user", text: h.text };
              // Eugene 2026-05-20 Босс «мини-плеер в чате»: history-сообщения
              // с attachedTrack — рендерим без autoPlay (юзер сам нажмёт Play).
              if (
                h.attachedTrack &&
                typeof h.attachedTrack === "object" &&
                typeof h.attachedTrack.id === "number" &&
                typeof h.attachedTrack.audioUrl === "string"
              ) {
                msg.attachedTrack = {
                  id: h.attachedTrack.id,
                  title: String(h.attachedTrack.title || "").slice(0, 200) || "Без названия",
                  authorName: typeof h.attachedTrack.authorName === "string" ? h.attachedTrack.authorName : null,
                  audioUrl: String(h.attachedTrack.audioUrl).slice(0, 500),
                  coverUrl: typeof h.attachedTrack.coverUrl === "string" ? h.attachedTrack.coverUrl : undefined,
                  durationSec: typeof h.attachedTrack.durationSec === "number" ? h.attachedTrack.durationSec : 0,
                };
              }
              return msg;
            })
          : [];
        // Eugene 2026-05-14 Босс «паузы как человек». Greeting показываем
        // СРАЗУ (юзер только что открыл, ждёт сразу), а quickReplies — через
        // паузу 1-1.5 сек чтобы юзер успел прочитать.
        const greetingText = String(j.greeting || "Привет!");
        const qrList = Array.isArray(j.quickReplies) && j.quickReplies.length > 0 ? j.quickReplies : undefined;
        const greeting: ChatMessage = { role: "bot", text: greetingText };
        setChatMsgs([...hist, greeting]);
        if (j.memo) setChatMemo(j.memo);
        if (qrList) {
          const qrDelay = 1000 + Math.floor(Math.random() * 600);
          window.setTimeout(() => {
            setChatMsgs(m => {
              if (m.length === 0) return m;
              const last = m[m.length - 1];
              if (last.role === "bot" && last.text === greetingText && !last.quickReplies) {
                return [...m.slice(0, -1), { ...last, quickReplies: qrList }];
              }
              return m;
            });
          }, qrDelay);
        }
      }
    } catch {
      setChatMsgs([{ role: "bot", text: "Что-то с сетью — но я тут. Пробуй ещё раз через секунду 🎵" }]);
    }
  }, []);

  const openChat = useCallback(async () => {
    // Eugene 2026-05-14 Босс «после уходу скоро вернусь — ещё один чат».
    // Idempotent — если уже открыт, не переоткрываем (избегаем дубль-анимации).
    if (chatOpen) return;
    try { playMuzaSparkle(); } catch {}
    setExpanded(false);
    setChatOpen(true);
    trackEngagement("consultant_action", { action: "open_chat" });
    if (chatInitialized.current) return;
    chatInitialized.current = true;
    await initChatSession();
  }, [initChatSession, chatOpen]);

  // Eugene 2026-05-21 Босс: pair-link auto-open. Hash-format (primary) +
  // query (legacy fallback). При detection — setVisible + openChat(200ms).
  useEffect(() => {
    try {
      const hashHasPair = /^#\/pair\/[\w-]{3,32}/.test(window.location.hash);
      const queryHasPair = !!new URLSearchParams(window.location.search).get("pair");
      if (hashHasPair || queryHasPair) {
        setVisible(true);
        setTimeout(() => { openChat(); }, 200);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Eugene 2026-05-18 Босс «в кабинете автора иконочка Музы под папочкой —
  // открывает историю взаимодействия. Юзер может в любое время зайти и
  // продолжить разговор». Dashboard секция MusaHistorySection шлёт
  // CustomEvent `musa-continue-session` → этот callback подхватывает
  // указанный sessionId, грузит full history через REST, set chatMsgs и
  // openChat(). Если sessionId совпадает с текущим — просто открываем чат.
  const continueWithSession = useCallback(async (newSessionId: string) => {
    if (!newSessionId) return;
    try { playMuzaSparkle(); } catch {}
    // Сменить локальный sessionId — следующий /api/muza/chat будет в этой сессии.
    try {
      sessionStorage.setItem("_muzaChatSid", newSessionId);
      localStorage.setItem("_muzaChatSid", newSessionId);
    } catch {}
    // Сброс UI-state предыдущего разговора.
    setVisibleCount(40);
    setChatPaired(null);
    setChatMemo({});
    // Загружаем full history конкретной сессии.
    try {
      const r = await fetch(`/api/user/musa-history/${encodeURIComponent(newSessionId)}`, {
        credentials: "include",
      });
      const j = await r.json();
      const data = j?.data;
      if (data?.messages && Array.isArray(data.messages)) {
        const msgs: ChatMessage[] = data.messages.map((m: any) => {
          const msg: ChatMessage = {
            role: m.role === "user" ? "user" : "bot",
            text: String(m.text || ""),
          };
          // Eugene 2026-05-20 Босс «мини-плеер в чате»: history musa-session
          // тоже содержит attachedTrack для bot-сообщений с прикрепленным треком.
          if (
            m.attachedTrack &&
            typeof m.attachedTrack === "object" &&
            typeof m.attachedTrack.id === "number" &&
            typeof m.attachedTrack.audioUrl === "string"
          ) {
            msg.attachedTrack = {
              id: m.attachedTrack.id,
              title: String(m.attachedTrack.title || "").slice(0, 200) || "Без названия",
              authorName: typeof m.attachedTrack.authorName === "string" ? m.attachedTrack.authorName : null,
              audioUrl: String(m.attachedTrack.audioUrl).slice(0, 500),
              coverUrl: typeof m.attachedTrack.coverUrl === "string" ? m.attachedTrack.coverUrl : undefined,
              durationSec: typeof m.attachedTrack.durationSec === "number" ? m.attachedTrack.durationSec : 0,
            };
          }
          return msg;
        });
        setChatMsgs(msgs);
        if (data.session?.personaName) {
          setChatPersona({
            name: data.session.personaName,
            avatar: data.session.personaAvatar || "🎀",
          });
        }
      }
    } catch {
      // Не катастрофа — init создаст новую сессию с этим id.
      setChatMsgs([]);
    }
    // Помечаем chatInitialized чтобы openChat не дёргал initChatSession поверх.
    chatInitialized.current = true;
    setVisible(true);
    setExpanded(false);
    setChatOpen(true);
    trackEngagement("consultant_action", { action: "continue_session", sessionId: newSessionId });
  }, []);

  // Слушаем CustomEvent от dashboard MusaHistorySection.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onContinue = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
      const sid = detail?.sessionId;
      if (sid) continueWithSession(sid);
    };
    window.addEventListener("musa-continue-session", onContinue as EventListener);
    return () => window.removeEventListener("musa-continue-session", onContinue as EventListener);
  }, [continueWithSession]);

  // Eugene 2026-05-14 Босс: кнопка «начать новый разговор» — сбрасывает
  // локальный sessionId, backend создаёт новую session с чистой историей.
  // Полезно когда юзер видит остатки старого диалога (например после
  // переката fallback pool).
  const startFreshChat = useCallback(async () => {
    try {
      sessionStorage.removeItem("_muzaChatSid");
      localStorage.removeItem("_muzaChatSid");
    } catch {}
    setChatMsgs([]);
    setChatPaired(null);
    setChatMemo({});
    setVisibleCount(4);
    chatInitialized.current = false;
    chatInitialized.current = true;
    await initChatSession();
    trackEngagement("consultant_action", { action: "chat_reset" });
  }, [initChatSession]);

  // Eugene 2026-05-14 Босс «повторное нажатие учитывает изменение в дальнейшем
  // диалоге». QR-кнопки кликабельны на ЛЮБОМ bot-message в истории.
  // Backend extractMemoryFromHistory берёт ПОСЛЕДНЕЕ matching - перевыбор
  // обновляет memo и применяется в дальнейших ответах Музы.
  const sendQuickReply = useCallback((variant: string) => {
    setChatInput(variant);
    setTimeout(() => {
      doSendMessage(variant);
    }, 0);
  }, []);

  // Eugene 2026-05-18 Босс «чат → окно генерации». Когда юзер кликает по
  // одной из 3 кнопок в proposedGeneration-карточке — собираем URL
  // /#/music?mode=X[&style=Y][&voice=Z][&lyrics=W] и переходим. music.tsx
  // уже умеет читать эти query params и pre-fill форму (см. transferred
  // ветку с urlPrompt/urlLyrics/urlTitle/urlStyle/urlVoice).
  const openGenerationWithMode = useCallback((
    chosenMode: "audio" | "simple" | "full",
    pg: ProposedGeneration,
  ) => {
    // Маппим внутренний mode на ?mode= параметр music.tsx:
    //   audio   → audio (Аудио-вход)
    //   simple  → basic (Простой текст)
    //   full    → advanced (Расширенный, полный текст + параметры)
    const musicTabMode =
      chosenMode === "audio" ? "audio"
      : chosenMode === "simple" ? "basic"
      : "advanced";
    const params = new URLSearchParams();
    params.set("mode", musicTabMode);
    // Голос: female/male/duet/instrumental — music.tsx читает воспринимая
    // эти ключи в transferred.voiceType.
    if (pg.voice) params.set("voice", pg.voice);
    // Стиль pop/rock/lullaby/... — music.tsx ставит как initial style.
    if (pg.style) params.set("style", pg.style);
    // Lyrics для full-режима (для simple обычно нет, для audio тоже).
    if (pg.lyrics && chosenMode !== "audio") params.set("lyrics", pg.lyrics);
    // Engagement event — admin видит сколько раз карточка дала клик.
    try {
      let sid = sessionStorage.getItem("_engagementSid");
      if (!sid) { sid = Math.random().toString(36).slice(2, 14); sessionStorage.setItem("_engagementSid", sid); }
      fetch("/api/engagement/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "consultant_action",
          sessionId: sid,
          meta: { action: "propose_generation_click", chosen: chosenMode, suggested: pg.mode, reason: pg.reason },
        }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
    // Закрываем чат на mobile — юзер уезжает в форму
    setExpanded(false);
    setChatOpen(false);
    window.location.hash = `#/music?${params.toString()}`;
  }, []);

  // Eugene 2026-05-18 Босс «inline-карточка регистрации».
  // State для UI inline-card: ключ = индекс сообщения в chatMsgs (stable пока
  // не reset чата). Хранит режим (idle | email-input | sent), email-черновик и
  // успешный код восстановления (показывается с кнопкой «Скопировать»).
  type RegCardState = {
    mode: "idle" | "email" | "sending" | "sent";
    email: string;
    code?: string;
    emailSent?: boolean;
    error?: string;
  };
  const [regCards, setRegCards] = useState<Record<number, RegCardState>>({});
  const updateRegCard = useCallback((idx: number, patch: Partial<RegCardState>) => {
    setRegCards(prev => ({ ...prev, [idx]: { ...(prev[idx] || { mode: "idle", email: "" }), ...patch } }));
  }, []);
  // Engagement-tracker для кликов по inline-карточке регистрации.
  // chosen: 'login' | 'register' | 'email_open' | 'email_send' | 'copy_code'.
  const trackRegClick = useCallback((chosen: string, meta?: Record<string, any>) => {
    try {
      let sid = sessionStorage.getItem("_engagementSid");
      if (!sid) { sid = Math.random().toString(36).slice(2, 14); sessionStorage.setItem("_engagementSid", sid); }
      fetch("/api/engagement/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "consultant_action",
          sessionId: sid,
          meta: { action: "propose_registration_click", chosen, ...(meta || {}) },
        }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }, []);

  // Eugene 2026-05-18 Босс «после клика — переход в /login или /register».
  // Если в localStorage есть прошлый email — подсветка опции «Войти».
  const lastLoginEmail = useCallback((): string | null => {
    try {
      return localStorage.getItem("_lastLoginEmail") || null;
    } catch { return null; }
  }, []);

  const openRegistrationAction = useCallback((
    chosen: "login" | "register",
    pr: ProposedRegistration,
  ) => {
    trackRegClick(chosen, { reason: pr.reason });
    // Если есть pending lyrics — сохраняем в sessionStorage для recovery после
    // регистрации (через `/register?recovery_lyrics=1` страница может прочитать).
    if (pr.lyricsTitle && pr.lyricsText) {
      try {
        sessionStorage.setItem("_pendingLyrics", JSON.stringify({
          title: pr.lyricsTitle,
          text: pr.lyricsText,
          savedAt: Date.now(),
        }));
      } catch {}
    }
    setExpanded(false);
    setChatOpen(false);
    if (chosen === "login") {
      window.location.hash = "#/login";
    } else {
      // recovery_lyrics=1 — флаг что после регистрации надо auto-claim текст
      // из sessionStorage._pendingLyrics через /api/lyrics/save.
      window.location.hash = "#/register?recovery_lyrics=1";
    }
  }, [trackRegClick]);

  const sendAnonymousLyricsSave = useCallback(async (
    idx: number,
    pr: ProposedRegistration,
    email: string,
  ) => {
    const title = (pr.lyricsTitle || "").trim() || "Текст от Музы";
    const text = (pr.lyricsText || "").trim();
    // Если text не пришёл с сервера — не можем сохранить. Это редкий случай
    // (TTL pending lyrics истёк или save_user_lyrics не вызывался).
    if (!text || text.length < 5) {
      updateRegCard(idx, {
        mode: "idle",
        error: "Текст не найден в сессии — попроси Музу прислать его ещё раз",
      });
      return;
    }
    updateRegCard(idx, { mode: "sending", error: undefined });
    trackRegClick("email_send", { reason: pr.reason });
    try {
      const sid = ensureClientSessionId();
      const r = await fetch("/api/lyrics/anonymous-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, text, email, chatSessionId: sid }),
      });
      const j = await r.json();
      if (!r.ok || !j?.data) {
        const errMsg = j?.error || `Ошибка ${r.status}`;
        updateRegCard(idx, { mode: "email", error: errMsg });
        return;
      }
      try { localStorage.setItem("_lastLoginEmail", email); } catch {}
      updateRegCard(idx, {
        mode: "sent",
        code: String(j.data.code || ""),
        emailSent: !!j.data.emailSent,
        error: undefined,
      });
    } catch (e: any) {
      updateRegCard(idx, {
        mode: "email",
        error: e?.message?.includes("Failed to fetch") ? "Сеть подвисла, попробуй ещё раз" : "Не удалось отправить",
      });
    }
  }, [trackRegClick, updateRegCard]);

  // Eugene 2026-05-14 Босс «плавно общаться, ответы проявлять в 2 раза
  // медленнее. Ускорять если человек ускоряется». ADAPTIVE timing:
  // - Базовый humanDelay в 2 раза медленнее (плавность).
  // - Если юзер пишет БЫСТРО (gap между сообщениями < 5 сек) — ускоряемся.
  const lastUserMsgAtRef = useRef<number>(0);
  const userPaceRef = useRef<"slow" | "fast">("slow");
  const humanDelay = useCallback((replyLen: number) => {
    // База 2400ms + 50ms на каждый символ, потолок 9000ms (медленно, плавно).
    const base = 2400;
    const perChar = 50;
    const maxMs = 9000;
    let delay = Math.min(maxMs, base + Math.floor(replyLen * perChar));
    // Если юзер ускорился — Муза тоже ускоряется (×0.5).
    if (userPaceRef.current === "fast") delay = Math.floor(delay * 0.5);
    return delay;
  }, []);

  // Выделил core-send в отдельную функцию чтобы вызывать с произвольным
  // text (для quick-reply без перезагрузки chatInput state).
  const doSendMessage = useCallback(async (textArg: string) => {
    const text = textArg.trim();
    if (!text) return;
    // Eugene 2026-05-14 Босс «ускорять если человек ускоряется». Меряем gap.
    const now = Date.now();
    const gap = lastUserMsgAtRef.current ? now - lastUserMsgAtRef.current : 0;
    if (gap > 0 && gap < 8_000) userPaceRef.current = "fast";
    else userPaceRef.current = "slow";
    lastUserMsgAtRef.current = now;
    try { playMuzaTick(); } catch {}
    const sid = ensureClientSessionId();
    setChatMsgs(m => [...m, { role: "user", text }]);
    setChatInput("");
    setChatSending(true);
    const ctrl = new AbortController();
    // Eugene 2026-05-20 (frontend-audit fix #3): 20s → 45s. При Anthropic 403
    // fallback chain (Claude-2 → Claude-3 → TimeWeb → GPTunnel GPT-4o-mini)
    // занимает 30-45 сек. 20s слишком короткий — AbortError на здоровом стеке.
    const timeoutId = window.setTimeout(() => ctrl.abort(), 45_000);
    try {
      const r = await fetch("/api/muza/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: sid }),
        signal: ctrl.signal,
      });
      window.clearTimeout(timeoutId);
      if (!r.ok) {
        setChatMsgs(m => [...m, { role: "bot", text: `Хм, что-то с сервером (${r.status}). Попробуй ещё раз — я тут.` }]);
        setChatSending(false);
        return;
      }
      const j = await r.json();
      if (j?.ok && j.reply) {
        // Eugene 2026-05-14 Босс «паузы как человек». Задержка пропорциональная
        // длине ответа — имитирует «печатание». QR-кнопки появляются ещё позже.
        const delay = humanDelay(j.reply.length);
        await new Promise(resolve => window.setTimeout(resolve, delay));
        try { playMuzaChime({ volume: 0.04 }); } catch {}
        // Сначала показываем текст БЕЗ кнопок
        // Eugene 2026-05-17 Босс: если LLM упал (usedFallback) — прикрепляем
        // backupChannels к этому сообщению. Под текстом отрисуется баннер
        // с альтернативными каналами (Telegram, Max).
        const backupChannels: BackupChannel[] | undefined =
          j.usedFallback && Array.isArray(j.backupChannels) && j.backupChannels.length > 0
            ? j.backupChannels
            : undefined;
        // Eugene 2026-05-18 Босс «чат → окно генерации». Если Муза вставила
        // маркер [PROPOSE_GEN:...] — фронт получит payload в j.proposedGeneration
        // и рендерит inline-карточку с 3 кнопками выбора режима.
        const proposedGeneration: ProposedGeneration | undefined =
          j.proposedGeneration && typeof j.proposedGeneration === "object" &&
          (j.proposedGeneration.mode === "audio" || j.proposedGeneration.mode === "simple" || j.proposedGeneration.mode === "full")
            ? j.proposedGeneration
            : undefined;
        // Eugene 2026-05-18 Босс «Муза сохраняет тексты». Если Муза вставила
        // [PROPOSE_REGISTER:reason=X] — фронт получит payload в j.proposedRegistration
        // и рендерит inline-карточку «Войти / Регистрация / Email».
        const validRegReasons = ["save_lyrics", "save_draft", "view_my_tracks", "history"];
        const proposedRegistration: ProposedRegistration | undefined =
          j.proposedRegistration && typeof j.proposedRegistration === "object" &&
          typeof j.proposedRegistration.reason === "string" &&
          validRegReasons.includes(j.proposedRegistration.reason)
            ? {
                reason: j.proposedRegistration.reason,
                lyricsTitle: typeof j.proposedRegistration.lyricsTitle === "string"
                  ? j.proposedRegistration.lyricsTitle.slice(0, 200)
                  : undefined,
                lyricsText: typeof j.proposedRegistration.lyricsText === "string"
                  ? j.proposedRegistration.lyricsText.slice(0, 8000)
                  : undefined,
                message: typeof j.proposedRegistration.message === "string"
                  ? j.proposedRegistration.message.slice(0, 500)
                  : undefined,
              }
            : undefined;
        // Eugene 2026-05-20 Босс «мини-плеер в чате». Если backend прикрепил
        // attachedTrack (find_public_track tool вернул playNow:<id>) — берём
        // payload с валидацией shape. autoPlay=true применяется на render
        // (только последнее сообщение, чтобы при перезагрузке history старые
        // треки не запускались сами).
        let attachedTrack: ChatTrackCardData | undefined = undefined;
        if (
          j.attachedTrack &&
          typeof j.attachedTrack === "object" &&
          typeof j.attachedTrack.id === "number" &&
          typeof j.attachedTrack.title === "string" &&
          typeof j.attachedTrack.audioUrl === "string"
        ) {
          attachedTrack = {
            id: j.attachedTrack.id,
            title: String(j.attachedTrack.title).slice(0, 200),
            authorName: typeof j.attachedTrack.authorName === "string" ? j.attachedTrack.authorName.slice(0, 100) : null,
            audioUrl: String(j.attachedTrack.audioUrl).slice(0, 500),
            coverUrl: typeof j.attachedTrack.coverUrl === "string" ? j.attachedTrack.coverUrl.slice(0, 500) : undefined,
            durationSec: typeof j.attachedTrack.durationSec === "number" ? j.attachedTrack.durationSec : 0,
          };
        }

        // Eugene 2026-05-21 Босс Chat-tool-calling MVP: pendingApproval +
        // attachedJob парсинг. Approval-карточка появится сразу под reply,
        // attachedJob — inline-card статуса с polling если processing.
        let pendingApproval: PendingApproval | undefined = undefined;
        if (
          j.pendingApproval &&
          typeof j.pendingApproval === "object" &&
          typeof j.pendingApproval.tool === "string" &&
          typeof j.pendingApproval.message === "string"
        ) {
          pendingApproval = {
            tool: String(j.pendingApproval.tool).slice(0, 60),
            estimated_cost_kopecks: Number(j.pendingApproval.estimated_cost_kopecks || 0),
            estimated_cost_label: String(j.pendingApproval.estimated_cost_label || "").slice(0, 60),
            user_balance_label: typeof j.pendingApproval.user_balance_label === "string" ? j.pendingApproval.user_balance_label.slice(0, 60) : undefined,
            user_bonus_tracks: Number(j.pendingApproval.user_bonus_tracks || 0),
            params_preview: j.pendingApproval.params_preview ?? null,
            message: String(j.pendingApproval.message).slice(0, 500),
          };
        }
        let attachedJob: AttachedJob | undefined = undefined;
        if (
          j.attachedJob &&
          typeof j.attachedJob === "object" &&
          typeof j.attachedJob.jobId === "number" &&
          typeof j.attachedJob.type === "string"
        ) {
          attachedJob = {
            jobId: Number(j.attachedJob.jobId),
            type: String(j.attachedJob.type).slice(0, 30),
            status: String(j.attachedJob.status || "processing").slice(0, 30),
            title: String(j.attachedJob.title || "").slice(0, 200) || "Без названия",
            audioUrl: typeof j.attachedJob.audioUrl === "string" ? j.attachedJob.audioUrl.slice(0, 500) : null,
            coverUrl: typeof j.attachedJob.coverUrl === "string" ? j.attachedJob.coverUrl.slice(0, 500) : null,
            lyricsPreview: typeof j.attachedJob.lyricsPreview === "string" ? j.attachedJob.lyricsPreview.slice(0, 500) : null,
            durationSec: Number(j.attachedJob.durationSec || 0),
            errorReason: typeof j.attachedJob.errorReason === "string" ? j.attachedJob.errorReason.slice(0, 300) : null,
          };
        }
        setChatMsgs(m => [...m, {
          role: "bot",
          text: j.reply,
          backupChannels,
          proposedGeneration,
          proposedRegistration,
          attachedTrack,
          pendingApproval,
          attachedJob,
          // quickReplies подадим отдельной перезаписью через ещё одну паузу
        }]);
        setChatSending(false);
        if (j.paired) setChatPaired({ channel: j.pairedFromChannel });
        if (j.memo) setChatMemo(j.memo);
        // Через 1800-2800ms добавляем quickReplies — юзер успел прочитать.
        // Если юзер быстрый — половина (900-1400ms).
        const qrList = Array.isArray(j.quickReplies) && j.quickReplies.length > 0 ? j.quickReplies : undefined;
        if (qrList) {
          const slowQR = 1800 + Math.floor(Math.random() * 1000);
          const qrDelay = userPaceRef.current === "fast" ? Math.floor(slowQR * 0.5) : slowQR;
          window.setTimeout(() => {
            setChatMsgs(m => {
              if (m.length === 0) return m;
              const last = m[m.length - 1];
              if (last.role === "bot" && last.text === j.reply) {
                return [...m.slice(0, -1), { ...last, quickReplies: qrList }];
              }
              return m;
            });
          }, qrDelay);
        }
      } else {
        setChatMsgs(m => [...m, { role: "bot", text: j?.error || "Что-то пошло не так — попробуйте ещё раз" }]);
        setChatSending(false);
      }
    } catch (e: any) {
      window.clearTimeout(timeoutId);
      const msg = e?.name === "AbortError"
        ? "Думаю слишком долго — наверное, провайдер сегодня медленный. Повторим?"
        : "Сеть подвисла — попробуйте через секунду";
      setChatMsgs(m => [...m, { role: "bot", text: msg }]);
      setChatSending(false);
    }
  }, [humanDelay]);

  const sendChat = useCallback(async () => {
    if (!chatInput.trim() || chatSending) return;
    await doSendMessage(chatInput);
  }, [chatInput, chatSending, doSendMessage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = Number(sessionStorage.getItem(SS_KEY) || "0");
      dismissedRef.current = saved;
      if (saved >= MAX_DISMISS) return;
    } catch {}
    timerRef.current = window.setTimeout(() => {
      setVisible(true);
      trackEngagement("consultant_impression");
    }, APPEAR_DELAY_MS);
    // Listener для открытия извне (новость, кнопка). Eugene 2026-05-14
    // Босс «любое нажатие на Музу — сразу в чат, не меню».
    const onOpen = () => {
      setVisible(true);
      setExpanded(false);
      // Открываем чат напрямую
      try { playMuzaSparkle(); } catch {}
      openChat();
      trackEngagement("consultant_open", { trigger: "external" });
    };
    window.addEventListener("open-consultant", onOpen);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      window.removeEventListener("open-consultant", onOpen);
    };
  }, []);

  const dismiss = () => {
    setExiting(true);
    window.setTimeout(() => {
      setVisible(false);
      setExiting(false);
      setExpanded(false);
      dismissedRef.current += 1;
      try { sessionStorage.setItem(SS_KEY, String(dismissedRef.current)); } catch {}
      // Eugene 2026-05-14 Босс «1 мин после первого, 1 час после ещё раз».
      if (dismissedRef.current < MAX_DISMISS) {
        const reappearMs = dismissedRef.current === 1 ? REAPPEAR_MS_FIRST : REAPPEAR_MS_SECOND;
        timerRef.current = window.setTimeout(() => {
          setVisible(true);
        }, reappearMs);
      }
    }, 350);
  };

  // Eugene 2026-05-14 Босс «любой резкий скролл вниз — появляется Муза».
  // Меряем pixel-velocity между scroll-events; если резко вниз — show.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let lastY = window.scrollY;
    let lastT = Date.now();
    const onScroll = () => {
      const y = window.scrollY;
      const t = Date.now();
      const dy = y - lastY;
      const dt = t - lastT;
      lastY = y; lastT = t;
      if (dt < 100 && dy > SCROLL_VELOCITY_THRESHOLD && !visible && !chatOpen) {
        // Резкий scroll вниз — показываем Музу даже если dismissed
        if (timerRef.current) window.clearTimeout(timerRef.current);
        setVisible(true);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [visible, chatOpen]);

  // Eugene 2026-05-14 Босс «3 тапа по экрану — появляется Муза когда нет,
  // 3 тапа — исчезает медленно когда есть». Triple-tap в окне 700ms.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const taps: number[] = [];
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      // Игнорируем тапы на интерактивные элементы — не сбиваем UI
      if (target?.closest("button,input,textarea,a,[role='button']")) return;
      const now = Date.now();
      taps.push(now);
      while (taps.length > 0 && now - taps[0] > 700) taps.shift();
      if (taps.length >= 3) {
        taps.length = 0;
        if (chatOpen) return;
        if (visible) {
          dismiss(); // плавный fade-out + REAPPEAR cooldown
        } else {
          if (timerRef.current) window.clearTimeout(timerRef.current);
          setVisible(true);
        }
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [visible, chatOpen]);

  // Eugene 2026-05-17 Босс: smart-триггер Музы — появляется когда юзер долго
  // думает (idle/form-abandon/no-play). Подписка на user-journey events.
  //
  // Сценарии:
  //   a. idle_30s на любой странице → подсказка «Помочь?»
  //   b. form_abandon на /register-phone / /music → «Не получается? Помогу»
  //   c. 90 сек на landing без play → «Послушай несколько треков 🎵»
  //   d. idle_30s на /music без формы → «Не знаешь с чего начать?»
  //
  // Каждый триггер — once per session (smartFiredRef). Не спамим юзера.
  // Если Муза скрыта/dismissed — показываем. Если уже видна — highlight.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const showWithBubble = (key: string, bubbleText: string) => {
      if (smartFiredRef.current.has(key)) return;
      smartFiredRef.current.add(key);
      if (chatOpen) return; // не дёргаем во время разговора
      setSmartBubbleText(bubbleText);
      if (visible) {
        // Уже видна — animate attention.
        setSmartHighlight(true);
        window.setTimeout(() => setSmartHighlight(false), 2500);
      } else {
        // Скрыта — показываем (минуя dismiss-cooldown).
        if (timerRef.current) window.clearTimeout(timerRef.current);
        setVisible(true);
        trackEngagement("consultant_impression", { trigger: key });
      }
      // Автоматически убираем кастомный текст через 12 сек —
      // возвращается стандартное «Заходи в чат — креативить».
      window.setTimeout(() => setSmartBubbleText(null), 12_000);
    };

    const off = onJourneyEvent(({ type, page, meta }) => {
      // Сброс счётчиков при смене страницы.
      if (type === "page_view") {
        pageEnteredAtRef.current = Date.now();
        pageHadPlayRef.current = false;
        return;
      }
      // Маркер play (click по play-button / audio play).
      if (type === "click") {
        const txt = String(meta?.text || "").toLowerCase();
        const elemId = String(meta?.id || "").toLowerCase();
        if (txt.includes("play") || elemId.includes("play") || elemId.includes("audio")) {
          pageHadPlayRef.current = true;
        }
        return;
      }
      // idle_30s — основной триггер.
      if (type === "idle_30s") {
        // На /music — «не знаешь с чего начать?»
        if (page === "/music") {
          showWithBubble("idle:music", "Не знаешь с чего начать? Помогу собрать идею 🎵");
          return;
        }
        // На /register-phone — «не получается? войди через email или напиши мне»
        if (page === "/register-phone" || page === "/login-phone") {
          showWithBubble("idle:auth", "Не получается войти? Спроси меня — подскажу 💡");
          return;
        }
        // На любой другой странице — generic «Помочь?»
        showWithBubble("idle:" + page, "Помочь? Я тут, спрашивай 💜");
        return;
      }
      // form_abandon — самый сильный сигнал «застрял на форме».
      if (type === "form_abandon") {
        if (page === "/register-phone" || page === "/login-phone") {
          showWithBubble("abandon:auth", "Не получается? Войди через email или напиши мне 💌");
          return;
        }
        if (page === "/music") {
          showWithBubble("abandon:music", "Застряла форма? Расскажи идею словами — помогу собрать ✨");
          return;
        }
        showWithBubble("abandon:" + page, "Не получается заполнить? Спроси меня 💜");
      }
    });

    // 90 сек на landing без play — проверяем тикером.
    const landingTick = window.setInterval(() => {
      const cur = (window.location.hash || "#/").slice(1).split("?")[0] || "/";
      if (cur !== "/") return;
      if (pageHadPlayRef.current) return;
      const elapsed = Date.now() - pageEnteredAtRef.current;
      if (elapsed >= 90_000) {
        showWithBubble("landing:no-play", "Послушай несколько треков для вдохновения 🎵");
      }
    }, 15_000);

    return () => {
      off();
      window.clearInterval(landingTick);
    };
  }, [visible, chatOpen]);

  if (!visible) return null;
  if (!featureEnabled) return null;
  // Eugene 2026-05-19 Single-Musa rule: маленькая mouse-follow override'ит большую FAB
  if (mouseFollowActive && !chatOpen && !expanded) return null;

  return (
    <div
      style={{
        position: "fixed",
        left: fabPos.x,
        top: fabPos.y,
        zIndex: 100000,
        // Плавный transition обычно — но во время drag без transition (instant follow).
        transition: dragMode ? "none" : "left 280ms cubic-bezier(.2,.7,.2,1), top 280ms cubic-bezier(.2,.7,.2,1)",
        touchAction: dragMode ? "none" : undefined,
        filter: dragMode ? "drop-shadow(0 0 12px rgba(124,58,237,0.5))" : undefined,
      }}
      className={`transition-opacity duration-500 ${exiting ? "opacity-0 consultant-slide-out" : "opacity-100 consultant-slide-in animate-in fade-in"} ${smartHighlight ? "consultant-attention" : ""}`}
      data-testid="floating-consultant"
      // Eugene 2026-05-21 Босс «куклу музу можно перемещать пальцем».
      // Long-press 350ms → drag-mode. Если палец двигается раньше — обычный click/expand.
      onPointerDown={(e) => {
        if (!e.isPrimary) return;
        if (chatOpen || expanded) return; // не двигаем когда открыт чат/меню
        const { w: fabW, h: fabH } = getFabSize();
        fabDragStartRef.current = { px: e.clientX, py: e.clientY, fx: fabPos.x, fy: fabPos.y, pointerId: e.pointerId };
        if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = window.setTimeout(() => {
          // Long-press hit — вход в drag-mode
          dragModeRef.current = true;
          setDragMode(true);
          try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
          try { (navigator as any).vibrate?.(10); } catch {}
          // Юзер двигает руками — сбрасываем auto-move-back state
          userPositionBeforeAutoMoveRef.current = null;
        }, 350);
        // Mark флаг что юзер сам поставил позицию (после drag сохраним)
        void fabW; void fabH;
      }}
      onPointerMove={(e) => {
        const start = fabDragStartRef.current;
        if (!start) return;
        const dx = e.clientX - start.px;
        const dy = e.clientY - start.py;
        const dist = Math.hypot(dx, dy);
        if (!dragModeRef.current) {
          // Не в drag-mode — если палец двинулся >8px ДО long-press, отменяем таймер.
          // Дальше управляет существующий drag-to-expand на inner button.
          if (dist > 8 && longPressTimerRef.current) {
            window.clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
            fabDragStartRef.current = null;
          }
          return;
        }
        // Drag-mode — перемещаем Музу
        e.stopPropagation();
        e.preventDefault();
        const { w: fabW, h: fabH } = getFabSize();
        const clamped = clampToViewport(start.fx + dx, start.fy + dy, fabW, fabH);
        setFabPos(clamped);
      }}
      onPointerUp={(e) => {
        if (longPressTimerRef.current) {
          window.clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        const wasDragging = dragModeRef.current;
        if (wasDragging) {
          dragModeRef.current = false;
          setDragMode(false);
          try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
          // Сохраняем юзер-позицию в localStorage
          writePos(FAB_DRAG_KEY, fabPos);
          userPositionedRef.current = true;
          e.stopPropagation();
          e.preventDefault();
        }
        fabDragStartRef.current = null;
      }}
      onPointerCancel={() => {
        if (longPressTimerRef.current) {
          window.clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        if (dragModeRef.current) {
          dragModeRef.current = false;
          setDragMode(false);
        }
        fabDragStartRef.current = null;
      }}
    >
      <div className="relative">
        {/* Eugene 2026-05-20 Босс: Музa зафиксирована справа внизу,
            drag handle убран. */}
        {/* Eugene 2026-05-14 Босс «нажатие на облако заводит в чат».
            Облако кликабельно — открывает чат напрямую.
            Eugene 2026-05-17 Босс: при smart-триггере (idle/form_abandon)
            текст облака меняется на контекстную подсказку.
            Eugene 2026-05-18 Босс «убери облака с подсказками по умолчанию».
            Default-облако удалено — показываем только контекстные smart-bubbles
            (idle 30 сек / form abandon / etc). */}
        {!expanded && !reaction && !chatOpen && smartBubbleText && (
          <button
            type="button"
            onClick={openChat}
            className="absolute bottom-full right-0 mb-2 px-4 py-2.5 backdrop-blur-md border text-[12px] font-medium text-white text-center leading-tight max-w-[180px] animate-in fade-in slide-in-from-bottom-2 duration-300 shadow-lg hover:scale-105 transition-all cursor-pointer bg-gradient-to-br from-pink-500/40 to-purple-500/30 border-pink-300/50 shadow-pink-500/30 hover:from-pink-500/60 hover:to-purple-500/45"
            style={{
              borderRadius: "55% 45% 45% 50% / 60% 50% 60% 40%",
            }}
            aria-label="Открыть чат с Музой"
          >
            {smartBubbleText}
          </button>
        )}

        {/* Click reaction bubble — игровая деловая фраза при нажатии */}
        {reaction && (
          <div className="absolute bottom-full right-0 mb-1.5 px-3 py-1.5 rounded-2xl bg-gradient-to-br from-purple-500/30 to-blue-500/20 backdrop-blur-md border border-purple-400/40 text-[11px] text-white font-medium whitespace-nowrap animate-in fade-in slide-in-from-bottom-2 duration-200 shadow-lg shadow-purple-500/20">
            {reaction}
          </div>
        )}

        {/* Expanded меню «мечтательное облако» (Eugene 2026-05-14 Босс).
            Eugene 2026-05-15 Босс «облачно у Музы уменьшить по высоте +
            кнопку чат ближе к скрыть, мини-облачко светлее, ближе кликать
            на смартфоне». p-4 → p-2.5, w-60 (компактнее), Чат+Скрыть в
            самом низу парой, Чат как яркое мини-облачко. */}
        {expanded && (
          <div
            className="absolute bottom-full right-0 mb-3 w-72 sm:w-80 p-4 bg-gradient-to-br from-violet-400/25 via-fuchsia-300/18 to-sky-400/18 backdrop-blur-2xl border border-white/15 shadow-lg shadow-purple-400/15 animate-in fade-in slide-in-from-bottom-2 duration-300 overflow-hidden"
            style={{
              borderRadius: "60% 40% 55% 70% / 50% 65% 45% 60%",
              boxShadow: "0 20px 60px rgba(139, 92, 246, 0.5), 0 0 40px rgba(34, 211, 238, 0.25), inset 0 0 30px rgba(255, 255, 255, 0.05)",
            }}
          >
            {/* Космо-фон: мерцающие звёзды */}
            <svg viewBox="0 0 200 100" className="absolute inset-0 w-full h-full pointer-events-none opacity-60" aria-hidden="true">
              <circle cx="15" cy="10" r="0.9" fill="#fde68a" className="gift-twinkle" style={{animationDelay:"0s"}} />
              <circle cx="50" cy="20" r="0.7" fill="#a78bfa" className="gift-twinkle" style={{animationDelay:"0.8s"}} />
              <circle cx="100" cy="8" r="1" fill="#22d3ee" className="gift-twinkle" style={{animationDelay:"1.6s"}} />
              <circle cx="150" cy="15" r="0.8" fill="#60a5fa" className="gift-twinkle" style={{animationDelay:"2.4s"}} />
              <circle cx="180" cy="30" r="0.9" fill="#fde68a" className="gift-twinkle" style={{animationDelay:"3.0s"}} />
              <circle cx="30" cy="50" r="0.7" fill="#22d3ee" className="gift-twinkle" style={{animationDelay:"0.5s"}} />
              <circle cx="90" cy="65" r="0.8" fill="#a78bfa" className="gift-twinkle" style={{animationDelay:"1.3s"}} />
              <circle cx="170" cy="80" r="1" fill="#60a5fa" className="gift-twinkle" style={{animationDelay:"2.1s"}} />
            </svg>
            {/* Brand-header */}
            <div className="relative flex items-center gap-2 mb-3 pb-2 border-b border-white/10">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-500 via-violet-400 to-blue-500 flex items-center justify-center shadow-lg shadow-purple-500/40 shrink-0">
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none">
                  <path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="white" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-bold tracking-tight">
                  <span className="bg-gradient-to-r from-purple-300 via-violet-200 to-blue-300 bg-clip-text text-transparent">Muza</span><span className="bg-gradient-to-r from-blue-300 to-cyan-200 bg-clip-text text-transparent">Ai</span>
                  <span className="text-white/60 font-normal ml-1">· Муза тут</span>
                </div>
                <div className="text-[10px] text-white/50">Выбирайте как общаться 🚀</div>
              </div>
            </div>
            {/* Eugene 2026-05-15 Босс «кнопку чат ближе к скрыть» — primary
                CTA перенесён вниз, рядом с кнопкой Скрыть. */}
            <a
              href="https://t.me/Muziaipodari_bot"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackEngagement("consultant_action", { action: "telegram" })}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90"
            >
              <span>📱</span> Telegram
            </a>
            <a
              href="https://max.ru/id7017236261_1_bot"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackEngagement("consultant_action", { action: "max" })}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90"
            >
              <span>💬</span> Max
            </a>
            {/* Eugene 2026-05-14 Босс: «Создадим песню» → сразу в чат
                и от него диалог развиваем. */}
            <button
              type="button"
              onClick={() => { trackEngagement("consultant_action", { action: "create_via_chat" }); openChat(); }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90 text-left"
            >
              <span>🎵</span> Создадим песню (в чате)
            </button>
            {/* Eugene 2026-05-14 Босс: «Зарегистрироваться открывает меню». */}
            <button
              type="button"
              onClick={() => setRegisterMenuOpen(s => !s)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90 text-left"
            >
              <span>🎁</span> Зарегистрироваться <span className="ml-auto text-[10px] text-white/40">{registerMenuOpen ? "▴" : "▾"}</span>
            </button>
            {registerMenuOpen && (
              <div className="ml-4 my-1 pl-2 border-l border-purple-300/20 space-y-0.5">
                <button
                  type="button"
                  onClick={() => { trackEngagement("consultant_action", { action: "register_email" }); window.location.hash = "#/register"; }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[11px] text-white/85 text-left"
                >
                  <span>📧</span> По email (форма)
                </button>
                <a
                  href="https://t.me/Muziaipodari_bot?start=register"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => trackEngagement("consultant_action", { action: "register_telegram" })}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[11px] text-white/85"
                >
                  <span>📱</span> Через Telegram
                </a>
                <a
                  href="https://max.ru/id7017236261_1_bot"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => trackEngagement("consultant_action", { action: "register_max" })}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[11px] text-white/85"
                >
                  <span>💬</span> Через Max
                </a>
              </div>
            )}
            {/* Eugene 2026-05-17 Босс: кнопка «🆘 Техподдержка» — открывает
                Муза-чат + создаёт ticket в agent_handoffs + alert админу. */}
            <button
              type="button"
              onClick={() => {
                trackEngagement("consultant_action", { action: "support_button" });
                setSupportOpen(true);
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90 text-left"
            >
              <span>🆘</span> Техподдержка
            </button>
            {/* Eugene 2026-05-15 Босс «уменьшить по высоте» — Share-submenu
                удалён (он дублирует Telegram/Max выше). Single share-button —
                native share API. */}
            <button
              type="button"
              onClick={async () => {
                trackEngagement("consultant_action", { action: "share_native" });
                const text = "Привет! Порекомендую Музу — крутая в подборе песен под событие.";
                const url = "https://muzaai.ru";
                if (typeof navigator !== "undefined" && (navigator as any).share) {
                  try {
                    await (navigator as any).share({ title: "MuzaAi · Муза", text, url });
                    return;
                  } catch {}
                }
                // Fallback: копирование ссылки.
                try { await navigator.clipboard?.writeText(url); } catch {}
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90 text-left"
            >
              <span className="text-green-400 text-base">➜</span>
              <span>Поделиться Музой</span>
            </button>
            {/* Eugene 2026-05-15 Босс «кнопку чат сделать ближе к скрыть, прям
                мини-облачко светлее в облаке, ближе кликать на смартфоне».
                Пара кнопок Чат + Скрыть внизу облака. Чат — большой яркий
                мини-облачный bubble (светлый bg, contrasting border), Скрыть
                — компактная серая.
                min-h-[44px] iOS HIG для удобного тапа на смартфоне. */}
            <div className="grid grid-cols-[1fr_auto] gap-2 mt-3">
              {/* Eugene 2026-05-20 Босс: «Чат с Музой» — pulse-glow + ярче чем
                  остальные пункты + больше шрифт. Привлекает внимание. */}
              <button
                type="button"
                onClick={openChat}
                className="relative min-h-[48px] px-3 rounded-[40%_50%_45%_55%/50%_45%_55%_50%] bg-gradient-to-br from-purple-400/70 via-fuchsia-400/60 to-cyan-400/55 hover:from-purple-400/90 hover:via-fuchsia-400/80 hover:to-cyan-400/75 transition-all text-white text-[14px] font-bold shadow-[0_0_18px_rgba(217,70,239,0.45)] hover:shadow-[0_0_28px_rgba(217,70,239,0.7)] border-2 border-white/55 overflow-hidden group active:scale-95 animate-chat-pulse"
                aria-label="Открыть чат с Музой"
              >
                <span className="relative z-10 flex items-center justify-center gap-1.5">
                  <span className="text-base">💬</span>
                  <span>Чат с Музой</span>
                </span>
                <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={dismiss}
                className="min-h-[44px] px-3 rounded-xl bg-white/[0.04] text-[12px] text-white/70 hover:text-white hover:bg-white/[0.08] transition-colors border border-white/[0.06] active:scale-95"
                aria-label="Скрыть"
              >
                Скрыть
              </button>
            </div>
          </div>
        )}

        {/* Силуэт взрослой певицы с микрофоном.
            Минимум деталей лица, акцент на pose певицы.
            Pastel MuzaAi gradient. */}
        <button
          type="button"
          onDoubleClick={() => {
            // Eugene 2026-05-14 Босс «двойное нажатие на Музу — она плавно
            // уходит». Используем dismiss (с REAPPEAR cooldown).
            dismiss();
          }}
          onClick={() => {
            // Если только что раскрыли через drag — не toggle.
            if (dragExpandedRef.current) {
              dragExpandedRef.current = false;
              return;
            }
            // Single-click: меню expanded. Double-click intercept выше.
            try { playMuzaChime(); } catch {}
            const phrase = CLICK_REACTIONS[reactionIdxRef.current % CLICK_REACTIONS.length];
            reactionIdxRef.current += 1;
            setReaction(phrase);
            if (reactionTimerRef.current) window.clearTimeout(reactionTimerRef.current);
            reactionTimerRef.current = window.setTimeout(() => setReaction(null), 2500);
            setExpanded(e => { const next = !e; if (next) trackEngagement("consultant_open"); return next; });
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onPointerDown={(e) => {
            // Eugene 2026-05-20: drag-to-expand для mouse/pen/touch (1 палец).
            if (e.isPrimary) {
              expandDragStartRef.current = { x: e.clientX, y: e.clientY };
              dragExpandedRef.current = false;
            }
          }}
          onPointerMove={(e) => {
            if (!expandDragStartRef.current) return;
            const dx = expandDragStartRef.current.x - e.clientX;
            const dy = expandDragStartRef.current.y - e.clientY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 60 && !expanded) {
              try { playMuzaChime(); } catch {}
              setExpanded(true);
              trackEngagement("consultant_open", { via: "drag" });
              dragExpandedRef.current = true;
              expandDragStartRef.current = null;
            }
          }}
          onPointerUp={() => { expandDragStartRef.current = null; }}
          onPointerCancel={() => { expandDragStartRef.current = null; }}
          onTouchStart={(e) => {
            // Eugene 2026-05-20: pinch-to-expand на mobile (2 пальца).
            // При появлении 2-го пальца — отменяем drag, остаётся только pinch.
            if (e.touches.length === 2) {
              const dx = e.touches[0].clientX - e.touches[1].clientX;
              const dy = e.touches[0].clientY - e.touches[1].clientY;
              pinchStartDistRef.current = Math.sqrt(dx * dx + dy * dy);
              expandDragStartRef.current = null;
            }
          }}
          onTouchMove={(e) => {
            if (e.touches.length === 2 && pinchStartDistRef.current !== null) {
              const dx = e.touches[0].clientX - e.touches[1].clientX;
              const dy = e.touches[0].clientY - e.touches[1].clientY;
              const dist = Math.sqrt(dx * dx + dy * dy);
              const delta = dist - pinchStartDistRef.current;
              if (delta > 50 && !expanded) {
                try { playMuzaChime(); } catch {}
                setExpanded(true);
                trackEngagement("consultant_open", { via: "pinch" });
                pinchStartDistRef.current = dist;
              } else if (delta < -50 && expanded) {
                setExpanded(false);
                pinchStartDistRef.current = dist;
              }
            }
          }}
          onTouchEnd={() => { pinchStartDistRef.current = null; }}
          onTouchCancel={() => { pinchStartDistRef.current = null; }}
          aria-label="Муза — клик, растяни двумя пальцами или потяни для меню"
          className="block w-24 h-36 sm:w-28 sm:h-48 active:scale-95 transition-transform opacity-90 hover:opacity-100 consultant-dance"
        >
          {/* Eugene 2026-05-18: 3D-аватар (musa-3d) с onError fallback на
              SVG. После approve в админке consultant-avatar.png будет
              переписан hi-res 3D PNG'ом — Муза везде станет «живой». */}
          <img
            src="/consultant-avatar.png"
            alt="Муза"
            className="w-full h-full object-contain"
            draggable={false}
            onError={(e) => { (e.target as HTMLImageElement).src = "/consultant-avatar.svg"; }}
          />
        </button>
        {/* Eugene 2026-05-14 Босс «кнопку свернуть по её ногами». Маленькая
            кнопка под Музой — sweep её на 1 мин (или 1 час если повторно). */}
        {!expanded && !chatOpen && (
          <button
            type="button"
            onClick={dismiss}
            aria-label="Свернуть Музу"
            title={dismissedRef.current === 0 ? "Свернуть на 1 минуту" : "Свернуть на 1 час"}
            className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-6 h-6 rounded-full bg-black/40 backdrop-blur-sm border border-white/20 text-white/70 hover:text-white hover:bg-black/60 text-[10px] flex items-center justify-center transition-colors"
          >×</button>
        )}
      </div>
      {/* Eugene 2026-05-14 Босс v2: inline chat panel вынесена в портал
          к document.body — иначе родитель с transform (consultant-slide-in)
          ломает fixed-позиционирование на мобильном (узкий столбик справа).
          Drawer от правой границы влево, не fullscreen. */}
      {chatOpen && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[99999] pointer-events-none"
          aria-modal="true"
          role="dialog"
        >
          {/* Eugene 2026-05-14 Босс «можно нажимать на кнопки главной без
              закрытия чата». Backdrop без pointer-events — клики проходят
              сквозь, главная страница реагирует. Клик ВНЕ drawer не закрывает. */}
          <div
            className="absolute inset-0 pointer-events-none"
          />
          {/* Eugene 2026-05-18 Босс: snap-indicators во время resize — тонкие
              вертикальные линии на 30% / 50% / 70% viewport width + бейдж с %
              у активной snap-зоны. Subtle (purple/fuchsia при активной),
              появляются только во время drag. */}
          {!isMobile && isResizing && (
            <>
              {[0.3, 0.5, 0.7].map((t) => {
                const isActive = resizeSnapTarget === t;
                return (
                  <div
                    key={t}
                    className={`absolute top-0 bottom-0 w-px pointer-events-none transition-all ${
                      isActive ? "bg-fuchsia-400/60 shadow-[0_0_8px_rgba(232,121,249,0.6)]" : "bg-purple-400/20"
                    }`}
                    style={{ left: `${(1 - t) * 100}%` }}
                  >
                    {isActive && (
                      <div className="absolute top-2 -translate-x-1/2 left-0 text-[10px] font-mono px-2 py-0.5 rounded-full bg-fuchsia-500/20 text-fuchsia-200 border border-fuchsia-400/40 whitespace-nowrap">
                        {Math.round(t * 100)}%
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
          <div
            className={`absolute flex flex-col bg-background/[0.28] backdrop-blur-md border-2 rounded-2xl border-purple-400/40 shadow-2xl shadow-purple-500/20 overflow-hidden pointer-events-auto animate-in fade-in duration-300 ${
              isResizing ? "" : "transition-all"
            } ${
              // Mobile (sm:hidden break) — фиксированные responsive ширины как раньше.
              // Desktop/iPad без chatSize — тоже CSS-default; с chatSize — inline width/height.
              isMobile || !chatSize ? "w-[92vw] max-w-[420px] sm:w-[380px] sm:!h-[460px]" : ""
            } ${
              // Eugene 2026-05-20 Босс: чат не перекрывает Музу (bottom-right).
              // br/bl смещены выше на высоту Музы (80px) + gap.
              drawerSnap === "br" ? "right-0 bottom-[104px] sm:bottom-[104px] sm:right-4" :
              drawerSnap === "bl" ? "left-0 bottom-0 sm:bottom-4 sm:left-4" :
              drawerSnap === "tr" ? "right-0 top-20 sm:top-20 sm:right-4" :
              drawerSnap === "tl" ? "left-0 top-20 sm:top-20 sm:left-4" :
              "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
            }`}
            style={{
              // На mobile или без кастомного chatSize — старая высота через CSS clamp.
              // С chatSize (desktop/iPad) — inline width/height (приоритет над w-/sm:w-/sm:h-).
              ...(!isMobile && chatSize
                ? { width: `${chatSize.w}px`, height: `${chatSize.h}px` }
                : { height: "min(60vh, calc(100vh - 96px - env(safe-area-inset-bottom, 0px)))" }),
              marginBottom: drawerSnap === "br" || drawerSnap === "bl" ? "env(safe-area-inset-bottom, 0px)" : undefined,
            }}
          >
            {/* Eugene 2026-05-18 Босс: диагональная стрелка resize в верхне-левом
                углу. Drag от угла → размер chat panel меняется (рост влево/вверх).
                Snap-зоны 30% / 50% / 70% viewport width — магнит ±20px,
                индикатор-glow на handle при close-to-snap. Mobile — скрыт. */}
            {!isMobile && (
              <div
                onPointerDown={handleResizeStart}
                className={`absolute top-0 left-0 w-9 h-9 z-30 flex items-center justify-center select-none cursor-nwse-resize rounded-br-xl transition-all ${
                  isResizing
                    ? resizeSnapTarget !== null
                      ? "text-fuchsia-200 bg-fuchsia-500/20 drop-shadow-[0_0_10px_rgba(232,121,249,0.95)]"
                      : "text-purple-200 bg-purple-500/15"
                    : "text-fuchsia-300/80 hover:text-fuchsia-200 hover:bg-purple-500/20 animate-pulse"
                }`}
                title={`Перетащи угол ↖ чтобы изменить размер${resizeSnapTarget !== null ? ` · ${Math.round(resizeSnapTarget * 100)}%` : ""}`}
                aria-label="Resize handle"
                role="separator"
              >
                <span className="text-[16px] font-bold leading-none rotate-[-45deg] drop-shadow-[0_0_6px_rgba(232,121,249,0.6)]">⇕</span>
              </div>
            )}
            {/* Eugene 2026-05-14 Босс «нажатие на левую часть по вертикали
                перемещать. Углы возвращают в центр». Drag-handle на левой
                полосе drawer. Touch + drag → определяем направление и snap. */}
            <div
              onPointerDown={(e) => {
                dragStartRef.current = { x: e.clientX, y: e.clientY };
              }}
              onPointerUp={(e) => {
                const start = dragStartRef.current;
                dragStartRef.current = null;
                if (!start) return;
                const dx = e.clientX - start.x;
                const dy = e.clientY - start.y;
                const absDx = Math.abs(dx);
                const absDy = Math.abs(dy);
                if (absDx < 30 && absDy < 30) return; // tap, не drag
                if (absDx > absDy) {
                  // horizontal: ←→
                  if (dx < -50) setDrawerSnap(drawerSnap === "br" ? "bl" : drawerSnap === "tr" ? "tl" : "bl");
                  else if (dx > 50) setDrawerSnap(drawerSnap === "bl" ? "br" : drawerSnap === "tl" ? "tr" : "br");
                } else {
                  // vertical: ↑↓
                  if (dy < -50) setDrawerSnap(drawerSnap === "br" ? "tr" : drawerSnap === "bl" ? "tl" : "tr");
                  else if (dy > 50) setDrawerSnap(drawerSnap === "tr" ? "br" : drawerSnap === "tl" ? "bl" : "br");
                }
              }}
              className="absolute left-0 top-0 bottom-0 w-3 cursor-grab active:cursor-grabbing z-20 hover:bg-purple-400/10 transition-colors flex items-center justify-center"
              title="Перетащите чтобы переместить"
              aria-label="Drag handle"
            >
              <div className="w-0.5 h-12 rounded-full bg-purple-400/30" />
            </div>
            {/* Snap to center button (top-right corner of drawer) */}
            <button
              type="button"
              onClick={() => setDrawerSnap("center")}
              aria-label="Центр"
              title="В центр экрана"
              className="absolute top-1 right-12 w-6 h-6 rounded text-white/40 hover:text-white text-[11px] z-20 hover:bg-white/[0.08]"
            >⊕</button>
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-3 sm:py-2 border-b border-white/[0.06] bg-gradient-to-r from-purple-500/10 to-blue-500/5 shrink-0 relative">
              <img src="/consultant-avatar.png" alt="Муза" className="w-9 h-9 sm:w-8 sm:h-8 rounded-full object-contain bg-white/5 shrink-0" onError={(e) => { (e.target as HTMLImageElement).src = "/consultant-avatar.svg"; }} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-white truncate">
                  Муза
                  {chatPaired && (
                    <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-300 font-normal whitespace-nowrap">
                      {chatPaired.channel === "telegram" ? "📱 из Telegram" : chatPaired.channel === "max" ? "💬 из Max" : "✨ привязано"}
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-white/50 truncate">Подскажу с песней, темой, регистрацией</div>
              </div>
              {/* Eugene 2026-05-14 Босс: новый разговор — чистый sessionId,
                  устраняет остатки старой истории в БД. */}
              <button
                type="button"
                onClick={() => {
                  if (chatMsgs.filter(m => m.role === "user").length > 0) {
                    if (!window.confirm("Начать новый разговор? Текущая история сохранится в БД, но новый чат начнётся с чистого листа.")) return;
                  }
                  startFreshChat();
                }}
                aria-label="Начать новый разговор"
                title="Начать новый разговор"
                className="w-9 h-9 sm:w-7 sm:h-7 rounded-full hover:bg-white/[0.08] text-white/70 hover:text-white text-sm flex items-center justify-center shrink-0"
              >🔄</button>
              {/* Share — Eugene 2026-05-14 Босс «пересылка чата выдаёт ошибку».
                  Native share может reject из-за: 1) не https 2) text too long
                  3) user cancel 4) browser unsupported. Логика:
                  - text+url < 1500 → пробуем native;
                  - reject (НЕ AbortError = user cancel) → fallback submenu;
                  - всегда оборачиваем в try/catch чтобы не падать. */}
              {chatMsgs.length >= 2 && (
                <button
                  type="button"
                  onClick={async () => {
                    const dialogText = serializeChatForShare(chatMsgs);
                    const truncated = dialogText.length > 1200 ? dialogText.slice(0, 1200) + "…" : dialogText;
                    let nativeWorked = false;
                    if (typeof navigator !== "undefined" && (navigator as any).share) {
                      try {
                        await (navigator as any).share({
                          title: "Разговор с Музой",
                          text: truncated,
                        });
                        nativeWorked = true;
                      } catch (e: any) {
                        if (e?.name !== "AbortError") {
                          console.warn("[CHAT-SHARE] native rejected:", e?.name, e?.message);
                        }
                      }
                    }
                    if (!nativeWorked) setShareMenuOpen(s => !s);
                  }}
                  aria-label="Поделиться диалогом"
                  title="Поделиться диалогом"
                  className="w-9 h-9 sm:w-7 sm:h-7 rounded-full hover:bg-white/[0.08] text-green-400 hover:text-green-300 text-lg font-bold flex items-center justify-center shrink-0"
                >➜</button>
              )}
              {/* Eugene 2026-05-18 Босс «звук сообщения в чате» — toggle 🔔/🔕.
                  Persist через localStorage. При первом включении нужен user-gesture
                  для AudioContext resume (W3C Autoplay Policy) — клик на toggle и
                  является этим gesture. */}
              <button
                type="button"
                onClick={() => {
                  setSoundEnabled((v) => {
                    const next = !v;
                    // resume() при включении (user gesture требуется браузером)
                    if (next) {
                      const ctx = getAudioCtx();
                      if (ctx && ctx.state === "suspended") {
                        try { ctx.resume(); } catch {}
                      }
                    }
                    return next;
                  });
                }}
                aria-label={soundEnabled ? "Отключить звук сообщений" : "Включить звук сообщений"}
                title={soundEnabled ? "Звук включён — отключить" : "Звук выключен — включить"}
                className={`w-9 h-9 sm:w-7 sm:h-7 rounded-full hover:bg-white/[0.08] text-sm flex items-center justify-center shrink-0 transition-transform ${
                  soundEnabled ? "text-fuchsia-300 hover:text-fuchsia-200 rotate-0" : "text-white/40 hover:text-white/70 -rotate-12"
                }`}
              >{soundEnabled ? "🔔" : "🔕"}</button>
              <button
                type="button"
                onClick={() => { setChatOpen(false); setShareMenuOpen(false); }}
                aria-label="Закрыть чат"
                className="w-9 h-9 sm:w-7 sm:h-7 rounded-full hover:bg-white/[0.08] text-white/70 hover:text-white text-xl flex items-center justify-center shrink-0"
              >×</button>
              {/* Share dropdown */}
              {shareMenuOpen && (
                <div className="absolute right-2 top-full mt-1 w-52 rounded-xl bg-background/95 backdrop-blur-xl border border-white/15 shadow-2xl p-1.5 z-10">
                  <div className="text-[10px] text-white/50 px-2 py-1">Переслать диалог</div>
                  {(() => {
                    const text = encodeURIComponent(serializeChatForShare(chatMsgs));
                    const url = encodeURIComponent("https://muzaai.ru");
                    return (
                      <>
                        <a href={`https://t.me/share/url?url=${url}&text=${text}`} target="_blank" rel="noopener noreferrer"
                           onClick={() => setShareMenuOpen(false)}
                           className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/[0.06] text-[12px] text-white/90">
                          <span>📱</span> Telegram
                        </a>
                        <a href={`https://max.ru/share?url=${url}&text=${text}`} target="_blank" rel="noopener noreferrer"
                           onClick={() => setShareMenuOpen(false)}
                           className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/[0.06] text-[12px] text-white/90">
                          <span>💬</span> Max
                        </a>
                        {/* WhatsApp убран (Eugene 2026-05-14 Босс) */}
                        <button type="button"
                                onClick={async () => {
                                  try { await navigator.clipboard.writeText(serializeChatForShare(chatMsgs)); } catch {}
                                  setShareMenuOpen(false);
                                }}
                                className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/[0.06] text-[12px] text-white/90 text-left">
                          <span>📋</span> Скопировать текст
                        </button>
                      </>
                    );
                  })()}
                  <div className="border-t border-white/[0.06] mt-1 pt-1 px-2 pb-1 text-[9px] text-white/40 leading-tight">
                    Друг может отредактировать и переслать обратно — продолжишь разговор тут.
                  </div>
                </div>
              )}
            </div>
            {/* Eugene 2026-05-14 Босс «таблица с автором характеристик
                над плоскостью чата если соответствуют меню окна генерации».
                Показывается только если есть >= 1 поле. Слова — точно из /music. */}
            {(() => {
              const fields: Array<{ key: string; emoji: string; label: string; value?: string }> = [
                { key: "name", emoji: "👤", label: "Имя", value: chatMemo.name },
                { key: "occasion", emoji: "🎉", label: "Повод", value: chatMemo.occasion },
                { key: "recipient", emoji: "💝", label: "Кому", value: chatMemo.recipient },
                { key: "mood", emoji: "💫", label: "Настр", value: chatMemo.mood },
                { key: "style", emoji: "🎼", label: "Стиль", value: chatMemo.style },
                { key: "voiceType", emoji: "🎤", label: "Голос", value: chatMemo.voiceType },
                { key: "birthday", emoji: "🎂", label: "ДР", value: chatMemo.birthday },
              ];
              const filled = fields.filter(f => f.value);
              if (filled.length === 0) return null;
              return (
                <div className="px-2 py-1.5 border-b border-purple-400/20 bg-gradient-to-r from-purple-500/[0.08] via-blue-500/[0.06] to-cyan-500/[0.06] shrink-0">
                  <div className="flex items-center gap-1 flex-wrap">
                    {filled.map(f => (
                      <span key={f.key} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-white/[0.06] border border-purple-400/20" title={f.label}>
                        <span>{f.emoji}</span>
                        <span className="text-purple-300/70">{f.label}:</span>
                        <span className="font-medium text-white truncate max-w-[80px]">{f.value}</span>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}
            {/* History scroll
                Eugene 2026-05-15 Босс «надо немного поднимать последний текст
                вверх чата а то из-за ввода клиентом не видно». pb-8 → 32px
                отступ снизу, чтобы последнее сообщение не упиралось в input
                (особенно на мобилке когда клавиатура поднимает форму). */}
            <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-3 pt-3 pb-8 space-y-2 min-h-0 scroll-pb-8">
              {chatMsgs.length === 0 && (
                <div className="text-[11px] text-white/40 text-center py-4">Загружаю…</div>
              )}
              {/* «Показать ещё N» — Eugene 2026-05-14 Босс «3-4 видны + раскрыть 2+ раз»
                  Показываем последние visibleCount сообщений. Кнопка вверху подтягивает старые. */}
              {chatMsgs.length > visibleCount && (
                <div className="flex justify-center">
                  <button type="button"
                          onClick={() => setVisibleCount(c => c + 5)}
                          className="text-[11px] px-3 py-1 rounded-full bg-white/[0.06] hover:bg-white/[0.10] text-white/70 border border-white/[0.08]">
                    ↑ Показать ещё {Math.min(5, chatMsgs.length - visibleCount)} · всего {chatMsgs.length}
                  </button>
                </div>
              )}
              {chatMsgs.slice(-visibleCount).map((m, i, arr) => {
                // Eugene 2026-05-14 Босс v2 «облака повторно появляются только
                // в последнем сообщении». QR — только на последнем bot-msg.
                const isLastBot = i === arr.length - 1 && m.role === "bot";
                const showQR = isLastBot && m.quickReplies && m.quickReplies.length > 0;
                // Eugene 2026-05-18 Босс «inline-карточка регистрации».
                // Стабильный идентификатор сообщения для regCards state —
                // позиция в полном массиве chatMsgs (не в slice).
                const fullIdx = chatMsgs.length - arr.length + i;
                return (
                  <div key={i} className={`flex flex-col gap-1 ${m.role === "user" ? "items-end" : "items-start"}`}>
                    {/* Eugene 2026-05-14 Босс «исключаем в чате остальные имена.
                        Муза всегда. Муза всегда в градиенте цветов MuzaAi». */}
                    {m.role === "bot" && (
                      <div className="flex items-center gap-1 px-1 text-[11px] font-bold">
                        <span>🎵</span>
                        <span className="bg-gradient-to-r from-purple-300 via-violet-300 to-cyan-300 bg-clip-text text-transparent">Муза</span>
                      </div>
                    )}
                    {/* Eugene 2026-05-20 Босс «при нажатии сразу копировало
                        предыдущее». Tap на bubble → текст копируется в input
                        для редактирования. Tap на свой msg = его текст; tap на
                        bot-reply = текст предыдущего MOEГО сообщения (чтобы
                        задать тот же вопрос с правкой). */}
                    <div
                      onClick={() => {
                        let textToCopy = m.text;
                        if (m.role !== "user") {
                          // Найти предыдущее user-сообщение (искать назад от fullIdx)
                          for (let k = fullIdx - 1; k >= 0; k--) {
                            if (chatMsgs[k]?.role === "user") {
                              textToCopy = chatMsgs[k].text;
                              break;
                            }
                          }
                        }
                        setChatInput(textToCopy || "");
                        // Click click bonus: фокус на input после копирования
                        setTimeout(() => {
                          const ta = document.querySelector<HTMLTextAreaElement>('textarea[data-muza-chat-input]');
                          if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
                        }, 20);
                      }}
                      title="Нажми чтобы скопировать в поле ввода"
                      className={`max-w-[80%] px-3 py-2 rounded-2xl text-[13px] leading-relaxed whitespace-pre-wrap break-words cursor-pointer hover:brightness-110 transition-all ${
                      m.role === "user"
                        ? "bg-gradient-to-br from-purple-500/30 to-blue-500/25 text-white border border-purple-400/30"
                        : "bg-white/[0.06] text-white/90 border border-white/[0.08]"
                    }`}>{linkify(m.text).map((p, j) => p.href
                        ? <a key={j} href={p.href} target="_blank" rel="noopener noreferrer" className="underline text-cyan-300 hover:text-cyan-200" onClick={(e) => e.stopPropagation()}>{p.text}</a>
                        : <span key={j}>{p.text}</span>
                      )}</div>
                    {/* Eugene 2026-05-20 Босс «мини-плеер в чате».
                        Когда Муза вызвала find_public_track и tool вернул
                        hint=playNow:<id> — backend прикрепил attachedTrack.
                        Рендерим inline-карточку с persistent audio singleton.
                        autoPlay=true только для последнего bot-сообщения
                        (свежий ответ) — для history юзер сам нажмёт Play. */}
                    {m.role === "bot" && m.attachedTrack && (
                      <ChatTrackCard
                        track={m.attachedTrack}
                        autoPlay={i === arr.length - 1}
                      />
                    )}
                    {/* Eugene 2026-05-21 Босс Chat-tool-calling MVP.
                        Approval-карточка для платных tools (generate_lyrics /
                        create_music_job / publish_asset). По «Да» — шлём
                        confirm-сообщение в чат и LLM повторяет tool с
                        confirm_spend=true / confirm_publish=true. */}
                    {m.role === "bot" && m.pendingApproval && i === arr.length - 1 && (
                      <ChatApprovalCard
                        approval={m.pendingApproval}
                        onApprove={() => doSendMessage(`Да, подтверждаю ${m.pendingApproval!.tool}. Запускай (confirm_spend=true, confirm_publish=true).`)}
                        onCancel={() => doSendMessage("Нет, отмена. Не запускаем.")}
                      />
                    )}
                    {/* attachedJob — генерация юзера созданная через chat-tool.
                        Если processing — polling /api/generations/:id/status
                        каждые 7 сек. Когда done — встроенный audio player. */}
                    {m.role === "bot" && m.attachedJob && (
                      <ChatJobCard initial={m.attachedJob} autoPoll={i === arr.length - 1} />
                    )}
                    {/* Eugene 2026-05-17 Босс «резервные каналы при downtime».
                        Если LLM вернул fallback — показываем баннер с
                        альтернативами (Telegram / Max). Юзер не остаётся
                        без ответа: переходит в работающий канал одним кликом. */}
                    {m.role === "bot" && m.backupChannels && m.backupChannels.length > 0 && (
                      <div className="w-full max-w-[80%] mt-1 p-3 rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 via-purple-500/10 to-cyan-500/10">
                        <div className="flex items-center gap-2 mb-1.5 text-[11px] text-amber-200/90 font-semibold">
                          <span>⚠️</span>
                          <span>Чат временно недоступен</span>
                        </div>
                        <div className="text-[11px] text-white/70 mb-2">
                          Напишите нам в одном из мессенджеров — отвечу там быстро:
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {m.backupChannels.map((bc, bi) => (
                            <a
                              key={bi}
                              href={bc.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[12px] px-3 py-1.5 rounded-full bg-gradient-to-br from-purple-500/25 to-cyan-500/25 hover:from-purple-500/45 hover:to-cyan-500/45 text-white border border-purple-400/40 hover:border-purple-300/60 transition-colors shadow-md shadow-purple-500/10"
                              title={bc.hint}
                            >
                              {bc.id === "telegram" ? "✈️ " : bc.id === "max" ? "💬 " : "🔌 "}{bc.name}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Eugene 2026-05-18 Босс «чат → окно генерации с 3
                        кнопками». Когда Муза сигналит готовность ([PROPOSE_GEN])
                        — отрисовываем inline-карточку с выбором режима.
                        Подсветка предложенного mode purple-glow. Клик —
                        редирект в /music с pre-fill параметрами. */}
                    {m.role === "bot" && m.proposedGeneration && (
                      <div className="w-full max-w-[90%] mt-2 p-3 rounded-2xl glass-card border border-purple-400/30 bg-gradient-to-br from-purple-500/10 via-fuchsia-500/8 to-cyan-500/10 shadow-lg shadow-purple-500/10">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-base">🎵</span>
                          <span className="text-[12px] font-bold bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
                            Готовы создать? Я заполню форму
                          </span>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          {([
                            {
                              key: "audio" as const,
                              icon: "🎤",
                              label: "Аудио — голосом",
                              desc: "Надиктовать, я соберу текст",
                            },
                            {
                              key: "simple" as const,
                              icon: "✏️",
                              label: "Простой текст",
                              desc: "Короткое описание идеи",
                            },
                            {
                              key: "full" as const,
                              icon: "📜",
                              label: "Полная песня",
                              desc: "Свой текст + стиль + голос",
                            },
                          ]).map((opt) => {
                            const isProposed = m.proposedGeneration!.mode === opt.key;
                            return (
                              <button
                                key={opt.key}
                                type="button"
                                onClick={() => openGenerationWithMode(opt.key, m.proposedGeneration!)}
                                className={`flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all ${
                                  isProposed
                                    ? "bg-gradient-to-r from-purple-500/30 via-fuchsia-500/25 to-blue-500/25 border border-purple-400/60 shadow-[0_0_24px_rgba(124,58,237,0.35)] hover:shadow-[0_0_32px_rgba(124,58,237,0.5)]"
                                    : "bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] hover:border-purple-400/30"
                                }`}
                              >
                                <span className="text-xl shrink-0">{opt.icon}</span>
                                <div className="flex-1 min-w-0">
                                  <div className={`text-[12px] font-semibold ${isProposed ? "text-white" : "text-white/85"}`}>
                                    {opt.label}
                                    {isProposed && (
                                      <span className="ml-1.5 text-[10px] font-normal text-purple-200">· рекомендую</span>
                                    )}
                                  </div>
                                  <div className="text-[10px] text-white/55 mt-0.5 truncate">{opt.desc}</div>
                                </div>
                                <span className={`text-base shrink-0 ${isProposed ? "text-purple-200" : "text-white/30"}`}>→</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {/* Eugene 2026-05-18 Босс «Муза сохраняет тексты — UI часть».
                        Inline-карточка «Войти / Зарегистрироваться / Дать email»
                        появляется когда Муза вставила [PROPOSE_REGISTER] маркер
                        (см. extractProposedRegistration в routes.ts). Подсветка
                        опции «Войти» если в localStorage есть прошлый email. */}
                    {m.role === "bot" && m.proposedRegistration && (() => {
                      const pr = m.proposedRegistration!;
                      const rc = regCards[fullIdx] || { mode: "idle" as const, email: "" };
                      const hasLastLogin = !!lastLoginEmail();
                      const titleSafe = (pr.lyricsTitle || "Текст от Музы").slice(0, 80);
                      return (
                        <div className="w-full max-w-[90%] mt-2 p-3 rounded-2xl glass-card border border-purple-400/30 bg-gradient-to-br from-purple-500/10 via-fuchsia-500/8 to-cyan-500/10 shadow-lg shadow-purple-500/10">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-base">🎵</span>
                            <span className="text-[12px] font-bold bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
                              Чтобы сохранить «{titleSafe}» — выбери:
                            </span>
                          </div>
                          {rc.mode !== "email" && rc.mode !== "sent" && (
                            <div className="flex flex-col gap-1.5">
                              <button
                                type="button"
                                onClick={() => openRegistrationAction("login", pr)}
                                className={`flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all ${
                                  hasLastLogin
                                    ? "bg-gradient-to-r from-purple-500/30 via-fuchsia-500/25 to-blue-500/25 border border-purple-400/60 shadow-[0_0_24px_rgba(124,58,237,0.35)] hover:shadow-[0_0_32px_rgba(124,58,237,0.5)]"
                                    : "bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] hover:border-purple-400/30"
                                }`}
                              >
                                <span className="text-xl shrink-0">✏️</span>
                                <div className="flex-1 min-w-0">
                                  <div className={`text-[12px] font-semibold ${hasLastLogin ? "text-white" : "text-white/85"}`}>
                                    Войти
                                    {hasLastLogin && (
                                      <span className="ml-1.5 text-[10px] font-normal text-purple-200">· твой email есть</span>
                                    )}
                                  </div>
                                  <div className="text-[10px] text-white/55 mt-0.5 truncate">У меня уже есть кабинет</div>
                                </div>
                                <span className={`text-base shrink-0 ${hasLastLogin ? "text-purple-200" : "text-white/30"}`}>→</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => openRegistrationAction("register", pr)}
                                className="flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] hover:border-fuchsia-400/30"
                              >
                                <span className="text-xl shrink-0">💜</span>
                                <div className="flex-1 min-w-0">
                                  <div className="text-[12px] font-semibold text-white/85">Зарегистрироваться</div>
                                  <div className="text-[10px] text-white/55 mt-0.5 truncate">Сохраню в твой кабинет — бесплатно</div>
                                </div>
                                <span className="text-base shrink-0 text-white/30">→</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  trackRegClick("email_open", { reason: pr.reason });
                                  updateRegCard(fullIdx, { mode: "email", email: lastLoginEmail() || "", error: undefined });
                                }}
                                className="flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] hover:border-cyan-400/30"
                              >
                                <span className="text-xl shrink-0">📧</span>
                                <div className="flex-1 min-w-0">
                                  <div className="text-[12px] font-semibold text-white/85">Дать email</div>
                                  <div className="text-[10px] text-white/55 mt-0.5 truncate">Отправлю текст и код для восстановления</div>
                                </div>
                                <span className="text-base shrink-0 text-white/30">→</span>
                              </button>
                            </div>
                          )}
                          {rc.mode === "email" && (
                            <form
                              onSubmit={(ev) => {
                                ev.preventDefault();
                                const email = rc.email.trim();
                                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                                  updateRegCard(fullIdx, { error: "Email невалидный — проверь формат" });
                                  return;
                                }
                                sendAnonymousLyricsSave(fullIdx, pr, email);
                              }}
                              className="flex flex-col gap-2"
                            >
                              <label className="text-[11px] text-white/70">На какой email отправить?</label>
                              <input
                                type="email"
                                inputMode="email"
                                autoComplete="email"
                                value={rc.email}
                                onChange={(e) => updateRegCard(fullIdx, { email: e.target.value, error: undefined })}
                                placeholder="you@example.com"
                                className="bg-white/[0.07] text-[14px] text-white placeholder:text-white/40 px-3 py-2 rounded-lg border border-purple-400/25 focus:border-purple-400/60 focus:outline-none"
                                autoFocus
                                disabled={false}
                              />
                              {rc.error && (
                                <div className="text-[11px] text-rose-300">{rc.error}</div>
                              )}
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => updateRegCard(fullIdx, { mode: "idle", error: undefined })}
                                  className="text-[12px] px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/70 hover:text-white"
                                >
                                  ← Назад
                                </button>
                                <button
                                  type="submit"
                                  className="flex-1 text-[12px] font-semibold px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white shadow-[0_0_16px_rgba(124,58,237,0.4)] hover:shadow-[0_0_24px_rgba(124,58,237,0.6)] transition-shadow"
                                >
                                  Отправить
                                </button>
                              </div>
                            </form>
                          )}
                          {rc.mode === "sending" && (
                            <div className="text-[12px] text-purple-200 px-2 py-1.5">Отправляю…</div>
                          )}
                          {rc.mode === "sent" && (
                            <div className="flex flex-col gap-1.5">
                              <div className="text-[12px] text-emerald-300 font-medium">
                                {rc.emailSent ? "✓ Отправила на email" : "✓ Сохранила"}
                              </div>
                              <div className="text-[11px] text-white/70">
                                {rc.emailSent
                                  ? "Письмо со ссылкой регистрации уже у тебя. Код для восстановления:"
                                  : "Запомни код — он понадобится после регистрации (действует 30 дней):"}
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-[18px] font-mono font-bold tracking-[0.25em] text-white px-3 py-1.5 rounded-lg bg-white/[0.06] border border-purple-400/30">
                                  {rc.code}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    try {
                                      navigator.clipboard?.writeText(rc.code || "");
                                      trackRegClick("copy_code");
                                    } catch {}
                                  }}
                                  className="text-[11px] px-2.5 py-1 rounded-lg bg-white/[0.06] border border-white/[0.08] text-white/80 hover:text-white"
                                >
                                  📋 Копировать
                                </button>
                              </div>
                              <button
                                type="button"
                                onClick={() => openRegistrationAction("register", pr)}
                                className="text-[12px] font-semibold mt-1 px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-500/25 to-cyan-500/25 hover:from-purple-500/45 hover:to-cyan-500/45 border border-purple-400/40 text-white"
                              >
                                💜 Завершить регистрацию сейчас
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    {/* Eugene 2026-05-14 Босс: QR-кнопки кликабельны на ЛЮБОМ
                        bot-msg (повторное нажатие меняет выбор для дальнейшего). */}
                    {showQR && (
                      <div className="flex flex-wrap gap-1.5 justify-center w-full max-w-[95%] mx-auto">
                        {(m.quickReplies ?? []).map((qr, qi) => (
                          <button
                            key={qi}
                            type="button"
                            disabled={chatSending}
                            onClick={() => sendQuickReply(qr)}
                            style={{
                              // Eugene 2026-05-14 Босс «×2 медленнее, ускорять
                              // если человек быстрый». Adaptive stagger:
                              // slow=1400ms между / fast=700ms.
                              animation: `qrBalloon 800ms cubic-bezier(0.34, 1.56, 0.64, 1) backwards`,
                              animationDelay: `${qi * (userPaceRef.current === "fast" ? 700 : 1400)}ms`,
                            }}
                            className="text-[12px] px-3 py-1.5 rounded-full bg-gradient-to-br from-purple-500/15 to-blue-500/15 hover:from-purple-500/30 hover:to-blue-500/30 text-purple-200 hover:text-white border border-purple-400/30 hover:border-purple-400/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-purple-500/10"
                          >{qr}</button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {chatSending && (
                <div className="flex justify-start">
                  <div className="px-3 py-2 rounded-2xl bg-white/[0.06] text-white/70 text-[12px] border border-white/[0.08] flex items-center gap-1.5">
                    <img src="/consultant-avatar.png" alt="" className="w-5 h-5 rounded-full object-contain bg-white/5" onError={(e) => { (e.target as HTMLImageElement).src = "/consultant-avatar.svg"; }} />
                    <span className="inline-block animate-pulse font-medium">Муза…</span>
                  </div>
                </div>
              )}
            </div>
            {/* Quick-reply chips — Eugene 2026-05-18 Босс «убери облака с
                подсказками по умолчанию, оставь кнопку для появления».
                Показываются ТОЛЬКО по клику на «💡 Подсказки» в input area. */}
            {showSuggestions && chatMsgs.filter(m => m.role === "user").length === 0 && (
              <div className="px-3 py-2 border-t border-white/[0.04] shrink-0 bg-white/[0.015] animate-in fade-in slide-in-from-bottom-2 duration-200">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-[10px] text-white/40">Можно начать так:</div>
                  <button
                    type="button"
                    onClick={() => setShowSuggestions(false)}
                    className="text-[10px] text-white/40 hover:text-white/70 px-1"
                    aria-label="Скрыть подсказки"
                  >
                    ×
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {CHAT_SUGGESTIONS.map((s) => (
                    <button key={s} type="button"
                            onClick={() => { setChatInput(s); setShowSuggestions(false); }}
                            className="text-[11px] px-2.5 py-1 rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-white/80 border border-white/[0.10]">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Pair-code hint (top of input area) */}
            {!chatPaired && chatMsgs.length <= 1 && (
              <div className="px-3 py-1.5 text-[10px] text-white/40 border-t border-white/[0.04] bg-white/[0.02] shrink-0">
                💡 Есть код из Telegram/Max? Введи его — подтяну наш разговор оттуда.
              </div>
            )}
            {/* Eugene 2026-05-18 Босс «мини-плеер в чат — управление треком прямо
                из чата». Sticky между messages-area и input-area. Использует
                persistent <audio> singleton (Persistent-audio-only rule) и
                window.__muziaiTrack как источник track-меты. Контролы prev/next
                эмитят 'muza-player-action' — landing.tsx уже слушает. */}
            <ChatMiniPlayer />
            {/* Input — Eugene 2026-05-14 Босс «увеличение окно и шрифт ввода
                сообщение Музе». Шрифт 16px, padding больше, кнопка тоже
                крупнее — input area стала доминирующей. */}
            <form
              onSubmit={(e) => { e.preventDefault(); sendChat(); }}
              className="flex items-center gap-2 px-3 py-3 border-t border-white/[0.06] shrink-0 bg-background/60"
            >
              {/* Eugene 2026-05-18 Босс «оставь в чате кнопку с возможностью
                  появления подсказок». Toggle для quick-reply chips —
                  показываются только если юзер сам нажал. */}
              {chatMsgs.filter(m => m.role === "user").length === 0 && (
                <button
                  type="button"
                  onClick={() => setShowSuggestions(s => !s)}
                  className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-all border ${
                    showSuggestions
                      ? "bg-purple-500/20 border-purple-400/40 text-purple-200"
                      : "bg-white/[0.04] border-white/[0.08] text-white/50 hover:bg-white/[0.08] hover:text-white/80"
                  }`}
                  aria-label="Подсказки"
                  title="Подсказки для начала диалога"
                >
                  💡
                </button>
              )}
              {/* Eugene 2026-05-20 Босс «улучши возможность правки в диалоговом
                  окне не видно всю строку» — converted from <input type="text"> to
                  auto-resize <textarea>. Enter = send, Shift+Enter = новая строка.
                  Min 1 line (3.5rem), max 6 lines (visual cap, scroll внутри). */}
              <textarea
                data-muza-chat-input
                value={chatInput}
                onChange={(e) => {
                  // Eugene 2026-05-14 Босс «появление хотя бы одного символа
                  // в чате это /start». При первом символе после пустого
                  // input — engagement-event как маркер активности.
                  if (e.target.value.length === 1 && chatInput.length === 0) {
                    trackEngagement("consultant_action", { action: "chat_start_typing" });
                  }
                  setChatInput(e.target.value);
                  // Auto-resize: вернуть в auto, измерить scrollHeight, выставить
                  // height = min(scrollHeight, 6 lines * line-height ≈ 132px).
                  const ta = e.target as HTMLTextAreaElement;
                  ta.style.height = "auto";
                  ta.style.height = Math.min(ta.scrollHeight, 132) + "px";
                }}
                onKeyDown={(e) => {
                  // Enter без Shift = send (исторический паттерн single-line);
                  // Shift+Enter = новая строка (стандарт textarea). На мобиле
                  // virtual keyboard «Send» button тоже триггерит Enter — OK.
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (chatInput.trim() && !chatSending) {
                      const form = (e.target as HTMLElement).closest("form");
                      form?.requestSubmit();
                    }
                  }
                }}
                onFocus={() => {
                  // Eugene 2026-05-15 Босс «надо поднимать последний текст».
                  // На мобилке открытие клавиатуры скрывает последнее сообщение.
                  setTimeout(() => {
                    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
                  }, 50);
                  setTimeout(() => {
                    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
                  }, 350);
                }}
                placeholder={chatPaired ? "Продолжаем…" : "Сообщение Музе…"}
                maxLength={1500}
                // Eugene 2026-05-20 Босс «после отправки можно следующее писать».
                // disabled={chatSending} убран — юзер пишет след. сообщение
                // пока ждёт ответ LLM (fallback chain до 45 сек). Кнопка
                // submit остаётся disabled пока пред. не ответил, чтобы
                // избежать concurrent requests.
                rows={1}
                className="flex-1 min-w-0 bg-white/[0.07] text-[16px] text-white placeholder:text-white/40 px-4 py-3 rounded-xl border-2 border-purple-400/25 focus:border-purple-400/60 focus:outline-none disabled:opacity-50 font-medium resize-none leading-[1.4] min-h-[3.25rem] max-h-[8.25rem] overflow-y-auto"
                autoFocus
              />
              <button
                type="submit"
                disabled={!chatInput.trim() || chatSending}
                className="px-5 py-3.5 rounded-xl bg-gradient-to-r from-purple-500 to-blue-500 text-white text-[16px] font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:from-purple-600 hover:to-blue-600 transition-colors shrink-0 shadow-lg shadow-purple-500/20"
              >➤</button>
            </form>
            {/* Eugene 2026-05-14 Босс «кнопку ухожу и вернусь — внизу».
                Человечнее чем X в header — обещает возврат, Муза «помнит». */}
            <button
              type="button"
              onClick={() => setChatOpen(false)}
              className="w-full py-2.5 text-[12px] text-white/60 hover:text-white bg-white/[0.02] hover:bg-white/[0.05] border-t border-white/[0.04] transition-colors shrink-0"
            >👋 Ухожу, скоро вернусь</button>
          </div>
        </div>,
        document.body
      )}
      {/* Eugene 2026-05-17 Босс «техподдержка». */}
      <SupportModal
        open={supportOpen}
        onOpenChange={setSupportOpen}
        context={{ page: typeof window !== "undefined" ? window.location.hash : undefined }}
      />
    </div>
  );
}
