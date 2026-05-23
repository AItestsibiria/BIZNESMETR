# Agent Orchestrator — central registry

**Eugene 2026-05-23** «Оркестратор нужен всеми компаниями агентами начать в проекте — коде».

Central in-memory registry для всех AI-agents / channels / personas / watchdog'ов / cron'ов MuzaAi. Один файл-source-of-truth, lightweight tracking, admin visualization.

## Что такое «agent»

- **Agent** = логическая роль. Один agent может работать через несколько каналов.
- **Persona** = маска/личность. Один agent может иметь несколько persona (см. Single-persona-across-channels rule в CLAUDE.md).
  - Пример: Музa-TG = один agent с 4 personas (Аня / Татьяна / Мария / Ольга), выбор по hash(userId).
  - Пример: Музa-web и Музa-TG = **разные** agents (разные channels), но одна общая «персона Музы» (Single-persona rule).

## Channels (типы каналов)

| Channel | Где | Status |
|---|---|---|
| `web` | muzaai.ru web-чат | ✅ Музa-web |
| `telegram` | TG bot @Muziaipodari_bot | ✅ multi-persona |
| `max` | Max bot | ✅ |
| `vk` | VK community bot | ⏳ (subagent параллельно) |
| `email` | Email inbound + outbound | ✅ |
| `voice` | Yandex TTS / STT | ✅ |
| `admin` | Admin-voice FAB | ✅ |
| `cron` | Periodic schedulers | ✅ |
| `internal` | Filters / detectors / utility | ✅ |

## Roles (типы агентов)

| Role | Описание |
|---|---|
| `consultant` | Диалоговый помощник (Музa et al) |
| `watchdog` | Мониторинг, polling, refund |
| `moderator` | Yars-detector, pre-flight filters |
| `broadcaster` | Outbound notifications |
| `diagnostic` | Health probes |
| `tool` | Utility internal services |

## Default зарегистрированные agents

Bootstrap происходит в `apps/neurohub/server/index.ts` через `bootstrapDefaultAgents()` (см. `apps/neurohub/server/lib/agentOrchestrator.ts`):

| id | name | channel | role | persona |
|---|---|---|---|---|
| `muza-web` | Музa (web) | web | consultant | muza |
| `muza-tg` | Музa (Telegram) | telegram | consultant | anya\|tatyana\|maria\|olga |
| `muza-max` | Музa (Max) | max | consultant | muza |
| `muza-vk` | Музa (VK) | vk | consultant | muza |
| `muza-voice` | Музa Voice (TTS/STT) | voice | consultant | muza |
| `muza-admin` | Музa Admin (голос Босса) | admin | consultant | muza |
| `channel-email` | Email канал | email | broadcaster | — |
| `watchdog-suno` | Watchdog Suno | cron | watchdog | — |
| `watchdog-api-health` | Watchdog API-keys | cron | diagnostic | — |
| `watchdog-channels` | Channel watchdog | cron | watchdog | — |
| `moderator-yars` | Yars-детектор | internal | moderator | — |
| `marketing-orchestrator` | Маркетинг-оркестратор | internal | marketing | — |

Status каждого вычисляется при bootstrap по presence ENV-ключей. Нет ключа → `not_configured`.

## Как добавить новый agent (3 шага)

### Шаг 1 — Register

В `bootstrapDefaultAgents()` (или в onLoad plugin'а):

```ts
import { orchestrator } from "@/lib/agentOrchestrator";

orchestrator.register({
  id: "muza-whatsapp",
  name: "Музa (WhatsApp)",
  channel: "internal", // или расширь AgentChannel type
  role: "consultant",
  persona_key: "muza",
  status: process.env.WA_TOKEN ? "active" : "not_configured",
  capabilities: ["chat", "voice", "media"],
});
```

### Шаг 2 — recordActivity hook (опционально, recommended)

В webhook handler / cron tick / endpoint после успешного processing:

```ts
import { recordAgentActivity } from "@/lib/agentOrchestrator";

// На каждый успешный reply / tick / tool call:
recordAgentActivity("muza-whatsapp", { sessionId, userId });
```

Это lightweight, sync, never throws. Просто обновляет `lastSeenAt`.

### Шаг 3 — healthCheck (опционально)

При register передай функцию-probe:

```ts
orchestrator.register({
  id: "muza-whatsapp",
  // ...
  healthCheck: async () => {
    const r = await fetch("https://api.whatsapp.com/v1/health", {
      headers: { Authorization: `Bearer ${process.env.WA_TOKEN}` },
    });
    return { ok: r.ok, details: r.ok ? "200" : `HTTP ${r.status}` };
  },
});
```

`runHealthCheck(agentId)` / `healthCheckAll()` запускается из admin UI или вручную.

## Admin endpoints

| Endpoint | Описание |
|---|---|
| `GET /api/admin/v304/orchestrator/agents` | List всех agents + summary. Поддерживает фильтры `?channel=X&role=Y&status=Z` |
| `GET /api/admin/v304/orchestrator/health` | Run `healthCheckAll()` + return results |

Auth: `requireAdmin` (Босс / super_admin only). Никаких секретов в response — только status, capabilities, lastSeenAt.

## Admin UI

Вкладка **🤖 Оркестратор** в `/admin/v304`. Возможности:
- Карточки всех agents (cards grid)
- Фильтр по channel / role / status
- Status badge: 🟢 active / 🔴 error / 🟡 paused / ⚪ not_configured
- Last seen relative time
- Capabilities chips
- Кнопка «🔬 Запустить health check» — синхронно проверяет все agents с healthCheck'ом
- Auto-refresh каждые 60 сек

## Pattern для future channels

Когда нужно добавить ещё один канал (WhatsApp, Instagram DMs, SIP-calls, Email-inbound — да что угодно):

1. Создаёшь plugin / webhook handler как обычно (без изменений в существующий orchestrator API)
2. В plugin'е `onLoad` или в boot — `orchestrator.register({...})`
3. В webhook handler — `recordAgentActivity(id, meta)` после успешной обработки
4. Опционально — healthCheck функция

Никакой кросс-вызов RPC между agents через orchestrator — это **registry + visibility layer**, не event bus. Для cross-plugin communication используй существующий `EventBus` из `core/`.

## Anti-patterns (что НЕ делает orchestrator)

- ❌ Не routing actual messages между agents (channel handler сам знает куда class'ить)
- ❌ Не replace existing endpoints / channels — это observability layer
- ❌ Не хранит секреты (только статусы + capabilities)
- ❌ Не управляет start/stop/restart (admin UI info-only)
- ❌ Не дублирует state (existing logic работает как раньше)

## Связано с

- **Single-persona-across-channels rule** в CLAUDE.md — про persona vs agent
- **No-duplicates rule** — orchestrator extends visibility, не дублирует api-health / channel-watchdog
- **Reuse-working-solutions rule** — channels продолжают использовать существующие endpoints

## Code reference

- `apps/neurohub/server/lib/agentOrchestrator.ts` — singleton + types + bootstrap + edges + emitter
- `apps/neurohub/server/lib/marketingAgent.ts` — marketing campaigns / segments / calendar
- `apps/neurohub/server/routes.ts` — admin endpoints (search `orchestrator/agents`, `marketing/`)
- `apps/neurohub/client/src/pages/admin/orchestrator-tab.tsx` — admin UI (3 sub-tabs)
- `apps/neurohub/server/index.ts` — `bootstrapDefaultAgents()` + `installMarketingHandlers()` calls
- `docs/AGENT-ORCHESTRATOR-PROPOSALS.md` — edge matrix + 15 marketing предложений
