# Регистрация MuzaAi в поисковых системах — инструкция Боссу

Eugene 2026-05-23 Босс «Субу зарегистрироваться в метриках поисковиков минимально со мной лучше без меня».

Полностью без Босса нельзя — все панели требуют sign-in (Yandex / Google / Microsoft account). Но сам процесс сведён к минимуму: **2-3 клика на каждый поисковик + копи-паст токена в Claude chat**.

---

## Очерёдность (рекомендую именно в этом порядке)

1. **Yandex.Webmaster** — обязательно для РФ. Уже подключён (token `1cd1aa5e9660b262` в `client/index.html`). ✅
2. **Google Search Console** — глобальный SEO. **5 минут.**
3. **Bing Webmaster Tools** — Microsoft + Bing AI Chat indexing. **3 минуты.**
4. **Mail.ru / Поиск Рамблер** — опционально, ниша РФ. **3 минуты.**
5. **IndexNow protocol** (Yandex + Bing instant indexing) — **2 минуты** (один раз на VPS).

---

## 1. Yandex.Webmaster — УЖЕ ПОДКЛЮЧЁН ✅

Уже работает. Проверить статус:
- https://webmaster.yandex.ru/sites/ — должен быть сайт `muzaai.ru` со статусом «Сайт добавлен».
- Можно засабмитить sitemap руками: Indexing → Sitemap files → Add → `https://muzaai.ru/sitemap.xml`.

---

## 2. Google Search Console (5 минут)

1. Открой https://search.google.com/search-console → войти Google-аккаунтом.
2. Жми «**Add property**» → выбери «**URL prefix**» → введи `https://muzaai.ru` → «Continue».
3. Среди методов верификации выбери «**HTML tag**» (не HTML file — у нас SPA).
4. Скопируй содержимое атрибута `content="ABC..."` (только значение между кавычками).
5. Пришли мне в Claude chat: **«Google verification token: ABC...»**
6. Я заменю `content=""` в `apps/neurohub/client/index.html` (строка с `data-google-placeholder="true"`) → commit → push → 1-2 минуты auto-deploy.
7. Возвращайся в Search Console → жми «**Verify**» (синяя кнопка).

После verification:
- Sitemaps → Add new sitemap → введи `sitemap.xml` → Submit.
- Готово. Первые данные появятся через 2-3 дня.

---

## 3. Bing Webmaster Tools (3 минуты)

1. Открой https://www.bing.com/webmasters → войти **Microsoft / Google / Facebook** аккаунтом.
2. Жми «**Add a site**» → `https://muzaai.ru` → «Add».
3. Выбери метод «**Add a meta tag to your website**».
4. Скопируй содержимое `content="..."` из показанного `<meta name="msvalidate.01" content="...">`.
5. Пришли мне в Claude chat: **«Bing verification token: ABC...»**
6. Я заменю → commit → push → 1-2 минуты.
7. Возвращайся в Bing Webmaster → жми «**Verify**».

После verification:
- Sitemaps → Submit sitemap → `https://muzaai.ru/sitemap.xml`.

**Бонус**: Bing Webmaster даёт **import из Google Search Console** в один клик — после verification предложит «Import sites from Google» → выбери muzaai.ru → автоматом подтянутся sitemaps + URL inspection.

---

## 4. Mail.ru / Поиск Рамблер (3 минуты, опционально)

1. Открой https://webmaster.mail.ru → войти Mail.ru аккаунтом (или зарегистрируй новый — у нас может пригодиться отдельно).
2. Жми «**Добавить ресурс**» → `https://muzaai.ru` → «Далее».
3. Выбери «**Мета-тег**» → скопируй значение `content="..."` из `<meta name="wmail-verification">`.
4. Пришли мне в Claude chat: **«Mail.ru verification token: ABC...»**
5. Я заменю → commit → push → 1-2 минуты.
6. Возвращайся → жми «**Проверить**».

---

## 5. IndexNow protocol (2 минуты — один раз на VPS)

IndexNow — открытый стандарт от Microsoft и Yandex для мгновенного уведомления поисковиков о новых/обновлённых URL'ах. Поддерживают: **Bing, Yandex, Seznam, Naver**. Google **не участвует** (у них свой API).

После подключения — наш код будет автоматически уведомлять Bing+Yandex о каждом новом треке/новости/опубликованной странице → быстрее в индексе.

**Шаги (Босс делает на VPS один раз):**

1. SSH на prod (или clone для теста):
   ```bash
   ssh root@31.130.148.107 'cd /var/www/neurohub && \
     KEY=$(openssl rand -hex 32) && \
     echo "$KEY" > client/public/$KEY.txt && \
     ln -sf client/public/$KEY.txt dist/public/$KEY.txt 2>/dev/null || cp client/public/$KEY.txt dist/public/$KEY.txt && \
     sed -i "/^INDEXNOW_KEY=/d" .env && \
     echo "INDEXNOW_KEY=$KEY" >> .env && \
     chmod 600 .env && \
     pm2 restart neurohub --update-env && \
     echo "Готово. Ключ: $KEY"'
   ```

   Замечание: команда копирует `$KEY.txt` в `dist/public/` чтобы файл был доступен после build'а. Если структура другая — проверь где у тебя production index.html (`dist/public/index.html`).

2. Проверь что ключ доступен:
   ```bash
   curl -s https://muzaai.ru/$KEY.txt
   # должен вернуть тот же $KEY одной строкой
   ```

3. Тест ping:
   ```bash
   curl -s -X POST https://muzaai.ru/api/admin/v304/indexnow/notify \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"urls":["https://muzaai.ru/","https://muzaai.ru/#/music"]}'
   ```
   Ожидаемый ответ: `{"ok":true,"result":{"status":200,"submittedCount":2}}`.

---

## Endpoints для автоматизации

Реализованы в `apps/neurohub/server/routes.ts`:

| Endpoint | Метод | Что делает |
|---|---|---|
| `/api/admin/v304/seo/verification-status` | GET | Диагностика какие токены заполнены (yandex/google/bing/mailru) + статус IndexNow key |
| `/api/admin/v304/sitemap/ping` | GET | Ping Yandex sitemap endpoint. Google/Bing endpoint'ы устарели в 2023 — отдаём informational ответ |
| `/api/admin/v304/indexnow/notify` | POST | Body `{urls: string[]}` — мгновенное notify Bing+Yandex через IndexNow. No-op если INDEXNOW_KEY env не настроен |

Все endpoints под `requireAdmin` + пишут в `admin_audit_log`.

**Удобная кнопка в админке** (для следующей итерации UI):
- Вкладка `/admin/v304 → 🔍 SEO` — три кнопки «Ping sitemap», «Notify IndexNow для top-20 треков», статус verification по каждому engine.

---

## Что делать каждую неделю

Ничего, если IndexNow подключён. Поисковики сами краулят `sitemap.xml` (он динамический, в `server/index.ts`). Yandex обновляет индекс за 1-3 дня, Google — 3-14 дней, Bing — 1-7 дней.

Если хочется ускорить индексацию нового трека/новости:
- В админке (TODO UI) — кнопка «Notify IndexNow» с пресет-URL'ами недавно опубликованных треков.
- Или curl на endpoint выше.

---

## Дополнительные платформы (на будущее, не сейчас)

- **Apple Search Ads / App Store search** — если выпустим iOS app через Capacitor (IOS-APP-CAPACITOR-SETUP.md).
- **Telegram Channel Indexing** — нет официального API, но Telegram умеет индексировать публичные каналы. Достаточно держать активный @MuzaAi канал с регулярным контентом.
- **DuckDuckGo** — нет webmaster panel. Они краулят через Bing → значит как только верифицируешься в Bing, DuckDuckGo подтянется автоматически за 2-4 недели.
- **Brave Search** — есть Webmaster panel но в beta, ниша. Пропускаем.

---

*Last updated: 2026-05-23. Связано с CLAUDE.md правилами Brand-assets-registry, Backup-before-edit, Secrets-admin-only.*
