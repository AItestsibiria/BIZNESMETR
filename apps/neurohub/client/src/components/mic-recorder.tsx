// MicRecorder — запись с микрофона через MediaRecorder API.
// ТЗ Eugene 2026-05-07 11:55: «человек открывает окно, нажимает запись,
// надиктовывает / напевает, по стопу — Blob уходит на /api/gen/upload
// → cover. Если не нравится → кнопка «Перегенерировать».»
//
// Не использует внешних зависимостей — чистый Web API.
// Поддержка mp4/webm/ogg в зависимости от браузера.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Mic, Square, Play, Pause, Trash2 } from "lucide-react";

interface MicRecorderProps {
  maxSeconds?: number;
  onRecorded: (file: File) => void;
  disabled?: boolean;
}

const DEFAULT_MAX = 180; // 3 мин — достаточно для напева/демо

function pickMime(): { mime: string; ext: string } {
  // Пытаемся получить максимально совместимый mime для Suno/ffmpeg.
  const candidates: Array<{ mime: string; ext: string }> = [
    { mime: "audio/webm;codecs=opus", ext: "webm" },
    { mime: "audio/webm", ext: "webm" },
    { mime: "audio/mp4", ext: "m4a" },
    { mime: "audio/ogg;codecs=opus", ext: "ogg" },
    { mime: "audio/ogg", ext: "ogg" },
  ];
  if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported) {
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    }
  }
  return { mime: "audio/webm", ext: "webm" };
}

export function MicRecorder({ maxSeconds = DEFAULT_MAX, onRecorded, disabled }: MicRecorderProps) {
  const [state, setState] = useState<"idle" | "recording" | "ready">("idle");
  const [seconds, setSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0); // 0..1 для индикатора звука
  const [playing, setPlaying] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const tickRef = useRef<number | null>(null);
  const audioElemRef = useRef<HTMLAudioElement | null>(null);

  const cleanup = () => {
    try { recorderRef.current?.state !== "inactive" && recorderRef.current?.stop(); } catch {}
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    if (tickRef.current) {
      cancelAnimationFrame(tickRef.current);
      tickRef.current = null;
    }
  };

  useEffect(() => () => cleanup(), []);

  const start = async () => {
    setError(null);
    chunksRef.current = [];
    setSeconds(0);
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const { mime, ext } = pickMime();
      const rec = new MediaRecorder(stream, { mimeType: mime });
      recorderRef.current = rec;
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mime });
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        setState("ready");
        const filename = `mic-${Date.now()}.${ext}`;
        const file = new File([blob], filename, { type: mime });
        onRecorded(file);
        cleanup();
      };
      rec.start();
      setState("recording");

      // Уровень звука для визуала
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.frequencyBinCount);
      const startedAt = Date.now();
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length / 255;
        setLevel(avg);
        const elapsed = (Date.now() - startedAt) / 1000;
        setSeconds(Math.floor(elapsed));
        if (elapsed >= maxSeconds) {
          stop();
          return;
        }
        tickRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  };

  const stop = () => {
    try { recorderRef.current?.stop(); } catch {}
  };

  const reset = () => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    setState("idle");
    setSeconds(0);
    setLevel(0);
    setPlaying(false);
  };

  const togglePlay = () => {
    const a = audioElemRef.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); }
    else { a.play().then(() => setPlaying(true)).catch(() => {}); }
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        {state === "idle" && (
          <Button
            type="button"
            onClick={start}
            disabled={disabled}
            className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500"
            data-testid="btn-mic-start"
          >
            <Mic className="w-4 h-4 mr-2" />
            🎤 Записать с микрофона
          </Button>
        )}
        {state === "recording" && (
          <>
            <Button type="button" onClick={stop} variant="destructive" data-testid="btn-mic-stop">
              <Square className="w-4 h-4 mr-2" />
              Стоп ({fmt(seconds)})
            </Button>
            <div className="flex items-end gap-[3px] h-6 ml-1">
              {Array.from({ length: 12 }).map((_, i) => {
                const peak = Math.max(0.05, level * (1 + Math.sin(i * 0.7) * 0.3));
                return (
                  <div
                    key={i}
                    className="w-[3px] rounded-sm bg-cyan-400"
                    style={{ height: `${Math.min(100, peak * 100)}%`, transition: "height 50ms" }}
                  />
                );
              })}
            </div>
            <span className="text-[10px] text-muted-foreground">макс. {maxSeconds}с</span>
          </>
        )}
        {state === "ready" && audioUrl && (
          <>
            <audio
              ref={audioElemRef}
              src={audioUrl}
              onEnded={() => setPlaying(false)}
              className="hidden"
            />
            <Button type="button" variant="outline" onClick={togglePlay} data-testid="btn-mic-play">
              {playing ? <Pause className="w-4 h-4 mr-2" /> : <Play className="w-4 h-4 mr-2" />}
              Прослушать ({fmt(seconds)})
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={reset} data-testid="btn-mic-reset">
              <Trash2 className="w-4 h-4 mr-1" />
              Перезаписать
            </Button>
          </>
        )}
      </div>
      {error && (
        <div className="text-xs text-rose-300 p-2 rounded bg-rose-500/10 border border-rose-500/30">
          Не удалось получить доступ к микрофону: {error}
          <br />
          <span className="text-[10px] text-muted-foreground/80">
            Разреши доступ в адресной строке (значок 🎤). На iOS Safari запись работает только с HTTPS.
          </span>
        </div>
      )}
    </div>
  );
}
