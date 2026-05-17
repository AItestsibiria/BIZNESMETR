// Eugene 2026-05-17 Босс «Заведи кнопку техподдержка при нажатии открывается
// муза бот и фиксирует обращение и начинает решение».
//
// Большой support-chat overlay. Открывается из dashboard.tsx (кнопка
// «🆘 Техподдержка») и floating-consultant action menu. Внутри — диалог
// с Музой через тот же /api/muza/chat endpoint, что и стандартный чат.
// Отличается тем что заранее создан ticket в agent_handoffs (через
// /api/support/create-ticket) и юзер видит индикатор «Ticket #xxx · открыт».

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

type ChatMessage = { role: "user" | "bot"; text: string };

type TicketInfo = {
  ticketId: string;
  sessionId: string;
  subject: string;
  priority: "low" | "normal" | "high" | "urgent";
  firstMessage: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPriority?: "low" | "normal" | "high" | "urgent";
  initialSubject?: string;
  context?: { page?: string; currentTrackId?: number };
};

function ensureSessionId(): string {
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

export function SupportModal({
  open,
  onOpenChange,
  initialPriority = "normal",
  initialSubject,
  context,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [ticket, setTicket] = useState<TicketInfo | null>(null);
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLabel, setStatusLabel] = useState("открыт · Муза работает");
  const scrollRef = useRef<HTMLDivElement>(null);
  const createdRef = useRef(false);

  // Auto-scroll on new message
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [msgs.length]);

  // Создать ticket при первом открытии модалки.
  useEffect(() => {
    if (!open || createdRef.current) return;
    createdRef.current = true;
    setCreating(true);
    setError(null);
    const sessionId = ensureSessionId();
    fetch("/api/support/create-ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        channel: "web",
        subject: initialSubject,
        priority: initialPriority,
        page: context?.page || (typeof window !== "undefined" ? window.location.hash : ""),
        currentTrackId: context?.currentTrackId,
      }),
    })
      .then(r => r.json())
      .then(j => {
        if (j?.data?.ticketId) {
          setTicket(j.data);
          setMsgs([{ role: "bot", text: j.data.firstMessage }]);
        } else {
          setError(j?.error || "Не удалось создать обращение");
        }
      })
      .catch(e => {
        setError(e?.message || "Сеть подвисла. Попробуйте ещё раз.");
      })
      .finally(() => setCreating(false));
  }, [open, initialPriority, initialSubject, context]);

  // Сброс состояния при закрытии (чтобы при повторном открытии создавался новый ticket).
  useEffect(() => {
    if (!open) {
      createdRef.current = false;
      setTicket(null);
      setMsgs([]);
      setInput("");
      setSending(false);
      setError(null);
      setStatusLabel("открыт · Муза работает");
    }
  }, [open]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !ticket) return;
    setMsgs(m => [...m, { role: "user", text }]);
    setInput("");
    setSending(true);
    const ctrl = new AbortController();
    const tid = window.setTimeout(() => ctrl.abort(), 25_000);
    try {
      const r = await fetch("/api/muza/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId: ticket.sessionId.replace(/^web:/, ""),
        }),
        signal: ctrl.signal,
      });
      window.clearTimeout(tid);
      if (!r.ok) {
        setMsgs(m => [...m, { role: "bot", text: `Сервер ответил ${r.status}. Попробуйте ещё раз — я тут.` }]);
        return;
      }
      const j = await r.json();
      if (j?.ok && j.reply) {
        setMsgs(m => [...m, { role: "bot", text: j.reply }]);
        // Если бот указал на эскалацию (вызвал escalate_to_admin) — переключим лейбл.
        if (typeof j.reply === "string" && /Передала Боссу|передал.*адми|эскалировал/i.test(j.reply)) {
          setStatusLabel("передано админу");
        }
      } else {
        setMsgs(m => [...m, { role: "bot", text: j?.error || "Не получилось обработать ваше сообщение." }]);
      }
    } catch (e: any) {
      window.clearTimeout(tid);
      setMsgs(m => [...m, {
        role: "bot",
        text: e?.name === "AbortError"
          ? "Долго отвечаю — провайдер задумался. Повторим?"
          : "Сеть подвисла — попробуйте ещё раз.",
      }]);
    } finally {
      setSending(false);
    }
  }, [input, sending, ticket]);

  const copyTranscript = useCallback(() => {
    const text = msgs.map(m => `${m.role === "user" ? "Вы" : "Муза"}: ${m.text}`).join("\n\n");
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById("support-copy-btn");
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = "✅ Скопировано";
        setTimeout(() => { btn.textContent = orig || "📋 Скопировать переписку"; }, 1500);
      }
    }).catch(() => {});
  }, [msgs]);

  const markResolved = useCallback(async () => {
    if (!ticket) return;
    try {
      const r = await fetch(`/api/support/my-tickets`, { method: "GET" });
      // Юзер закрывает сам — отправим сообщение «Решено, спасибо!» в чат, бот вызовет resolve_ticket.
      if (r) {
        setInput("Спасибо, у меня всё решилось!");
        setTimeout(() => sendMessage(), 0);
      }
    } catch {}
    setStatusLabel("ожидает закрытия Музой");
  }, [ticket, sendMessage]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl w-[95vw] sm:w-full p-0 overflow-hidden border border-purple-500/30 bg-gradient-to-br from-[#0a0a17]/95 via-[#1a0f2e]/95 to-[#0a0a17]/95 backdrop-blur-xl"
      >
        <DialogHeader className="p-5 pb-3 border-b border-white/10">
          <DialogTitle className="font-display font-bold text-2xl bg-gradient-to-r from-purple-400 via-fuchsia-400 to-blue-400 bg-clip-text text-transparent">
            🆘 Техподдержка
          </DialogTitle>
          <DialogDescription className="text-sm font-sans text-white/60">
            Муза подключилась — расскажите что случилось. Если потребуется, передам Боссу.
          </DialogDescription>
          {ticket ? (
            <div className="flex items-center gap-2 text-xs font-mono text-purple-300/80 mt-1">
              <span className="px-2 py-0.5 rounded-full bg-purple-500/15 border border-purple-500/30">
                Ticket #{ticket.ticketId.slice(0, 8)}
              </span>
              <span>·</span>
              <span>{statusLabel}</span>
            </div>
          ) : null}
        </DialogHeader>

        <div className="flex flex-col" style={{ minHeight: "60vh" }}>
          {/* Chat area */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-4 space-y-3"
            style={{ maxHeight: "calc(70vh - 200px)" }}
          >
            {creating ? (
              <div className="flex items-center gap-2 text-white/60 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Создаю обращение…</span>
              </div>
            ) : null}
            {error ? (
              <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 px-3 py-2 text-sm text-rose-200">
                {error}
              </div>
            ) : null}
            {msgs.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[80%] rounded-2xl rounded-br-md px-4 py-2 bg-gradient-to-br from-purple-500/30 to-fuchsia-500/20 border border-purple-400/30 text-white text-sm font-sans"
                      : "max-w-[80%] rounded-2xl rounded-bl-md px-4 py-2 bg-white/[0.04] border border-white/10 text-white/90 text-sm font-sans"
                  }
                >
                  {m.text.split("\n").map((line, j) => (
                    <div key={j}>{line}</div>
                  ))}
                </div>
              </div>
            ))}
            {sending ? (
              <div className="flex items-center gap-2 text-white/50 text-xs">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Муза печатает…</span>
              </div>
            ) : null}
          </div>

          {/* Input area */}
          <div className="p-4 border-t border-white/10 space-y-3">
            <div className="flex gap-2">
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                placeholder="Опишите вашу ситуацию…"
                disabled={!ticket || sending}
                className="flex-1 input-glow bg-white/[0.03] border border-purple-500/20 rounded-xl px-4 py-2 text-white text-sm font-sans placeholder:text-white/30 focus:outline-none focus:border-purple-400/50"
              />
              <Button
                onClick={sendMessage}
                disabled={!ticket || sending || !input.trim()}
                className="bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 hover:opacity-90 shadow-[0_0_24px_rgba(124,58,237,0.4)] border-0 text-white font-sans"
              >
                Отправить
              </Button>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <button
                id="support-copy-btn"
                onClick={copyTranscript}
                disabled={msgs.length === 0}
                className="px-3 py-1.5 rounded-lg bg-white/5 border border-purple-400/20 hover:bg-purple-500/20 text-purple-200 font-sans transition-colors disabled:opacity-40"
              >
                📋 Скопировать переписку
              </button>
              <button
                onClick={markResolved}
                disabled={!ticket}
                className="px-3 py-1.5 rounded-lg bg-white/5 border border-emerald-400/20 hover:bg-emerald-500/20 text-emerald-200 font-sans transition-colors disabled:opacity-40"
              >
                ✅ Решено
              </button>
              <button
                onClick={() => onOpenChange(false)}
                className="ml-auto px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white/70 font-sans transition-colors"
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SupportModal;
