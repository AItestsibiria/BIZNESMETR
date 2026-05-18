# Clone-first deploy — pre-flight гайд (Eugene 2026-05-18)

> **Контекст:** этот документ описывает опциональный «clone-first» workflow для
> тестирования рискованных коммитов на `clone.muziai.ru` перед prod. Он
> **не отменяет** актуальное правило `Prod-auto-deploy + versioned backup`
> (systemd timer pulls из ветки `claude/add-claude-documentation-OW5V7` каждую
> минуту) — это просто способ протестировать что-то на clone, прежде чем
> рассказать timer'у про обновление.

---

## Когда использовать clone-first

Pre-flight на clone полезен когда:
- 🟡 Меняем schema БД (migration ALTER/CREATE)
- 🟡 Меняем payment endpoints (Robokassa init / refund)
- 🟡 Меняем CI/CD scripts / deploy/auto-deploy*.sh
- 🟡 Большой refactor с риском регрессии
- 🟡 Новый плагин с непроверенным runtime

Pre-flight НЕ нужен (push сразу в prod-ветку):
- 🟢 UI правки (компоненты, стили)
- 🟢 Контент (KB, persona, docs)
- 🟢 Bug-fixes с чётким root cause
- 🟢 Test/docs/refactor без user-visible изменений

---

## Топология деплоя

| Environment | Хост | Путь | Канал доставки |
|---|---|---|---|
| Production muziai.ru | 31.130.148.107 | /var/www/neurohub | systemd timer (1 min) ← GitHub ветка `claude/add-claude-documentation-OW5V7` |
| Clone | 72.56.1.149 | /var/www/neurohub | systemd timer ← та же ветка |
| Prod podaripesnu.ru | TBD | — | (отдельный VPS, отдельный workflow) |

Обе среды — **clone и prod** — тянут из одной и той же ветки. Поэтому
«clone-first» = «дождись minute auto-deploy на clone, проверь, потом minute
auto-deploy подхватит и prod». Если нужен **строгий gap** (clone сначала, prod
ПОСЛЕ проверки) — есть три варианта:

---

## Вариант 1 — natural staggering (по умолчанию)

Оба VPS пуллят раз в минуту. Если push в 12:00:00 — clone подтянет в 12:00:15,
prod в 12:00:45 (зависит от offset timer'а). Различие 30 сек — успеть открыть
clone и быстро проверить.

**Использование:** push → открыть `https://clone.muziai.ru/` в одной вкладке →
если в течение 30 сек видишь регрессию — `git revert` или `git reset --hard` на
previous SHA + push (auto-deploy откатит обе).

---

## Вариант 2 — pause prod timer (если нужен полный контроль)

Когда хочешь спокойно потестировать на clone 10-30 минут перед prod:

```bash
ssh root@31.130.148.107 'systemctl stop neurohub-prod-auto-deploy.timer'
```

→ push в ветку → clone подхватит сам (его timer работает) → проверяешь на
`https://clone.muziai.ru/` → когда готов → запускаешь prod вручную:

```bash
ssh root@31.130.148.107 'bash /usr/local/bin/neurohub-prod-auto-deploy.sh && systemctl start neurohub-prod-auto-deploy.timer'
```

Скрипт сам сделает: pre-flight backup → git pull → npm ci → build → swap dist
→ pm2 restart → health-check `/api/example/ping` → если fail → auto-rollback.

---

## Вариант 3 — manual cherry-pick SHA на prod

Если на clone несколько коммитов, а на prod хочешь только один (например fix
без новых фич):

```bash
ssh root@31.130.148.107 'cd /opt/muziai-src && git fetch origin && git cherry-pick 🔴SHA_КОММИТА🔴 && bash /usr/local/bin/neurohub-prod-auto-deploy.sh'
```

⚠️ Cherry-pick создаёт расхождение между prod-веткой и `claude/...` веткой —
после теста надо либо вмёрджить нужное в основную ветку, либо revert на
prod чтобы timer её снова чистил.

---

## Команда быстрой проверки clone после push

```bash
ssh root@72.56.1.149 'tail -20 /var/log/neurohub-auto-deploy.log && cd /opt/neurohub-src && git log --oneline -1 && pm2 status neurohub'
```

Если SHA в `git log` совпадает с твоим push'ем + pm2 status `online` + log
заканчивается `✓ deploy OK` — clone подтянул успешно.

---

## Откат clone (если что-то сломалось)

Backup'ы clone живут в `/var/backups/neurohub-auto/dist-*.tar.gz`:

```bash
ssh root@72.56.1.149 'ls -t /var/backups/neurohub-auto/dist-*.tar.gz | head -10'
ssh root@72.56.1.149 'cd /var/www/neurohub && rm -rf dist && tar xzf /var/backups/neurohub-auto/dist-🔴TIMESTAMP-SHA🔴.tar.gz && pm2 restart neurohub --update-env'
```

---

## Связь с другими правилами

- **Prod-auto-deploy + versioned backup rule** (Eugene 2026-05-17) — primary
  канал доставки. Этот гайд лишь добавляет pre-flight шаг.
- **Clone-deprecated + GH-only deploy rule** (Eugene 2026-05-15) — отменяет
  старую цепочку «clone → smoke → approve → prod» как обязательную. Сейчас
  clone-first это **опция** для рискованных коммитов, не дефолт.
- **Selective-deploy rule** (Eugene 2026-05-09) — частично перекрывается с
  Вариантом 2 выше (pause prod timer).
- **Prod-deploy 3-warning rule** (Eugene 2026-05-08) — применяется к ручному
  ssh-pm2 на prod из Варианта 2/3.

---

*Updated: 2026-05-18*
