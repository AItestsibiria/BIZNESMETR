# iOS Assets — иконки и splash screens

Эта папка — **исходники** для генерации иконок iOS App Store + splash screens. Финальные ассеты (30+ файлов разных размеров) Capacitor положит в `ios/App/App/Assets.xcassets/` при выполнении `@capacitor/assets generate --ios` на Mac.

## Что уже готово в репо (Eugene 2026-05-23)

| Файл | Размер | Назначение |
|---|---|---|
| `icon-source.svg` | 1024×1024 viewBox | Исходник иконки (vector, easy to tweak) |
| `icon.png` | 1024×1024 PNG | **App Store icon** — без прозрачности, без скруглений (Apple сам округлит) |
| `splash-source.svg` | 2732×2732 viewBox | Исходник splash (vector) |
| `splash.png` | 2732×2732 PNG | **Splash screen** — квадратный, помещается на iPad Pro 12.9 в обеих ориентациях |

PNG'и сгенерированы из SVG через `sharp` (`apps/neurohub/node_modules/sharp`). Если бренд меняется или нужны правки — отредактировать SVG и пересобрать (см. ниже).

## Пересборка PNG из SVG (опционально, если редактировали SVG)

```bash
cd apps/neurohub
node -e "
const sharp = require('sharp');
(async () => {
  await sharp('ios-assets/icon-source.svg', { density: 300 })
    .resize(1024, 1024, { fit: 'cover' })
    .flatten({ background: '#0a0a17' })
    .png({ quality: 95, compressionLevel: 9 })
    .toFile('ios-assets/icon.png');
  await sharp('ios-assets/splash-source.svg', { density: 200 })
    .resize(2732, 2732, { fit: 'cover' })
    .flatten({ background: '#0a0a17' })
    .png({ quality: 95, compressionLevel: 9 })
    .toFile('ios-assets/splash.png');
})().catch(e => { console.error(e); process.exit(1); });
"
```

## Как использовать на Mac (после `npx cap add ios`)

```bash
# Установить capacitor-assets глобально (один раз на Mac)
npm install -g @capacitor/assets

# Сгенерировать ВСЕ размеры иконок + splash из исходников
# (читает icon.png + splash.png из ios-assets/ и кладёт в ios/App/App/Assets.xcassets/)
cd apps/neurohub
npm run ios:assets

# Или вручную:
# npx @capacitor/assets generate --ios \
#   --iconBackgroundColor "#0a0a17" \
#   --splashBackgroundColor "#0a0a17"
```

После этой команды появятся:
- `ios/App/App/Assets.xcassets/AppIcon.appiconset/` — 18+ иконок разных размеров (20×20 до 1024×1024)
- `ios/App/App/Assets.xcassets/Splash.imageset/` — splash screens для всех экранов

## Apple App Store requirements (соблюдены)

- ✅ icon.png 1024×1024 PNG, **без прозрачности** (flatten на `#0a0a17` background)
- ✅ **Без скруглённых углов** — Apple iOS сам наложит маску при отображении
- ✅ **Без альфа-канала** — заоблочен через `flatten()` в sharp
- ✅ sRGB colour space (sharp default)
- ✅ splash.png квадратный 2732×2732 — оба ориентации iPad Pro

## Reference — фирменный стиль (соблюдён в SVG)

- Cyber Violet: `#7C3AED` (purple-600) — primary gradient
- Electric Blue: `#00D4FF` (cyan-400) — secondary
- Deep Space: `#0A0A17` — фон
- Hot Magenta: `#D946EF` (fuchsia-500) — accent
- Шрифт лого: Verdana/Helvetica (system, чтобы не зависеть от загрузки кастомных font'ов)

См. также `CLAUDE.md → Brand-style consistency rule` и `Brand-assets-registry rule`.

## Связанные файлы

- `apps/neurohub/client/public/artwork-512.png` — lock-screen fallback для MediaSession (см. `Apple-audio-best-practices rule` пункт 5)
- `apps/neurohub/client/public/artwork-512-source.svg` — base источник из которого выведен icon-source.svg + splash-source.svg
- `apps/neurohub/client/public/favicon.svg` — favicon (упрощённый)

## TODO для Босса перед App Store submit

- [ ] Проверить визуально icon.png и splash.png — открыть в Preview, оценить читаемость на тёмном фоне
- [ ] Если хочется правок — отредактировать `icon-source.svg` / `splash-source.svg` и пересобрать PNG (команда выше)
- [ ] На Mac после `npx cap add ios` — запустить `npm run ios:assets`
- [ ] Проверить в Xcode → `ios/App/App/Assets.xcassets/AppIcon.appiconset/` что все размеры на месте
- [ ] Запустить на iOS Simulator (`npx cap open ios` → ▶️) — проверить как splash и иконка выглядят на home screen
- [ ] Подготовить **App Store screenshots** (отдельно — 6.7" iPhone 1290×2796 + 6.5" iPhone 1242×2688 + 12.9" iPad 2048×2732). Минимум 3 на каждое разрешение. Использовать iOS Simulator + Cmd+S.
