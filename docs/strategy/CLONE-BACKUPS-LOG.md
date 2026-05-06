# Журнал ручных бэкапов clone.muziai.ru

Каждый ручной snapshot перед потенциально опасной операцией фиксируется здесь — путь, дата, SHA256-манифест. Это позволяет верифицировать целостность бэкапа перед откатом.

---

## 2026-05-06 — pre-fix backup (этап 1 prompt #4)

**Контекст:** перед установкой `bcryptjs`, `ffmpeg` и инспекцией `/api/.env`.
**Исполнитель:** Perplexity по prompt из `PERPLEXITY-PROMPT-4-BACKUP-AND-FIXES.md`, ЭТАП 1.
**Хост:** `72.56.1.149` (clone.muziai.ru).

### SHA256 manifest

```
11e3b1ec7c2999143930e8b1b203ef3a34d1e82177ac52c28bf329c813c76165  data.db
1d7e1fccdc3f656554c149d136d5d10c2b8611befc3785bffd5db20986a02407  authors.tar.gz
446ad14044c59165aa1074e662a37f058189ddaa4289001de9d45874e064c8a5  env
5d314c36b66d5fe995eff3d3f054a7bf814df62a3d96e83a44aacbfb583ab8a4  pm2-jlist.json
eafa840015551ed054a76f0001c761c3aa168c2d1a66044054803408869e38e8  pm2-neurohub.txt
```

### Состав

| Файл | Что внутри |
|---|---|
| `data.db` | SQLite snapshot через `sqlite3 .backup` (consistent online) |
| `authors.tar.gz` | gzip-tar `/var/www/neurohub/authors/` (медиа треков) |
| `env` | копия `/var/www/neurohub/.env` (chmod 600) |
| `pm2-jlist.json` | `pm2 jlist` — полное описание процессов |
| `pm2-neurohub.txt` | `pm2 describe neurohub` — текстовый snapshot |

### Незаполнено в отчёте Perplexity (запросить при необходимости)

- [ ] Путь к backup-каталогу (`/var/backups/neurohub-<TS>/`)
- [ ] Общий размер `du -sh`
- [ ] Результат `PRAGMA integrity_check` (должно быть `ok`)

### Как откатиться (если потребуется)

```bash
ssh root@72.56.1.149 '
  set -e
  BACKUP_DIR=/var/backups/neurohub-<TIMESTAMP>   # см. отчёт
  # Верификация SHA256 ДО восстановления:
  cd "$BACKUP_DIR" && sha256sum -c checksums.txt
  # Стоп приложения, восстановление:
  pm2 stop neurohub
  cp "$BACKUP_DIR/data.db" /var/www/neurohub/data.db
  rm -rf /var/www/neurohub/authors
  tar xzf "$BACKUP_DIR/authors.tar.gz" -C /var/www/neurohub/
  cp "$BACKUP_DIR/env" /var/www/neurohub/.env
  pm2 restart neurohub
'
```

---

*Last updated: 2026-05-06*
