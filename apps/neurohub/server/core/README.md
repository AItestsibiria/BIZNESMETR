# `server/core/` — v304 plugin foundation (Sprint 1)

Реализация требований из `docs/strategy/original/06-PLUGIN-АРХИТЕКТУРА-ХВОСТЫ.md` и таблиц из `07-DEPLOY-ROADMAP-СХЕМА-БД.md §3`.

---

## Состав

| Файл | Зачем |
|---|---|
| `types.ts` | Контракты: `Module`, `BusEvent`, `EventBusContract`, `FeatureFlagsContract`, `BootContext`, `Migration`, `Job` |
| `eventBus.ts` | In-process pub/sub. Каждое событие пишется в таблицу `events` (id, name, payload JSON, source, user_id, lead_id, handlers_count/_failed). Подписчики выполняются с timeout 5 сек, ошибки в одном handler не валят остальных |
| `featureFlags.ts` | Кэш в памяти. `isEnabled(key, userId?)` учитывает `enabled` + `rolloutPercent` (детерминированный bucket по hash(`key:userId`)). `getVariant(key, userId?)` отдаёт A/B-вариант с весом |
| `moduleRegistry.ts` | Топологическая сортировка по `dependencies`, применение миграций (best-effort, идемпотентно), монтирование роутов под `/api/<prefix>`, подписка на события, запись в `plugins_registry`. Падение одного модуля не валит остальные |
| `logger.ts` | Минимальная обёртка над `console.{log,warn,error}` — заменим на pino + redaction в Спринте 8 |
| `index.ts` | Public surface (re-export) |

## Таблицы (см. `shared/schema.ts` + `server/storage.ts` auto-CREATE)

| Таблица | Назначение | Спринт |
|---|---|---|
| `events` | Шина событий, аудит, replay | 1 |
| `plugins_registry` | Реестр плагинов, статусы, ошибки | 1 |
| `feature_flags` | A/B + rollout по % | 1 |
| `leads` | Анонимные посетители до регистрации | 1 |
| `agent_actions` | Что сделал каждый из 9 агентов | 1 (схема) / 4–5 (заполнение) |
| `tracking_attribution` | UTM first/last touch + clickids | 1 |

## Подключение в `server/index.ts`

```ts
import { EventBus, FeatureFlags, ModuleRegistry, createLogger } from "./core";
import exampleModule from "./plugins/example/module";

// ... после await registerRoutes(httpServer, app):
const eventBus = new EventBus();
const featureFlags = new FeatureFlags();
const registry = new ModuleRegistry();
registry.register([exampleModule]);
await registry.start({ app, eventBus, featureFlags, logger: createLogger("boot") });
```

## Создание нового плагина

```ts
// server/plugins/<name>/module.ts
import { Router } from "express";
import type { Module } from "../../core";

const router = Router();
router.get("/health", (_req, res) => res.json({ data: { ok: true }, error: null }));

const myPlugin: Module = {
  name: "my-plugin",
  version: "1.0.0",
  dependencies: [],                 // имена других модулей
  routes: { prefix: "my-plugin", router },  // /api/my-plugin/health
  publishes: ["my-plugin.something_happened"],
  subscribes: {
    "auth.user.registered": async (event, ctx) => {
      ctx.logger.info("hi", { userId: (event.payload as any)?.userId });
    },
  },
  onLoad: async (ctx) => {
    ctx.logger.info("loaded");
  },
  healthCheck: () => ({ status: "ok" }),
};
export default myPlugin;
```

И в `server/index.ts`: `registry.register([myPlugin])`.

## Проверка после деплоя

```bash
# 1. Сервис поднялся, ничего не падает
pm2 status neurohub

# 2. Пробный плагин отдаёт ответ
curl -s http://127.0.0.1:5000/api/example/ping

# 3. v304-таблицы созданы
sqlite3 /var/www/neurohub/data.db ".tables" | tr ' ' '\n' | grep -E '^(events|plugins_registry|feature_flags|leads|agent_actions|tracking_attribution)$'

# 4. Плагин зарегистрирован в реестре
sqlite3 /var/www/neurohub/data.db "SELECT name, version, status, loaded_at FROM plugins_registry;"
```

## Что НЕ входит в Sprint 1 (передвинуто)

- Hook system (`pre:generate`, `pre:payment`) — Sprint 2/3 при необходимости
- Admin UI для feature flags — Sprint 7 (вместе с дашбордом)
- 9 агентов как плагины — Sprint 4–5
- Vitest-инфраструктура — Sprint 6 (вместе с тестами для chatbot/notifications)
- pino logger + redaction — Sprint 8

## Граничные правила (НЕ нарушать)

1. Плагины **не пишут в core-таблицы** (`users`, `generations`, `payments`, …) — только через storage API или events.
2. Плагины **не вызывают друг друга напрямую** — только через `eventBus.emit`.
3. Каждое событие подписчик обрабатывает **до 5 сек** — иначе timeout. Длинные операции — через `agent_actions` + jobs.
4. **Идемпотентность миграций** обязательна — `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE` с проверкой PRAGMA. Мы перезагружаем модули на каждый старт.
5. **Никаких секретов в `module.ts`** — только через `process.env`.
