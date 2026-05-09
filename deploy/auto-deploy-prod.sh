#!/usr/bin/env bash
# Auto-deploy для muziai.ru (PROD).
# Раз в минуту проверяет ветку claude/add-claude-documentation-OW5V7
# в репо AItestsibiria/BIZNESMETR. Если есть новые коммиты:
#   1. pre-flight backup текущего dist
#   2. git fetch + reset --hard в /opt/muziai-src
#   3. npm ci + npm run build
#   4. swap dist в /var/www/neurohub
#   5. pm2 restart neurohub
#   6. health check; при ошибке — авто-rollback из backup
#   7. лог в /var/log/neurohub-prod-auto-deploy.log
#
# Источник: AItestsibiria/BIZNESMETR (через локальный clone в /opt/muziai-src).
# Рестрикции:
#   - касается ТОЛЬКО /var/www/neurohub на 31.130.148.107 (prod muziai.ru).
#   - Telegram alert при rollback (если TELEGRAM_BOT_TOKEN + ADMIN_TELEGRAM_ID
#     есть в /var/www/neurohub/.env).
#   - подписан на единственную ветку — никакая другая не задеплоится.

set -euo pipefail

# pm2 + systemd ловушка: systemd запускает service без HOME, и pm2
# ищет daemon в /etc/.pm2 вместо /root/.pm2 — не находит процессов.
export HOME="${HOME:-/root}"
export PM2_HOME="${PM2_HOME:-/root/.pm2}"

REPO_URL="git@github.com:AItestsibiria/BIZNESMETR.git"
BRANCH="claude/add-claude-documentation-OW5V7"
SRC_DIR="/opt/muziai-src"
APP_DIR="/var/www/neurohub"
PM2_NAME="neurohub"
BACKUP_ROOT="/var/backups/neurohub-prod-auto"
LOG_FILE="/var/log/neurohub-prod-auto-deploy.log"
LOCK_FILE="/var/run/neurohub-prod-auto-deploy.lock"
HEALTH_URL="http://127.0.0.1:5000/api/example/ping"
HEALTH_RETRIES=15

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG_FILE" >&2; }

tg_alert() {
  local msg="$1"
  local TOK="$(grep "^TELEGRAM_BOT_TOKEN=" "$APP_DIR/.env" 2>/dev/null | cut -d= -f2-)"
  local CHAT="$(grep "^ADMIN_TELEGRAM_ID=" "$APP_DIR/.env" 2>/dev/null | cut -d= -f2-)"
  [[ -z "$TOK" || -z "$CHAT" ]] && return 0
  curl -sS -m 5 -X POST "https://api.telegram.org/bot$TOK/sendMessage" \
    --data-urlencode "chat_id=$CHAT" \
    --data-urlencode "text=🚨 muziai.ru auto-deploy: $msg" \
    >/dev/null 2>&1 || true
}

# Single-instance gate
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

# Первый запуск: клонируем (git@ — нужен SSH key для GitHub; обычно
# /root/.ssh/github_deploy уже настроен на prod).
if [[ ! -d "$SRC_DIR/.git" ]]; then
  log "first run: cloning $REPO_URL into $SRC_DIR"
  rm -rf "$SRC_DIR"
  git clone --branch "$BRANCH" --depth 50 "$REPO_URL" "$SRC_DIR"
fi

cd "$SRC_DIR"
git fetch --quiet origin "$BRANCH"
REMOTE=$(git rev-parse "origin/$BRANCH")

# Self-update FIRST
SCRIPT_PATH=$(readlink -f "$0")
REPO_SCRIPT_PATH="$SRC_DIR/deploy/auto-deploy-prod.sh"
if [[ -f "$REPO_SCRIPT_PATH" ]] && [[ "$SCRIPT_PATH" != "$REPO_SCRIPT_PATH" ]]; then
  if ! cmp -s "$SCRIPT_PATH" "$REPO_SCRIPT_PATH"; then
    log "self-update: script changed in repo, copying new version"
    cp "$REPO_SCRIPT_PATH" "$SCRIPT_PATH"
    chmod +x "$SCRIPT_PATH"
    log "self-update: done; next tick will run the new script"
    exit 0
  fi
fi

# SHA-tracking
DEPLOYED_SHA_FILE="$APP_DIR/.deployed-sha-prod"
DEPLOYED_SHA=$(cat "$DEPLOYED_SHA_FILE" 2>/dev/null || echo "")
if [[ "$DEPLOYED_SHA" == "$REMOTE" ]]; then
  exit 0
fi

LOCAL="$DEPLOYED_SHA"
log "deploy needed: deployed=${LOCAL:-<none>} → target=$REMOTE"
SHORT_BEFORE="${LOCAL:0:7}"
[[ -z "$SHORT_BEFORE" ]] && SHORT_BEFORE="initial"
SHORT_AFTER="${REMOTE:0:7}"

# 1. Pre-flight backup
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_ROOT"
BACKUP_FILE="$BACKUP_ROOT/dist-$TS-$SHORT_BEFORE.tar.gz"
if [[ -d "$APP_DIR/dist" ]]; then
  tar czf "$BACKUP_FILE" -C "$APP_DIR" dist
  log "backup: $BACKUP_FILE"
fi
ls -1t "$BACKUP_ROOT"/dist-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f

# 2. Sync to REMOTE
git reset --hard "$REMOTE" >/dev/null
git clean -fdq

# 3. Build из apps/neurohub/
SOURCE_PATH="$SRC_DIR/apps/neurohub"
if [[ ! -d "$SOURCE_PATH" ]]; then
  log "FAIL: $SOURCE_PATH not found"
  tg_alert "FAIL: $SOURCE_PATH not found in repo"
  exit 2
fi

cd "$SOURCE_PATH"

[[ -L node_modules ]] && unlink node_modules
[[ -d node_modules ]] && rm -rf node_modules

if [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund 2>&1 | tail -20 | tee -a "$LOG_FILE" >&2 || {
    log "FAIL: npm ci"
    tg_alert "FAIL: npm ci ($SHORT_BEFORE → $SHORT_AFTER)"
    exit 3
  }
else
  npm install --no-audit --no-fund 2>&1 | tail -20 | tee -a "$LOG_FILE" >&2 || {
    log "FAIL: npm install"
    tg_alert "FAIL: npm install ($SHORT_BEFORE → $SHORT_AFTER)"
    exit 3
  }
fi

npm run build 2>&1 | tail -30 | tee -a "$LOG_FILE" >&2 || {
  log "FAIL: npm run build"
  tg_alert "FAIL: npm run build ($SHORT_BEFORE → $SHORT_AFTER)"
  exit 4
}

# 4. Swap dist
rm -rf "$APP_DIR/dist"
cp -r "$SOURCE_PATH/dist" "$APP_DIR/dist"

# 5. Restart
pm2 restart "$PM2_NAME" --update-env >/dev/null
log "pm2 restarted"

# 6. Health check
SUCCESS=0
for i in $(seq 1 "$HEALTH_RETRIES"); do
  sleep 2
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    SUCCESS=1
    log "health check passed (attempt $i)"
    break
  fi
done

if [[ "$SUCCESS" -ne 1 ]]; then
  log "FAIL: health check; ROLLING BACK to $BACKUP_FILE"
  tg_alert "ROLLBACK: health check failed ($SHORT_BEFORE → $SHORT_AFTER), restored from $BACKUP_FILE"
  pm2 stop "$PM2_NAME" >/dev/null || true
  rm -rf "$APP_DIR/dist"
  if [[ -f "$BACKUP_FILE" ]]; then
    tar xzf "$BACKUP_FILE" -C "$APP_DIR"
  fi
  pm2 restart "$PM2_NAME" --update-env >/dev/null
  log "rollback done"
  exit 5
fi

# 7. Report
REPORT_DIR="/var/log/neurohub-prod-auto-deploy.d"
mkdir -p "$REPORT_DIR"
REPORT_FILE="$REPORT_DIR/deploy-$TS.md"
{
  echo "# PROD auto-deploy $TS"
  echo ""
  echo "- Commit: $SHORT_BEFORE → $SHORT_AFTER"
  echo "- Branch: $BRANCH"
  echo "- Backup: $BACKUP_FILE"
  echo "- Health: passed"
  echo ""
  echo "## Diff (last 20 commits)"
  echo '```'
  git log --oneline -20 "$LOCAL..$REMOTE" 2>/dev/null || echo "(no history)"
  echo '```'
} > "$REPORT_FILE"
ls -1t "$REPORT_DIR"/deploy-*.md 2>/dev/null | tail -n +51 | xargs -r rm -f

echo "$REMOTE" > "$DEPLOYED_SHA_FILE"
log "deploy OK: $SHORT_BEFORE → $SHORT_AFTER"
tg_alert "✅ deploy OK: $SHORT_BEFORE → $SHORT_AFTER"
