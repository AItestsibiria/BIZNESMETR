# iOS Assets — иконки и splash screens

Эта папка — **исходники** для генерации иконок iOS App Store + splash screens. Финальные ассеты Capacitor положит в `ios/App/App/Assets.xcassets/` при первом `npx cap copy ios`.

## Что нужно положить сюда (на Mac, перед `npx cap add ios`)

### 1. `icon.png` — главная иконка приложения (обязательно)

- Размер: **1024 × 1024 px**, PNG, без прозрачности (sRGB)
- Содержание: фирменный логотип MuzaAi на фоне `#0A0A17` (Deep Space) — purple waveform + текст «MuzaAi»
- Источник: текущий `apps/neurohub/client/public/favicon.svg` — экспортировать в Figma как 1024×1024 PNG с фирменным gradient'ом
- Apple требует: НЕТ скруглённых углов (iOS сам округлит), НЕТ прозрачности, НЕТ альфа-канала

### 2. `splash.png` — splash screen (обязательно)

- Размер: **2732 × 2732 px** (квадратный, чтобы помещался на iPad Pro 12.9 в обеих ориентациях)
- Лого по центру, остальное — `#0A0A17`
- Capacitor нарежет автоматически на все iPhone/iPad размеры

### 3. `splash-dark.png` (опционально, для dark mode)

- То же что splash, но если у Босса будет light mode версия — отдельный файл
- Сейчас skip — приложение всегда dark theme

## Как использовать (на Mac)

После размещения двух PNG (или одного `icon.png` + одного `splash.png`):

```bash
# Установить capacitor-assets глобально (один раз)
npm install -g @capacitor/assets

# Генерация всех размеров из исходников
npx @capacitor/assets generate --ios \
  --iconBackgroundColor "#0a0a17" \
  --splashBackgroundColor "#0a0a17"
```

Это создаст 30+ файлов в `ios/App/App/Assets.xcassets/AppIcon.appiconset/` + `Splash.imageset/`.

## Reference — фирменный стиль

- Cyber Violet: `#7C3AED` (purple-600) — primary gradient
- Electric Blue: `#00D4FF` (cyan-400) — secondary
- Deep Space: `#0A0A17` — фон
- Hot Magenta: `#FF006E` — accent
- Шрифт лого: Space Grotesk Bold (если делается через Figma)

## Текущие исходники (для копирования в Figma)

- `../client/public/favicon.svg` — текущий favicon (упрощённый, без текста)
- `../client/public/bot-logo-text.svg` — лого с текстом (если есть)
- `../client/public/consultant-avatar.svg` — Музa-аватар (НЕ для иконки app, для in-app использования)

## TODO для Босса перед App Store submit

- [ ] Экспортировать `icon.png` 1024×1024 из Figma
- [ ] Экспортировать `splash.png` 2732×2732 из Figma
- [ ] Запустить `npx @capacitor/assets generate --ios` на Mac
- [ ] Проверить в Xcode что AppIcon выглядит корректно (тёмный preview на iOS Simulator)
- [ ] Подготовить App Store screenshots (отдельно — 6.7", 6.5", 5.5" iPhone + 12.9" iPad)
