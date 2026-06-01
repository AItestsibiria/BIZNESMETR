# Готовый prompt для Perplexity — SSH-аудит VPS1

> Копируй блок ниже целиком в Perplexity. Перед выполнением Perplexity сам спросит у тебя подтверждение — это правильное поведение.

---

```
Привет. Мне нужна твоя помощь с проектом MuziAI / podaripesnu.ru.

ЗАДАЧА
Сделай аудит staging-инстанса clone.muziai.ru. Он живёт на том же VPS, что и два prod-инстанса.

🚨 КРИТИЧНО: на VPS 72.56.1.149 — ТРИ инстанса:
  1. podaripesnu.ru — prod #1 (продаёт, не трогаем)
  2. muziai.ru     — prod #2 (продаёт, не трогаем)
  3. clone.muziai.ru — staging-копия с боевыми данными (наш предмет)

Цель аудита — понять, в каких путях лежит каждый из трёх, какие pm2-процессы за ними, и какие server_name указаны в nginx. Менять — НИЧЕГО.

⚠️ ОПЕРАЦИОННОЕ ПРАВИЛО

Любая команда, не ограниченная путём clone-инстанса, может затронуть prod. Поэтому:

1. ВСЕ команды — READ-ONLY (никаких pm2 restart, никаких npm install, никаких изменений в /var/www/muziai*).
2. Перед каждой командой — пятиуровневое предупреждение и явное "да" от Евгения.
3. В выводе явно различай: `/var/www/muziai/` (prod, podaripesnu.ru) и `/var/www/muziai-clone/` или подобный путь (clone). Нам нужен AUDIT обоих, чтобы понять структуру, но менять НИЧЕГО нельзя.
4. Если попросят что-то, кроме команд из списка ниже — ОТКАЖИСЬ и спроси меня.

ПЕРЕД ЛЮБОЙ КОМАНДОЙ:
1. Дождись от меня явного "да, можно".
2. Покажи 5-уровневое предупреждение: что выполнишь, на каком сервере, какие риски, как откатить, есть ли альтернатива.
3. Никаких изменений данных, конфигов, перезапусков сервисов — только READ-ONLY команды (из списка ниже).

ЕСЛИ ПОПРОСЯТ ЧТО-ТО, КРОМЕ ЭТИХ КОМАНД — ОТКАЖИСЬ И СПРОСИ МЕНЯ.

КОМАНДЫ К ВЫПОЛНЕНИЮ (только эти, ничего больше)

ssh root@72.56.1.149 '
  echo "=== System ===";          uname -a;
  echo "=== Node ===";             node -v 2>/dev/null || echo "node not installed";
  echo "=== npm ===";              npm -v 2>/dev/null || echo "npm not installed";
  echo "=== pm2 ===";              pm2 -v 2>/dev/null || echo "pm2 not installed";
  echo "=== pm2 process list ==="; pm2 jlist 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f\"{p[\"name\"]}\\t{p[\"pm2_env\"][\"status\"]}\\t{p[\"pm2_env\"].get(\"pm_cwd\",\"?\")}\") for p in d]" 2>/dev/null || pm2 status 2>/dev/null || true;
  echo "=== sqlite3 ===";          sqlite3 --version 2>/dev/null || echo "sqlite3 not installed";
  echo "=== git ===";              git --version 2>/dev/null || echo "git not installed";
  echo "=== nginx -v ===";         nginx -v 2>&1 | head -1;
  echo "=== nginx vhosts ===";     ls /etc/nginx/sites-enabled/ 2>/dev/null;
  echo "=== nginx server_name ==="; grep -h "server_name" /etc/nginx/sites-enabled/* 2>/dev/null | sort -u;
  echo "=== rclone ===";           rclone version 2>/dev/null | head -1 || echo "rclone not installed";
  echo "=== Disk /var ===";        df -h /var | tail -1;
  echo "=== Disk root ===";        df -h / | tail -1;
  echo "=== Memory ===";           free -h | head -2;
  echo "=== Uptime ===";           uptime;
  echo "=== /var/www/* ===";       ls -la /var/www/ 2>/dev/null;
  echo "=== muziai dirs ===";      find /var/www -maxdepth 2 -type d -name "muziai*" 2>/dev/null;
  echo "=== all data.db files ==="; find /var/www -maxdepth 3 -name "data.db" -exec ls -lh {} \; 2>/dev/null;
  echo "=== .env files (size only, NOT contents) ==="; find /var/www -maxdepth 3 -name ".env" -exec ls -l {} \; 2>/dev/null;
'

ОТЧЁТ

После выполнения собери результат в таком формате на русском:

# SSH-аудит VPS1 — отчёт для Claude

**Дата/время выполнения:** ...

## Стек
| Компонент | Версия | Статус |
|---|---|---|
| ОС / kernel | ... | OK / устарела |
| Node.js | ... | OK ≥20 LTS / нужен апгрейд / не установлен |
| npm | ... | ... |
| pm2 | ... | ... |
| sqlite3 | ... | ... |
| git | ... | ... |
| nginx | ... | ... |
| rclone | ... | OK / не установлен |

## Топология трёх инстансов на одном VPS
| Инстанс | Путь | data.db размер | pm2 имя | nginx server_name |
|---|---|---|---|---|
| podaripesnu.ru (prod #1) | ... | ... | ... | ... |
| muziai.ru (prod #2) | ... | ... | ... | ... |
| clone.muziai.ru (staging) | ... | ... | ... | ... |

- .env файлы (путь → размер, БЕЗ содержимого): ...
- Прочие подозрительные каталоги в `/var/www/`: ...

## Ресурсы
- Свободно на /var: ...
- Свободно на /: ...
- Память (used / available): ...
- Uptime: ...

## Что нужно сделать перед Sprint 1
(перечисли, чего не хватает: например, "Node 18 → нужен апгрейд до 20 LTS", "rclone не установлен", "мало свободного места")

## Сырой вывод
(приклей сюда полный stdout SSH-команды)

ПОСЛЕ ОТЧЁТА — НИЧЕГО НЕ ДЕЛАЙ. Жду решений Евгения.
```

---

## Что делать с отчётом Perplexity

1. Когда Perplexity пришлёт готовый отчёт — **просто скопируй его сюда**, в этот чат с Claude.
2. Я по результату решу, нужен ли апгрейд Node, нужна ли установка rclone/sqlite3, и подготовлю следующие шаги Спринта 1.

---

*Last updated: 2026-05-06*
