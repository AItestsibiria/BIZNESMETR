import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor config — единый source of truth для iOS (и future Android) сборок.
 *
 * Bundle ID: ru.muzaai.app (зарегистрирован у Apple Developer аккаунта Босса).
 * Каждое изменение здесь требует `npx cap sync ios` чтобы перенести в Xcode project.
 *
 * Документация: docs/strategy/IOS-APP-CAPACITOR-SETUP.md
 *
 * РЕЖИМ: hybrid (live load с muzaai.ru). Это даёт:
 *   - моментальные web-обновления (push в GitHub → auto-deploy на prod → юзеры видят
 *     обновлённый контент без Apple Review)
 *   - native shell (push-notifications, IAP, native splash, status-bar) даёт review
 *     только при изменении native кода
 *
 * Если когда-нибудь захотим pure-offline mode — убрать `server.url` и оставить только
 * webDir (тогда юзеры получают то что лежит в bundle на момент Apple Review).
 */
const config: CapacitorConfig = {
  appId: "ru.muzaai.app",
  appName: "MuzaAi",
  webDir: "dist/public",

  // Hybrid режим: WebView грузит production-сайт. cleartext=false — только HTTPS.
  server: {
    url: "https://muzaai.ru",
    cleartext: false,
    // androidScheme не используем (iOS-only пока)
    iosScheme: "https",
  },

  ios: {
    // iOS-specific: contentInset='automatic' даёт правильный safe-area handling
    // под notch / home indicator (важно для Persistent-audio-only + Apple-audio-best-practices правил)
    contentInset: "automatic",
    // Фон splash + WebView пока контент не загрузился — фирменный Deep Space (#0A0A17)
    backgroundColor: "#0a0a17",
    // Allow inline media playback (без fullscreen takeover для <audio>/<video>)
    allowsLinkPreview: false,
    // Scroll behaviour — нативный bouncing
    scrollEnabled: true,
    // Limit JS console только для дебага (production build скроет автоматически)
    limitsNavigationsToAppBoundDomains: false,
  },

  plugins: {
    SplashScreen: {
      // Splash при запуске — 2 сек фирменный Deep Space + лого
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: "#0a0a17",
      // androidSplashResourceName: "splash", // когда добавим Android
      iosSplashResourceName: "Splash",
      splashFullScreen: true,
      splashImmersive: true,
      // showSpinner: true → нативный spinner поверх лого пока WebView грузится
      showSpinner: true,
      spinnerStyle: "large",
      // androidSpinnerStyle: "large",
      // iosSpinnerStyle: "large",
      spinnerColor: "#7C3AED", // Cyber Violet
    },
    StatusBar: {
      // По умолчанию светлый текст на тёмном фоне (Deep Space)
      style: "DARK",
      backgroundColor: "#0a0a17",
      overlaysWebView: false,
    },
    App: {
      // Deep links / universal links — будущее (поделиться треком → откроется в app)
      // Конфигурируется через Associated Domains в Xcode Capabilities
    },
  },
};

export default config;
