# 07. DEPLOY + ROADMAP + СХЕМА БД  
  
## §0. О ЧЁМ ЭТОТ ФАЙЛ  
  
Три блока:  
1. **One-command deploy** для Perplexity / любого ассистента-исполнителя.  
2. **Объединённый roadmap** v303 → v304 (8 спринтов).  
3. **Полная схема БД** — все 20 новых таблиц + расширения существующих, единым DDL-скриптом.  
  
И в конце — **открытые вопросы** к Евгению, без ответов на которые нельзя стартовать.  
  
---  
  
## §1. ONE-COMMAND DEPLOY  
  
### §1.1 Идея  
  
Любой деплой / обновление / откат — **одна команда**, которую копирует Perplexity (или сам Евгений) в SSH-консоль VPS1.  
  
```bash  
curl -fsSL https://podaripesnu.ru/deploy/v304.sh | sudo bash -s -- --action=install  
```  
  
ð¨ **Важно:** перед выполнением на VPS1 (72.56.1.149) — действует пятиуровневое предупреждение из памяти. Скрипт ниже — это инструкция исполнителю, **не делать ничего автоматически без согласия Евгения**.  
  
### §1.2 Что делает скрипт  
  
```bash  
#!/usr/bin/env bash  
# deploy/v304.sh  
# One-command deploy MuziAI v304  
set -euo pipefail  
  
ACTION="${1:-install}"  # install | update | rollback | status  
RELEASE_DIR="/var/www/muziai"  
BACKUP_DIR="/var/backups/muziai"  
RELEASE_TAG="v304-$(date +%Y%m%d-%H%M%S)"  
  
log() { echo "[$(date '+%H:%M:%S')] $*"; }  
  
preflight() {  
  log "=== Pre-flight checks ==="  
  command -v node >/dev/null || { log "FAIL: Node.js не установлен"; exit 1; }  
  node -v | grep -qE 'v(20|22)' || { log "FAIL: Нужен Node 20+ или 22+"; exit 1; }  
  command -v pm2 >/dev/null || { log "FAIL: pm2 не установлен"; exit 1; }  
  command -v sqlite3 >/dev/null || { log "FAIL: sqlite3 не установлен"; exit 1; }  
  [[ -f "$RELEASE_DIR/.env" ]] || { log "FAIL: .env отсутствует"; exit 1; }  
  log "OK"  
}  
  
backup_db() {  
  log "=== Backup ==="  
  mkdir -p "$BACKUP_DIR"  
  sqlite3 "$RELEASE_DIR/data.db" ".backup $BACKUP_DIR/data-$RELEASE_TAG.db"  
  cp "$RELEASE_DIR/.env" "$BACKUP_DIR/env-$RELEASE_TAG"  
  log "Backup сохранён в $BACKUP_DIR/data-$RELEASE_TAG.db"  
}  
  
fetch_release() {  
  log "=== Fetch release ==="  
  cd /tmp  
  rm -rf muziai-release  
  # вариант 1: git  
  git clone --depth 1 --branch "$RELEASE_TAG" "$REPO_URL" muziai-release  
  # вариант 2: archive из Drive (если git недоступен)  
  # curl -fsSL "$ARCHIVE_URL" | tar xz -C /tmp/muziai-release  
}  
  
install_deps() {  
  log "=== Install dependencies ==="  
  cd /tmp/muziai-release  
  npm ci --only=production  
  npm run build  
}  
  
migrate_db() {  
  log "=== Migrate DB ==="  
  cd /tmp/muziai-release  
  node scripts/migrate.js up  
}  
  
swap_release() {  
  log "=== Swap release ==="  
  pm2 stop muziai || true  
  rsync -a --delete /tmp/muziai-release/ "$RELEASE_DIR/"  
  cp "$BACKUP_DIR/env-$RELEASE_TAG" "$RELEASE_DIR/.env"  
  cd "$RELEASE_DIR"  
  pm2 start ecosystem.config.cjs --env production  
  pm2 save  
}  
  
healthcheck() {  
  log "=== Health check ==="  
  sleep 5  
  for i in {1..10}; do  
    if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then  
      log "Health OK"  
      return 0  
    fi  
    sleep 2  
  done  
  log "FAIL: health check не прошёл"  
  return 1  
}  
  
rollback() {  
  log "=== ROLLBACK ==="  
  local last_backup=$(ls -t "$BACKUP_DIR"/data-*.db | head -n1)  
  pm2 stop muziai || true  
  cp "$last_backup" "$RELEASE_DIR/data.db"  
  # ... + откат файлов из BACKUP_DIR  
  pm2 restart muziai  
  log "Откат на $last_backup"  
}  
  
case "$ACTION" in  
  install|update)  
    preflight  
    backup_db  
    fetch_release  
    install_deps  
    migrate_db  
    swap_release  
    healthcheck || rollback  
    ;;  
  rollback) rollback ;;  
  status) pm2 status; sqlite3 "$RELEASE_DIR/data.db" "SELECT name,version FROM plugins_registry;" ;;  
esac  
```  
  
### §1.3 Что Perplexity делает руками  
  
1. Читает текущий статус: `ssh root@72.56.1.149 'pm2 status && cat /var/www/muziai/version.txt'`.  
2. Скачивает архив релиза из Drive: ID архива → подставляет в скрипт.  
3. **Спрашивает у Евгения подтверждение** (правило памяти).  
4. Выполняет `bash deploy/v304.sh install`.  
5. Проверяет `/api/health`, `/api/status`.  
6. Отчитывается.  
  
### §1.4 Структура deploy-пакета  
  
```  
deploy-package/  
├── DEPLOY.md                    # инструкция для Perplexity на русском  
├── v304.sh                      # сам скрипт  
├── ecosystem.config.cjs         # pm2 конфиг  
├── nginx.conf.template          # шаблон nginx (если меняется)  
├── .env.example                 # пример переменных окружения  
├── pre-flight-check.sh          # проверка готовности перед install  
└── checksums.txt                # md5 всех файлов релиза  
```  
  
### §1.5 DEPLOY.md (для Perplexity, на русском)  
  
```markdown  
# Деплой MuziAI v304 на VPS1 (72.56.1.149)  
  
## ⚠️ ВАЖНО  
1. Перед любыми действиями получи **явное подтверждение от Евгения**.  
2. VPS1 = MuziAI = podaripesnu.ru. Не путай с другими VPS.  
3. Если что-то пошло не так — `bash v304.sh rollback`.  
  
## Шаги  
  
1. Подтверди у Евгения: "Можно деплоить v304 на VPS1?"  
2. SSH: `ssh root@72.56.1.149`  
3. Скачай deploy-пакет: `cd /tmp && git clone <archive-url> deploy-pkg`  
4. Pre-flight: `bash deploy-pkg/pre-flight-check.sh`  
5. Если всё OK — `bash deploy-pkg/v304.sh install`  
6. Дождись сообщения "Health OK"  
7. Открой https://podaripesnu.ru/api/health — должно быть `{"status":"ok"}`  
8. Отчитайся Евгению: версия, время деплоя, статус.  
  
## Откат  
  
`bash /var/www/muziai/v304.sh rollback`  
  
## После деплоя  
  
1. Проверить, что новые плагины активны:  
   `sqlite3 data.db "SELECT * FROM plugins_registry;"`  
2. Проверить feature_flags:  
   `sqlite3 data.db "SELECT * FROM feature_flags WHERE enabled=0;"`  
3. Прогнать smoke-tests (см. v304/tests/smoke.sh).  
```  
  
### §1.6 .env.example (для v304)  
  
```bash  
# === ЯДРО ===  
NODE_ENV=production  
PORT=3000  
DATABASE_URL=file:./data.db  
SESSION_SECRET=<32-byte-random>  
SIGNED_URL_SECRET=<32-byte-random>  
COOKIE_DOMAIN=podaripesnu.ru  
TRUST_PROXY=true  
  
# === Suno via GPTunnel ===  
GPTUNNEL_API_KEY=<...>  
GPTUNNEL_BASE_URL=https://gptunnel.ru/api  
SUNO_DEFAULT_MODEL=v4.5  
SUNO_MAX_CONCURRENT=5  
  
# === Robokassa ===  
ROBOKASSA_LOGIN=<...>  
ROBOKASSA_PASSWORD_1=<...>  
ROBOKASSA_PASSWORD_2=<...>  
ROBOKASSA_TEST_MODE=0  
  
# === SMTP (notifications) ===  
SMTP_HOST=smtp.yandex.ru  
SMTP_PORT=465  
SMTP_USER=noreply@podaripesnu.ru  
SMTP_PASS=<...>  
SMTP_FROM="MuziAI <noreply@podaripesnu.ru>"  
  
# === IMAP (входящие письма для поддержки) ===  
IMAP_HOST=imap.yandex.ru  
IMAP_PORT=993  
IMAP_USER=support@podaripesnu.ru  
IMAP_PASS=<...>  
IMAP_POLL_INTERVAL_SEC=300  
  
# === Telegram-бот ===  
TELEGRAM_BOT_TOKEN=<...>  
TELEGRAM_WEBHOOK_SECRET=<random>  
TELEGRAM_CHANNEL_ID=@MuziAI  
  
# === VK ===  
VK_GROUP_ID=<...>  
VK_ACCESS_TOKEN=<...>  
VK_CONFIRMATION_CODE=<...>  
VK_SECRET=<...>  
  
# === Pixels ===  
YM_COUNTER_ID=<...>  
VK_PIXEL_ID=<...>  
MAILRU_PIXEL_ID=<...>  
  
# === LLM для бота (через GPTunnel) ===  
LLM_PROVIDER=gptunnel  
LLM_MODEL=claude-sonnet-4-5  
LLM_MAX_TOKENS=2000  
  
# === Админ ===  
INITIAL_ADMIN_EMAIL=admin@podaripesnu.ru  
INITIAL_ADMIN_PASSWORD=<min-12-chars>  # удалить после первого старта!  
  
# === Логи ===  
LOG_LEVEL=info  
LOG_DIR=/var/log/muziai  
  
# === Feature flags (override) ===  
FF_CHATBOT_ENABLED=1  
FF_AGENTS_ENABLED=1  
FF_PIXELS_SERVERSIDE=1  
FF_AUTO_PUBLISH_VK=0    # пока вручную одобряем  
```  
  
---  
  
## §2. ОБЪЕДИНЁННЫЙ ROADMAP (8 СПРИНТОВ)  
  
Один спринт ≈ 1 неделя. Если работа идёт силами одного разработчика, спринты можно растянуть до 2 недель.  
  
### Спринт 1 — Фундамент (исправления + plugin-фундамент)  
  
**Цели:** закрыть критические баги ядра, заложить инфраструктуру для всего остального.  
  
- [ ] Исправить **№1, №3, №7** (см. файл 01)  
- [ ] Создать `EventBus` (in-process) и таблицу `events`  
- [ ] Создать `ModuleRegistry` и таблицу `plugins_registry`  
- [ ] Создать `feature_flags` таблицу + simple admin UI  
- [ ] Завести `leads` таблицу  
- [ ] Завести `agent_actions` таблицу  
- [ ] Поставить **Yandex Метрика + VK Pixel** (5 базовых событий)  
- [ ] UTM tracker на клиенте + `tracking_attribution` таблица  
  
**DoD:** деплой на staging, базовые события приходят в Метрику, EventBus работает.  
  
### Спринт 2 — Suno на 100% (рост качества и AOV)  
  
- [ ] Структурные теги в lyrics + UI с подсветкой  
- [ ] Tempo / Mood / Key — отдельные поля + UI  
- [ ] Negative prompts  
- [ ] 10 шаблонов (свадьба, ДР и т.д.) + админ-редактор  
- [ ] Расширение `generations` (persona_id, structural_tags, vocal_weights, source_gen_id, suno_model, duration_seconds, bpm, music_key)  
  
**DoD:** конверсия prompt→результат улучшилась, юзеры реже жалуются «не то получилось».  
  
### Спринт 3 — Persona, Extend, Cover (новые SKU)  
  
- [ ] Persona ID — UI «Мой голос», создание из существующего трека  
- [ ] Таблица `personas`  
- [ ] Extend (продление трека) — endpoint + UI  
- [ ] Cover (перепеть) — endpoint + UI с upload mp3  
- [ ] Таблица `gen_extensions`  
- [ ] Новый pricing с 11 SKU  
- [ ] Bundles: Series of 5, Wedding bundle  
  
**DoD:** AOV вырос в среднем на 30%.  
  
### Спринт 4 — Агенты часть 1: Lead → Demo  
  
- [ ] LeadHunter (popup-логика на клиенте по UTM/intent/exit)  
- [ ] ScoutAgent (атрибуция, парсинг UTM)  
- [ ] WelcomeAgent (3 email через notifications)  
- [ ] DemoAgent (бесплатная первая генерация)  
- [ ] Lead Scoring 0..100  
- [ ] Plugin `notifications` v1 (email через SMTP, шаблоны)  
  
**DoD:** воронка Anon→Lead→Reg→Demo измерима в дашборде.  
  
### Спринт 5 — Агенты часть 2: Demo → Paid → Repeat  
  
- [ ] OnboardingAgent (помощь, regenerate, upsell-карточки)  
- [ ] ConversionAgent (paywall A/B, скидки, dunning)  
- [ ] ReferralAgent (правильное начисление при первой покупке, не при регистрации)  
- [ ] RetentionAgent + RFM-сегментация  
- [ ] ContentAgent (агрегаты `gen_stats_daily`, рекомендации)  
- [ ] A1 Master Controller  
  
**DoD:** все 9 агентов в работе, audit trail в `agent_actions`.  
  
### Спринт 6 — Чат-бот (продажи + поддержка + биллинг)  
  
- [ ] Plugin `chatbot` core: `ConductorBot` + tools API  
- [ ] Web-widget на сайте  
- [ ] Telegram-канал (webhook + /start linking)  
- [ ] Plugin `support` (тикеты + admin UI)  
- [ ] Plugin `omnichannel`: email IMAP polling, парсер писем  
- [ ] Plugin `invoicing`: PDF-генерация счетов и актов для юрлиц  
- [ ] Knowledge base (FTS5)  
  
**DoD:** юзер может из чата сделать заказ, получить счёт, открыть тикет.  
  
### Спринт 7 — Дашборд и реклама  
  
- [ ] Дашборд v304 с 8 виджетами (см. файл 03 §8)  
- [ ] Server-side tracking + VK Conversions API  
- [ ] Plugin `pixels` v2 + worker для отложенных событий  
- [ ] Аудитории (cron sync to VK)  
- [ ] ROI dashboard  
- [ ] Plugin `social-publish` (автопостинг VK + Telegram-канал, через ContentAgent)  
  
**DoD:** реклама в VK Ads запущена, ROI виден в дашборде.  
  
### Спринт 8 — Полировка, оптимизация, документация  
  
- [ ] Все производительные правки (`gen_stats_daily` materialized, indexы)  
- [ ] CSRF middleware  
- [ ] Path traversal защита в streaming  
- [ ] Logger redaction (чтобы пароли не попадали в логи)  
- [ ] Quality auto-check для треков  
- [ ] Модерация контента  
- [ ] Документация для разработчиков  
- [ ] Smoke tests + Integration tests  
- [ ] WhatsApp канал (опционально)  
  
**DoD:** v304 production-ready, нагрузочные тесты пройдены, безопасность проверена.  
  
---  
  
## §3. ПОЛНАЯ СХЕМА БД (DDL ОДНИМ ФАЙЛОМ)  
  
> Все миграции применяются скриптом `node scripts/migrate.js up`. Каждый плагин владеет своей секцией.  
  
```sql  
-- ========================================  
-- 1. CORE: расширения существующих таблиц  
-- ========================================  
  
ALTER TABLE users ADD COLUMN lead_id INTEGER;  
ALTER TABLE users ADD COLUMN lifecycle_stage TEXT  
  CHECK(lifecycle_stage IN ('anon','lead','activated','tried','paid','repeat','champion','churned'))  
  DEFAULT 'lead';  
ALTER TABLE users ADD COLUMN lead_score INTEGER DEFAULT 0;  
ALTER TABLE users ADD COLUMN rfm_recency INTEGER;  
ALTER TABLE users ADD COLUMN rfm_frequency INTEGER;  
ALTER TABLE users ADD COLUMN rfm_monetary INTEGER;  
ALTER TABLE users ADD COLUMN ban_reason TEXT;  
ALTER TABLE users ADD COLUMN marketing_opt_in INTEGER DEFAULT 0;  
ALTER TABLE users ADD COLUMN telegram_chat_id TEXT;  
ALTER TABLE users ADD COLUMN vk_user_id TEXT;  
ALTER TABLE users ADD COLUMN phone TEXT;  
ALTER TABLE users ADD COLUMN email_verified_at TEXT;  
ALTER TABLE users ADD COLUMN allow_repost INTEGER DEFAULT 0;  
CREATE INDEX users_lead_idx ON users(lead_id);  
CREATE INDEX users_lifecycle_idx ON users(lifecycle_stage);  
CREATE INDEX users_rfm_idx ON users(rfm_recency, rfm_frequency, rfm_monetary);  
CREATE INDEX users_telegram_idx ON users(telegram_chat_id);  
  
ALTER TABLE generations ADD COLUMN persona_id TEXT;  
ALTER TABLE generations ADD COLUMN structural_tags TEXT;     -- JSON  
ALTER TABLE generations ADD COLUMN vocal_weights TEXT;       -- JSON  
ALTER TABLE generations ADD COLUMN source_gen_id INTEGER;  
ALTER TABLE generations ADD COLUMN suno_model TEXT DEFAULT 'v4.5';  
ALTER TABLE generations ADD COLUMN duration_seconds INTEGER;  
ALTER TABLE generations ADD COLUMN bpm INTEGER;  
ALTER TABLE generations ADD COLUMN music_key TEXT;  
CREATE INDEX gen_persona_idx ON generations(persona_id);  
CREATE INDEX gen_source_idx ON generations(source_gen_id);  
  
ALTER TABLE payments ADD COLUMN invoice_id INTEGER;  
ALTER TABLE payments ADD COLUMN receipt_url TEXT;  
ALTER TABLE payments ADD COLUMN attribution_id INTEGER;  
  
-- ========================================  
-- 2. EVENTS — единая шина (core)  
-- ========================================  
CREATE TABLE events (  
  id TEXT PRIMARY KEY,  
  name TEXT NOT NULL,  
  payload TEXT,  
  source_module TEXT,  
  user_id INTEGER,  
  lead_id INTEGER,  
  occurred_at TEXT DEFAULT CURRENT_TIMESTAMP,  
  handlers_count INTEGER,  
  handlers_failed INTEGER  
);  
CREATE INDEX events_name_idx ON events(name, occurred_at);  
CREATE INDEX events_user_idx ON events(user_id);  
CREATE INDEX events_occurred_idx ON events(occurred_at);  
  
-- ========================================  
-- 3. PLUGINS REGISTRY — реестр модулей  
-- ========================================  
CREATE TABLE plugins_registry (  
  name TEXT PRIMARY KEY,  
  version TEXT NOT NULL,  
  status TEXT CHECK(status IN ('active','disabled','failed')) DEFAULT 'active',  
  loaded_at TEXT,  
  last_error TEXT,  
  config TEXT  
);  
  
CREATE TABLE feature_flags (  
  key TEXT PRIMARY KEY,  
  enabled INTEGER DEFAULT 0,  
  rollout_percent INTEGER DEFAULT 100,  
  conditions TEXT,  
  ab_variants TEXT,  
  description TEXT,  
  updated_at TEXT  
);  
  
-- ========================================  
-- 4. LEADS — анонимные посетители  
-- ========================================  
CREATE TABLE leads (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  fingerprint TEXT UNIQUE,  
  email TEXT,  
  phone TEXT,  
  telegram_chat_id TEXT,  
  vk_user_id TEXT,  
  intent TEXT,  
  score INTEGER DEFAULT 0,  
  segment TEXT,  
  status TEXT CHECK(status IN ('new','engaged','converted','dead')) DEFAULT 'new',  
  first_seen TEXT DEFAULT CURRENT_TIMESTAMP,  
  last_seen TEXT DEFAULT CURRENT_TIMESTAMP,  
  user_id INTEGER  
);  
CREATE INDEX leads_fingerprint_idx ON leads(fingerprint);  
CREATE INDEX leads_email_idx ON leads(email);  
CREATE INDEX leads_score_idx ON leads(score DESC);  
  
-- ========================================  
-- 5. AGENT ACTIONS — что сделал агент  
-- ========================================  
CREATE TABLE agent_actions (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  agent_name TEXT NOT NULL,  
  trigger_event TEXT NOT NULL,  
  user_id INTEGER,  
  lead_id INTEGER,  
  action_kind TEXT NOT NULL,  
  action_payload TEXT,  
  scheduled_for TEXT,  
  executed_at TEXT,  
  status TEXT CHECK(status IN ('pending','executed','failed','cancelled')) DEFAULT 'pending',  
  result TEXT,  
  error TEXT,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX agent_actions_user_idx ON agent_actions(user_id);  
CREATE INDEX agent_actions_status_idx ON agent_actions(status, scheduled_for);  
CREATE INDEX agent_actions_agent_idx ON agent_actions(agent_name, created_at);  
  
-- ========================================  
-- 6. SUPPORT — тикеты  
-- ========================================  
CREATE TABLE support_tickets (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  number TEXT UNIQUE NOT NULL,  
  user_id INTEGER,  
  email TEXT,  
  subject TEXT NOT NULL,  
  status TEXT CHECK(status IN ('open','pending_user','pending_admin','resolved','closed')) DEFAULT 'open',  
  priority TEXT CHECK(priority IN ('low','normal','high','urgent')) DEFAULT 'normal',  
  category TEXT,  
  assignee TEXT,  
  source TEXT,  
  source_session_id INTEGER,  
  related_gen_id INTEGER,  
  related_payment_id INTEGER,  
  first_response_at TEXT,  
  resolved_at TEXT,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,  
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX tickets_status_idx ON support_tickets(status, priority);  
CREATE INDEX tickets_user_idx ON support_tickets(user_id);  
  
CREATE TABLE ticket_messages (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  ticket_id INTEGER NOT NULL,  
  author_kind TEXT CHECK(author_kind IN ('user','admin','bot')) NOT NULL,  
  author_id INTEGER,  
  body TEXT NOT NULL,  
  attachments TEXT,  
  internal INTEGER DEFAULT 0,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX ticket_messages_ticket_idx ON ticket_messages(ticket_id, id);  
  
-- ========================================  
-- 7. CHATBOT — сессии и сообщения  
-- ========================================  
CREATE TABLE chatbot_sessions (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  channel TEXT NOT NULL CHECK(channel IN ('web','telegram','vk','email','whatsapp')),  
  channel_id TEXT NOT NULL,  
  user_id INTEGER,  
  lead_id INTEGER,  
  status TEXT CHECK(status IN ('active','closed','human')) DEFAULT 'active',  
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,  
  last_activity TEXT DEFAULT CURRENT_TIMESTAMP,  
  metadata TEXT  
);  
CREATE INDEX chatbot_sessions_channel_idx ON chatbot_sessions(channel, channel_id);  
CREATE INDEX chatbot_sessions_user_idx ON chatbot_sessions(user_id);  
  
CREATE TABLE chatbot_messages (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  session_id INTEGER NOT NULL,  
  role TEXT CHECK(role IN ('user','assistant','tool','system')) NOT NULL,  
  content TEXT NOT NULL,  
  tool_calls TEXT,  
  tool_results TEXT,  
  tokens_in INTEGER,  
  tokens_out INTEGER,  
  latency_ms INTEGER,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX chatbot_messages_session_idx ON chatbot_messages(session_id, id);  
  
CREATE TABLE chatbot_prompts (  
  slug TEXT PRIMARY KEY,  
  name TEXT NOT NULL,  
  system_prompt TEXT NOT NULL,  
  tools_enabled TEXT,  
  model TEXT DEFAULT 'claude-sonnet-4-5',  
  active INTEGER DEFAULT 1,  
  updated_at TEXT  
);  
  
CREATE TABLE faq_articles (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  question TEXT NOT NULL,  
  answer TEXT NOT NULL,  
  tags TEXT,  
  active INTEGER DEFAULT 1,  
  views INTEGER DEFAULT 0,  
  updated_at TEXT  
);  
CREATE VIRTUAL TABLE faq_fts USING fts5(question, answer, tags, content=faq_articles, content_rowid=id);  
  
-- ========================================  
-- 8. INVOICING — счета и закрывающие  
-- ========================================  
CREATE TABLE invoices (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  number TEXT UNIQUE NOT NULL,  
  user_id INTEGER,  
  customer_kind TEXT CHECK(customer_kind IN ('physical','legal','self_employed')) NOT NULL,  
  customer_name TEXT NOT NULL,  
  customer_inn TEXT,  
  customer_kpp TEXT,  
  customer_address TEXT,  
  customer_email TEXT,  
  customer_phone TEXT,  
  amount_kopecks INTEGER NOT NULL,  
  vat_kopecks INTEGER DEFAULT 0,  
  currency TEXT DEFAULT 'RUB',  
  payment_id INTEGER,  
  generation_ids TEXT,  
  pdf_url TEXT,  
  contract_pdf_url TEXT,  
  act_pdf_url TEXT,  
  receipt_pdf_url TEXT,  
  status TEXT CHECK(status IN ('draft','sent','paid','overdue','cancelled')) DEFAULT 'draft',  
  due_date TEXT,  
  paid_at TEXT,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX invoices_user_idx ON invoices(user_id);  
CREATE INDEX invoices_status_idx ON invoices(status);  
  
CREATE TABLE documents (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  kind TEXT CHECK(kind IN ('offer','privacy','contract','act','invoice','receipt','other')) NOT NULL,  
  user_id INTEGER,  
  invoice_id INTEGER,  
  title TEXT NOT NULL,  
  pdf_url TEXT NOT NULL,  
  metadata TEXT,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX docs_user_idx ON documents(user_id);  
CREATE INDEX docs_invoice_idx ON documents(invoice_id);  
  
-- ========================================  
-- 9. EMAIL HUB  
-- ========================================  
CREATE TABLE email_outbox (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  to_address TEXT NOT NULL,  
  subject TEXT NOT NULL,  
  body_html TEXT,  
  body_text TEXT,  
  template_slug TEXT,  
  attachments TEXT,  
  status TEXT CHECK(status IN ('queued','sending','sent','failed','bounced')) DEFAULT 'queued',  
  error TEXT,  
  attempts INTEGER DEFAULT 0,  
  scheduled_for TEXT,  
  sent_at TEXT,  
  message_id TEXT,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX outbox_status_idx ON email_outbox(status, scheduled_for);  
  
CREATE TABLE email_inbox (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  from_address TEXT NOT NULL,  
  to_address TEXT NOT NULL,  
  subject TEXT,  
  body_text TEXT,  
  body_html TEXT,  
  message_id TEXT UNIQUE,  
  in_reply_to TEXT,  
  references_chain TEXT,  
  attachments TEXT,  
  parsed_user_id INTEGER,  
  parsed_ticket_id INTEGER,  
  parsed_session_id INTEGER,  
  received_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX inbox_from_idx ON email_inbox(from_address);  
CREATE INDEX inbox_message_id_idx ON email_inbox(message_id);  
  
-- ========================================  
-- 10. NOTIFICATIONS HUB  
-- ========================================  
CREATE TABLE notification_templates (  
  slug TEXT PRIMARY KEY,  
  name TEXT NOT NULL,  
  subject_template TEXT,  
  body_template TEXT NOT NULL,  
  channels TEXT NOT NULL,  
  enabled INTEGER DEFAULT 1,  
  ab_variants TEXT,  
  updated_at TEXT  
);  
  
CREATE TABLE notifications (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  user_id INTEGER,  
  channel TEXT NOT NULL,  
  template_slug TEXT,  
  to_address TEXT,  
  subject TEXT,  
  body TEXT,  
  status TEXT CHECK(status IN ('queued','sending','sent','failed','bounced')) DEFAULT 'queued',  
  error TEXT,  
  attempts INTEGER DEFAULT 0,  
  scheduled_for TEXT,  
  sent_at TEXT,  
  opened_at TEXT,  
  clicked_at TEXT,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX notifications_status_idx ON notifications(status, scheduled_for);  
CREATE INDEX notifications_user_idx ON notifications(user_id);  
  
-- ========================================  
-- 11. PIXELS — server-side tracking  
-- ========================================  
CREATE TABLE pixel_configs (  
  slug TEXT PRIMARY KEY,  
  enabled INTEGER DEFAULT 1,  
  config TEXT NOT NULL,  
  notes TEXT,  
  updated_at TEXT  
);  
  
CREATE TABLE pixel_events (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  user_id INTEGER,  
  lead_id INTEGER,  
  event_name TEXT NOT NULL,  
  params TEXT,  
  client_event_id TEXT UNIQUE,  
  vk_status TEXT CHECK(vk_status IN ('queued','sent','failed','skipped')) DEFAULT 'queued',  
  ym_status TEXT CHECK(ym_status IN ('queued','sent','failed','skipped')) DEFAULT 'queued',  
  vk_error TEXT, ym_error TEXT,  
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,  
  yclid TEXT, vk_clickid TEXT, fbclid TEXT,  
  ip TEXT, ua TEXT, page_url TEXT,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX pe_status_idx ON pixel_events(vk_status, ym_status, created_at);  
  
CREATE TABLE tracking_attribution (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  user_id INTEGER,  
  lead_id INTEGER,  
  first_utm_source TEXT, first_utm_medium TEXT, first_utm_campaign TEXT, first_utm_content TEXT,  
  first_referer TEXT, first_landing_page TEXT, first_seen_at TEXT,  
  last_utm_source TEXT, last_utm_medium TEXT, last_utm_campaign TEXT, last_utm_content TEXT,  
  last_seen_at TEXT,  
  yandex_yclid TEXT, vk_clickid TEXT, google_gclid TEXT, meta_fbclid TEXT,  
  country TEXT, city TEXT, ip TEXT, device TEXT, browser TEXT, os TEXT  
);  
CREATE INDEX attribution_user_idx ON tracking_attribution(user_id);  
CREATE INDEX attribution_lead_idx ON tracking_attribution(lead_id);  
  
CREATE TABLE audience_segments (  
  slug TEXT PRIMARY KEY,  
  name TEXT NOT NULL,  
  description TEXT,  
  query_sql TEXT NOT NULL,  
  user_ids_cache TEXT,  
  last_synced_vk TEXT,  
  last_synced_mailru TEXT,  
  size INTEGER,  
  updated_at TEXT  
);  
  
CREATE TABLE marketing_spend (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  channel TEXT NOT NULL,  
  campaign TEXT,  
  date TEXT NOT NULL,  
  amount_kopecks INTEGER NOT NULL,  
  notes TEXT,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX spend_channel_date_idx ON marketing_spend(channel, date);  
  
-- ========================================  
-- 12. SUNO — расширенные возможности  
-- ========================================  
CREATE TABLE personas (  
  id TEXT PRIMARY KEY,  
  user_id INTEGER NOT NULL,  
  display_name TEXT NOT NULL,  
  description TEXT,  
  source_gen_id INTEGER NOT NULL,  
  use_count INTEGER DEFAULT 0,  
  is_public INTEGER DEFAULT 0,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX personas_user_idx ON personas(user_id);  
  
CREATE TABLE gen_extensions (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  source_gen_id INTEGER NOT NULL,  
  result_gen_id INTEGER NOT NULL,  
  kind TEXT CHECK(kind IN ('extend','cover','inpaint','stems')),  
  cost INTEGER NOT NULL,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
  
CREATE TABLE gen_templates (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  slug TEXT UNIQUE NOT NULL,  
  name TEXT NOT NULL,  
  category TEXT,  
  prompt_template TEXT,  
  style_json TEXT,  
  recommended_lyrics_structure TEXT,  
  popularity INTEGER DEFAULT 0,  
  active INTEGER DEFAULT 1,  
  updated_at TEXT  
);  
  
CREATE TABLE pricing (  
  sku TEXT PRIMARY KEY,  
  name TEXT NOT NULL,  
  description TEXT,  
  price_kopecks INTEGER NOT NULL,  
  active INTEGER DEFAULT 1,  
  ab_variant TEXT,  
  updated_at TEXT  
);  
  
-- ========================================  
-- 13. CONTENT — агрегаты для ленты  
-- ========================================  
CREATE TABLE gen_stats_daily (  
  gen_id INTEGER NOT NULL,  
  date TEXT NOT NULL,  
  plays INTEGER DEFAULT 0,  
  unique_listeners INTEGER DEFAULT 0,  
  completions INTEGER DEFAULT 0,  
  shares INTEGER DEFAULT 0,  
  PRIMARY KEY (gen_id, date)  
);  
CREATE INDEX stats_date_idx ON gen_stats_daily(date);  
  
-- ========================================  
-- 14. PROMO (опц., как пример плагина)  
-- ========================================  
CREATE TABLE promo_codes (  
  code TEXT PRIMARY KEY,  
  description TEXT,  
  discount_kind TEXT CHECK(discount_kind IN ('percent','fixed','free_track')),  
  discount_value INTEGER,  
  max_uses INTEGER,  
  used_count INTEGER DEFAULT 0,  
  valid_from TEXT,  
  valid_until TEXT,  
  applies_to_sku TEXT,  
  active INTEGER DEFAULT 1,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
```  
  
**Итого:** 20 новых таблиц + 4 расширенных, ≈30 индексов, 1 FTS5 виртуальная таблица. Применяется чисто, без удалений существующих данных.  
  
---  
  
## §4. ОТКРЫТЫЕ ВОПРОСЫ К ЕВГЕНИЮ  
  
Без ответов на эти вопросы стартовать нельзя.  
  
### §4.1 Бизнес  
  
1. **Цены подтверждаем?** Новый pricing с 11 SKU (см. файл 02 §5) — менять или ок? Особенно интересует Wedding bundle (2999 ₽) и Corporate anthem (4999 ₽).  
2. **Реферальный бонус** — оставляем 299 ₽ обеим сторонам, но при первой покупке реферала, а не при регистрации. Согласовано?  
3. **Юрлица:** оферта подписана живой подписью или через ЭЦП? Кто принимает их платежи — расчётный счёт ИП/ООО? (нужно для invoicing)  
4. **Чек ОФД (54-ФЗ):** через Robokassa уже сейчас работает? Если нет — какой провайдер ОФД (Атол, Эвотор, Чек-онлайн)?  
5. **Самозанятые** на стороне продавца — нужно ли интегрировать «Мой Налог» для автогенерации чеков НПД?  
  
### §4.2 Каналы коммуникации  
  
6. **Telegram-бот** — новый или есть существующий @podaripesnu_bot? Если есть — у Евгения токен?  
7. **VK сообщество** — есть, нужно дать токен. Готовы дать админа Claude / Perplexity?  
8. **WhatsApp** — нужен в первой итерации или потом? Greenapi (\~1000 ₽/мес) или официальный API (дороже, но выше доверие)?  
9. **SMS** — нужны вообще? Если да — какой провайдер (smsc.ru, sms.ru)?  
10. **Email-домен** — `noreply@podaripesnu.ru`, `support@podaripesnu.ru`. SPF/DKIM/DMARC настроены?  
  
### §4.3 Рекламные кабинеты  
  
11. **VK Ads** — есть кабинет, какой бюджет в месяц на тест?  
12. **Yandex Direct** — есть кабинет?  
13. **MyTarget / Top.Mail.Ru** — нужно сейчас или отложить?  
14. **Google Ads / Meta** — целевые рынки только РФ или СНГ + дальше? (определяет пиксельный стек)  
  
### §4.4 Технические  
  
15. **Ноды старее 20** на VPS1 — обновлять или собирать на 18? (рекомендую обновить до 20.x LTS).  
16. **SQLite vs PostgreSQL** — сейчас SQLite, при росте до 1000+ юзеров онлайн будет узко. План миграции на PG в v305-306?  
17. **Резервные копии** — есть ли бэкап `data.db` куда-то наружу VPS1? (если нет — обязательно настроить, например, hourly rsync на S3-совместимое хранилище).  
18. **Domain DNS** — `podaripesnu.ru` — у какого регистратора, есть ли доступ к DNS для добавления записей (SPF, DKIM, txt verification)?  
  
### §4.5 Юридические  
  
19. **Политика конфиденциальности** обновлена? Должны быть упомянуты: cookies, пиксели, передача данных в Suno (через GPTunnel), хранение треков, реферальная программа.  
20. **Оферта** обновлена под новые SKU? Особенно: extend, cover, persona, B2B-пакет.  
21. **Cookie-баннер** — нужен формальный (для GDPR-подобной защиты), даже если работаем только в РФ.  
  
### §4.6 Контент и операционка  
  
22. **Кто будет ревьюить автопостинг** в VK / Telegram? Сам Евгений / админ / автоматически с порогом?  
23. **Шаблоны писем** — на 100% уверены, что нужны 8 базовых templates (welcome, paid, refund, password reset, etc.)?  
24. **NPS-опросы** — через 30 дней после первой покупки. Согласовано?  
25. **Email-частота** — для marketing-кампаний максимум сколько в неделю на одного юзера? (рекомендую 1-2).  
  
---  
  
## §5. КРИТЕРИИ ГОТОВНОСТИ К PRODUCTION  
  
Чек-лист перед прод-релизом v304:  
  
- [ ] Все миграции прошли, `data.db` валидна (`PRAGMA integrity_check`)  
- [ ] Все плагины активны в `plugins_registry`  
- [ ] Bug Collector не показывает критических ошибок  
- [ ] Smoke-tests pass  
- [ ] Healthcheck `/api/health` отдаёт `{status:"ok"}`  
- [ ] Pixels в Метрике видят события, в VK — конверсии  
- [ ] Тестовая покупка по новой схеме (с новыми SKU) проходит end-to-end  
- [ ] Тестовый заказ B2B → счёт PDF корректный  
- [ ] Чат-бот в Telegram отвечает  
- [ ] Чат-бот на сайте отвечает  
- [ ] Email отправляется, в IMAP попадают входящие  
- [ ] Бэкап `data.db` сохранён до релиза  
- [ ] Откат-скрипт `v304.sh rollback` протестирован  
- [ ] Все 25 открытых вопросов из §4 имеют ответы  
- [ ] Документация обновлена (README, ARCHITECTURE, DEPLOY)  
- [ ] Stage-окружение прошло 24 часа без ошибок  
  
---  
  
## §6. ПОСЛЕ ЗАПУСКА: ЧТО ИЗМЕРЯТЬ  
  
Первые 30 дней после релиза смотрим:  
  
| День | Метрика | Цель |  
|---|---|---|  
| 1 | Crash rate | < 0.1% |  
| 1-3 | LLM stability чат-бота | < 2% errors |  
| 7 | Anon → Lead conversion | +50% от v303 |  
| 7 | Demo → Paid conversion | +30% |  
| 14 | AOV | +25% |  
| 14 | Time to first response (бот) | < 5 сек |  
| 30 | Retention 30-day | +50% |  
| 30 | LTV | +100% |  
| 30 | NPS | впервые измеряем, > 35 |  
  
---  
  
## §7. ИТОГ ПАКЕТА  
  
Этот пакет из 8 файлов (00 — навигатор + 01–07) — целостная стратегия превращения MuziAI v303 в **самообслуживающуюся платформу с агентной CRM**, которая:  
  
1. Сама притягивает посетителей и превращает их в лиды.  
2. Сама ведёт по воронке через 9 агентов.  
3. Сама общается через чат-бот по 5 каналам.  
4. Сама выставляет счета юрлицам.  
5. Сама публикует контент в соцсети.  
6. Сама оптимизирует рекламу через server-side tracking.  
7. **Расширяема плагинами** — любая новая фича не ломает ядро.  
  
Объём кода для реализации — **примерно в 2× текущий объём ядра** (≈10 000 строк новой логики). Реалистичный срок при 1 разработчике fulltime — **2.5 месяца** (8 спринтов × 1.3 недели в среднем).  
  
---  
  
## КОНЕЦ ПАКЕТА. ЧТО ДАЛЬШЕ  
  
1. **Прочесть весь пакет** (00 → 07).  
2. **Ответить на 25 вопросов** из §4 этого файла.  
3. **Решить, что в Спринте 1.** Минимум — критические баги ядра (см. файл 01 §1.1) и фундамент (EventBus, Module API). Без этого остальное не строится.  
4. **Запустить Спринт 1** — через Perplexity (с пятиуровневым предупреждением) или вручную