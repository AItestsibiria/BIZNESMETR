# Установка auto-deploy на clone (одноразовая)

> Это **один prompt**, копируется один раз в Perplexity. Он ставит systemd-таймер, который сам забирает изменения с git каждую минуту. **После этого Perplexity для деплоев больше не нужен.**

---

## Prompt для Perplexity

```
Привет. Установи на VPS 72.56.1.149 auto-deploy для clone.muziai.ru.
Это одноразовая операция — после неё деплой будет автоматическим.

⚠️ КРИТИЧНО
- Меняем ТОЛЬКО clone. Производственные сайты podaripesnu.ru / muziai.ru
  на ДРУГОМ VPS, их не касаемся.
- Перед каждой командой — пятиуровневое предупреждение и явное "да" Евгения.

ЭТАП 1 — Проверь что нет конфликтов

ssh root@72.56.1.149 '
  systemctl status neurohub-auto-deploy.timer 2>/dev/null && echo "ALREADY INSTALLED" || echo "ok to install"
  ls /opt/neurohub-src 2>/dev/null && echo "SRC EXISTS" || echo "ok"
  test -x /usr/local/bin/neurohub-auto-deploy.sh && echo "SCRIPT EXISTS" || echo "ok"
'

Если хоть где-то "ALREADY INSTALLED" / "EXISTS" — СТОП и спроси Евгения,
переустанавливать или нет.

ЭТАП 2 — Скачай deploy-скрипт из репо

ssh root@72.56.1.149 '
  set -e
  curl -fsSL \
    "https://raw.githubusercontent.com/AItestsibiria/biznesmetr/claude/add-claude-documentation-OW5V7/deploy/auto-deploy.sh" \
    -o /usr/local/bin/neurohub-auto-deploy.sh
  chmod +x /usr/local/bin/neurohub-auto-deploy.sh
  head -5 /usr/local/bin/neurohub-auto-deploy.sh
  ls -lh /usr/local/bin/neurohub-auto-deploy.sh
'

Если raw.githubusercontent вернул 404 — репо приватный, скажи мне, и я
дам тебе альтернативный URL или Евгений положит файл через scp.

ЭТАП 3 — Создай systemd unit + timer

ssh root@72.56.1.149 '
  cat > /etc/systemd/system/neurohub-auto-deploy.service <<EOF
[Unit]
Description=Auto-deploy clone.muziai.ru from git
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/neurohub-auto-deploy.sh
Nice=10
TimeoutStartSec=600
EOF

  cat > /etc/systemd/system/neurohub-auto-deploy.timer <<EOF
[Unit]
Description=Run neurohub auto-deploy every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
Unit=neurohub-auto-deploy.service

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now neurohub-auto-deploy.timer
  systemctl status neurohub-auto-deploy.timer --no-pager | head -15
'

ЭТАП 4 — Дождись первого запуска и проверь

Подожди 90 секунд, потом:

ssh root@72.56.1.149 '
  echo "=== timer status ==="
  systemctl list-timers neurohub-auto-deploy.timer --no-pager

  echo "=== last run journal ==="
  journalctl -u neurohub-auto-deploy.service --no-pager -n 30

  echo "=== deploy log ==="
  tail -30 /var/log/neurohub-auto-deploy.log 2>/dev/null || echo "(no log yet)"

  echo "=== /opt/neurohub-src created? ==="
  ls -la /opt/neurohub-src 2>/dev/null | head -10

  echo "=== pm2 status ==="
  pm2 status neurohub
'

Должно быть видно:
  - Таймер активен (active running) и next запуск через ≤60 сек
  - В логе — "first run: cloning ..." потом "deploy OK: ..."
  - /opt/neurohub-src содержит чек-аут ветки
  - pm2 рестарт счётчик +1 от вчерашнего

ИТОГОВЫЙ ОТЧЁТ — пришли мне:

| Этап | Статус |
|---|---|
| 1. Проверка | OK / был конфликт |
| 2. Скрипт | OK / 404 от raw |
| 3. Systemd | OK / fail |
| 4. Первый запуск | OK / fail (с текстом ошибки) |

И пришли первые 50 строк /var/log/neurohub-auto-deploy.log.

ВСЁ. Дальше я (Claude) просто пушу в репо, и через минуту изменения на сервере.
Тебя (Perplexity) для деплоя больше беспокоить не буду.
```

---

## После установки — что делать с этим Perplexity

Ничего. Можно закрыть вкладку. Все будущие правки v304 идут через `git push` — auto-deploy.timer их подхватит.

**Если что-то сломается** (например, Sprint 2 build падает) — auto-deploy сам делает rollback к предыдущему `dist`, а в `/var/log/neurohub-auto-deploy.log` будет видно, на каком коммите упало.

## Как мне (Claude) узнать, что деплой прошёл

Скрипт пушит отчёты в отдельную ветку `clone-deploy-log`. Я проверяю её через `git fetch` + `git log origin/clone-deploy-log` и читаю последний `.md`. Без копипаста через чат.

## Как выключить, если что-то идёт не так

```bash
ssh root@72.56.1.149 'systemctl stop neurohub-auto-deploy.timer && systemctl disable neurohub-auto-deploy.timer'
```

Возвращаемся к ручному деплою (prompt #5).

---

*Last updated: 2026-05-06*
