# iOS App MuzaAi — Capacitor.js setup для App Store

Версия: 1.0 (Eugene 2026-05-21)
Bundle ID: `ru.muzaai.app`
Target: iOS 14+ (iPhone + iPad)
Источник: `apps/neurohub/capacitor.config.ts` (single source of truth)

---

## TL;DR — что Босс должен сделать

1. Купить **Apple Developer аккаунт** — $99/год — https://developer.apple.com/programs/
2. На Mac установить **Xcode 15+** из App Store (15-20 GB, ~1 час)
3. Clone репо на Mac, выполнить шаги из раздела «Первый билд на Mac»
4. Подождать Apple Review (~1-7 дней первый раз, ~24 часа дальше)
5. Готово — приложение в App Store

Капитан config + Capacitor зависимости уже добавлены в репо (commit с `feat(ios): Capacitor iOS app skeleton`). Босс на Mac делает `npm install && npm run build && npx cap add ios && npx cap open ios` — Xcode откроется готовый к подписи.

---

## Что такое Capacitor + почему этот подход

**Capacitor** (от создателей Ionic, https://capacitorjs.com) — это native shell для web-приложений. WebView рендерит наш React SPA, плюс native plugins дают доступ к push-notifications, Apple Pay, биометрии, камере, file system.

### Почему НЕ другие пути

| Подход | Pro | Contra | Решение |
|---|---|---|---|
| **Native Swift / SwiftUI** | Максимальная производительность, доступ к ВСЕМ API | Полная переписка с нуля. 2-3 месяца разработки. Двойная maintenance (web + iOS). | ❌ Слишком дорого |
| **React Native** | Native performance, shared logic | Нужно переписывать UI компоненты (нет HTML/CSS). Не поддерживает CSS animations / gradient'ы напрямую. | ❌ Переписка UI |
| **PWA через Safari «Add to Home»** | Ноль работы | НЕТ App Store, НЕТ push в России (Apple убрала Web Push для iOS Safari в РФ), НЕТ IAP | ❌ Нет в Store |
| **Cordova** (предшественник Capacitor) | Зрелая экосистема | Legacy, устаревший plugin API, slower обновления | ❌ Устарел |
| **Capacitor (выбран)** | Web-код переиспользуется 100%. Native plugins по необходимости. Один codebase. Push + IAP работают. | WebView чуть медленнее native. Зависим от Apple WebKit (= Safari quirks). | ✅ |

### Hybrid mode (наш выбор)

Capacitor config `server.url = "https://muzaai.ru"` означает что приложение **грузит web с production**. Native shell только обеспечивает:

- Splash screen + status bar
- Push notifications (через Capacitor plugin)
- In-app purchases (для премиум-фич)
- Offline fallback (опционально)
- Биометрия / Apple Pay (когда понадобится)

**Преимущество:** web-обновления (новости, KB, прайс, фичи) идут моментально через `git push` → auto-deploy → юзеры видят сразу. БЕЗ Apple Review. Apple Review нужен только при изменении native кода (новые plugins, splash, capabilities).

**Trade-off:** требуется интернет для работы. Если хотим offline-режим — можно перейти на `webDir` only (без `server.url`), но тогда каждое обновление = App Store Review.

---

## Pre-requisites

### Железо
- **Mac** (Intel или Apple Silicon, минимум 16 GB RAM рекомендуется)
- macOS 13 Ventura или новее (для Xcode 15+)
- ~50 GB свободного диска (Xcode + simulators + iOS SDKs)

### Аккаунты + покупки
- **Apple Developer Program** — $99/год — https://developer.apple.com/programs/enroll/
  - Регистрация: 24-48 часов, требуется D-U-N-S Number для company (или Individual)
  - Для MuzaAi рекомендую Individual если бизнес-структура простая, иначе Organization (требует D-U-N-S)
- **Apple ID** связанный с Apple Developer аккаунтом (тот же что для App Store Connect)

### Софт
- **Xcode 15+** из Mac App Store (бесплатно, 15-20 GB)
- **Node.js 20 LTS** (тот же что на VPS — `node --version` должен быть `v20.x`)
- **CocoaPods** (для Capacitor iOS dependencies):
  ```bash
  sudo gem install cocoapods
  pod --version  # должно быть 1.15+
  ```
- **Git** (предустановлен на macOS через Xcode Command Line Tools)

---

## Первый билд на Mac

### Шаг 1: Clone репо

```bash
cd ~/Projects  # или куда удобно
git clone git@github.com:AItestsibiria/biznesmetr.git
cd biznesmetr
git checkout claude/add-claude-documentation-OW5V7  # или main после merge
```

### Шаг 2: Установить зависимости + build web

```bash
cd apps/neurohub
npm install
npm run build
# → создаст dist/public/ (web-bundle для WebView)
```

### Шаг 3: Создать iOS project

```bash
npx cap add ios
# → создаст ios/App/ с готовым Xcode project
# Capacitor использует apps/neurohub/capacitor.config.ts как источник правды
```

### Шаг 4: Скопировать web-сборку и синхронизировать plugins

```bash
npx cap copy ios     # копирует dist/public/ → ios/App/App/public/
npx cap sync ios     # CocoaPods install + связывает native plugins
```

### Шаг 5: Подготовить иконки + splash (см. ../../apps/neurohub/ios-assets/README.md)

```bash
# Положить icon.png (1024×1024) и splash.png (2732×2732) в apps/neurohub/ios-assets/
npm install -g @capacitor/assets
cd apps/neurohub
npx @capacitor/assets generate --ios \
  --iconBackgroundColor "#0a0a17" \
  --splashBackgroundColor "#0a0a17"
```

### Шаг 6: Открыть в Xcode

```bash
npx cap open ios
# → откроет ios/App/App.xcworkspace в Xcode
```

### Шаг 7: Подписать (Signing & Capabilities)

В Xcode:
1. Выбрать target `App` в навигаторе
2. Вкладка **Signing & Capabilities**
3. **Team**: выбрать свой Apple Developer Team (появится после login в Xcode → Settings → Accounts → Apple ID)
4. **Bundle Identifier**: `ru.muzaai.app` (уже задан в Capacitor config)
5. Включить **Automatically manage signing** ✅
6. Xcode сам создаст provisioning profiles + signing certificates

Если Bundle ID `ru.muzaai.app` уже занят (App Store globally unique) — поменять на что-то типа `ru.muzaai.MuzaAi` или `com.eugene.muzaai`. После смены — обновить в `capacitor.config.ts` + `npx cap sync ios`.

### Шаг 8: Запустить на Simulator

В Xcode top bar:
- Выбрать device: **iPhone 16 Pro Simulator** (или другой)
- Нажать ▶️ (Play / Build & Run)
- Через ~30 сек Simulator запустит приложение

Должно открыться: splash 2 сек (фирменный фон) → WebView показывает `muzaai.ru`. Все плеер-features работают как в Safari + native MediaSession на lock-screen.

### Шаг 9: Запустить на физическом iPhone (опционально для отладки)

1. Подключить iPhone к Mac через USB-C / Lightning
2. На iPhone: Settings → Privacy & Security → Developer Mode → ON (требует перезагрузку)
3. В Xcode выбрать свой iPhone как target → ▶️
4. На iPhone разрешить установку от своего Developer Team (Settings → General → VPN & Device Management)

### Шаг 10: Архив + загрузка в App Store Connect

```
Xcode → Product menu → Archive (target должен быть "Any iOS Device", НЕ simulator)
→ откроется Organizer window после ~5 мин build
→ Distribute App → App Store Connect → Upload
→ ввести Apple Developer credentials → Upload
```

После загрузки (~15 мин обработки) — артефакт появится в https://appstoreconnect.apple.com/apps:
- Создать новое приложение (Bundle ID: `ru.muzaai.app`, Name: `MuzaAi`, Primary Language: Russian)
- Выбрать загруженную build
- Заполнить metadata (описание, ключевые слова, скриншоты, иконка, privacy policy URL)
- Submit for Review

### Шаг 11: Apple Review

- **Первый review:** 1-7 дней (Apple часто реджектит первое приложение — особенно за privacy policy, недостающие скриншоты, описание)
- **Последующие:** обычно 24-48 часов

Когда review пройден — приложение появляется в App Store автоматически (или ручной release по выбору).

---

## Update workflow (когда меняется web-код)

Поскольку у нас hybrid mode (`server.url`), большинство обновлений web НЕ требуют App Store Review:

### Случай 1: Web-изменение (компоненты, контент, тексты, KB, новости)

```
1. Eugene → push в claude/add-claude-documentation-OW5V7
2. Auto-deploy на VPS → muzaai.ru обновился
3. Юзеры в iOS app получают изменения СРАЗУ при следующем открытии (WebView рефрешит)
```

**Никакого Apple Review.** Это главное преимущество hybrid-подхода.

### Случай 2: Native изменения (новый Capacitor plugin, splash, capabilities, push настройка)

```
1. На Mac: cd apps/neurohub
2. Обновить capacitor.config.ts (например добавить новый plugin)
3. npm install <new-plugin>
4. npx cap sync ios
5. Xcode → Archive → Submit
6. Apple Review (1-7 дней)
7. Юзеры получают обновление через App Store update
```

### Случай 3: Минорный web-update + native sync

Если хочется обновить bundle web-кода **внутри** app (для offline-режима или ускорения первого запуска):

```
cd apps/neurohub
npm run build           # обновляет dist/public/
npx cap copy ios        # копирует в ios/App/App/public/
npx cap sync ios        # обновляет native deps если поменялись
# Xcode → Archive → Submit
```

---

## iOS-specific quirks (отличия от Safari)

### MediaSession + Audio

Capacitor WebView = WKWebView = тот же engine что Safari. Значит **все правила из CLAUDE.md** работают идентично:

- ✅ Persistent-audio-only rule — НЕ создавать new Audio для player tracks
- ✅ iOS-lock-screen-audio rule — НЕ использовать `createMediaElementSource` на iOS
- ✅ Apple-audio-best-practices rule — MediaSession setup synchronously в user gesture handler
- ✅ Suno-audio-playback rule — cookie auth + `crossOrigin="use-credentials"`

**Но есть отличия:**
- **Native MediaSession lock-screen работает лучше в Capacitor app** чем в Safari mobile — потому что WKWebView получает audio focus через native iOS APIs (более стабильно)
- **Background audio:** в Capacitor app можно явно запросить background audio capability (Info.plist → UIBackgroundModes → audio) — тогда WebView продолжит играть когда юзер свернул app. В Safari такого нет, audio останавливается через ~30-60 сек.

### Cookies + Session persistence

WKWebView в Capacitor app имеет **отдельный cookie storage** от Safari. Это значит:
- Юзер залогинен в Safari ≠ залогинен в Capacitor app (разные sessions)
- Это норм — Apple так делает для всех hybrid apps
- Решение: при первом запуске app → auto-redirect на `/auth/sms-login` (юзер регистрируется заново). Или Universal Links + token transfer.

### Cellular data restrictions

Apple требует чтобы apps работали на 4G/5G (не только Wi-Fi). У нас web-bundle 5-10 MB — нормально загрузится на cellular. Но **первый запуск** может занять 10-30 сек на медленном 4G — splash покрывает это время.

### App Tracking Transparency (ATT)

Если используем any analytics что считается «tracking» (Yandex Metrika, VK Pixel, Facebook Pixel) — Apple требует показать ATT prompt при первом запуске:

```
«MuzaAi хочет отслеживать вашу активность в других приложениях.
Это поможет улучшить рекомендации песен.
[Разрешить]  [Не отслеживать]»
```

Без ATT-разрешения — Yandex Metrika не сможет связать iOS-юзера с web-юзером по IDFA. Метрика по userId всё равно работает.

**TODO:** добавить `@capacitor-community/app-tracking-transparency` plugin при первой подаче в App Store (или skip, если используем только server-side analytics по userId).

### Push notifications

В России **APNs (Apple Push Notification service) работает** — Apple не блокировал. Можно использовать `@capacitor/push-notifications`:

```bash
npm install @capacitor/push-notifications
npx cap sync ios
```

Затем в Xcode добавить **Push Notifications** capability + **Background Modes → Remote notifications**. Сервер шлёт push через APNs (нужен APNs key из Apple Developer аккаунта → Certificates, Identifiers & Profiles → Keys).

Альтернатива: Firebase Cloud Messaging (бесплатно, но требует Firebase project + FCM работает в РФ через APNs всё равно).

---

## In-App Purchases (IAP) — для премиум-фич

### Когда нужны

- Покупка треков напрямую из app (399 ₽ за трек)
- Премиум-подписка (premium_voice_msg — голосовые сообщения от Музы)
- Пополнение баланса

### Apple Tax 30% — **главный аргумент**

Apple **берёт 30% с любых платежей** через IAP. То есть:
- В web (Robokassa) Босс получает ~97% от 399 ₽ = 387 ₽
- В iOS app (IAP) Босс получит 70% от 399 ₽ = 279 ₽

**Каждый трек проданный через IAP дешевле для бизнеса на ~110 ₽** = 28% потерь.

### Альтернативы (legal в App Store)

Apple запрещает **рекламировать** внешние способы оплаты ВНУТРИ app. Но разрешено:

1. **Reader app (free + external login).** Если app даёт доступ к контенту купленному в web — IAP НЕ обязателен. Юзер заходит в app под своим аккаунтом, видит свои треки, играет. Покупка только через web на muzaai.ru.

   **Решение для MuzaAi:** оформить как «Reader app» — генерация треков делается в web, app только воспроизводит купленное.

2. **Hybrid approach.** Все основные покупки в web (Robokassa, 3% потерь). IAP только для **бонусных** или **подписочных** фич (типа «убрать рекламу» — но у нас нет рекламы).

3. **Web-payment links сабъект к Apple Guideline 3.1.1** (US) — после Epic vs Apple Apple обязана разрешать «buttons or external links to other purchasing mechanisms» в US. В РФ скрин-кейс — серая зона.

### План для первого submit

1. **НЕ добавлять IAP в первый submit** — это упрощает review
2. Все платежи остаются через Robokassa (web-side)
3. В app — только воспроизведение купленного + просмотр profile
4. После одобрения первой версии — A/B тест: добавить IAP как option для тех кто не хочет переходить в Safari

---

## Privacy policy + App Store metadata требования

### Обязательно для submit

1. **Privacy Policy URL** — публичная страница на muzaai.ru/privacy. Должна включать:
   - Какие данные собираются (телефон, email, IP, события генерации)
   - Зачем (для функционирования сервиса, аналитика, маркетинг)
   - Хранение (на серверах в РФ, не передаются третьим лицам кроме провайдеров платежей)
   - Права юзера (удаление аккаунта, экспорт данных — GDPR-style)
2. **Support URL** — muzaai.ru/support или email `hello@muziai.ru`
3. **Marketing URL** (опционально) — muzaai.ru
4. **App description** (RU + EN) — что приложение делает
5. **Keywords** — для поиска в App Store
6. **Category** — Music (primary)
7. **Age rating** — заполнить questionnaire в App Store Connect (обычно 12+ из-за UGC контент)

### Скриншоты

Apple требует скриншоты для каждого размера экрана:
- iPhone 6.7" (iPhone 16 Pro Max) — 1290 × 2796 — **обязательно**
- iPhone 6.5" (iPhone 14 Plus) — 1242 × 2688 — обязательно
- iPad Pro 12.9" 6th gen — 2048 × 2732 — обязательно если поддерживаем iPad
- Минимум 3 скриншота на каждое разрешение, максимум 10

Использовать iOS Simulator + Xcode для генерации (Cmd+S сохраняет PNG).

### App Privacy questionnaire

В App Store Connect → App Privacy → ответить на ~50 вопросов:
- Контакт информация (телефон, email) — Yes, used to identify user
- Audio data — Yes (voice messages), linked to user, not used for tracking
- Purchase history — Yes
- Crash data — Yes (linked to user)
- Performance data — Yes
- Etc.

---

## Cost summary (для Босса)

| Item | Cost | Frequency |
|---|---|---|
| Apple Developer Program | $99 | Annual |
| Mac (Intel/Apple Silicon) | $1500+ (если нет) | One-time |
| Xcode | $0 | — |
| iOS Simulator | $0 | — |
| Capacitor | $0 (MIT license) | — |
| Apple Tax (если IAP) | 30% with revenue | Per transaction |
| App Store review | $0 | — |
| Push notifications (APNs) | $0 | — |
| **Минимум для start** | **$99 + Mac** | — |

---

## Reference

- Capacitor docs: https://capacitorjs.com/docs
- iOS deployment guide: https://capacitorjs.com/docs/ios
- App Store guidelines: https://developer.apple.com/app-store/review/guidelines/
- App Store Connect: https://appstoreconnect.apple.com/
- Apple Developer console: https://developer.apple.com/account/

## Связанные правила в CLAUDE.md

- `iOS-app-capacitor rule` (Eugene 2026-05-21) — bundle ID + workflow
- `iOS-lock-screen-audio rule` — NowPlaying на lock-screen
- `Apple-audio-best-practices rule` — MediaSession + Web Audio API constraints
- `Persistent-audio-only rule` — single audio element pattern
- `Suno-audio-playback rule` — protected stream auth для WebView
