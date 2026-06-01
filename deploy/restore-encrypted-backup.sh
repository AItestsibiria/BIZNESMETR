#!/usr/bin/env bash
# Restore encrypted DB backup для muzaai.ru.
#
# Usage:
#   BACKUP_PASSPHRASE='...' /usr/local/bin/restore-encrypted-backup.sh /path/to/backup-YYYYMMDD-HHMMSS.tar.gz.gpg
#   или
#   BACKUP_PASSPHRASE='...' /usr/local/bin/restore-encrypted-backup.sh latest
#
# Pipeline:
#   1. gpg --decrypt → tar.gz во временной директории
#   2. tar -xzf → data.db + manifest.txt
#   3. Verify sha256 из manifest совпадает
#   4. SHOW manifest, ASK confirmation (если TTY)
#   5. Backup текущий data.db в /var/backups/neurohub-encrypted/pre-restore-...
#   6. pm2 stop neurohub
#   7. Заменить data.db
#   8. pm2 start neurohub
#   9. Verify integrity_check на восстановленной БД
#
# Безопасность:
#   - passphrase ТОЛЬКО в env
#   - pre-restore snapshot текущей БД (на случай ошибки)
#   - pm2 stop перед заменой (избегаем corruption)

set -euo pipefail

export HOME="${HOME:-/root}"

APP_DIR="${APP_DIR:-/var/www/neurohub}"
DB_FILE="${DB_FILE:-$APP_DIR/data.db}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/neurohub-encrypted}"
PM2_NAME="${PM2_NAME:-neurohub}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <backup-file.tar.gz.gpg | latest>"
  echo ""
  echo "Available backups in $BACKUP_ROOT:"
  ls -lh "$BACKUP_ROOT"/backup-*.tar.gz.gpg 2>/dev/null | tail -10 || echo "  (none)"
  exit 1
fi

INPUT="$1"

# Resolve "latest" → newest .gpg в BACKUP_ROOT
if [[ "$INPUT" == "latest" ]]; then
  BACKUP_FILE="$(ls -t "$BACKUP_ROOT"/backup-*.tar.gz.gpg 2>/dev/null | head -1)"
  if [[ -z "$BACKUP_FILE" ]]; then
    echo "ERROR: no backups found in $BACKUP_ROOT"
    exit 1
  fi
  echo "Using latest: $BACKUP_FILE"
else
  BACKUP_FILE="$INPUT"
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "ERROR: backup file not found: $BACKUP_FILE"
  exit 1
fi

# Load passphrase from env or .env
if [[ -z "${BACKUP_PASSPHRASE:-}" ]] && [[ -f "$APP_DIR/.env" ]]; then
  BACKUP_PASSPHRASE="$(grep "^BACKUP_PASSPHRASE=" "$APP_DIR/.env" 2>/dev/null | cut -d= -f2-)"
fi

if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then
  echo "ERROR: BACKUP_PASSPHRASE not set"
  exit 1
fi

WORK_DIR="$(mktemp -d -t restore-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "=== Decrypt + verify ==="
echo "$BACKUP_PASSPHRASE" | gpg --batch --yes --passphrase-fd 0 \
  --decrypt \
  --output "$WORK_DIR/backup.tar.gz" \
  "$BACKUP_FILE"

tar -xzf "$WORK_DIR/backup.tar.gz" -C "$WORK_DIR"

if [[ ! -f "$WORK_DIR/data.db" ]] || [[ ! -f "$WORK_DIR/manifest.txt" ]]; then
  echo "ERROR: backup malformed — missing data.db or manifest.txt"
  exit 1
fi

EXPECTED_SHA="$(grep '^db_sha256:' "$WORK_DIR/manifest.txt" | cut -d' ' -f2)"
ACTUAL_SHA="$(sha256sum "$WORK_DIR/data.db" | cut -d' ' -f1)"

if [[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
  echo "ERROR: sha256 mismatch — backup corrupted!"
  echo "  expected: $EXPECTED_SHA"
  echo "  actual:   $ACTUAL_SHA"
  exit 1
fi

echo ""
echo "=== Manifest ==="
cat "$WORK_DIR/manifest.txt"
echo ""
echo "=== Target: $DB_FILE ==="
ls -lh "$DB_FILE" 2>/dev/null || echo "(current DB не существует)"
echo ""

if [[ -t 0 ]] && [[ "${ASSUME_YES:-0}" != "1" ]]; then
  read -rp "Заменить текущую БД? [yes/NO]: " ANSWER
  if [[ "$ANSWER" != "yes" ]]; then
    echo "Отменено."
    exit 0
  fi
fi

echo "=== Pre-restore snapshot текущей БД ==="
PRE_SNAPSHOT="$BACKUP_ROOT/pre-restore-$(date -u +'%Y%m%d-%H%M%S').db"
mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
if [[ -f "$DB_FILE" ]]; then
  sqlite3 "$DB_FILE" ".backup '$PRE_SNAPSHOT'"
  chmod 600 "$PRE_SNAPSHOT"
  echo "  saved: $PRE_SNAPSHOT"
fi

echo "=== Stop pm2 ==="
pm2 stop "$PM2_NAME" || true

echo "=== Replace DB ==="
cp "$WORK_DIR/data.db" "$DB_FILE"
chmod 644 "$DB_FILE"
chown -R "$(stat -c '%U:%G' "$APP_DIR")" "$DB_FILE" 2>/dev/null || true

echo "=== Integrity check ==="
INTEGRITY="$(sqlite3 "$DB_FILE" 'PRAGMA integrity_check;' | head -1)"
if [[ "$INTEGRITY" != "ok" ]]; then
  echo "ERROR: integrity_check FAILED: $INTEGRITY"
  echo "Восстанавливаю предыдущую БД из pre-restore snapshot..."
  cp "$PRE_SNAPSHOT" "$DB_FILE"
  pm2 start "$PM2_NAME" --update-env
  exit 1
fi
echo "  integrity_check: OK"

echo "=== Start pm2 ==="
pm2 start "$PM2_NAME" --update-env || pm2 restart "$PM2_NAME" --update-env

echo ""
echo "✅ Restore complete. Previous DB: $PRE_SNAPSHOT"
