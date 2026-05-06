#!/usr/bin/env bash
# Auto-deploy для clone.muziai.ru.
# Раз в минуту проверяет ветку claude/add-claude-documentation-OW5V7
# в репо aitestsibiria/biznesmetr. Если есть новые коммиты:
#   1. pre-flight backup текущего dist
#   2. git pull в /opt/neurohub-src
#   3. npm install + npm run build
#   4. swap dist в /var/www/neurohub
#   5. pm2 restart neurohub
#   6. health check; при ошибке — авто-rollback из backup
#   7. лог в /var/log/neurohub-auto-deploy.log + git-комит в ветку clone-deploy-log
#
# Источник: aitestsibiria/biznesmetr (через локальный bare-clone в /opt/neurohub-src).
# Рестрикции:
#   - касается ТОЛЬКО /var/www/neurohub (clone). Prod /var/www/podaripesnu и
#     /var/www/muziai — НЕ ТРОГАЕТ (даже если их назначат на этот же VPS).
#   - подписан на единственную ветку — никакая другая не задеплоится.
#   - rollback идемпотентный: если pm2 не поднялся за 30 сек, откатываем dist.

set -euo pipefail

REPO_URL="https://github.com/AItestsibiria/biznesmetr.git"
BRANCH="claude/add-claude-documentation-OW5V7"
SRC_DIR="/opt/neurohub-src"
APP_DIR="/var/www/neurohub"
PM2_NAME="neurohub"
BACKUP_ROOT="/var/backups/neurohub-auto"
LOG_FILE="/var/log/neurohub-auto-deploy.log"
LOCK_FILE="/var/run/neurohub-auto-deploy.lock"
HEALTH_URL="http://127.0.0.1:5000/api/example/ping"
HEALTH_RETRIES=15

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG_FILE" >&2; }

# Single-instance gate — если предыдущий запуск ещё крутится, выходим тихо.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

# Первый запуск: клонируем репо в SRC_DIR. Дальнейшие — fetch+pull.
if [[ ! -d "$SRC_DIR/.git" ]]; then
  log "first run: cloning $REPO_URL into $SRC_DIR"
  rm -rf "$SRC_DIR"
  git clone --branch "$BRANCH" --depth 50 "$REPO_URL" "$SRC_DIR"
fi

cd "$SRC_DIR"
git fetch --quiet origin "$BRANCH"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")
if [[ "$LOCAL" == "$REMOTE" ]]; then
  exit 0
fi

log "new commit on $BRANCH: $LOCAL → $REMOTE; deploying"
SHORT_BEFORE="${LOCAL:0:7}"
SHORT_AFTER="${REMOTE:0:7}"

# 1. Pre-flight backup текущего dist
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_ROOT"
BACKUP_FILE="$BACKUP_ROOT/dist-$TS-$SHORT_BEFORE.tar.gz"
if [[ -d "$APP_DIR/dist" ]]; then
  tar czf "$BACKUP_FILE" -C "$APP_DIR" dist
  log "backup: $BACKUP_FILE"
fi

# Чистим старые бэкапы — храним последние 10
ls -1t "$BACKUP_ROOT"/dist-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f

# 2. Pull
git reset --hard "origin/$BRANCH" >/dev/null
git clean -fdq

# 3. Сборка из apps/neurohub/
SOURCE_PATH="$SRC_DIR/apps/neurohub"
if [[ ! -d "$SOURCE_PATH" ]]; then
  log "FAIL: $SOURCE_PATH not found in repo; aborting"
  exit 2
fi

cd "$SOURCE_PATH"

# Переиспользуем существующий node_modules для скорости — symlink в $APP_DIR
if [[ ! -e node_modules ]] && [[ -d "$APP_DIR/node_modules" ]]; then
  ln -s "$APP_DIR/node_modules" node_modules
fi

npm install --omit=dev --no-audit --no-fund 2>&1 | tail -20 | tee -a "$LOG_FILE" >&2 || {
  log "FAIL: npm install"
  exit 3
}

npm run build 2>&1 | tail -30 | tee -a "$LOG_FILE" >&2 || {
  log "FAIL: npm run build"
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
  log "FAIL: health check did not pass; ROLLING BACK to $BACKUP_FILE"
  pm2 stop "$PM2_NAME" >/dev/null || true
  rm -rf "$APP_DIR/dist"
  if [[ -f "$BACKUP_FILE" ]]; then
    tar xzf "$BACKUP_FILE" -C "$APP_DIR"
  fi
  pm2 restart "$PM2_NAME" --update-env >/dev/null
  log "rollback done"
  exit 5
fi

# 7. Записать deploy report локально (без push'а — anonymous push в публичный
# репо невозможен; чтобы я мог прочитать историю деплоев, пусть Perplexity
# раз в день шлёт мне `tail -200 /var/log/neurohub-auto-deploy.log`).
REPORT_DIR="/var/log/neurohub-auto-deploy.d"
mkdir -p "$REPORT_DIR"
REPORT_FILE="$REPORT_DIR/deploy-$TS.md"
{
  echo "# Auto-deploy $TS"
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

# Чистим старые отчёты — храним последние 50
ls -1t "$REPORT_DIR"/deploy-*.md 2>/dev/null | tail -n +51 | xargs -r rm -f

log "deploy OK: $SHORT_BEFORE → $SHORT_AFTER"
