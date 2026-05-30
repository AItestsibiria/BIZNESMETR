/**
 * ScreenDebugOverlay — on-screen debug overlay для Босса на iPad (без DevTools).
 *
 * Активируется ТОЛЬКО когда:
 *   - localStorage["muzaai-screen-debug"] === "1"
 *   - ИЛИ URL содержит ?debug=1 (set'ит флаг автоматически)
 *
 * Слушает CustomEvent("muza:debug-log", { detail: string }) и показывает
 * последние 20 строк с timestamp в правом-верхнем углу через createPortal.
 *
 * Не виден prod-юзерам — пока флаг не set'нут.
 *
 * Eugene 2026-05-30 (5-й инцидент «летят к Земле»): Босс на iPad, без DevTools.
 * Нужен визуальный канал debug-логов прямо в UI. Brand-style: glass-card +
 * font-mono + brand-gradient.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type LogEntry = {
  id: number;
  ts: string;
  text: string;
};

const MAX_LINES = 20;

function nowHHMMSS(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function ScreenDebugOverlay() {
  const [enabled, setEnabled] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const idCounterRef = useRef(0);

  // Активация: ?debug=1 → set localStorage["muzaai-screen-debug"]="1" + reload
  // (чтобы все компоненты прочитали флаг свежим). Если флаг уже set — просто включаемся.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const param = url.searchParams.get("debug");
      if (param === "1") {
        const wasOff = window.localStorage.getItem("muzaai-screen-debug") !== "1";
        window.localStorage.setItem("muzaai-screen-debug", "1");
        window.localStorage.setItem("muzaai-click-debug", "1");
        // Уберём ?debug=1 из URL чтобы не мешал (без перезагрузки страницы).
        url.searchParams.delete("debug");
        window.history.replaceState({}, "", url.toString());
        setEnabled(true);
        // Если только что включили — сразу зальём приветственный лог
        if (wasOff) {
          idCounterRef.current += 1;
          setLogs([{ id: idCounterRef.current, ts: nowHHMMSS(), text: "[ScreenDebug] активирован через ?debug=1" }]);
        }
        return;
      }
      const flag = window.localStorage.getItem("muzaai-screen-debug");
      setEnabled(flag === "1");
    } catch {
      /* no-op */
    }
  }, []);

  // Подписка на CustomEvent("muza:debug-log")
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: Event) => {
      try {
        const ce = e as CustomEvent;
        const raw = ce.detail;
        const text =
          typeof raw === "string"
            ? raw
            : (() => {
                try {
                  return JSON.stringify(raw);
                } catch {
                  return String(raw);
                }
              })();
        idCounterRef.current += 1;
        const entry: LogEntry = { id: idCounterRef.current, ts: nowHHMMSS(), text };
        setLogs((prev) => {
          const next = [...prev, entry];
          if (next.length > MAX_LINES) next.splice(0, next.length - MAX_LINES);
          return next;
        });
      } catch {
        /* no-op */
      }
    };
    window.addEventListener("muza:debug-log", handler as EventListener);
    return () => {
      window.removeEventListener("muza:debug-log", handler as EventListener);
    };
  }, [enabled]);

  if (!enabled || typeof document === "undefined") return null;

  const handleClear = () => {
    setLogs([]);
  };

  const handleCopyAll = async () => {
    try {
      const text = logs.map((l) => `[${l.ts}] ${l.text}`).join("\n");
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // fallback для старых браузеров — textarea + execCommand
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } catch {
          /* no-op */
        }
        document.body.removeChild(ta);
      }
      idCounterRef.current += 1;
      setLogs((prev) => [
        ...prev.slice(-(MAX_LINES - 1)),
        { id: idCounterRef.current, ts: nowHHMMSS(), text: "[ScreenDebug] скопировано в буфер" },
      ]);
    } catch {
      /* no-op */
    }
  };

  const handleDisable = () => {
    try {
      window.localStorage.removeItem("muzaai-screen-debug");
      window.localStorage.removeItem("muzaai-click-debug");
    } catch {
      /* no-op */
    }
    setEnabled(false);
  };

  const overlay = (
    <div
      className="fixed top-2 right-2 z-[400] glass-card rounded-lg border border-purple-400/40 shadow-[0_0_24px_rgba(124,58,237,0.35)] pointer-events-auto"
      style={{
        width: collapsed ? "auto" : "min(360px, calc(100vw - 16px))",
        maxHeight: collapsed ? "auto" : "min(60dvh, 480px)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        background: "rgba(10, 10, 23, 0.78)",
      }}
      data-screen-debug="1"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-purple-400/20">
        <span className="font-display font-bold text-[11px] bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
          MuzaAi Debug
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-purple-400/30 text-purple-200/80 hover:bg-purple-500/10"
            aria-label={collapsed ? "Развернуть" : "Свернуть"}
          >
            {collapsed ? "▾" : "▴"}
          </button>
          <button
            onClick={handleDisable}
            className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-fuchsia-400/30 text-fuchsia-200/80 hover:bg-fuchsia-500/10"
            aria-label="Выключить debug"
            title="Выключить debug"
          >
            ✕
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Logs */}
          <div
            className="px-2 py-1 overflow-y-auto font-mono text-[10px] leading-tight text-cyan-100/90"
            style={{ maxHeight: "calc(min(60dvh, 480px) - 78px)" }}
          >
            {logs.length === 0 ? (
              <div className="text-purple-300/50 italic py-2">
                Ждём событий... (тапни планету / FAB / globe)
              </div>
            ) : (
              logs.map((l) => (
                <div key={l.id} className="py-0.5 border-b border-purple-400/10 last:border-b-0 break-words">
                  <span className="text-amber-300/70">[{l.ts}]</span>{" "}
                  <span>{l.text}</span>
                </div>
              ))
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-purple-400/20">
            <button
              onClick={handleClear}
              className="flex-1 text-[10px] font-mono px-2 py-1 rounded bg-purple-500/15 border border-purple-400/30 text-purple-100 hover:bg-purple-500/25 active:scale-95 transition"
            >
              Очистить
            </button>
            <button
              onClick={handleCopyAll}
              className="flex-1 text-[10px] font-mono px-2 py-1 rounded bg-gradient-to-r from-purple-500/20 via-fuchsia-500/20 to-cyan-500/20 border border-fuchsia-400/30 text-white hover:from-purple-500/35 hover:via-fuchsia-500/35 hover:to-cyan-500/35 active:scale-95 transition"
            >
              Скопировать всё ({logs.length})
            </button>
          </div>
        </>
      )}
    </div>
  );

  return createPortal(overlay, document.body);
}

export default ScreenDebugOverlay;
