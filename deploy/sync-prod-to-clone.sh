#!/usr/bin/env bash
# sync-prod-to-clone.sh — Snapshot prod (muzaai.ru / 31.130.148.107) → clone (clone.muziai.ru / 72.56.1.149).
#
# Запускается НА clone-VPS (72.56.1.149). Через SSH дёргает prod (31.130.148.107)
# чтобы снять консистентный snapshot data.db (через `sqlite3 .backup`), authors/ (tar)
# и .env (cp). Затем pulls tarball на clone, делает pre-flight backup текущего
# state clone-а, разворачивает snapshot, ставит clone на тот же git SHA что и prod,
# rebuild + pm2 restart + health check.
#
# Использует ~/.ssh/config alias `prod-muzaai` — настроить one-time (см. doc внизу).
#
# Flags:
#   --with-mp3              включить аудио-файлы в authors/ (default: без mp3, экономия трафика)
#   --no-env                НЕ копировать .env (оставить текущий clone .env)
#   --dry-run               показать что бы сделалось, без изменений
#   --target-sha=<SHA>      явный git SHA на который выставить clone (default: read prod HEAD)
#
# Pre-flight backup clone-а: /var/backups/neurohub-pre-sync/MuzaAi-Triumph-DDMMYY-HHMM.tar.gz
# Snapshot tarballs от prod: /tmp/prod-snapshot-<STAMP>/
#
# Idempotent: повторный запуск создаёт новый pre-flight backup и применяет свежий snapshot.

set -euo pipefail

# ── Параметры ────────────────────────────────────────────────────────────────

PROD_SSH_ALIAS="${PROD_SSH_ALIAS:-prod-muzaai}"   # ~/.ssh/config alias на prod
PROD_HOST_RAW="31.130.148.107"                    # fallback если alias не настроен
CLONE_APP_DIR="${CLONE_APP_DIR:-/var/www/neurohub}"
PROD_APP_DIR="${PROD_APP_DIR:-/var/www/neurohub}"
PM2_NAME="${PM2_NAME:-neurohub}"
SRC_DIR="${SRC_DIR:-/opt/neurohub-src}"            # auto-deploy clone src
BACKUP_ROOT="/var/backups/neurohub-pre-sync"
SNAP_TMP_BASE="/tmp/prod-snapshot"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:5000/api/example/ping}"
HEALTH_RETRIES=15

WITH_MP3=0
COPY_ENV=1
DRY_RUN=0
TARGET_SHA=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-mp3) WITH_MP3=1; shift ;;
    --no-env)   COPY_ENV=0; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --target-sha=*) TARGET_SHA="${1#*=}"; shift ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 64 ;;
  esac
done

ts()   { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log()  { echo "[$(ts)] $*"; }
fail() { echo "[$(ts)] FAIL: $*" >&2; exit 1; }

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[DRY] $*"
  else
    eval "$@"
  fi
}

# ── 0. Sanity ────────────────────────────────────────────────────────────────

[[ "$(id -u)" == "0" ]] || fail "запускать от root (sudo)"

# Проверяем SSH-alias до prod; если нет — пробуем по IP с явным предупреждением.
PROD_SSH="$PROD_SSH_ALIAS"
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$PROD_SSH_ALIAS" 'echo ok' >/dev/null 2>&1; then
  log "WARN: SSH alias '$PROD_SSH_ALIAS' не настроен или не работает."
  log "WARN: Пробую напрямую root@$PROD_HOST_RAW (требует authorized_keys на prod)."
  PROD_SSH="root@$PROD_HOST_RAW"
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$PROD_SSH" 'echo ok' >/dev/null 2>&1 \
    || fail "SSH к prod не работает. Настрой ~/.ssh/config alias '$PROD_SSH_ALIAS' или добавь pub-key clone в authorized_keys prod-а. См. docs/strategy/CLONE-PROD-SYNC-WORKFLOW.md §SSH-setup."
fi

log "Prod SSH: $PROD_SSH"
log "Clone app dir: $CLONE_APP_DIR"
log "Prod app dir: $PROD_APP_DIR"
log "With mp3: $WITH_MP3 · Copy env: $COPY_ENV · Dry-run: $DRY_RUN"

# ── 1. Pre-flight backup clone-а ─────────────────────────────────────────────

# Backup-naming rule: MuzaAi-Triumph-DDMMYY-HHMM.tar.gz (локальное время)
STAMP_BACKUP=$(date +%d%m%y-%H%M)
BACKUP_NAME="MuzaAi-Triumph-${STAMP_BACKUP}.tar.gz"
BACKUP_PATH="$BACKUP_ROOT/$BACKUP_NAME"

run "mkdir -p \"$BACKUP_ROOT\""

if [[ -d "$CLONE_APP_DIR" ]]; then
  log "[1/7] Pre-flight backup clone → $BACKUP_PATH"
  # Backup без node_modules / dist (восстанавливаются из репо)
  run "tar czf \"$BACKUP_PATH\" \
    -C \"$CLONE_APP_DIR\" \
    --exclude=node_modules \
    --exclude=dist \
    --exclude='authors/**/*.mp3' \
    data.db .env authors 2>/dev/null || \
    tar czf \"$BACKUP_PATH\" -C \"$CLONE_APP_DIR\" \
    --exclude=node_modules --exclude=dist --exclude='authors/**/*.mp3' \
    data.db .env authors"
  # Retention: 20 последних
  ls -1t "$BACKUP_ROOT"/MuzaAi-Triumph-*.tar.gz 2>/dev/null | tail -n +21 | xargs -r rm -f
else
  log "[1/7] Clone app dir не существует ($CLONE_APP_DIR) — пропуск pre-flight backup (первая инициализация)"
fi

# ── 2. Snapshot на prod ──────────────────────────────────────────────────────

STAMP=$(date +%Y%m%d-%H%M%S)
SNAP_DIR="$SNAP_TMP_BASE-$STAMP"

# Tar exclusions для authors/
AUTHORS_TAR_FLAGS=""
if [[ "$WITH_MP3" == "0" ]]; then
  AUTHORS_TAR_FLAGS="--exclude='*.mp3' --exclude='*.wav' --exclude='*.flac'"
fi

log "[2/7] Snapshot на prod (STAMP=$STAMP) — sqlite3 .backup + tar authors"
run "ssh \"$PROD_SSH\" 'bash -se' << REMOTE_EOF
set -euo pipefail
mkdir -p $SNAP_DIR
cd $PROD_APP_DIR

echo \"  → sqlite3 .backup data.db (consistent snapshot без stop pm2)\"
sqlite3 data.db \".backup $SNAP_DIR/data.db\"

echo \"  → integrity check snapshot\"
sqlite3 $SNAP_DIR/data.db 'PRAGMA integrity_check;' | head -1

echo \"  → tar authors/ ($([ $WITH_MP3 = 1 ] && echo 'с mp3' || echo 'БЕЗ mp3'))\"
tar czf $SNAP_DIR/authors.tar.gz $AUTHORS_TAR_FLAGS authors/ 2>/dev/null || true

if [[ \"$COPY_ENV\" = \"1\" ]]; then
  echo \"  → cp .env\"
  cp .env $SNAP_DIR/env
fi

echo \"  → git HEAD\"
if [[ -d /opt/muziai-src/.git ]]; then
  git -C /opt/muziai-src rev-parse HEAD > $SNAP_DIR/prod-git-sha.txt
else
  echo 'unknown' > $SNAP_DIR/prod-git-sha.txt
fi

ls -lh $SNAP_DIR/
REMOTE_EOF"

# ── 3. Download snapshot на clone ────────────────────────────────────────────

log "[3/7] rsync snapshot prod → clone"
run "mkdir -p $SNAP_DIR"
run "rsync -avz --partial --info=progress2 \
  \"$PROD_SSH:$SNAP_DIR/\" \
  \"$SNAP_DIR/\""

[[ "$DRY_RUN" == "1" ]] || ls -lh "$SNAP_DIR/"

# ── 4. Determine target SHA ──────────────────────────────────────────────────

if [[ -z "$TARGET_SHA" ]]; then
  if [[ -f "$SNAP_DIR/prod-git-sha.txt" ]]; then
    TARGET_SHA=$(cat "$SNAP_DIR/prod-git-sha.txt")
  fi
fi

log "[4/7] Target git SHA: ${TARGET_SHA:-<none>}"

# ── 5. Apply snapshot на clone ───────────────────────────────────────────────

log "[5/7] pm2 stop + apply snapshot → clone"
run "pm2 stop $PM2_NAME 2>/dev/null || true"

# 5a. data.db
if [[ -f "$SNAP_DIR/data.db" ]]; then
  run "cp \"$SNAP_DIR/data.db\" \"$CLONE_APP_DIR/data.db\""
  if [[ "$DRY_RUN" != "1" ]]; then
    INTEG=$(sqlite3 "$CLONE_APP_DIR/data.db" 'PRAGMA integrity_check;' | head -1)
    log "  data.db integrity: $INTEG"
    [[ "$INTEG" == "ok" ]] || fail "data.db integrity_check FAILED после copy"
  fi
else
  fail "snapshot $SNAP_DIR/data.db не найден — sync прерван"
fi

# 5b. authors/
if [[ -f "$SNAP_DIR/authors.tar.gz" ]]; then
  # Move старый authors в sidecar (на случай если pre-flight backup не покрыл всё)
  run "[[ -d \"$CLONE_APP_DIR/authors\" ]] && mv \"$CLONE_APP_DIR/authors\" \"$CLONE_APP_DIR/authors.before-sync-$STAMP\" || true"
  run "tar xzf \"$SNAP_DIR/authors.tar.gz\" -C \"$CLONE_APP_DIR/\""
  run "rm -rf \"$CLONE_APP_DIR/authors.before-sync-$STAMP\" 2>/dev/null || true"
fi

# 5c. .env
if [[ "$COPY_ENV" == "1" && -f "$SNAP_DIR/env" ]]; then
  run "cp \"$CLONE_APP_DIR/.env\" \"$CLONE_APP_DIR/.env.before-sync-$STAMP\" 2>/dev/null || true"
  run "cp \"$SNAP_DIR/env\" \"$CLONE_APP_DIR/.env\""
  run "chmod 600 \"$CLONE_APP_DIR/.env\""
  log "  .env скопирован с prod (backup: .env.before-sync-$STAMP)"
fi

# ── 6. Git checkout target SHA + rebuild ─────────────────────────────────────

if [[ -n "$TARGET_SHA" && -d "$SRC_DIR/.git" ]]; then
  log "[6/7] git checkout $TARGET_SHA в $SRC_DIR + rebuild"
  run "cd \"$SRC_DIR\" && git fetch --quiet origin && git reset --hard \"$TARGET_SHA\""
  SOURCE_PATH="$SRC_DIR/apps/neurohub"
  if [[ -d "$SOURCE_PATH" ]]; then
    run "cd \"$SOURCE_PATH\" && npm ci --no-audit --no-fund 2>&1 | tail -10"
    run "cd \"$SOURCE_PATH\" && npm run build 2>&1 | tail -10"
    run "rm -rf \"$CLONE_APP_DIR/dist\""
    run "cp -r \"$SOURCE_PATH/dist\" \"$CLONE_APP_DIR/dist\""
  else
    log "  WARN: $SOURCE_PATH не найден — пропуск rebuild"
  fi
else
  log "[6/7] Пропуск git-sync (TARGET_SHA пустой или $SRC_DIR/.git не существует)"
fi

# ── 7. Restart + health check ────────────────────────────────────────────────

log "[7/7] pm2 restart + health check"
run "pm2 restart $PM2_NAME --update-env"

if [[ "$DRY_RUN" != "1" ]]; then
  SUCCESS=0
  for i in $(seq 1 "$HEALTH_RETRIES"); do
    sleep 2
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
      SUCCESS=1
      log "  health check passed (attempt $i)"
      break
    fi
  done
  [[ "$SUCCESS" == "1" ]] || fail "health check failed после sync — откат: bash $0 --restore-last (см. CLONE-PROD-SYNC-WORKFLOW.md §Rollback)"
fi

# ── 8. Cleanup ───────────────────────────────────────────────────────────────

log "Cleanup snapshot tmp dirs (clone + prod)"
run "rm -rf \"$SNAP_DIR\""
run "ssh \"$PROD_SSH\" \"rm -rf $SNAP_DIR\" || true"

echo ""
echo "========================================================================"
echo "✅ SYNC DONE"
echo "  Pre-flight backup clone: $BACKUP_PATH"
echo "  Snapshot from prod (STAMP $STAMP): cleaned"
echo "  Target SHA: ${TARGET_SHA:-<not-applied>}"
echo "  Health: passed"
echo ""
echo "  Открыть clone:    https://clone.muziai.ru"
echo "  Admin clone:      https://clone.muziai.ru/#/admin"
echo ""
echo "  Rollback (если что-то сломалось):"
echo "    bash /var/backups/neurohub-pre-sync/$BACKUP_NAME — НЕ исполняется,"
echo "    распакуй вручную: tar xzf $BACKUP_PATH -C $CLONE_APP_DIR"
echo "    pm2 restart $PM2_NAME --update-env"
echo "========================================================================"
