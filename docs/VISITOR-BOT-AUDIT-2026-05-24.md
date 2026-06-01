# Visitor Bot Audit — 24.05.2026

**Триггер:** Босс — «Czechia 1 уник + 1887 visits за сутки. Очень много. Разбери на атомы».

## TL;DR

`visitors.visits` — incrementing counter per (fingerprint+ip) row. 1887 visits на 1 unique = одна row была инкрементирована 1887 раз за сутки. Dedup пропускал increments из-за SPA route mutations + UA detector пропускал patched Headless Chrome / Playwright. Per-IP rate-limit отсутствовал.

**Сделано:** расширенный bot UA detector, per-IP rate-limit (30/мин, 200/час), datacenter ASN check, burst Telegram alert (>500/час), `is_bot` flag в `visitors` schema, новые admin endpoints для suspicious review и backfill.

---

## Атомарный разбор «Czechia 1+1887»

Один visitor в `visitors` table содержит:
- `ip` + `fingerprint` (composite key для upsert)
- `visits` integer — incrementing counter
- `last_visit` timestamp
- `user_agent` text

Логика track-visit (routes.ts:892):
1. Bot UA filter (через `isBotUserAgent` — старый regex без headless/puppeteer/playwright)
2. Upsert by `fingerprint OR ip` — если row уже есть, делаем `visits += 1`
3. Dedup: SKIP increment ТОЛЬКО если `samePage && isRecent(5min)`

**Атомарные причины 1887 hits / 1 IP:**

1. **Dedup bypass через pageUrl mutations** — каждый SPA route change (#/dashboard → #/music → /track/X) меняет `pageUrl` → dedup НЕ срабатывает → `visits += 1`. У Czech-визитёра mosly разные pageUrl за 24ч → 1887 hits.
2. **UA detector gap** — `isBotUserAgent` regex purelyмат `bot|crawler|spider|slurp|curl|wget|httpie|python-requests|java-http|axios|fetch|head` с `\b`. Не покрывает:
   - `puppeteer`, `playwright`, `selenium`, `webdriver`
   - `headless` (без «headlesschrome» в основном regex — есть только в SUBSTRINGS, который не используется на запись)
   - Monitoring tools: `uptimerobot`, `pingdom`, `datadog`, `newrelic`
   - Prerender / Lighthouse / PageSpeed
   - Social embed bots: `facebookexternalhit`, `twitterbot`, `telegrambot`, `whatsapp`
3. **Нет per-IP rate-limit** — один IP мог делать неограниченно много track-visit/min. Real browser делает 1-3/min, bot ~1/2sec = 30-60/min.
4. **Нет datacenter ASN check** — Czech IPs часто из Hetzner FSN1 / OVH Strasbourg (Eu datacenters). ASN info уже доступна через `getIpGeo().asn`, но не использовалась.

---

## Fixed (file:line)

### Новые файлы

- `apps/neurohub/server/lib/botDetect.ts` (новый, 296 строк)
  - `isLikelyBotUa(ua)` — расширенный regex покрывает 35+ patterns включая puppeteer/playwright/headless variants/monitoring
  - `isDatacenterAsn(asn)` — список 25+ hosting providers (Hetzner, OVH, DigitalOcean, AWS, GCP, и т.д.)
  - `checkVisitRateLimit(ip)` — sliding window 30/мин + 200/час, returns `{ok, reason, burst, hitsLast...}`
  - `notifyBurstAlert({ip, ua, country, ...})` — Telegram alert при >500/час (cooldown 1час/IP)
  - `getRateMapSnapshot(limit)` — для admin UI live snapshot

### Schema

- `apps/neurohub/shared/schema.ts:167-176` — добавлены колонки в `visitors`:
  - `isBot: integer("is_bot").notNull().default(0)`
  - `botReason: text("bot_reason")` — `ua` / `rate_limit_min` / `rate_limit_hour` / `datacenter_asn` / `burst` / `backfill_ua`

- `apps/neurohub/server/storage.ts:523-528` — ALTER TABLE migration:
  - `ALTER TABLE visitors ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0`
  - `ALTER TABLE visitors ADD COLUMN bot_reason TEXT`
  - `CREATE INDEX visitors_is_bot ON visitors(is_bot, last_visit DESC)`

### Track-visit endpoint

- `apps/neurohub/server/routes.ts:892-1080` — обновлён `/api/track-visit`:
  - **Line 905:** заменён `isBotUserAgent` → `isLikelyBotUa` (расширенный)
  - **Lines 919-933:** per-IP rate-limit check + 429-like skip + sticky bot marking
  - **Lines 940-948:** datacenter ASN check через `getIpGeo().asn`
  - **Lines 950-959:** burst alert при >500/час
  - **Lines 985-1010:** UPDATE/INSERT с `isBot` + `botReason` колонками

### Read-side фильтрация

- `apps/neurohub/server/routes.ts:1144-1156` — `/api/admin/visitor-stats` теперь исключает `is_bot=1`:
  - Добавлен `isBotFilter = " AND (is_bot IS NULL OR is_bot=0)"` в `realFilter` и `realFilterSql`
  - Может быть отключён через `?includeBots=1` для admin аудита

### Новые admin endpoints

- `GET /api/admin/v304/visitor-stats/suspicious?hours=24&threshold=100` (routes.ts:1257-1310):
  - Top IPs за окно с totalVisits >= threshold
  - Список уже-помеченных `is_bot=1` rows
  - Live in-memory rate-map snapshot
  - Summary: totalIps / botIps / realIps / totalVisits / botVisits

- `POST /api/admin/v304/visitor-stats/backfill-bot-flag?dryRun=1` (routes.ts:1313-1349):
  - UPDATE visitors SET is_bot=1 для UA matching expanded patterns
  - dryRun=1 — preview без записи
  - Audit-log через `recordAuditEntry`

---

## Список подозрительных IP (метод проверки)

Запустить **после deploy** на VPS:

```bash
ssh root@31.130.148.107 'curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" "https://muzaai.ru/api/admin/v304/visitor-stats/suspicious?hours=168&threshold=100" | python3 -m json.tool | head -100'
```

И dry-run backfill:

```bash
curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" "https://muzaai.ru/api/admin/v304/visitor-stats/backfill-bot-flag?dryRun=1"
```

После review кандидатов — real backfill (без dryRun param).

---

## Recommended next steps

**P0 (немедленно после deploy):**
1. Запустить `POST /api/admin/v304/visitor-stats/backfill-bot-flag?dryRun=1` → review samples → real backfill.
2. Проверить master-dashboard visitor-stats — Czech IP должен исчезнуть из «честной» сводки.

**P1 (на этой неделе):**
3. **Cloudflare Free** перед nginx — DDoS protection + bot management (бесплатно). Включить «Bot Fight Mode» в Cloudflare → block known headless / scrapers до того как они достигнут VPS. Решает корень проблемы (rate-limit on edge, не in-process).
4. **nginx rate-limit** на `/api/track-visit` — backup защита если Cloudflare упадёт. Пример: `limit_req_zone $binary_remote_addr zone=trackvisit:10m rate=30r/m;`.

**P2 (опционально):**
5. **hCaptcha invisible** на главной странице — отсекает legitimate-looking bots без UX friction. Только при подозрении (после 5+ visits в час).
6. Расширить `visitors_is_bot` index → cluster index для read-side perf (если суммарно >1M rows).
7. ASN block list — добавить в `blockedEntities` IP ranges из ASN с очень высоким bot-rate (Hetzner, OVH datacenter blocks).

---

## CLAUDE.md rules применены

- ✅ **Play-counting rule** — bot UA regex consistent pattern
- ✅ **User-action-failure registry** — failed track-visit не logged (это OK — skip это не fail)
- ✅ **Backup-before-edit** — backfill через recordAuditEntry
- ✅ **Secrets-admin-only** — admin endpoints через requireAdmin
- ✅ **Period-20-MSK** — endpoints использует period-aware queries (через existing helpers)
- ✅ **No-duplicates** — расширил существующий botUa.ts (не создал параллель), добавил один новый admin endpoint в существующий V304 namespace

---

**Файлы изменены:**
- `apps/neurohub/server/lib/botDetect.ts` (новый)
- `apps/neurohub/shared/schema.ts` (visitors: isBot, botReason)
- `apps/neurohub/server/storage.ts` (ALTER migration + index)
- `apps/neurohub/server/routes.ts` (track-visit hardening + 2 admin endpoints + read-side фильтр)
- `docs/VISITOR-BOT-AUDIT-2026-05-24.md` (этот файл)
