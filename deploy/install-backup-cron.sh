#!/bin/bash
# Eugene 2026-05-20: установщик ежедневного auto-backup через systemd timer.
#
# Запуск один раз: bash /opt/muziai-src/deploy/install-backup-cron.sh
#
# Что делает:
# 1. Копирует backup-no-mp3.sh → /usr/local/bin/neurohub-backup.sh
# 2. Создаёт systemd service + timer
# 3. Enable + start timer
# 4. Тестовый запуск
#
# Расписание: ежедневно 00:00 UTC (03:00 МСК — тихие часы).
# Ротация: 14 последних backup'ов (см. backup-no-mp3.sh).
# Логи: /var/log/neurohub-backup.log

set -e

SRC_REPO="${SRC_REPO:-/opt/muziai-src}"
SCRIPT_SRC="$SRC_REPO/deploy/backup-no-mp3.sh"
SCRIPT_DST="/usr/local/bin/neurohub-backup.sh"

if [ ! -f "$SCRIPT_SRC" ]; then
  echo "❌ $SCRIPT_SRC не найден. Сначала git pull в $SRC_REPO."
  exit 1
fi

echo "=== 1. Копирую скрипт в /usr/local/bin ==="
cp "$SCRIPT_SRC" "$SCRIPT_DST"
chmod +x "$SCRIPT_DST"
echo "  ✓ $SCRIPT_DST"

echo ""
echo "=== 2. Создаю systemd service ==="
cat > /etc/systemd/system/neurohub-backup.service <<'EOF'
[Unit]
Description=Neurohub daily backup (data.db + .env + authors/ без mp3)
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/neurohub-backup.sh
StandardOutput=append:/var/log/neurohub-backup.log
StandardError=append:/var/log/neurohub-backup.log
EOF
echo "  ✓ /etc/systemd/system/neurohub-backup.service"

echo ""
echo "=== 3. Создаю systemd timer (00:00 UTC = 03:00 МСК) ==="
cat > /etc/systemd/system/neurohub-backup.timer <<'EOF'
[Unit]
Description=Daily backup at 03:00 MSK (00:00 UTC)
Requires=neurohub-backup.service

[Timer]
OnCalendar=*-*-* 00:00:00 UTC
RandomizedDelaySec=300
Persistent=true
Unit=neurohub-backup.service

[Install]
WantedBy=timers.target
EOF
echo "  ✓ /etc/systemd/system/neurohub-backup.timer"

echo ""
echo "=== 4. Reload + enable + start ==="
systemctl daemon-reload
systemctl enable --now neurohub-backup.timer
echo "  ✓ timer enabled + started"

echo ""
echo "=== 5. Тестовый запуск (создаст backup прямо сейчас) ==="
systemctl start neurohub-backup.service
sleep 2
echo "  ✓ test run done"

echo ""
echo "=== 6. Статус ==="
systemctl status neurohub-backup.timer --no-pager | head -12
echo ""
echo "=== 7. Последние backup'ы ==="
ls -lt /var/backups/neurohub-manual/nomp3-*.tar.gz 2>/dev/null | head -5

echo ""
echo "=== DONE ==="
echo ""
echo "Backup будет создаваться каждый день в 03:00 МСК."
echo ""
echo "Команды:"
echo "  systemctl list-timers neurohub-backup.timer    # когда следующий запуск"
echo "  systemctl start neurohub-backup.service        # запуск backup сейчас"
echo "  bash $SCRIPT_DST                               # ручной запуск (без systemd)"
echo "  ls -lh /var/backups/neurohub-manual/           # список backup'ов"
echo "  tail -20 /var/log/neurohub-backup.log          # логи"
