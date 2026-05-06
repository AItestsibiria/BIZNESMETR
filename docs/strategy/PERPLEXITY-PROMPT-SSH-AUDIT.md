# Готовый prompt для Perplexity — SSH-аудит VPS1

> Копируй блок ниже целиком в Perplexity. Перед выполнением Perplexity сам спросит у тебя подтверждение — это правильное поведение.

---

```
Привет. Мне нужна твоя помощь с проектом MuziAI / podaripesnu.ru.

ЗАДАЧА
Сделай аудит продакшен-сервера VPS1 (IP 72.56.1.149) — нужно понять, на чём он стоит сейчас, и нужен ли апгрейд перед стартом v304-кодинга.

⚠️ КРИТИЧНО — ОПЕРАЦИОННОЕ ПРАВИЛО

VPS1 — это боевой сервер podaripesnu.ru.

ПЕРЕД ЛЮБОЙ КОМАНДОЙ:
1. Дождись от меня явного "да, можно".
2. Покажи 5-уровневое предупреждение: что выполнишь, на каком сервере, какие риски, как откатить, есть ли альтернатива.
3. Никаких изменений данных, конфигов, перезапусков сервисов — только READ-ONLY команды (из списка ниже).

ЕСЛИ ПОПРОСЯТ ЧТО-ТО, КРОМЕ ЭТИХ КОМАНД — ОТКАЖИСЬ И СПРОСИ МЕНЯ.

КОМАНДЫ К ВЫПОЛНЕНИЮ (только эти, ничего больше)

ssh root@72.56.1.149 '
  echo "=== System ===";        uname -a;
  echo "=== Node ===";           node -v 2>/dev/null || echo "node not installed";
  echo "=== npm ===";            npm -v 2>/dev/null || echo "npm not installed";
  echo "=== pm2 ===";            pm2 -v 2>/dev/null || echo "pm2 not installed";
  echo "=== pm2 status ===";     pm2 status 2>/dev/null || true;
  echo "=== sqlite3 ===";        sqlite3 --version 2>/dev/null || echo "sqlite3 not installed";
  echo "=== git ===";            git --version 2>/dev/null || echo "git not installed";
  echo "=== nginx ===";          nginx -v 2>&1 | head -1;
  echo "=== rclone ===";         rclone version 2>/dev/null | head -1 || echo "rclone not installed";
  echo "=== Disk /var ===";      df -h /var | tail -1;
  echo "=== Disk root ===";      df -h / | tail -1;
  echo "=== Memory ===";         free -h | head -2;
  echo "=== Uptime ===";         uptime;
  echo "=== /var/www/muziai ===";ls -la /var/www/muziai 2>/dev/null | head -10 || echo "not found";
  echo "=== data.db size ===";   ls -lh /var/www/muziai/data.db 2>/dev/null || echo "not found";
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

## Состояние проекта
- /var/www/muziai существует? ...
- data.db размер: ...
- pm2 процессы: ... (имена и статусы)

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
