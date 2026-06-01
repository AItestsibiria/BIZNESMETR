# PLAYS-COUNT AUDIT — 2026-05-09

**Контекст:** Eugene попросил глубокую ревизию подсчёта прослушиваний. Документ описывает текущее устройство, риски, и предложения по укреплению. Read-only — никаких правок кода в этом коммите.

---

## TL;DR

- Прослушивания считаются на **клик по кнопке Play**, а не на реальное прослушивание. Даже не на `audio.canplay` — на момент `onClick`.
- **Дедупа нет ни по userId, ни по IP, ни по времени.** 5 кликов подряд = +5 plays.
- **Auth не требуется** — endpoint открыт для любого анонима, gen IDs угадываются последовательно.
- Логи `gen_activity` хранят только `ip` без `userId` — невозможно понять кто из юзеров что слушал.
- Race condition: `meta.plays` хранится в JSON-поле `style`, инкремент = read-modify-write без транзакции.
- `/api/stream/:id` (где реально течёт аудио) **не инкрементит plays вообще** — только клик-эндпоинты.

Вывод: число «прослушиваний» в дашборде/лендинге сейчас **корректно называть «кликами Play»**, не реальными прослушиваниями. Любой бот или один обновляющий вкладку юзер ломает метрику.

---

## 1. Storage / схема

| Где | Структура | Файл |
|---|---|---|
| Event-log | `gen_activity` table — `genId`, `action ∈ {download,copy,play,share}`, `ip`, `city/region/country/countryCode`, `createdAt`. **Нет `userId`.** | `apps/neurohub/shared/schema.ts:101-112` |
| Cumulative | `generations.style` JSON, поля `meta.plays` и `meta.lastPlayed` (денормализация). | `apps/neurohub/shared/schema.ts:44` |

Двойное хранение работает, но event-log без `userId` ограничен — IP меняется (мобильный 4G ↔ Wi-Fi ↔ VPN), один юзер на одной вкладке выглядит как несколько IP.

---

## 2. Где инкрементится (server-side)

### A. `POST /api/playlist/play/:id` — основной путь
- Файл: `apps/neurohub/server/routes.ts:3557-3572`
- Логика:
  ```ts
  logGenActivity(genId, 'play', req.ip);              // event log
  meta.plays = (meta.plays || 0) + 1;                 // cumulative
  ```
- **Auth: нет** (нет `authMiddleware`)
- **Dedup: нет**
- **Rate limit: нет**

### B. `POST /api/gen-activity/:id/:action` — generic activity logger
- Файл: `apps/neurohub/server/routes.ts:3894-3920`
- Поведение идентичное A для `action='play'`
- Тоже без auth / dedup / rate limit

### C. `logGenActivity()` helper
- Файл: `apps/neurohub/server/routes.ts:524-541`
- Чистит `::ffff:` префикс с IPv4-mapped-IPv6, асинхронно резолвит geo через `resolveIpGeo()`. Если geo-резолвер падает — поля `city/region/country/countryCode` остаются NULL.

### D. `/api/stream/:id` — стриминг аудио
- Файл: `apps/neurohub/server/routes.ts:2469-2525`
- **Не инкрементит plays.** Прослушивание ≠ play count.

---

## 3. Где читается / отображается

| Локация | Что показывает | Файл |
|---|---|---|
| Server: `/api/playlist?sort=plays` | Сортирует список по `meta.plays` desc | `apps/neurohub/server/routes.ts:3611-3613, 3677` |
| Server: `/api/admin/gen-stats` | Топ-10 по `gen_activity.action='play'` за день/неделю/месяц | `apps/neurohub/server/routes.ts:3923-3946` (защищён hard-coded email `egnovoselov@gmail.com` в строке 3925 — отдельный smell) |
| Client: landing page | `▶{plays}` + green/red chevron (≥5 / <5) | `apps/neurohub/client/src/pages/landing.tsx:1228-1235` |
| Client: dashboard | `▶{plays}` в Activity-табе, опциональная сортировка | `apps/neurohub/client/src/pages/dashboard.tsx:76, 83, 1609` |

---

## 4. Анти-фрод / дедуп — статус

| Защита | Статус |
|---|---|
| Per-user dedup window | ❌ нет (даже userId в event-log нет) |
| Per-IP rate limit / cooldown | ❌ нет |
| Min listen duration | ❌ нет |
| Auth на /play endpoint | ❌ нет |
| Bot detection / CAPTCHA | ❌ нет |
| Атомарность инкремента | ❌ нет (read-modify-write JSON) |
| Привязка к stream-completion | ❌ нет (click ≠ listen) |

**Attack surface:**
1. Anon юзер → `for i in $(seq 1 1000); do curl -X POST /api/playlist/play/123; done` → +1000 plays на трек, IP один и тот же, все 1000 строк лежат в `gen_activity`.
2. С нескольких IP (Tor / прокси-пул) → +1000 plays и распределены гео — не отличить от органики.
3. Один юзер обновляет страницу 50 раз → +50 plays (если кнопка Play триггерится автоплеем).
4. Race: два запроса одновременно читают `meta.plays = 10`, оба пишут `11` → потеря инкремента.

---

## 5. Audio pipeline → счётчик

```
Юзер кликает Play
      ↓
Client: onClick → fetch POST /api/playlist/play/:id  ← ИНКРЕМЕНТ ЗДЕСЬ
      ↓
Client: <audio src="/api/stream/:id"> начинает грузиться
      ↓
Server: GET /api/stream/:id → отдаёт mp3 (БЕЗ инкремента)
      ↓
Юзер слушает 0.5 сек / 30 сек / весь трек — для счётчика всё равно
```

Корректнее назвать текущую метрику «PlayClicks», а не «Plays».

---

## Suspected issues (приоритизированно)

| # | Проблема | Серьёзность | Эффект |
|---|---|---|---|
| 1 | Click ≠ listen | 🔴 критично | Метрика не отражает реальное потребление; рейтинги ложные |
| 2 | Нет dedup ни по чему | 🔴 критично | Один юзер = +N через рефреш / автоплей |
| 3 | Нет auth | 🔴 критично | Любой бот за 1 минуту накручивает любой трек |
| 4 | Нет userId в event-log | 🟠 высокая | Невозможен per-user аудит, retention-аналитика, рекомендации |
| 5 | Race condition на JSON | 🟠 высокая | Потеря инкрементов под нагрузкой; не критично пока трафик низкий |
| 6 | Hardcoded admin email в `/admin/gen-stats` | 🟠 высокая | Если Eugene потеряет gmail → потеря admin-доступа на этом эндпоинте; smell для security |
| 7 | Geo async, не блокирует | 🟢 низкая | Ряд строк gen_activity без geo — мешает аналитике, не безопасности |

---

## What's already good

✅ Двухслойное хранение (event-log + counter) — есть и быстрый счётчик, и raw-данные для пересчёта если что.  
✅ IP сохраняется (с очисткой `::ffff:` префикса) — основа для будущей дедупликации/гео.  
✅ Geo-резолвер async — не задерживает ответ.  
✅ Топ-10 admin-эндпоинт уже есть — есть с чего считать историю.  
✅ Soft-delete уважается — удалённые треки не пушат свои plays.

---

## Предложения (в порядке от самого надёжного)

### 1. [Самое надёжное] Перейти на listen-events + per-user dedup window
- Клиент шлёт `POST /api/playlist/listen/:id` **на 50% прослушивания** (через `<audio>.ontimeupdate` когда `currentTime / duration ≥ 0.5`), не на onClick.
- Server проверяет: «был ли уже play от этого `userId` (или IP при анониме) для этого `genId` за последние 30 минут?» — если да, не инкрементит.
- Добавить колонку `user_id INTEGER` в `gen_activity` (миграция additive).
- Добавить колонку `duration_listened_ms INTEGER`.
- Перевести `meta.plays` в **производное** значение от `gen_activity` (агрегат через triggered count или периодический job), убрать race condition полностью.
- Срок: ~6-8 часов на код + миграция + клиент-сайд hook.

### 2. [Среднее] Dedup без переезда на listen-events
- Оставить click-trigger, но в `/api/playlist/play/:id` проверять «есть ли запись `gen_activity` с тем же `(genId, ip)` за последние 5 минут» — если есть, скипаем инкремент.
- Атомарный update через SQL `UPDATE generations SET style = json_set(style, '$.meta.plays', json_extract(style, '$.meta.plays') + 1) WHERE id = ?` — закроет race.
- Срок: ~1-2 часа.

### 3. [Быстрое] Только rate limit
- Express middleware `express-rate-limit` на оба endpoint'а (A и B): 1 запрос в минуту с одного IP на один genId.
- Срок: 30 минут.
- Минус: один юзер с автоплеем проходит через rate limit; накрутчик с прокси-пулом тоже.

### 4. [Не рекомендую] Не делать ничего
- Текущая метрика устраивает, лендинг показывает «топ» на основе кликов — это OK для marketing-картинки. Реальную retention считать никак не получается. Юзеры могут видеть «свои треки в топ-10» когда сами накрутили.

---

## Verification план (если возьмём вариант 1 или 2)

1. `npm run db:test:reset && npm run test` — миграция применилась чисто.
2. Локально: 5 кликов Play подряд на одном треке → +1 play (dedup сработал).
3. Локально: 10 минут спустя ещё клик → +1 play (окно истекло).
4. На clone: запустить накрутку `for i in {1..50}; do curl ...; done` → +1 play (или 0 без auth, если перешли на required-auth).
5. На clone: открыть `/admin/gen-stats` → топ-10 совпадает с reality.
6. После 24 часов на clone: сверить `gen_activity` count vs `meta.plays` — должны быть равны (если perf job работает) или меньше (если меняли логику mid-flight).

---

## Что НЕ удаляем (по «без удаления»)

- ❌ `meta.plays` в `style.JSON` — даже после миграции на `gen_activity`-агрегат, остаётся как cache.
- ❌ Существующие строки в `gen_activity` — их `userId` остаётся NULL для исторических записей, фронт показывает их как «pre-2026-05-XX legacy».
- ❌ Старые endpoint'ы `/api/playlist/play/:id` и `/api/gen-activity/:id/:action` — не ломаем, добавляем dedup внутри.

---

## Решения, требующие Eugene

1. **Какой из 4 вариантов брать?** (1 — proper, 2 — компромисс, 3 — patch, 4 — оставить).
2. **Auth на play endpoint:** жёсткий required (зарегистрированные юзеры) ИЛИ опциональный (anon допускается, но dedup только по IP)?
3. **Min listen %:** 50% / 30 секунд / иное? Для коротких треков (1 мин) 50% строже чем для длинных (4 мин). Лучше дуальный критерий «50% ИЛИ 30 секунд (что меньше)».
4. **Hardcoded email** в `/admin/gen-stats` (line 3925) — заменить на `requireAdmin` middleware? (Точно да, но это отдельная security PRIO 0 правка вне scope plays-аудита.)

---

*Audit сделан Claude через Explore-агента, файлы цитируются по состоянию на commit `8c6b315` (Auto-resume rule). Реализация — отдельным коммитом после approval.*
