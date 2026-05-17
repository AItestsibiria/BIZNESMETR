// v304 component: MusaVoiceFab (Eugene 2026-05-17 Босс «голос Музы доступен
// со всех admin вкладок как Floating Action Button»).
//
// Это FAB-обёртка над уже работающим голосовым диалогом (был блоком в
// master-dashboard-tab.tsx до 2026-05-17). Логика записи / upload / TTS /
// history идентична — отличие только в визуальной форме:
//   - idle: круглая кнопка fixed bottom-right с нежной pulse-glow
//   - click: разворачивается mini-panel с recording UI + result drawer
//   - все states (recording / uploading / thinking / playing) — тот же
//     pipeline, тот же endpoint /api/admin/v304/voice-command
//
// Reuse-working-solutions rule: backend остаётся как был — fab вызывает
// тот же endpoint, не плодим параллельный код.
//
// Стиль (brand-style consistency rule):
//   - gradient purple→fuchsia→cyan (brand primary)
//   - glass-card для разворачиваемой панели
//   - font-sans для body, font-display для title
//
// Mobile-friendly: на mobile сдвинут чуть выше (bottom-20) чтобы не мешать
// нижней навигации, кнопка слегка меньше.

import { useState, useEffect, useRef, useCallback } from "react";
import { registerAudio } from "@/lib/audio-bus";

type VoiceAction = {
  tool: string;
  input: unknown;
  result: string;
};

type VoiceCommandResult = {
  transcript: string;
  response: string;
  actions: VoiceAction[];
  audioBase64?: string;
  audioContentType?: string;
  meta?: {
    durationMs?: number;
    usage?: { inputTokens: number; outputTokens: number };
    ttsRequested?: boolean;
  };
};

type RecentVoiceItem = {
  id: number;
  adminUserId: number | null;
  createdAt: string;
  transcript: string;
  response: string;
  actions: VoiceAction[];
  durationMs?: number;
};

function base64ToBlob(b64: string, contentType: string): Blob {
  const byteChars = atob(b64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: contentType });
}

export function MusaVoiceFab() {
  const [state, setState] = useState<"idle" | "recording" | "uploading" | "thinking" | "playing">(
    "idle",
  );
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VoiceCommandResult | null>(null);
  const [history, setHistory] = useState<RecentVoiceItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [autoTts, setAutoTts] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("voice-command-tts") !== "0";
  });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const autoStopTimerRef = useRef<number | null>(null);
  // Eugene 2026-05-17: Web Speech API path (iOS Safari Siri-engine + Chrome
  // Google STT) — браузер сам распознаёт речь, минуем MediaRecorder.
  // Решает «запись слишком короткая» — нет blob-threshold.
  const speechRecRef = useRef<any>(null);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/v304/voice-command/recent?limit=5", {
        credentials: "include",
      });
      if (!r.ok) return;
      const j = await r.json();
      setHistory(j?.data?.items || []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (open) loadHistory();
  }, [open, loadHistory]);

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      streamRef.current = null;
    }
    if (autoStopTimerRef.current) {
      window.clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      } catch {
        /* ignore */
      }
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    if (state === "playing") setState("idle");
  }, [state]);

  useEffect(() => {
    return () => {
      cleanupStream();
      stopPlayback();
    };
  }, [cleanupStream, stopPlayback]);

  const handleAutoTtsChange = (on: boolean) => {
    setAutoTts(on);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("voice-command-tts", on ? "1" : "0");
    }
  };

  const handleVoiceResult = useCallback(
    async (data: VoiceCommandResult) => {
      setResult(data);
      loadHistory();
      try {
        for (const a of data.actions || []) {
          if (a.tool !== "focus_brain_node") continue;
          const inp = a.input as { name?: string } | undefined;
          const fromInput = inp?.name?.trim();
          const fromResult = (() => {
            const m = String(a.result || "").match(/\[FOCUS_BRAIN_NODE:([^\]]+)\]/);
            return m ? m[1].trim() : null;
          })();
          const name = fromInput || fromResult;
          if (name) {
            window.dispatchEvent(new CustomEvent("brain-focus-node", { detail: { name } }));
          }
        }
      } catch {/* ignore */}
      if (data.audioBase64 && data.audioContentType) {
        const audioBlob = base64ToBlob(data.audioBase64, data.audioContentType);
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        const audioUrl = URL.createObjectURL(audioBlob);
        blobUrlRef.current = audioUrl;
        const audio = new Audio(audioUrl);
        registerAudio(audio);
        audioRef.current = audio;
        audio.onended = () => {
          setState("idle");
          if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
        };
        audio.onerror = () => { setState("idle"); setError("Ошибка воспроизведения mp3"); };
        setState("playing");
        await audio.play().catch((e) => { console.warn("auto-play blocked", e); setState("idle"); });
      } else {
        setState("idle");
      }
    },
    [loadHistory],
  );

  // Eugene 2026-05-17: text-only path для Web Speech API.
  // Минует STT — браузер уже распознал, шлём только transcript.
  const uploadTranscript = useCallback(
    async (transcript: string) => {
      setState("thinking");
      try {
        const url = `/api/admin/v304/voice-command-text${autoTts ? "?tts=1" : ""}`;
        const r = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript }),
        });
        if (!r.ok) {
          const tx = await r.text().catch(() => "");
          let err = tx.slice(0, 200);
          try { const j = JSON.parse(tx); if (j?.error) err = j.error; } catch {/* ignore */}
          throw new Error(`${r.status}: ${err}`);
        }
        const j = await r.json();
        await handleVoiceResult(j.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState("idle");
      }
    },
    [autoTts, handleVoiceResult],
  );

  const uploadAudio = useCallback(
    async (blob: Blob) => {
      setState("uploading");
      try {
        const fd = new FormData();
        fd.append("audio", blob, "voice.webm");
        const url = `/api/admin/v304/voice-command${autoTts ? "?tts=1" : ""}`;
        const r = await fetch(url, {
          method: "POST",
          credentials: "include",
          body: fd,
        });
        if (!r.ok) {
          const tx = await r.text().catch(() => "");
          let err = tx.slice(0, 200);
          try {
            const j = JSON.parse(tx);
            if (j?.error) err = j.error;
          } catch {
            /* ignore */
          }
          throw new Error(`${r.status}: ${err}`);
        }
        setState("thinking");
        const j = await r.json();
        const data: VoiceCommandResult = j.data;
        setResult(data);
        loadHistory();
        // focus_brain_node integration (Eugene 2026-05-17 Босс): если LLM
        // вызвала tool focus_brain_node, парсим имя узла и эмитим
        // CustomEvent — SecondBrain3D компонент его ловит и подъезжает
        // камерой. Marker: [FOCUS_BRAIN_NODE:<name>] в result строке.
        try {
          for (const a of data.actions || []) {
            if (a.tool !== "focus_brain_node") continue;
            const inp = a.input as { name?: string } | undefined;
            const fromInput = inp?.name?.trim();
            const fromResult = (() => {
              const m = String(a.result || "").match(/\[FOCUS_BRAIN_NODE:([^\]]+)\]/);
              return m ? m[1].trim() : null;
            })();
            const name = fromInput || fromResult;
            if (name) {
              window.dispatchEvent(
                new CustomEvent("brain-focus-node", { detail: { name } }),
              );
            }
          }
        } catch {
          /* ignore — non-fatal UI integration */
        }
        if (data.audioBase64 && data.audioContentType) {
          const audioBlob = base64ToBlob(data.audioBase64, data.audioContentType);
          if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
          const audioUrl = URL.createObjectURL(audioBlob);
          blobUrlRef.current = audioUrl;
          const audio = new Audio(audioUrl);
          registerAudio(audio);
          audioRef.current = audio;
          audio.onended = () => {
            setState("idle");
            if (blobUrlRef.current) {
              URL.revokeObjectURL(blobUrlRef.current);
              blobUrlRef.current = null;
            }
          };
          audio.onerror = () => {
            setState("idle");
            setError("Ошибка воспроизведения mp3");
          };
          setState("playing");
          await audio.play().catch((e) => {
            console.warn("auto-play blocked", e);
            setState("idle");
          });
        } else {
          setState("idle");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState("idle");
      }
    },
    [autoTts, loadHistory],
  );

  const startRecording = useCallback(async () => {
    setError(null);
    setResult(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Браузер не поддерживает запись микрофона.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const msg =
        e instanceof Error && e.name === "NotAllowedError"
          ? "Разреши доступ к микрофону (значок 🎤 в адресной строке)."
          : e instanceof Error
            ? e.message
            : String(e);
      setError(msg);
      return;
    }
    streamRef.current = stream;
    // Eugene 2026-05-17: iOS Safari не поддерживает audio/webm — пишет
    // audio/mp4. Добавили chain fallback. Backend (transcribe.ts) принимает
    // оба через ffmpeg.
    let recorder: MediaRecorder;
    let pickedMime = "";
    try {
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/mp4;codecs=mp4a.40.2",
        "audio/aac",
      ];
      pickedMime = candidates.find(m => {
        try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
      }) || "";
      recorder = pickedMime
        ? new MediaRecorder(stream, { mimeType: pickedMime })
        : new MediaRecorder(stream);
      // eslint-disable-next-line no-console
      console.log("[voice-fab] mimeType:", pickedMime || "default", "/ recorder.state:", recorder.state);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[voice-fab] MediaRecorder ctor failed:", e);
      recorder = new MediaRecorder(stream);
    }
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      cleanupStream();
      // Eugene 2026-05-17: blob.type должен совпадать с реально использованным
      // mimeType (Safari = audio/mp4, Chrome = audio/webm). Иначе backend
      // ffmpeg попробует распарсить mp4 как webm и упадёт.
      const blobMime = pickedMime || recorder.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: blobMime });
      // eslint-disable-next-line no-console
      console.log("[voice-fab] blob size:", blob.size, "mime:", blobMime);
      chunksRef.current = [];
      // Eugene 2026-05-17: снизил threshold с 500 → 200 байт (≈0.3 сек),
      // 1 сек был слишком строгим — короткие команды «доложи» / «открой»
      // легко не дотягивают. Сейчас отсекает только случайные click без речи.
      if (blob.size < 200) {
        setError("Запись очень короткая. Удерживай кнопку дольше — скажи фразу полностью.");
        setState("idle");
        return;
      }
      await uploadAudio(blob);
    };
    recorder.start(250);
    setState("recording");
    (window as any).__voiceRecordStartAt = Date.now();
    autoStopTimerRef.current = window.setTimeout(() => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
    }, 60_000);
  }, [cleanupStream, uploadAudio]);

  // Eugene 2026-05-17: Web Speech API primary path — браузер сам распознаёт.
  // Если поддерживается — используем (no MediaRecorder, no STT server-side).
  // Fallback на startRecording если SpeechRecognition недоступен.
  const startSpeechRecognition = useCallback((): boolean => {
    if (typeof window === "undefined") return false;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return false;
    setError(null);
    setResult(null);
    try {
      const rec = new SR();
      rec.lang = "ru-RU";
      rec.interimResults = false;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      let finalTranscript = "";
      rec.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalTranscript += r[0].transcript;
        }
      };
      rec.onerror = (e: any) => {
        console.warn("[voice-fab] SpeechRecognition error:", e?.error);
        // not-allowed / no-speech — показываем readable error
        if (e?.error === "no-speech") {
          setError("Не услышал речь — скажи чётче, ближе к микрофону.");
          setState("idle");
        } else if (e?.error === "not-allowed") {
          setError("Разреши доступ к микрофону (значок 🎤 в адресной строке).");
          setState("idle");
        } else if (e?.error === "audio-capture") {
          // Аппаратная проблема — fallback на MediaRecorder
          startRecording();
        } else {
          setError(`SpeechRecognition: ${e?.error || "unknown"}`);
          setState("idle");
        }
      };
      rec.onend = () => {
        const t = finalTranscript.trim();
        if (t) {
          uploadTranscript(t);
        } else if (state === "recording") {
          setState("idle");
        }
      };
      speechRecRef.current = rec;
      rec.start();
      setState("recording");
      return true;
    } catch (e) {
      console.warn("[voice-fab] SpeechRecognition init failed:", e);
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadTranscript, state]);

  const stopSpeechRecognition = useCallback(() => {
    try {
      if (speechRecRef.current) {
        speechRecRef.current.stop();
        speechRecRef.current = null;
      }
    } catch {/* ignore */}
  }, []);

  const stopRecording = useCallback(() => {
    // Eugene 2026-05-17: защита от тапа дважды слишком быстро. iOS Safari
    // MediaRecorder.start() имеет задержку ~300-500ms перед первым chunk.
    // Если stop вызван слишком быстро — blob пустой → "запись короткая".
    const startedAt = (window as any).__voiceRecordStartAt || 0;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs < 800) {
      // Откладываем stop ещё на остаток до 800ms
      window.setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
          mediaRecorderRef.current.stop();
          setState("uploading");
        }
      }, 800 - elapsedMs);
      return;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      setState("uploading");
    }
  }, []);

  const onMicClick = () => {
    if (state === "idle") {
      if (!open) setOpen(true);
      // Eugene 2026-05-17: пробуем Web Speech API первым — на iOS Safari
      // и Chrome работает stabильно. Только если не поддерживается —
      // fallback на MediaRecorder + сервер STT.
      if (!startSpeechRecognition()) {
        startRecording();
      }
    } else if (state === "recording") {
      // Сначала остановим Web Speech (если активен) — он сам отправит
      // transcript через onend. Если был MediaRecorder — остановим его.
      if (speechRecRef.current) {
        stopSpeechRecognition();
        setState("uploading");
      } else {
        stopRecording();
      }
    } else if (state === "playing") {
      stopPlayback();
    }
  };

  const stateLabel =
    state === "recording"
      ? "🔴 Слушает..."
      : state === "uploading"
        ? "📤 Распознаёт..."
        : state === "thinking"
          ? "🧠 Думает..."
          : state === "playing"
            ? "🔊 Озвучивает..."
            : "🎤 Сказать Музе";

  // === FAB-кнопка ===
  // idle = brand gradient + soft pulse, recording = red+ping, playing = cyan
  const fabBg =
    state === "recording"
      ? "bg-gradient-to-br from-red-500 via-pink-500 to-purple-500 shadow-[0_0_40px_rgba(239,68,68,0.7)]"
      : state === "playing"
        ? "bg-gradient-to-br from-emerald-500 via-cyan-500 to-blue-500 shadow-[0_0_40px_rgba(34,211,238,0.5)]"
        : state === "idle"
          ? "bg-gradient-to-br from-purple-500 via-fuchsia-500 to-cyan-500 shadow-[0_0_32px_rgba(124,58,237,0.5)] hover:scale-110 musa-fab-pulse"
          : "bg-white/10 opacity-70 cursor-wait";

  const fabIcon =
    state === "recording"
      ? "⏹"
      : state === "playing"
        ? "🔇"
        : state === "uploading" || state === "thinking"
          ? "⌛"
          : "🎤";

  return (
    <>
      {/* Inline keyframes для idle-pulse (нежная вспышка раз в 4 сек) */}
      <style>{`
        @keyframes musa-fab-pulse-kf {
          0%, 70%, 100% { box-shadow: 0 0 32px rgba(124,58,237,0.5); }
          80% { box-shadow: 0 0 56px rgba(217,70,239,0.85); }
          90% { box-shadow: 0 0 40px rgba(34,211,238,0.6); }
        }
        .musa-fab-pulse {
          animation: musa-fab-pulse-kf 4s ease-in-out infinite;
        }
      `}</style>

      {/* Expanded panel — над FAB, появляется при open=true */}
      {open && (
        <div
          className="fixed bottom-28 right-4 sm:right-6 z-50 w-[92vw] sm:w-[420px] max-w-[420px] max-h-[70vh] overflow-y-auto rounded-2xl border border-purple-500/30 bg-gradient-to-br from-[#0a0a17]/95 via-[#1a0f2e]/95 to-[#0a0a17]/95 backdrop-blur-xl shadow-[0_0_48px_rgba(124,58,237,0.4)]"
          data-testid="musa-voice-panel"
          role="dialog"
          aria-label="Голосовой диалог с Музой"
        >
          <div className="p-4">
            <div className="flex items-start gap-3 mb-2">
              <span className="text-2xl">🎙</span>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-sans font-bold text-white">
                  <span className="bg-gradient-to-r from-purple-300 via-cyan-300 to-emerald-300 bg-clip-text text-transparent">
                    Муза слушает
                  </span>
                </h3>
                <p className="text-[11px] font-sans text-muted-foreground leading-relaxed">
                  Контекст: dashboard + клики + brain. Лимит 30/час, до 60 сек.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-white text-lg leading-none -mt-1"
                aria-label="Закрыть"
                data-testid="musa-voice-close"
              >
                ✕
              </button>
            </div>

            <div className="flex items-center gap-3 mb-1">
              <div className="flex flex-col gap-1 text-xs flex-1">
                <div className="font-medium text-white">{stateLabel}</div>
                <label className="flex items-center gap-1 text-muted-foreground cursor-pointer select-none text-[11px]">
                  <input
                    type="checkbox"
                    checked={autoTts}
                    onChange={(e) => handleAutoTtsChange(e.target.checked)}
                    className="rounded border-white/20"
                    data-testid="musa-voice-tts-toggle"
                  />
                  Озвучивать ответ
                </label>
              </div>
              <button
                type="button"
                onClick={onMicClick}
                disabled={state === "uploading" || state === "thinking"}
                data-testid="musa-voice-mic-panel"
                className={`relative w-14 h-14 rounded-full font-bold text-xl flex items-center justify-center transition-all ${fabBg}`}
                aria-label={stateLabel}
                title={stateLabel}
              >
                {state === "recording" && (
                  <span className="absolute inset-0 rounded-full ring-4 ring-red-400/40 animate-ping" />
                )}
                <span className="relative z-10">{fabIcon}</span>
              </button>
            </div>

            {error && (
              <div className="mt-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                Ошибка: {error}
              </div>
            )}

            {result && (
              <div className="mt-3 space-y-2" data-testid="musa-voice-result">
                <div className="bg-black/30 border border-white/10 rounded-lg px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    Распознано
                  </div>
                  <div className="text-sm text-white/90">{result.transcript}</div>
                </div>
                <div
                  className={`bg-gradient-to-br from-purple-500/10 to-cyan-500/10 border rounded-lg px-3 py-2 transition-all ${
                    state === "playing"
                      ? "border-cyan-400/60 ring-2 ring-cyan-400/40 shadow-[0_0_24px_rgba(34,211,238,0.4)]"
                      : "border-purple-500/20"
                  }`}
                >
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    Муза ответила
                  </div>
                  <div className="text-sm text-white whitespace-pre-wrap">{result.response}</div>
                </div>
                {result.actions && result.actions.length > 0 && (
                  <details
                    className="bg-black/30 border border-amber-500/20 rounded-lg px-3 py-2"
                    open
                  >
                    <summary className="text-[11px] uppercase tracking-wider text-amber-300 cursor-pointer">
                      Действия ({result.actions.length})
                    </summary>
                    <ul className="mt-2 space-y-1 text-xs">
                      {result.actions.map((a, i) => (
                        <li key={i} className="border-l-2 border-amber-500/40 pl-2">
                          <div className="text-amber-300 font-mono">
                            {a.tool}({JSON.stringify(a.input).slice(0, 60)})
                          </div>
                          <div className="text-white/70 whitespace-pre-wrap">
                            {String(a.result).slice(0, 300)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {result.meta && (
                  <div className="text-[10px] text-muted-foreground font-mono">
                    {result.meta.durationMs}ms · tokens{" "}
                    {result.meta.usage?.inputTokens ?? 0}/{result.meta.usage?.outputTokens ?? 0}
                    {result.meta.ttsRequested && " · TTS ✓"}
                  </div>
                )}
              </div>
            )}

            <div className="mt-3">
              <button
                type="button"
                onClick={() => setHistoryOpen((v) => !v)}
                className="text-[11px] text-muted-foreground hover:text-white transition-colors"
                data-testid="musa-voice-history-toggle"
              >
                {historyOpen ? "▼" : "▶"} История ({history.length})
              </button>
              {historyOpen && (
                <div className="mt-2 space-y-2">
                  {history.length === 0 ? (
                    <div className="text-[11px] text-muted-foreground">Ещё нет команд.</div>
                  ) : (
                    history.map((h) => (
                      <div
                        key={h.id}
                        className="bg-black/20 border border-white/[0.06] rounded-lg px-3 py-2 text-xs"
                      >
                        <div className="text-[10px] text-muted-foreground font-mono mb-1">
                          #{h.id} · {new Date(h.createdAt).toLocaleString("ru-RU")}
                          {h.durationMs ? ` · ${h.durationMs}ms` : ""}
                        </div>
                        <div className="text-white/80">
                          <span className="text-cyan-300">→</span> {h.transcript}
                        </div>
                        <div className="text-white/60 mt-1">
                          <span className="text-purple-300">←</span> {h.response.slice(0, 200)}
                          {h.response.length > 200 ? "…" : ""}
                        </div>
                        {h.actions && h.actions.length > 0 && (
                          <div className="text-[10px] text-amber-300/70 mt-1 font-mono">
                            {h.actions.map((a) => a.tool).join(", ")}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Сам FAB — fixed bottom-right, виден на всех вкладках.
          Eugene 2026-05-17 — в idle вокруг FAB рисуются 2 floating CSS-частицы
          (через wrapper .particle-bg на большей зоне). Wrapper pointer-events-none
          чтобы клики на пустые зоны не блокировались — клики идут только на
          button (z-10 относительно wrapper). В active states (recording /
          playing / uploading) wrapper не рендерим — нет particles. */}
      {state === "idle" && (
        <div
          className="particle-bg fixed z-40 w-32 h-32 sm:w-40 sm:h-40 right-0 sm:right-0 pointer-events-none"
          style={{ bottom: "max(0rem, env(safe-area-inset-bottom, 0rem))" }}
          aria-hidden="true"
        />
      )}
      <button
        type="button"
        onClick={() => {
          if (state === "idle" && !open) {
            setOpen(true);
            return;
          }
          if (state === "recording") {
            stopRecording();
            return;
          }
          if (state === "playing") {
            stopPlayback();
            return;
          }
          if (state === "idle" && open) {
            setOpen(false);
            return;
          }
        }}
        data-testid="musa-voice-fab"
        className={`fixed bottom-6 sm:bottom-6 right-4 sm:right-6 z-50 w-16 h-16 sm:w-20 sm:h-20 rounded-full font-bold text-2xl sm:text-3xl flex items-center justify-center transition-all ${fabBg}`}
        style={{ bottom: "max(1.5rem, env(safe-area-inset-bottom, 1.5rem))" }}
        aria-label={stateLabel}
        title={stateLabel}
      >
        {state === "recording" && (
          <span className="absolute inset-0 rounded-full ring-4 ring-red-400/40 animate-ping" />
        )}
        <span className="relative z-10">{fabIcon}</span>
      </button>
    </>
  );
}

export default MusaVoiceFab;
