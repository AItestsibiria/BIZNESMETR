# PITFALLS — реестр ошибок и анти-паттернов проекта v304

Каждая запись — реальный баг который случился в ходе работы, что-было-сделано-не-так, и **рабочий паттерн**. Документ обновляется при появлении нового класса ошибок.

**Правило:** перед задачей класса X сверяюсь с этим файлом. Если задача порождает новый класс — добавляю запись.

---

## 1. Shell-экранирование во вложенных языках (bash + python -c + curl)

**Симптом:** `SyntaxError: unexpected character after line continuation character`, или `prompt ушёл пустым`, или JSON собрался криво.

**Причина:** bash one-liner с inline `python -c "..."` через `ssh '...'` имеет 3 уровня кавычек (ssh outer, bash, python), плюс nested `\"` для JSON. Любой пропуск escape — ломается.

**Анти-паттерн:**
```bash
ssh root@host 'curl -d "{\"prompt\":\"$(python -c \"...\\\")\"}" ...'
```

**Рабочий паттерн — bash heredoc + python heredoc:**
```bash
ssh root@host 'bash /path/to/script.sh'
```
А внутри `script.sh` — обычный bash + `python3 <<'PY' ... PY` (с одинарными кавычками вокруг 'PY' — нет интерполяции). JSON-payload пишется в файл, curl шлёт `--data-binary @/tmp/file.json`. См. `apps/neurohub/scripts/smoke-anthem.sh`.

**Правило:** если скрипт длиннее 1 строки или есть JSON-сборка — кладу в `apps/neurohub/scripts/*.sh` репозитория, запускаю одной короткой ssh-командой. Это и для повторяемости (auto-deploy катит файл, можно перезапускать без копи-паста).

---

## 2. systemd-service без HOME → pm2 идёт в /etc/.pm2

**Симптом:** `pm2 restart neurohub` тихо упал, restart counter не вырос, scrip упал на `set -e` сразу после build, лог обрывается на `Done in NNNms`.

**Причина:** `systemd` не наследует `HOME` родительского shell. pm2 без `HOME` идёт в `/etc/.pm2`, не находит зарегистрированных процессов → возвращает error → bash на `set -e` упал.

**Анти-паттерн:** запускать `pm2 *` команды из systemd-service без env.

**Рабочий паттерн:** В начале любого bash-скрипта который дёргает pm2:
```bash
export HOME="${HOME:-/root}"
export PM2_HOME="${PM2_HOME:-/root/.pm2}"
```
Или в systemd unit:
```
Environment=HOME=/root
Environment=PM2_HOME=/root/.pm2
```

**Правило:** все скрипты с pm2 проверяю на наличие HOME-export.

---

## 3. esbuild не bundles `await import(varname)` — только литералы

**Симптом:** на сервере `Cannot find module './plugins/example/module'`. Локально работает (Node резолвит через filesystem).

**Причина:** в bundled cjs все динамические `import(path)` где `path` — переменная превращаются в runtime `require(varname)`. esbuild не может их статически разрешить и не инлайнит. Сборка проходит, runtime падает.

**Анти-паттерн:**
```ts
const PATHS = ["./plugins/foo/module", "./plugins/bar/module"];
for (const p of PATHS) await import(p);
```

**Рабочий паттерн:**
```ts
import fooModule from "./plugins/foo/module";
import barModule from "./plugins/bar/module";
const PLUGINS = [{ name: "foo", module: fooModule }, ...];
```
Статические top-level imports. esbuild видит литералы → bundles.

**Правило:** для bundled-кода никогда не использую `await import()` с переменной.

---

## 4. SQLite TIMESTAMP vs ISO-string lexicographic compare

**Симптом:** `WHERE created_at >= ?` с ISO-датой ничего не возвращает, хотя строки есть.

**Причина:** SQLite `CURRENT_TIMESTAMP` отдаёт `'YYYY-MM-DD HH:MM:SS'` (пробел разделитель). JS `new Date().toISOString()` отдаёт `'YYYY-MM-DDTHH:MM:SS.sssZ'` (буква T). Лексикографически `T` (0x54) > пробел (0x20), все old-rows будут МЕНЬШЕ нового ISO → пустой результат.

**Анти-паттерн:**
```ts
const since = new Date().toISOString();
db.select().from(t).where(sql`${t.createdAt} >= ${since}`);
```

**Рабочий паттерн:** id-tracking через MAX(id) для autoincrement-таблиц:
```ts
const beforeMaxId = db.select({ m: sql<number>`COALESCE(MAX(id), 0)` }).from(t).get()?.m ?? 0;
// ... operations ...
db.select().from(t).where(sql`${t.id} > ${beforeMaxId}`);
```
Или `datetime('now', '-1 day')` SQL-функция вместо JS:
```ts
sql`${t.createdAt} >= datetime('now', '-1 day')`
```

**Правило:** не сравниваю ISO-string с CURRENT_TIMESTAMP колонками.

---

## 5. v51 auth — Bearer token в `sessions` таблице, не express-session

**Симптом:** мой `requireAdmin` всегда возвращает 401, хотя пользователь залогинен.

**Причина:** v51 не использует express-session/passport. Token приходит в `Authorization: Bearer <X>`, проверяется через `SELECT FROM sessions WHERE token = ?`. См. `routes.ts:263-318`. Клиент в `auth.tsx:42-48` патчит `window.fetch` чтобы добавлять Bearer на все `/api/*`.

**Анти-паттерн:**
```ts
const userId = req.session?.passport?.user;
```

**Рабочий паттерн:**
```ts
const auth = req.headers.authorization;
const token = auth?.startsWith("Bearer ") ? auth.slice(7) : req.query.token;
const row = db.get(sql`SELECT user_id as userId FROM sessions WHERE token = ${token} LIMIT 1`);
const userId = row?.userId ?? null;
```

**Правило:** все новые admin-эндпоинты повторяют логику `authMiddleware` из routes.ts. Не выдумываю свой механизм.

---

## 6. Self-update в скрипте — гонка: cmp до или после reset

**Симптом:** новые версии скрипта не подтягиваются автоматически — каждый тик проводит deploy старым кодом.

**Причина:** в первой версии `auto-deploy.sh` self-update сравнивал `/usr/local/bin/...` с `/opt/neurohub-src/deploy/...` **до** `git reset --hard`. Working tree был на старом коммите, файл в нём = тот же что и установленный → cmp одинаков → не обновляется.

**Анти-паттерн:**
```bash
git fetch
if cmp -s "$INSTALLED" "$REPO_FILE"; then exit; fi   # <-- repo_file = working tree, ещё старый
git reset --hard $REMOTE
... deploy ...
```

**Рабочий паттерн:**
```bash
git fetch
git reset --hard $REMOTE                              # <-- сначала
# Теперь $REPO_FILE — свежий
if ! cmp -s "$INSTALLED" "$REPO_FILE"; then
  cp "$REPO_FILE" "$INSTALLED"; exit 0
fi
... deploy ...
```
Или: использовать `git show origin/<branch>:path` который читает из commit, не из working tree.

**Правило:** в self-modifying скриптах reset/checkout идёт ДО любых сравнений с файлами.

---

## 7. First-run no-deploy: `LOCAL == REMOTE` после clone

**Симптом:** auto-deploy после первого clone тикает, но никогда не делает deploy. Даёт `exit 0` каждый раз.

**Причина:** `git rev-parse HEAD` сразу после `git clone` равно `git rev-parse origin/<branch>` — и старая логика "если они равны → exit" срабатывала сразу.

**Анти-паттерн:**
```bash
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/$BRANCH)
if [[ "$LOCAL" == "$REMOTE" ]]; then exit 0; fi
```

**Рабочий паттерн:** SHA-tracking через отдельный файл:
```bash
DEPLOYED_SHA=$(cat /var/www/<app>/.deployed-sha 2>/dev/null || echo "")
if [[ "$DEPLOYED_SHA" == "$REMOTE" ]]; then exit 0; fi
# ... deploy ...
echo "$REMOTE" > /var/www/<app>/.deployed-sha   # ТОЛЬКО на success
```

Преимущества: на first-run файла нет → forced deploy. На rollback файл не пишется → next tick retry.

**Правило:** идемпотентность через персистентный маркер success, не через current-state равенство.

---

## 8. `npm install --omit=dev` через symlink на prod

**Симптом:** build падает на `tsx: not found`. Или (хуже) prod node_modules повреждён.

**Причина:** скрипт делал `ln -s /var/www/<app>/node_modules build_dir/node_modules`, потом `npm install --omit=dev` — если бы запустился целостно, он бы выпилил devDependencies из ПРОДА (через symlink). С `--omit=dev` к тому же не подтягивает `tsx` (devDep) → build не находит его.

**Анти-паттерн:** symlink на prod node_modules + npm install. **Никогда.**

**Рабочий паттерн:** изолированная папка билд + полный `npm ci` + копирование только `dist/` обратно на прод. node_modules сборки в мусор. Кэш ~/.npm reuse'ится автоматически.

**Правило:** prod node_modules — read-only зона из любого build-pipeline.

---

## 9. Hardcoded API-key в коде попадает в публичный репо

**Симптом:** ключ скомпрометирован при первом push в public.

**Причина:** `const KEY = process.env.X || "real_value"` — строковый fallback на случай отсутствия env. В public-history теперь permanent.

**Анти-паттерн:**
```ts
const GPTUNNEL_API_KEY = process.env.GPTUNNEL_API_KEY || "shds-real-key-here";
```

**Рабочий паттерн:**
```ts
const GPTUNNEL_API_KEY = process.env.GPTUNNEL_API_KEY || "";
if (!GPTUNNEL_API_KEY) console.error("[FATAL] GPTUNNEL_API_KEY missing");
```
Empty fallback + явный warn. Сервис стартует, но любая попытка вызова API пойдёт в 401, что сразу видно в логах.

**Правило:** never `|| "real_value"`. Только `|| ""` или throw.

---

## 10. Передача секретов через AI-чат

**Симптом:** ключ виден всем кто читает мой контекст.

**Причина:** AI-сессии хранятся, агрегируются, могут попасть в support/training/logs.

**Анти-паттерн:**
- Скопировать ключ из GPTunnel-кабинета через ⌘+C → ⌘+V в чат
- Прислать ключ в шаблоне ssh-команды
- Зашифровать ключ и прислать blob (мне всё равно надо decrypt = plaintext в контексте)

**Рабочий паттерн:** ssh + ручной ввод (Mac Terminal в split-view с GPTunnel-кабинетом, набирать клавишами). См. `docs/strategy/CLONE-BACKUPS-LOG.md` для конкретных команд.

**Правило:** секрет существует только: GPTunnel-кабинет, локальная RAM терминала, `.env` на VPS. Нигде больше.

---

---

## 11. Пробросы upstream-ошибок выглядят как локальные

**Симптом:** `POST /api/music/generate` возвращает `{"message":"Invalid token, check if authorization header has a valid value."}`. Текст звучит как наша auth-проблема, но в кодовой базе такой строки нет.

**Причина:** v51 проксирует на GPTunnel Suno API. Когда GPTunnel возвращает 401/403 — v51 пробрасывает body как есть. Сообщение чужое, ошибка тоже не наша. Локальный auth-стек прошёл.

**Анти-паттерн:** искать `"Invalid token"` в `server/`, чинить `authMiddleware`. Тратить время на ложный след.

**Рабочий паттерн:**
1. `grep -rE "точный текст ошибки" server/ node_modules/` → если нет совпадений → upstream.
2. Проверить ключ upstream-провайдера (`.env` GPTUNNEL_API_KEY) на: пустой, лидирующие пробелы, скрытые символы.
3. `awk -F= '/^X=/{print "length:",length($2)}'` показывает длину значения (с пробелами).
4. `pm2 env <name>` показывает что подхватилось в runtime (не всегда == .env, если не было `--update-env`).

**Правило:** ошибки от внешних API не лечатся локально. Сначала grep, потом исследую env/keys, потом — если своё.

---

## 12. dotenv не trim'ит ВЕДУЩИЕ пробелы у значения

**Симптом:** ключ есть в `.env`, но не работает. `awk` показывает length на 1 больше ожидаемого. Первый символ — пробел.

**Причина:** при добавлении ключа через `echo "X= value"` (с пробелом после `=`) dotenv возьмёт `" value"` буквально. Suno/GPTunnel/etc вернут 401 потому что у них strict matching.

**Анти-паттерн:**
```bash
echo "GPTUNNEL_API_KEY= shds-..." >> .env
                       ↑ пробел убивает ключ
```

**Рабочий паттерн:**
```bash
echo "GPTUNNEL_API_KEY=shds-..." >> .env
                       ↑ ОДИН символ '=' и сразу значение
```

Или после-добавления:
```bash
sed -i 's/^\([A-Z_]\+\)= */\1=/' /var/www/<app>/.env
# убирает пробелы между = и значением
```

**Правило:** в bash при формировании .env-строки не оставляю пробел после `=`.

---

## 13. GPTunnel Authorization без Bearer + 400-char prompt лимит в basic mode

**Симптом 1:** API возвращает auth-error даже с правильным ключом.
**Симптом 2:** трек получается коротким / не той структуры, чем ждёшь.

**Документация:** https://docs.gptunnel.ru/media-api/suno

**Анти-паттерн:**
```bash
# Bearer вообще не нужен:
-H "Authorization: Bearer shds-..."   # ❌
# Длинный текст в basic-mode prompt:
{"model":"suno", "prompt":"<1500 chars текста>"}   # ❌ truncated до 400
```

**Рабочий паттерн:**

Заголовок:
```
Authorization: shds-XXX                ✅ голый ключ, без Bearer
```

Endpoint: `POST https://gptunnel.ru/v1/media/create`

Basic mode (Suno сам пишет текст):
```json
{ "model": "suno", "prompt": "<≤400 chars описание>", "version": "chirp-v4-5" }
```

Custom mode (свой текст песни):
```json
{
  "model": "suno",
  "mode": "custom",
  "lyric": "<50-3000 chars>",
  "title": "<≤80 chars обязательно>",
  "tags": "<≤200 chars стиль/жанр/voice>",
  "prompt": "<опц. ≤400 chars>"
}
```

В v51 `/api/music/generate` это разруливается автоматически: если в request body передать `lyrics` ≥ 50 chars + `title` — v51 переключается в custom mode (см. `routes.ts:2010-2017`). Просто шлёшь:
```json
{ "lyrics": "<full text>", "title": "...", "style": "..." }
```

После — `POST /v1/media/result` с `task_id` (24 символа) для проверки статуса.

**Правило:** длинный текст → `lyrics` + `title`, а не `prompt`. И никогда не `Bearer` для GPTunnel.

---

## 14. pm2 restart --update-env берёт env из shell вызывающего, не из .env

**Симптом:** ключ обновлён через UI, admin-verify показывает ✅ (читает .env напрямую), но `/api/music/generate` всё ещё падает с 401 на старом ключе. `process.env.GPTUNNEL_API_KEY` в runtime отличается от `.env` файла.

**Причина:** `pm2 restart neurohub --update-env` подхватывает env из **процесса, который вызвал команду**, а не парсит `.env` файл. Если spawn запущен из express-приложения с устаревшим `process.env`, новый процесс получит то же устаревшее окружение даже с `--update-env`.

**Анти-паттерн:**
```ts
spawn("bash", ["-c", "pm2 restart neurohub --update-env"], {
  env: { ...process.env, HOME: "/root" },
});
```

**Рабочий паттерн:** source .env в bash-subshell перед pm2:
```ts
const cmd = `set -a && [ -f ${ENV_FILE} ] && . ${ENV_FILE}; set +a && pm2 restart neurohub --update-env`;
spawn("bash", ["-c", cmd], { env: { HOME: "/root", PM2_HOME: "/root/.pm2", PATH: ... } });
```
`set -a` экспортирует все assignments автоматически — эквивалент `export X=value` для каждой строки.

**Диагностика:** добавить endpoint `/api/admin/v304/secrets/runtime-check` — сравнивает `readEnvFile()` с `process.env` для каждого whitelist-ключа. UI показывает `desynced` список + кнопку «Restart pm2».

**Verify ≠ Test:** `verify` через `/v1/balance` проверяет account-level scope. `test-suno` через `POST /v1/media/create` — media-level scope. Эти scope могут различаться у GPTunnel. Если verify ✅, а test-suno ❌ — нужен другой ключ с media-доступом.

**Правило:** для admin-flow «обновить ключ → ожидать что runtime его увидит» использовать source-then-restart pattern + endpoint runtime-check для пост-проверки + test-suno для верификации правильного scope.

---

*Last updated: 2026-05-07. Каждый новый bug-class пополняет список.*
