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

// === Voice picker (Eugene 2026-05-17 Босс «8 голосов Yandex SpeechKit как из
// фантастики»). Каталог 8 голосов с RU именами + полом + кратким описанием +
// поддержкой эмоций. Для женских голосов (alena/jane/oksana/omazh) Yandex
// принимает emotion neutral/good/evil — для мужских игнорирует.
type VoiceId = "alena" | "jane" | "oksana" | "omazh" | "zahar" | "ermil" | "filipp" | "madirus";
type EmotionId = "neutral" | "good" | "evil";

interface VoiceDef {
  id: VoiceId;
  name: string;          // RU display name
  emoji: string;         // одна emoji per voice
  gender: "f" | "m";     // ♀ / ♂
  desc: string;          // 2-3 слова описания тембра
  supportsEmotion: boolean;
}

const VOICE_CATALOG: ReadonlyArray<VoiceDef> = [
  { id: "alena",   name: "Алёна",   emoji: "🌸", gender: "f", desc: "женский тёплый",       supportsEmotion: true  },
  { id: "jane",    name: "Джейн",   emoji: "✨", gender: "f", desc: "женский нейтральный",  supportsEmotion: true  },
  { id: "oksana",  name: "Оксана",  emoji: "💎", gender: "f", desc: "женский эмоциональный", supportsEmotion: true  },
  { id: "omazh",   name: "Омаж",    emoji: "🎀", gender: "f", desc: "женский медленный",    supportsEmotion: true  },
  { id: "zahar",   name: "Захар",   emoji: "🛡", gender: "m", desc: "мужской глубокий",     supportsEmotion: false },
  { id: "ermil",   name: "Эрмиль",  emoji: "⚡", gender: "m", desc: "мужской позитивный",   supportsEmotion: false },
  { id: "filipp",  name: "Филипп",  emoji: "🌊", gender: "m", desc: "мужской спокойный",    supportsEmotion: false },
  { id: "madirus", name: "Мадирус", emoji: "🔮", gender: "m", desc: "мужской премиум",      supportsEmotion: false },
];

const VALID_VOICES = new Set<string>(VOICE_CATALOG.map(v => v.id));
const VALID_EMOTIONS: ReadonlySet<string> = new Set(["neutral", "good", "evil"]);

function normalizeStoredVoice(raw: string | null | undefined): VoiceId {
  const v = String(raw || "").toLowerCase();
  return VALID_VOICES.has(v) ? (v as VoiceId) : "alena";
}
function normalizeStoredEmotion(raw: string | null | undefined): EmotionId {
  const e = String(raw || "").toLowerCase();
  return VALID_EMOTIONS.has(e) ? (e as EmotionId) : "neutral";
}

type VoiceAction = {
  tool: string;
  input: unknown;
  result: string;
  brainFocus?: { nodeName: string };
};

// Eugene 2026-05-17 «вязка со вторым мозгом»: interim transcript keywords
// → имя узла. Эмитим focus заранее (до server response) — даёт «мгновенную
// реакцию» 3D мозга на голос. Регулярки RU-russified.
const KEYWORD_TO_BRAIN_NODE: Array<{ re: RegExp; node: string }> = [
  { re: /\b(метрик|статистик|показател|kpi)/i, node: "Аналитика" },
  { re: /\b(юзер|пользовател|клиент|кто|сколько людей)/i, node: "Юзеры" },
  { re: /\b(платеж|оплат|деньг|выручк|продаж|robokass)/i, node: "Платежи" },
  { re: /\b(инцидент|ошибк|сбо|упал|падени|проблем)/i, node: "Incidents" },
  { re: /\b(трек|музык|песн|генераци)/i, node: "Generations" },
  { re: /\b(телеграм|telegram|тг|tg)/i, node: "Telegram" },
  { re: /\b(максимум|max\b|макс\b)/i, node: "Max" },
  { re: /\b(suno|сун)/i, node: "GPTunnel" },
  { re: /\b(база знани|kb\b|knowledge)/i, node: "KnowledgeBase" },
  { re: /\b(голос|tts|stt|speechkit|яндекс)/i, node: "Yandex" },
  { re: /\b(claude|клод|anthropic|llm)/i, node: "Anthropic" },
];

function matchBrainNodeFromText(text: string): string | null {
  const lower = text.toLowerCase();
  for (const entry of KEYWORD_TO_BRAIN_NODE) {
    if (entry.re.test(lower)) return entry.node;
  }
  return null;
}

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
  // Eugene 2026-05-17 Босс «режим диалога»: continuous conversation —
  // юзер говорит → 1.5 сек тишины → отправка → LLM → TTS → авто-возобновление
  // listening. Сохраняется в localStorage пер-юзер.
  const [dialogMode, setDialogMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("voice-command-dialog") === "1";
  });
  // Live interim transcript (видим что юзер сейчас говорит)
  const [interimTranscript, setInterimTranscript] = useState<string>("");
  // Eager-focus: подсветка узлов мозга по keyword'ам в interim transcript
  const [eagerFocus, setEagerFocus] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("voice-command-eager-focus") !== "0";
  });
  // Voice picker state (Eugene 2026-05-17 Босс): persist в localStorage.
  // Default alena/neutral — back-compat для пользователей без сохранённого
  // выбора.
  const [voice, setVoice] = useState<VoiceId>(() =>
    normalizeStoredVoice(
      typeof window === "undefined" ? null : window.localStorage.getItem("voice-command-voice"),
    ),
  );
  const [emotion, setEmotion] = useState<EmotionId>(() =>
    normalizeStoredEmotion(
      typeof window === "undefined" ? null : window.localStorage.getItem("voice-command-emotion"),
    ),
  );
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  // Live refs для async-handlers — actual values без замыкания (как dialogActiveRef).
  const voiceRef = useRef<VoiceId>(voice);
  const emotionRef = useRef<EmotionId>(emotion);
  useEffect(() => { voiceRef.current = voice; }, [voice]);
  useEffect(() => { emotionRef.current = emotion; }, [emotion]);

  const handleVoiceChange = useCallback((newVoice: VoiceId, newEmotion?: EmotionId) => {
    setVoice(newVoice);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("voice-command-voice", newVoice);
    }
    if (newEmotion) {
      setEmotion(newEmotion);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("voice-command-emotion", newEmotion);
      }
    }
  }, []);

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

  // === Dialog mode refs (continuous conversation) ===
  // dialogActiveRef — true когда юзер запустил dialog loop (явный «🛑 Закончить»
  //   останавливает). Refs (не state) чтобы async-handlers видели актуальное
  //   значение без замыкания.
  const dialogActiveRef = useRef<boolean>(false);
  // VAD silence timer: после 1.5 сек без interim updates — финализируем
  //   transcript и отправляем на сервер.
  const vadTimerRef = useRef<number | null>(null);
  // Accumulator интервью-результатов между VAD-pause'ами (continuous=true).
  //   На каждый final result добавляем text; при VAD silence — flush + reset.
  const dialogTranscriptBufferRef = useRef<string>("");
  // Когда TTS играет и юзер начинает говорить — barge-in. Запоминаем
  //   время начала playback чтобы передать сколько мс ответа юзер услышал.
  const ttsStartedAtRef = useRef<number>(0);
  // Set последних подсвеченных eager-focus узлов — чтобы не спамить один
  //   и тот же узел в течение одной фразы.
  const eagerFocusedNodesRef = useRef<Set<string>>(new Set());
  // AudioContext + analyser для visual pulse (амплитуда микрофона)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micAmpRafRef = useRef<number | null>(null);
  const [micAmp, setMicAmp] = useState<number>(0);
  // Live flag для «идёт TTS playback» — нужен для barge-in detection
  //   (если interim возникает при ttsPlayingRef=true — pause audio).
  const ttsPlayingRef = useRef<boolean>(false);
  // Recent final transcript per dialog turn — для barge-in / debug
  const lastDialogTranscriptRef = useRef<string>("");

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
      // Dialog mode cleanup на unmount: остановить loop + analyser
      dialogActiveRef.current = false;
      if (vadTimerRef.current !== null) {
        window.clearTimeout(vadTimerRef.current);
        vadTimerRef.current = null;
      }
      if (speechRecRef.current) {
        try { speechRecRef.current.stop(); } catch {/* ignore */}
        try { speechRecRef.current.abort?.(); } catch {/* ignore */}
        speechRecRef.current = null;
      }
      if (micAmpRafRef.current !== null) {
        cancelAnimationFrame(micAmpRafRef.current);
        micAmpRafRef.current = null;
      }
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close(); } catch {/* ignore */}
        audioCtxRef.current = null;
      }
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
      // Brain-focus integration (Eugene 2026-05-17):
      //  1) Explicit focus_brain_node tool — берём имя из input / result marker.
      //  2) Auto-focus по brainFocus в action (server enrich) — для каждой
      //     data-tool action (get_metrics → Аналитика, query_users → Юзеры…).
      //     Это даёт «облёт» 3D мозга по узлам в такт ответа.
      try {
        for (const a of data.actions || []) {
          // (1) focus_brain_node — admin 3D view (explicit tool)
          if (a.tool === "focus_brain_node") {
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
          // (2) Server-side auto-focus (brainFocus в action — для data-tools)
          if (a.brainFocus?.nodeName) {
            window.dispatchEvent(
              new CustomEvent("brain-focus-node", { detail: { name: a.brainFocus.nodeName } }),
            );
          }
          // (3) Player actions — marker [PLAYER_ACTION:type:payload]
          // → CustomEvent 'muza-player-action' (landing.tsx / dashboard.tsx listeners).
          const pm = String(a.result || "").match(/\[PLAYER_ACTION:([a-z_]+)(?::([^\]]+))?\]/);
          if (pm) {
            const [, action, payload] = pm;
            window.dispatchEvent(
              new CustomEvent("muza-player-action", {
                detail: { action, payload: payload || null },
              }),
            );
          }
          // (4) Voice picker — marker [VOICE_CHANGED:<voice>:<emotion>]
          //     LLM сменила голос через change_voice tool → sync localStorage +
          //     state, чтобы следующий TTS request шёл с новым голосом.
          const vm = String(a.result || "").match(/\[VOICE_CHANGED:([a-z_]+):([a-z_]+)\]/);
          if (vm) {
            const [, vVoice, vEmotion] = vm;
            if (VALID_VOICES.has(vVoice)) {
              handleVoiceChange(
                vVoice as VoiceId,
                VALID_EMOTIONS.has(vEmotion) ? (vEmotion as EmotionId) : undefined,
              );
            }
          }
        }
      } catch {/* ignore */}

      // TTS playback (with voice-speaking event for SecondBrain3D pulse-glow)
      if (data.audioBase64 && data.audioContentType) {
        const audioBlob = base64ToBlob(data.audioBase64, data.audioContentType);
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        const audioUrl = URL.createObjectURL(audioBlob);
        blobUrlRef.current = audioUrl;
        const audio = new Audio(audioUrl);
        registerAudio(audio);
        audioRef.current = audio;
        const wasDialog = dialogActiveRef.current;
        audio.onended = () => {
          ttsPlayingRef.current = false;
          ttsStartedAtRef.current = 0;
          window.dispatchEvent(new CustomEvent("voice-speaking", { detail: { active: false } }));
          if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
          // Auto-resume listening в dialog mode — продолжаем диалог-loop
          if (wasDialog && dialogActiveRef.current) {
            // Defer один tick чтобы избежать «overlap» с предыдущим recognition
            window.setTimeout(() => {
              if (dialogActiveRef.current) {
                startDialogTurnRef.current?.();
              }
            }, 100);
          } else {
            setState("idle");
          }
        };
        audio.onerror = () => {
          ttsPlayingRef.current = false;
          window.dispatchEvent(new CustomEvent("voice-speaking", { detail: { active: false } }));
          setState("idle");
          setError("Ошибка воспроизведения mp3");
        };
        setState("playing");
        ttsPlayingRef.current = true;
        ttsStartedAtRef.current = Date.now();
        window.dispatchEvent(new CustomEvent("voice-speaking", { detail: { active: true } }));
        await audio.play().catch((e) => {
          console.warn("auto-play blocked", e);
          ttsPlayingRef.current = false;
          window.dispatchEvent(new CustomEvent("voice-speaking", { detail: { active: false } }));
          setState("idle");
        });
      } else {
        // Нет TTS — в dialog mode сразу продолжаем listening
        if (dialogActiveRef.current) {
          window.setTimeout(() => {
            if (dialogActiveRef.current) {
              startDialogTurnRef.current?.();
            }
          }, 100);
        } else {
          setState("idle");
        }
      }
    },
    [loadHistory],
  );

  // Forward-ref для recursive вызова startDialogTurn внутри audio.onended.
  // Решает hoisting между useCallback definitions.
  const startDialogTurnRef = useRef<(() => void) | null>(null);

  // Eugene 2026-05-17: text-only path для Web Speech API.
  // Минует STT — браузер уже распознал, шлём только transcript.
  // dialogMode + previousResponseTruncatedAt пересылаются на сервер для
  // короткого промпта + контекста barge-in.
  const uploadTranscript = useCallback(
    async (transcript: string, opts?: { previousResponseTruncatedAt?: number }) => {
      setState("thinking");
      try {
        const url = `/api/admin/v304/voice-command-text${autoTts ? "?tts=1" : ""}`;
        const body: Record<string, unknown> = { transcript };
        if (dialogActiveRef.current) body.dialogMode = true;
        if (opts?.previousResponseTruncatedAt && opts.previousResponseTruncatedAt > 0) {
          body.previousResponseTruncatedAt = opts.previousResponseTruncatedAt;
        }
        // Voice picker (Eugene 2026-05-17): передаём текущий voice + emotion
        // чтобы Yandex TTS озвучил ответ выбранным голосом. Ref'ы чтобы
        // получить актуальное значение без замыкания.
        body.voice = voiceRef.current;
        body.emotion = emotionRef.current;
        const r = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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
        // В dialog mode не выходим из loop — продолжаем listening (юзер
        // может попытаться переспросить). Если 2 ошибки подряд — пусть нажмёт
        // «Закончить» руками.
        if (dialogActiveRef.current) {
          window.setTimeout(() => {
            if (dialogActiveRef.current) startDialogTurnRef.current?.();
          }, 800);
        } else {
          setState("idle");
        }
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
        // Voice picker (Eugene 2026-05-17): передаём voice + emotion как
        // multipart text-fields — server normalizeVoice/normalizeEmotion
        // принимает их из req.body вместе с файлом.
        fd.append("voice", voiceRef.current);
        fd.append("emotion", emotionRef.current);
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
        // focus_brain_node + player actions integration (Eugene 2026-05-17 Босс):
        // одна петля парсит оба типа marker'ов:
        //   - [FOCUS_BRAIN_NODE:<name>] → 'brain-focus-node' CustomEvent
        //   - [PLAYER_ACTION:<type>:<payload>] → 'muza-player-action' CustomEvent
        try {
          for (const a of data.actions || []) {
            if (a.tool === "focus_brain_node") {
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
              continue;
            }
            const pm = String(a.result || "").match(/\[PLAYER_ACTION:([a-z_]+)(?::([^\]]+))?\]/);
            if (pm) {
              const [, action, payload] = pm;
              window.dispatchEvent(
                new CustomEvent("muza-player-action", {
                  detail: { action, payload: payload || null },
                }),
              );
            }
            // Voice picker marker [VOICE_CHANGED:<voice>:<emotion>] — sync state
            const vm = String(a.result || "").match(/\[VOICE_CHANGED:([a-z_]+):([a-z_]+)\]/);
            if (vm) {
              const [, vVoice, vEmotion] = vm;
              if (VALID_VOICES.has(vVoice)) {
                handleVoiceChange(
                  vVoice as VoiceId,
                  VALID_EMOTIONS.has(vEmotion) ? (vEmotion as EmotionId) : undefined,
                );
              }
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

  // === Dialog mode: setting toggle + persistence ===
  const handleDialogModeChange = (on: boolean) => {
    setDialogMode(on);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("voice-command-dialog", on ? "1" : "0");
    }
    // Если выключили dialog mode на ходу — остановим loop
    if (!on && dialogActiveRef.current) {
      stopDialogModeRef.current?.();
    }
  };
  const handleEagerFocusChange = (on: boolean) => {
    setEagerFocus(on);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("voice-command-eager-focus", on ? "1" : "0");
    }
  };

  // === Mic amplitude analyser (visual pulse в dialog mode) ===
  // Создаём AudioContext + AnalyserNode из MediaStream, читаем уровень в RAF
  // и пишем в state. Использует stream из getUserMedia который и так
  // нужен для Web Speech API в большинстве браузеров.
  const startMicAnalyser = useCallback(async () => {
    try {
      if (audioCtxRef.current) return; // already running
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const Ctx: typeof AudioContext =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        const avg = sum / buf.length / 255;
        setMicAmp(avg);
        micAmpRafRef.current = requestAnimationFrame(tick);
      };
      micAmpRafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      console.warn("[voice-fab] mic analyser init failed:", e);
    }
  }, []);

  const stopMicAnalyser = useCallback(() => {
    if (micAmpRafRef.current !== null) {
      cancelAnimationFrame(micAmpRafRef.current);
      micAmpRafRef.current = null;
    }
    setMicAmp(0);
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {/* ignore */}
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    if (streamRef.current) {
      try { streamRef.current.getTracks().forEach(t => t.stop()); } catch {/* ignore */}
      streamRef.current = null;
    }
  }, []);

  // === Dialog turn: один шаг continuous conversation ===
  // Запускает SpeechRecognition в continuous=true + interimResults=true.
  // VAD: если 1500ms без interim updates — финализируем и шлём transcript.
  // Eager-focus: если interim text матчит keyword — emit brain-focus-node
  //   до server response (мгновенная реакция 3D).
  const startDialogTurn = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!dialogActiveRef.current) return;
    const SR =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setError("Браузер не поддерживает continuous Speech Recognition (нужен Chrome / Safari 14.5+)");
      dialogActiveRef.current = false;
      setState("idle");
      return;
    }
    try {
      // Очищаем предыдущий rec если был
      if (speechRecRef.current) {
        try { speechRecRef.current.stop(); } catch {/* ignore */}
        speechRecRef.current = null;
      }
      const rec = new SR();
      rec.lang = "ru-RU";
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;

      dialogTranscriptBufferRef.current = "";
      eagerFocusedNodesRef.current.clear();
      setInterimTranscript("");

      const scheduleFlush = () => {
        if (vadTimerRef.current !== null) {
          window.clearTimeout(vadTimerRef.current);
        }
        vadTimerRef.current = window.setTimeout(() => {
          // VAD silence triggered — flush accumulated transcript
          const t = dialogTranscriptBufferRef.current.trim();
          dialogTranscriptBufferRef.current = "";
          setInterimTranscript("");
          if (!t) {
            // ничего не сказал — продолжаем listening
            if (dialogActiveRef.current) {
              try { rec.stop(); } catch {/* ignore */}
            }
            return;
          }
          lastDialogTranscriptRef.current = t;
          // Stop рекогнайзер (onend → отправка). Используем stop() а не abort()
          // чтобы получить onend callback который запустит flush.
          try { rec.stop(); } catch {/* ignore */}
          // Barge-in метка — если TTS играл, передаём сколько мс юзер услышал
          let truncatedAt = 0;
          if (ttsPlayingRef.current && ttsStartedAtRef.current > 0) {
            truncatedAt = Math.max(0, Date.now() - ttsStartedAtRef.current);
            // Pause TTS прямо сейчас
            if (audioRef.current) {
              try { audioRef.current.pause(); } catch {/* ignore */}
            }
            ttsPlayingRef.current = false;
            window.dispatchEvent(new CustomEvent("voice-speaking", { detail: { active: false } }));
          }
          uploadTranscript(t, truncatedAt > 0 ? { previousResponseTruncatedAt: truncatedAt } : undefined);
        }, 1500);
      };

      rec.onresult = (e: any) => {
        let interimText = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) {
            dialogTranscriptBufferRef.current += " " + r[0].transcript;
          } else {
            interimText += r[0].transcript;
          }
        }
        const displayText = (dialogTranscriptBufferRef.current + " " + interimText).trim();
        setInterimTranscript(displayText);
        scheduleFlush();
        // Barge-in detection (Eugene 2026-05-17): если TTS играет и юзер
        // начал говорить — pause TTS немедленно. Конечный transcript будет
        // отправлен через VAD flush с previousResponseTruncatedAt.
        if (ttsPlayingRef.current && displayText.length > 0) {
          if (audioRef.current) {
            try { audioRef.current.pause(); } catch {/* ignore */}
          }
          ttsPlayingRef.current = false;
          window.dispatchEvent(new CustomEvent("voice-speaking", { detail: { active: false } }));
        }
        // Eager-focus (Eugene Босс «мгновенная реакция 3D на голос»):
        // на каждом interim update проверяем keyword'ы — если новый узел,
        // emit brain-focus-node заранее (до server response).
        if (eagerFocus && interimText.length > 0) {
          const node = matchBrainNodeFromText(displayText);
          if (node && !eagerFocusedNodesRef.current.has(node)) {
            eagerFocusedNodesRef.current.add(node);
            window.dispatchEvent(new CustomEvent("brain-focus-node", { detail: { name: node } }));
          }
        }
      };

      rec.onerror = (e: any) => {
        console.warn("[voice-fab dialog] SpeechRecognition error:", e?.error);
        if (e?.error === "not-allowed") {
          setError("Разреши доступ к микрофону (значок 🎤 в адресной строке).");
          dialogActiveRef.current = false;
          stopMicAnalyser();
          setState("idle");
          return;
        }
        // no-speech / audio-capture / network — не валим loop, перезапускаем
        if (dialogActiveRef.current) {
          window.setTimeout(() => {
            if (dialogActiveRef.current) startDialogTurnRef.current?.();
          }, 400);
        }
      };

      rec.onend = () => {
        if (vadTimerRef.current !== null) {
          window.clearTimeout(vadTimerRef.current);
          vadTimerRef.current = null;
        }
        // Если есть accumulated text — отправляем (для случая когда
        // браузер сам завершил rec но VAD не успел сработать).
        const t = dialogTranscriptBufferRef.current.trim();
        if (t && dialogActiveRef.current && state !== "thinking" && state !== "uploading") {
          dialogTranscriptBufferRef.current = "";
          setInterimTranscript("");
          lastDialogTranscriptRef.current = t;
          let truncatedAt = 0;
          if (ttsPlayingRef.current && ttsStartedAtRef.current > 0) {
            truncatedAt = Math.max(0, Date.now() - ttsStartedAtRef.current);
            if (audioRef.current) {
              try { audioRef.current.pause(); } catch {/* ignore */}
            }
            ttsPlayingRef.current = false;
          }
          uploadTranscript(t, truncatedAt > 0 ? { previousResponseTruncatedAt: truncatedAt } : undefined);
        }
      };

      speechRecRef.current = rec;
      rec.start();
      setState("recording");
      setError(null);
    } catch (e) {
      console.warn("[voice-fab dialog] start failed:", e);
      // Browser race-condition: «recognition has already started» — игнорим
      if (dialogActiveRef.current) {
        window.setTimeout(() => {
          if (dialogActiveRef.current) startDialogTurnRef.current?.();
        }, 400);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eagerFocus, uploadTranscript, state, stopMicAnalyser]);

  // Bind ref so handleVoiceResult и rec.onerror могут вызывать startDialogTurn
  // без circular-dependency проблем при useCallback.
  useEffect(() => {
    startDialogTurnRef.current = startDialogTurn;
  }, [startDialogTurn]);

  // === Stop dialog mode (выход из continuous loop) ===
  const stopDialogModeRef = useRef<(() => void) | null>(null);
  const stopDialogMode = useCallback(() => {
    dialogActiveRef.current = false;
    if (vadTimerRef.current !== null) {
      window.clearTimeout(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    if (speechRecRef.current) {
      try { speechRecRef.current.stop(); } catch {/* ignore */}
      try { speechRecRef.current.abort?.(); } catch {/* ignore */}
      speechRecRef.current = null;
    }
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch {/* ignore */}
    }
    ttsPlayingRef.current = false;
    window.dispatchEvent(new CustomEvent("voice-speaking", { detail: { active: false } }));
    stopMicAnalyser();
    setInterimTranscript("");
    setState("idle");
  }, [stopMicAnalyser]);

  useEffect(() => {
    stopDialogModeRef.current = stopDialogMode;
  }, [stopDialogMode]);

  // === Start dialog mode (юзер нажал «🎙 Диалог») ===
  const startDialogMode = useCallback(async () => {
    setError(null);
    setResult(null);
    const SR =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setError("Браузер не поддерживает continuous Speech Recognition (нужен Chrome / Safari 14.5+).");
      return;
    }
    dialogActiveRef.current = true;
    await startMicAnalyser();
    startDialogTurnRef.current?.();
  }, [startMicAnalyser]);

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
    // Dialog mode active — клик на основной FAB интерпретируется как
    // «остановить диалог». Юзер видит специальную кнопку «🛑 Закончить» в
    // panel, но FAB тоже должен реагировать.
    if (dialogActiveRef.current) {
      stopDialogMode();
      return;
    }
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

  const stateLabel = dialogActiveRef.current
    ? state === "recording"
      ? "🎙 Диалог · слушает"
      : state === "thinking"
        ? "🧠 Диалог · думает"
        : state === "playing"
          ? "🔊 Диалог · отвечает"
          : "🎙 Диалог активен"
    : state === "recording"
      ? "🔴 Слушает..."
      : state === "uploading"
        ? "📤 Распознаёт..."
        : state === "thinking"
          ? "🧠 Думает..."
          : state === "playing"
            ? "🔊 Озвучивает..."
            : "🎤 Сказать Музе";

  // === FAB-кнопка ===
  // idle = brand gradient + soft pulse, recording = red+ping, playing = cyan,
  // dialog active = brighter rainbow shimmer (continuous conversation).
  const fabBg = dialogActiveRef.current
    ? "bg-gradient-to-br from-purple-500 via-fuchsia-500 to-cyan-500 shadow-[0_0_48px_rgba(217,70,239,0.7)]"
    : state === "recording"
      ? "bg-gradient-to-br from-red-500 via-pink-500 to-purple-500 shadow-[0_0_40px_rgba(239,68,68,0.7)]"
      : state === "playing"
        ? "bg-gradient-to-br from-emerald-500 via-cyan-500 to-blue-500 shadow-[0_0_40px_rgba(34,211,238,0.5)]"
        : state === "idle"
          ? "bg-gradient-to-br from-purple-500 via-fuchsia-500 to-cyan-500 shadow-[0_0_32px_rgba(124,58,237,0.5)] hover:scale-110 musa-fab-pulse"
          : "bg-white/10 opacity-70 cursor-wait";

  const fabIcon = dialogActiveRef.current
    ? "🎙"
    : state === "recording"
      ? "⏹"
      : state === "playing"
        ? "🔇"
        : state === "uploading" || state === "thinking"
          ? "⌛"
          : "🎤";

  // === Voice picker helpers ===
  const currentVoiceDef = VOICE_CATALOG.find((v) => v.id === voice) || VOICE_CATALOG[0];

  const previewVoice = useCallback(
    async (vId: VoiceId, ePreview?: EmotionId) => {
      // Превью через тот же /voice-command-text endpoint — отправляем фиксированную
      // фразу как transcript + voice + emotion. Сервер сделает LLM-вызов с короткой
      // фразой и вернёт TTS audio. Это reuse-working-solutions (нет отдельного
      // /preview endpoint'а — переиспользуем существующий путь).
      // Кладём в state так чтобы playback пошёл через handleVoiceResult.
      const previewText = `Привет, я Муза. Говорю голосом ${
        VOICE_CATALOG.find((c) => c.id === vId)?.name || vId
      }.`;
      setState("thinking");
      try {
        const url = `/api/admin/v304/voice-command-text?tts=1`;
        const r = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: previewText,
            voice: vId,
            emotion: ePreview || emotionRef.current,
            // dialogMode=false: одиночное превью, не запускает continuous loop
          }),
        });
        if (!r.ok) {
          const tx = await r.text().catch(() => "");
          throw new Error(`${r.status}: ${tx.slice(0, 120)}`);
        }
        const j = await r.json();
        // Не вызываем handleVoiceResult чтобы НЕ перезаписать main result panel
        // и НЕ дёрнуть dialog auto-resume. Только проигрываем audio локально.
        const data: VoiceCommandResult = j.data;
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
          audio.onerror = () => setState("idle");
          setState("playing");
          await audio.play().catch(() => setState("idle"));
        } else {
          setState("idle");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState("idle");
      }
    },
    [],
  );

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
                <label className="flex items-center gap-1 text-muted-foreground cursor-pointer select-none text-[11px]">
                  <input
                    type="checkbox"
                    checked={dialogMode}
                    onChange={(e) => handleDialogModeChange(e.target.checked)}
                    className="rounded border-white/20"
                    data-testid="musa-voice-dialog-toggle"
                  />
                  🎙 Режим диалога
                </label>
                <label className="flex items-center gap-1 text-muted-foreground cursor-pointer select-none text-[11px]">
                  <input
                    type="checkbox"
                    checked={eagerFocus}
                    onChange={(e) => handleEagerFocusChange(e.target.checked)}
                    className="rounded border-white/20"
                    data-testid="musa-voice-eager-focus-toggle"
                  />
                  ✨ Мгновенный фокус мозга
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

            {/* Voice picker (Eugene 2026-05-17 Босс «8 голосов Yandex, можно
                менять кликом и по команде»). Toggle-кнопка показывает текущий
                голос + при клике раскрывает grid 2×4 (на mobile 1 столбец).
                Каждый item — emoji + RU name + бейдж пола + описание + ▶ preview.
                Active голос подсвечен brand glow.  */}
            <div className="mt-3" data-testid="musa-voice-picker">
              <button
                type="button"
                onClick={() => setVoicePickerOpen((v) => !v)}
                data-testid="musa-voice-picker-toggle"
                className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-purple-500/30 bg-white/5 hover:bg-gradient-to-r hover:from-purple-500/20 hover:to-cyan-500/20 transition-colors text-left"
                aria-expanded={voicePickerOpen}
                aria-controls="musa-voice-picker-panel"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-xl">{currentVoiceDef.emoji}</span>
                  <span className="flex flex-col min-w-0">
                    <span className="text-[10px] uppercase tracking-wider text-cyan-300">
                      Голос
                    </span>
                    <span className="font-sans font-bold text-sm text-white truncate">
                      {currentVoiceDef.name}{" "}
                      <span className="text-muted-foreground font-normal">
                        {currentVoiceDef.gender === "f" ? "♀" : "♂"}
                      </span>
                      {currentVoiceDef.supportsEmotion && emotion !== "neutral" && (
                        <span className="ml-1 text-amber-300 text-[11px]">
                          ({emotion === "good" ? "позитивно" : "строго"})
                        </span>
                      )}
                    </span>
                  </span>
                </span>
                <span className="text-muted-foreground text-sm">
                  {voicePickerOpen ? "▼" : "▶"}
                </span>
              </button>

              {voicePickerOpen && (
                <div
                  id="musa-voice-picker-panel"
                  className="mt-2 rounded-xl border border-purple-500/20 bg-black/30 p-2"
                  data-testid="musa-voice-picker-grid"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {VOICE_CATALOG.map((v) => {
                      const isActive = v.id === voice;
                      return (
                        <div
                          key={v.id}
                          className={`relative rounded-lg border p-2 transition-all ${
                            isActive
                              ? "border-purple-400/70 bg-gradient-to-br from-purple-500/20 via-fuchsia-500/15 to-cyan-500/20 shadow-[0_0_16px_rgba(124,58,237,0.4)]"
                              : "border-white/10 bg-white/[0.03] hover:border-purple-400/30 hover:bg-white/5"
                          }`}
                          data-testid={`musa-voice-item-${v.id}`}
                        >
                          <button
                            type="button"
                            onClick={() => handleVoiceChange(v.id)}
                            className="w-full text-left"
                            aria-pressed={isActive}
                            aria-label={`Выбрать голос ${v.name}`}
                          >
                            <div className="flex items-start gap-2">
                              <span className="text-2xl leading-none mt-0.5">{v.emoji}</span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span
                                    className={`font-sans font-bold text-sm truncate ${
                                      isActive
                                        ? "bg-gradient-to-r from-purple-200 via-fuchsia-200 to-cyan-200 bg-clip-text text-transparent"
                                        : "text-white"
                                    }`}
                                  >
                                    {v.name}
                                  </span>
                                  <span
                                    className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                                      v.gender === "f"
                                        ? "bg-pink-500/20 text-pink-300"
                                        : "bg-blue-500/20 text-blue-300"
                                    }`}
                                  >
                                    {v.gender === "f" ? "♀" : "♂"}
                                  </span>
                                </div>
                                <div className="text-[11px] text-muted-foreground truncate">
                                  {v.desc}
                                </div>
                              </div>
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              previewVoice(v.id);
                            }}
                            disabled={state === "uploading" || state === "thinking"}
                            data-testid={`musa-voice-preview-${v.id}`}
                            className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-purple-500/20 hover:bg-purple-500/40 border border-purple-400/40 flex items-center justify-center text-xs text-purple-200 transition-colors disabled:opacity-40 disabled:cursor-wait"
                            aria-label={`Прослушать ${v.name}`}
                            title={`Прослушать ${v.name}`}
                          >
                            ▶
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  {/* Emotion selector — только для женских голосов с support */}
                  {currentVoiceDef.supportsEmotion && (
                    <div
                      className="mt-3 pt-2 border-t border-white/10"
                      data-testid="musa-voice-emotion-row"
                    >
                      <div className="text-[10px] uppercase tracking-wider text-cyan-300 mb-1.5">
                        Эмоция
                      </div>
                      <div className="grid grid-cols-3 gap-1.5">
                        {(["neutral", "good", "evil"] as const).map((em) => {
                          const labels: Record<EmotionId, string> = {
                            neutral: "ровно",
                            good: "позитивно",
                            evil: "строго",
                          };
                          const isActiveEm = emotion === em;
                          return (
                            <button
                              key={em}
                              type="button"
                              onClick={() => handleVoiceChange(voice, em)}
                              data-testid={`musa-voice-emotion-${em}`}
                              className={`text-xs py-1 rounded-md transition-all ${
                                isActiveEm
                                  ? "bg-gradient-to-r from-amber-400/40 to-fuchsia-500/40 border border-amber-400/60 text-white shadow-[0_0_12px_rgba(251,191,36,0.3)]"
                                  : "bg-white/5 border border-white/10 text-white/70 hover:bg-white/10"
                              }`}
                              aria-pressed={isActiveEm}
                            >
                              {labels[em]}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Dialog mode: start / stop кнопка + live transcript banner */}
            {dialogMode && (
              <div className="mt-3 space-y-2" data-testid="musa-voice-dialog-section">
                {!dialogActiveRef.current ? (
                  <button
                    type="button"
                    onClick={startDialogMode}
                    disabled={state === "uploading" || state === "thinking"}
                    data-testid="musa-voice-dialog-start"
                    className="w-full px-4 py-3 rounded-xl font-sans font-bold text-sm text-white bg-gradient-to-r from-purple-500 via-fuchsia-500 to-cyan-500 shadow-[0_0_24px_rgba(124,58,237,0.5)] hover:scale-[1.02] active:scale-[0.98] transition-transform"
                  >
                    🎙 Начать диалог с Музой
                  </button>
                ) : (
                  <>
                    {/* Pulse circle с амплитудой микрофона */}
                    <div className="flex items-center justify-center py-2">
                      <div
                        className="relative w-20 h-20 rounded-full bg-gradient-to-br from-purple-500/40 via-fuchsia-500/40 to-cyan-500/40 flex items-center justify-center transition-transform"
                        style={{
                          transform: `scale(${1 + Math.min(0.5, micAmp * 2)})`,
                          boxShadow: `0 0 ${24 + Math.round(micAmp * 64)}px rgba(124,58,237,${0.4 + micAmp * 0.4})`,
                        }}
                        aria-hidden="true"
                      >
                        <span className="text-2xl">
                          {ttsPlayingRef.current ? "🔊" : "🎙"}
                        </span>
                      </div>
                    </div>
                    {/* Live interim transcript banner */}
                    {interimTranscript && (
                      <div
                        className="bg-cyan-500/10 border border-cyan-400/30 rounded-lg px-3 py-2"
                        data-testid="musa-voice-interim"
                      >
                        <div className="text-[10px] uppercase tracking-wider text-cyan-300 mb-1">
                          Слышу
                        </div>
                        <div className="text-sm text-white/90 whitespace-pre-wrap">
                          {interimTranscript}
                        </div>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={stopDialogMode}
                      data-testid="musa-voice-dialog-stop"
                      className="w-full px-4 py-3 rounded-xl font-sans font-bold text-sm text-white bg-red-500/20 border-2 border-red-400/60 hover:bg-red-500/30 transition-colors"
                    >
                      🛑 Закончить диалог
                    </button>
                  </>
                )}
              </div>
            )}

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
