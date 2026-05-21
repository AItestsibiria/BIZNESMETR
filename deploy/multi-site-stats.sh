#!/bin/bash
# Eugene 2026-05-21: универсальный анализ статистики MuzaAi instance.
# Запуск: bash multi-site-stats.sh [path/to/data.db]
# Default: /var/www/neurohub/data.db
#
# Используется для сбора цифр с разных instance (muzaai / clone / podaripesnu).

DB="${1:-/var/www/neurohub/data.db}"

if [ ! -f "$DB" ]; then
  echo "❌ DB not found: $DB"
  echo "Usage: bash $0 /path/to/data.db"
  exit 1
fi

echo "===== ANALYSIS: $DB ====="
echo "File size: $(du -h "$DB" | cut -f1)"
echo "Hostname:  $(hostname)"
echo "Date:      $(date -u +%FT%TZ)"
echo ""

sqlite3 "$DB" <<'SQL'
.headers on
.mode column

SELECT '=== USERS ===' AS section;
SELECT
  COUNT(*) AS total_users,
  SUM(CASE WHEN role IN ('admin','super_admin') THEN 1 ELSE 0 END) AS admins,
  SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS new_7d,
  SUM(CASE WHEN created_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS new_24h
FROM users;

SELECT '=== VISITS ===' AS section;
SELECT
  COUNT(*) AS unique_fingerprints,
  COALESCE(SUM(visits), 0) AS total_visits,
  COUNT(DISTINCT country_code) AS countries
FROM visitors;

SELECT '=== GENERATIONS ===' AS section;
SELECT
  COUNT(*) AS total_gens,
  SUM(CASE WHEN type='music' THEN 1 ELSE 0 END) AS music,
  SUM(CASE WHEN type='music' AND status='done' THEN 1 ELSE 0 END) AS music_done,
  SUM(CASE WHEN type='music' AND is_public=1 THEN 1 ELSE 0 END) AS public_main,
  SUM(CASE WHEN type='music' AND deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted
FROM generations
WHERE deleted_at IS NULL OR deleted_at IS NOT NULL;

SELECT '=== PLAYS ===' AS section;
SELECT
  action,
  COUNT(*) AS count
FROM gen_activity
WHERE action='play' OR action LIKE 'play_rejected%'
GROUP BY action
ORDER BY count DESC;

SELECT '=== PLAYS SUM (meta.plays) ===' AS section;
SELECT
  SUM(CAST(json_extract(style, '$.plays') AS INTEGER)) AS total_meta_plays,
  COUNT(*) AS tracks_with_meta
FROM generations
WHERE type='music' AND deleted_at IS NULL
  AND style LIKE '{%' AND json_valid(style)=1;

SELECT '=== PAYMENTS ===' AS section;
SELECT
  COUNT(*) AS total_payments,
  SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid_count,
  COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END), 0) / 100 AS paid_rub_total
FROM payments;

SELECT '=== MESSAGES TO МУЗА ===' AS section;
SELECT
  COUNT(*) AS total_messages,
  COUNT(DISTINCT session_id) AS sessions
FROM chatbot_messages
WHERE role='user';
SQL

echo ""
echo "===== END $DB ====="
