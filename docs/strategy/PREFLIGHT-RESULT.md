# SSH-аудит VPS 72.56.1.149 — результат

**Дата выполнения:** 2026-05-06 13:28 МСК (Perplexity по prompt из `PERPLEXITY-PROMPT-SSH-AUDIT.md`)

---

## Стек (всё свежее, апгрейд НЕ нужен)

| Компонент | Версия | Статус |
|---|---|---|
| ОС / kernel | Ubuntu 22.04 LTS, kernel 5.15.0-176 (msk-1-vm-my9j) | OK |
| Node.js | **v22.22.0** | OK (даже свежее целевых 20 LTS) |
| npm | 10.9.4 | OK |
| pm2 | 6.0.14 | OK |
| sqlite3 | 3.37.2 | OK |
| git | 2.34.1 | OK |
| nginx | 1.18.0 | OK |
| **rclone** | **не установлен** | ⚠️ доустановить (1 командой в §3) |

---

## Топология VPS 72.56.1.149

**Это НЕ боевой prod-сервер.** На нём — только staging-инстанс `clone.muziai.ru` плюс несвязанный сторонний проект `worldbeauty.su`.

| nginx vhost | server_name | pm2-процесс | путь | data.db | примечание |
|---|---|---|---|---|---|
| `muziai-clone` | `clone.muziai.ru` + bare IP `72.56.1.149` | `neurohub` (id 3) | `/var/www/neurohub/` | 3.9 МБ | Бэкенд clone. **Связка предполагается**, проверим prompt #2 |
| `worldbeauty` | `worldbeauty.su`, `www.worldbeauty.su` | `worldbeauty` (id 0) | `/var/www/worldbeauty/` | — | Отдельный проект Евгения, не v304 |
| — | — | — | `/var/www/anthropic-proxy/` | — | Прокси, не приложение |
| — | — | — | `/var/www/html/` | — | nginx default |

**.env-файлы** (только размеры, содержимое не читали):
- `/var/www/neurohub/.env` — 72 байта
- `/var/www/worldbeauty/backend/.env` — 315 байт

**Отсутствуют на этом сервере:** `podaripesnu.ru`, `muziai.ru` — они на ДРУГОМ VPS (IP получим от Евгения отдельно).

---

## pm2-процессы — состояние

| id | name | uptime | restart count | status | mem |
|---|---|---|---|---|---|
| 3 | **neurohub** | 16 ч | **30** ⚠️ | online | 229.9 MB |
| 0 | worldbeauty | 4 дня | 0 | online | 1.7 MB |

⚠️ **neurohub за 16 часов рестартился 30 раз** (~ каждые 30 минут). До старта Спринта 1 — изучить логи `pm2 logs neurohub --lines 200` и понять причину. Возможно: OOM, необработанные исключения, segfault SQLite.

---

## Ресурсы

- **Disk:** один том `/dev/sda1` 49 GiB, **используется 32 GiB (67%)**, свободно 17 GiB. Бэкапы и логи будут расти — следить.
- **Memory:** total 1.9 GiB, used 410 MiB, **free всего 102 MiB** (1.3 GiB в buff/cache доступно). На v304 со всеми плагинами + LLM-вызовы тонко. План: добавить swap 2 GiB на pre-Sprint 1 (см. PREFLIGHT.md §2).
- **Uptime:** 4 дня, load avg 0.16 — спокойно.

---

## Решения и операционные правки

1. **Операционный риск на 72.56.1.149 — НИЗКИЙ** (вопреки первоначальной модели):
   - Прода `podaripesnu.ru` / `muziai.ru` тут нет.
   - `worldbeauty.su` — сторонний проект; его пути и pm2-процесс трогать запрещено.
   - clone-инстанс — нормальная staging-площадка для v304-кодинга.
2. **Pre-Sprint 1 чек-лист сжимается до:**
   - [ ] Подтвердить связку `neurohub` ↔ `clone.muziai.ru` (prompt #2 ниже).
   - [ ] Установить rclone и настроить бэкапы `/var/www/neurohub/data.db` на Google Drive.
   - [ ] Понять, почему neurohub рестартится 30 раз/16 ч.
   - [ ] (Опционально, рекомендую) Добавить swap 2 GiB.
3. **podaripesnu.ru / muziai.ru** на другом VPS — IP получим от Евгения, повторим там аудит и операционные правила (тогда ужесточим: пятиуровневое предупреждение, ручной snapshot, окна минимальной нагрузки).

---

## Что НЕ трогаем на 72.56.1.149

- `/var/www/worldbeauty/` — сторонний проект Евгения.
- `/var/www/anthropic-proxy/` — proxy, кто-то использует.
- `/var/www/html/` — nginx default (можно очистить, но не сейчас).
- pm2-процесс `worldbeauty` — не наш.
- nginx vhost `worldbeauty` — не наш.

---

*Last updated: 2026-05-06*
