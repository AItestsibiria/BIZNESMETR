#!/bin/bash
# Eugene 2026-05-21: проверка plays на frontend через /api/playlist.
# Запуск: bash /opt/muziai-src/deploy/check-plays.sh
#
# Сравнивает Frontend API с БД. URL собирается из частей чтобы не autolink-ался в чате.

set +e

# Собираем URL из частей — chat autolink не сработает на эту строку при отображении
H1="muz"
H2="aai"
H3=".ru"
HOST="${H1}${H2}${H3}"
URL="https://${HOST}/api/playlist?status=main&sort=rating&dir=desc"

echo "=== Fetching from frontend API ==="
echo "URL: $URL"
curl -s "$URL" > /tmp/pl.json
SIZE=$(wc -c < /tmp/pl.json)
echo "Response size: $SIZE bytes"

if [ "$SIZE" -lt 100 ]; then
  echo "❌ Empty/small response — API not reachable?"
  echo "Content:"
  cat /tmp/pl.json
  exit 1
fi

python3 <<'PY'
import json
try:
    d = json.load(open('/tmp/pl.json'))
except Exception as e:
    print(f"❌ JSON parse error: {e}")
    with open('/tmp/pl.json') as f:
        print("First 500 chars:", f.read()[:500])
    exit(1)

if not isinstance(d, list):
    print(f"⚠ Unexpected response type: {type(d).__name__}")
    print("Keys:", d.keys() if isinstance(d, dict) else "N/A")
    exit(0)

print(f"\n=== Summary ===")
print(f"Total tracks in main playlist: {len(d)}")
total_plays = sum(t.get('plays', 0) for t in d)
print(f"Sum plays (all tracks):        {total_plays}")

print(f"\n=== Top 10 by plays ===")
sorted_tracks = sorted(d, key=lambda t: t.get('plays', 0), reverse=True)
for t in sorted_tracks[:10]:
    pid = t.get('id', '?')
    plays = t.get('plays', 0)
    title = (t.get('display_title') or t.get('prompt') or '')[:50]
    print(f"  {pid:>4} | {plays:>5} | {title}")

print(f"\n=== Top 20 sum ===")
print(f"  {sum(t.get('plays', 0) for t in sorted_tracks[:20])}")
PY
