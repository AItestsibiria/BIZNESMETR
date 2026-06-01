# 06. PLUGIN-АРХИТЕКТУРА: КАК ЦЕПЛЯТЬ НОВЫЕ ХВОСТЫ К ЯДРУ  
  
## §0. ИДЕЯ И ПРИНЦИПЫ  
  
Ядро — **тонкое и стабильное**. Всё новое — **плагины**, которые подключаются по единому API.  
  
**Что значит «плагин»:**  
- Папка в `plugins/<name>/`.  
- Один экспорт `module.ts` → объект типа `Module`.  
- Свои миграции, маршруты, jobs, подписки на события.  
- Ставится/снимается без переписывания ядра.  
- Включается/выключается через `feature_flags` без релиза.  
  
**5 правил расширения:**  
1. **Никаких прямых правок ядра.** Хочешь новую логику — пиши плагин.  
2. **Общение через events**, не через прямые вызовы между плагинами.  
3. **Своя миграция, своя схема.** Плагин владеет своими таблицами.  
4. **Идемпотентность.** Любая операция плагина может быть выполнена дважды без вреда.  
5. **Откат без боли.** Удалил плагин — ядро продолжает работать.  
  
---  
  
## §1. MODULE API  
  
### §1.1 Тип  
  
```typescript  
// core/moduleRegistry.ts  
import type { Router } from 'express';  
  
export interface Module {  
  name: string;             // уникальное имя, например 'chatbot'  
  version: string;          // semver: '1.2.0'  
  description?: string;  
   
// Зависимости от других модулей. Если зависимость отключена — этот тоже не запустится.  
  dependencies?: string[];  // ['notifications', 'support']  
   
// Миграции, которые этот модуль вносит в БД.  
  migrations?: Migration[];  
   
// HTTP маршруты (опц.). Маунтятся в /api/<prefix>.  
  routes?: { prefix: string; router: Router };  
   
// Cron jobs.  
  jobs?: Job[];  
   
// Подписки на события из EventBus.  
  subscribes?: Record<string, EventHandler>;  
   
// Какие события плагин публикует (для документации).  
  publishes?: string[];  
   
// Lifecycle hooks.  
  onLoad?: (ctx: ModuleContext) => Promise<void>;  // при подключении  
  onUnload?: (ctx: ModuleContext) => Promise<void>;  // при отключении  
   
// Health check (опц.) — для мониторинга.  
  healthCheck?: () => Promise<HealthStatus>;  
   
// Конфигурация плагина (где он берёт env-переменные).  
  configSchema?: ZodSchema;  
}  
  
export interface Migration {  
  version: string;  // '001_initial.sql'  
  up: string;       // SQL  
  down?: string;    // SQL для отката (опц.)  
}  
  
export interface Job {  
  name: string;  
  schedule: 'startup' | 'every_minute' | 'every_hour' | 'every_day' | string;  // cron  
  handler: () => Promise<void>;  
}  
  
export type EventHandler = (event: BusEvent, ctx: ModuleContext) => Promise<void>;  
```  
  
### §1.2 Регистрация  
  
```typescript  
// server/index.ts (точка входа)  
import { ModuleRegistry } from './core/moduleRegistry.js';  
  
import authModule from './modules/auth/module.js';  
import billingModule from './modules/billing/module.js';  
// ... ядро ...  
  
import chatbotPlugin from './plugins/chatbot/module.js';  
import supportPlugin from './plugins/support/module.js';  
import invoicingPlugin from './plugins/invoicing/module.js';  
// ... плагины ...  
  
const registry = new ModuleRegistry();  
  
// Регистрируем (порядок не важен, registry разрулит зависимости)  
registry.register([  
  authModule, billingModule, /* ... */,  
  chatbotPlugin, supportPlugin, invoicingPlugin, /* ... */,  
]);  
  
// Запускаем  
await registry.start({  
  app,        // express app  
  db,         // drizzle db  
  eventBus,  
  scheduler,  
  logger,  
});  
```  
  
### §1.3 Внутри ModuleRegistry (упрощённо)  
  
```typescript  
class ModuleRegistry {  
  private modules: Module[] = [];  
   
register(modules: Module[]) { this.modules.push(...modules); }  
   
async start(ctx: BootContext) {  
    // 1. Сортировка по dependencies (топологическая)  
    const sorted = topoSort(this.modules);  
   
// 2. Для каждого модуля:  
    for (const m of sorted) {  
      if (!await this.isEnabled(m)) {  
        ctx.logger.info({ module: m.name }, 'отключен через feature flag');  
        continue;  
      }  
   
// 2a. Применить миграции  
      if (m.migrations) await this.runMigrations(m, ctx.db);  
   
// 2b. Подписаться на события  
      if (m.subscribes) {  
        for (const [event, handler] of Object.entries(m.subscribes)) {  
          ctx.eventBus.subscribe(event, m.name, handler);  
        }  
      }  
   
// 2c. Зарегистрировать маршруты  
      if (m.routes) {  
        ctx.app.use(`/api/${m.routes.prefix}`, m.routes.router);  
      }  
   
// 2d. Запустить jobs  
      if (m.jobs) {  
        for (const job of m.jobs) ctx.scheduler.add(job);  
      }  
   
// 2e. onLoad  
      if (m.onLoad) await m.onLoad({ db: ctx.db, eventBus: ctx.eventBus, logger: ctx.logger });  
   
// 2f. Записать в plugins_registry  
      await ctx.db.insert(plugins_registry).values({  
        name: m.name, version: m.version, status: 'active', loaded_at: new Date()  
      }).onConflictDoUpdate(/*...*/);  
   
ctx.logger.info({ module: m.name, version: m.version }, 'плагин активирован');  
    }  
  }  
   
async stop() {  
    for (const m of this.modules.reverse()) {  
      if (m.onUnload) await m.onUnload(/*ctx*/);  
    }  
  }  
}  
```  
  
### §1.4 Таблица реестра  
  
```sql  
CREATE TABLE plugins_registry (  
  name TEXT PRIMARY KEY,  
  version TEXT NOT NULL,  
  status TEXT CHECK(status IN ('active', 'disabled', 'failed')) DEFAULT 'active',  
  loaded_at TEXT,  
  last_error TEXT,  
  config TEXT  -- JSON, копия эффективной конфигурации  
);  
```  
  
Дашборд показывает: какие плагины активны, версии, последние ошибки.  
  
---  
  
## §2. EVENT BUS  
  
### §2.1 Простая реализация (in-process)  
  
```typescript  
// core/eventBus.ts  
type Handler = (event: BusEvent, ctx: ModuleContext) => Promise<void>;  
  
interface BusEvent {  
  id: string;  // uuid  
  name: string;  // 'user.registered', 'payment.succeeded', ...  
  payload: any;  
  timestamp: Date;  
  source: string;  // имя модуля-публикатора  
}  
  
export class EventBus {  
  private subs = new Map<string, Array<{ module: string; handler: Handler }>>();  
   
subscribe(eventName: string, module: string, handler: Handler) {  
    if (!this.subs.has(eventName)) this.subs.set(eventName, []);  
    this.subs.get(eventName)!.push({ module, handler });  
  }  
   
async emit(name: string, payload: any, source: string) {  
    const event: BusEvent = {  
      id: crypto.randomUUID(),  
      name, payload, source,  
      timestamp: new Date(),  
    };  
   
// 1. Записать в БД (events таблица — для аудита и репроса)  
    await db.insert(events).values({ ...event, payload: JSON.stringify(payload) });  
   
// 2. Доставить подписчикам параллельно (или sequentially, опц.)  
    const handlers = this.subs.get(name) || [];  
    await Promise.allSettled(handlers.map(({ module, handler }) =>  
      handler(event, { module }).catch(err =>   
logger.error({ event: name, module, err }, 'event handler failed')  
      )  
    ));  
   
// 3. Wildcard-подписки (для аналитики)  
    const wildcard = this.subs.get('*') || [];  
    await Promise.allSettled(wildcard.map(({ handler }) => handler(event, {})));  
  }  
}  
```  
  
### §2.2 Persisted events  
  
```sql  
CREATE TABLE events (  
  id TEXT PRIMARY KEY,  
  name TEXT NOT NULL,  
  payload TEXT,  -- JSON  
  source_module TEXT,  
  user_id INTEGER,  
  lead_id INTEGER,  
  occurred_at TEXT DEFAULT CURRENT_TIMESTAMP,  
  -- Метаданные доставки:  
  handlers_count INTEGER,  
  handlers_failed INTEGER  
);  
CREATE INDEX events_name_idx ON events(name, occurred_at);  
CREATE INDEX events_user_idx ON events(user_id);  
```  
  
**Зачем хранить:**  
1. Аудит — кто, когда, что сделал.  
2. Replay — пересчитать аналитику или агентов на старых данных.  
3. Аналитика воронки.  
4. Debug — увидеть всю цепочку событий по user_id.  
  
### §2.3 Стандартный каталог событий  
  
```  
auth.user.registered           { userId, email, source }  
auth.user.email_verified       { userId }  
auth.user.logged_in            { userId, ip, ua }  
auth.session.expired           { userId, sessionId }  
  
billing.charged                { userId, amount, kind, generationId }  
billing.refunded               { userId, amount, reason }  
billing.balance.low            { userId, balance, threshold }  
  
generation.started             { genId, userId, type, kind }  
generation.completed           { genId, userId, durationMs }  
generation.failed              { genId, userId, error }  
generation.played              { genId, userId, duration_played }  
generation.shared              { genId, userId, channel }  
  
payment.initiated              { paymentId, userId, amount, sku }  
payment.succeeded              { paymentId, userId, amount, sku }  
payment.failed                 { paymentId, userId, reason }  
payment.refunded               { paymentId, userId, amount }  
  
lead.captured                  { leadId, source, fingerprint }  
lead.scored                    { leadId, score, segment }  
lead.identified                { leadId, userId } # связали лид с регой  
  
chatbot.session.started        { sessionId, channel, userId? }  
chatbot.message.received       { sessionId, role, content }  
chatbot.escalated              { sessionId, ticketId, reason }  
  
support.ticket.created         { ticketId, userId, priority }  
support.ticket.replied         { ticketId, by }  
support.ticket.resolved        { ticketId, resolutionTime }  
  
invoice.created                { invoiceId, userId, amount, customerKind }  
invoice.paid                   { invoiceId, paymentId }  
invoice.overdue                { invoiceId }  
  
notification.queued            { notificationId, channel, template }  
notification.sent              { notificationId, channel }  
notification.delivered         { notificationId }  
notification.opened            { notificationId } # email tracking pixel  
notification.clicked           { notificationId, url }  
  
agent.action.executed          { agentName, actionKind, userId }  
agent.action.failed            { agentName, actionKind, error }  
```  
  
---  
  
## §3. HOOK POINTS В ЯДРЕ  
  
Иногда событий недостаточно — нужно **прерывать** flow. Для этого есть hook points.  
  
### §3.1 Реализация hook'а  
  
```typescript  
// core/hooks.ts  
type HookHandler<T> = (payload: T) => Promise<T | { halt: true; reason: string }>;  
  
class HookSystem {  
  private hooks = new Map<string, HookHandler<any>[]>();  
   
register(name: string, handler: HookHandler<any>) {  
    if (!this.hooks.has(name)) this.hooks.set(name, []);  
    this.hooks.get(name)!.push(handler);  
  }  
   
async run<T>(name: string, payload: T): Promise<T> {  
    const handlers = this.hooks.get(name) || [];  
    let current = payload;  
    for (const h of handlers) {  
      const result = await h(current);  
      if (result && typeof result === 'object' && 'halt' in result) {  
        throw new Error(`Hook ${name} halted: ${result.reason}`);  
      }  
      current = result;  
    }  
    return current;  
  }  
}  
```  
  
### §3.2 Используется так  
  
```typescript  
// modules/music/music.service.ts  
async function generate(userId: number, input: GenerateInput) {  
  // Plugin может перехватить и модифицировать input  
  input = await hooks.run('pre:generate', { userId, input });  
   
// ... основная логика ...  
  const gen = await db.insert(generations).values(...);  
   
// Plugin может реагировать на результат  
  await hooks.run('post:generate', { genId: gen.id, userId });  
   
return gen;  
}  
```  
  
### §3.3 Каталог hook points в ядре  
  
```  
pre:generate           { userId, input }              → can modify input or halt  
post:generate          { genId, userId }              → no return  
pre:payment            { userId, amount, sku }        → can apply promo or halt  
post:payment           { paymentId, userId }  
pre:user.register      { email, password, name }      → can validate or halt  
post:user.register     { userId }  
pre:streaming.serve    { genId, requesterId? }        → can deny access  
pre:notification.send  { template, vars }             → can modify template  
```  
  
### §3.4 Пример использования: плагин «промокоды»  
  
```typescript  
// plugins/promo/module.ts  
export const promoModule: Module = {  
  name: 'promo',  
  version: '1.0',  
  onLoad: async (ctx) => {  
    ctx.hooks.register('pre:payment', async (p) => {  
      const promoCode = p.input?.promoCode;  
      if (!promoCode) return p;  
      const code = await ctx.db.select().from(promo_codes).where(eq(code, promoCode)).get();  
      if (!code || code.used_count >= code.max_uses) {  
        return { halt: true, reason: 'Промокод недействителен' };  
      }  
      p.amount = applyDiscount(p.amount, code);  
      return p;  
    });  
  },  
};  
```  
  
Без правок ядра — добавили промокоды в payment flow.  
  
---  
  
## §4. FEATURE FLAGS  
  
### §4.1 Зачем  
  
- **Поэтапный rollout:** новый агент тестируется на 10% юзеров.  
- **Kill switch:** что-то пошло не так — отключаем за секунду.  
- **A/B-тесты:** одну версию paywall'а видит 50%, вторую — 50%.  
  
### §4.2 Таблица  
  
```sql  
CREATE TABLE feature_flags (  
  key TEXT PRIMARY KEY,  
  enabled INTEGER DEFAULT 0,  
  rollout_percent INTEGER DEFAULT 100,  -- 0-100  
  conditions TEXT,  -- JSON: { user_role, country, ... }  
  ab_variants TEXT,  -- JSON: [{ name, weight, payload }]  
  description TEXT,  
  updated_at TEXT  
);  
```  
  
### §4.3 API  
  
```typescript  
import { isEnabled, getVariant } from 'core/featureFlags';  
  
// Простая проверка  
if (await isEnabled('chatbot.web_widget', userId)) {  
  return <ChatWidget />;  
}  
  
// A/B-вариант  
const variant = await getVariant('paywall.layout', userId);  
if (variant.name === 'A') return <PaywallA />;  
if (variant.name === 'B') return <PaywallB />;  
```  
  
### §4.4 Дашборд  
  
В админке — таблица флагов с кнопками включения/% rollout, history изменений.  
  
---  
  
## §5. ПРИМЕР ПЛАГИНА ОТ А ДО Я  
  
Допустим, нужно добавить **«Аукцион Persona»**: пользователи могут продавать свои persona другим.  
  
### §5.1 Создаём папку  
  
```  
plugins/persona-marketplace/  
├── module.ts  
├── routes.ts  
├── service.ts  
├── repo.ts  
├── migrations/  
│   └── 001_initial.sql  
└── README.md  
```  
  
### §5.2 Миграция  
  
```sql  
-- 001_initial.sql  
CREATE TABLE persona_listings (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  persona_id TEXT NOT NULL,  
  seller_id INTEGER NOT NULL,  
  price_kopecks INTEGER NOT NULL,  
  status TEXT CHECK(status IN ('active', 'sold', 'cancelled')) DEFAULT 'active',  
  description TEXT,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE TABLE persona_purchases (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  listing_id INTEGER NOT NULL,  
  buyer_id INTEGER NOT NULL,  
  price_paid INTEGER NOT NULL,  
  payment_id INTEGER,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
```  
  
### §5.3 module.ts  
  
```typescript  
import { Module } from '../../core/moduleRegistry';  
import { router } from './routes';  
import migrations from './migrations';  
  
export default {  
  name: 'persona-marketplace',  
  version: '1.0.0',  
  dependencies: ['payments', 'notifications'],  
  migrations,  
  routes: { prefix: 'persona-market', router },  
   
subscribes: {  
    'payment.succeeded': async (event, ctx) => {  
      const { paymentId, sku } = event.payload;  
      if (sku?.startsWith('persona_')) {  
        await markListingSold(parseInt(sku.split('_')[1]), paymentId);  
        await emit('persona.purchased', { listingId, buyerId });  
      }  
    },  
  },  
   
publishes: ['persona.listed', 'persona.purchased'],  
   
onLoad: async (ctx) => {  
    ctx.logger.info('persona-marketplace activated');  
  },  
   
healthCheck: async () => {  
    const count = await db.select(count(*)).from(persona_listings).get();  
    return { status: 'ok', listings: count };  
  },  
} satisfies Module;  
```  
  
### §5.4 routes.ts  
  
```typescript  
import { Router } from 'express';  
import { requireAuth } from '../../middleware/auth.js';  
export const router = Router();  
  
router.post('/list', requireAuth, async (req, res) => {  
  // создать listing  
});  
router.get('/listings', async (req, res) => {  
  // лента  
});  
router.post('/buy/:listingId', requireAuth, async (req, res) => {  
  // payment flow → emit('payment.initiated')  
});  
```  
  
### §5.5 Регистрация  
  
В `server/index.ts`:  
```typescript  
import personaMarketplace from './plugins/persona-marketplace/module.js';  
registry.register([personaMarketplace]);  
```  
  
Готово. Плагин подключен, миграция применилась, маршруты доступны на `/api/persona-market/*`, события отслеживаются.  
  
**Если нужно отключить** — выставляем `feature_flag` `plugin.persona-marketplace = false` через админку.  
  
---  
  
## §6. ТЕСТИРОВАНИЕ ПЛАГИНОВ  
  
### §6.1 Изоляция  
  
Каждый плагин — отдельный модуль с тестами в `plugins/<name>/__tests__/`.  
  
```typescript  
// plugins/persona-marketplace/__tests__/listing.test.ts  
import { describe, test, expect } from 'vitest';  
import { createTestDb, createTestEventBus } from '../../../tests/helpers';  
import personaModule from '../module';  
  
describe('persona-marketplace', () => {  
  test('создаёт listing', async () => {  
    const ctx = await bootstrapModule(personaModule);  
    const result = await ctx.callRoute('POST', '/api/persona-market/list', {...});  
    expect(result.status).toBe(201);  
  });  
});  
```  
  
### §6.2 Integration тесты  
  
Проверяют связку нескольких плагинов:  
- регистрация → welcome email → demo генерация → платёж → invoice → реферальная ссылка.  
  
### §6.3 Smoke тесты в CI  
  
```bash  
npm run test:smoke   # 5-10 минут, проверяет основные пути  
npm run test:full    # 30+ минут, полный прогон  
```  
  
---  
  
## §7. БЕЗОПАСНОСТЬ ПЛАГИНОВ  
  
1. **Подпись плагинов:** в будущем — `plugin.json` с подписью, ядро отказывается грузить неподписанные. Для MVP — все плагины свои.  
2. **Permissions:** в будущем — manifest объявляет, какие capabilities нужны (read DB, send mail, call external API). MVP — все имеют полный доступ.  
3. **Sandboxing:** в Node.js полная изоляция дорогая. На MVP — code review при добавлении плагина.  
4. **Rate limiting:** плагин не может уронить ядро. Каждое подписанное событие выполняется с timeout 5 сек.  
  
---  
  
## §8. ROADMAP ВНЕДРЕНИЯ САМОЙ ПЛАГИННОЙ СИСТЕМЫ  
  
| Спринт | Что |  
|---|---|  
| 1 | Module API, ModuleRegistry, Migration auto-discovery |  
| 2 | EventBus + persisted events |  
| 3 | Hook points в ядре (`pre:generate`, `pre:payment`, ...) |  
| 4 | Feature flags + админ UI |  
| 5 | Перенос текущих модулей под Module API (рефакторинг ядра) |  
| 6 | Тестовая инфра для плагинов |  
| 7 | Документация + примеры |  
  
---  
  
## §9. КАК ЭТО СВЯЗАНО С ОСТАЛЬНЫМИ ФАЙЛАМИ  
  
| Файл | Использует |  
|---|---|  
| 02 (Suno) | Музыкальные провайдеры — это плагины (Suno, Mubert, Riffusion) |  
| 03 (Агенты) | Каждый агент — мини-плагин с подпиской на события |  
| 04 (Чат-бот) | `plugins/chatbot`, `plugins/support`, `plugins/invoicing`, `plugins/notifications`, `plugins/omnichannel` |  
| 05 (Соцсети) | `plugins/pixels`, `plugins/social-publish` |  
| 07 (Deploy) | One-command deploy умеет включать/выключать плагины через `.env` |  
  
---  
  
## §10. ЧТО ПЛАГИНАМИ **НЕЛЬЗЯ**  
  
1. **Менять схему ядра.** Только свои таблицы.  
2. **Прямо вызывать сервисы других плагинов.** Через events или published API.  
3. **Захватывать глобальный state.** Каждый плагин — самодостаточный.  
4. **Грузить тяжёлые библиотеки в bootstrap.** Lazy import.  
5. **Ставить блокирующие jobs > 100мс в синхронной части load.**  
  
---  
  
## СЛЕДУЮЩИЙ ФАЙЛ → `07-DEPLOY-ROADMAP-СХЕМА-БД.md`  