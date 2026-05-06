#!/bin/bash
# Скрипт деплоя НейронХаб на Timeweb VPS
# IP: 72.56.1.149, Login: uf895983

set -e

echo "=== Деплой НейронХаб на Timeweb VPS ==="

# 1. Создание директории проекта
echo ">> Создаю директорию /var/www/neurohub..."
ssh uf895983@72.56.1.149 "sudo mkdir -p /var/www/neurohub && sudo chown -R uf895983:uf895983 /var/www/neurohub"

# 2. Копирование файлов на сервер
echo ">> Копирую файлы проекта..."
rsync -avz --exclude='node_modules' --exclude='.git' --exclude='data.db' \
  /home/user/workspace/gptunnel-saas/ \
  uf895983@72.56.1.149:/var/www/neurohub/

# 3. Установка зависимостей и сборка на сервере
echo ">> Устанавливаю зависимости и собираю проект..."
ssh uf895983@72.56.1.149 << 'REMOTE_SCRIPT'
cd /var/www/neurohub

# Установка зависимостей
npm install --production=false

# Сборка
npm run build

# Установка PM2 если ещё нет
which pm2 || npm install -g pm2

# Остановка старого процесса если есть
pm2 delete neurohub 2>/dev/null || true

# Запуск production сервера
NODE_ENV=production pm2 start dist/index.cjs --name neurohub

# Сохранение конфигурации PM2
pm2 save

echo "=== НейронХаб запущен на порту 5000 ==="
pm2 status neurohub
REMOTE_SCRIPT

echo ""
echo "=== Готово! ==="
echo "Сайт доступен по адресу: http://72.56.1.149:5000"
echo ""
echo "Для настройки Nginx (порт 80 или 443):"
echo "  ssh uf895983@72.56.1.149"
echo "  sudo nano /etc/nginx/sites-available/neurohub"
