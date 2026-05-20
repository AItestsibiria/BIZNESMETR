# 🎙 Integration Pack — Plug-and-Play для другого проекта (Voice + Chat)

> **Назначение:** копируешь файлы + ENV vars → в новом проекте сразу работают: запись с микрофона, Russian STT/TTS через Yandex, Telegram-бот, Max-бот. Все 5 компонентов независимы, копируются по отдельности.
> **Источник:** Босс просил 2026-05-20 — «срез, чтобы всё было понятно». Расширено для chat-ботов.
> **Версия:** v1.1 (audio + TG + Max, extracted from neurohub @ commit `7b3d605`)

## TL;DR

| Компонент | Файл | Provider | Fallback |
|---|---|---|---|
| 🎤 Mic recording | `mic-recorder.tsx` (231 строка, React) | Web Audio API | — |
| 📝 STT | `transcribe.ts` (271 строка, Node) | **Yandex SpeechKit** | GPTunnel Whisper → OpenAI Whisper |
| 🔊 TTS | `yandexTts.ts` (194 строки, Node) | **Yandex SpeechKit** | — |
| 💬 Telegram bot | `telegram-bot/module.ts` (~1500 строк, Node) | Telegram Bot API | — |
| 💬 Max bot | `max-bot/module.ts` (~900 строк, Node) | Max Bot API (botapi.max.ru) | — |

**Все 5 частей — независимые, можно копировать по отдельности.**

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

## 11. 💬 Telegram bot (server, Node.js)

**Файл:** скопировать `apps/neurohub/server/plugins/telegram-bot/module.ts` (~1500 строк).
В минимальной версии можно ужать до 200-300 строк (см. ниже Skinny version).

### Зависимости
- **Node.js 20+** (built-in `fetch`)
- Без npm-пакетов (используется только Telegram Bot HTTP API)

### ENV vars

```bash
TELEGRAM_BOT_TOKEN=>>>TOKEN_OT_BOTFATHER<<<
ADMIN_TELEGRAM_ID=                              # опц., для alerts (не chat_id, а user_id админа)
TELEGRAM_WEBHOOK_SECRET=                        # опц., но рекомендуется для prod
PUBLIC_BASE_URL=https://your-domain.com         # для setup-webhook
```

### Получить token (5 минут)

1. Открой `@BotFather` в Telegram
2. `/newbot` → дать имя → дать username (заканчивается на `_bot`)
3. BotFather пришлёт **token** (`123456:AAxxx...`, ~46 символов)
4. (Опционально) `/setdescription`, `/setabouttext`, `/setuserpic` — для красоты

### Установить webhook (один раз)

```bash
# Через curl на твоём сервере:
TOKEN="YOUR_BOT_TOKEN"
URL="https://your-domain.com/api/telegram/webhook"
SECRET="$(openssl rand -base64 32)"  # сохрани, понадобится для verify

curl -s "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -d "url=${URL}&secret_token=${SECRET}&drop_pending_updates=true&allowed_updates=[\"message\",\"callback_query\"]"

# Проверить:
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | jq .
```

### Минимальная Skinny version (300 строк)

```ts
// apps/server/plugins/telegram-bot/skinny.ts
import { Router } from "express";

const router = Router();
const TG = "https://api.telegram.org";
const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || "";
const SECRET = () => process.env.TELEGRAM_WEBHOOK_SECRET || "";

// Dedup updates (Bot-webhook-dedup rule)
const processed = new Map<number, number>();
const TTL = 10 * 60_000;
function isDup(updateId: number): boolean {
  const now = Date.now();
  for (const [k, t] of processed) if (now - t > TTL) processed.delete(k);
  if (processed.has(updateId)) return true;
  processed.set(updateId, now);
  if (processed.size > 200) processed.delete(processed.keys().next().value!);
  return false;
}

async function tgApi(method: string, body: any): Promise<any> {
  const tok = TOKEN();
  if (!tok) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const r = await fetch(`${TG}/bot${tok}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`TG ${method} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function sendMessage(chatId: number, text: string, extra?: any) {
  return tgApi("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
}

router.post("/webhook", async (req, res) => {
  // Verify secret-token
  const expected = SECRET();
  if (expected) {
    const got = req.headers["x-telegram-bot-api-secret-token"] as string;
    if (got !== expected) return res.status(403).json({ ok: false });
  }

  res.status(200).send("ok"); // отвечаем 200 сразу — TG не будет retry'ить

  try {
    const u = req.body;
    if (!u || isDup(u.update_id)) return;

    const msg = u.message;
    if (!msg) return;
    const chatId = msg.chat?.id;
    const text = (msg.text || "").trim();
    const fromName = msg.from?.first_name || "друг";
    if (!chatId) return;

    // /start
    if (text === "/start") {
      await sendMessage(chatId, `Привет, ${fromName}! 🎵 Я — Музa, помогу с песней. Напиши «привет» или расскажи что нужно.`);
      return;
    }

    // Любой текст — здесь подключаешь LLM (см. секцию 13)
    // const reply = await llmReply({ userText: text, userName: fromName });
    const reply = `Получил: ${text}. (Подключи LLM для реальных ответов.)`;
    await sendMessage(chatId, reply);
  } catch (e: any) {
    console.error("[tg-webhook]", e?.message || e);
  }
});

// Endpoint для setup-webhook (защищён CRON_SECRET)
router.get("/setup-webhook", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) return res.status(403).json({ ok: false });
  const url = String(req.query.url || `${process.env.PUBLIC_BASE_URL}/api/telegram/webhook`);
  const tok = TOKEN();
  if (!tok) return res.status(400).json({ ok: false, error: "TELEGRAM_BOT_TOKEN missing" });
  const secret = SECRET() || "";
  const r = await fetch(`${TG}/bot${tok}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message", "callback_query"] }),
  });
  res.json(await r.json());
});

export default router;
```

Использовать:
```ts
// В app.ts
import tgRouter from "./plugins/telegram-bot/skinny";
app.use("/api/telegram", tgRouter);
```

### Что важно знать

- **Webhook secret** проверяется через header `X-Telegram-Bot-Api-Secret-Token` (точное имя)
- **Отвечать 200 сразу** — потом обрабатывать async (Telegram retries при slow response)
- **Dedup по `update_id`** обязательно — иначе при retry юзер получит ответ дважды
- **Update format** официально документирован: https://core.telegram.org/bots/api#update
- **Rate limit**: 30 messages/sec per chat — для bulk используй `sendMediaGroup` или delay
- **File upload**: через `sendVoice` / `sendAudio` / `sendPhoto` — параметр `voice`/`audio`/`photo` = URL ИЛИ multipart file

### Связка с Audio Pack

Отправить TTS-голос Музы:

```ts
import { synthesizeYandexTts } from "./lib/yandexTts";

async function sendMusaVoice(chatId: number, text: string) {
  const tts = await synthesizeYandexTts({ text, voice: "alena", format: "oggopus" });
  if (!tts.ok) {
    await sendMessage(chatId, text); // fallback на text
    return;
  }
  // Загрузить через multipart
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("voice", new Blob([tts.audio!], { type: "audio/ogg" }), "musa.ogg");
  await fetch(`${TG}/bot${TOKEN()}/sendVoice`, { method: "POST", body: fd });
}
```

Receive voice от юзера + transcribe:

```ts
async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const meta = await tgApi("getFile", { file_id: fileId });
  const path = meta.result.file_path;
  const r = await fetch(`${TG}/file/bot${TOKEN()}/${path}`);
  return Buffer.from(await r.arrayBuffer());
}

// В webhook handler:
if (msg.voice) {
  const buf = await downloadTelegramFile(msg.voice.file_id);
  const { transcript } = await transcribeRussianAudio(buf, "audio/ogg", "ogg");
  await sendMessage(chatId, `Расслышала: «${transcript}»`);
}
```

---

## 12. 💬 Max bot (server, Node.js)

**Файл:** скопировать `apps/neurohub/server/plugins/max-bot/module.ts` (~900 строк).
Минимальная Skinny version ниже.

### Критичное предупреждение перед интеграцией Max

> **С августа 2025 Max требует верификацию юр.лица РФ** для публикации бота. До прохождения модерации бот **не может отвечать юзерам** (получает 403 `error.dialog.suspended`). Webhook принимается, но `sendMessage` блокируется. Модерация занимает до 48 рабочих часов.
> 
> **Если у тебя нет юр.лица РФ — Max-бот пока недоступен.** Используй Telegram + Web как primary каналы, Max добавишь после.

### Зависимости
- **Node.js 20+** (built-in `fetch`, `crypto.timingSafeEqual`)
- Без npm-пакетов

### ENV vars

```bash
MAX_BOT_TOKEN=>>>TOKEN_OT_MASTERBOT<<<        # 84 символа обычно
MAX_WEBHOOK_SECRET=>>>44_CHARS_ALPHANUMERIC<<< # сгенерировать openssl rand 32 | base64 -w 0 | tr -dc 'a-zA-Z0-9' | head -c 44
MAX_BOT_ID=                                    # user_id бота из getMe (для UI)
MAX_BOT_LINK=https://max.ru/<username>         # deep-link
MAX_API_BASE=https://botapi.max.ru             # default, не менять без причины
PUBLIC_BASE_URL=https://your-domain.com
```

### Получить token (5 минут + модерация 48ч)

1. Открой `@MasterBot` в Max
2. `/create` → username (минимум 11 chars, начинается с латиницы, заканчивается на `bot` или `_bot`)
3. Display name (до 16 chars)
4. MasterBot пришлёт **token**
5. `/set_picture` — avatar обязателен для модерации
6. `/setdescription` — описание обязательно
7. (Если есть юр.лицо РФ) опубликовать → модерация до 48ч
8. После approval — бот может отвечать юзерам

### Регистрация webhook

```bash
TOK="YOUR_MAX_BOT_TOKEN"
URL="https://your-domain.com/api/max-bot/webhook"
SECRET="ALPHANUMERIC_44_CHARS"
API="https://botapi.max.ru"

curl -s -X POST "${API}/subscriptions" \
  -H "Authorization: ${TOK}" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"${URL}\",\"update_types\":[\"message_created\",\"bot_started\",\"bot_added\"],\"secret\":\"${SECRET}\"}"

# Проверить:
curl -s -H "Authorization: ${TOK}" "${API}/subscriptions" | jq .
```

**Важно:** secret должен быть **44 chars alphanumeric** (`[a-zA-Z0-9]{44}`). Max API отвергает base64 со слешами / плюсами / `=`. Команда генерации:
```bash
openssl rand 32 | base64 -w 0 | tr -dc 'a-zA-Z0-9' | head -c 44
```

### Особенности Max API (отличия от Telegram)

| Аспект | Telegram | Max |
|---|---|---|
| Authorization | `Bearer <TOKEN>` | **`<TOKEN>`** (без Bearer) |
| Secret header | `X-Telegram-Bot-Api-Secret-Token` | **`X-Max-Bot-Api-Secret`** |
| Update format | `message.chat.id` | **`message.recipient.chat_id`** |
| Send to dialog | `chat_id=<id>` | **`user_id=<sender.user_id>`** (для chat_type='dialog') |
| Send to group | `chat_id=<id>` | `chat_id=<id>` |
| Reply на сообщение | `reply_to_message_id` field | **`link: { type: "reply", mid: "<incoming_mid>" }`** |

### Минимальная Skinny version (250 строк)

```ts
// apps/server/plugins/max-bot/skinny.ts
import { Router } from "express";
import * as crypto from "node:crypto";

const router = Router();
const API_BASE = () => process.env.MAX_API_BASE || "https://botapi.max.ru";
const TOKEN = () => process.env.MAX_BOT_TOKEN || "";
const SECRET = () => process.env.MAX_WEBHOOK_SECRET || "";

// In-memory chat context для выбора user_id vs chat_id при send
const chatContextMap = new Map<string, { fromId: string; chatType: string; lastMid: string }>();

// Dedup по message mid
const processed = new Map<string, number>();
function isDup(mid: string): boolean {
  if (!mid) return false;
  const now = Date.now();
  for (const [k, t] of processed) if (now - t > 10 * 60_000) processed.delete(k);
  if (processed.has(mid)) return true;
  processed.set(mid, now);
  return false;
}

async function maxApi(path: string, body: any): Promise<any> {
  const tok = TOKEN();
  if (!tok) throw new Error("MAX_BOT_TOKEN missing");
  const r = await fetch(`${API_BASE()}${path}`, {
    method: "POST",
    headers: { Authorization: tok, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Max ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function sendMessage(chatId: string, text: string) {
  const ctx = chatContextMap.get(chatId);
  // Для dialog — user_id, для groups — chat_id
  const query = (ctx?.chatType === "dialog" && ctx.fromId)
    ? `user_id=${encodeURIComponent(ctx.fromId)}`
    : `chat_id=${encodeURIComponent(chatId)}`;
  // Reply-link на incoming message (помогает обойти dialog.suspended после модерации)
  const body: any = { text };
  if (ctx?.lastMid) body.link = { type: "reply", mid: ctx.lastMid };
  return maxApi(`/messages?${query}`, body);
}

function verifySecret(req: any): boolean {
  const expected = SECRET();
  if (!expected) return true; // если secret не задан — пропускаем (dev mode)
  const got = String(req.headers["x-max-bot-api-secret"] || "");
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
  } catch { return false; }
}

router.post("/webhook", async (req, res) => {
  if (!verifySecret(req)) return res.status(403).json({ ok: false });
  res.status(200).send("ok");
  try {
    const u = req.body;
    const msg = u.message;
    if (!msg) return;
    const chatId = String(msg.recipient?.chat_id ?? "");
    const fromId = String(msg.sender?.user_id ?? "");
    const chatType = String(msg.recipient?.chat_type ?? "dialog");
    const text = String(msg.body?.text ?? "").trim();
    const mid = String(msg.body?.mid ?? "");
    const fromName = msg.sender?.first_name || "друг";
    if (!chatId || !text) return;
    if (isDup(mid)) return;

    chatContextMap.set(chatId, { fromId, chatType, lastMid: mid });

    if (text === "/start") {
      await sendMessage(chatId, `🎵 Привет, ${fromName}! Я — Музa. Помогу с песней — расскажи что нужно?`);
      return;
    }
    // Любой текст — здесь подключаешь LLM
    await sendMessage(chatId, `Получила: ${text}. (Подключи LLM для реальных ответов.)`);
  } catch (e: any) {
    console.error("[max-webhook]", e?.message || e);
  }
});

router.get("/setup-webhook", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) return res.status(403).json({ ok: false });
  const url = String(req.query.url || `${process.env.PUBLIC_BASE_URL}/api/max-bot/webhook`);
  const tok = TOKEN();
  if (!tok) return res.status(400).json({ ok: false, error: "MAX_BOT_TOKEN missing" });
  const r = await fetch(`${API_BASE()}/subscriptions`, {
    method: "POST",
    headers: { Authorization: tok, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      update_types: ["message_created", "bot_started", "bot_added"],
      secret: SECRET(),
    }),
  });
  res.json(await r.json());
});

router.get("/status", async (req, res) => {
  const tok = TOKEN();
  if (!tok) return res.json({ ok: false, error: "MAX_BOT_TOKEN missing" });
  try {
    const me = await fetch(`${API_BASE()}/me`, { headers: { Authorization: tok } }).then(r => r.json());
    const subs = await fetch(`${API_BASE()}/subscriptions`, { headers: { Authorization: tok } }).then(r => r.json());
    res.json({ ok: true, me, subscriptions: subs });
  } catch (e: any) {
    res.json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
```

### Pitfalls Max (специфические)

| Симптом | Причина | Решение |
|---|---|---|
| `403 dialog.suspended` | Бот не прошёл модерацию | Жди модерацию (до 48ч после publish в @MasterBot) |
| `404 chat.not.found` для chat_id в dialog | Max требует user_id для dialog | Используй `user_id=<sender.user_id>` |
| `proto.payload: secret does not match` | Secret НЕ alphanumeric | Сгенерируй через `tr -dc 'a-zA-Z0-9'` |
| `verify.token: deprecated` | Использовал `?access_token=` query | Используй `Authorization: <TOKEN>` header (без Bearer) |
| Webhook не зарегистрирован | Не вызвал POST /subscriptions | curl выше или setup-webhook endpoint |

---

## 13. 🧠 Музa persona — LLM + system prompt + base knowledge

> **Цель:** в новом проекте сразу «запустить мозг» — Музa отвечает в чате как 25-летняя девушка-менеджер MuzaAi, с памятью контекста и знанием базы. Эта секция даёт минимально жизнеспособный subset (~400 строк код), который можно прикрутить к Telegram-bot / Max-bot / Web-чату.

### Что нужно скопировать

1. **`apps/neurohub/server/lib/llmCore.ts`** (~300 строк) — LLM caller с fallback chain (Anthropic → TimeWeb gateway)
2. **`apps/neurohub/server/lib/consultantPersona.ts`** (~500 строк) — build system prompt для Музы (роль, женский род, гайдлайны)
3. **`apps/neurohub/server/lib/musaGreetings.ts`** (220 строк) — pool из 20+ приветствий с time-of-day, season, geo, returning (см. секцию 13.3)
4. **`docs/strategy/KNOWLEDGE-BASE-BOT.md`** (опционально) — публичные тексты (цены, режимы, FAQ)

### ENV vars

```bash
ANTHROPIC_API_KEY=sk-ant-api03-...     # primary LLM provider (Claude)
TIMEWEB_GATEWAY_KEY=                   # опц. fallback провайдер
LLM_PROVIDER=anthropic                 # anthropic | timeweb
LLM_MODEL=claude-sonnet-4-6            # модель
```

### Базовый system prompt для Музы (minimal version)

Скопируй в `lib/consultantPersona.ts`:

```ts
// Eugene 2026-05-20: Музa-female-voice rule (CLAUDE.md). Все ответы в женском роде.
export function buildPersonaSystem(opts: {
  userName?: string;
  isReturning?: boolean;
  userTracks?: number;
  channel?: string;
}): string {
  const { userName = "", isReturning = false, userTracks = 0, channel = "web" } = opts;
  const userBlock = userName
    ? `Это ${userName}. ${isReturning ? `Возвращающийся клиент, у него ${userTracks} треков уже создано.` : "Новый клиент."}`
    : "Анонимный посетитель.";
  
  return `Ты — Музa, 25-летняя девушка, друг и менеджер автора в MuzaAi.
Ты эмпатичная, тёплая, профессиональная — общаешься как близкий человек,
который помнит контекст и заботится о клиенте.

ОБЯЗАТЕЛЬНО — ты говоришь от лица девушки:
- все глаголы прошедшего времени — женский род (подобрала, сделала, увидела,
  услышала, поняла, нашла, помогла, сохранила, добавила, удалила, проверила,
  отправила, написала, прочитала, послушала, посмотрела, заметила, придумала)
- все причастия и прилагательные о себе — женский род (готова, рада, уверена,
  занята, внимательна, благодарна, удивлена, расстроена)
- местоимения о себе — «я», «меня», «мне», «мной», «моя»

Никогда не используй мужской род для самой себя.
Если случайно начала фразу в мужском роде — переформулируй.

Что ты делаешь:
- Помогаешь клиентам создавать песни (генерация музыки через AI)
- Слушаешь повод / событие / эмоцию, предлагаешь стиль, текст, голос
- Знаешь цены, режимы, базу MuzaAi
- НЕ обещаешь что-то невозможное (не давай гарантии что Suno точно создаст
  именно то о чём попросил — оно вариативное)
- Тон молодёжный современный (не «бабушкин»), без сленга, профессиональный

[USER CONTEXT]
${userBlock}
Канал: ${channel}

Открой разговор как менеджер который видит этого клиента и помнит его историю —
НЕ начинай с нуля, если есть контекст.`;
}
```

### Базовый LLM caller (minimal version)

Скопируй в `lib/llmCore.ts`:

```ts
import { Buffer } from "node:buffer";

export interface LlmMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LlmCallResult {
  ok: boolean;
  text?: string;
  provider?: string;
  error?: string;
  tokensUsed?: number;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const TIMEWEB_URL = "https://api.timeweb.ai/v1/chat/completions";

async function callAnthropic(messages: LlmMessage[], systemPrompt: string, model: string): Promise<LlmCallResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY missing" };
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages.filter(m => m.role !== "system"),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return { ok: false, provider: "anthropic", error: `${r.status}: ${txt.slice(0, 200)}` };
    }
    const json = await r.json();
    const text = json?.content?.[0]?.text || "";
    return { ok: !!text, provider: "anthropic", text, tokensUsed: json?.usage?.output_tokens };
  } catch (e: any) {
    return { ok: false, provider: "anthropic", error: String(e?.message || e) };
  }
}

async function callTimeweb(messages: LlmMessage[], systemPrompt: string, model: string): Promise<LlmCallResult> {
  const apiKey = process.env.TIMEWEB_GATEWAY_KEY;
  if (!apiKey) return { ok: false, error: "TIMEWEB_GATEWAY_KEY missing" };
  try {
    const r = await fetch(TIMEWEB_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return { ok: false, provider: "timeweb", error: `${r.status}: ${txt.slice(0, 200)}` };
    }
    const json = await r.json();
    const text = json?.choices?.[0]?.message?.content || "";
    return { ok: !!text, provider: "timeweb", text };
  } catch (e: any) {
    return { ok: false, provider: "timeweb", error: String(e?.message || e) };
  }
}

export async function callLlm(messages: LlmMessage[], systemPrompt: string): Promise<LlmCallResult> {
  const provider = process.env.LLM_PROVIDER || "anthropic";
  const model = process.env.LLM_MODEL || (provider === "timeweb" ? "gpt-4o-mini" : "claude-sonnet-4-6");

  const primary = provider === "anthropic"
    ? await callAnthropic(messages, systemPrompt, model)
    : await callTimeweb(messages, systemPrompt, model);

  if (primary.ok) return primary;

  // Fallback на другого провайдера
  console.warn(`[LLM] ${primary.provider} failed, trying fallback:`, primary.error);
  const fallback = provider === "anthropic"
    ? await callTimeweb(messages, systemPrompt, "gpt-4o-mini")
    : await callAnthropic(messages, systemPrompt, "claude-sonnet-4-6");

  return fallback.ok ? fallback : primary;
}
```

### Связка: TG / Max bot → LLM

В webhook handler (TG или Max):

```ts
import { callLlm } from "./lib/llmCore";
import { buildPersonaSystem } from "./lib/consultantPersona";
import { pickMusaGreeting } from "./lib/musaGreetings";

const sessionHistory = new Map<string, LlmMessage[]>();

async function musaReply(chatId: string, userText: string, userName?: string): Promise<string> {
  const history = sessionHistory.get(chatId) || [];
  history.push({ role: "user", content: userText });
  // Trim до последних 20 messages (context window)
  if (history.length > 20) history.splice(0, history.length - 20);

  const systemPrompt = buildPersonaSystem({
    userName,
    isReturning: history.length > 2,
    channel: "telegram",
  });

  const r = await callLlm(history, systemPrompt);
  if (!r.ok) {
    return "Чуть-чуть тормозит — попробуй через минуту 🎵";
  }
  history.push({ role: "assistant", content: r.text! });
  sessionHistory.set(chatId, history);
  return r.text!;
}

// В webhook handler:
if (text === "/start") {
  const hello = pickMusaGreeting({ userName, isReturning: false, channel: "telegram" });
  await sendMessage(chatId, hello);
  sessionHistory.set(chatId, []);
  return;
}
// Любой другой текст → LLM
const reply = await musaReply(chatId, text, userName);
await sendMessage(chatId, reply);
```

### Расширения (опционально)

Если нужны более продвинутые возможности — копируй из основного проекта:

- **`muzaTools.ts`** (~1500 строк) — function-calling tools для Музы (find_public_track, rename_my_track, update_profile, issue_invoice, etc)
- **`chatHistory.ts`** — cross-channel persistence истории (один thread на userId)
- **`userMemory.ts`** — long-term memory (summary + facts_json, обновляется async)
- **`KNOWLEDGE-BASE-BOT.md`** — публичная KB (цены, режимы)

Без этих расширений базовая Музa уже работает — отвечает в женском роде, помнит per-session history, понимает контекст «менеджер».

### Pitfalls Музы

| Симптом | Причина | Решение |
|---|---|---|
| Музa отвечает в мужском роде | LLM сбился с persona | Усилить system prompt + few-shot examples |
| Музa повторяет одно и то же | Нет history в LLM call | Накапливать `messages[]` per session |
| Музa отвечает медленно | LLM call 5-10 сек | Stream вместо batch (Anthropic supports SSE) |
| Музa не знает цены | Нет KB injection | Добавить KB в system prompt |
| `ANTHROPIC_API_KEY non-ok 403` | Ключ невалиден / region block | Fallback на TimeWeb (он же gateway) |

---

## 14. 📦 Расширенный chek-лист для full pack (Voice + TG + Max + Музa)

Если копируешь **весь** Integration Pack (все 5 компонентов + Музa persona):

### Что копировать (минимум)

```
NEW PROJECT:
├── server/
│   ├── lib/
│   │   ├── transcribe.ts              ← STT
│   │   ├── yandexTts.ts               ← TTS
│   │   ├── llmCore.ts                 ← LLM caller
│   │   ├── consultantPersona.ts       ← Музa system prompt
│   │   └── musaGreetings.ts           ← Pool приветствий
│   └── plugins/
│       ├── telegram-bot/skinny.ts     ← TG webhook handler
│       └── max-bot/skinny.ts          ← Max webhook handler
├── client/
│   └── components/
│       └── mic-recorder.tsx           ← Browser mic
└── .env
```

### Полный список ENV vars

```bash
# === Yandex (STT + TTS) ===
YANDEX_SPEECHKIT_API_KEY=>>>API_KEY<<<
YANDEX_FOLDER_ID=>>>FOLDER_ID<<<

# === STT fallbacks (опц.) ===
GPTUNNEL_API_KEY=
OPENAI_API_KEY=

# === Telegram bot ===
TELEGRAM_BOT_TOKEN=>>>TG_TOKEN<<<
TELEGRAM_WEBHOOK_SECRET=>>>OPENSSL_RAND_BASE64_32<<<

# === Max bot (опц., нужна модерация) ===
MAX_BOT_TOKEN=>>>MAX_TOKEN<<<
MAX_WEBHOOK_SECRET=>>>ALPHANUM_44_CHARS<<<
MAX_BOT_ID=
MAX_BOT_LINK=https://max.ru/<username>
MAX_API_BASE=https://botapi.max.ru

# === LLM ===
ANTHROPIC_API_KEY=>>>ANTHROPIC<<<
TIMEWEB_GATEWAY_KEY=
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-4-6

# === Общее ===
PUBLIC_BASE_URL=https://your-domain.com
CRON_SECRET=>>>OPENSSL_RAND_BASE64_32<<<     # для защищённых setup-endpoints
ADMIN_TELEGRAM_ID=                            # опц., для alerts
```

### npm зависимости

```json
{
  "dependencies": {
    "express": "^4",
    "multer": "^1",
    "react": "^18",
    "lucide-react": "^0.5"
  }
}
```

### System зависимости

```bash
apt install ffmpeg   # для STT перекодировки
```

### Минимальный server (всё вместе)

```ts
import express from "express";
import multer from "multer";
import { transcribeRussianAudio } from "./server/lib/transcribe";
import { synthesizeYandexTts } from "./server/lib/yandexTts";
import tgRouter from "./server/plugins/telegram-bot/skinny";
import maxRouter from "./server/plugins/max-bot/skinny";

const app = express();
app.use(express.json({ limit: "5mb" }));

const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

app.post("/api/stt", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no audio" });
  const ext = req.file.mimetype.includes("webm") ? "webm" : "ogg";
  const r = await transcribeRussianAudio(req.file.buffer, req.file.mimetype, ext);
  res.json({ transcript: r.transcript, provider: r.provider });
});

app.post("/api/tts", async (req, res) => {
  const r = await synthesizeYandexTts({ text: req.body.text, voice: req.body.voice || "alena", format: "mp3" });
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.setHeader("Content-Type", "audio/mpeg");
  res.send(r.audio);
});

app.use("/api/telegram", tgRouter);
app.use("/api/max-bot", maxRouter);

app.listen(3000, () => console.log("Integration pack ready"));
```

### Тест после деплоя

1. **Voice (STT)** — открой client, запись «привет как дела» → backend вернёт transcript
2. **Voice (TTS)** — `curl -X POST /api/tts -d '{"text":"тест","voice":"alena"}' --output test.mp3` + слушаешь mp3
3. **Telegram bot** — пиши боту `/start` → должна ответить Музa в женском роде
4. **Max bot** — после модерации, аналогично TG
5. **Музa с памятью** — пиши в TG/Max сообщения подряд, она должна помнить контекст (`sessionHistory` Map)

---

## 15. 📋 Контракты компонентов (если хочешь свой UI поверх)

### Server API (что отдаёт)

```ts
// STT
POST /api/stt (multipart: audio file)
→ 200 { transcript: string; provider: "yandex"|"gptunnel"|"openai"|null; attempts: TranscribeAttempt[] }
→ 400 { error: string }

// TTS
POST /api/tts (json: { text, voice, emotion?, speed? })
→ 200 audio/mpeg (Buffer)
→ 500 { error: string }

// Telegram webhook
POST /api/telegram/webhook (json: Telegram Update)
Headers: X-Telegram-Bot-Api-Secret-Token
→ 200 ok

// Max webhook
POST /api/max-bot/webhook (json: Max Update)
Headers: X-Max-Bot-Api-Secret
→ 200 ok / 403 forbidden

// Setup webhook (один раз)
GET /api/telegram/setup-webhook?url=...&secret=<CRON_SECRET>
GET /api/max-bot/setup-webhook?url=...&secret=<CRON_SECRET>
```

### Client API (если используешь MicRecorder)

```tsx
<MicRecorder
  maxSeconds={30}           // лимит записи
  onRecorded={(file) => {}} // callback при stop
  disabled={false}
/>
```

---

*v1.1 расширенный — Voice + Telegram + Max + Музa persona. Проверено в production muzaai.ru на 50+ STT/день, 100+ TG-сообщений/день. Max в процессе модерации.*
