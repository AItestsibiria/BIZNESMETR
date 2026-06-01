#!/usr/bin/env bash
# Encrypted FULL backup для muzaai.ru — закрытая от всех копия данных.
#
# Что в backup:
#   - data.db (SQLite, через .backup snapshot)
#   - authors/<uid>/gen_*.{mp3,jpg} (все треки + обложки)
#   - .env (БЕЗ BACKUP_PASSPHRASE — это значение хранится отдельно у Босса)
#   - manifest.txt — sha256 + размеры + метаданные
#
# Pipeline:
#   1. sqlite3 .backup (consistent snapshot)
#   2. cp .env → .env.scrubbed (вырезается BACKUP_PASSPHRASE строка)
#   3. tar gzip (data.db + .env.scrubbed + authors/ + manifest)
#   4. gpg --symmetric --cipher-algo AES256
#   5. Upload в Telegram self-chat если < 50MB иначе skip
#   6. Локальная копия в /var/backups/neurohub-encrypted/ (TTL 30 дней)
#   7. Логи в /var/log/neurohub-backup-encrypted.log
#
# Запуск:
#   - Cron еженедельно (Sunday 04:00 MSK = 01:00 UTC) — DB-only режим
#   - Manual full: FULL_BACKUP=1 BACKUP_PASSPHRASE=... /usr/local/bin/backup-encrypted.sh
#   - Manual db-only: BACKUP_PASSPHRASE=... /usr/local/bin/backup-encrypted.sh
#
# Восстановление: deploy/restore-encrypted-backup.sh

set -euo pipefail

export HOME="${HOME:-/root}"

APP_DIR="${APP_DIR:-/var/www/neurohub}"
DB_FILE="${DB_FILE:-$APP_DIR/data.db}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
AUTHORS_DIR="${AUTHORS_DIR:-$APP_DIR/authors}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/neurohub-encrypted}"
LOG_FILE="${LOG_FILE:-/var/log/neurohub-backup-encrypted.log}"
LOCK_FILE="${LOCK_FILE:-/var/run/neurohub-backup-encrypted.lock}"
TTL_DAYS="${TTL_DAYS:-30}"
FULL_BACKUP="${FULL_BACKUP:-0}"
TG_LIMIT_BYTES="${TG_LIMIT_BYTES:-52428800}"

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG_FILE" >&2; }

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "Already running, exit"
  exit 0
fi

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"

if [[ -z "${BACKUP_PASSPHRASE:-}" ]] && [[ -f "$ENV_FILE" ]]; then
  BACKUP_PASSPHRASE="$(grep "^BACKUP_PASSPHRASE=" "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
fi

if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then
  log "ERROR: BACKUP_PASSPHRASE not set (env or $ENV_FILE)"
  exit 1
fi

if [[ ! -f "$DB_FILE" ]]; then
  log "ERROR: DB file not found: $DB_FILE"
  exit 1
fi

STAMP="$(date -u +'%Y%m%d-%H%M%S')"
WORK_DIR="$(mktemp -d -t backup-encrypted-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

MODE_LABEL="db-only"
[[ "$FULL_BACKUP" == "1" ]] && MODE_LABEL="full"

log "=== Encrypted backup start: $STAMP (mode: $MODE_LABEL) ==="

# 1. SQLite consistent snapshot
log "Step 1: sqlite3 .backup snapshot..."
DB_SNAPSHOT="$WORK_DIR/data.db"
sqlite3 "$DB_FILE" ".backup '$DB_SNAPSHOT'"
DB_SIZE="$(stat -c%s "$DB_SNAPSHOT")"
DB_SHA="$(sha256sum "$DB_SNAPSHOT" | cut -d' ' -f1)"
log "  snapshot: $DB_SIZE bytes, sha256=$DB_SHA"

# 2. Scrub .env (вырезаем BACKUP_PASSPHRASE — хранится отдельно у Босса)
ENV_SCRUBBED="$WORK_DIR/.env"
ENV_SHA=""
ENV_SIZE=0
if [[ -f "$ENV_FILE" ]]; then
  grep -v "^BACKUP_PASSPHRASE=" "$ENV_FILE" > "$ENV_SCRUBBED" || true
  chmod 600 "$ENV_SCRUBBED"
  ENV_SIZE="$(stat -c%s "$ENV_SCRUBBED")"
  ENV_SHA="$(sha256sum "$ENV_SCRUBBED" | cut -d' ' -f1)"
  log "Step 2: .env scrubbed ($ENV_SIZE bytes, без BACKUP_PASSPHRASE)"
else
  log "Step 2: .env не найден — пропускаю"
fi

# 3. Authors/ если FULL_BACKUP=1
AUTHORS_SIZE=0
AUTHORS_FILES=0
if [[ "$FULL_BACKUP" == "1" ]] && [[ -d "$AUTHORS_DIR" ]]; then
  AUTHORS_SIZE="$(du -sb "$AUTHORS_DIR" 2>/dev/null | cut -f1)"
  AUTHORS_FILES="$(find "$AUTHORS_DIR" -type f 2>/dev/null | wc -l)"
  log "Step 3: authors/ — $AUTHORS_FILES files, $AUTHORS_SIZE bytes"
  cp -a "$AUTHORS_DIR" "$WORK_DIR/authors"
else
  log "Step 3: authors/ SKIP (FULL_BACKUP=0)"
fi

# 4. Manifest
MANIFEST="$WORK_DIR/manifest.txt"
cat > "$MANIFEST" <<EOF
backup_timestamp: $(ts)
backup_mode: $MODE_LABEL
hostname: $(hostname)
source_db: $DB_FILE
db_size_bytes: $DB_SIZE
db_sha256: $DB_SHA
env_size_bytes: $ENV_SIZE
env_sha256: $ENV_SHA
env_note: BACKUP_PASSPHRASE removed before encryption — store it separately
authors_dir: $AUTHORS_DIR
authors_size_bytes: $AUTHORS_SIZE
authors_files: $AUTHORS_FILES
sqlite_version: $(sqlite3 --version | head -1)
EOF

# 5. tar + gzip
log "Step 4: tar + gzip..."
TAR_FILE="$WORK_DIR/backup-$STAMP.tar.gz"
TAR_INCLUDES=("data.db" "manifest.txt")
[[ -f "$ENV_SCRUBBED" ]] && TAR_INCLUDES+=(".env")
[[ -d "$WORK_DIR/authors" ]] && TAR_INCLUDES+=("authors")
tar -czf "$TAR_FILE" -C "$WORK_DIR" "${TAR_INCLUDES[@]}"
TAR_SIZE="$(stat -c%s "$TAR_FILE")"
log "  tar: $TAR_SIZE bytes ($(echo "$TAR_SIZE" | awk '{printf "%.1f", $1/1048576}') MB)"

# 6. GPG symmetric AES256
log "Step 5: gpg --symmetric --cipher-algo AES256..."
ENCRYPTED_FILE="$BACKUP_ROOT/backup-$MODE_LABEL-$STAMP.tar.gz.gpg"
echo "$BACKUP_PASSPHRASE" | gpg --batch --yes --passphrase-fd 0 \
  --symmetric --cipher-algo AES256 \
  --output "$ENCRYPTED_FILE" \
  "$TAR_FILE"
chmod 600 "$ENCRYPTED_FILE"
ENC_SIZE="$(stat -c%s "$ENCRYPTED_FILE")"
ENC_SHA="$(sha256sum "$ENCRYPTED_FILE" | cut -d' ' -f1)"
ENC_MB="$(echo "$ENC_SIZE" | awk '{printf "%.1f", $1/1048576}')"
log "  encrypted: $ENC_SIZE bytes ($ENC_MB MB), sha256=$ENC_SHA"
log "  saved: $ENCRYPTED_FILE"

# 7. Upload в Telegram self-chat
TG_TOK="$(grep "^TELEGRAM_BOT_TOKEN=" "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
TG_CHAT="$(grep "^ADMIN_TELEGRAM_ID=" "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
BACKUP_TG_CHAT="$(grep "^BACKUP_TELEGRAM_CHAT_ID=" "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
[[ -n "$BACKUP_TG_CHAT" ]] && TG_CHAT="$BACKUP_TG_CHAT"

if [[ -n "$TG_TOK" && -n "$TG_CHAT" && "$ENC_SIZE" -lt "$TG_LIMIT_BYTES" ]]; then
  log "Step 6: Telegram upload..."
  CAPTION="🔒 Encrypted $MODE_LABEL backup
Stamp: $STAMP
DB: $DB_SIZE bytes (sha256: ${DB_SHA:0:16}…)
Authors: $AUTHORS_FILES files, $AUTHORS_SIZE bytes
Encrypted: $ENC_MB MB
AES256 · passphrase ONLY у Босса"
  if curl -sS -m 120 \
    -F "chat_id=$TG_CHAT" \
    -F "document=@$ENCRYPTED_FILE" \
    -F "caption=$CAPTION" \
    "https://api.telegram.org/bot$TG_TOK/sendDocument" >/dev/null 2>&1; then
    log "  Telegram upload OK"
  else
    log "  Telegram upload FAILED (но локальная копия есть)"
  fi
else
  if [[ "$ENC_SIZE" -ge "$TG_LIMIT_BYTES" ]]; then
    log "Step 6: SKIP Telegram (file $ENC_MB MB > 50MB bot limit) — только локальная копия"
  else
    log "Step 6: SKIP Telegram (no TELEGRAM_BOT_TOKEN/CHAT_ID)"
  fi
fi

# 8. TTL cleanup
log "Step 7: cleanup older than $TTL_DAYS days..."
DELETED=$(find "$BACKUP_ROOT" -name 'backup-*.tar.gz.gpg' -type f -mtime "+$TTL_DAYS" -delete -print | wc -l)
log "  deleted $DELETED old backups"

COUNT=$(find "$BACKUP_ROOT" -name 'backup-*.tar.gz.gpg' -type f | wc -l)
TOTAL_SIZE=$(du -sb "$BACKUP_ROOT" 2>/dev/null | cut -f1)
log "=== Backup OK: $COUNT files in $BACKUP_ROOT ($TOTAL_SIZE bytes total) ==="

exit 0
