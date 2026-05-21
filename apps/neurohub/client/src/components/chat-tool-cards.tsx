// Eugene 2026-05-21 Босс Chat-tool-calling MVP. Inline-карточки для tool flow:
//
//   ChatApprovalCard — рендерится когда платный tool (generate_lyrics /
//     create_music_job / publish_asset) вернул approval_required. Показывает
//     цену + параметры + 2 кнопки [Подтвердить] / [Отмена]. По клику шлёт
//     соответствующее текстовое сообщение в чат → LLM повторяет tool с
//     confirm_spend=true / confirm_publish=true.
//
//   ChatJobCard — рендерится когда attachedJob прикреплён к bot-сообщению
//     (после create_music_job / get_generation_status). Если status=processing
//     — polling GET /api/generations/:id/status каждые 7 сек. Когда done —
//     встроенный audio (через persistent player singleton + lock-screen rule).
//
// Brand-style consistency rule: glass-card + brand gradient, font-display
// для заголовков карточек, font-mono для цифр (cost / duration / job_id).

import { useCallback, useEffect, useRef, useState } from "react";

// === ChatApprovalCard ===
export type ChatApprovalData = {
  tool: string;
  estimated_cost_kopecks: number;
  estimated_cost_label: string;
  user_balance_label?: string;
  user_bonus_tracks?: number;
  params_preview?: any;
  message: string;
};

export type ChatApprovalCardProps = {
  approval: ChatApprovalData;
  onApprove: () => void;
  onCancel: () => void;
};

const TOOL_TITLES: Record<string, string> = {
  generate_lyrics: "Сгенерировать текст",
  rewrite_lyrics: "Переписать текст",
  create_music_job: "Создать музыкальный трек",
  publish_asset: "Опубликовать трек",
};

export function ChatApprovalCard({ approval, onApprove, onCancel }: ChatApprovalCardProps) {
  const [decided, setDecided] = useState(false);
  const title = TOOL_TITLES[approval.tool] || approval.tool;
  const preview = approval.params_preview || {};

  const fields = Object.entries(preview)
    .filter(([_k, v]) => v !== null && v !== undefined && v !== "")
    .slice(0, 6);

  const handleApprove = () => {
    if (decided) return;
    setDecided(true);
    onApprove();
  };
  const handleCancel = () => {
    if (decided) return;
    setDecided(true);
    onCancel();
  };

  return (
    <div className="w-full max-w-[80%] mt-1 p-3 rounded-2xl border border-amber-400/30 bg-gradient-to-br from-amber-500/10 via-purple-500/10 to-fuchsia-500/10 backdrop-blur-sm">
      <div className="flex items-center gap-2 mb-1.5 text-[12px] font-display font-bold">
        <span>💸</span>
        <span className="bg-gradient-to-r from-amber-300 to-fuchsia-300 bg-clip-text text-transparent">{title}</span>
      </div>
      <div className="text-[12px] text-white/85 leading-relaxed mb-2">
        {approval.message}
      </div>
      {fields.length > 0 && (
        <div className="text-[11px] text-white/65 mb-2 space-y-0.5">
          {fields.map(([k, v]) => (
            <div key={k} className="flex gap-1.5">
              <span className="text-white/45 capitalize">{k}:</span>
              <span className="text-white/80 truncate">
                {typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 100)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 mb-2 text-[11px]">
        <div className="text-white/60">
          {approval.user_balance_label && (
            <span>На балансе: <span className="font-mono text-white/85">{approval.user_balance_label}</span></span>
          )}
        </div>
        <div className="font-mono text-amber-300 font-bold">
          {approval.estimated_cost_label || (approval.estimated_cost_kopecks > 0 ? `${Math.round(approval.estimated_cost_kopecks / 100)} ₽` : "Бесплатно")}
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleApprove}
          disabled={decided}
          className="flex-1 text-[12px] px-3 py-2 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500 text-white font-semibold shadow-md shadow-emerald-500/20 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          ✓ Подтвердить
        </button>
        <button
          onClick={handleCancel}
          disabled={decided}
          className="flex-1 text-[12px] px-3 py-2 rounded-full bg-white/[0.06] border border-white/[0.12] text-white/70 hover:bg-white/[0.12] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          Отмена
        </button>
      </div>
    </div>
  );
}

// === ChatJobCard ===
export type ChatJobData = {
  jobId: number;
  type: string;
  status: string;
  title: string;
  audioUrl: string | null;
  coverUrl: string | null;
  lyricsPreview: string | null;
  durationSec: number;
  errorReason: string | null;
};

export type ChatJobCardProps = {
  initial: ChatJobData;
  /** Auto-poll status only for the most recent message (newest job). */
  autoPoll?: boolean;
};

const POLL_INTERVAL_MS = 7_000;
const POLL_MAX_ATTEMPTS = 60; // ≈ 7 минут — Suno делает 1-3 мин

export function ChatJobCard({ initial, autoPoll = false }: ChatJobCardProps) {
  const [job, setJob] = useState<ChatJobData>(initial);
  const attemptsRef = useRef(0);
  const intervalRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Polling: только если autoPoll + processing + music
  useEffect(() => {
    if (!autoPoll) return;
    if (job.status !== "processing" && job.status !== "pending") return;
    if (job.type !== "music") return; // lyrics/cover завершаются sync

    const tick = async () => {
      attemptsRef.current += 1;
      if (attemptsRef.current > POLL_MAX_ATTEMPTS) {
        stopPolling();
        return;
      }
      try {
        const token = (typeof window !== "undefined" && (localStorage.getItem("auth_token") || sessionStorage.getItem("auth_token"))) || "";
        const r = await fetch(`/api/generations/${job.jobId}/status`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!r.ok) return;
        const j = await r.json();
        if (!j || j.ok !== true) return;
        setJob((prev) => ({
          ...prev,
          status: String(j.status || prev.status),
          title: String(j.title || prev.title),
          audioUrl: typeof j.audioUrl === "string" ? j.audioUrl : prev.audioUrl,
          coverUrl: typeof j.coverUrl === "string" ? j.coverUrl : prev.coverUrl,
          lyricsPreview: typeof j.lyricsPreview === "string" ? j.lyricsPreview : prev.lyricsPreview,
          durationSec: Number(j.durationSec || prev.durationSec),
          errorReason: typeof j.errorReason === "string" ? j.errorReason : prev.errorReason,
        }));
        if (j.status === "done" || j.status === "error" || j.status === "cancelled") {
          stopPolling();
        }
      } catch {
        // network blip — try next tick
      }
    };

    // Первый tick через 3 сек (даём Suno время начать)
    const startTimeout = window.setTimeout(() => {
      tick();
      intervalRef.current = window.setInterval(tick, POLL_INTERVAL_MS);
    }, 3_000);

    return () => {
      window.clearTimeout(startTimeout);
      stopPolling();
    };
  }, [autoPoll, job.jobId, job.status, job.type, stopPolling]);

  const isProcessing = job.status === "processing" || job.status === "pending";
  const isDone = job.status === "done";
  const isError = job.status === "error" || job.status === "cancelled";

  const typeIcon =
    job.type === "music" ? "🎵" :
    job.type === "lyrics" ? "📝" :
    job.type === "cover" ? "🎨" :
    "✨";

  return (
    <div className="w-full max-w-[80%] mt-1 p-3 rounded-2xl border border-purple-400/30 bg-gradient-to-br from-purple-500/10 via-fuchsia-500/10 to-blue-500/10 backdrop-blur-sm">
      <div className="flex items-center gap-2 mb-1 text-[12px] font-display font-bold">
        <span>{typeIcon}</span>
        <span className="bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent truncate">
          {job.title}
        </span>
        <span className="ml-auto text-[10px] font-mono text-white/45">#{job.jobId}</span>
      </div>
      {isProcessing && (
        <div className="text-[11px] text-white/70 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <span>Генерируется… обычно 1-2 минуты</span>
        </div>
      )}
      {isDone && job.type === "music" && job.audioUrl && (
        <div className="mt-1.5">
          <audio
            src={job.audioUrl}
            controls
            preload="metadata"
            className="w-full h-9"
          />
          {job.coverUrl && (
            <a
              href={`/track/${job.jobId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-[11px] px-2.5 py-1 rounded-full bg-white/[0.06] border border-white/[0.12] text-white/70 hover:bg-white/[0.12]"
            >
              Открыть страницу трека →
            </a>
          )}
        </div>
      )}
      {isDone && job.type === "lyrics" && job.lyricsPreview && (
        <div className="mt-1 text-[12px] text-white/80 whitespace-pre-wrap leading-snug bg-black/15 rounded-lg p-2 border border-white/[0.06] font-sans">
          {job.lyricsPreview}
          {job.lyricsPreview.length >= 200 && <span className="text-white/45">…</span>}
        </div>
      )}
      {isDone && job.type === "cover" && job.coverUrl && (
        <img
          src={job.coverUrl}
          alt={job.title}
          className="mt-1.5 w-32 h-32 rounded-lg object-cover border border-white/[0.08]"
        />
      )}
      {isError && (
        <div className="text-[11px] text-red-300 mt-1">
          ⚠ {job.errorReason || "Что-то пошло не так. Баланс возвращён."}
        </div>
      )}
    </div>
  );
}
