// FloatingConsultant (Eugene 2026-05-11 v4): деловой стиль —
// менеджер 25-30 в пиджаке, с планшетом (намёк на работу/консультацию).
// Pastel MuzaAi gradient. Открытые глаза, закрытый рот, прямая осанка.
// Минимум нот вокруг (1 акцентная) — для связи с музыкой.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { playMuzaChime, playMuzaTick, playMuzaSparkle } from "../lib/muza-sounds";
import { onJourneyEvent } from "../lib/user-journey";
import { SupportModal } from "./support-modal";

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
// Mapping имени персоны на цвет — психотип определяет тон.
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
type ChatMessage = {
  role: "user" | "bot";
  text: string;
  quickReplies?: string[];
  // Eugene 2026-05-17 Босс «резервные каналы». Если LLM упал, бот ставит
  // backupChannels в последнее сообщение, фронт рендерит баннер под текстом.
  backupChannels?: BackupChannel[];
  // Eugene 2026-05-18 Босс «чат → окно генерации с 3 кнопками».
  proposedGeneration?: ProposedGeneration;
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

export function FloatingConsultant() {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [reaction, setReaction] = useState<string | null>(null);
  const reactionIdxRef = useRef(0);
  const reactionTimerRef = useRef<number | null>(null);
  const dismissedRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  // === Inline chat (Eugene 2026-05-14 Босс) ===
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMsgs, setChatMsgs] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  // Eugene 2026-05-18 Босс «убери облака с подсказками, но оставь в чате
  // кнопку с возможностью их появления». Default false — пустой чат без
  // подсказок. Юзер нажимает «💡 Подсказки» — появляются 4-5 chips.
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [chatPersona, setChatPersona] = useState<{ name: string; avatar: string } | null>(null);
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

  const initChatSession = useCallback(async () => {
    try {
      const sid = ensureClientSessionId();
      const r = await fetch("/api/muza/chat/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid }),
      });
      const j = await r.json();
      if (j?.ok) {
        if (j.persona) setChatPersona(j.persona);
        if (j.paired) setChatPaired({ channel: j.pairedFromChannel });
        const hist: ChatMessage[] = Array.isArray(j.history)
          ? j.history.map((h: any) => ({ role: h.role === "bot" ? "bot" : "user", text: h.text }))
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
    const timeoutId = window.setTimeout(() => ctrl.abort(), 20_000);
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
        setChatMsgs(m => [...m, {
          role: "bot",
          text: j.reply,
          backupChannels,
          proposedGeneration,
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

  return (
    <div
      className={`fixed z-30 bottom-3 right-3 sm:bottom-4 sm:right-4 transition-opacity duration-500 ${exiting ? "opacity-0 consultant-slide-out" : "opacity-100 consultant-slide-in animate-in fade-in"} ${smartHighlight ? "consultant-attention" : ""}`}
      data-testid="floating-consultant"
    >
      <div className="relative">
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
            className="absolute bottom-full right-0 mb-3 w-60 sm:w-64 p-2.5 bg-gradient-to-br from-purple-600/85 via-violet-600/80 to-blue-500/75 backdrop-blur-2xl border-2 border-purple-300/40 shadow-2xl shadow-purple-500/50 animate-in fade-in slide-in-from-bottom-2 duration-300 overflow-hidden"
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
            <div className="grid grid-cols-[1fr_auto] gap-2 mt-2">
              <button
                type="button"
                onClick={openChat}
                className="relative min-h-[44px] px-3 rounded-[40%_50%_45%_55%/50%_45%_55%_50%] bg-gradient-to-br from-white/35 via-white/25 to-white/15 hover:from-white/45 hover:via-white/35 hover:to-white/25 transition-all text-white text-[13px] font-semibold shadow-lg shadow-white/10 border-2 border-white/40 overflow-hidden group active:scale-95"
                aria-label="Открыть чат с Музой"
              >
                <span className="relative z-10 flex items-center justify-center gap-1.5">
                  <span className="text-base">💬</span>
                  <span>Чат</span>
                </span>
                <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" aria-hidden="true" />
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
          aria-label="Муза"
          className="block w-24 h-36 sm:w-28 sm:h-48 active:scale-95 transition-transform opacity-90 hover:opacity-100 consultant-dance"
        >
          <img
            src="/consultant-avatar.svg"
            alt="Муза"
            className="w-full h-full object-contain"
            draggable={false}
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
          <div
            className={`absolute w-[92vw] max-w-[420px] sm:w-[380px] flex flex-col bg-background/[0.18] backdrop-blur-md border-2 rounded-2xl border-purple-400/40 shadow-2xl shadow-purple-500/20 overflow-hidden pointer-events-auto animate-in fade-in duration-300 sm:!h-[460px] transition-all ${
              drawerSnap === "br" ? "right-0 bottom-0 sm:bottom-4 sm:right-4" :
              drawerSnap === "bl" ? "left-0 bottom-0 sm:bottom-4 sm:left-4" :
              drawerSnap === "tr" ? "right-0 top-20 sm:top-20 sm:right-4" :
              drawerSnap === "tl" ? "left-0 top-20 sm:top-20 sm:left-4" :
              "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
            }`}
            style={{
              height: "min(60vh, calc(100vh - 96px - env(safe-area-inset-bottom, 0px)))",
              marginBottom: drawerSnap === "br" || drawerSnap === "bl" ? "env(safe-area-inset-bottom, 0px)" : undefined,
            }}
          >
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
              <img src="/consultant-avatar.svg" alt="Муза" className="w-9 h-9 sm:w-8 sm:h-8 rounded-full object-contain bg-white/5 shrink-0" />
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
                    <div className={`max-w-[80%] px-3 py-2 rounded-2xl text-[13px] leading-relaxed whitespace-pre-wrap break-words ${
                      m.role === "user"
                        ? "bg-gradient-to-br from-purple-500/30 to-blue-500/25 text-white border border-purple-400/30"
                        : "bg-white/[0.06] text-white/90 border border-white/[0.08]"
                    }`}>{linkify(m.text).map((p, j) => p.href
                        ? <a key={j} href={p.href} target="_blank" rel="noopener noreferrer" className="underline text-cyan-300 hover:text-cyan-200">{p.text}</a>
                        : <span key={j}>{p.text}</span>
                      )}</div>
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
                    {/* Eugene 2026-05-14 Босс: QR-кнопки кликабельны на ЛЮБОМ
                        bot-msg (повторное нажатие меняет выбор для дальнейшего). */}
                    {showQR && (
                      <div className="flex flex-wrap gap-1.5 justify-center w-full max-w-[95%] mx-auto">
                        {m.quickReplies.map((qr, qi) => (
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
                    <img src="/consultant-avatar.svg" alt="" className="w-5 h-5 rounded-full object-contain bg-white/5" />
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
              <input
                type="text"
                value={chatInput}
                onChange={(e) => {
                  // Eugene 2026-05-14 Босс «появление хотя бы одного символа
                  // в чате это /start». При первом символе после пустого
                  // input — engagement-event как маркер активности.
                  if (e.target.value.length === 1 && chatInput.length === 0) {
                    trackEngagement("consultant_action", { action: "chat_start_typing" });
                  }
                  setChatInput(e.target.value);
                }}
                onFocus={() => {
                  // Eugene 2026-05-15 Босс «надо поднимать последний текст».
                  // На мобилке открытие клавиатуры скрывает последнее сообщение.
                  // 2 раза с задержкой — пока браузер не пересчитал layout.
                  setTimeout(() => {
                    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
                  }, 50);
                  setTimeout(() => {
                    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
                  }, 350);
                }}
                placeholder={chatPaired ? "Продолжаем…" : "Сообщение Музе…"}
                maxLength={1500}
                disabled={chatSending}
                className="flex-1 min-w-0 bg-white/[0.07] text-[16px] text-white placeholder:text-white/40 px-4 py-3.5 rounded-xl border-2 border-purple-400/25 focus:border-purple-400/60 focus:outline-none disabled:opacity-50 font-medium"
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
