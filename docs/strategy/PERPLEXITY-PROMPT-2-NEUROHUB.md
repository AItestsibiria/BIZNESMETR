# Prompt #2 для Perplexity — подтвердить связку neurohub ↔ clone.muziai.ru + проверить рестарты

> Копируй блок ниже целиком в Perplexity.

---

```
Привет. Продолжаем аудит VPS 72.56.1.149 для проекта MuziAI.

КОНТЕКСТ
В прошлом аудите выяснилось:
  - на VPS живёт nginx vhost `muziai-clone` с server_name `clone.muziai.ru 72.56.1.149`
  - pm2-процесс `neurohub` (id 3) работает в /var/www/neurohub/
  - за 16 часов он рестартился 30 раз — много

НУЖНО ВЫЯСНИТЬ
1. Действительно ли HTTP-запросы на clone.muziai.ru идут в pm2-процесс neurohub?
2. Почему neurohub рестартится — есть ли в логах криты/OOM/uncaughtException?

⚠️ ОПЕРАЦИОННОЕ ПРАВИЛО
Только READ-ONLY команды. Никаких pm2 restart, никаких изменений конфигов. Пятиуровневое предупреждение перед каждой командой и явное "да" Евгения.

КОМАНДЫ К ВЫПОЛНЕНИЮ

ssh root@72.56.1.149 '
  echo "=== nginx vhost muziai-clone ===";
  cat /etc/nginx/sites-enabled/muziai-clone 2>/dev/null;

  echo "";
  echo "=== nginx vhost worldbeauty (для сравнения) ===";
  cat /etc/nginx/sites-enabled/worldbeauty 2>/dev/null | head -30;

  echo "";
  echo "=== /var/www/neurohub/ структура ===";
  ls -la /var/www/neurohub/ 2>/dev/null;

  echo "";
  echo "=== /var/www/neurohub/package.json (name, version, scripts.start) ===";
  cat /var/www/neurohub/package.json 2>/dev/null | python3 -c "import sys,json; p=json.load(sys.stdin); print(json.dumps({k:p.get(k) for k in [\"name\",\"version\",\"description\",\"scripts\"]}, indent=2, ensure_ascii=False))" 2>/dev/null;

  echo "";
  echo "=== pm2 описание процесса neurohub ===";
  pm2 describe neurohub 2>/dev/null | head -50;

  echo "";
  echo "=== pm2 logs neurohub (последние 200 строк, ошибки + stdout) ===";
  pm2 logs neurohub --lines 200 --nostream 2>/dev/null;

  echo "";
  echo "=== Что слушает на портах (только локальные TCP) ===";
  ss -ltnp 2>/dev/null | grep -v "127.0.0.53" | head -20;

  echo "";
  echo "=== curl localhost (на каких портах работают neurohub и worldbeauty) ===";
  for port in 3000 3001 3002 4000 5000 8000 8080; do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:$port/ 2>/dev/null);
    [ "$code" != "000" ] && echo "port $port → HTTP $code";
  done;

  echo "";
  echo "=== git remote и git log neurohub ===";
  cd /var/www/neurohub && git remote -v 2>/dev/null && git log --oneline -5 2>/dev/null;
'

ОТЧЁТ

Сформируй на русском такой отчёт:

# Аудит neurohub — отчёт #2 для Claude

## 1. Связка clone.muziai.ru → neurohub
- nginx upstream / proxy_pass для muziai-clone: ...
- На каком порту слушает neurohub: ...
- Подтверждено ли что clone.muziai.ru идёт в neurohub? Да/Нет, доказательство.

## 2. Что такое neurohub
- package.json name: ...
- package.json version: ...
- description: ...
- scripts.start: ...
- git remote: ...
- последние 5 коммитов: ...
- Это бывший podaripesnu.ru / MuziAI codebase или другой проект?

## 3. Почему 30 рестартов за 16 часов
- В pm2 logs последние ошибки (топ-3 уникальных): ...
- Тип проблемы: OOM / uncaughtException / process.exit / segfault / другое
- Recommended action: ...

## 4. Структура каталога /var/www/neurohub/
- Список верхнего уровня: ...
- Что бросается в глаза: ...

## 5. Сырой вывод
(полный stdout SSH-команды)

ПОСЛЕ ОТЧЁТА — НИЧЕГО НЕ ДЕЛАЙ. Жду решений Евгения.
```

---

## Что я сделаю по результату

- Подтверждение `neurohub = clone backend` → можно стартовать v304-кодинг прямо в этом каталоге (или в новой ветке git, если там git инициализирован).
- Если 30 рестартов из-за OOM — добавим swap до 2 GiB или ограничим процесс.
- Если из-за uncaughtException — оформим первый bug как «фундаментальное исправление №0» в Спринт 1.

---

*Last updated: 2026-05-06*
