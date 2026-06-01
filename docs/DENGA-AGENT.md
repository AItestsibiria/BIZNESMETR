# Агент Деньга — cost tracking + profit analysis

**Eugene 2026-05-24** «заведи агента по учёту затрат на каждого автора, чат, генерации по каждому треку. Если было общение между треками — затраты на счёт последнего. Анализ дохода MuzaAi по трекам / автору исходя из стоимости трека/текста/изображения на МОМЕНТ генерации. Правило для всех ранее созданных. Отчёт в админке — Агент Деньга».

Cost tracking + profit analysis с разбивкой по авторам / трекам / анонимам. Хранит тарифы провайдеров на момент генерации, версионирование через `validFrom/validUntil`. Manual override через admin.

## Зачем

- **Cost-side visibility.** До этого агента — знали только revenue (сколько юзер заплатил). НЕ знали — сколько нам стоила каждая генерация в провайдерах (Suno / Anthropic / Yandex). Это нужно для PnL.
- **Per-user LTV.** Топ-20 авторов по profit → marketing target для premium upsell. Loss-makers — нужна review.
- **Anomaly detection.** Если юзер платит мало, но cost огромный — abuse / accident / pricing-error. Алерт в admin.
- **Chat-to-track attribution.** Чат — наш реальный расход (LLM tokens), но он не привязан напрямую к gen. Босс правило: «если общение между треками — затраты на счёт последнего» (т.е. на трек, который пришёл после chat'а).

## Архитектура

```
┌──────────────────────────────────────────────────┐
│  AdminUI: /admin/v304 → 💰 Деньга                │
│  ┌────────────┬─────────┬─────────┬────────────┐ │
│  │  Сводка    │ Авторы  │ Треки   │ Анонимы    │ │
│  │  Тарифы    │ Override                       │ │
│  └────────────┴─────────┴─────────┴────────────┘ │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│  Endpoints (server/routes.ts, requireAdmin):     │
│  GET  /api/admin/v304/denga/aggregates           │
│  GET  /api/admin/v304/denga/users                │
│  GET  /api/admin/v304/denga/users/:id/details    │
│  GET  /api/admin/v304/denga/tracks               │
│  GET  /api/admin/v304/denga/tracks/:genId        │
│  GET  /api/admin/v304/denga/anonymous            │
│  GET  /api/admin/v304/denga/tariffs              │
│  POST /api/admin/v304/denga/manual-cost          │
│  POST /api/admin/v304/denga/invalidate-cache     │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│  lib/dengaAgent.ts                               │
│  ├─ getAggregates() — per period totals          │
│  ├─ getUserStats() — per-user breakdown          │
│  ├─ getTrackStats() — per-track cost detail      │
│  ├─ getAnonymousStats() — chat без userId        │
│  ├─ listUsersWithStats() / listTracksWithStats() │
│  ├─ setManualCost() — admin override             │
│  └─ attributeChatCostToTracks() — chat → track   │
└──────────────┬───────────────────────────────────┘
               │
        ┌──────┴──────┬─────────────┐
        ▼             ▼             ▼
┌─────────────┐ ┌──────────────┐ ┌──────────────────┐
│ providerTar │ │ generations  │ │ chatbot_messages │
│ -iffs.ts    │ │ (revenue)    │ │ + sessions       │
│ (cost side) │ │ + tariff_    │ │ (chat cost)      │
│             │ │   history    │ │                  │
└─────────────┘ └──────────────┘ └──────────────────┘
        +
┌─────────────────────────────┐
│ denga_manual_costs          │
│ (admin overrides)           │
└─────────────────────────────┘
```

## Методология расчёта

### Revenue (что юзер заплатил нам)

- `generations.cost` — точная цена на момент генерации (snapshot из PRICES в момент списания)
- Fallback: текущий PRICES если `gen.cost = 0` / null

### Cost (наши OUT-of-pocket затраты)

Каждый component считается отдельно через `providerTariffs.ts`:

| Component | Provider | Cost ≈ |
|---|---|---|
| Music gen (Suno) | gptunnel-suno | 220 ₽ за трек (V4.5) |
| Cover image | gptunnel-image | 50 ₽ |
| Lyrics | gptunnel-suno (/lyrics) | 20 ₽ |
| Chat reply | deepseek (primary) | ~25₽/1M input + ~104₽/1M output |
| Chat reply (Anthropic fallback) | anthropic-haiku | ~76₽/1M input + ~380₽/1M output |
| Yandex STT | yandex-stt | ~0.67₽/сек |
| Yandex TTS | yandex-tts | ~5₽ за call |

Тарифы версионированы — при изменении цены провайдера добавляется новая запись в `TARIFF_HISTORY` с `validFrom = новое время` + `validUntil = новое время` у старой записи.

### Chat-to-track attribution (Босс rule)

Алгоритм per user:

1. Сортируем все gens юзера ASC по `createdAt`
2. Сортируем все chat messages юзера ASC по `createdAt`
3. Для каждого bot message (role='bot') — находим **первый gen с `gen.createdAt > msg.createdAt`** (т.е. трек который пришёл ПОСЛЕ chat'а)
4. Если такой trek есть → attribute chat.cost к этому gen
5. Если такого gen нет (chat произошёл после всех gens юзера) → attribute к **последнему** gen юзера
6. Если у юзера вообще нет gens, но он chat'ил → bucket "anonymous_chat_cost"

**Anonymous chats** (нет userId в session) — отдельный bucket, прибавляется к `totalCost` для PnL, но НЕ привязан к юзеру.

### Manual override

Admin может через `/admin/v304 → 💰 Деньга → ✋ Ручной ввод` указать:
- Override Suno cost (если у вас был discount от провайдера)
- Override chat cost (если расчёт не отражает реальный provider invoice)
- Override cover/lyrics cost

Каждый override:
- Записывается в `denga_manual_costs` с `admin_id` + `created_at`
- Apply latest wins per gen_id
- Audit-log через `recordAuditEntry` (Backup-before-edit rule)
- Cache invalidate сразу же

## Period boundaries

Все endpoints используют `getPeriodRange()` из `lib/periodBoundaries.ts` (Period-20-MSK rule — cut-off дня 20:00 МСК).

Supported periods: `today` / `yesterday` / `7d` / `30d` / `365d` / `all` / `month-1`..`month-12` / `custom`.

## Cache

In-memory cache TTL=5 минут (`CACHE_TTL_MS`). Invalidated:
- При `setManualCost()` (любой override)
- При `POST /api/admin/v304/denga/invalidate-cache` (manual из UI)

Per-track запросы (`getTrackStats`) НЕ кешированы — точные данные на каждый клик.

## UI: Sub-tabs

| Sub-tab | Что |
|---|---|
| 📊 Сводка | KPI: revenue / cost / profit / avg per track |
| 👥 По авторам | Searchable table users with stats |
| 🎵 По трекам | Searchable table tracks with cost breakdown |
| 👤 Анонимы | Chat cost от non-authenticated sessions |
| 💵 Тарифы | Provider tariffs viewer (read-only) |
| ✋ Ручной ввод | Admin override form for specific gen |

## Backfill для existing данных

«Правило для всех, ранее созданных» (Босс) — agent работает без миграции существующих gens. При первом запросе `/aggregates` / `/users` — agent проходит по всем gens, считает cost из `TARIFF_HISTORY` по `gen.createdAt`, кэширует. Никаких записей в existing rows не делается.

Если provider tariff (TARIFF_HISTORY запись) меняется ретроспективно (нашли что Suno реально стоил больше до даты X) — добавляется новая запись со `validFrom` старой даты, и все cost'ы для gens до этой даты пересчитываются автоматически (через cache invalidate).

## Связано с

- **Pricing-single-source rule** (CLAUDE.md) — `PRICES` для revenue side, `TARIFF_HISTORY` для cost side
- **Agent-orchestrator rule** — `denga` зарегистрирован как agent (`role: diagnostic`)
- **Backup-before-edit rule** — все manual overrides → `recordAuditEntry`
- **Period-20-MSK rule** — все аналитические endpoints через `getPeriodRange()`
- **Secrets-admin-only rule** — все endpoints `requireAdmin`
- **No-duplicates rule** — НЕ дублирует billing-audit; billing-audit о integrity, denga о PnL

## TODO (next iterations)

1. **Real-time tariff sync** — если provider меняет цены (Anthropic price drop / GPTunnel наценка), нужен manual update `TARIFF_HISTORY` через миграцию. Опционально: webhook listener для Anthropic pricing updates.
2. **Per-track manual revenue override** — сейчас manual override только cost-side. Иногда нужно adjust revenue (если был refund partial).
3. **Export to CSV** — для bookkeeping / 1C.
4. **Profit-trend chart** — line chart per period.
5. **Loss alert daemon** — auto-detect юзеров с profit < 0 + push alert в Telegram админу.
6. **API для marketing-orchestrator** — `getDengaUserLTV(userId)` → используется при segmentation (high-LTV → premium upsell).

## Edges в Orchestrator

```
denga → marketing-orchestrator (data-sync)
   purpose: Per-user profit/LTV → retargeting segments

denga → muza-admin (webhook)
   purpose: Loss alerts (profit < 0) для review
```
