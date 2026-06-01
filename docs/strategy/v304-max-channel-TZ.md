# ТЗ v304 — Max.ru как отдельный sales-канал

**Статус:** черновик 2026-05-07. Eugene 12:00 запросил «отдельную ветку продаж через Max.ru с привязкой БД к каналу».

**Цель:** позволить пользователям Max.ru заказать кавер песни через бота — с записью голоса, переработкой в текст, генерацией 2 вариантов и оплатой через тот же Robokassa, с полной attribution в наших таблицах (`leads.source='max'`).

---

## §1. Контекст и ссылки

- Eugene-канал в Max: https://max.ru/id7017236261_biz
- API docs: [dev.max.ru/docs](https://dev.max.ru/docs-api), endpoint `https://platform-api.max.ru`
- Auth: header `Authorization: <BOT_TOKEN>` (без Bearer)
- Webhook: HTTPS only, port 443, secret через `X-Max-Bot-Api-Secret`
- Rate-limit: 30 req/sec
- **Регуляторика 2026:** публиковать ботов в каталоге MAX можно только через **верифицированное ЮЛ РФ** (см. Habr). Для приватного канала с прямой ссылкой это не требуется.

---

## §2. User flow (sales-funnel в Max.ru)

```
1. User: открывает https://max.ru/id7017236261_biz → жмёт «Написать» → /start
2. Bot: «Привет! Я создам песню по вашему запросу. Выберите тип:
       [🎵 Простая песня · 299₽]   [🎂 Поздравление · 299₽]
       [💼 Корпоратив · 999₽]      [🎼 Больше шаблонов]»
3. User: выбирает кнопку
4. Bot: «Запишите голосовое: расскажите 30 секунд кому/о чём песня. Имя адресата, повод, особенности.»
5. User: отправляет voice (mp3/m4a/ogg, до 3 мин) + опц. текст
6. Bot: «Готовлю текст… (15 сек)»
   - Скачиваем audio через GET /attachments/<id>
   - Транскрибируем через Whisper (LLM_PROVIDER + speech-to-text)
   - LLM переписывает в singable lyrics (4 куплета + припев) с placeholder-ами заполненными
7. Bot: «Текст готов. Подходит?
       <текст песни>
       [✅ Да, генерируй]   [✏ Переделать текст]   [✋ Отменить]»
8. User: ✅
9. Bot: «Оплати 299₽ → [💳 Оплатить через Robokassa]»
   - URL: https://muziai.ru/api/payment/create-max?leadId=...
   - leadId привязан к max_user_id, source='max'
10. User: оплачивает → webhook /api/payment/result с InvId={leadId}
11. Bot: «Спасибо! Генерирую 2 варианта кавера, 2-4 минуты ждать.»
   - Запускаем 2 параллельные генерации в Suno с одной лирикой,
     разный seed/style для разнообразия
12. Bot: «Готово! Слушайте:
       [🎧 Вариант 1.mp3]   [🎧 Вариант 2.mp3]
       
       Понравилось? Поставьте оценку:
       [⭐⭐⭐⭐⭐]   [Перегенерировать (доплата 199₽)]»
13. User: рейтинг → запись в DB → авто-follow-up «спасибо!»
```

---

## §3. Архитектура

```
                        ┌─── Max.ru cloud ───┐
                        │  bot 7017236261_biz │
                        └──────────┬──────────┘
                                   │ HTTPS webhook (X-Max-Bot-Api-Secret)
                                   ▼
        ┌──────── server: plugin max-channel ────────┐
        │  POST /api/max/webhook  (secret-verify)    │
        │  ┌───────────── FSM ──────────────────┐   │
        │  │ idle → menu → recording → review   │   │
        │  │       → payment → generating → done │   │
        │  └────────────────────────────────────┘   │
        │  - storage: chatbot_sessions (channel='max')│
        │  - audio: download → /uploads/<userId>/<sha>│
        │  - LLM: speech-to-text → text-rewrite       │
        │  - payment: Robokassa create-max + webhook  │
        │  - generate: 2× /api/gen/audio-cover        │
        │  - delivery: POST /messages (audio_url)     │
        └─────────────────┬───────────────────────────┘
                          │ uses existing infra
                          ▼
         storage.ts · normalizeVocalParams · audio-upload
         leads · transactions · admin-overview · payments
```

---

## §4. Изменения БД

### §4.1 Таблица `leads` (extension)
Уже есть `source` column. Добавить значения: `source='max'`. Никаких ALTER не нужно.

### §4.2 Таблица `chatbot_sessions` (extension)
Уже поддерживает `channel`. Добавим:
```sql
ALTER TABLE chatbot_sessions ADD COLUMN max_user_id TEXT;       -- id юзера в Max
ALTER TABLE chatbot_sessions ADD COLUMN max_chat_id TEXT;       -- ид чата (для отправки)
ALTER TABLE chatbot_sessions ADD COLUMN fsm_state TEXT;         -- 'menu'|'recording'|'review'|...
ALTER TABLE chatbot_sessions ADD COLUMN fsm_data TEXT;          -- JSON {templateSlug, audioSha, lyricsId, paymentId, ...}
```

### §4.3 Привязка генераций к каналу
Добавить в `generations`:
```sql
ALTER TABLE generations ADD COLUMN source_channel TEXT;         -- 'web'|'max'|'tg'|...
ALTER TABLE generations ADD COLUMN source_session_id INTEGER;   -- FK chatbot_sessions
```

Это позволит делать в /admin/v304 фильтр «генерации по каналу» + revenue per channel.

---

## §5. Плагин `max-channel`

`apps/neurohub/server/plugins/max-channel/module.ts`

Endpoints:
- `POST /api/max/webhook` — приёмник Max.ru, X-Max-Bot-Api-Secret verify
- `GET /api/max/health` — health для admin

Внутренние функции:
- `sendMessage(chatId, text, buttons?)` — POST platform-api.max.ru/messages
- `downloadAttachment(attachmentId)` → Buffer + сохранение через audio-upload
- `transcribeAudio(buffer)` → text via GPTunnel speech-to-text
- `rewriteToLyrics(text, templateSlug)` → singable lyrics via GPTunnel chat
- `generateTwoCovers(uploadSha, lyrics)` → 2 paralle calls к /api/gen/audio-cover
- `handleFsmTransition(session, event)` — FSM state machine

Jobs:
- `every_minute`: scan chatbot_sessions where state='generating' → poll Suno → если 1 готов, шлём пользователю; если оба — финал

Subscriptions:
- `payment.completed` где `source='max'` → переводит FSM из `payment` в `generating`
- `gen.cover.completed` → проверяет связь с max-сессией → отправляет audio_url пользователю

---

## §6. Платёжный flow

Существующий Robokassa-flow расширяем:
- Новый endpoint `POST /api/payment/create-max { leadId, amount, sessionId }`
- Возвращает payment URL с UTM `?utm_source=max&utm_medium=bot&utm_campaign=cover`
- Webhook `/api/payment/result` уже обрабатывает; добавим логику: если invoice связан с max-session → emit `payment.completed { source:'max', sessionId }`

В DB `payments` добавим:
```sql
ALTER TABLE payments ADD COLUMN source_channel TEXT;
ALTER TABLE payments ADD COLUMN source_session_id INTEGER;
```

---

## §7. Speech-to-text + LLM-rewrite

GPTunnel поддерживает Whisper через `/v1/audio/transcriptions`:
```ts
POST https://gptunnel.ru/v1/audio/transcriptions
Content-Type: multipart/form-data
Authorization: <GPTUNNEL_API_KEY>
file: <buffer>
model: whisper-1
language: ru
```

Затем chat-completion для rewrite:
```ts
POST https://gptunnel.ru/v1/chat/completions
{
  model: "gpt-4o-mini",
  messages: [
    {role: "system", content: "Ты — поэт-песенник. Перепиши описание в текст песни (4 куплета + припев)…"},
    {role: "user", content: "Тема: ${transcript}\nШаблон: ${templateSlug}"}
  ],
  max_tokens: 800,
  temperature: 0.85
}
```

---

## §8. Pricing per channel

| Услуга в Max.ru | Цена | Комментарий |
|---|---|---|
| Простая песня | 299 ₽ | как в web |
| Поздравление | 299 ₽ | как в web |
| Корпоратив | 999 ₽ | премиум-канал, ручная курация (опц.) |
| Re-roll | 199 ₽ | как extend в web |
| Stems package | 499 ₽ | если запросит (Sprint 5+) |

Маржа Max-канала: контролируем в /admin/v304 → новая секция «Доход по каналам».

---

## §9. Admin-секция «Каналы продаж»

В /admin/v304 → Обзор → новая карточка:
```
📡 Каналы продаж (за 7 дней)
| Канал  | Сессий | Заказов | Выручка |
|--------|--------|---------|---------|
| web    | 142    | 38      | 11 362₽ |
| max    | 23     | 6       | 1 794₽  |
| tg     | 0      | 0       | 0₽      |
```

Drill-down: клик на строку → таблица сессий/заказов конкретного канала с переходом на /track/<id>.

---

## §10. Открытые вопросы (нужны решения Евгения цифрой)

1. **Регистрация бота в Max.ru:**
   - У тебя уже есть BOT_TOKEN или надо создать через `@MasterBot` в Max?
   - Если бот-юзер `id7017236261_biz` — это ТВОЙ юзер-аккаунт, а не бот, нужен отдельный регистрированный бот.

2. **Speech-to-text провайдер:**
   - Whisper через GPTunnel (~$0.006/мин, RU поддержка отличная)?
   - Или Yandex SpeechKit (нативно русский, ~₽0.45/мин)?
   - Или другое?

3. **Платежи:**
   - Тот же Robokassa с доп. UTM (web и max → одна касса) — рекомендую
   - Или отдельный мерчант для max-канала
   - Или Max.ru in-app payments (если у них есть)

4. **Авто-регистрация юзеров:**
   - Создавать `users` запись по max_user_id (без email/пароля), потом приглашение в web?
   - Или max-юзеры остаются «leads» без users-записи до тех пор пока не зайдут на сайт?

5. **Доставка трека:**
   - Слать audio-файл (mp3) прямо в Max — ограничение 50 MB (хватит)
   - Или ссылку на /track/<id>?
   - Гибрид: сообщение «Слушай → max-audio» + «полная страница → ссылка»

---

## §11. Sprint plan

| Sprint | Что | ETA |
|---|---|---|
| 6.1 (этот) | Skeleton max-channel plugin: webhook + 5-state FSM + DB ALTERs | 1 день |
| 6.2 | Speech-to-text + lyrics-rewrite через GPTunnel | 0.5 дня |
| 6.3 | Robokassa create-max + webhook bridge | 0.5 дня |
| 6.4 | 2-параллельные генерации, доставка audio в Max | 0.5 дня |
| 6.5 | Admin «Каналы продаж» панель | 0.5 дня |
| 6.6 | E2E smoke-test на staging Max-боте | 0.5 дня |

**Итого: ~3.5 дня** до production-ready.

---

*Sources: [dev.max.ru/docs](https://dev.max.ru/docs-api), [habr.com/ru/articles/951326/](https://habr.com/ru/articles/951326/), [github.com/max-messenger](https://github.com/max-messenger).*
