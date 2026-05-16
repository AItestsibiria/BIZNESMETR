# Handoff 16 мая 2026 — для следующей сессии

> Этот документ суммирует состояние после длинной 16+ часовой сессии 15-16 мая 2026.
> Прочитать **перед** началом работы.

## 📍 Состояние Prod (muzaai.ru)

- **HEAD:** `b9fc41f` (triumph-muza-150526) + cherry-pick `7ce92db` (скрыт toggle «Новые авторы»)
- **PM2:** online, sharp + native binaries установлены вручную (`npm install sharp@0.34.5 --force`)
- **БД:**
  - User 2 (admin egnovoselov@gmail.com) теперь имеет phone `+79138209174`
  - User 16, 17 — soft-deleted
  - UNIQUE INDEX `idx_users_phone_unique` создан на `users(phone) WHERE phone != '' AND deleted_at IS NULL`
- **Cookie auth_token:** 90 дней, SameSite=Lax (НЕ HttpOnly — frontend читает через `globalToken`)
- **REGISTRATION_DISABLED:** НЕ задеплоено — регистрация открыта

## 📦 Готовые коммиты в ветке `claude/add-claude-documentation-OW5V7` (не задеплоены)

`triumph-muza-150526` (b9fc41f) → 18 коммитов вперёд → текущий HEAD `7ce92db`

Ключевые **в очереди на deploy** (по одному, с тестом):

1. `7d93990` — REGISTRATION_DISABLED feature flag (Босс просил «закрой регистрацию»)
2. `f684c2f` — топ-4 critical fixes из аудита (CORS exact match, link-existing transaction, UNIQUE retry, share-qr URLs). **Один из них сломал site** при попытке деплоя — нужно найти. Скорее всего `link-existing` raw.transaction или sed по share-qr.
3. `3ab05dd` — big-player Modal на landing
4. `35fe931` — toast + сразу navigate в кабинет (после успешного звонка)
5. `0624559` — текст «по исходящему звонку» вместо «по входящему»
6. Прочие — branding, новости, privacy, и т.д.

## 🔴 Открытые проблемы

### 1. Empty state «Новые авторы» — плейлист исчезает
- **Симптом:** клик «Новые авторы» → весь плейлист (включая контейнер) исчезает
- **Cherry-pick `2ca7e84`** (мой fix с `min-h-[60px]` + empty-row) НЕ помог
- **Текущее решение:** скрыли toggle через `display:none` (cherry-pick `7ce92db`)
- **Следующий шаг:** найти КОРНЕВУЮ причину — почему empty state блок (line 1291 в landing.tsx, добавлен в `4930904`) не отображается. Возможно JS error при switch на "new" → React не рендерит. Нужны console-ошибки из browser.

### 2. Дубликат-регистрация — закрыта временно
- User 2 имеет phone, дубликаты слиты, UNIQUE INDEX стоит. Но без REGISTRATION_DISABLED **новая** регистрация по тому же phone теперь должна возвращать существующего user (после `f684c2f` fix UNIQUE retry) — это в коде, но не задеплоено.
- **Нужно:** cherry-pick UNIQUE retry часть отдельно + REGISTRATION_DISABLED.

### 3. Lockscreen — обложка не обновляется при next/prev
- Это известное ограничение iOS MediaSession API
- Мои 2 fix'а (clear+Date.now() bust + 1024 sizes) сломали — откачены
- На завтра: попытаться заново, по одному, с тестом

### 4. Share-QR / соцсети могут показывать старый домен
- В `f684c2f` я делал mass-replace `https://muziai.ru` → `https://muzaai.ru` в client/
- Этот коммит подозревается в crash сайта (см #1)

## 🟡 Action-plan на следующую сессию (по аудиту Стратег-Критик 22 пункта)

**Топ-5 критичных:**
1. Cherry-pick **только CORS exact match** (`security-guard/module.ts:47` — 1 строка) → deploy → test
2. Cherry-pick **только REGISTRATION_DISABLED** (если Босс ещё хочет) → deploy → set env
3. Локально **разделить `f684c2f` на 4 отдельных коммита** — найти причину crash. Подозрение: `raw.transaction(() => {})()` либо sed по share-qr
4. UNIQUE retry в auth-sms — отдельным коммитом
5. share-qr → BRAND.url через `client/src/lib/branding.ts`

**Топ-7 🟡:**
6. Cookie Secure+SameSite=Strict (но НЕ HttpOnly — сначала backend middleware)
7. Rate-limit forgot-password (3/час IP + 1/час email)
8. Admin token query → header only
9. localStorage cleanup в inline-auth
10. Webhook rate-limit
11. Sessions TTL + cleanup cron
12. Reset code log audit

**Дополнения от Стратега (#16-21):**
- UNIQUE constraint retry в backend
- Token TTL в sessions
- Sharp re-install при deploy документировать
- Welcome_gift_given race
- Lockscreen — known limitation
- REGISTRATION_DISABLED не задеплоен

## 🎯 Что хорошо завершено

- Домен переехал muziai.ru → muzaai.ru (DNS, SSL, nginx 301)
- Авторизация по звонку (callcheck) работает
- Sharp + native binaries on prod
- Триумф-tag `triumph-muza-150526` + `triumph-strateg-160526`
- Правила в CLAUDE.md (12 новых за день)
- Стратег-Критик аудит: 22 пункта с приоритетами

## 🌙 Где что лежит

- **Triumph-tag (recovery point):** `triumph-strateg-160526`
- **Стабильный prod-state:** `b9fc41f` (triumph-muza-150526)
- **Ветка с готовыми коммитами:** `claude/add-claude-documentation-OW5V7`
- **CLAUDE.md** в корне репо — все правила, конвенции, контекст
- **deploy/domain-switch-muzaai.md** — план перехода домена
- **deploy/nginx-muzaai.conf** — production nginx config
- **docs/strategy/PITFALLS.md** — реестр ошибок (если есть)

---

**Сессия 15-16 мая закрыта в 14:35 MSK после ~16 часов работы.**
**Следующая сессия:** прочитать этот документ → восстановить контекст → продолжить с action-plan.
