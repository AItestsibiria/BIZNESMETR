# `deploy/` — артефакты для выкатки на VPS

Здесь лежат tarball-снапшоты, которые мы перекатываем на `clone.muziai.ru` (и потом на prod) через Perplexity / SSH. Хранение в git — компромисс: размер +/- несколько МБ на коммит, но Perplexity и оператор всегда знают, **какой именно билд** они катят, и могут сравнить SHA256 с историей.

---

## v304 Sprint 1 — `v304-sprint-1-src.tar.gz`

| Поле | Значение |
|---|---|
| Размер | ≈ 2.7 МБ |
| SHA256 | `2a28b37fe05cc1f1fe4f9601083574b8d6e537a787d238d884e15f15009de356` |
| Содержимое | весь `apps/neurohub/` без `node_modules`, `dist`, `data.db*`, `authors`, `.env`, `.git` (≈ 133 файла) |
| Версия кода | git ветка `claude/add-claude-documentation-OW5V7`, коммиты до Sprint 1 closure |

### Как Perplexity скачивает на VPS

Если у Perplexity есть SSH-доступ к `72.56.1.149` и `git clone` репозитория `aitestsibiria/biznesmetr` работает:

```bash
ssh root@72.56.1.149 '
  set -e
  mkdir -p /tmp/v304-deploy
  cd /tmp/v304-deploy
  # Любой из путей ниже:

  # Путь A — git pull последнего состояния ветки и копирование артефакта
  git clone --branch claude/add-claude-documentation-OW5V7 --depth 1 \
    https://github.com/AItestsibiria/biznesmetr.git biznesmetr
  cp biznesmetr/deploy/v304-sprint-1-src.tar.gz /tmp/v304-deploy/

  # Путь B — wget сразу raw-файла (требует, что репо публичен ИЛИ токен)
  # wget -O /tmp/v304-deploy/v304-sprint-1-src.tar.gz \
  #   https://raw.githubusercontent.com/AItestsibiria/biznesmetr/claude/add-claude-documentation-OW5V7/deploy/v304-sprint-1-src.tar.gz

  # Верификация целостности
  cd /tmp/v304-deploy
  sha256sum v304-sprint-1-src.tar.gz
  # ожидаем: 2a28b37fe05cc1f1fe4f9601083574b8d6e537a787d238d884e15f15009de356
'
```

Если ни git-доступ, ни raw-доступ из VPS не работают — Евгений делает `git pull` локально, потом `scp` на VPS. См. `docs/strategy/PERPLEXITY-PROMPT-5-DEPLOY-V304.md`.

### Сборка + swap dist на сервере

После того как `v304-sprint-1-src.tar.gz` лежит в `/tmp/v304-deploy/` на VPS:

```bash
ssh root@72.56.1.149 '
  set -e
  TS=$(date +%Y%m%d-%H%M%S)

  # 1. Pre-flight backup текущего dist
  cd /var/www/neurohub
  tar czf /var/backups/neurohub-$TS-dist.tar.gz dist/

  # 2. Развернуть исходник в /tmp
  mkdir -p /tmp/neurohub-build
  cd /tmp/neurohub-build
  tar xzf /tmp/v304-deploy/v304-sprint-1-src.tar.gz

  # 3. Сборка с переиспользованием существующего node_modules
  cp -r /var/www/neurohub/node_modules ./node_modules
  cp /var/www/neurohub/package.json ./   # на случай если local package.json свежее
  npm install --omit=dev      # только новые зависимости (например, drizzle-zod уже есть, но bcryptjs тоже)
  npm run build

  # 4. Swap dist на /var/www/neurohub/
  cd /var/www/neurohub
  rm -rf dist
  cp -r /tmp/neurohub-build/dist ./

  # 5. Restart
  pm2 restart neurohub --update-env
  sleep 5
  pm2 status neurohub
  pm2 logs neurohub --lines 30 --nostream
'
```

### Откат

```bash
ssh root@72.56.1.149 '
  pm2 stop neurohub
  cd /var/www/neurohub
  rm -rf dist
  tar xzf /var/backups/neurohub-<TS>-dist.tar.gz   # из шага 1 выше
  pm2 restart neurohub
'
```

---

*Last updated: 2026-05-06*
