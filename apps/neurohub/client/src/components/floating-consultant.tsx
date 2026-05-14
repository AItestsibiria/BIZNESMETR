// FloatingConsultant (Eugene 2026-05-11 v4): деловой стиль —
// менеджер 25-30 в пиджаке, с планшетом (намёк на работу/консультацию).
// Pastel MuziAi gradient. Открытые глаза, закрытый рот, прямая осанка.
// Минимум нот вокруг (1 акцентная) — для связи с музыкой.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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

// Eugene 2026-05-14 Босс: inline-чат с Музой на сайте + cross-channel pair-code.
type ChatMessage = { role: "user" | "bot"; text: string };

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

  const openChat = useCallback(async () => {
    setExpanded(false);
    setChatOpen(true);
    trackEngagement("consultant_action", { action: "open_chat" });
    if (chatInitialized.current) return;
    chatInitialized.current = true;
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
        const greeting: ChatMessage = { role: "bot", text: String(j.greeting || "Привет!") };
        setChatMsgs([...hist, greeting]);
      }
    } catch (e) {
      setChatMsgs([{ role: "bot", text: "Что-то с сетью — но я тут. Пробуй ещё раз через секунду 🎵" }]);
    }
  }, []);

  const sendChat = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || chatSending) return;
    const sid = ensureClientSessionId();
    setChatMsgs(m => [...m, { role: "user", text }]);
    setChatInput("");
    setChatSending(true);
    // Eugene 2026-05-14 Босс «не отвечает» — добавил AbortSignal timeout 20s
    // чтобы не зависало навсегда. Frontend гарантированно даст ответ юзеру.
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
        return;
      }
      const j = await r.json();
      if (j?.ok && j.reply) {
        setChatMsgs(m => [...m, { role: "bot", text: j.reply }]);
        if (j.paired) {
          setChatPaired({ channel: j.pairedFromChannel });
        }
      } else {
        setChatMsgs(m => [...m, { role: "bot", text: j?.error || "Что-то пошло не так — попробуйте ещё раз" }]);
      }
    } catch (e: any) {
      window.clearTimeout(timeoutId);
      const msg = e?.name === "AbortError"
        ? "Думаю слишком долго — наверное, провайдер сегодня медленный. Повторим?"
        : "Сеть подвисла — попробуйте через секунду";
      setChatMsgs(m => [...m, { role: "bot", text: msg }]);
    } finally {
      setChatSending(false);
    }
  }, [chatInput, chatSending]);

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
    // Listener для открытия извне (например с новости лендинга).
    const onOpen = () => {
      setVisible(true);
      setExpanded(true);
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
        {/* Compact tooltip */}
        {hovered && !expanded && !reaction && (
          <div className="absolute bottom-full right-0 mb-1.5 px-2.5 py-1 rounded-full bg-white/[0.07] backdrop-blur-md border border-white/15 text-[10px] text-white/85 whitespace-nowrap animate-in fade-in slide-in-from-bottom-1 duration-150">
            Чем помочь? 🎵
          </div>
        )}

        {/* Click reaction bubble — игровая деловая фраза при нажатии */}
        {reaction && (
          <div className="absolute bottom-full right-0 mb-1.5 px-3 py-1.5 rounded-2xl bg-gradient-to-br from-purple-500/30 to-blue-500/20 backdrop-blur-md border border-purple-400/40 text-[11px] text-white font-medium whitespace-nowrap animate-in fade-in slide-in-from-bottom-2 duration-200 shadow-lg shadow-purple-500/20">
            {reaction}
          </div>
        )}

        {/* Expanded — простое меню без новостей */}
        {expanded && (
          <div className="absolute bottom-full right-0 mb-2 w-48 p-2 rounded-xl bg-background/40 backdrop-blur-xl border border-white/10 animate-in fade-in slide-in-from-bottom-2 duration-200 shadow-lg">
            <div className="text-[10px] text-white/60 mb-1.5 px-1">Чем помочь?</div>
            {/* Eugene 2026-05-14 Босс: основная кнопка — чат прямо тут на сайте.
                Включая cross-channel pair-code из Telegram/Max. */}
            <button
              type="button"
              onClick={openChat}
              className="w-full flex items-center gap-2 px-2 py-2 rounded-lg bg-gradient-to-r from-purple-500/20 to-blue-500/20 hover:from-purple-500/30 hover:to-blue-500/30 transition-colors text-[12px] text-white text-left font-medium border border-purple-500/30 mb-1"
            >
              <span>💬</span> Чат со мной здесь
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
              <a
                href={`https://api.whatsapp.com/send?text=${encodeURIComponent("Привет! Порекомендую Музу — крутая в подборе песен под событие. Попробуй: https://t.me/Muziaipodari_bot")}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackEngagement("consultant_action", { action: "share_whatsapp" })}
                className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-white/[0.06] transition-colors text-[11px] text-white/80"
              >
                <span>💚</span> WhatsApp
              </a>
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
            // Eugene 2026-05-12: показываем reaction-bubble + открываем меню.
            // Каждое нажатие — новая фраза из массива (циклично).
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
          className="block w-16 h-24 sm:w-20 sm:h-32 active:scale-95 transition-transform opacity-90 hover:opacity-100 consultant-dance"
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
          {/* Полупрозрачный backdrop — клик закрывает. */}
          <div
            className="absolute inset-0 bg-black/40 pointer-events-auto"
            onClick={() => setChatOpen(false)}
          />
          {/* Drawer: на мобильном w=92vw drawer справа полная высота —
              «справа налево от правой границы». На десктопе 380×520 в углу. */}
          <div
            className="absolute right-0 bottom-0 top-0 sm:top-auto sm:bottom-4 sm:right-4 w-[92vw] max-w-[420px] sm:w-[380px] h-full sm:h-[520px] flex flex-col bg-background/95 backdrop-blur-xl border-l sm:border sm:rounded-2xl border-white/10 shadow-2xl shadow-purple-500/20 overflow-hidden pointer-events-auto animate-in slide-in-from-right duration-300"
          >
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-3 sm:py-2 border-b border-white/[0.06] bg-gradient-to-r from-purple-500/10 to-blue-500/5 shrink-0 relative">
              <img src="/consultant-avatar.svg" alt="Муза" className="w-9 h-9 sm:w-8 sm:h-8 rounded-full object-contain bg-white/5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-white truncate">
                  Муза{chatPersona ? ` · ${chatPersona.name}` : ""}
                  {chatPaired && (
                    <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-300 font-normal whitespace-nowrap">
                      {chatPaired.channel === "telegram" ? "📱 из Telegram" : chatPaired.channel === "max" ? "💬 из Max" : "✨ привязано"}
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-white/50 truncate">Подскажу с песней, темой, регистрацией</div>
              </div>
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
                        <a href={`https://api.whatsapp.com/send?text=${text}`} target="_blank" rel="noopener noreferrer"
                           onClick={() => setShareMenuOpen(false)}
                           className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/[0.06] text-[12px] text-white/90">
                          <span>💚</span> WhatsApp
                        </a>
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
              {chatMsgs.slice(-visibleCount).map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] px-3 py-2 rounded-2xl text-[13px] leading-relaxed whitespace-pre-wrap break-words ${
                    m.role === "user"
                      ? "bg-gradient-to-br from-purple-500/30 to-blue-500/25 text-white border border-purple-400/30"
                      : "bg-white/[0.06] text-white/90 border border-white/[0.08]"
                  }`}>{linkify(m.text).map((p, j) => p.href
                      ? <a key={j} href={p.href} target="_blank" rel="noopener noreferrer" className="underline text-cyan-300 hover:text-cyan-200">{p.text}</a>
                      : <span key={j}>{p.text}</span>
                    )}</div>
                </div>
              ))}
              {chatSending && (
                <div className="flex justify-start">
                  <div className="px-3 py-2 rounded-2xl bg-white/[0.06] text-white/60 text-[12px] border border-white/[0.08]">
                    <span className="inline-block animate-pulse">пишу…</span>
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
            {/* Input */}
            <form
              onSubmit={(e) => { e.preventDefault(); sendChat(); }}
              className="flex items-center gap-2 px-3 py-3 sm:py-2 border-t border-white/[0.06] shrink-0 bg-background/60"
            >
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder={chatPaired ? "Продолжаем…" : "Сообщение Музе…"}
                maxLength={1500}
                disabled={chatSending}
                className="flex-1 min-w-0 bg-white/[0.05] text-[14px] text-white placeholder:text-white/40 px-3 py-2.5 sm:py-2 rounded-xl border border-white/[0.08] focus:border-purple-400/40 focus:outline-none disabled:opacity-50"
                autoFocus
              />
              <button
                type="submit"
                disabled={!chatInput.trim() || chatSending}
                className="px-4 py-2.5 sm:py-2 rounded-xl bg-gradient-to-r from-purple-500 to-blue-500 text-white text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:from-purple-600 hover:to-blue-600 transition-colors shrink-0"
              >➤</button>
            </form>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
