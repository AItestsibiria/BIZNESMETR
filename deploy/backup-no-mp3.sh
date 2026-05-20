#!/bin/bash
# Eugene 2026-05-20 Босс «cron авто-backup, без mp3».
#
# Ежедневный backup data.db + .env + authors/ (без mp3).
# Ротация — хранит последние BACKUP_KEEP штук (default 14).
# Запускается systemd timer neurohub-backup.timer (см. install-backup-cron.sh).
#
# Ручной запуск: bash /opt/muziai-src/deploy/backup-no-mp3.sh
# Логи: /var/log/neurohub-backup.log

set +e

# === Конфигурация ===
APP_DIR="${APP_DIR:-/var/www/neurohub}"
DEST="${BACKUP_DEST:-/var/backups/neurohub-manual}"
KEEP="${BACKUP_KEEP:-14}"
LOG="/var/log/neurohub-backup.log"
SRC_REPO="/opt/muziai-src"

# === Подготовка ===
mkdir -p "$DEST"
# Eugene 2026-05-20 Босс: формат имени «MuzaAi-Triumph-DDMMYY-HHMM.tar.gz»
# (consistent с Triumph-tag rule).
TS=$(date +%d%m%y-%H%M)
SHA=$(cd "$SRC_REPO" 2>/dev/null && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
OUTFILE="$DEST/MuzaAi-Triumph-$TS.tar.gz"

cd "$APP_DIR" || { echo "[$(date -u +%FT%TZ)] FAIL: $APP_DIR не найден" >> "$LOG"; exit 1; }

# === Backup ===
# Включаем: data.db (БД), .env (секреты), authors/ (обложки и meta — БЕЗ mp3)
# Исключаем: *.mp3, node_modules, dist, .git
tar --exclude='*.mp3' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.git' \
    --exclude='*.tmp' \
    -czf "$OUTFILE" \
    data.db .env authors/ 2>/dev/null

if [ ! -f "$OUTFILE" ] || [ ! -s "$OUTFILE" ]; then
  echo "[$(date -u +%FT%TZ)] FAIL: tar не создал $OUTFILE" >> "$LOG"
  exit 1
fi

SIZE=$(du -h "$OUTFILE" | cut -f1)
COUNT=$(tar -tzf "$OUTFILE" 2>/dev/null | wc -l)
echo "[$(date -u +%FT%TZ)] OK: $OUTFILE ($SIZE, $COUNT файлов, sha=$SHA)" >> "$LOG"

# === Ротация — удаляем старше KEEP ===
KEPT=$(ls -t "$DEST"/MuzaAi-Triumph-*.tar.gz 2>/dev/null | wc -l)
if [ "$KEPT" -gt "$KEEP" ]; then
  TO_DELETE=$(ls -t "$DEST"/MuzaAi-Triumph-*.tar.gz | tail -n +$((KEEP+1)))
  for f in $TO_DELETE; do
    rm -f "$f"
    echo "[$(date -u +%FT%TZ)] ROTATED: удалил $f" >> "$LOG"
  done
fi

# === Итоговая статистика в stdout (видно при ручном запуске) ===
echo "✓ Backup создан: $OUTFILE ($SIZE, $COUNT файлов)"
echo "✓ Всего backup'ов: $(ls -1 $DEST/MuzaAi-Triumph-*.tar.gz 2>/dev/null | wc -l) (keep=$KEEP)"
echo "✓ Total size: $(du -sh $DEST 2>/dev/null | cut -f1)"
echo "✓ Log: $LOG"
