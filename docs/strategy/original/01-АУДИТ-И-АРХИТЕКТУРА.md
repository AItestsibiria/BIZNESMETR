# 01. АУДИТ КОДА v303 + ЦЕЛЕВАЯ АРХИТЕКТУРА v304  
  
## §0. РЕЗЮМЕ  
  
1. В ядре найдено **11 нестыковок**: 3 критические (ломают monetization/security), 6 архитектурных, 2 производительность.  
2. Целевая архитектура v304 — **тонкое ядро + plugin layer + event bus**. Каждый новый функционал (агенты, чат-бот, аналитика) — плагин.  
3. Все исправления и расширения сгруппированы в **8 спринтов** (см. §10 → файл 07).  
  
### §0.1 Что делать на этой неделе (приоритет 1)  
  
1. Закрыть критические нестыковки **№1, №3, №7** (см. §1.1).  
2. Добавить таблицы `events`, `leads`, `agent_actions` (см. файл 07).  
3. Внедрить `EventBus` и `ModuleRegistry` (см. файл 06).  
4. Поставить базовые pixels (VK + Метрика, 5 событий) — см. файл 05.  
  
После этого можно строить агентов, дашборд и чат-бот.  
  
---  
  
## §1. НАЙДЕННЫЕ НЕСТЫКОВКИ  
  
### §1.1 Критические (блокируют monetization или безопасность)  
  
#### №1. Реферальный бонус начисляется при регистрации, а не при первой покупке  
  
- **Где:** `auth.service.ts: confirmRegistration` — начисляет 299 ₽ обоим при подтверждении email реферала.  
- **Проблема:** боты-фермы. Эмулятор регистраций через временные почтовые ящики — 100 рефералов = 29 900 ₽ без единой покупки.  
- **Решение:** перенести начисление в `payments.service.ts: handleSuccessCallback`, проверяя:  
  ```  
  - referrer.referral_bonus_given = 0  
  - referee.payments WHERE status='paid' .count >= 1  
  - либо: referee первая успешная generation type='music'  
  ```  
- **Размер правки:** \~12 строк в одном сервисе + миграция на сброс уже начисленных, но «фейковых» бонусов.  
  
#### №3. `streaming.routes.ts: extractAudioUrl` не находит аудио для старых записей  
  
- **Где:** функция падает на v200-эпохе, где `result_url IS NULL`, а аудио сидит только в `result_data.result[0].audio_url`.  
- **Симптом:** в библиотеке трек есть, по play — 404.  
- **Решение:**  
  1. Сначала проверять `localPath` (если файл скачан локально).  
  2. Затем `result_url`.  
  3. Затем парсить `result_data` JSON — берём первый `audio_url`.  
  4. Миграция: для всех done-генераций без `result_url` — копируем из JSON.  
- **Размер правки:** \~20 строк + миграция data backfill.  
  
#### №7. Бонусный трек не возвращается при ошибке генерации  
  
- **Где:** `billing.service.ts: charge` возвращает `usedBonusTrack: true`, но `music.service.ts` при refund вызывает `refund({ usedBonusTrack: false })`.  
- **Симптом:** пользователь получил подарок, генерация упала на стороне Suno, бонус сгорел.  
- **Решение:** сохранять `usedBonusTrack` в `generations.style` JSON или отдельной колонке. При refund читать оттуда.  
- **Размер правки:** \~6 строк, миграция не нужна (миграция нужна только если хотим вернуть бонусы тем, у кого они уже сгорели — отдельный скрипт по логам).  
  
### §1.2 Архитектурные нестыковки  
  
#### №2. `signed_url_nonces` создана, но не используется  
  
- Replay-атака на signed URL возможна (5-минутный TTL её не закрывает: за 5 минут URL можно расшарить через социалки).  
- **Решение:** middleware на `/api/stream/play/:token`, который пишет nonce в БД при первом verify, отказывает на повторе. Cleanup-job чистит старше TTL.  
- Если бизнес-логика разрешает «один раз послушать → расшарить → ещё раз послушать», nonce не нужен. Это решение бизнеса.  
  
#### №4. `playlist.routes.ts` показывает удалённые треки  
  
- WHERE учитывает `is_public=1` и `status='done'`, но не `deleted_at IS NULL`.  
- В ленте появляются удалённые треки → 404 при play.  
- **Решение:** добавить `AND deleted_at IS NULL` во все ленты публичные/трендовые/персональные.  
  
#### №5. `bug_reports.fingerprint` склеивает несвязанные ошибки  
  
- Минифицированные production-стеки имеют одинаковые первые строки (`at o (a.js:1:2345)`).  
- Группировка ломается.  
- **Решение:** нормализовать через source maps (если есть) или хешировать `message + первая строка вне node_modules + statusCode`.  
  
#### №6. `MediaSession.seekto` зависает на iOS Safari  
  
- Если `setPositionState` вызван до `loadedmetadata`, iOS игнорирует, и lockscreen-progress «зависает» на 0:00.  
- **Решение:** очередь обновлений position, flush при `loadedmetadata`.  
  
#### №8. `gen_activity.play` записывается каждые 5 секунд = 30+ строк за трек  
  
- Клиент в `player.ts: tickPosition` репортит на сервер каждые 5 сек.  
- За 1 трек — 30+ записей `play`. Таблица растёт линейно, аналитика искажается.  
- **Решение:** дедуп `play` per `(gen_id, session_id)` за 30 минут. Дополнительные события `play_completed_30s`, `play_completed_full` — для воронки.  
  
#### №9. Cleanup `rate_limit` не вызывается  
  
- `pruneRateLimit` объявлен в `jobs/index.ts`, но никогда не запускается (нет регистрации в `index.ts` точки входа).  
- **Решение:** в `jobs/index.ts: registerJobs()` добавить `setInterval(cleanupRateLimit, 3600_000)`. Вызвать `registerJobs()` в `server/index.ts`.  
  
#### №10. Нет retry на 429/503 от GPTunnel  
  
- Один сбой провайдера = трек уходит в `error`.  
- **Решение:** wrapper с экспоненциальным backoff, max 3 попытки за 30 секунд. На 4-й — refund.  
  
#### №11. Поля `pendingName` / `nameChangeToken` без endpoints  
  
- В схеме есть, в коде нет workflow подтверждения.  
- **Решение (быстрое):** удалить поля, чтобы не путали.  
- **Решение (правильное):** написать /api/profile/request-name-change + /api/profile/confirm-name-change/:token.  
  
### §1.3 Производительность  
  
#### №12. Лента «trending» делает full scan  
  
- `playlist.routes.ts` сортирует через JOIN с `gen_activity` без агрегатной таблицы.  
- На 100k+ записей запрос >2 секунд.  
- **Решение:** новая таблица `gen_stats_daily(gen_id, date, plays, unique_listeners, completions)`. Cron-job обновляет каждый час. Лента читает из неё.  
  
#### №13. Hourly-summary багов — full scan  
  
- Индекс `(fingerprint, created_at)` есть, но запрос `WHERE created_at >= ? GROUP BY fingerprint` использует `created_at` первым полем.  
- **Решение:** второй индекс `(created_at, fingerprint)` или materialized agreg.  
  
### §1.4 Безопасность (помимо критических)  
  
| ✅ / ⚠️ | Что | Комментарий |  
|---|---|---|  
| ✅ | Backdoor `admin@soundai.ru` удалён | Память подтверждает |  
| ✅ | Sessions с TTL 30 дней rolling | OK |  
| ✅ | Bearer только в `Authorization` header | OK |  
| ⚠️ | CSRF middleware упомянут, но не реализован | Для платежей и удаления треков критично |  
| ⚠️ | Path traversal в streaming | `streamFileWithRange` не проверяет симлинки. Решение: `fs.realpathSync` |  
| ⚠️ | `INITIAL_ADMIN_PASSWORD` в `.env` | После первого старта удалить вручную (документировать в DEPLOY.md) |  
| ⚠️ | Логи могут содержать секреты | Logger пишет `req.body`, если `REQUEST_LOG_BODY=true`. Залогировать пароль из `/api/auth/login` — лёгкая ошибка. Решение: redaction-middleware |  
  
---  
  
## §2. ЦЕЛЕВАЯ АРХИТЕКТУРА v304  
  
### §2.1 Слои (вертикальный разрез)  
  
```  
┌─────────────────────────────────────────────────────────────┐  
│  CHANNELS (web, telegram, vk, email, whatsapp)              │  
└────────────────────────┬────────────────────────────────────┘  
                         │ нормализация  
┌────────────────────────▼────────────────────────────────────┐  
│  OMNICHANNEL GATEWAY                                         │  
│  превращает любое входящее в IncomingMessage{user, intent}   │  
└────────────────────────┬────────────────────────────────────┘  
                         │  
┌────────────────────────▼────────────────────────────────────┐  
│  CONDUCTOR-BOT (LLM)                                         │  
│  intent classification, slot filling, маршрутизация          │  
└────────────────────────┬────────────────────────────────────┘  
                         │  
┌────────────────────────▼────────────────────────────────────┐  
│  AGENTS LAYER (9 агентов + Master A1)                        │  
│  declarative, plugin-based, подписаны на events              │  
└────────────────────────┬────────────────────────────────────┘  
                         │ events  ↕ commands  
┌────────────────────────▼────────────────────────────────────┐  
│  EVENT BUS (in-process pub/sub + persisted)                  │  
│  все важные события записываются в `events` таблицу          │  
└────────────────────────┬────────────────────────────────────┘  
                         │  
┌────────────────────────▼────────────────────────────────────┐  
│  CORE (тонкое ядро)                                          │  
│  auth, billing, generations, streaming, payments,            │  
│  playlist, admin, diagnostics                                │  
└────────────────────────┬────────────────────────────────────┘  
                         │  
┌────────────────────────▼────────────────────────────────────┐  
│  INFRASTRUCTURE                                              │  
│  SQLite WAL · GPTunnel (Suno + LLM) · Robokassa · SMTP       │  
│  · IMAP · Telegram Bot API · VK API · Webhooks (pixels)      │  
└─────────────────────────────────────────────────────────────┘  
```  
  
### §2.2 Файловая структура v304  
  
```  
muziai/  
├── core/                  # тонкое ядро (как в v303)  
│   ├── env.ts, db.ts, logger.ts, errors.ts, http.ts  
│   ├── signedUrl.ts, crypto.ts, ua.ts  
│   ├── eventBus.ts        # ★ НОВОЕ: pub/sub шина  
│   └── moduleRegistry.ts  # ★ НОВОЕ: регистрация плагинов  
│  
├── modules/               # бизнес-модули (можно отключать)  
│   ├── auth/  
│   ├── billing/  
│   ├── generations/  
│   ├── music/             # Suno-провайдер + расширенные возможности  
│   ├── streaming/  
│   ├── payments/  
│   ├── playlist/  
│   ├── analytics/  
│   └── admin/  
│  
├── plugins/               # ★ ПОДКЛЮЧАЕМЫЕ ПЛАГИНЫ  
│   ├── chatbot/           # ConductorBot + agents  
│   ├── crm/               # Lead scoring, RFM, NBA  
│   ├── support/           # Ticket system  
│   ├── invoicing/         # Счета и закрывающие документы  
│   ├── notifications/     # Email/SMS/Telegram/Push  
│   ├── omnichannel/       # Inbound из всех каналов  
│   ├── social-publish/    # Автопостинг VK/Telegram  
│   ├── pixels/            # VK/Yandex/Meta/MyTarget tracking  
│   ├── retention/         # Email-кампании, re-engagement  
│   ├── feature-flags/     # A/B тесты, флаги  
│   ├── leads/             # Анонимные посетители → leads  
│   └── extend-cover/      # Suno extend/cover воркфлоу  
│  
├── agents/                # ★ АГЕНТЫ (как мини-плагины)  
│   ├── A1-master.ts  
│   ├── leadHunter.ts  
│   ├── scoutAgent.ts  
│   ├── welcomeAgent.ts  
│   ├── demoAgent.ts  
│   ├── onboardingAgent.ts  
│   ├── conversionAgent.ts  
│   ├── referralAgent.ts  
│   ├── retentionAgent.ts  
│   └── contentAgent.ts  
│  
├── client/                # фронт (как в v303)  
│   └── src/features/player/, lib/, ...  
│  
├── shared/schema.ts       # вся БД-схема  
├── scripts/migrate.ts  
└── server/index.ts        # точка входа  
```  
  
### §2.3 Принципы расширения (резюме, детали — файл 06)  
  
1. **Module API.** Каждый модуль/плагин экспортирует:  
   ```typescript  
   export const myModule: Module = {  
     name: 'invoicing',  
     version: '1.0.0',  
     dependencies: ['payments', 'notifications'],  
     migrations: [/* SQL files */],  
     routes: invoicingRouter,  
     jobs: [createInvoiceJob, ...],  
     subscribes: {  
       'payment.succeeded': handlePaymentForInvoice,  
     },  
     publishes: ['invoice.created', 'invoice.sent'],  
   };  
   ```  
  
2. **Event Bus.** Не функциональные вызовы, а события. Любой плагин может подписаться/публиковать.  
3. **Hook Points** в ядре: `pre:generate`, `post:generate`, `pre:payment`, `post:payment`, `user:lifecycle:*` и т.д.  
4. **Feature Flags.** Любая новая функциональность за флагом, можно отключить без релиза.  
5. **Migration auto-discovery.** Каждый модуль кладёт миграции в `modules/<name>/migrations/`. Скрипт `migrate.ts` находит все, применяет в правильном порядке.  
  
### §2.4 Bootstrap последовательность  
  
```  
1. loadEnv()              ← валидация .env  
2. initDb()               ← подключение SQLite, WAL-режим  
3. runMigrations()        ← все миграции из core + modules + plugins  
4. moduleRegistry.load()  ← все модули  
5. eventBus.start()  
6. agents.start()         ← подписка на events  
7. registerJobs()         ← cron-таски  
8. startBugCollector()  
9. http.listen(PORT)  
```  
  
---  
  
## §3. ОБРАТНАЯ СОВМЕСТИМОСТЬ С v303  
  
Все API-маршруты v303 сохраняются. Новые endpoints добавляются с префиксом `/api/v2/...` (по необходимости). Старый клиент продолжит работать после деплоя v304 без изменений.  
  
**Что произойдёт автоматически:**  
- Сессии с TTL переезжают (миграция уже была в v303 → v304 без изменений).  
- Бонусные треки с историей сохраняются.  
- Существующие генерации не пересоздаются.  
  
**Что требует ручного действия:**  
- Включить новые pixels (см. файл 05) — задаётся в `.env`.  
- Подключить чат-бот канал (Telegram/VK) — задаётся в `.env` + регистрация бота у Telegram/VK.  
- Настроить SMTP IMAP для входящих писем поддержки (см. файл 04, §5).  
  
---  
  
## СЛЕДУЮЩИЙ ФАЙЛ → `02-МУЗЫКАЛЬНЫЙ-ДВИЖОК-Suno-на-100.md`  