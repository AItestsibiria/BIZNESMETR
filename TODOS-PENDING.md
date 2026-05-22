# Pending tasks — MuzaAi (Eugene's queue)

Updated: 2026-05-22 06:45 MSK

Принцип: всё что я нашёл / собрал в субагент-аудитах / Boss отложил «утром решу» — лежит здесь до явного «apply / cancel». Я напоминаю в чате когда контекст уместен.

---

## 🔴 P0 — High value, low effort

### Metrics consistency (audit metrics-audit-2026-05-21)
- [ ] **Единый источник PLAYS** — JOIN `gen_activity` COUNT во все read-sites (sort=rating плейлист, per-track row, plays-analytics, multi-domain). Сейчас 3+ источника, расхождение до 1300.
  - Approach A: JOIN при чтении (после P2 индексов быстро). Effort: 3-4ч.
  - Approach B: materialized cache + trigger. Effort: 1 день.
- [ ] **Author cabinet `/api/account/my-gen-stats`** — сейчас `/api/admin/gen-stats` отдаёт 403 не-админу → авторы не видят свои plays/downloads в ЛК. Новый endpoint с `WHERE user_id = currentUser.id`. Effort: 1-2ч.

### Security (audit security-audit-2026-05-21)
- [ ] **Body size limit** `express.json({ limit: "1mb" })` — DoS prevention (1 строка `index.ts:147`)
- [ ] **OTP brute-force** rate-limit на `/api/auth/verify-register` + attempts counter (~10 строк)
- [ ] **Generation rate-limit** на `/api/music/generate` + `/lyrics/generate` + `style-cover` + `extend` + `regenerate` (5/мин per user)
- [ ] **TG force_create cap** — `/api/auth/telegram` сейчас даёт 1000₽ бонус без лимита → bot фарм (~15 строк)

### Conversion (audit conversion-2026-05-22)
- [ ] **B1 — DeepSeek tools router** — DeepSeek (primary LLM) не поддерживает tools → `create_music_job` не работает в 95%. Intent-based router: тригерные слова → Anthropic step. **Это объясняет 0 продаж при Музa open=25/день.**
- [ ] **B2 — persona inline create_music_job** — добавить в `consultantPersona.ts` блок «когда юзер сказал ‘запускай’ → tool вместо ссылки на /music». Сейчас воронка ведёт на ВНЕШНИЙ /music → 952→16 (1.7%) теряется
- [ ] **A1 — share button** `landing.tsx:2051` неверный URL `/api/playlist/activity/` → должен `/api/gen-activity/${id}/share`. 1-line fix
- [ ] **A2 — main player share без log** `landing.tsx:1681,1685` нет fetch после `navigator.share`. 2 строки
- [ ] **A3 — dashboard share без log** `dashboard.tsx:1573,1911`. То же
- [ ] **A4 — copy-link** — кнопки нет в UI, но админ считает column. Либо добавить, либо удалить колонку

---

## 🟡 P1 — Medium effort, important

### Security P1 (9 items)
- [ ] helmet + CSP + HSTS + X-Frame-Options + `disable("x-powered-by")` + `set("trust proxy", 1)`
- [ ] timing-safe HMAC compare (Telegram auth, Telegram webhook secret, SMS OTP) — `crypto.timingSafeEqual` wrapper
- [ ] Reflected XSS escape (`/api/auth/confirm-name/:token`, `/api/generations/confirm-delete/:token`) — escapeHtml util
- [ ] Admin CMS dangerouslySetInnerHTML — DOMPurify wrapper
- [ ] Tokens в localStorage → migrate HttpOnly Secure SameSite cookies
- [ ] Suno webhook timingSafeEqual length-check fix
- [ ] Telegram webhook fail-closed если secret missing (сейчас fail-open)

### Metrics consistency
- [ ] Bot filter consistently — apply `buildBotExclusionSql` к `gen_activity` (сейчас только visitors)
- [ ] Унифицировать `visitors` дата-фильтр (`created_at` vs `last_visit`) — admin-vstats vs master-dashboard
- [ ] Host filter в `/api/admin/gen-stats` + top-downloads

### Counter cosmetic
- [ ] Per-country visits в admin (1826 для Праги) — тот же inflated SUM bug. Quick fix через event-log как periodVisits
- [ ] Структурный — `visit_events` таблица (1 row per visit), deprecate `visitors.visits` aggregator. 1-2 дня

---

## 🟢 P2 — Performance / nice-to-have

### Database performance
- [ ] **SQL индексы** — готовы 8 штук (CREATE INDEX), уже одобрены, но Boss ещё не запускал команду на VPS. Дать ему команду ещё раз?
  ```sql
  CREATE INDEX idx_gen_activity_action_created ON gen_activity(action, created_at);
  CREATE INDEX idx_gen_activity_gen_action ON gen_activity(gen_id, action);
  CREATE INDEX idx_gen_activity_ip_action_created ON gen_activity(ip, action, created_at);
  -- + visitors + generations
  ```
- [ ] Cache 60s→5мин для dashboard-summary

### SEO (audit conversion-2026-05-22)
- [ ] **C1 — sitemap.xml `/#/music` → `/music`** (hash routes не индексируются)
- [ ] **C2 — top-100 треков в sitemap** `/share/:id` URL'ы для индексации
- [ ] **C3 — MusicRecording schema.org** в `/share/:id` (rich snippets Yandex/Google)
- [ ] **C4 — fake aggregateRating 4.9/120 убрать** (Google penalty risk)
- [ ] **C5 — Yandex Webmaster: sitemap submit** (нет — почему медленный crawl РФ)
- [ ] **C6 — og:image SVG → 1200×630 PNG** (Telegram/WhatsApp превью)
- [ ] **C7 — landing SSR fallback `<h1>` в index.html body** для crawler'ов
- [ ] **C8 — `/share/:id` description с first-line lyrics** (per-track snippets)
- [ ] **C10 — self-host шрифты** Inter + Space Grotesk (Google CDN РФ flaky)

### Other
- [ ] **DELETE 29 127 seed-rows** из visitors — освободит ~5MB БД, упростит queries (опционально, уже отфильтрованы при чтении)
- [ ] **iOS app Phase 1** (P0+P1+P2+P3 из планa) — Capacitor, offline downloads, play-bulk sync. Ждёт 8 решений Boss'а (storage cap, cellular gate и т.д.)
- [ ] **Backup команда** — Boss получил `MuzaAi-Triumph-DDMMYY-HHMM.tar.gz` SQL команду, но запустил ли?
- [ ] **Counter variant решение** — A (4311 deduped) / B (6102 public) / **C (3793 public+deduped, рекомендую)** / 6677 keep. Текущий 6677 остаётся

---

## ✅ Recently done (для контекста)

- 2026-05-22 — Quick fix admin visitor-stats periodVisits через user_journey_events
- 2026-05-22 — Реальная статистика везде (filter seed daily_country_bump + cron OFF)
- 2026-05-22 — PlaysCounter перенесён с landing в dashboard
- 2026-05-22 — Compact single-row layout (60-70px вместо 280px)
- 2026-05-22 — RocketLaunch отключён после трека
- 2026-05-22 — God-mode fix counter = gen_activity COUNT (sync с админом)
- 2026-05-21 — SSE realtime counter + throttle 1/min
- 2026-05-21 — Geo modal + countries-count + flags
- 2026-05-21 — Trophy → 🚀 emoji rocket
- 2026-05-21 — 3D rotating planet SVG (equirectangular strip + SMIL)
- 2026-05-21 — Musa multi-step tool-loop (audit #1)
- 2026-05-21 — ChatTrackCard player connection (event-bus)
