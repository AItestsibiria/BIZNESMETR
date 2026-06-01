# Sprint 1 — Definition of Done

**Спринт 1 v304 — Фундамент.** План в `original/07 §2`.

## Чек-лист по DoD

| Пункт | Статус | Где |
|---|---|---|
| EventBus + таблица `events` | ✅ | `apps/neurohub/server/core/eventBus.ts` + schema |
| ModuleRegistry + таблица `plugins_registry` | ✅ | `apps/neurohub/server/core/moduleRegistry.ts` + schema |
| Таблица `feature_flags` + базовый API | ✅ | `apps/neurohub/server/core/featureFlags.ts` + schema (admin UI отложен на S7 — `07 §2`) |
| Таблица `leads` + ingest endpoint | ✅ | `apps/neurohub/server/plugins/lead-capture/module.ts` |
| Таблица `agent_actions` | ✅ (DDL) | `apps/neurohub/shared/schema.ts` (заполнение — Sprint 4-5) |
| Таблица `tracking_attribution` | ✅ | заполняется плагином `lead-capture` |
| Yandex Метрика + VK Pixel SDK | ✅ | `apps/neurohub/client/src/lib/pixels.ts` + main.tsx (no-op без `VITE_*_ID`) |
| UTM client tracker | ✅ | `apps/neurohub/client/src/lib/tracking.ts` |
| Багфикс №1 (реферал при первой оплате) | ✅ **уже исправлен в v51** | `server/routes.ts:3665-3677` |
| Багфикс №3 (`extractAudioUrl` с fallback на `result_data`) | ✅ **уже исправлен в v51** | `server/routes.ts:1670-1682` |
| Багфикс №7 (refund bonus track при ошибке) | ✅ **уже исправлен в v51** (см. tech-debt ниже) | `server/routes.ts:2215-2216` |

## Tech-debt и наблюдения, не блокирующие Sprint 1

### Bug №7 — рефанд bonus track по эвристике `cost === 0`

**Текущее решение в v51:**
```ts
// routes.ts:2215-2216
if (gen.cost > 0) {
  // refund balance
  storage.updateBalance(gen.userId, gen.cost);
  storage.createTransaction(...);
} else {
  // assume it was a bonus track
  db.update(users).set({ bonusTracks: sql`${users.bonusTracks} + 1` })...;
}
```

**Что предлагала стратегия:** хранить `usedBonusTrack: boolean` явно в `generations.style` JSON или отдельной колонке.

**Почему не блокер:** на практике `cost === 0` эквивалентно использованию bonus track (см. `checkAndCharge` в `routes.ts:343-352`, строка 352: `return { ok: true, isFree: false, cost: 0, usedBonusTrack: true }`). Эвристика устойчива.

**Когда может сломаться:** если появится новый flow с `cost === 0`, не связанный с bonus track (например, free-trial новой фичи). Тогда refund начислит лишний бонус.

**Решение (если/когда нужно):** добавить колонку `generations.used_bonus_track INTEGER DEFAULT 0` через ALTER TABLE в `storage.ts` migrations + читать её при refund. Маленькая правка, ставлю в backlog Sprint 2 (вместе с Suno-расширениями).

---

## Что закоммичено в Sprint 1

- `c7acace` — server/core/ (EventBus, ModuleRegistry, FeatureFlags, types, logger), пробный плагин example, расширения schema + storage migrations
- `3419b68` — client tracking + pixels + lead-capture плагин
- `da58239` — рабочее правило «авто-продолжение» в CLAUDE.md

## Что осталось до выкатки v304-фундамента

1. **Сборка** на dev-машине → `npm install && npm run build`.
2. **Smoke-тест** локально: запуск `npm run dev`, проверка `GET /api/example/ping`, `POST /api/lead-capture/touch` (curl), проверка таблиц в `data.db`.
3. **Деплой на clone** через scp + tar + pm2 restart (Perplexity prompt #5).
4. **Проверка** на сервере: `sqlite3 .tables` показывает 6 новых таблиц, `plugins_registry` содержит `example` и `lead-capture` со статусом `active`.

После шага 4 — Sprint 1 закрыт реально, переходим к Sprint 2 (Suno на 100%).

---

*Last updated: 2026-05-06*
