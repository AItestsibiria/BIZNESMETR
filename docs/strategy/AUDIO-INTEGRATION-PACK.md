# 🎙 Audio Integration Pack — Plug-and-Play блок для другого проекта

> **Назначение:** копируешь 3 файла + 5 env vars + 1 ffmpeg бинарь → в новом проекте сразу работают: запись с микрофона, транскрибация (Russian STT), озвучка (Russian TTS) через Yandex SpeechKit с fallback на OpenAI/GPTunnel.
> **Источник:** Босс просил 2026-05-20 — «срез, чтобы всё было понятно».
> **Версия:** v1.0 (extracted from neurohub @ commit `73edcee`)

## TL;DR

| Компонент | Файл | Provider | Fallback |
|---|---|---|---|
| 🎤 Запись с микрофона | `mic-recorder.tsx` (231 строк, React) | Web Audio API (browser-native) | — |
| 📝 STT (распознавание) | `transcribe.ts` (271 строка, Node) | **Yandex SpeechKit** | GPTunnel Whisper → OpenAI Whisper |
| 🔊 TTS (озвучка) | `yandexTts.ts` (194 строки, Node) | **Yandex SpeechKit** | — |

**Все три части — независимые, можно копировать по отдельности.**

---

## Архитектура (data flow)

```
┌─────────────────┐                   ┌─────────────────┐
│   BROWSER       │                   │   YOUR SERVER   │
│                 │                   │                 │
│  <MicRecorder>  │   POST audio      │  /api/stt route │
│   getUserMedia  │   blob (webm)     │                 │
│   MediaRecorder │───────────────────▶ transcribe.ts   │
│   30 sec limit  │                   │   1. ffmpeg →   │
│                 │                   │      ogg/opus   │
│                 │                   │   2. Yandex STT │
│                 │                   │   3. ↳ fallback │
│                 │   text reply      │                 │
│                 │◀──────────────────│                 │
│                 │                   │                 │
│  <audio>        │                   │  /api/tts route │
│   play mp3      │   POST text       │                 │
│                 │───────────────────▶ yandexTts.ts    │
│                 │   mp3 audio       │   Yandex TTS    │
│                 │◀──────────────────│   (8 voices)    │
└─────────────────┘                   └─────────────────┘
                                            │
                                            ▼
                                      ┌──────────────────┐
                                      │ Yandex SpeechKit │
                                      │ stt.api.cloud... │
                                      │ tts.api.cloud... │
                                      └──────────────────┘
```

---

## 1. 🎤 Mic Recorder (client, React)

**Файл:** скопировать `apps/neurohub/client/src/components/mic-recorder.tsx` целиком (231 строка).

### Зависимости
- **React** (любая версия 17+)
- **lucide-react** для иконок: `npm i lucide-react`
- **Web Audio API + MediaRecorder API** — встроены в браузер, ничего ставить не нужно
- **Tailwind CSS** — для стилей (или замени классы на свои)
- shadcn/ui `Button` — можно заменить на свою кнопку

### Что делает
- Запись через `MediaRecorder` (webm/mp4/ogg в зависимости от браузера)
- Auto-detect mime через `MediaRecorder.isTypeSupported()`
- Echo cancellation + noise suppression + auto gain control
- Визуальный VU-метр (12 столбиков, через `AnalyserNode.getByteFrequencyData`)
- Auto-stop через 30 сек (configurable через prop `maxSeconds`)
- Возвращает `File` объект через callback `onRecorded(file)`
- Reset / Re-record / Delete buttons

### Использование

```tsx
import { MicRecorder } from "./components/mic-recorder";

function MyPage() {
  const handleRecorded = async (file: File) => {
    const fd = new FormData();
    fd.append("audio", file);
    const resp = await fetch("/api/stt", { method: "POST", body: fd });
    const { transcript } = await resp.json();
    console.log("Распознано:", transcript);
  };

  return <MicRecorder maxSeconds={30} onRecorded={handleRecorded} />;
}
```

### Что важно знать
- **HTTPS обязателен** — `getUserMedia` не работает на HTTP (кроме `localhost`)
- **iOS Safari** — только HTTPS, нужен user gesture (click) перед `getUserMedia`
- **Mime fallback** — Safari ≠ Chrome, MediaRecorder возвращает разные форматы
- **30 сек лимит** — соответствует Yandex SpeechKit short-audio (≤30s / ≤1MB)

### Минимальная альтернатива без UI (если нужен только запись-логика)

```ts
async function recordAudio(maxSec = 30): Promise<File> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  
  return new Promise((resolve) => {
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: mime });
      resolve(new File([blob], `mic-${Date.now()}.webm`, { type: mime }));
    };
    rec.start();
    setTimeout(() => rec.stop(), maxSec * 1000);
  });
}
```

---

## 2. 📝 Speech-to-Text (server, Node.js)

**Файл:** скопировать `apps/neurohub/server/lib/transcribe.ts` целиком (271 строка).

### Зависимости
- **Node.js 20+** (для built-in `fetch`, `FormData`, `AbortSignal.timeout`)
- **ffmpeg бинарь** в `PATH` — нужен для перекодировки webm → ogg/opus
  - Ubuntu: `apt install ffmpeg`
  - macOS: `brew install ffmpeg`
- Никаких npm-пакетов не требует

### ENV vars

```bash
# Обязательно для Yandex STT (рекомендуется, лучшее качество для русского)
YANDEX_SPEECHKIT_API_KEY=AQVN...         # API-ключ из console.cloud.yandex.ru → IAM → Сервисный аккаунт с ролью ai.speechkit-stt.user
YANDEX_FOLDER_ID=b1g...                  # Folder ID из той же консоли

# Опциональный fallback 1 — GPTunnel (прокси для Whisper, для российских юзеров без OpenAI)
GPTUNNEL_API_KEY=...                     # api key из gptunnel.ru

# Опциональный fallback 2 — OpenAI Whisper напрямую
OPENAI_API_KEY=sk-...
```

**Если задан только один ключ — будет использоваться только тот провайдер. Если нет ни одного — функция вернёт `{ transcript: "", provider: null }`.**

### Использование

```ts
import { transcribeRussianAudio } from "./lib/transcribe";
import express from "express";
import multer from "multer";

const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB max
app.post("/api/stt", upload.single("audio"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "no audio" });
  
  const ext = file.mimetype.includes("webm") ? "webm"
    : file.mimetype.includes("mp4") ? "m4a"
    : file.mimetype.includes("ogg") ? "ogg"
    : "bin";
  
  const result = await transcribeRussianAudio(file.buffer, file.mimetype, ext);
  // result = { transcript: "Привет, как дела", provider: "yandex", attempts: [...] }
  
  res.json({ transcript: result.transcript, provider: result.provider });
});
```

### Что важно знать
- **Yandex принимает только oggopus/lpcm** — браузер шлёт webm, поэтому ffmpeg перекодирует
- **30 сек лимит** Yandex short-audio — функция `-t 30` обрезает на стороне ffmpeg как 2-ю линию защиты
- **Fallback chain работает только если предыдущий вернул `ok: false` или пустой transcript**
- **Возвращает `attempts[]`** — массив всех попыток (для админ-диагностики/debug)
- **HTTP timeouts** — 60 сек на провайдера, 30 сек на ffmpeg

### Стоимость
- **Yandex STT short-audio:** ~1 коп за 1 сек = ~0.30 ₽ за 30-сек запись
- **OpenAI Whisper:** $0.006 / минуту
- **GPTunnel:** через тариф (примерно как OpenAI)

### Helper для verify всех провайдеров

```ts
import { verifyAllProviders } from "./lib/transcribe";

const attempts = await verifyAllProviders(buffer, mime, ext);
// attempts = [{provider:"yandex",ok:true,...}, {provider:"gptunnel",ok:false,...}, ...]
```

---

## 3. 🔊 Text-to-Speech (server, Node.js)

**Файл:** скопировать `apps/neurohub/server/lib/yandexTts.ts` целиком (194 строки).

### Зависимости
- **Node.js 20+** (для built-in `fetch`)
- Никаких npm-пакетов

### ENV vars (тот же ключ что для STT)

```bash
YANDEX_SPEECHKIT_API_KEY=AQVN...
YANDEX_FOLDER_ID=b1g...
```

### 8 голосов Yandex

```ts
type YandexVoice =
  | "alena"   // женский премиум, по умолчанию
  | "jane"    // женский, эмоциональный
  | "oksana"  // женский, спокойный
  | "omazh"   // женский, низкий тембр
  | "zahar"   // мужской
  | "ermil"   // мужской, выразительный
  | "filipp"  // мужской, премиум
  | "madirus"; // мужской премиум с низким pitch
```

**Эмоции** (`neutral`/`good`/`evil`) поддерживаются ТОЛЬКО женскими голосами.

### Использование (минимальный пример)

```ts
import { synthesizeYandexTts } from "./lib/yandexTts";
import express from "express";

app.post("/api/tts", async (req, res) => {
  const { text, voice = "alena", emotion = "neutral", speed = 1.0 } = req.body;
  const result = await synthesizeYandexTts({ text, voice, emotion, speed, format: "mp3" });
  
  if (!result.ok) {
    return res.status(500).json({ error: result.error });
  }
  
  res.setHeader("Content-Type", result.contentType!); // "audio/mpeg"
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(result.audio);
});
```

### С in-memory cache (опционально — снижает расходы)

```ts
import { synthesizeYandexTts, getTtsFromCache, putTtsInCache } from "./lib/yandexTts";

app.post("/api/tts", async (req, res) => {
  const { text, voice = "alena" } = req.body;
  
  const cached = getTtsFromCache(text, voice, "mp3");
  if (cached) {
    res.setHeader("Content-Type", cached.contentType);
    return res.send(cached.audio);
  }
  
  const result = await synthesizeYandexTts({ text, voice, format: "mp3" });
  if (!result.ok) return res.status(500).json({ error: result.error });
  
  putTtsInCache(text, voice, "mp3", result.audio!, result.contentType!);
  res.setHeader("Content-Type", result.contentType!);
  res.send(result.audio);
});
```

### Что важно знать
- **Hard-limit 5000 символов** — функция возвращает error если больше
- **Кэш 5 минут** — для повторных запросов (например пользователь жмёт «Озвучить ещё раз»)
- **Возвращает Buffer** — можно сразу в `res.send()` или сохранить в файл
- **Formats:** mp3 (default), oggopus, lpcm

### Стоимость TTS
- **Yandex TTS:** ~400 ₽ за 1 млн символов (≈ 0.4 коп / симв)
- Helper `estimateTtsCostKopecks(textLen)` оценивает per-request стоимость

---

## 4. 📦 Plug-and-Play: чек-лист для нового проекта

### Шаг 1: Получить ключи Yandex (5 минут)

1. Открой https://console.cloud.yandex.ru
2. Создай (или выбери) **Folder** — запиши `FolderId` (формат `b1gXXX...`)
3. Создай **Сервисный аккаунт** с ролями: `ai.speechkit-stt.user` + `ai.speechkit-tts.user`
4. Создай **API-ключ** для этого аккаунта (не IAM token — он короткоживущий)
5. Запиши API-key (формат `AQVN...` или `t1.9eu...`, ~40 символов)

### Шаг 2: Скопировать файлы

```bash
# Server-side
cp apps/neurohub/server/lib/transcribe.ts <new-project>/server/lib/
cp apps/neurohub/server/lib/yandexTts.ts <new-project>/server/lib/

# Client-side (если фронт нужен)
cp apps/neurohub/client/src/components/mic-recorder.tsx <new-project>/client/src/components/
```

### Шаг 3: Установить зависимости

```bash
# Server
apt install ffmpeg  # Ubuntu
# или
brew install ffmpeg # macOS

# Client
npm install react lucide-react
# Если используешь shadcn/ui Button:
npx shadcn-ui@latest add button
```

### Шаг 4: Прописать ENV в `.env`

```bash
YANDEX_SPEECHKIT_API_KEY=>>>ВПИШИ_API_КЛЮЧ<<<
YANDEX_FOLDER_ID=>>>ВПИШИ_FOLDER_ID<<<
# Опционально:
GPTUNNEL_API_KEY=
OPENAI_API_KEY=
```

### Шаг 5: Создать endpoints

Server (Express пример):

```ts
import express from "express";
import multer from "multer";
import { transcribeRussianAudio } from "./lib/transcribe";
import { synthesizeYandexTts, getTtsFromCache, putTtsInCache } from "./lib/yandexTts";

const app = express();
app.use(express.json({ limit: "5mb" }));

const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

app.post("/api/stt", upload.single("audio"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "no audio file" });
  const ext = file.mimetype.includes("webm") ? "webm"
    : file.mimetype.includes("ogg") ? "ogg"
    : file.mimetype.includes("mp4") ? "m4a" : "bin";
  const r = await transcribeRussianAudio(file.buffer, file.mimetype, ext);
  res.json({ ok: !!r.transcript, transcript: r.transcript, provider: r.provider, attempts: r.attempts });
});

app.post("/api/tts", async (req, res) => {
  const { text, voice = "alena" } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });
  const cached = getTtsFromCache(text, voice, "mp3");
  if (cached) {
    res.setHeader("Content-Type", cached.contentType);
    return res.send(cached.audio);
  }
  const r = await synthesizeYandexTts({ text, voice, format: "mp3" });
  if (!r.ok) return res.status(500).json({ error: r.error });
  putTtsInCache(text, voice, "mp3", r.audio!, r.contentType!);
  res.setHeader("Content-Type", r.contentType!);
  res.send(r.audio);
});

app.listen(3000);
```

Client (React):

```tsx
import { MicRecorder } from "./components/mic-recorder";

function VoiceDemo() {
  const handleRec = async (file: File) => {
    const fd = new FormData();
    fd.append("audio", file);
    const r = await fetch("/api/stt", { method: "POST", body: fd });
    const { transcript } = await r.json();
    
    // Озвучка ответа
    const ttsResp = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `Вы сказали: ${transcript}`, voice: "alena" }),
    });
    const blob = await ttsResp.blob();
    new Audio(URL.createObjectURL(blob)).play();
  };

  return <MicRecorder onRecorded={handleRec} />;
}
```

### Шаг 6: Тест

1. Запусти server (`node server.js` или эквивалент)
2. Открой client в браузере на **HTTPS** (или `localhost`)
3. Кликни «Записать», скажи «Привет, как дела»
4. Должен получить transcript + услышать TTS-ответ

---

## 5. ⚠ Pitfalls / типичные ошибки

| Симптом | Причина | Решение |
|---|---|---|
| `getUserMedia` запрос не появляется | Не HTTPS | Использовать HTTPS или localhost |
| Yandex STT вернул HTTP 401 | Неверный API-ключ или роль | Проверить роль `ai.speechkit-stt.user` |
| Yandex STT HTTP 200 но `result=""` | Тишина в записи или ффmpeg не сработал | Проверить ffmpeg в PATH, log buffer size |
| `ffmpeg: command not found` | Не установлен | `apt install ffmpeg` |
| Запись 30+ сек обрывается | Yandex short-audio limit | Использовать long-audio (другой endpoint) или дробить |
| iOS Safari не пишет аудио | User gesture отсутствует | Click handler перед `getUserMedia` |
| Webm не работает в Safari | Safari пишет mp4 | Pickmime() уже handles |
| TTS возвращает 400 text too long | Текст > 5000 симв | Разбить на куски и склеить mp3 ffmpeg-ом |

---

## 6. 🔒 Безопасность

- **API ключ Yandex** хранить ТОЛЬКО в `.env` server-side, **никогда** не показывать клиенту
- **CORS** настроить если client на другом домене
- **Rate limit** на endpoints — без него можно сжечь квоту Yandex за минуту
- **Audio size limit** через multer/busboy — 5 MB достаточно для 30-сек записи

Минимальный rate-limit (in-memory):

```ts
const sttHits = new Map<string, number[]>();
app.post("/api/stt", (req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const recent = (sttHits.get(ip) || []).filter(t => now - t < 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: "rate limit" });
  recent.push(now);
  sttHits.set(ip, recent);
  next();
}, upload.single("audio"), /* ... handler */);
```

---

## 7. 🚀 Альтернативы и расширения

### Если нужен long-audio (>30 сек) STT
Yandex SpeechKit long-audio: https://yandex.cloud/ru/docs/speechkit/stt/transcribation
- Асинхронный API, через S3 bucket
- Бесплатно до 60 минут/месяц
- Дороже short-audio

### Если нужен streaming STT (real-time)
Yandex SpeechKit gRPC streaming:
- Низкая latency (~200ms)
- Сложнее интеграция
- Поддержка только Node.js / Go / Python SDK

### Если нужно other languages
- Yandex поддерживает: ru-RU, en-US, kk-KK, uk-UK, и др. — параметр `lang`
- OpenAI Whisper — auto-detect language

### Если нужно voice cloning или premium voices
- Yandex Premium voices доступны через console (extra cost)
- ElevenLabs (US), Resemble.ai (US) — но платно и за рубежом

---

## 8. 📊 Метрики и мониторинг

Что логировать в production:
- **STT**: `provider` (yandex/gptunnel/openai), `durationMs`, `httpStatus`, `transcript.length`, `bufferSize`
- **TTS**: `voice`, `textLen`, `durationMs`, cache hit/miss
- **Errors**: full `attempts[]` от transcribe — для диагностики

Алерты:
- 5 STT errors / минута → провайдер down
- Cache hit rate <30% → стоит увеличить TTL
- Avg STT duration > 5 сек → ffmpeg slow или провайдер deg

---

## 9. 📁 Список файлов для копи-паста

```
NEW PROJECT structure:
├── server/
│   ├── lib/
│   │   ├── transcribe.ts          ← copy as-is
│   │   └── yandexTts.ts           ← copy as-is
│   └── routes/
│       └── audio.ts               ← создать (см. Шаг 5 выше)
├── client/
│   └── components/
│       └── mic-recorder.tsx       ← copy as-is
├── .env                           ← добавить 2 yandex vars
└── package.json                   ← + react + lucide-react
```

**Все 3 файла самодостаточны, без внутренних импортов нашего проекта.**

---

## 10. Quick-test bash для проверки yandex ключа

```bash
TOK="YOUR_API_KEY"
FOLDER="YOUR_FOLDER_ID"

# Тест TTS — должен скачать mp3
curl -X POST "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize" \
  -H "Authorization: Api-Key $TOK" \
  -d "text=Привет, мир&lang=ru-RU&voice=alena&format=mp3&folderId=$FOLDER" \
  -o /tmp/test.mp3 && ls -la /tmp/test.mp3

# Тест STT — нужен .ogg файл
# curl -X POST "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?topic=general&lang=ru-RU&format=oggopus&folderId=$FOLDER" \
#   -H "Authorization: Api-Key $TOK" \
#   --data-binary "@audio.ogg"
```

Если оба curl возвращают валидные ответы — ключи работают, можно интегрировать.

---

*Документ подготовлен 2026-05-20 для extraction в сторонние проекты. Все code-snippets копируются как есть, env vars подставляются один раз. Pipeline проверен на production muzaai.ru — handles ~50 STT requests/день без проблем.*
