# ТЗ v304 — Генерация по аудио (Suno audio-input)

**Статус:** черновик 2026-05-07. Базируется на актуальной spec'е sunoapi.org / kie.ai / GPTunnel media-api/suno и текущем skeleton'е `extend-cover`.

**Цель:** довести Sprint-3 skeleton `extend-cover` до прода + добавить операции, в которых **аудио — на ВХОДЕ** генерации (upload/cover/extend/voice-reference).

---

## §0. Контракт с voice-fix TZ (обязательно)

**Все** аудио-эндпоинты (cover/extend/voice-clone) обязаны проходить через
`apps/neurohub/server/lib/normalizeVocalParams.ts` ДО формирования payload в
GPTunnel. Это закрывает класс багов «выбран female — пришёл male», который
описан в отдельном TZ Eugene 2026-05-07.

Контракт:
- На вход норматизатора передаётся `{prompt, style, lyrics, voiceType, voice, isDuet, instrumental, generationId}`.
- На выход берутся `{finalPrompt, finalStyle, finalLyrics, voiceType}` — это
  и идёт в Suno-payload.
- В DB сохраняется `generations.voiceType` для будущего regenerate/extend.
- voiceType `"auto"` означает «не добавлять маркеры» (legacy + явное «не
  выбрано»). НЕ дефолтим на female.

| Эндпоинт | Статус интеграции с normalizer | Комментарий |
|---|---|---|
| `/api/music/generate` | ✅ wired | основная точка |
| `/api/music/regenerate/:id` | ✅ wired | наследует voiceType от oldGen |
| `/api/music/style-cover` | ✅ wired | наследует от source |
| `/api/music/extend` | ✅ wired (commit 2026-05-07) | наследует от source |
| `/api/admin/v304/generate-anthem` | ✅ wired | duet-by-default для гимна |
| `/api/gen/cover` (audio upload) | ⏳ TODO Sprint 3.2 | обязательно через normalizer |
| `/api/gen/extend` (audio upload) | ⏳ TODO Sprint 3.3 | обязательно через normalizer |

UI-точки переноса voiceType:
- Dashboard «🔄 Повторить» → window.__voiceTypeTransfer + sessionStorage → music.tsx инициализирует state.
- Templates → / music — voiceType из шаблона передаётся через те же transfer-globals.
- /audio cover/extend — после upload используем `vocalGender` slider/dropdown → нормализатор.

---

## §1. Архитектурный обзор

Sprint 3 plugin `extend-cover` (`apps/neurohub/server/plugins/extend-cover/module.ts`) — skeleton, поля принимает, события эмитит, реальный Suno-call не вшит. Все 4 режима ниже — это его доделка + новый client-side upload.

```
                      ┌───────── client (browser) ───────────┐
                      │  /audio/upload  /audio/cover         │
                      │  ↑ MediaRecorder | <input file>       │
                      └─────────┬────────────────────────────┘
                                │ multipart/form-data
                                ▼
┌──── server: plugin extend-cover (productionalized) ────┐
│ POST /api/gen/upload          → /var/www/neurohub/uploads/<sha>.mp3 → public URL
│ POST /api/gen/cover {uploadUrl|sourceGenId, style, vocalGender}
│ POST /api/gen/extend {sourceGenId|uploadUrl, continueAtSec}
│ POST /api/gen/voice-clone     (Sprint 4 — через persona plugin)
└─────────┬───────────────────────────────────────────────┘
          │ POST gptunnel.ru/v1/media/create  (model="suno-cover" | "suno", uploadUrl=..)
          ▼
   GPTunnel proxy → Suno V4_5+ → audio_url + lyrics
```

---

## §2. Suno API surface (через GPTunnel)

Источники: [sunoapi.org docs](https://docs.sunoapi.org/suno-api/upload-and-cover-audio), [kie.ai docs](https://docs.kie.ai/suno-api/upload-and-cover-audio), [gptunnel media-api](https://docs.gptunnel.ru/media-api/suno).

### §2.1 Upload-cover (новое аудио → кавер в новом стиле)

`POST https://gptunnel.ru/v1/media/create` (через наш `gptunnelFetch` в `routes.ts:320`)

Headers: `Authorization: <GPTUNNEL_API_KEY>` (без `Bearer`), `Content-Type: application/json`

```json
{
  "model": "suno-cover",
  "mode": "custom",
  "uploadUrl": "https://clone.muziai.ru/uploads/abc123.mp3",
  "customMode": true,
  "instrumental": false,
  "prompt": "Soft acoustic remake",
  "style": "acoustic, fingerpicking, intimate",
  "title": "Кавер",
  "vocalGender": "f",
  "styleWeight": 0.65,
  "weirdnessConstraint": 0.4,
  "audioWeight": 0.7,
  "negativeTags": "heavy metal, screaming"
}
```

| Поле | Тип | Обяз. | Лимит/Заметки |
|---|---|---|---|
| `uploadUrl` | string | да* | публичный URL mp3/wav/m4a; `≤ 8 минут` длительности; `≤ 20 MB` |
| `customMode` | bool | да | `true` если есть `style`+`title`; `false` для basic-mode |
| `instrumental` | bool | нет | `true` = без вокала |
| `prompt` | string | да* | `≤ 400` chars в basic; `≤ 3000` в custom |
| `style` | string | если `customMode=true` | `≤ 200` chars; жанр+теги |
| `title` | string | если `customMode=true` | `≤ 80` chars |
| `vocalGender` | "m"\|"f" | нет | если не задан — Suno выбирает |
| `styleWeight` | 0..1 | нет | насколько следовать `style` (default 0.65) |
| `weirdnessConstraint` | 0..1 | нет | креативность; > 0.7 = эксперимент |
| `audioWeight` | 0..1 | нет | насколько копировать мелодию из `uploadUrl` (default 0.7) |
| `negativeTags` | string | нет | что НЕ должно быть в выводе |
| `personaId` | string | нет | если есть Persona (Sprint 3.5) — закрепляет «голос автора» |

*\*`uploadUrl` ИЛИ `sourceGenId` (через `task_id` нашей предыдущей генерации). Не оба.*

### §2.2 Extend (продление готового аудио)

```json
{
  "model": "suno-extend",
  "task_id": "<suno-clip-id>",       // если продлеваем нашу генерацию
  "audio_url": "https://...mp3",     // ИЛИ загруженного пользователем
  "continue_at": 90,                 // секунда, с которой генерируем хвост
  "mode": "custom",
  "prompt": "...", "style": "...", "title": "..."
}
```

Работает только если оригинал ≥ `continue_at` сек. Лимит хвоста: до `+180` сек за один extend (можно цеплять).

### §2.3 Voice clone (Sprint 4 — через Persona)

Suno на момент 2026-05 нативного voice-clone **не предоставляет** через GPTunnel; косвенный путь:
1. Автор грузит 30 сек напева → сохраняем как `personas.referenceAudioUrl`.
2. Каждая генерация автора уходит с `personaId` + `audioWeight=0.85` → Suno «склоняется» к голосу.
3. В Sprint 4 заменим на нативный voice-clone когда GPTunnel его прокинет.

---

## §3. Upload механизм (наш сервер)

Suno ХОЧЕТ публичный URL. Pre-signed URL у GPTunnel **нет** — нужна наша своя upload-точка с публичной отдачей.

### §3.1 Endpoint `POST /api/gen/upload`

Multipart/form-data, поле `audio`. Auth: Bearer (sessions). Лимиты:
- ≤ 20 MB
- ≤ 10 минут (декодим через `fluent-ffmpeg` для проверки duration)
- mime: `audio/mpeg`, `audio/wav`, `audio/m4a`, `audio/mp4`, `audio/webm`

Сохранение: `/var/www/neurohub/uploads/<userId>/<sha256>.<ext>`. SHA256 от файла = идемпотентность (повторная загрузка того же файла = тот же URL).

Возвращает:
```json
{ "data": { "uploadUrl": "https://clone.muziai.ru/uploads/42/a1b2c3.mp3",
            "duration": 142, "size": 4321567, "sha": "a1b2c3..." },
  "error": null }
```

### §3.2 Раздача файлов

`app.use("/uploads", express.static("/var/www/neurohub/uploads", { maxAge: "30d" }))` + nginx `expires 30d` + `Cache-Control: public`.

### §3.3 Очистка

Cron `every_day` чистит `uploads/<userId>/*` старше **30 дней** если файл не используется (нет `generations.audioInputUrl` ссылающегося на него).

---

## §4. Изменения в БД

### §4.1 ALTER `generations` (additive, idempotent)

```sql
ALTER TABLE generations ADD COLUMN audio_input_url TEXT;          -- загруженный mp3 пользователя
ALTER TABLE generations ADD COLUMN audio_input_sha TEXT;          -- для дедупа
ALTER TABLE generations ADD COLUMN audio_weight REAL;             -- 0..1, насколько копировать
ALTER TABLE generations ADD COLUMN style_weight REAL;             -- 0..1
ALTER TABLE generations ADD COLUMN weirdness_constraint REAL;     -- 0..1
ALTER TABLE generations ADD COLUMN negative_tags TEXT;
ALTER TABLE generations ADD COLUMN extend_continue_at INTEGER;    -- сек
```

### §4.2 Новая таблица `audio_uploads`

```sql
CREATE TABLE audio_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  sha TEXT NOT NULL UNIQUE,
  filename_original TEXT,
  ext TEXT,
  size_bytes INTEGER,
  duration_sec REAL,
  mime TEXT,
  storage_path TEXT NOT NULL,
  public_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT
);
CREATE INDEX idx_audio_uploads_user ON audio_uploads(user_id);
```

`storage.ts` auto-migration берёт это на себя (PRAGMA-based pattern).

---

## §5. UI / UX

### §5.1 Страница `/audio` (новая)

Три таба:

| Таб | Действие | Stack |
|---|---|---|
| 📁 Загрузить файл | drag-and-drop или `<input type="file" accept="audio/*">` | стандартный |
| 🎤 Записать с микрофона | MediaRecorder API (webm) → конвертация в mp3 на сервере через ffmpeg | `MediaRecorder`, `MediaStream` |
| 🔗 Из ссылки | URL → server-side download → проверка mime/размера → upload | стандартный fetch |

После успешного upload — **на той же странице** появляется блок «Что сделать с этим аудио?»:

1. **🎨 Сделать кавер** → `/music?cover=<sha>` — обычная страница music с pre-filled `audioInputUrl`
2. **➕ Продлить** (если type=music) → `/music?extend=<sha>&continueAt=...`
3. **🎵 Использовать как голос** (Sprint 4) — кнопка серая «Скоро»

### §5.2 Расширение `/music`

В существующую страницу `/music` добавляются:
- Toggle «Использовать аудио как референс» — если включён, появляется блок с loaded `audioInputUrl` (preview audio + slider `audioWeight 0..1`).
- Toggle «Это продление трека» — slider `continueAt` (сек), показывается только если у `sourceGen.duration > 30`.

### §5.3 Навбар

Добавить пункт «🎵 Аудио» рядом с «Шаблоны».

---

## §6. Безопасность

| Угроза | Митигация |
|---|---|
| Загрузка вредоносных файлов | mime-sniffing через `file-type` пакет (а не trust client `Content-Type`); whitelist аудио-mime; max 20 MB |
| DDoS upload-эндпоинта | rate-limit через существующий `security-guard` plugin: ≤ 10 upload/час на user |
| Авторские права (юзер грузит чужую песню) | Disclaimer на upload-странице + лог `audio_uploads.filename_original` для последующего DMCA-разбора. Длинные треки (> 5 мин) — авто-блок с предложением «попробуй короткий фрагмент». |
| Storage-bomb | Квота: 500 MB на user; превысил — старые файлы (без `last_used_at` за 30 дней) удаляются first-in-first-out |
| Ссылка на чужой `audioInputUrl` | На сервере проверка `audio_uploads.user_id == req.userId` ИЛИ `is_public=1`; иначе 403 |

---

## §7. Pricing (предложение)

| Операция | Цена в кредитах | Комментарий |
|---|---|---|
| Upload (без генерации) | 0 | Бесплатно — это просто файл |
| Cover из upload | **+50 ₽ к music**: 349 ₽ | премия за audio_weight (Suno дороже считает) |
| Extend | **199 ₽** | дешевле music, т.к. короче |
| Voice clone (Sprint 4) | TBD | зависит от GPTunnel pricing |

---

## §8. Sprint plan

| Sprint | Что | ETA |
|---|---|---|
| 3.1 (этот) | Upload endpoint + storage + audio_uploads table + nginx static | 1.5 дня |
| 3.2 | Cover flow: extend-cover plugin → real Suno-call + UI cover toggle на /music | 1 день |
| 3.3 | Extend flow: continue_at + UI на /music | 0.5 дня |
| 3.4 | /audio страница (3 таба: file, mic, URL) + MediaRecorder integration | 1 день |
| 3.5 | Persona binding к audioInputUrl (referenceAudio) | 0.5 дня |
| 4.x | Voice clone когда GPTunnel прокинет API | TBD |

**Итого: ~4.5 дня** на полную production-готовность audio-input.

---

## §9. Smoke-test чеклист (после Sprint 3.4)

```bash
# 1. Upload mp3 файла 3 МБ → ожидаем publicUrl
curl -X POST -F "audio=@test.mp3" -H "Authorization: Bearer $TOKEN" \
  https://clone.muziai.ru/api/gen/upload

# 2. Cover из uploaded audio
curl -X POST -d '{"uploadUrl":"...","style":"jazz","title":"test","vocalGender":"m"}' \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  https://clone.muziai.ru/api/gen/cover

# 3. Polling: серверный poller (admin-overview every_minute) подхватит → status=done
# 4. UI: открыть /track/<id> — должен показать аудио с lockscreen + lyrics

# 5. Идемпотентность: upload того же файла повторно → тот же sha → тот же uploadUrl
# 6. Cleanup: создать gen с audioInputUrl, удалить gen → cron должен зачистить файл через 30 дней
```

---

## §10. Открытые вопросы (требуют решения Евгения цифрой)

1. **Storage:** локально на VPS (`/var/www/neurohub/uploads/`, 500 GB SSD) — или сразу S3-совместимое (Yandex Object Storage, Selectel)? Локально — проще, дешевле; S3 — масштабируемо, безопаснее.
2. **Лимит длительности upload:** 8 мин (Suno hard-limit) или 5 мин (наш soft-limit чтобы дешевле)?
3. **Запись с микрофона:** включаем в Sprint 3.4 или отдельным Sprint 3.6 (требует доп. UX-итераций под мобилки)?
4. **DMCA workflow:** автоматический ML-fingerprint (acoustid/chromaprint) или только manual takedown по жалобе?
5. **Кто платит за фейлы Suno** при cover (Suno вернул error из-за «sensitive content», но мы уже посчитали upload-кредит)? Текущая логика возвращает балу — оставляем или меняем?

---

*Updated: 2026-05-07. См. также [02-МУЗЫКАЛЬНЫЙ-ДВИЖОК-Suno-на-100.md](original/02-МУЗЫКАЛЬНЫЙ-ДВИЖОК-Suno-на-100.md), `apps/neurohub/server/plugins/extend-cover/module.ts`, [PITFALLS.md](PITFALLS.md).*
