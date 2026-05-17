# Второй мозг MuzaAi — задача для следующей сессии

> Босс 17.05.2026 ~01:11 MSK: «Запусти субагента для создания второго мозга Муза Ай когда лимит возобновится»

## Что нужно сделать

**После возобновления контекста / новой сессии** — запустить subagent в worktree с задачей создать **«Второй мозг»** — 3D-визуализация всей архитектуры проекта.

## Концепт (из обсуждений 16 мая)

- Парящее облако точек — узлы = модули проекта
- Связи (рёбра) разной толщины = частота вызовов
- Цвет узла = состояние (зелёный=ok / жёлтый=warning / красный=incident)
- Размер = объём данных / трафика
- Hover → glow + popup с метриками (calls/день, latency p95, last error)
- Click → drawer справа с full info (link на код, recent events, KPI)

## Стек технологий

- **3D engine**: React Three Fiber (R3F) — уже в проекте через VRoid Муза subagent
- **Force-directed graph**: `3d-force-graph` (vasturiano) или custom через R3F + d3-force
- **UI overlay**: Framer Motion popovers + Drei `<Html>`
- **Data source**: `GET /api/admin/v304/brain-export` (сделан subagent'ом master dashboard, см. agentId a468480dfdd419035)

## Что переиспользовать

- ✅ Three.js + R3F + Drei deps (уже добавлены в `package.json` через worktree-agent-ae94ba360c3ee4256)
- ✅ Glow lighting setup (purple/cyan/amber) — переиспользовать
- ✅ `brain-export` endpoint (создан subagent'ом master dashboard)
- ✅ API health data (api_key_health table — содержит статусы)
- ✅ Existing module catalog (14 agent-plugins + auth + chat + payments + etc.)

## Файлы для создания

- `apps/neurohub/client/src/pages/admin/second-brain.tsx` — full-screen 3D view
- `apps/neurohub/client/src/components/brain/BrainGraph.tsx` — Three.js force graph
- `apps/neurohub/client/src/components/brain/NodeDetail.tsx` — drawer с info
- `apps/neurohub/server/lib/brainData.ts` — агрегатор data для brain-export

## Откуда брать данные узлов

| Узел | Метрики |
|---|---|
| auth-sms | registrations 7d, callcheck success rate |
| chatbot/muza | sessions 24h, avg tokens/call |
| generation | success rate 24h, avg latency |
| payments | invoices 7d, success rate |
| telegram-bot | webhooks received 24h |
| max-bot | то же |
| anthropic | API health (status), token usage |
| timeweb gateway | API health |
| gptunnel | balance |
| yandex-speechkit | usage |
| storage | DB integrity, disk usage |
| и все остальные plugins |

## Точное ТЗ для subagent

(подробное описание задачи следующий subagent получит при создании, на основе этого файла + текущих коммитов)

## Связанные файлы

- `docs/strategy/HANDOFF-160526.md` — handoff от вчерашней сессии
- `docs/strategy/PLAYS-COUNT-AUDIT-170526.md` — недавний audit
- API health endpoint в `apps/neurohub/server/plugins/api-health/module.ts`
- Master dashboard от subagent a468480dfdd419035 (когда завершится)

## Команда для следующей сессии

```
git pull origin claude/add-claude-documentation-OW5V7
ls docs/strategy/SECOND-BRAIN-NEXT-SESSION.md && echo "OK, начинаю"
# Затем — запустить Agent с subagent_type='general-purpose', isolation='worktree'
# с prompt'ом на основе этого файла
```

🕐 Создан: 2026-05-17 01:12 MSK
