# Voice-Admin Audit — 2026-05-24

**Босс:** «диалог с Музой из админ-панели не работает».
**Симптом:** клик «Сказать Музе» в master-dashboard → «Запись слишком короткая — попробуй ещё раз (минимум 1 сек).» сразу после release кнопки. Микрофон permission уже выдан.

## Точная схема flow

```
[Browser]
 1. Click «🎤» → getUserMedia → MediaStream
 2. new MediaRecorder(stream, {mimeType}) → recorder
    ⚠ iOS Safari НЕ поддерживает audio/webm — даёт audio/mp4.
 3. recorder.start() (БЕЗ timeslice) → ondataavailable срабатывает ОДИН раз на stop().
 4. Click «⏹» → recorder.stop() → onstop callback → Blob.
 5. POST /api/admin/v304/voice-command  (multipart audio + ?tts=1)

[Server  apps/neurohub/server/plugins/voice-admin/module.ts]
 6. requireAdmin → multer parse (memoryStorage, 5MB cap)
 7. ALLOWED_MIMES check → file.size < 500B → STT
 8. transcribeRussianAudio (Yandex → GPTunnel Whisper → OpenAI Whisper)
    — ffmpeg перепаковка → ogg/opus → Yandex SpeechKit /stt:recognize
 9. callAdminVoiceLLM:
    – buildPersonaSystem(sessionId, "consultant", isAdmin=true)
    – ADMIN-VOICE block + dashboard snapshot inject
    – Anthropic /v1/messages tool-use loop (5 iter cap + dedupe)
    – tools = filterToolsForRole('admin') → ВСЕ MUZA_TOOLS вкл [ADMIN-ONLY]
10. ?tts=1 → synthesizeYandexTts (mp3) → audioBase64
11. admin_audit_log INSERT, response { transcript, response, actions, audioBase64 }

[Browser]
12. Если audioBase64 — new Audio(blobUrl).play()
13. Иначе — fallback на browser SpeechSynthesis (новое 2026-05-24).
```

## 7 ROOT CAUSES (атомы)

1. **iOS Safari MIME mismatch.** `MediaRecorder.isTypeSupported("audio/webm")` возвращает `false` на iPad → `new MediaRecorder(stream)` без mime → recorder отдаёт `audio/mp4`. В frontend `new Blob(chunks, { type: "audio/webm" })` ставил **неверный** type. Server `ALLOWED_MIMES` тогда не имел `audio/mp4` варианта с codec-suffix (уже был base, но через split срабатывал) — но ffmpeg на сервере получал mp4-данные с подписью webm и не мог корректно decode без явного `-i`.

2. **Empty/incomplete blob.** `recorder.start()` без `timeslice` → `ondataavailable` срабатывает один раз на `stop()`. На iOS Safari + короткой записи (~1 сек) этот блок мог приходить пустым/неполным. Без `recorder.requestData()` перед `stop()` chunks не дренировались.

3. **500 B пороговый — слишком жёсткий.** Короткая фраза «покажи метрики» на iOS Safari в mp4 формате = 600B–1.2KB. Хордкод `blob.size < 500` блокировал валидные записи на iPad.

4. **MIME ALLOWED_MIMES set неполный.** Не было `audio/opus`, `audio/aacp`, `audio/3gpp`, `application/octet-stream` (когда browser не выставил MIME).

5. **TTS no-fallback.** Если `YANDEX_SPEECHKIT_API_KEY` отсутствует / квота закончилась — `audioBase64` пуст → client просто `setState("idle")` → Босс не получает голосовой ответ совсем.

6. **Persona admin block слабый.** В `consultantPersona.ts` admin-режим разрешал темы, но НЕ инструктировал «вызывай tool сразу, без переспросов period/что-то ещё». LLM иногда отвечал «уточни какой период» вместо `get_metrics({period:"today"})`.

7. **File extension mismatch на upload.** `fd.append("audio", blob, "voice.webm")` всегда `.webm` — даже для mp4. Сервер передавал `ext='webm'` в `transcribeRussianAudio` → ffmpeg `inExt='webm'` → пытался decode mp4 как webm, иногда фейлил.

## Applied fixes (file:line)

### Frontend — `apps/neurohub/client/src/pages/admin/master-dashboard-tab.tsx`

- **L1219-1252** Добавлен `recordingStartedAtRef`, `actualMimeRef`.
- **L1324-1378** Cross-browser MIME selection — кандидаты `webm;opus → webm → mp4;codecs → mp4 → ogg;opus → default`. Запоминаем `recorder.mimeType` как actual MIME.
- **L1349-1377** `recorder.start(250)` с timeslice — гарантия что chunks отдаются каждые 250ms. Fallback на `start()` для старых Safari.
- **L1338-1369** `onstop`: проверка по `elapsedMs >= 350` (не размеру), `blob.size >= 200`. Blob создаётся с **реальным** MIME.
- **L1382-1396** `stopRecording`: `requestData()` перед `stop()` — flush pending chunks.
- **L1395-1431** `uploadAudio(blob, mimeOverride)` — file extension по реальному MIME (`m4a`/`ogg`/`wav`/`mp3`/`webm`).
- **L1454-1476** `else if (autoTts && data.response)` — browser `SpeechSynthesis` fallback когда Yandex TTS не вернул audio.

### Backend — `apps/neurohub/server/plugins/voice-admin/module.ts`

- **L312-336** `ALLOWED_MIMES` расширен: `audio/opus`, `audio/aac`, `audio/aacp`, `audio/3gpp`, `audio/3gpp2`, `application/octet-stream`.
- **L611-616** Unknown MIME → warn + accept (не reject). ffmpeg сам determinate через magic-bytes.
- **L617-627** `file.size < 500` → `file.size < 200` с понятным сообщением.
- **L629-640** `ext` определяется по реальному `baseMime` (не хардкод `webm`).
- **L642-657** STT failure → возвращает summary attempts от всех провайдеров (yandex/gptunnel/openai) для admin-debug.

### Persona — `apps/neurohub/server/lib/consultantPersona.ts`

- **L1289-1303** Добавлен 🎤 ГОЛОСОВОЙ АДМИН-РЕЖИМ блок: «вызывай tool сразу без переспроса period, по умолчанию today, мутирующие tools озвучивай перед выполнением, ответ 1-3 предложения для TTS».

## Что Босс должен проверить (env vars + verify)

### 1. Env keys на prod (`31.130.148.107`)

```bash
ssh root@31.130.148.107 'awk -F= "/^YANDEX_SPEECHKIT_API_KEY/{print \"YDX_STT:\", length(\$2), substr(\$2,1,4)} /^YANDEX_FOLDER_ID/{print \"FOLDER:\", length(\$2), substr(\$2,1,4)} /^ANTHROPIC_API_KEY/{print \"ANTH:\", length(\$2), substr(\$2,1,7)} /^OPENAI_API_KEY/{print \"OPENAI:\", length(\$2), substr(\$2,1,7)} /^GPTUNNEL_API_KEY/{print \"GPT:\", length(\$2), substr(\$2,1,4)}" /var/www/neurohub/.env'
```

Ожидаем:
- `YDX_STT` length ≥ 40 (формат `AQVN...` или `t1.9eu...`)
- `FOLDER` length ≥ 20 (формат `b1g...`)
- `ANTH` начинается с `sk-ant-` length ≈ 108
- `OPENAI` или `GPT` — хотя бы один из них есть как fallback

Если YDX_STT отсутствует — STT chain попробует GPTunnel Whisper / OpenAI Whisper (см. transcribe.ts). Если ВСЕ три отсутствуют → voice-admin недоступен.

### 2. Verify endpoint работает

После next deploy открыть на устройстве с микрофоном:
**https://muzaai.ru/#/admin → Сводка → секция «🎙 Сказать Музе»**

### 3. Тестовый sequence (что сказать в микрофон)

| # | Команда голосом | Ожидаемое поведение |
|---|---|---|
| 1 | «покажи метрики за сегодня» | LLM вызывает `get_metrics({period:"today"})` → озвучивает counts регистраций / генераций / платежей |
| 2 | «сколько генераций упало сегодня» | `get_metrics` → читает music.error → произносит число |
| 3 | «покажи последние инциденты» | `get_recent_incidents` → 3-5 коротких описаний |
| 4 | «покажи топ юзеров с ошибками» | `get_failed_users` → top-3 group_keys |
| 5 | «состояние каналов» | `get_bot_channels_status` → web/TG/Max + LLM движок |
| 6 | «сфокусируй на Telegram» | `focus_brain_node({name:"Telegram"})` — UI feedback в 3D mozg |
| 7 | «перезагрузи KB» | `reload_kb` → возвращает `requiresEmailConfirm` → модалка 2FA → ввести код → повторить команду |

### 4. Если всё ещё «Запись слишком короткая» после deploy

- Открыть DevTools Console на /admin → произнести команду → смотреть network tab → запрос `/api/admin/v304/voice-command` должен иметь Content-Type `multipart/form-data` и audio file.
- В Console смотреть warnings — `auto-play blocked` (если есть, нужен user gesture перед первым play).
- В audit-log на сервере смотреть `entity='voice-admin:command'` записи — там `audioBytes`, `audioMime`, `transcript` для каждого запроса.

```bash
ssh root@31.130.148.107 "sqlite3 /var/www/neurohub/data.db \"SELECT created_at, json_extract(after_json, '\$.audioBytes') AS bytes, json_extract(after_json, '\$.audioMime') AS mime, json_extract(after_json, '\$.transcript') AS tx FROM admin_audit_log WHERE entity='voice-admin:command' ORDER BY id DESC LIMIT 10;\""
```

## Compat / непротиворечие правилам

- ✅ Persistent-audio-only rule: TTS reply использует `new Audio(blobUrl)` (one-shot, не player audio). Explicit исключение в правиле для admin preview / TTS one-shot.
- ✅ Secrets-admin-only: keys остаются в .env, ответы LLM не содержат raw values (только status / length).
- ✅ Reuse-working-solutions: используется существующий `transcribeRussianAudio` chain + `callAdminVoiceLLM` + `synthesizeYandexTts` — без параллельных endpoints.
- ✅ Musa-female-voice rule: persona admin block обновлён (общается в женском роде согласно basePersona).
