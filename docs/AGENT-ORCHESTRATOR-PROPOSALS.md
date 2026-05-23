# Agent-Orchestrator — Marketing Proposals (Eugene 2026-05-23)

Set of marketing-oriented agent enhancements built on top of `lib/agentOrchestrator.ts` + `lib/marketingAgent.ts`. Each proposal includes user/business value, effort, and risk.

---

## Edge Matrix (agent ↔ agent relationships)

После регистрации `marketing-orchestrator` через `bootstrapDefaultAgents()` дефолтная матрица edges:

| From \ To | muza-web | muza-tg | muza-vk | muza-max | channel-email | watchdog-suno | muza-admin | marketing-orchestrator |
|---|---|---|---|---|---|---|---|---|
| **muza-web** | — | data-sync | — | — | notify | — | — | event (payment, publish) |
| **muza-tg** | pair-link | — | — | — | — | — | — | event (register) |
| **muza-vk** | — | — | — | — | — | — | — | — |
| **muza-max** | pair-link | — | — | — | — | — | — | — |
| **muza-voice** | webhook | — | — | — | — | — | webhook | — |
| **watchdog-suno** | — | — | — | — | notify | — | webhook | — |
| **watchdog-api-health** | — | — | — | — | — | — | webhook | — |
| **moderator-yars** | — | — | — | — | — | — | event | — |
| **marketing-orchestrator** | campaign | broadcast | broadcast | broadcast | broadcast | — | — | — |

**Edge types** в `lib/agentOrchestrator.ts`:

- `pair-link` — handoff context (Cross-channel conversation linking rule)
- `broadcast` — marketing-orchestrator → channel post
- `webhook` — outbound HTTP call
- `notify` — transactional notification
- `event` — listen на event (orchestrator-local emitter)
- `campaign` — marketing → in-channel content placement
- `data-sync` — обмен memory / user context

---

## 1. VK Donut автообвязка → premium TG channel

**Что**: когда VK-юзер подписывается на VK Donut → `marketing-orchestrator` создаёт campaign `email` (welcome) + `telegram` (invite в premium TG-channel) + assign premium_subscription tier `donut_vk`.

- **Юзеру**: единый seamless onboarding в premium независимо от channel где он подписался.
- **MuzaAi**: cross-channel retention. VK-юзеры начинают взаимодействовать через TG, увеличивая touch-points.
- **Effort**: mid (нужен VK Donut webhook + premium_subscriptions tier extension)
- **Risk**: VK Donut API rate limits. Решается idempotency через `payment.succeeded` event.
- **Dependency**: vk-channel plugin must accept Donut callbacks.

## 2. Музa-recovery: incomplete chat → +24h follow-up

**Что**: юзер вёл диалог с Музой, дошёл до `[PROPOSE_GEN]` маркера, но **не нажал «запускай»**. Через 24h `marketing-orchestrator` создаёт campaign email/web-chat «не доделали трек?».

- **Юзеру**: помощь не дойти до забытого черновика. Реминд + промокод.
- **MuzaAi**: recovery конверсии в 5-15% от brought-up интентов (Suno funnel benchmark).
- **Effort**: low (existing `[PROPOSE_GEN]` маркер уже есть в chatHistory)
- **Risk**: spam-perception. Mitigation: только 1 recovery / неделю / юзер.

## 3. Birthday detection в Музе → 24h before reminder

**Что**: Музa в диалоге распознаёт **дату дня рождения** (LLM tool `detect_event_date({type: "birthday", date, person})`). За 24h orchestrator создаёт email/TG campaign «сделайте песню сегодня».

- **Юзеру**: tactical reminder. Подарок «вспомнили вовремя».
- **MuzaAi**: высокая конверсия (urgency + emotional + готовый use-case).
- **Effort**: mid (LLM tool + storage в user_memory.facts_json.important_dates)
- **Risk**: privacy — даты упоминаемые «маме на 70-летие» = PII. Mitigation: only store в user_memory с access governance.
- **Связано**: User-memory-context rule.

## 4. VK Pixel goals + LookAlike ребют

**Что**: setup goals (registration, generation, payment) в VK Pixel. После 1000+ conversions запросить LookAlike audience. `marketing-orchestrator` channel-allocation suggests % бюджета на LAL.

- **Юзеру**: больше похожих авторов в community.
- **MuzaAi**: CAC снижается -25-40% по lookalike vs cold targeting.
- **Effort**: high (требует minimum 1000 conversions в Pixel + admin VK ads UI)
- **Risk**: VK Pixel deprecation pending (replacement VK Ads tag). Mitigation: dual track Yandex.Metrika.

## 5. Email warming для new SMTP IP

**Что**: когда добавляем 2-й SMTP-relay (failover from Gmail to private SMTP) — постепенно ramp-up отправок (50/100/500/1000/день). `marketing-orchestrator` calendar контролирует throughput.

- **Юзеру**: меньше попаданий в спам.
- **MuzaAi**: deliverability rates >95% vs typical 60-70% для cold IP.
- **Effort**: mid (need throughput limiter в email plugin)
- **Risk**: missed campaigns during warming. Mitigation: priority queue (transactional > marketing).

## 6. Multi-touch attribution (UTM + last-touch + first-touch)

**Что**: tracker UTM на ВСЕ outbound ссылки (`utm_source=tg&utm_campaign=cmp_xxx`). Сохранять в `user_profiles.meta.touchpoints[]`. Attribution model: last-touch (default), optional first-touch / linear для admin reports.

- **Юзеру**: invisible.
- **MuzaAi**: знаем какой channel реально привёл к payment. ROI per channel = revenue / ad_spend.
- **Effort**: mid (UTM injection + storage column + admin UI)
- **Risk**: cookie tracking restrictions (Apple ATT). Mitigation: server-side UTM via session linkage.

## 7. Auto-Ya.Direct campaign builder из top searches

**Что**: top-search queries в Музa-чате («сделать песню маме на юбилей», «трек на свадьбу») → auto-generate Yandex.Direct keyword list + ad copy templates. Admin одним кликом запускает campaign в Direct UI.

- **Юзеру**: лучшая релевантность ads (точные topic-match).
- **MuzaAi**: 2-3× CTR vs generic keywords.
- **Effort**: high (Ya.Direct API integration + admin UI builder)
- **Risk**: keyword over-saturation. Mitigation: bid-cap.

## 8. TG channel auto-post top-5 треков недели

**Что**: каждый понедельник в 10:00 МСК `marketing-orchestrator` собирает top-5 публичных треков по plays за последние 7 дней. Post в TG community channel + VK community wall.

- **Юзеру**: discovery новых авторов. Авторы в топе — social proof.
- **MuzaAi**: engagement ↑ (likes / shares / follows к авторам).
- **Effort**: low (cron + existing playlist queries)
- **Risk**: накрутки plays. Mitigation: Play-counting rule (3 conditions) уже фильтрует ботов.
- **Связано**: Two-playlist rule (только из main playlist).

## 9. VK Clips auto-cut → 15-сек teaser

**Что**: top-rated треки → автогенерация 15-сек video clip (cover + 15-сек audio + animated bars) → upload в VK Klipy.

- **Юзеру**: short-form discovery.
- **MuzaAi**: trending в VK Klipy = бесплатный organic reach.
- **Effort**: high (требует ffmpeg + VK Clips API + automation)
- **Risk**: storage (each clip ~5-10 МБ × thousands). Mitigation: cleanup через 30 дней.

## 10. Reactivation cron: inactive 14+ days

**Что**: каждый понедельник `marketing-orchestrator` запрашивает segment `churned_14d` → создаёт email + push reactivation campaign. Variant A: бонусный трек, Variant B: «расскажи что мы пропустили».

- **Юзеру**: возврат к платформе.
- **MuzaAi**: 5-10% reactivation rate (industry benchmark) = +N% MAU.
- **Effort**: low (segment уже описан в SEGMENT_REGISTRY)
- **Risk**: повторный churn. Mitigation: лимит 2 reactivations / квартал / юзер.

---

## 11. Premium upsell после 3-го трека

**Что**: юзер сгенерировал 3 трека за 7 дней (power-user signal) → marketing создаёт offer «премиум-голосовые сообщения от Музы + неделя бесплатно».

- **Юзеру**: discovery премиум-фич.
- **MuzaAi**: премиум-подписки conversion >15% на activated power-users (vs <2% на cold).
- **Effort**: mid (трек-count detector + segment `milestone_3_tracks`)
- **Risk**: premature pitch. Mitigation: только если 3+ треков **за неделю** (high intent).

## 12. Cross-channel referral leaderboard

**Что**: top-10 рефереров за месяц → display в landing + email-newsletter + TG community message. Хосты получают бонус-трек + featured badge.

- **Юзеру**: gamification рефералов.
- **MuzaAi**: referral программа становится виральной.
- **Effort**: mid (leaderboard query + UI + bonus distribution)
- **Risk**: PII utilities (top names). Mitigation: opt-in displaying real name (default = маска).

## 13. Anti-churn signal: long-running pause в чате с Музой

**Что**: юзер был в активном диалоге 5+ exchange'ев, потом 7+ дней молчал → orchestrator emit `user.churned` с **специальным контекстом** «активный диалог брошен». Custom variant: «продолжим где остановились?» с цитатой последнего exchange.

- **Юзеру**: персональный реминд = высокая re-engagement rate.
- **MuzaAi**: revival продолженных диалогов с фактической продолжением = LTV boost.
- **Effort**: mid (chatHistory query + user.churned variant routing)
- **Risk**: stale context (за неделю интерес ушёл). Mitigation: 7-day TTL не больше.

## 14. Segmented payment-recovery: failed → retry next month

**Что**: payment.failed (Robokassa отклонил карту) → orchestrator email через 3 дня «попробуйте ещё раз — кошельки / СБП тоже работают». Через 14 дней — special-discount campaign.

- **Юзеру**: помощь обойти банковский отказ (карта рф vs зарубежная и т.д.).
- **MuzaAi**: recovery 8-12% от failed transactions (industry).
- **Effort**: low (payment.failed event + email template)
- **Risk**: confused user. Mitigation: ссылка на Музу для personal help.

## 15. Daily Music — TG channel «один трек / день»

**Что**: TG community channel «MuzaAi · Daily Music» — каждое утро 09:00 МСК один отобранный трек. `marketing-orchestrator` calendar выбирает по weighted score (plays + freshness + diversity).

- **Юзеру**: ежедневный discovery habit.
- **MuzaAi**: community engagement, TG subscribers ↑.
- **Effort**: low (cron + existing top-tracks query)
- **Risk**: repetition. Mitigation: dedup last 30 days.

---

## Implementation priority

| # | Title | Effort | Impact | Priority |
|---|---|---|---|---|
| 2 | Музa-recovery 24h follow-up | low | high | **🟢 P0** |
| 8 | TG/VK top-5 weekly | low | high | **🟢 P0** |
| 10 | Reactivation cron 14d | low | mid | **🟢 P0** |
| 14 | Payment recovery | low | mid | 🟡 P1 |
| 15 | Daily Music TG | low | mid | 🟡 P1 |
| 3 | Birthday detection | mid | high | 🟡 P1 |
| 11 | Premium upsell 3+ tracks | mid | high | 🟡 P1 |
| 6 | Multi-touch attribution | mid | high | 🟡 P1 |
| 13 | Anti-churn signal | mid | mid | 🟡 P1 |
| 1 | VK Donut | mid | mid | 🟠 P2 |
| 5 | Email warming | mid | low | 🟠 P2 |
| 12 | Referral leaderboard | mid | mid | 🟠 P2 |
| 4 | VK Pixel LookAlike | high | high | 🔴 P3 |
| 7 | Ya.Direct builder | high | mid | 🔴 P3 |
| 9 | VK Clips auto-cut | high | mid | 🔴 P3 |

---

## API контракт (endpoints)

Все под `requireAdmin` (Босс / super_admin). Никаких user PII в responses.

| Endpoint | Покрытие |
|---|---|
| `GET /api/admin/v304/orchestrator/edges` | Все edges + visualization graph |
| `GET /api/admin/v304/orchestrator/edges/:agentId` | Edges per agent (in/out) |
| `GET /api/admin/v304/marketing/stats` | Campaigns + calendar + perf totals |
| `GET /api/admin/v304/marketing/segments` | Список 10 segment types |
| `GET /api/admin/v304/marketing/campaigns` | Campaigns list (filter status/channel) |
| `POST /api/admin/v304/marketing/campaigns` | Create campaign |
| `GET /api/admin/v304/marketing/campaigns/:id` | Campaign details + variants |
| `POST /api/admin/v304/marketing/campaigns/:id/status` | Pause / resume / complete |
| `POST /api/admin/v304/marketing/campaigns/:id/metric` | Record metric (sent/opened/clicked/converted) |
| `GET /api/admin/v304/marketing/campaigns/:id/variant?userId=` | A/B split for user |
| `GET /api/admin/v304/marketing/calendar` | Scheduled posts |
| `POST /api/admin/v304/marketing/calendar` | Schedule post |
| `DELETE /api/admin/v304/marketing/calendar/:id` | Cancel scheduled |
| `GET /api/admin/v304/marketing/allocation?budget=N` | CAC/LTV-based budget split |
| `POST /api/admin/v304/marketing/trigger-event` | Manual fire event (testing) |

---

## Hooks wired in routes.ts

| Endpoint | Event emitted | Marketing handler |
|---|---|---|
| `POST /api/payment/result` (after `status='paid'`) | `payment.succeeded` | Thank-you campaign (email + web-chat) |
| `POST /api/payment/result` (после referral bonus) | `referral.bonus.given` | Social-proof campaign (VK+TG+landing, без PII) |
| `POST /api/admin/v304/generations/:id/playlist` (0→1/2) | `generation.published` | Broadcast в VK+TG |

Future hooks (TODO в plugins):
- generation completion in suno-watchdog → `generation.milestone` (5/10/25/50/100)
- cron `admin-overview` → `user.churned` (30+ дней)
- subscription expiration → `subscription.expired`
- user registration → `user.registered` (по channel)

---

## Связано с CLAUDE.md rules

- **Agent-orchestrator rule** — каждый agent register через `bootstrap`
- **Single-persona-across-channels rule** — marketing-orchestrator уважает persona consistency
- **Secrets-admin-only rule** — никаких PII в campaign payloads / endpoints
- **No-duplicates rule** — marketing-orchestrator не дублирует api-health / channel-watchdog
- **Pricing-single-source rule** — campaign offers ссылаются на actual PRICES, никаких hardcoded
- **Reuse-working-solutions rule** — campaigns используют existing channel endpoints, не свой pipeline
- **User-action-failure registry rule** — failed campaigns → log в user_action_failures (TODO для следующих итераций)
- **Musa-knowledge-governance rule** — клиент видит только свои треки, marketing tools не leak'ают чужих юзеров

---

## Code reference

- `apps/neurohub/server/lib/agentOrchestrator.ts` — singleton + edges + event emitter + `bootstrapDefaultAgents` + `registerDefaultEdges`
- `apps/neurohub/server/lib/marketingAgent.ts` — campaigns / segments / calendar / A/B / allocation / event handlers
- `apps/neurohub/server/routes.ts` — admin endpoints + hooks в payment/publish
- `apps/neurohub/client/src/pages/admin/orchestrator-tab.tsx` — 3 sub-tabs (Agents / Связи / Маркетинг)
