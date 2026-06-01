# 03. АГЕНТЫ + ДАШБОРД + CRM-ЛОГИКА  
  
## §0. ИДЕЯ  
  
В классической CRM (Salesforce, HubSpot, Bitrix) есть менеджер, который ведёт сделку через стадии. В MuziAI v304 каждой стадии соответствует **специализированный агент**. Они работают параллельно, общаются через Event Bus, под руководством мастера A1.  
  
Цель — превратить «прохожий → платящий клиент» из ручной воронки в **автоматизированный конвейер**.  
  
---  
  
## §1. ВОРОНКА И СТАДИИ  
  
```  
ANONYMOUS → LEAD → ACTIVATED → TRIED → PAID → REPEAT → CHAMPION  
посетитель  оставил   зареган     сделал  купил   купил   приводит  
            email/    без покупки демо    первое  2-й раз+ рефералов  
            telegram                       трек  
   ↑          ↑          ↑           ↑       ↑       ↑          ↑  
LeadHunter Welcome   Onboarding    Demo  Conversion Retention Referral  
ScoutAgent Agent      Agent        Agent  Agent      Agent     Agent  
                                                ↑  
                                          ContentAgent  
                                          (постоянно фоном)  
```  
  
| Стадия | % переходов (отрасль) | % сейчас (оценка MuziAI) | Цель v304 |  
|---|---|---|---|  
| Anon → Lead | 8–15% | \~3% | 12% |  
| Lead → Activated | 25–40% | \~15% | 35% |  
| Activated → Tried | 40–60% | \~30% | 55% |  
| Tried → Paid | 8–18% | \~12% | 20% |  
| Paid → Repeat | 25–40% | \~15% | 35% |  
| Repeat → Champion | 5–10% | \~2% | 8% |  
  
Если поднять каждую конверсию **на 50% от текущего**, итоговая воронка вырастет в **3.5x** при том же трафике.  
  
---  
  
## §2. АГЕНТЫ — СПЕЦИФИКАЦИИ  
  
Каждый агент описан по единому шаблону: **триггер → действие → output → метрики**.  
  
### §2.1 LeadHunter (на сайте, до регистрации)  
  
**Триггер:**  
- `pageview` на лендинге  
- `scroll > 60%`  
- `time_on_page > 30 sec`  
- `exit_intent` (мышь к крестику вкладки)  
- `idle > 60 sec`  
  
**Действие:**  
- Сохраняет анонимную сессию в `leads(fingerprint, utm_*, referrer, first_page, ip, geo)`.  
- Считает `lead_score` (см. §4) — 0..100.  
- При высоком score показывает **умный pop-up** с одним из CTA (на основе UTM):  
  - Из Telegram-канала → «ð Послушай 10 примеров песен бесплатно»  
  - Из VK-таргета «свадьбы» → «ð Песня для свадьбы за 5 минут — попробуй»  
  - Из Яндекса по «песня в подарок маме» → «ð 5 примеров песен ко дню рождения»  
  
**Output (events):**  
- `lead.captured` (с источником)  
- `popup.shown`, `popup.converted`  
  
**Метрики:** Anon → Lead %, time-to-lead, popup CTR.  
  
### §2.2 ScoutAgent (анализ источника)  
  
**Триггер:** событие `lead.captured`.  
  
**Действие:**  
- Парсит UTM, referrer, fbclid/yclid/vkclid.  
- Атрибутирует канал (organic / paid-vk / paid-yandex / telegram / direct / referral).  
- Записывает в `tracking_attribution`.  
- Определяет повод (если из объявления «свадьба» — ставит `intent: wedding`).  
  
**Output:** `lead.scored` (с тегами `intent`, `channel`, `quality`).  
  
### §2.3 WelcomeAgent (первое касание)  
  
**Триггер:** событие `user.registered` ИЛИ `lead.captured` с email.  
  
**Действие:**  
- Через 5 минут после регистрации — **welcome email** (если не залогинен дальше) с шаблоном по `intent`:  
  - intent=wedding → «5 идей свадебных песен + бесплатный трек»  
  - intent=birthday → «10 примеров поздравительных песен»  
  - generic → «Как создать первую песню за 2 минуты»  
- Через 1 час — **push/in-app notification** «Готовы начать?».  
- Через 24 часа без активности — **дожимающее письмо** с темой «ð Ваш бесплатный трек ждёт».  
  
**Output:** `email.sent`, `email.opened`, `email.clicked`, `email.converted`.  
  
**Метрики:** Lead → Activated %, email open rate, click-to-trial CTR.  
  
### §2.4 DemoAgent (первый трек = бесплатно)  
  
**Триггер:** пользователь заходит в форму генерации и **впервые** видит её.  
  
**Действие:**  
- В UI большой плашкой: «ð Первый трек бесплатно — попробуйте!»  
- Если intent определён, **предзаполняет** форму подходящим шаблоном (Свадьба → Pop ballad, Romantic, Female).  
- Бот в чате (если открыт) предлагает «провести вас за 5 шагов».  
  
**Output:** `demo.started`, `demo.submitted`, `demo.completed`.  
  
**Метрики:** Activated → Tried %, time-to-demo.  
  
### §2.5 OnboardingAgent (доводит до результата)  
  
**Триггер:** `demo.submitted` (генерация запущена).  
  
**Действие:**  
- Push при готовности (через PWA/email/Telegram).  
- Если генерация упала — автоматически предлагает **regenerate бесплатно**.  
- Если результат готов — pop-up «Слушайте! ð Скачать в высоком качестве?».  
- Через 5 минут после первого play — **карточка «Сделайте трек ещё лучше»** с кнопками `[Продлить за 149 ₽]` `[Сделать кавер]` `[Создать в том же стиле]`.  
  
**Output:** `onboarding.completed`, `upsell.shown`, `upsell.clicked`.  
  
**Метрики:** Tried → Paid %, time-to-paid, upsell CTR.  
  
### §2.6 ConversionAgent (paywall + offers)  
  
**Триггер:** `demo.completed` AND `user.balance < price`.  
  
**Действие:**  
- A/B-тест paywall'а (см. §6).  
- Динамическая цена: для пользователей из дорогого канала (Яндекс) — обычная, из дешёвого (organic) — могут быть промокоды.  
- Если пользователь ушёл со страницы оплаты — через 30 минут email «ð¥ Скидка 20% на ваш трек, действует 1 час».  
- Если 3 раза смотрел paywall и не купил — Telegram-сообщение от бота с поддержкой («что-то не так? могу помочь»).  
  
**Output:** `paywall.shown`, `payment.initiated`, `payment.succeeded`, `payment.abandoned`.  
  
### §2.7 ReferralAgent (партнёрки и виральность)  
  
**Триггер:** `user.payment.first_succeeded`.  
  
**Действие:**  
- В транзакционном письме с трекассылает **уникальную реферальную ссылку**: «ð Подари песню другу — он получит первый трек бесплатно, ты получишь 299 ₽ на счёт».  
- В UI после успешной генерации — **share-buttons** с предзаполненным текстом.  
- Виральные хуки: «Слушай, что я сделал на MuziAI! ðµ» + ссылка с UTM.  
  
**Output:** `referral.link_shared`, `referral.signup`, `referral.first_purchase`.  
  
### §2.8 RetentionAgent (re-engagement)  
  
**Триггер:** `user.last_active_days > 7` без покупки в этом месяце.  
  
**Действие:**  
- Email-кампании по сегментам (RFM, см. §5):  
  - **Champions** (R<7, F>5, M>3000): «Новая фича — Persona ID. Только для вас бесплатно 1 раз».  
  - **At Risk** (R 30-60, F>2, M>1000): «Соскучились? Вот промокод 30% на этот месяц».  
  - **Hibernating** (R>90): «Бесплатный трек, чтобы вернуться».  
- Telegram-уведомление: «Вы давно не были — у нас обновление, посмотрите».  
- Если пользователь не открыл 5 писем подряд — пометить `marketing_opt_in = false` (cooling).  
  
**Output:** `retention.campaign_sent`, `retention.reactivated`.  
  
### §2.9 ContentAgent (постоянная работа с лентой)  
  
**Триггер:** cron каждые 30 минут.  
  
**Действие:**  
- Обновляет агрегаты `gen_stats_daily`.  
- Перестраивает рекомендации в публичной ленте (см. §7 — алгоритм).  
- Помечает «trending», «new», «recommended for you».  
- Отправляет в админку анти-моды (треки с резко падающей сессией прослушивания, потенциально проблемные).  
  
**Output:** `feed.updated`.  
  
### §2.10 A1 (Master Controller)  
  
Не делает работы напрямую, но:  
- Следит за **конфликтами** (например, ConversionAgent хочет показать paywall, а OnboardingAgent — карточку «Сделайте лучше». Что приоритетнее? — A1 решает по правилам).  
- Имеет **kill switch** для каждого агента (через `feature_flags`).  
- Собирает метрики всех агентов → дашборд.  
- Запускает **эксперименты** (A/B): дробит трафик, считает конверсию, выбирает победителя.  
  
---  
  
## §3. АРХИТЕКТУРА АГЕНТОВ  
  
### §3.1 Agent API (плагинная модель)  
  
```typescript  
// agents/types.ts  
export interface Agent {  
  name: string;  
  version: string;  
  enabled: boolean; // через feature flag  
  triggers: AgentTrigger[];  
  handle: (ctx: AgentContext, event: Event) => Promise<AgentAction[]>;  
}  
  
export interface AgentTrigger {  
  on: string;  // имя события, например 'user.registered'  
  filter?: (event: Event) => boolean;  
  delaySec?: number;  // отложенный запуск  
}  
  
export interface AgentAction {  
  kind: 'send_email' | 'send_telegram' | 'show_popup' | 'send_push'  
      | 'apply_promo' | 'update_user' | 'emit_event' | 'create_ticket';  
  payload: any;  
  scheduledFor?: Date;  
}  
  
export interface AgentContext {  
  userId?: number;  
  leadId?: number;  
  user?: PublicUser;  
  emit: (event: string, payload: any) => void;  
  log: (level: string, msg: string, data?: any) => void;  
}  
```  
  
### §3.2 Регистрация агента  
  
```typescript  
// agents/welcomeAgent.ts  
import { Agent } from './types';  
  
export const welcomeAgent: Agent = {  
  name: 'welcome',  
  version: '1.0',  
  enabled: true,  
  triggers: [  
    { on: 'user.registered', delaySec: 300 },  
    { on: 'user.registered', delaySec: 3600 },  
    { on: 'user.registered', delaySec: 86400 },  
  ],  
  async handle(ctx, event) {  
    const user = await getUser(event.userId);  
    if (await user.last_login_after(event.timestamp)) return []; // уже зашёл  
    const intent = await getLeadIntent(user.lead_id);  
    return [{  
      kind: 'send_email',  
      payload: {  
        to: user.email,  
        template: `welcome.${intent || 'generic'}`,  
        vars: { name: user.name, demo_url: '...' },  
      },  
    }];  
  },  
};  
```  
  
### §3.3 Логирование действий агентов (audit trail)  
  
Таблица `agent_actions`:  
  
```sql  
CREATE TABLE agent_actions (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  agent_name TEXT NOT NULL,  
  trigger_event TEXT NOT NULL,  
  user_id INTEGER,  
  lead_id INTEGER,  
  action_kind TEXT NOT NULL,  
  action_payload TEXT, -- JSON  
  scheduled_for TEXT,  
  executed_at TEXT,  
  status TEXT CHECK(status IN ('pending', 'executed', 'failed', 'cancelled')),  
  result TEXT,  
  error TEXT,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX agent_actions_user_idx ON agent_actions(user_id);  
CREATE INDEX agent_actions_status_idx ON agent_actions(status, scheduled_for);  
```  
  
Дашборд показывает **что делает каждый агент в реальном времени** — это даёт прозрачность и позволяет отлаживать.  
  
---  
  
## §4. LEAD SCORING (0..100)  
  
Скор пересчитывается на каждом значимом событии. Веса хранятся в БД, можно крутить.  
  
| Сигнал | +Вес |  
|---|---|  
| Email верифицирован | +15 |  
| Зарегистрирован | +10 |  
| Указал имя | +3 |  
| Geolocation: РФ/СНГ (целевой рынок) | +5 |  
| Заходил 2+ дня | +10 |  
| Открыл /pricing | +12 |  
| Сделал demo (без покупки) | +20 |  
| Открыл письмо | +3 |  
| Кликнул в письме | +8 |  
| Из платного канала (paid VK/Yandex) | +10 |  
| Из telegram-партнёра | +15 |  
| Время на сайте > 5 мин | +8 |  
  
**Минусы:**  
- Email с дешёвой почтовой dom (mail.ru — нет, но guerrillamail.com — да): −20.  
- IP из VPN/Tor: −10.  
- 5+ ошибок в попытке регистрации: −15.  
  
**Бакеты:**  
- 0–30: cold → email-rassylka раз в неделю  
- 31–60: warm → активный onboarding  
- 61–80: hot → персональный подход, чат-бот предлагает помощь  
- 81–100: very hot → менеджер (или A1) пишет лично  
  
---  
  
## §5. RFM-СЕГМЕНТЫ (для Retention)  
  
Классическая схема: **R**ecency (давность), **F**requency (частота), **M**onetary (выручка).  
  
Каждый параметр оценивается по шкале 1–5 на основе процентилей.  
  
| Сегмент | R | F | M | Действие |  
|---|---|---|---|---|  
| Champions | 4-5 | 4-5 | 4-5 | новые фичи бесплатно, пригласить на закрытое тестирование |  
| Loyal customers | 3-5 | 4-5 | 3-5 | реферальная программа, скидки за объём |  
| Potential loyalists | 4-5 | 2-3 | 2-3 | купоны, кросс-сейл |  
| New customers | 5 | 1 | 1 | onboarding, обучающие письма |  
| Promising | 4-5 | 1 | 1 | мотивация к 2-й покупке |  
| Need attention | 3 | 3 | 3 | реактивация |  
| About to sleep | 2-3 | 1-2 | 1-2 | мотивирующие предложения |  
| At Risk | 1-2 | 4-5 | 4-5 | **СРОЧНО** скидка, личное письмо |  
| Can't lose them | 1-2 | 4-5 | 4-5 | звонок (если телефон есть) |  
| Hibernating | 1-2 | 1-2 | 1-2 | последний шанс — большой бонус |  
| Lost | 1 | 1 | 1 | архив, опционально опросник «почему ушли» |  
  
Сегменты пересчитываются ночью cron-job. Поля `rfm_recency`, `rfm_frequency`, `rfm_monetary` в `users`.  
  
---  
  
## §6. NEXT BEST ACTION (NBA)  
  
В CRM есть концепт NBA: для каждого пользователя в каждый момент рассчитывается «лучшее следующее действие».  
  
**Реализация:**  
  
```typescript  
// agents/nba.ts  
export async function getNextBestAction(userId: number): Promise<NBA | null> {  
  const user = await getUserWithContext(userId);  
  const candidates: NBAOption[] = [];  
  
  if (!user.email_verified) {  
    candidates.push({ kind: 'verify_email', priority: 100, reason: 'не подтвердил email' });  
  }  
  if (user.demo_count === 0 && user.created_at > daysAgo(7)) {  
    candidates.push({ kind: 'try_demo', priority: 90, reason: 'давай первый трек' });  
  }  
  if (user.demo_count > 0 && user.payments_count === 0) {  
    candidates.push({ kind: 'paywall_offer', priority: 80, reason: 'триал прошёл — пора платить' });  
  }  
  if (user.last_payment_days > 30 && user.rfm_segment === 'at_risk') {  
    candidates.push({ kind: 'discount_30', priority: 95, reason: 'AT RISK — большая скидка' });  
  }  
  if (user.referrals_count === 0 && user.payments_count > 0) {  
    candidates.push({ kind: 'invite_friend', priority: 60, reason: 'есть деньги — может звать' });  
  }  
  candidates.sort((a, b) => b.priority - a.priority);  
  return candidates[0] || null;  
}  
```  
  
NBA вызывается:  
- При каждом логине (для главной страницы — баннер).  
- При открытии чат-бота (бот сразу знает, что предлагать).  
- В админке (менеджер видит — что предложить пользователю).  
  
---  
  
## §7. РЕКОМЕНДАЦИИ В ПУБЛИЧНОЙ ЛЕНТЕ  
  
### §7.1 Алгоритм (упрощённый)  
  
Рейтинг трека = функция от:  
- `plays_24h` × 1.0  
- `plays_7d` × 0.5  
- `unique_listeners_7d` × 0.7  
- `completions_rate` (% дослушавших) × 1.2  
- `shares` × 2.0  
- `time_decay` (новые треки получают boost первые 48 часов) × 1.5  
  
```sql  
SELECT g.*,   
(s.plays_24h * 1.0 + s.plays_7d * 0.5 + s.unique_listeners_7d * 0.7  
   + s.completion_rate * 1.2 + s.shares * 2.0 +   
CASE WHEN g.created_at > datetime('now', '-2 days') THEN 1.5 ELSE 1.0 END  
  ) AS score  
FROM generations g  
JOIN gen_stats_daily s ON s.gen_id = g.id AND s.date = date('now')  
WHERE g.is_public = 1 AND g.deleted_at IS NULL AND g.status = 'done'  
ORDER BY score DESC LIMIT 50;  
```  
  
### §7.2 Персонализация ленты  
  
Если есть история пользователя (любимые жанры, голоса), ContentAgent добавляет boost для треков с похожими признаками. Простой коллабо-фильтр на эмбеддингах style-text — реализуется отдельно (выходит за рамки v304).  
  
---  
  
## §8. ДАШБОРД V304 (UX)  
  
### §8.1 Структура (8 виджетов)  
  
```  
┌─────────────────────────────────────────────────────────────┐  
│ [1] ВОРОНКА REAL-TIME                                       │  
│ Anon → Lead → Reg → Demo → Paid → Repeat                    │  
│ с трендом за 7/30 дней                                      │  
├──────────────────────────┬──────────────────────────────────┤  
│ [2] ВЫРУЧКА ПО SKU       │ [3] АГЕНТЫ — СТАТУС              │  
│ bar chart за 30 дней     │ 9 карточек: что работают,        │  
│ + GMV / refunds          │ сколько действий за день,        │  
│                          │ есть ли ошибки                   │  
├──────────────────────────┼──────────────────────────────────┤  
│ [4] LEADS HOT-LIST       │ [5] AGENT ACTIONS LIVE           │  
│ топ-20 lead score >70    │ лента действий (последние 100)   │  
│ с кнопкой [Connect]      │ фильтры: agent, user, kind       │  
│ → бот пишет сам          │                                  │  
├──────────────────────────┼──────────────────────────────────┤  
│ [6] RFM-ТЕПЛОВАЯ КАРТА   │ [7] КАНАЛЫ И АТРИБУЦИЯ           │  
│ 9 ячеек, кликабельные    │ pie + table: trafic source,      │  
│ → выбираешь сегмент,     │ cost, conversion, ROI            │  
│   запускаешь кампанию    │                                  │  
├──────────────────────────┴──────────────────────────────────┤  
│ [8] BUG COLLECTOR (топ ошибок)                              │  
│ как в v303, но интегрировано в дашборд                      │  
└─────────────────────────────────────────────────────────────┘  
```  
  
### §8.2 Виджет «Воронка real-time»  
  
```  
   Anon (1247)  
     ▼ 11.4% ↑ +2.1% за неделю  
   Lead (142)  
     ▼ 34.5% → стабильно  
   Reg (49)  
     ▼ 48.9% ↓ -3% (внимание!)  
   Demo (24)  
     ▼ 16.6% ↑ +4%  
   Paid (4)  
     ▼ 25% (за месяц)  
   Repeat (1)  
```  
  
Клик по любой стадии → таблица пользователей в этой стадии + что делает с ними агент.  
  
### §8.3 Виджет «Агенты»  
  
Каждая карточка:  
```  
┌───────────────────┐  
│ ð¤ WelcomeAgent  │  
│ ✅ enabled         │  
│ Last 24h: 48 acts │  
│ Success: 92%      │  
│ Errors: 4         │  
│ [Logs] [Settings] │  
└───────────────────┘  
```  
  
Клик → подробная страница агента: правила, A/B-тесты, метрики, история.  
  
### §8.4 Технология реализации  
  
- **Frontend:** React + Tailwind + recharts (как в v303).  
- **Real-time:** Server-Sent Events для воронки и agent-actions feed.  
- **Запросы:** GraphQL или REST с агрегатами (через `gen_stats_daily` + `agent_actions_summary`).  
- **Доступ:** только `role='admin'`. Для будущего — `role='manager'` с ограниченными правами.  
  
---  
  
## §9. ИНТЕГРАЦИЯ С ОСТАЛЬНЫМИ МОДУЛЯМИ  
  
### §9.1 Агенты ↔ Чат-бот (файл 04)  
  
Чат-бот может быть **руками агентов**:  
- WelcomeAgent отправляет приветствие → бот в Telegram.  
- DemoAgent предлагает «5 шагов» → бот ведёт диалог.  
- ConversionAgent видит застрявшего юзера → бот пишет «нужна помощь?».  
  
ConductorBot вызывает агентов через events: `chatbot.user_idle` → ConversionAgent просыпается.  
  
### §9.2 Агенты ↔ Соцсети (файл 05)  
  
ContentAgent публикует «трек дня» в VK / Telegram-канал. Authentication через VK API token (хранится в `.env`).  
  
ScoutAgent читает входящий трафик из социалок (UTM `vk_paid_*`, `tg_channel_*`) → знает источник лида.  
  
### §9.3 Агенты ↔ Поддержка (файл 04)  
  
OnboardingAgent видит, что юзер пытался сгенерировать 3 раза подряд и всё неудачно → автоматически создаёт **тикет** в support-system (`support_tickets`) c high priority.  
  
---  
  
## §10. ЭТАПЫ ВНЕДРЕНИЯ  
  
| Спринт | Что |  
|---|---|  
| 1 | Event Bus, таблицы `events`, `leads`, `agent_actions`. ScoutAgent и LeadHunter. |  
| 2 | WelcomeAgent (email-каналы — через notifications). Lead Scoring. |  
| 3 | DemoAgent + OnboardingAgent. NBA. |  
| 4 | ConversionAgent + ReferralAgent. A/B-тестов framework. |  
| 5 | RetentionAgent + RFM. ContentAgent (рекомендации). |  
| 6 | Дашборд v304 (8 виджетов). |  
| 7 | Связь с чат-ботом (файл 04) и соцсетями (файл 05). |  
| 8 | Полировка, оптимизация, документация. |  
  
---  
  
## §11. МЕТРИКИ УСПЕХА (что считать)  
  
| Метрика | Сейчас (оценка) | Цель v304 (3 мес.) |  
|---|---|---|  
| Anon → Lead | 3% | 12% |  
| Lead → Activated | 15% | 35% |  
| Activated → Tried | 30% | 55% |  
| Tried → Paid | 12% | 20% |  
| AOV (средний чек) | 299 ₽ | 450 ₽ (за счёт extend/persona/bundles) |  
| LTV (90 дней) | \~600 ₽ | \~1500 ₽ |  
| MRR (выручка) | x | x × 3.5 |  
| Retention 30 дней | \~10% | 30% |  
| NPS | не измеряется | начать измерять, цель 40+ |  
  
---  
  
## СЛЕДУЮЩИЙ ФАЙЛ → `04-ЧАТ-Б