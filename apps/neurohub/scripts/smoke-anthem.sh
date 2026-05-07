#!/usr/bin/env bash
# Smoke-генерация гимна v304-anthem через Suno (GPTunnel).
# Безопасная сборка JSON через python heredoc — никакого вложенного
# экранирования.
#
# Запуск:
#   ssh root@72.56.1.149 'bash /opt/neurohub-src/apps/neurohub/scripts/smoke-anthem.sh'
#
# Что делает:
#   1. Берёт самый свежий auth-token из sessions БД.
#   2. Подтягивает шаблон /api/gen-templates/v304-anthem.
#   3. Строит JSON-payload через python (без shell-экранирования).
#   4. POST /api/music/generate с этим payload.
#   5. Печатает ответ + watch'ит статус.

set -euo pipefail

DB="${DATABASE_FILE:-/var/www/neurohub/data.db}"
API="http://127.0.0.1:5000"

echo "=== smoke-anthem $(date -u +'%Y-%m-%dT%H:%M:%SZ') ==="

# 1. Token (последний из sessions). Если нужен под конкретным юзером —
#    задай EMAIL=admin@... перед запуском.
EMAIL="${EMAIL:-egnovoselov@gmail.com}"
TOKEN=$(sqlite3 "$DB" "SELECT s.token FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = '${EMAIL}' ORDER BY s.rowid DESC LIMIT 1")
if [[ -z "$TOKEN" ]]; then
  echo "FAIL: no auth-token for ${EMAIL}; залогинься через UI и повтори"
  exit 1
fi
echo "Token: ${TOKEN:0:10}…"

# 2. Скачать шаблон гимна
curl -sS "${API}/api/gen-templates/v304-anthem" > /tmp/anthem-tpl.json
TEMPL_OK=$(python3 -c 'import json,sys; d=json.load(open("/tmp/anthem-tpl.json")); print("ok" if d.get("data") and d["data"].get("promptTemplate") else "fail")')
if [[ "$TEMPL_OK" != "ok" ]]; then
  echo "FAIL: cannot read template; response was:"
  cat /tmp/anthem-tpl.json
  exit 2
fi

# 3. Собрать body JSON через python (никакого shell-экранирования).
python3 <<'PY'
import json
tpl = json.load(open("/tmp/anthem-tpl.json"))["data"]

# Гимн содержит ~1437 символов, что больше 400-char лимита basic-mode
# у GPTunnel/Suno. Используем custom mode:
#   mode: "custom"
#   lyric: полный текст (50-3000 chars)
#   title: имя трека (обязательно)
#   tags:  стиль для tags
#   prompt: короткое описание (опц., <=400 chars)
# v51 routes.ts:1959 принимает поля 'lyrics' и 'title' и сам собирает
# custom-mode payload для GPTunnel (см. routes.ts:2010-2017).

full_text = tpl["promptTemplate"]
short_desc = tpl.get("description") or "Эпический гимн платформы MUZIAI v304."

body = {
    # 'lyrics' включает custom-mode у v51 (если len(lyrics) >= 50)
    "lyrics": full_text,
    "title": "Гимн MUZIAI v304",
    "style": tpl.get("style") or "epic symphonic rock, orchestral, choir, anthemic",
    # короткий prompt опционально — v51 включит его в payload как есть
    "prompt": short_desc[:400],
    "isPublic": 1,
    "authorName": "MUZIAI v304 (Claude)",
    # voice и instrumental не задаём — Suno подберёт mixed choir
}
json.dump(body, open("/tmp/anthem-body.json", "w"), ensure_ascii=False)
print(f"  lyrics chars: {len(body['lyrics'])}")
print(f"  prompt chars: {len(body['prompt'])}")
print(f"  title: {body['title']}")
print(f"  style: {body['style']}")
PY

# 4. POST
echo "POST ${API}/api/music/generate ..."
RESP=$(curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "${API}/api/music/generate" \
  --data-binary @/tmp/anthem-body.json)
echo "$RESP" | python3 -m json.tool || echo "$RESP"

# 5. Если в ответе есть generationId — попробуем подождать первый статус.
GEN_ID=$(echo "$RESP" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  for k in ("id","generationId","genId"):
    if d.get(k): print(d[k]); break
except Exception: pass' 2>/dev/null)

if [[ -n "$GEN_ID" ]]; then
  echo
  echo "=== generation id: $GEN_ID — жду 30 сек, посмотрим первый прогресс ==="
  sleep 30
  curl -sS -H "Authorization: Bearer $TOKEN" "${API}/api/track/${GEN_ID}" | python3 -m json.tool || true
fi

echo "=== smoke-anthem done $(date -u +'%Y-%m-%dT%H:%M:%SZ') ==="
