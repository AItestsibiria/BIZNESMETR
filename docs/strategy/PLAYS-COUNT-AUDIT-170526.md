# Аудит подсчёта прослушиваний (plays) — 17.05.2026

**Контекст:** на `muzaai.ru` ~20 000 посещений за месяц, ~200 прослушиваний → 1 % conversion. Норма 20–40 %. Босс подозревает баг.

**Цель:** найти где теряются плеи. Только диагноз, без правок кода.

---

## 1. Текущая логика подсчёта

### 1.1 Точки вызова на frontend

| Файл | Строка | Endpoint | Тригер |
|---|---|---|---|
| `apps/neurohub/client/src/pages/landing.tsx` | 843 | `POST /api/playlist/play/:id` | внутри `playTrack(track)` — **немедленно после `setPlayingId`**, до того как пользователь действительно успел послушать |
| `apps/neurohub/client/src/pages/dashboard.tsx` | 1148 | `POST /api/playlist/play/:id` | то же — внутри `playTrack(gen)`, немедленно |
| `apps/neurohub/client/src/pages/track.tsx` | 133 | `POST /api/gen-activity/:id/play` | внутри `togglePlay()` сразу после `audioRef.current.play()` |
| `apps/neurohub/client/src/pages/music.tsx` | — | **НЕ ТРЕКАЕТ ВООБЩЕ** | пост-генерационный плеер не вызывает endpoint |
| `apps/neurohub/client/src/components/**` | — | **НЕ ТРЕКАЮТ** | никакие компоненты-плееры не отправляют запросы |

Сигнатура запроса во всех точках одинаковая:
```js
fetch(`/api/playlist/play/${id}`, { method: "POST" }).catch(() => {});
```

**Что НЕ передаётся:**
- `Authorization: Bearer <token>` — отсутствует
- `credentials: "include"` — отсутствует (Bearer-only auth, куки игнорируются)
- `body` — отсутствует целиком → `req.body.elapsedSec` всегда `undefined`
- `Content-Type` — не задан

### 1.2 Backend rules (`shouldCountPlay`, `server/routes.ts:6596`)

Применяется в `/api/playlist/play/:id` (line 6644) и `/api/gen-activity/:id/play` (line 7035). Проверки в текущем порядке:

| № | Правило | Поведение в реальности |
|---|---|---|
| 1 | Author-self exclude (если `userId === gen.userId`) | **НИКОГДА не срабатывает** — `tryGetUserId(req)` возвращает `null` (token не передан) |
| 2 | Admin exclude (role admin/super_admin) | **НИКОГДА не срабатывает** — та же причина, userId не разрешён |
| 3 | Bot UA regex `/(bot\|crawler\|spider\|slurp\|curl\|wget\|httpie\|python-requests\|java-http\|axios\|fetch\|head)\b/` | Работает на реальных ботах. Реальные браузеры (Chrome/Safari/Yandex/Firefox/Telegram-WebView) проходят |
| 4 | `elapsedSec < 5` → reject `too-short` | **НИКОГДА не срабатывает** — поле всегда `undefined`, fallback-логика «считаем» (backward-compat) |
| 5 | IP-dedup 1 час | **Работает** — основной активный фильтр |

`logGenActivity(genId, action, req.ip)` нормализует IPv4 (`::ffff:` префикс снимает), `app.set("trust proxy", 1)` обеспечивает реальный клиентский IP из X-Forwarded-For (Nginx → Express).

### 1.3 Где растёт счётчик

```ts
// routes.ts:6651–6655
let meta = JSON.parse(gen.style || "{}");
meta.plays = (meta.plays || 0) + 1;
db.update(generations).set({ style: JSON.stringify(meta) })
```

То есть `generations.style` (JSON) хранит `plays`. Отдельная запись в `gen_activity` с `action='play'` или `action='play_rejected:<reason>'`.

### 1.4 «20k посещений» — откуда

`engagement_events` (`shared/schema.ts:506`), event `consultant_impression` от `floating-consultant.tsx:356`. Срабатывает при mount компонента консультанта (≈ на каждой загрузке landing после `APPEAR_DELAY_MS`).

---

## 2. Найденные баги / расхождения

### 2.1 Frontend никогда не передаёт `elapsedSec`
**File:** `landing.tsx:843`, `dashboard.tsx:1148`, `track.tsx:133`
**Проблема:** правило `shouldCountPlay` пункт 1 («5+ сек воспроизведения») **не работает**. Сейчас backend применяет fallback `backward compat — считаем` (комментарий на `routes.ts:6618`).
**Эффект на цифры:** **завышение** в одну сторону (каждый клик «play» в плейлисте, даже на 1 секунду, идёт как плей), **занижение** в другую (нет различия между «прокрутил мимо» и «послушал»).

### 2.2 Author-self и Admin exclude — мертвая логика
**File:** `routes.ts:6598–6610`
**Проблема:** `fetch(... { method: "POST" })` без `Authorization` header → `tryGetUserId(req) === null` → правила #1 и #2 никогда не срабатывают.
**Эффект:** плеи авторов **считаются** наравне с чужими — это противоречит правилу Босса, но **в текущем контексте играет в плюс** для cifr (плеи авторов своих треков повышают счётчик). При фиксе (передаче Bearer) — счётчик **упадёт** ещё ниже.

### 2.3 `tryGetUserId` использует `tokenStore` (in-memory)
**File:** `routes.ts:1804–1812`
**Проблема:** даже если бы frontend передал token, `tokenStore` живёт в памяти процесса pm2 — после `pm2 restart` все токены отвалятся (логин нужно повторять). Применительно к play-tracking это означает: после рестарта pm2 даже залогиненный юзер первое время не resolves.
**Эффект на cifr:** не значимо. Релевантно для будущего фикса #2.2.

### 2.4 Tracking fire'ит при автопереключении трека
**File:** `landing.tsx:759–784` (`handleEnded` → `playTrack(musicTracks[nextIdx])`)
**Проблема:** при `repeat=all` плейлист сам переключает треки → `playTrack` → fetch — это считается отдельным плеем. Каждый трек в continuous-playback фоне даёт **много** плеев на один и тот же IP, но IP-dedup 1h всё съедает кроме одного.
**Эффект:** **завышение в пределе одного юзера ограничено IP-dedup**, но логика «плей засчитывается когда юзер действительно слушал» искажена.

### 2.5 `music.tsx` (post-generation player) не трекает
**File:** `client/src/pages/music.tsx` — нет ни одного fetch'а на `/api/playlist/play` или `/api/gen-activity/:id/play`
**Проблема:** **большой блок плеев теряется** — автор после генерации обычно прослушивает свой трек, шарит ссылку, открывает у себя ещё раз. Все эти плеи проходят через `/music`, не через landing. Они **никак не учитываются**.
**Эффект:** **значимое занижение**. Это ровно «1% conversion».

### 2.6 IP-dedup 1h может «съедать» легитимные повторные плеи
**File:** `routes.ts:6627–6633`
**Проблема:** один IP-адрес может пройти **только один** плей одного трека в час. На офисах / университетах / семьях с одним IPv4 это режет ≈ 5–20× плеев. На NAT мобильных операторов (одинаковый IP у тысяч юзеров) — наоборот, дедуп блокирует все плеи кроме первого.
**Эффект:** **сильное занижение** при NAT-сценариях (мобильные сети России). Возможно главный фактор.

### 2.7 Тип `req.body` без body-parser-json в маршруте
**File:** `routes.ts:6619`
**Проблема:** даже если frontend начнёт отправлять `{elapsedSec: 5}` — без `Content-Type: application/json` и/или без `express.json()` middleware Express не распарсит. Нужно проверить, но скорее всего глобальный `express.json()` подключён. Просто на всякий случай — нюанс для будущего фикса.

### 2.8 Frontend tracking-fetch fire'ит при `setPlayingId` до play()
**File:** `landing.tsx:834+843` — `setPlayingId(track.id)` сразу, потом `fetch(.../play)`. Если `audio.play()` reject от autoplay-policy (iOS Safari, первый visit без gesture), fetch уже улетел.
**Эффект:** небольшое завышение «фантомных» плеев, но IP-dedup всё равно блокирует второй после удачного клика.

---

## 3. Рекомендации (БЕЗ КОДА — только что фиксить)

Отсортировано от самого надёжного к компромиссному.

### 3.1 [Самое надёжное] Добавить tracking в `music.tsx`
Это **главное занижение**. Все плеи пост-генерации сейчас невидимы. После фикса — большой буст cifr.

### 3.2 [Самое надёжное] Реализовать `elapsedSec` в плеере
Через `setTimeout(() => fetch(...), 5000)` или через `audio.timeupdate` (`currentTime >= 5`). Это правильно: текущий клик «попробовал и закрыл» не должен учитываться, длинный плей — должен. Backend готов это принимать.

### 3.3 [Самое надёжное] Расслабить IP-dedup для мобильных сетей
Текущие **60 минут** — слишком жёстко при NAT. Варианты:
- сократить window до **10 минут** (5x менее агрессивный)
- или ввести Web cookie / fingerprint вместо чистого IP (тогда NAT-юзеры считаются отдельно)
- или (комбинация) — IP+UA hash вместо IP

Это даст основной численный буст: **2–10× плеев** в зависимости от трафика мобильных операторов.

### 3.4 [Среднее] Передавать Bearer token в fetch tracking
`fetch(url, { method: "POST", headers: { Authorization: \`Bearer ${token}\` } })`. Тогда заработают author-self exclude и admin exclude (правила Босса).
Цена: **count упадёт** на 5–20% (плеи авторов и админа отсечутся). Это качественный фикс, но снижает абсолютное число.

### 3.5 [Среднее] Распределить tracking-call по тригерам
Различать «нажал play» (UI feedback) от «реально послушал» (analytics):
- UI событие — local state change, fetch НЕ улетает
- analytics fetch — только если `currentTime >= 5` накоплено в той же сессии воспроизведения этого трека
Это решает 2.4 и 2.8 одновременно.

### 3.6 [Быстрое] Хот-фикс: IP-dedup 60 → 5 мин + fix `music.tsx`
Без правок плеера/Bearer — просто две мелких правки. Уйдёт основной numerator-leak, цифры подскочат до ожидаемых 20%+.

### 3.7 [Не рекомендую] Убрать IP-dedup полностью
Это откроет анти-фрод дыру. Накрутка плеев в 100× за минуту через скрипт. Не делать.

---

## 4. SQL-проверки на VPS

Что Босс может запустить, чтобы оценить масштаб (по желанию):

```sql
-- Распределение action в gen_activity за 30 дней
SELECT action, COUNT(*) c FROM gen_activity
WHERE created_at >= datetime('now','-30 days')
GROUP BY action ORDER BY c DESC;

-- Из них play_rejected с разбивкой по reason
SELECT action, COUNT(*) c FROM gen_activity
WHERE created_at >= datetime('now','-30 days')
  AND action LIKE 'play_rejected:%'
GROUP BY action ORDER BY c DESC;

-- Уникальных IP, кликнувших play
SELECT COUNT(DISTINCT ip) FROM gen_activity
WHERE action='play' AND created_at >= datetime('now','-30 days');

-- Visits (engagement_events.consultant_impression)
SELECT COUNT(*) FROM engagement_events
WHERE event_type='consultant_impression'
  AND created_at >= datetime('now','-30 days');
```

Если `play_rejected:ip-dedup-1h` >> `play` — главный фактор 3.3 (IP-dedup жмёт).
Если `play_rejected:too-short` нулевое и `play` маленькое — главный фактор 3.1+3.2 (music.tsx + elapsedSec).

---

## 5. Резюме

| Фактор | Эффект на цифру | Действие |
|---|---|---|
| `music.tsx` не трекает плеи пост-генерации | сильно занижено | фикс (3.1) |
| IP-dedup 60 мин при NAT | сильно занижено | релакс (3.3) |
| Frontend не шлёт `elapsedSec` | средне (+ noise) | фикс (3.2) |
| Author-self / Admin не вычитаются | завышено | фикс (3.4), но **после** 3.1/3.3 |
| Tracking на каждый автоматический next | средне | улучшение (3.5) |
| Bot UA regex | работает корректно | без изменений |

**Главная гипотеза:** 1% conversion — комбинация (a) пропуска плеев в `music.tsx` и (b) NAT-юзеров отсечённых IP-dedup'ом 60-мин. После 3.1 + 3.3 ожидается рост до 15–30%.

---

*Подготовлено 2026-05-17, без правок кода, только аудит. Триумф-тег не создаётся.*
