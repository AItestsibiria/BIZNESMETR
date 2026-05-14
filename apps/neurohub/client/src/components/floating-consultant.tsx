// FloatingConsultant (Eugene 2026-05-11 v4): деловой стиль —
// менеджер 25-30 в пиджаке, с планшетом (намёк на работу/консультацию).
// Pastel MuziAi gradient. Открытые глаза, закрытый рот, прямая осанка.
// Минимум нот вокруг (1 акцентная) — для связи с музыкой.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { playMuzaChime, playMuzaTick, playMuzaSparkle } from "../lib/muza-sounds";

const REAPPEAR_MS = 60_000;
const APPEAR_DELAY_MS = 2500;
const MAX_DISMISS = 3;
const SS_KEY = "_helperDismissed";

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
type ChatMessage = { role: "user" | "bot"; text: string; quickReplies?: string[] };

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
  return `Разговор с Музой (MuziAi)\n${"━".repeat(20)}\n${lines.join("\n\n")}\n${"━".repeat(20)}\n\nХочешь продолжить? Открой https://muziai.ru и кликни на Музу.`;
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

  // Eugene 2026-05-14 Босс «при клике продолжай» — клик на quick-reply
  // chip = отправка этого варианта как user-message. После клика QR-кнопки
  // у последнего bot-message убираем (одноразовый выбор).
  const sendQuickReply = useCallback((variant: string) => {
    setChatInput(variant);
    // Убираем quickReplies у последнего bot-сообщения
    setChatMsgs(m => {
      if (m.length === 0) return m;
      const last = m[m.length - 1];
      if (last.role === "bot" && last.quickReplies) {
        return [...m.slice(0, -1), { ...last, quickReplies: undefined }];
      }
      return m;
    });
    // Отправка через timeout чтобы input обновился до sendChat
    setTimeout(() => {
      // sendChat использует chatInput через useCallback — закрытие
      // на старое значение если вызывать сразу. Через setTimeout state
      // успеет обновиться, либо sendChat прочитает текущий input.
      // Безопаснее — вызвать через ref на текущую функцию, но проще
      // дополнить параметром.
      // Решение: вызвать вручную fetch минуя sendChat.
      doSendMessage(variant);
    }, 0);
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
        setChatMsgs(m => [...m, {
          role: "bot",
          text: j.reply,
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
      if (dismissedRef.current < MAX_DISMISS) {
        timerRef.current = window.setTimeout(() => {
          setVisible(true);
        }, REAPPEAR_MS);
      }
    }, 350);
  };

  if (!visible) return null;

  return (
    <div
      className={`fixed z-30 bottom-3 right-3 sm:bottom-4 sm:right-4 ${exiting ? "consultant-slide-out" : "consultant-slide-in"}`}
      data-testid="floating-consultant"
    >
      <div className="relative">
        {/* Eugene 2026-05-14 Босс «при появлении облачко "заходи в чат
            креативить"». Появляется автоматически на 6 сек после mount —
            привлекает внимание. Hover тоже показывает. */}
        {!expanded && !reaction && !chatOpen && (
          <div className="absolute bottom-full right-0 mb-2 px-3 py-2 rounded-2xl rounded-br-sm bg-gradient-to-br from-purple-500/30 to-blue-500/25 backdrop-blur-md border border-purple-300/40 text-[12px] font-medium text-white whitespace-nowrap animate-in fade-in slide-in-from-bottom-2 duration-300 shadow-lg shadow-purple-500/20">
            Заходи в чат — креативить ✨
          </div>
        )}

        {/* Click reaction bubble — игровая деловая фраза при нажатии */}
        {reaction && (
          <div className="absolute bottom-full right-0 mb-1.5 px-3 py-1.5 rounded-2xl bg-gradient-to-br from-purple-500/30 to-blue-500/20 backdrop-blur-md border border-purple-400/40 text-[11px] text-white font-medium whitespace-nowrap animate-in fade-in slide-in-from-bottom-2 duration-200 shadow-lg shadow-purple-500/20">
            {reaction}
          </div>
        )}

        {/* Expanded меню «мечтательное облако» (Eugene 2026-05-14 Босс):
            Asymmetric organic shape вместо классического rect, brand-цвета
            MuziAi (purple→violet→blue→cyan), shimmer-glow, мини-chime. */}
        {expanded && (
          <div
            className="absolute bottom-full right-0 mb-3 w-64 sm:w-72 p-4 bg-gradient-to-br from-purple-600/85 via-violet-600/80 to-blue-500/75 backdrop-blur-2xl border-2 border-purple-300/40 shadow-2xl shadow-purple-500/50 animate-in fade-in slide-in-from-bottom-2 duration-300 overflow-hidden"
            style={{
              // Cloud-shape — асимметричные радиусы для мечтательной органики
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
                  <span className="bg-gradient-to-r from-purple-300 via-violet-200 to-blue-300 bg-clip-text text-transparent">Muzi</span><span className="bg-gradient-to-r from-blue-300 to-cyan-200 bg-clip-text text-transparent">Ai</span>
                  <span className="text-white/60 font-normal ml-1">· Муза тут</span>
                </div>
                <div className="text-[10px] text-white/50">Выбирайте как общаться 🚀</div>
              </div>
            </div>
            {/* Eugene 2026-05-14 Босс «прям побольше» — primary CTA полноширинная,
                с космо-glow градиентом и shimmer. */}
            <button
              type="button"
              onClick={openChat}
              className="relative w-full mb-2 px-3 py-3.5 rounded-xl bg-gradient-to-r from-purple-500 via-violet-500 to-blue-500 hover:from-purple-400 hover:via-violet-400 hover:to-blue-400 transition-all text-white text-[14px] font-semibold shadow-lg shadow-purple-500/30 border border-purple-300/30 overflow-hidden group"
            >
              <span className="relative z-10 flex items-center justify-center gap-2">
                <span className="text-lg">💬</span>
                <span>Чат со мной здесь</span>
                <span className="text-[10px] opacity-70">↗</span>
              </span>
              {/* Shimmer слой */}
              <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" aria-hidden="true" />
            </button>
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
            <button
              type="button"
              onClick={() => { trackEngagement("consultant_action", { action: "music" }); window.location.hash = "#/music"; }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90 text-left"
            >
              <span>🎵</span> Создать песню
            </button>
            <button
              type="button"
              onClick={() => { trackEngagement("consultant_action", { action: "register" }); window.location.hash = "#/register"; }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-[12px] text-white/90 text-left"
            >
              <span>🎁</span> Регистрация
            </button>
            <div className="border-t border-white/[0.04] my-1 pt-1">
              <div className="text-[10px] text-white/60 px-1 mb-1">📤 Порекомендовать Музу</div>
              <a
                href={`https://t.me/share/url?url=${encodeURIComponent("https://t.me/Muziaipodari_bot")}&text=${encodeURIComponent("Привет! Порекомендую Музу — крутая в подборе песен под событие. Попробуй: https://t.me/Muziaipodari_bot")}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackEngagement("consultant_action", { action: "share_telegram" })}
                className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-white/[0.06] transition-colors text-[11px] text-white/80"
              >
                <span>📱</span> Telegram
              </a>
              <a
                href={`https://max.ru/share?url=${encodeURIComponent("https://max.ru/id7017236261_bot")}&text=${encodeURIComponent("Привет! Порекомендую Музу — крутая в подборе песен под событие. Попробуй: https://max.ru/id7017236261_bot")}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackEngagement("consultant_action", { action: "share_max" })}
                className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-white/[0.06] transition-colors text-[11px] text-white/80"
              >
                <span>💬</span> Max
              </a>
              {/* WhatsApp убран (Eugene 2026-05-14 Босс «в меню убираем WhatsApp») */}
            </div>
            <button
              type="button"
              onClick={dismiss}
              className="w-full mt-2 px-3 py-2 rounded-lg bg-white/[0.04] text-[12px] text-white/70 hover:text-white hover:bg-white/[0.08] transition-colors border border-white/[0.06]"
            >
              Скрыть
            </button>
          </div>
        )}

        {/* Силуэт взрослой певицы с микрофоном.
            Минимум деталей лица, акцент на pose певицы.
            Pastel MuziAi gradient. */}
        <button
          type="button"
          onClick={() => {
            // Eugene 2026-05-14 Босс «любое нажатие перемещает в чат сразу с ней».
            // Раньше клик открывал expanded меню — теперь сразу openChat.
            // Reaction-bubble + chime + scale остаются.
            try { playMuzaChime(); } catch {}
            const phrase = CLICK_REACTIONS[reactionIdxRef.current % CLICK_REACTIONS.length];
            reactionIdxRef.current += 1;
            setReaction(phrase);
            if (reactionTimerRef.current) window.clearTimeout(reactionTimerRef.current);
            reactionTimerRef.current = window.setTimeout(() => setReaction(null), 2500);
            openChat();
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          aria-label="Муза"
          className="block w-32 h-48 sm:w-40 sm:h-64 active:scale-95 transition-transform opacity-90 hover:opacity-100 consultant-dance"
        >
          <img
            src="/consultant-avatar.svg"
            alt="Муза"
            className="w-full h-full object-contain"
            draggable={false}
          />
        </button>
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
            className="absolute right-0 bottom-0 sm:bottom-4 sm:right-4 w-[92vw] max-w-[420px] sm:w-[380px] flex flex-col bg-background/[0.18] backdrop-blur-md border-2 rounded-t-2xl sm:rounded-2xl border-purple-400/40 shadow-2xl shadow-purple-500/20 overflow-hidden pointer-events-auto animate-in slide-in-from-bottom-2 duration-300 sm:!h-[460px]"
            style={{
              // Eugene 2026-05-14 Босс «уменьши высоту чтобы кнопки главной
              // были доступны». Mobile 60vh (было 75vh), desktop 460px (было 520).
              height: "min(60vh, calc(100vh - 96px - env(safe-area-inset-bottom, 0px)))",
              marginBottom: "env(safe-area-inset-bottom, 0px)",
            }}
          >
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
              {/* Share — переслать диалог другу. Кнопка только когда есть что слать. */}
              {chatMsgs.length >= 2 && (
                <button
                  type="button"
                  onClick={() => setShareMenuOpen(s => !s)}
                  aria-label="Поделиться диалогом"
                  title="Поделиться диалогом"
                  className="w-9 h-9 sm:w-7 sm:h-7 rounded-full hover:bg-white/[0.08] text-white/70 hover:text-white text-base flex items-center justify-center shrink-0"
                >📤</button>
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
                    const url = encodeURIComponent("https://muziai.ru");
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
            {/* History scroll */}
            <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2 min-h-0">
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
                const isLastBot = i === arr.length - 1 && m.role === "bot";
                return (
                  <div key={i} className={`flex flex-col gap-1 ${m.role === "user" ? "items-end" : "items-start"}`}>
                    {/* Eugene 2026-05-14 Босс «исключаем в чате остальные имена.
                        Муза всегда. Муза всегда в градиенте цветов MuziAi». */}
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
                    {/* Eugene 2026-05-14 Босс «кнопки появляются как шарики
                        надуваются по смыслу посередине слева направо».
                        Stagger-animation: каждая через +200ms, scale-out → 1.
                        justify-center — посередине. */}
                    {isLastBot && m.quickReplies && m.quickReplies.length > 0 && (
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
            {/* Quick-reply chips — Eugene 2026-05-14: только пока юзер ещё не писал
                (или после приветствия Музы — 1 сообщение). Помогают разогнать диалог. */}
            {chatMsgs.length <= 2 && chatMsgs.filter(m => m.role === "user").length === 0 && (
              <div className="px-3 py-2 border-t border-white/[0.04] shrink-0 bg-white/[0.015]">
                <div className="text-[10px] text-white/40 mb-1.5">Можно начать так:</div>
                <div className="flex flex-wrap gap-1.5">
                  {CHAT_SUGGESTIONS.map((s) => (
                    <button key={s} type="button"
                            onClick={() => setChatInput(s)}
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
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
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
    </div>
  );
}
