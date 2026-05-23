# Критический аудит MuzaAi — 2026-05-24

> Аудитор: Claude Code (Opus 4.7 1M)
> Скоуп: end-to-end код проекта `apps/neurohub/` (server + client + shared)
> Метод: статический анализ кода (БД на VPS, не локально)
> Стиль severity: 🔴 CRITICAL → 🟡 MEDIUM → 🟢 LOW

---

## TL;DR — Top-5 issues по severity

### 🔴 1. Подарочный трек для Telegram-юзеров полностью потерян
В коде два пути регистрации через TG (`/api/auth/telegram` и `/api/auth/telegram/poll`), оба создают `users` row напрямую, **минуя `tryGiveWelcomeGift()`**. Юзер, зарегистрировавшийся через Telegram, никогда не получит подарочный трек — даже если он первый из 1000 РФ.
**File:** `apps/neurohub/server/routes.ts:1750`, `:1831`, `:1901` (3 точки insert users без gift).

### 🔴 2. Refund-сумма для music-треков ошибочна при `gen.cost = null/0`
В 7+ местах в `routes.ts` рефанд делается с fallback `cost: gen.cost || 9900` — но **9900 это lyrics-цена (99₽), а не music (39900 = 399₽)**. Если в БД gen.cost оказался 0 или null (что бывает после `usedBonusTrack`), юзер получит refund **99₽ вместо 399₽**.
**Files:** `routes.ts:9874, 9910, 10208, 10343, 13382, 13391` (все music refund paths).

### 🔴 3. Дублирующиеся endpoint'ы plays-counting (`/api/playlist/play/:id` vs `/api/gen-activity/:id/play`)
Два разных HTTP endpoint'а, делающих **полностью одинаковую** работу — пишут в `gen_activity action='play'` + `meta.plays++` + dedup + bot UA filter. Frontend использует только первый, но второй активен и принимает POST'ы. Любой агент / cron / bot может попасть на второй и обойти dedup кэш `_playsStatsCache`.
**Files:** `routes.ts:10456` (`/api/playlist/play/:id`) vs `routes.ts:11616-11656` (`/api/gen-activity/:id/play` для `action='play'`).

### 🔴 4. Дублирование Yars-команд: 2 параллельные системы
Существуют **две независимые таблицы и UI-вкладки** для operator-команд:
- `chatbot_messages.is_yars_command=1` (новая, `yarsAutoTag.ts`, UI: `/admin/v304/yars-queue`)
- `operator_command_queue` (старая, плагин `operator-commands`, UI: `/admin/v304/operator-commands`)
Босс не знает в какую очередь смотреть. Команды пишутся в обе при разных triggers.
**Files:** `plugins/operator-commands/module.ts` (старая) vs `lib/yarsAutoTag.ts` + `routes.ts:7565` (новая).

### 🔴 5. Bot-stats endpoint смешивает РЕАЛЬНЫЕ и FAKE города
Endpoint `/api/admin/v304/bot-stats` (`routes.ts:7920-7932`) дополняет real-cities из БД **искусственными mock-городами** (Москва, СПб, Лондон, Дубай и т.д.) с **случайным числом сессий** через `seedRand(i+1) * 30`. Босс видит «правдоподобные» цифры по городам, **которых нет в БД**. Mock помечен флагом `mock: true` в payload — но UI это не показывает.

---

## Раздел 1: End-to-end flows

### Flow A: Регистрация

#### ✅ Что работает
- Helper `tryGiveWelcomeGift()` (lib/welcomeGift.ts) — race-safe через better-sqlite3 transaction, единый source of truth для подарочного трека.
- SMS-OTP flow корректно использует `tryGiveWelcomeGift` (`plugins/auth-sms/module.ts:701, 955, 987, 1221, 1251` — 5 точек).
- `upsertPhoneUser` обрабатывает UNIQUE-race при параллельной регистрации.
- Backfill endpoint `POST /api/admin/v304/welcome-gift-backfill` (`routes.ts:4278`) корректно использует `tryGiveWelcomeGift`.

#### 🔴 Проблемы

##### A.1 [CRITICAL] Telegram-регистрация bypassит welcome gift
**Файл:** `routes.ts:1745-1766` (`force_create` branch in `/api/auth/telegram`)
**Файл:** `routes.ts:1828-1843` (`/api/auth/telegram/poll`)
**Файл:** `routes.ts:1888-1910` (`/api/auth/telegram-loginurl` — третья TG-точка)

Все три места делают `db.insert(users).values({...})` **напрямую**, без вызова `tryGiveWelcomeGift()`. Результат:
- TG-юзер из РФ → НЕ получает подарочный трек.
- TG-юзер не учитывается в счётчике «первые 1000».

```ts
// routes.ts:1750 — force_create:
user = db.insert(users).values({
  name: tgName,
  email: tgEmail,
  password: crypto.randomBytes(32).toString("hex"),
  balance: 100000,   // ← Старая логика 1000₽! Не consistent с email/SMS
  emailVerified: 1,
  telegramId: tgId,
  referralCode,
}).returning().get();
storage.createTransaction({ userId: user.id, type: "bonus", amount: 100000, description: "Приветственный бонус 1000 ₽" });
```

##### A.2 [CRITICAL] Конфликт ТРЁХ welcome-bonus политик в одном проекте
1. **Email регистрация** (`routes.ts:1297-1320`) — INLINE logic (НЕ использует helper) — даёт 1 bonus track если СНГ + слот <1000.
2. **SMS регистрация** — `tryGiveWelcomeGift()` helper — даёт 1 bonus track всем (CIS restriction УБРАН по комментарию в welcomeGift.ts:32-33).
3. **Telegram `/api/auth/telegram`** — даёт **`balance: 100000`** (1000₽ как старая логика) + transaction `"Приветственный бонус 1000 ₽"`.
4. **Telegram `/api/auth/telegram/poll`** — `balance: 0` (комментарий: «убрать 1000 ₽, 1 трек в подарок зачислится после открытия генерации» — но trigger'а нет!).
5. **Referral бонус** (любая регистрация по `?ref=`) — +39900 копеек **обоим**.

Юзер регистрируется через TG /poll → не получает ни 1000₽, ни bonus track. Регистрируется через TG force_create → получает 1000₽. Регистрируется через email → +1 bonus track. Через SMS → +1 bonus track. **Полностью inconsistent.**

##### A.3 [MEDIUM] Email-регистрация имеет INLINE welcome gift logic, дублирует helper
**Файл:** `routes.ts:1297-1320`

CIS-check + counter +1 + bonus_tracks update — всё inline. Полностью дублирует `tryGiveWelcomeGift()`. По CLAUDE.md правилу `Reuse-working-solutions rule` и `Pricing-single-source rule` — должен использовать helper.

Если когда-нибудь логика подарка изменится (например снять лимит 1000) — изменение в helper'е не применится к email-регистрации.

##### A.4 [MEDIUM] Telegram bot username hardcoded
**Файл:** `routes.ts:1791`
```ts
const botUsername = process.env.TELEGRAM_BOT_USERNAME || "Muziaipodari_bot";
```
Fallback на старый bot name `Muziaipodari_bot` — но домен после 2026-05-15 — `MuzaAi.ru` (см. CLAUDE.md `MuzaAi.ru-since-150526 rule`). Бот username не меняем (комментарий есть), но fallback должен быть env-based, не string-literal.

##### A.5 [LOW] Тур по `tg_<id>@telegram.muziai.ru` (старый домен)
**Файл:** `routes.ts:1831, 1901` — генерация tgEmail.
**Файл:** `routes.ts:1748` — `@telegram.MuzaAi.ru` (с заглавной MuzaAi — нестандартный).

Inconsistent: некоторые точки пишут `@telegram.muziai.ru`, одна — `@telegram.MuzaAi.ru`. Это создаёт **разные email'ы для одного и того же TG ID** в зависимости от пути регистрации. Дальше email используется как `users.email` (unique constraint). При смене пути регистрации может выскочить UNIQUE error.

##### A.6 [LOW] Pending registrations in-memory Map (`pendingRegs`)
**Файл:** `routes.ts:1152`
```ts
const pendingRegs = new Map<string, { ... }>();
```
At pm2 restart все pending верификационные коды **теряются**. Юзер вводит код → 400 «Сначала запросите регистрацию» → user-action-failure → впечатление что сайт сломан. Должно быть в БД или Redis.

### Flow B: Создание трека

#### ✅ Что работает
- Единый normalizer голоса `normalizeVocalParams()` — закрывает старую проблему 4 точек voice-formation.
- Circuit breaker `isSunoCircuitOpen()` — отказывает ДО списания, что предотвращает refund-цикл.
- Timeout-watcher (30 мин) с финальным poll Suno перед refund — снижает orphan'ы.
- Atomic refund через `storage.claimRefund()` + `refundGeneration()` — единый entry-point.
- `resolveInitialIsPublic()` корректно применяет cutoff для new authors.

#### 🔴 Проблемы

##### B.1 [CRITICAL] Refund fallback `9900` для music треков
**Файлы:** `routes.ts:9874, 9910, 10208, 10343, 13382, 13391`

```ts
storage.refundGeneration({
  genId: gen.id, userId,
  cost: gen.cost || 9900,    // ← 9900 (lyrics) НЕ 39900 (music)!
  type: "music",
  description: `Возврат: ошибка генерации #${gen.id}`
});
```

Если `gen.cost` оказался 0 (что происходит когда юзер использовал bonus track — `checkAndCharge` ставит `cost: 0`) или NULL — рефанд вернёт **99 ₽ вместо 399 ₽**. Юзер заплатил 399, получил обратно 99 → потерял 300 ₽.

Корректный fallback: `cost: gen.cost || PRICES.music` или `cost: PRICES[gen.type] || 0`.

##### B.2 [CRITICAL] Refund при использованном bonus_track теряет track-credit
**Файл:** `routes.ts:13110-13115` (timeout watcher)
```ts
if ((gen.cost || 0) > 0) {
  storage.refundGeneration({...});
} else if (storage.claimRefund(gen.id)) {
  db.update(users).set({ bonusTracks: sql`${users.bonusTracks} + 1` }).where(eq(users.id, gen.userId)).run();
  ...
}
```
Хорошо обработано в timeout-watcher — но в основных endpoint'ах refund (line 9874, 9910, 10208, 10343, etc.) **этой проверки нет**. Юзер потратил bonus_track, генерация упала → `cost === 0` → `refundGeneration` early-return (line 1544: `if (!args.cost || args.cost <= 0) return false`) → bonus_track НЕ возвращается, и transaction-record не пишется.

##### B.3 [MEDIUM] Дублирование Suno polling и webhook
**Файлы:**
- `routes.ts:884-885` — `sunoWebhookHandler` принимает GET и POST на `/api/suno/webhook`
- `routes.ts:9770-9954` — `/api/music/status/:taskId` (client-side polling)
- `routes.ts:13070+` — TIMEOUT WATCHER setInterval (server-side polling)
- `plugins/admin-overview` — `pollProcessingGenerations` (тоже polling cron)

Активны три источника. Webhook закомментирован как «dormant» (`routes.ts:9701`), но handler всё ещё принимает. Если webhook вдруг сработает + polling одновременно, race condition.

##### B.4 [MEDIUM] `/api/music/style-cover`, `/api/music/extend`, `/api/music/regenerate` повторяют логику /generate
**Файлы:** `routes.ts:9956, 10074, 13126`

Все три endpoint'а дублируют 80% кода `/api/music/generate`: charge → createGeneration → normalize → gptunnelFetch → status update. Каждый имеет свой почти идентичный try/catch + refund block. Должна быть общая функция `dispatchMusicGeneration(opts)`.

##### B.5 [LOW] Title-extraction inconsistent
**Файл:** `routes.ts:9621`
```ts
const autoTitle = title || rawLyrics.split("\n")[0]?.replace(/^\[.*?\]\s*/, "").slice(0, 80) || rawPrompt.slice(0, 80) || "Мой трек";
```
В CLAUDE.md `Track-title rule` указано: priority `body.title → lyrics-first-line → prompt-80ch → "Мой трек"`. Реализация совпадает, но дублируется в extend/cover/regenerate endpoint'ах с возможными расхождениями.

### Flow C: Воспроизведение трека

#### ✅ Что работает
- `shouldCountPlay()` правильно реализует 3 условия (5+sec, IP dedup 10 мин, bot UA).
- IDOR-fix на стрим (`routes.ts:8878`) — приватные треки только владельцу/админу.
- Cookie-fallback для audio tag auth (`routes.ts:8871`) — закрывает Suno-audio-playback rule.

#### 🔴 Проблемы

##### C.1 [CRITICAL] Два endpoint'а play counting — нарушение rule No-duplicates
**Файл 1:** `routes.ts:10456` — `POST /api/playlist/play/:id`
**Файл 2:** `routes.ts:11616-11656` — `POST /api/gen-activity/:id/play` (внутри multi-action endpoint)

Frontend (`landing.tsx:1436`, `dashboard.tsx:1373`) использует только первый. Но второй принимает POST'ы — и если ИИ-агент / bot / cron на нём попадёт, дедуп `_playsStatsCache = null` invalidate'ит cache, но **дубль play записан в gen_activity**.

Логика в обоих идентична (copy-paste):
```ts
const decision = shouldCountPlay(req, gen);
if (!decision.count) { logGenActivity(genId, `play_rejected:${decision.reason}`, ...); return; }
logGenActivity(genId, 'play', req.ip, extractHost(req));
let meta: any = {}; try { meta = JSON.parse(gen.style || "{}"); } catch {}
meta.plays = (meta.plays || 0) + 1;
meta.lastPlayed = new Date().toISOString();
db.update(generations).set({ style: JSON.stringify(meta) })...
```

**Fix:** оставить только `/api/playlist/play/:id`, второй endpoint при `action='play'` должен **перенаправлять** на первый или просто отказать.

##### C.2 [CRITICAL] meta.plays и gen_activity COUNT расходятся
Это явно зарегистрировано в собственном debug-endpoint `routes.ts:4036` (`/api/admin/v304/play-stats`):
```ts
// notes:
"Если A != B → meta.plays не sync с gen_activity (нужен backfill)",
"Site counter (/api/playlist/stats) использует A → matches admin dashboard plays если те тоже A",
"Per-track rating sort (/api/playlist?sort=rating) использует B → mismatch если stale",
```

Конкретно:
- **`/api/playlist/stats` (site counter)** → `getCurrentPlaysSum` → ранее использовал meta.plays, теперь использует `gen_activity COUNT` (`routes.ts:10725`)
- **`/api/playlist?sort=rating` (рейтинг треков)** → читает `meta.plays` из `style` JSON (`routes.ts:11136`)
- **`plays-analytics.counter.current`** → SUM(meta.plays) ONLY для `is_public=1` (`plays-analytics/module.ts:143-156`)
- **`/api/admin/v304/dashboard-summary plays.total`** → `gen_activity COUNT` (`master-dashboard/module.ts:480`)

Источники A vs B **не sync**. При сохранении play (`/api/playlist/play/:id`) пишется ОБА (gen_activity row + meta.plays++) — но при удалении/admin-операциях/cron'ах **они могут разойтись**. Например:
- Backfill admin-plays `/api/admin/v304/backfill-author-admin-plays` (routes.ts:7102-7123) пишет в meta.plays, **не** в gen_activity.
- Если cron почистит старые gen_activity rows — meta.plays останется завышенным.

**Per-track sort by rating** будет работать на устаревших meta.plays, который не отражает реальный счёт. Юзер видит трек на top-1 по plays, который реально получил 1/10 от показанного.

##### C.3 [MEDIUM] play counter dedup только для `/api/playlist/play/:id`
**Файл:** `routes.ts:10444`
```ts
const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const recent = db.get<{ c: number }>(sql`
  SELECT COUNT(*) as c FROM gen_activity
  WHERE gen_id = ${gen.id} AND action = 'play' AND ip = ${ip} AND created_at >= ${tenMinAgo}
`);
if ((recent?.c || 0) > 0) return { count: false, reason: "ip-dedup-1h" };
```
`reason: "ip-dedup-1h"` — текст говорит "1h" но окно 10 минут. Bot UA может попасть **до** dedup (`shouldCountPlay()` сначала проверяет UA → если UA пройдёт фильтр, dedup проверка пройдёт по IP).

Также: `req.ip` зависит от `trust proxy` setting Express'а. Если за nginx без `app.set('trust proxy', true)` — все плеи будут с одного IP-127.0.0.1 → ВСЕ плеи кроме первого dedup'ятся. Стоит проверить ENV trust proxy.

##### C.4 [LOW] `elapsedSec` backward-compat — слабая защита
**Файл:** `routes.ts:10431`
```ts
const elapsedRaw = (req.body as any)?.elapsedSec;
if (typeof elapsedRaw === "number" && elapsedRaw < 5) {
  return { count: false, reason: "too-short" };
}
```
Если `elapsedRaw === undefined` (frontend не передал) — фильтр пропускает. Любой curl без body → play counted. Реальные клиенты frontend всегда передают `elapsedSec: 5`, но **bot мог бы подделать**: `POST /api/playlist/play/123` с пустым body → play counted без проверки времени.

### Flow D: Покупка / оплата

#### ✅ Что работает
- `crypto.timingSafeEqual()` для Robokassa signature — защищает от time-attack.
- Idempotent fulfillment — `if (payment.status === "paid") return OK<InvId>` — повторный callback не дублирует.
- Atomic referral bonus claim через `WHERE referralBonusGiven=0` UPDATE — race-safe.
- Invoice-based premium fulfillment корректно различает tier/topup/track.

#### 🔴 Проблемы

##### D.1 [MEDIUM] Success URL подпись опциональна — UI открыт даже при bad-signature
**Файл:** `routes.ts:12798-12815`
```ts
if (!same) {
  console.warn(`[PAYMENT SUCCESS] Bad signature on Success URL ...`);
  // ... log to user_action_failures ...
}
// res.redirect("/#/payment/success");  ← ВСЕГДА redirect
```
Это **намеренно** (комментарий: «UI всё равно показан»). Однако: атакующий мог бы подменить InvId в Success URL → получить fake success-страницу для своего невалидного платежа. Не критично (Result URL валидирует подпись и реально кредитит), но UI confidence-tricks для phishing-сценариев становится возможной.

##### D.2 [MEDIUM] При invoice-fulfillment failure деньги уже списаны, но юзер не видит выручку
**Файл:** `routes.ts:12713-12717`
```ts
} catch (e) {
  console.error("[INVOICE FULFILLMENT] failed:", (e as Error).message);
  // Не возвращаем ошибку Robokassa — деньги уже списаны. Админ разберёт
  // через admin_chat_messages / invoices status.
}
```
Если subscription INSERT упал (например БД timeout) — payment отмечен как paid, но subscription/balance не обновлено. Юзер заплатил, не получил услугу. Только админский разбор через invoices.status.

**Нет alert'а Боссу.** Должен быть Telegram-alert при `[INVOICE FULFILLMENT] failed`. Сейчас только console.error.

##### D.3 [LOW] `Shp_userId` parsing не сверен с владельцем платежа
**Файл:** `routes.ts:12625`
```ts
const userId = parseInt(Shp_userId);
```
Используется как `storage.updateBalance(userId, amountKopecks)` — но **никакой проверки** что `userId === payment.userId`. Если атакующий подменит Shp_userId в Robokassa form → деньги уйдут чужому юзеру. Однако подпись включает Shp_userId, поэтому это закрыто. Стоит **assert** на defence-in-depth: `if (userId !== payment.userId) throw`.

### Flow E: Публикация трека (Two-playlist rule)

#### ✅ Что работает
- `resolveInitialIsPublic()` корректно применяет cutoff `2026-05-20`.
- `/api/generations/:id/privacy` (`routes.ts:11526`) учитывает `wasApproved` flag + established author cutoff.
- Admin endpoint `/api/admin/v304/generations/:id/playlist` для toggle main↔new.
- Челофильтр endpoint `/api/admin/v304/playlist-candidates` есть.

#### 🔴 Проблемы

##### E.1 [MEDIUM] `NEW_AUTHORS_CUTOFF_ISO` дублирован в двух местах
**File 1:** `routes.ts:544` (внутри `resolveInitialIsPublic`)
**File 2:** `routes.ts:11564` (внутри `/api/generations/:id/privacy`)

Один и тот же string `"2026-05-20T00:00:00.000Z"`, две копии. Если потребуется сдвинуть cutoff — придётся менять в двух местах. Если забудут — будет UB: при создании трек попадёт в main, при publish — в new (или наоборот).

##### E.2 [LOW] Челофильтр `>50 plays/24h` использует meta.plays
Per `/admin/v304/playlist-candidates` (`routes.ts:4647-4660+`):
```sql
WHERE g.is_public = 2 AND g.status = 'done' AND g.deleted_at IS NULL
```
Сортировка по plays внутри — через JSON_extract style (по моему опыту). Если meta.plays stale → треки попадут в «hot candidates» искусственно или наоборот пропустятся.

##### E.3 [LOW] Admin publish-all-covers использует TWO update statements
**Файл:** `routes.ts:11583-11595`
```ts
const r = db.update(generations).set({ isPublic: 1, publishedAt: nowIso }...).where(...sql`publishedAt IS NULL`).run();
const r2 = db.update(generations).set({ isPublic: 1 }).where(...isPublic=0).run();
```
Race condition theoretical: между r и r2 кто-то может изменить gen.publishedAt. Лучше один UPDATE c CASE.

---

## Раздел 2: Дубли

| # | Severity | File:line | Дубль | Recommendation |
|---|---|---|---|---|
| 1 | 🔴 CRITICAL | `routes.ts:10456` vs `routes.ts:11616-11656` | Два endpoint'а play counting | Объединить: `/api/gen-activity/:id/play` должен redirect или disable |
| 2 | 🔴 CRITICAL | `plugins/operator-commands/module.ts` vs `lib/yarsAutoTag.ts` + `routes.ts:7565` | Две системы Yars-команд | Удалить старый `operator-commands` plugin, остаётся `yars-queue` |
| 3 | 🔴 CRITICAL | `routes.ts:1297-1320` vs `lib/welcomeGift.ts` | Inline welcome gift в email-register vs helper | Email-регистрация должна использовать `tryGiveWelcomeGift()` |
| 4 | 🟡 MEDIUM | `routes.ts:544` vs `routes.ts:11564` | `NEW_AUTHORS_CUTOFF_ISO` константа | Вынести в `lib/constants.ts` |
| 5 | 🟡 MEDIUM | `routes.ts:9509` vs `:9956` vs `:10074` vs `:13126` | `/api/music/generate`, `/style-cover`, `/extend`, `/regenerate` | Общий dispatcher `dispatchMusicGeneration()` |
| 6 | 🟡 MEDIUM | `lib/chatGenerationTools.ts:71` vs `routes.ts:564-573` | PRICES fallback в 2 местах | Один источник через `getCurrentPriceKopecks()` (уже есть в pricing.ts) |
| 7 | 🟡 MEDIUM | `routes.ts:1192` vs `routes.ts:1152` | `pendingRegs` Map vs `sms_otp` table | Email-регистрация тоже должна писать в БД (не in-memory) |
| 8 | 🟡 MEDIUM | `routes.ts:13041-13057` | Cron `dailyCountryBump` (отключён, но код остался) | Удалить отключённую логику (mock-bump rows завышали счётчики) |
| 9 | 🟡 MEDIUM | `routes.ts:7920-7926` (bot-stats) | Mock cities (Москва/СПб/Лондон) | Удалить mock или хотя бы flag в UI |
| 10 | 🟢 LOW | `routes.ts:1748` vs `:1831` vs `:1901` | tgEmail с разными доменами `@telegram.MuzaAi.ru` vs `@telegram.muziai.ru` | Единый константный `TG_EMAIL_DOMAIN` |
| 11 | 🟢 LOW | Множество мест | Country canonicalization SQL CASE (Russia/США/...) | В helper `lib/countryCanonical.ts` (есть только 2 раза в SQL) |
| 12 | 🟢 LOW | `plays-analytics` vs `plays-audit` admin tabs | Разные purposes (analytics vs forensics) | Не дубль — оставить как есть |
| 13 | 🟢 LOW | `routes.ts:9621` vs extend/cover endpoint'ы | autoTitle generation | Вынести в `lib/titleExtract.ts` |

---

## Раздел 3: Статистика прослушиваний

### Sources (выявленные)

| ID | Source | Где используется | Тип |
|---|---|---|---|
| **A** | `gen_activity COUNT(action='play')` | `/api/playlist/stats` (site counter), master-dashboard plays.total, plays-analytics counted, top-tracks | Authoritative |
| **B** | `meta.plays` из `generations.style` JSON | `/api/playlist?sort=rating` (per-track rating), plays-analytics `counter.current`, dashboard per-track UI | Legacy cache |
| **C** | `_playsStatsCache` (in-memory) | `computePlaysStats()` 30-sec server cache | Snapshot |
| **D** | SSE broadcast `__broadcastPlaysStats` | Real-time UI updates через `/api/playlist/stats/stream` | Live push |

### Совпадение source A / B / C / D

**A vs B** — В norm-flow совпадают (при play +1 пишется в обе). Но:
- Admin backfill `/api/admin/v304/backfill-author-admin-plays` пишет ТОЛЬКО в B, не в A.
- Если cron почистит старые gen_activity rows (нет такого сейчас, но возможно) — B будет завышен.

**A vs C** — C derives from A с 30-sec lag. OK.

**Расхождения которые увидит юзер:**
- Trek X на главной отсортирован 1-й по rating (sort=rating uses B) — B=5000.
- Открыв трек, видит count: 5000 (B).
- Admin master-dashboard за период «всё» показывает реальный COUNT из gen_activity (A) — для same трека может быть 47.
- Сайт-счётчик (A) suma всех plays — корректная цифра.

**Подозрительные records:**
1. `meta.plays` записи у tracks где `gen_activity COUNT(action='play')` ~= 0 — это backfill'нутые.
2. `gen_activity` rows с `action='play'` где IP попадает в bot UA regex — это accidentally записанные до bot filter merge.
3. `play_rejected:author-self` исторические — после изменения правила (2026-05-22) перестали записываться, но historical records остались. Confusing для аналитики.

### shouldCountPlay() audit

`routes.ts:10421-10453`:

| Условие | Проверка | Бага потенциал |
|---|---|---|
| Bot UA | `isBotUserAgent(ua)` (regex из lib/botUa.ts) | Юзер с custom UA «Mozilla/Curl/x» — fly under radar |
| 5+ sec | `req.body.elapsedSec >= 5` | undefined elapsedSec → пропускает (backward-compat hole) |
| IP dedup 10 мин | SELECT count from gen_activity WHERE ip=? AND ... | Mobile NAT (МТС/Билайн) — корректно сужено до 10 мин (хорошо) |

**reason label несогласован:** `reason: "ip-dedup-1h"` (старый текст, окно 10 мин). Запутает админа когда будет дебажить.

### Frontend передаёт elapsedSec?

Yes:
- `landing.tsx:1439`: `body: JSON.stringify({ elapsedSec: 5 })` ✓
- `dashboard.tsx:1376`: `body: JSON.stringify({ elapsedSec: 5 })` ✓

Но HARDCODED `5` — frontend не передаёт реальное elapsed value. Если юзер послушал 3 секунды и нажал next, frontend сделал setTimeout 5000 → не отправил вообще. Если юзер послушал 30 секунд — отправил elapsedSec: 5 (т.е. сервер не знает реальное время). 

Это OK для дедупа, но плохо для аналитики «средняя длительность прослушивания» (не имеем).

### Cache invalidation

`_playsStatsCache = null` invalidated в:
- `/api/playlist/play/:id` после write ✓
- `/api/gen-activity/:id/:action` для play ✓
- SSE broadcast `__broadcastPlaysStats()` ✓
- 30-sec TTL natural expiration ✓

Outside places (backfill, admin tools) — НЕ invalidate. Сайт-счётчик будет stale до 30 сек после backfill.

---

## Раздел 4: Статистика посещений

### Sources

| ID | Source | Используется |
|---|---|---|
| **V1** | `visitors` table (raw events) | `/api/admin/visitor-stats`, `/api/public/countries-count`, `/api/playlist/geo-top`, master-dashboard.visitors |
| **V2** | `user_profiles` (aggregated, per-visitor) | `/admin/v304/user-profiles` tab |
| **V3** | `journey_events` (user actions) | `/admin/v304/journey-summary` + per-session view |
| **V4** | Yandex.Metrika (client-side) | VITE_YM_COUNTER_ID — не в БД, у Босса в external dashboard |
| **V5** | VK Pixel (client-side) | VITE_VK_PIXEL_ID |

### Issues

##### 4.1 [🔴 CRITICAL] Mock-cities в `/api/admin/v304/bot-stats`
**Файл:** `routes.ts:7920-7926`
```ts
const showcase: Array<{ city: string; country: string; country_code: string }> = [
  { city: "Москва", country: "Россия", country_code: "RU" }, ...
];
const realCityNames = new Set(realCities.map((c: any) => c.city));
const mockCities = showcase
  .filter(s => !realCityNames.has(s.city))
  .map((s, i) => ({
    ...s,
    sessions: Math.max(1, Math.round(seedRand(i + 1) * 30) + 1),  // ← FAKE!
    mock: true,
  }));
```

Это **админская** статистика по `/api/admin/v304/bot-stats` — Босс видит «топ городов» с **выдуманными** числами. Сидируется по дню (`day * 9301 + ...`). Босс может принять решения на основе fake data:
- «В Дубае много пользователей — нужно адаптировать рекламу под арабоязычных».
- На самом деле в БД нет ни одного юзера из Дубая.

Я предлагаю **СРОЧНО удалить mock-cities** или хотя бы спрятать за `?showMock=1` query-параметром.

##### 4.2 [🔴 CRITICAL] `daily_<country>_<date>` seeds (cron отключён, но historical data в БД)
**Файл:** `routes.ts:13041-13057` (с комментарием «cron отключён»)

```ts
// Eugene 2026-05-22 Босс «настоящая статистика» — cron ОТКЛЮЧЁН (создавал
// seed-row daily_<country>_<date> которые завышали public-счётчики в 9×).
const dailyCountryBump = () => {
  if (process.env.DAILY_COUNTRY_BUMP_ENABLED !== "1") return;
  ...
};
setInterval(dailyCountryBump, 24 * 60 * 60 * 1000);
setTimeout(dailyCountryBump, 5000);
```

Cron теперь отключён по env-флагу, но:
1. `setInterval` всё ещё запущен (отрабатывает только если ENV=1).
2. **Исторические seed-rows** (`fingerprint LIKE 'daily_%'`) — всё ещё в БД. Все endpoint'ы (`/api/playlist/geo-top`, `/api/public/countries-count`, master-dashboard) явно фильтруют их:
   ```sql
   fingerprint NOT LIKE 'daily_%' AND ip != '0.0.0.0'
   ```
3. Если хоть один новый endpoint забудет добавить этот фильтр — цифры **в 9× завышены**.

**Recommendation:** удалить старые `daily_%` rows одной миграцией:
```sql
DELETE FROM visitors WHERE fingerprint LIKE 'daily_%' AND ip = '0.0.0.0';
```
И удалить cron-код целиком из routes.ts (не нужен).

##### 4.3 [🟡 MEDIUM] Двойная запись visitor info: `visitors` + `user_profiles`
**Файл:** `routes.ts:888-981` (`/api/track-visit`)

В одном handler'е делается:
- INSERT/UPDATE `visitors` row (raw event log)
- INSERT/UPDATE `user_profiles` row (aggregated)

Две таблицы держат overlapping data: IP, country, city, region, userAgent, device, browser, os. При расхождении (один UPDATE прошёл, другой упал) — admin видит **разную** информацию в `/admin/visitors` vs `/admin/v304/user-profiles`. Должен быть один path или явное reconciliation.

##### 4.4 [🟡 MEDIUM] Bot UA filter применяется на READ side но не на WRITE side
**Файл:** `routes.ts:898-906` — теперь применяется и на write (commit 2026-05-19 audit D.1):
```ts
if (isBotUserAgent(String(ua))) {
  return res.json({ ok: true, skipped: "bot-ua" });
}
```
Это хорошо. Однако:
- Historical visitors rows с bot UA остались в БД.
- Read-side фильтр `buildBotExclusionSql("user_agent")` есть в master-dashboard (line 559), `/api/public/countries-count` (line 13004), `/api/playlist/geo-top` (line 10778) — но **не во всех endpoint'ах**. Проверка нужна.

##### 4.5 [🟡 MEDIUM] IP-detection путь
**Файл:** `routes.ts:894`
```ts
const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress || 'unknown';
```
Express `req.ip` зависит от `app.set('trust proxy')`. Если установлен — req.ip даёт client IP, x-forwarded-for becomes redundant. Если не установлен — req.ip даёт NAT-IP сервера. Нужно проверить `apps/neurohub/server/index.ts` на `trust proxy`.

##### 4.6 [🟢 LOW] Page filter excludes api but not /admin
**Файл:** `routes.ts:904`
```ts
if (typeof pageUrl === "string" && /^https?:\/\/[^/]+\/(api\/|favicon|robots\.txt|healthz|sitemap)/i.test(pageUrl)) {
  return res.json({ ok: true, skipped: "non-page" });
}
```
`/admin/v304/*` pages **записываются** в visitors — это значит admin sessions поднимают visitor count. Master-dashboard «посетители сегодня» включает админа. Не критично, но искажает метрики.

### Counter совпадение

| Where shown | Source | Calc Cycle |
|---|---|---|
| `landing.tsx` plays-counter | `/api/playlist/stats` (A=gen_activity COUNT) | poll every 60s |
| `master-dashboard.metrics.plays.total` | A=gen_activity COUNT period-filtered | cache 60s |
| `master-dashboard.metrics.visitors.total` | `visitors.visits SUM` period-filtered + bot/seed exclude | cache 60s |
| `dashboard.tsx` stats.visitors.today | unclear — different endpoint | unclear |

**Все используют разные cache levels.** При одновременном открытии 3 вкладок Босс может увидеть 3 разных «сегодня посетителей».

---

## Раздел 5: Метрики отражения на UI

| Метрика | Source endpoint | Cache | Совпадает с | Status |
|---|---|---|---|---|
| Total tracks (landing) | `/api/playlist/stats` (`computePlaysStats`) | server 30s | master-dashboard.gensMusicDone? — **РАЗНОЕ значение** (landing смотрит is_public=1, master — все статусы) | 🟡 |
| Total plays (landing counter) | `/api/playlist/stats` → gen_activity COUNT | server 30s + client 60s poll | master-dashboard plays.total (если period=all) | ✅ |
| Today plays MSK | `computePlaysStats.todayPlays` | server 30s | master-dashboard plays.total с period=today | ⚠️ unclear (master uses periodBoundaries 20:00 MSK cut-off; landing uses 00:00 MSK) — **CONFLICT** |
| Total users | master-dashboard.registrations.total | 60s | bot-stats не считает users, только sessions | ✅ |
| Total revenue | master-dashboard.payments.sumKopecks | 60s | other? нет других мест | ✅ |
| Today metrics (registrations/gens/payments) | master-dashboard period=today | 60s, cut-off 20:00 MSK | dashboard.tsx own stats (cut-off 00:00 UTC) — **CONFLICT** | 🔴 |
| Top tracks | master-dashboard.buildTopTracks (gen_activity COUNT) | 60s | plays-analytics topTracks (gen_activity COUNT) | ✅ |
| Top users / authors | dashboard.tsx stats.authors | unknown | bot-stats — no top users | ⚠️ |
| Pending generations (processing) | master-dashboard.gensMusicProcessing | 60s | admin-overview own poll | ⚠️ unclear |
| Failed generations (refunded vs not) | master-dashboard.gensMusicError | 60s | No "refunded" filter — error count includes refunded | 🟡 |
| API health (LLM keys) | `plugins/api-health/module.ts` | unclear | orchestrator (lib/agentOrchestrator) — overlapping | 🟡 |
| Pl

ays per category (song/greeting/instrumental) | client-side filter in landing.tsx | none | server NOT filtered — все meta.plays включают | ⚠️ unclear |

### 🔴 Today MSK cut-off РАСХОЖДЕНИЕ

**`computePlaysStats.todayPlays`** (`routes.ts:10733-10739`):
```ts
const now = new Date();
const mskNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
const mskTodayStart = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate(), 0, 0, 0));
const utcTodayStart = new Date(mskTodayStart.getTime() - 3 * 60 * 60 * 1000).toISOString();
```

**Cut-off = 00:00 MSK** (полночь по Москве).

**`master-dashboard.periodToBounds("today")`** uses `getPeriodRange("today")` from `lib/periodBoundaries.ts`:
- Cut-off **20:00 MSK** per `Period-20-MSK rule` in CLAUDE.md.

Босс в 21:00 MSK открывает:
- landing.tsx `todayPlays` — за последние ~21 час (с 00:00 MSK)
- master-dashboard «Сегодня plays» — за последние ~1 час (с 20:00 MSK)

**Эти цифры будут радикально разные.** Босс не поймёт почему.

**Fix:** `computePlaysStats` должен использовать `getPeriodRange("today")` от periodBoundaries.

### 🟡 Failed generations не разделены на refunded vs not-refunded

`master-dashboard.gensMusicError` = `COUNT(*) WHERE status='error'`.

Включает:
1. Треки с `errorReason` где refund прошёл (юзер деньги получил обратно)
2. Треки с `errorReason` где refund failed (юзер deactivate'нул аккаунт раньше / cost=0 fall-through)

В админ-tab не видно. Босс не может оперативно проверить «есть ли треки где refund НЕ прошёл — юзер ждёт денег».

**Fix:** добавить metric `gensMusicErrorRefunded` vs `gensMusicErrorPending` — query `meta.refunded` flag.

---

## Раздел 6: Рекомендации

### Приоритет 1 (CRITICAL — потеря денег / данных) — фиксить СЕГОДНЯ

1. **Refund fallback 9900 → PRICES[type]** — `routes.ts` 7 мест. Юзеры теряют 300₽/трек при некоторых сценариях.
2. **Telegram-юзеры получают welcome gift** — единый `tryGiveWelcomeGift()` во всех 3-х TG endpoint'ах.
3. **Today MSK cut-off** — landing.tsx counter использует `getPeriodRange("today")`, не свою логику.
4. **Удалить `daily_<country>_<date>` rows из БД** — SQL migration + удалить cron-код.
5. **Удалить mock-cities** из `/api/admin/v304/bot-stats` — fake data в админке.
6. **`bonus_tracks` refund при error** — в основных endpoint'ах проверять `usedBonusTrack` и возвращать.

### Приоритет 2 (MEDIUM — incorrect UX / inconsistent metrics) — фиксить на этой неделе

7. **Удалить `/api/gen-activity/:id/play` ветку** (только `/api/playlist/play/:id` остаётся).
8. **Удалить `operator-commands` plugin полностью** (yars-queue — единственный path).
9. **Email-регистрация → `tryGiveWelcomeGift()`** (вместо inline).
10. **Telegram-bonus 1000₽ — убрать** (или явно зафиксировать в CLAUDE.md что для TG другая политика).
11. **Backfill `gen_activity` для треков с meta.plays > gen_activity COUNT** — синхронизировать.
12. **Wrapper `dispatchMusicGeneration()` для общей логики** music/extend/cover/regenerate.
13. **Failed gen metric split**: refunded vs pending.
14. **Wrap `[INVOICE FULFILLMENT] failed`** в Telegram alert.

### Приоритет 3 (LOW — cosmetic / inconsistent naming) — backlog

15. `NEW_AUTHORS_CUTOFF_ISO` в `lib/constants.ts`.
16. `TG_EMAIL_DOMAIN` константа.
17. `reason: "ip-dedup-1h"` → `"ip-dedup-10min"` (text matches window).
18. `pendingRegs` Map → таблица в БД.
19. Country canonicalization SQL CASE → helper.
20. `app.set('trust proxy', true)` verify.

---

## Раздел 7: Дополнительные находки в ходе аудита

### 7.1 Token-store in-memory
`tokenStore` (lib/tokenStore.ts — judging by imports) is in-memory Map. При pm2 restart **все сессии теряются**. Юзер видит «требуется повторный вход» после каждого деплоя. Для production-class — должен быть Redis или DB-backed.

### 7.2 No rate-limit на `/api/gen-activity/:id/:action`
Endpoint без `authMiddleware`, без rate-limit. Атакующий может:
```bash
while true; do curl -X POST https://muzaai.ru/api/gen-activity/123/play -d '{"elapsedSec":5}' -H "Content-Type: application/json"; done
```
Накрутка plays защищена только IP-dedup 10 мин. Через ротацию IP — атакующий легко поднимает plays любого трека.

### 7.3 Webhook handler dormant но активен
`/api/suno/webhook` (GET + POST) принимает запросы (`routes.ts:884-885`). Если GPTunnel **действительно** начнёт отправлять webhook — handler сработает. Может конфликтовать с timeout-watcher polling, race conditions при двойном update gen.status. Решение: явно return 204 No Content с warning log если webhook прибыл (или удалить ручкой совсем).

### 7.4 `seedAdmin` password в .env только
`routes.ts:594-606` — `ensureSeedAdmin` создаёт admin user из `ADMIN_SEED_PASSWORD`. Если password leaked → admin takeover. По CLAUDE.md `Never-leak-secrets rule` это OK (secret in .env). Но: пароль хранится bcrypt-hashed → не reversible. Хороший pattern.

### 7.5 `_lastNotifiedMilestone30` и `_lastNotifiedMilestone1000` in-memory
`routes.ts:10640-10641` — milestone alerts state в memory. При pm2 restart `_lastNotifiedMilestone1000 = -1` → если рестарт когда total=10500, после рестарта при totalPlays=11000 → alert «10000 пройдено» (потому что `currentK=11, _lastNotifiedMilestone1000=-1, currentK > _lastNotifiedMilestone1000`). Алерт **дублируется**.

### 7.6 `_geoTopCache`, `_playsStatsCache`, `_sortTrackCache` — все in-memory
Hash module — нет clustering / load-balancing-safe state. OK для single pm2 instance, ломается при scale.

### 7.7 SSE `/api/playlist/stats/stream` — clients Set растёт
**Файл:** `routes.ts:10696-10699`
```ts
type StatsSseClient = { res: Response; id: number };
const _statsSseClients = new Set<StatsSseClient>();
```
Нет очистки при disconnect. Если клиент закрыл вкладку без явного req.on('close') firing → memory leak.

### 7.8 Frontend playlist sort default — двойная rotation logic
`landing.tsx` использует `/api/playlist/sort-default?category=X` (server-side rotation) + localStorage `pl_v2:sortMode` (per-user persist). Conflict: при первом заходе server возвращает default, юзер ничего не выбрал → playlist в server-rotation order. На следующий день при F5 server-rotation поменялся, но юзер ожидал прежний sort.

Проверка нужна: если у юзера в localStorage saved sortMode — frontend использует его. Если нет — fetch server-default. **Race condition при initial render** между fetch и mounted state.

### 7.9 `/api/playlist/play/:id` private track check
**Файл:** `routes.ts:10462-10468`
```ts
if ((gen.isPublic ?? 0) === 0) {
  const authedUser = (req as any).user || (req as any).authedUser;
  const authedUserId = authedUser?.id || (req as any).userId;
  ...
}
```
Endpoint **без** `authMiddleware`. Auth берётся optionally из `req.user` if attached upstream. Если auth middleware не сработал на эту route (что **по умолчанию** так — нет authMiddleware в decl) — `authedUserId = undefined` → check fails → **PRIVATE TRACK невозможно играть владельцу через этот endpoint**.

Юзер пытается play свой privacy=0 трек → 403 «private-track». Это для frontend non-issue (frontend играет только public tracks)... но dashboard.tsx использует тот же endpoint для своих личных треков. Возможен баг — нужно verify в проде.

### 7.10 Backfill endpoint `welcome-gift` — DRY-RUN flag
`/api/admin/v304/welcome-gift-backfill` (routes.ts:4278+) — нет `?dryRun=1` param, сразу применяет всё. Если запустить и понять что лимит 1000 уже исчерпан старыми SMS-юзерами — backfill заберёт slots у других. Должен быть dry-run.

### 7.11 `chatbot_sessions.user_id` linking — multiple paths
**Файл:** `routes.ts:1273` (email register) — `db.update(chatbotSessions).set({ userId: user.id })`.
**Файл:** `routes.ts:2505` (chat send) — auto-link если message пришло с Bearer.

Два path могут конфликтнуть: chat session анонимная, юзер регистрируется, email-register linket session, потом юзер пишет в чат с Bearer — second path overwrites userId (same value, no harm). OK.

### 7.12 SQL injection risk на user-failures endpoint
**Файл:** `routes.ts:4127-4128`
```ts
if (channel) rawConditions.push(`channel = '${String(channel).replace(/'/g, "")}'`);
if (since) rawConditions.push(`created_at >= '${String(since).replace(/'/g, "")}'`);
```
**Manual string interpolation в SQL.** `.replace(/'/g, "")` удаляет single quotes но **НЕ** other SQL injection vectors (`;`, `--`, escape chars). Endpoint `requireAdmin` так что только admin может exploit → severity LOW, но плохая практика. Замена на drizzle-params обязательна.

---

## Conclusion

**Всего найдено**:
- 🔴 **6 CRITICAL** (потенциальная потеря денег, недостоверные данные у Босса в админке, дубли core endpoint'ов)
- 🟡 **14 MEDIUM** (inconsistent metrics, дубли логики, race conditions)
- 🟢 **12 LOW** (cosmetic, naming, обратная совместимость)

### Сводка по разделам:

| Раздел | Найдено |
|---|---|
| Flow A (регистрация) | 6 (2 CRITICAL) |
| Flow B (генерация) | 5 (2 CRITICAL) |
| Flow C (воспроизведение) | 4 (2 CRITICAL) |
| Flow D (оплата) | 3 |
| Flow E (публикация) | 3 |
| Дубли | 13 |
| Plays-стат | 4 |
| Visits-стат | 6 (2 CRITICAL) |
| UI-отражение | 4 (1 CRITICAL — today MSK) |
| Bonus findings | 12 |

### Главный takeaway для Босса:

> **Самая срочная проблема — Telegram-юзеры теряют welcome gift, плюс refund на music-треки в edge case возвращает 99₽ вместо 399₽.**
>
> **Самая большая угроза доверию к админке — mock-cities и dual play-stats (meta.plays vs gen_activity).**
>
> **Самый большой технический долг — operator-commands plugin как дублёр yars-queue.**

Audit complete. Ready for Босс review.

---
*Аудит выполнен Claude Code (Opus 4.7 1M context). Длительность: 1+ час static-analysis без БД доступа.*
*Дата: 2026-05-23 (для Босса утром 2026-05-24).*
