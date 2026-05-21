#!/usr/bin/env bash
# promote-clone-to-prod.sh — Промоушн отлаженной редакции с clone → prod.
#
# Запускать НА clone-VPS (72.56.1.149) или на dev-машине с git push'ем.
#
# Что делает:
#   1. Берёт текущий HEAD SHA с /opt/neurohub-src (или $SRC_DIR) — это тот код
#      который сейчас работает на clone.
#   2. Делает rebuild + health check на clone чтобы гарантировать что код собирается.
#   3. Создаёт git tag формата `prod-ready-DDMMYY-HHMM` на этом SHA.
#   4. Push tag в GitHub (требует remote origin с push-rights, обычно key
#      ~/.ssh/github_deploy уже настроен).
#   5. Печатает Боссу что дальше: открыть GH Actions UI → workflow_dispatch с этим tag
#      ИЛИ запустить prod auto-deploy timer (он сам подхватит если ветка обновлена).
#
# НЕ запускает prod deploy автоматически — это требует явного Боссова «да».
# Прод deploy — через GH Actions `deploy-prod.yml` (workflow_dispatch с ref=<tag>).
#
# Flags:
#   --tag-name=<custom>   override tag name (default: prod-ready-DDMMYY-HHMM)
#   --no-rebuild          пропустить rebuild + health check (не рекомендую)
#   --dry-run             показать что бы сделалось, без push'a
#   --message="<text>"    custom tag annotation (default: "Promoted from clone")

set -euo pipefail

SRC_DIR="${SRC_DIR:-/opt/neurohub-src}"
CLONE_APP_DIR="${CLONE_APP_DIR:-/var/www/neurohub}"
PM2_NAME="${PM2_NAME:-neurohub}"
HEALTH_URL_LOCAL="${HEALTH_URL_LOCAL:-http://127.0.0.1:5000/api/example/ping}"
HEALTH_URL_PUBLIC="${HEALTH_URL_PUBLIC:-https://clone.muziai.ru/api/example/ping}"

TAG_NAME=""
TAG_MESSAGE="Promoted from clone (auto-tagged by promote-clone-to-prod.sh)"
DO_REBUILD=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag-name=*) TAG_NAME="${1#*=}"; shift ;;
    --no-rebuild) DO_REBUILD=0; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --message=*)  TAG_MESSAGE="${1#*=}"; shift ;;
    -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
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

# ── 1. Sanity ────────────────────────────────────────────────────────────────

[[ -d "$SRC_DIR/.git" ]] || fail "$SRC_DIR/.git не найден — нет git checkout clone-а"

cd "$SRC_DIR"

CURRENT_SHA=$(git rev-parse HEAD)
SHORT_SHA="${CURRENT_SHA:0:7}"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "DETACHED")

log "Source dir: $SRC_DIR"
log "Current SHA: $CURRENT_SHA ($SHORT_SHA)"
log "Current branch/ref: $CURRENT_BRANCH"
log "Last commit: $(git log -1 --format='%s' HEAD)"

# Verify clean working tree (no local uncommitted changes that would skew the promotion)
if [[ -n "$(git status --porcelain)" ]]; then
  log "WARN: working tree dirty. Promotion идёт по HEAD-commit'у, локальные правки ИГНОРИРУЮТСЯ."
  git status --short | head -20
fi

# ── 2. Build + health check on clone ─────────────────────────────────────────

if [[ "$DO_REBUILD" == "1" ]]; then
  log "[2/5] Rebuild + health check на clone"
  SOURCE_PATH="$SRC_DIR/apps/neurohub"
  [[ -d "$SOURCE_PATH" ]] || fail "$SOURCE_PATH не найден"

  run "cd \"$SOURCE_PATH\" && npm ci --no-audit --no-fund 2>&1 | tail -8"
  run "cd \"$SOURCE_PATH\" && npm run build 2>&1 | tail -10"

  # Verify dist artifacts
  if [[ "$DRY_RUN" != "1" ]]; then
    [[ -f "$SOURCE_PATH/dist/index.cjs" ]] || fail "dist/index.cjs missing после build"
    [[ -d "$SOURCE_PATH/dist/public" ]] || fail "dist/public missing после build"
    log "  ✅ build artifacts OK"
  fi

  # Health check (local & public)
  if [[ "$DRY_RUN" != "1" ]]; then
    if curl -fsS --max-time 5 "$HEALTH_URL_LOCAL" >/dev/null 2>&1; then
      log "  ✅ local health OK ($HEALTH_URL_LOCAL)"
    else
      log "  WARN: local health $HEALTH_URL_LOCAL не отвечает"
    fi
    if curl -fsS --max-time 5 "$HEALTH_URL_PUBLIC" >/dev/null 2>&1; then
      log "  ✅ public health OK ($HEALTH_URL_PUBLIC)"
    else
      log "  WARN: public health $HEALTH_URL_PUBLIC не отвечает (но это не блокер промоушна)"
    fi
  fi
else
  log "[2/5] Rebuild + health check ПРОПУЩЕНЫ (--no-rebuild)"
fi

# ── 3. Construct tag name ────────────────────────────────────────────────────

if [[ -z "$TAG_NAME" ]]; then
  STAMP=$(date +%d%m%y-%H%M)
  TAG_NAME="prod-ready-${STAMP}"
fi

# Avoid duplicate tag (idempotency)
if git rev-parse "$TAG_NAME" >/dev/null 2>&1; then
  EXISTING_SHA=$(git rev-parse "$TAG_NAME")
  if [[ "$EXISTING_SHA" == "$CURRENT_SHA" ]]; then
    log "[3/5] Tag $TAG_NAME уже существует на этом SHA — idempotent, продолжаем"
  else
    fail "Tag $TAG_NAME уже существует но на другом SHA ($EXISTING_SHA ≠ $CURRENT_SHA). Используй --tag-name=<other>."
  fi
else
  log "[3/5] Создаю annotated tag $TAG_NAME на $SHORT_SHA"
  run "git tag -a \"$TAG_NAME\" \"$CURRENT_SHA\" -m \"$TAG_MESSAGE — SHA=$SHORT_SHA — promoted $(date -u +'%Y-%m-%dT%H:%M:%SZ')\""
fi

# ── 4. Push tag в GitHub ─────────────────────────────────────────────────────

log "[4/5] git push origin $TAG_NAME"
run "git push origin \"$TAG_NAME\""

# ── 5. Instructions to Босс ──────────────────────────────────────────────────

log "[5/5] DONE — следующие шаги для Босса"

echo ""
echo "========================================================================"
echo "✅ PROMOTION TAGGED"
echo "  Tag:        $TAG_NAME"
echo "  SHA:        $CURRENT_SHA"
echo "  Short:      $SHORT_SHA"
echo "  Pushed to:  origin"
echo ""
echo "  Дальше — 3 варианта deploy на prod (выбери один):"
echo ""
echo "  ВАРИАНТ A — GH Actions workflow_dispatch (рекомендую, full audit):"
echo "    1. Открой https://github.com/AItestsibiria/biznesmetr/actions/workflows/deploy-prod.yml"
echo "    2. Жми 'Run workflow'"
echo "    3. В поле 'ref' впиши: $TAG_NAME"
echo "    4. 'Run workflow' → жди ~3-5 мин"
echo "    5. Проверь https://muzaai.ru/api/_status"
echo ""
echo "  ВАРИАНТ B — auto-deploy timer на prod (если tag на feature-ветке):"
echo "    Если tag $TAG_NAME указывает на коммит из ветки claude/add-claude-documentation-OW5V7,"
echo "    то systemd timer на prod сам подхватит коммит в течение ~1 мин."
echo "    Проверить логи: ssh root@31.130.148.107 'tail -50 /var/log/neurohub-prod-auto-deploy.log'"
echo ""
echo "  ВАРИАНТ C — manual SSH deploy (срочный hot-fix):"
echo "    ssh root@31.130.148.107 'cd /opt/muziai-src && git fetch origin --tags && git checkout $TAG_NAME && cd apps/neurohub && npm ci && npm run build && rm -rf /var/www/neurohub/dist && cp -r dist /var/www/neurohub/dist && pm2 restart neurohub --update-env'"
echo ""
echo "  Rollback (если prod сломался после deploy):"
echo "    ssh root@31.130.148.107 'ls -t /var/backups/neurohub-prod-auto/dist-*.tar.gz | head -5'"
echo "    выбрать предыдущий backup → tar xzf на /var/www/neurohub → pm2 restart"
echo "    ИЛИ git checkout PREV_SHA → npm ci → npm run build → swap dist"
echo "========================================================================"
