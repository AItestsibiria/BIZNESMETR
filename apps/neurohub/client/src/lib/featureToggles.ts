// featureToggles — единый реестр опциональных frontend-фич.
// Eugene 2026-05-19: «по всему проекту фронт — простая возможность выключить».
// Eugene 2026-05-19: «все делаем, отключим если надо. Заведи в админке
// управление одним блоком с подсказками для админа».
//
// Каждая опциональная фича читает featureEnabled(key) для проверки нужна
// ли она юзеру. Состояние persistится в localStorage под ключом FEATURES_KEY.
// Изменения broadcast'ятся через CustomEvent("features-changed") чтобы
// подписчики могли react'ить без полного refresh.

const FEATURES_KEY = "_user_features";

export type FeatureCategory =
  | "ui"
  | "notifications"
  | "audio"
  | "privacy"
  | "mobile"
  | "a11y"
  | "system"
  | "musa";

export type FeatureKey =
  // UI / визуал
  | "walking-musa"
  | "auto-play-tour"
  | "floating-consultant"
  | "cover-highlight"
  | "globe-3d"
  | "karaoke"
  | "hitech-effects"
  | "particle-fab"
  | "modal-animations"
  | "news-block"
  | "compact-mode"
  | "reduced-motion-override"
  | "long-press-save"
  | "active-track-highlight"
  // Notifications
  | "toast-on-ready"
  | "push-on-ready"
  | "sound-on-ready"
  | "blink-tab-on-ready"
  | "chat-sounds"
  | "leave-page-warning"
  // Audio
  | "background-music"
  | "auto-play-next"
  | "crossfade-tracks"
  | "volume-persist"
  | "repeat-mode-persist"
  | "auto-pause-on-hidden"
  // Privacy / трекинг
  | "yandex-metrica"
  | "vk-pixel"
  | "ip-geo-lookup"
  | "engagement-tracking"
  | "broadcast-sync"
  | "visitor-fingerprint"
  // Mobile
  | "sticky-bottom-player"
  | "hide-nav-on-scroll"
  | "swipe-gestures"
  | "haptic-feedback"
  // Accessibility
  | "high-contrast"
  | "large-text"
  | "skip-links"
  // System
  | "lockscreen-mediasession"
  | "lockscreen-position-sync"
  | "persistent-audio"
  // Musa-помощник
  | "musa-mini-player"
  | "musa-chat-resize"
  | "musa-idle-prompt"
  | "musa-propose-gen-card";

export interface FeatureMeta {
  key: FeatureKey;
  label: string;
  description: string;       // для юзера
  adminHint?: string;        // расширенная инструкция для админа
  category: FeatureCategory;
  defaultEnabled: boolean;
  /** Если true — фича пока без wiring (toggle есть, но кода ещё нет). Отображается как «скоро». */
  pending?: boolean;
}

export const CATEGORY_LABELS: Record<FeatureCategory, string> = {
  ui: "🎨 Визуал / UX",
  notifications: "🔔 Уведомления",
  audio: "🎵 Аудио",
  privacy: "📊 Приватность / трекинг",
  mobile: "📱 Mobile",
  a11y: "♿ Accessibility",
  system: "🎬 Lock-screen / системные",
  musa: "🤖 Помощница Муза",
};

export const FEATURES: FeatureMeta[] = [
  // ============ UI / визуал ============
  { key: "walking-musa", label: "🚶 Помощница за курсором", description: "Муза идёт за курсором, показывает подсказки на кнопках",
    adminHint: "Mouse-follow + контекстные подсказки через data-musa-hint. Снижает confusion на новой странице.", category: "ui", defaultEnabled: true },
  { key: "auto-play-tour", label: "🎭 Авто-тур Музы", description: "Первый показ возможностей через ходящую Музу",
    adminHint: "5 остановок desktop / 3 mobile. Запускается через 30 сек на странице, раз в 24ч.", category: "ui", defaultEnabled: true },
  { key: "floating-consultant", label: "💬 Чат с Музой (FAB)", description: "Плавающая кнопка чата в углу",
    adminHint: "Bottom-right FAB. Главный entry в Музу-чат. Отключение скрывает чат полностью — пользователь не сможет писать.", category: "ui", defaultEnabled: true },
  { key: "cover-highlight", label: "✨ Подсветка обложек", description: "Розовое свечение на треках с авторской обложкой",
    adminHint: "Ring + shadow на mini-cover (landing) и в swipe-modal. Маркирует custom-cover (не Suno-default).", category: "ui", defaultEnabled: true },
  { key: "globe-3d", label: "🌍 3D-глобус стран", description: "Настоящий вращающийся 3D-глобус с реальной географией и маркерами стран-слушателей",
    adminHint: "react-globe.gl + three.js. Lazy-load + ErrorBoundary + WebGL-детект. При ошибке (нет WebGL / не загрузилась CDN-текстура) показывает обычный список стран. Открывается кнопкой «🌍 3D» из панели стран на плеере.", category: "ui", defaultEnabled: true },
  { key: "karaoke", label: "🎤 Караоке-текст", description: "Подсветка строк по таймингу при воспроизведении",
    adminHint: "Activatable через кнопку «Текст» в expanded плеере. Требует track.lyric.", category: "ui", defaultEnabled: true },
  { key: "hitech-effects", label: "✨ Hi-tech эффекты", description: "scan-line / cyber-grid / holographic shimmer на админке и swipe",
    adminHint: "CSS-only утилиты (.scan-line, .cyber-grid, .holographic). Reduced-motion safe.", category: "ui", defaultEnabled: true, pending: true },
  { key: "particle-fab", label: "✨ Частицы вокруг кнопок", description: "Floating частицы вокруг кнопки Музы в idle",
    adminHint: ".particle-bg утility — 2 floating particles, 6-7 сек циклы. CSS-only.", category: "ui", defaultEnabled: true, pending: true },
  { key: "modal-animations", label: "🎬 Анимации модалок", description: "fade / scale / slide при открытии модалок",
    adminHint: "framer-motion AnimatePresence. При выключении — модалки появляются мгновенно.", category: "ui", defaultEnabled: true, pending: true },
  { key: "news-block", label: "📰 Новости на главной", description: "Блок последних 3 новостей под hero",
    adminHint: "CMS landing-news. Если отключено — блок скрыт, не влияет на админский CMS-управление.", category: "ui", defaultEnabled: true, pending: true },
  { key: "compact-mode", label: "📐 Компактный режим", description: "Плотнее padding и font для большего контента на экране",
    adminHint: "Глобальный class на <html> — компоненты с .compact:padding-2. Для пользователей с маленьким экраном.", category: "ui", defaultEnabled: false, pending: true },
  { key: "reduced-motion-override", label: "🐢 Отключить анимации", description: "Все CSS-анимации/transition выключены",
    adminHint: "Force-overrides prefers-reduced-motion=reduce. Для слабых устройств.", category: "ui", defaultEnabled: false, pending: true },
  { key: "long-press-save", label: "📥 Long-press сохранение", description: "Удержание обложки 0.65 сек → скачать с watermark",
    adminHint: "Canvas-генерация JPG с MuzaAi.ru pill. Может тригериться случайно при slow tap.", category: "ui", defaultEnabled: true },
  { key: "active-track-highlight", label: "🎯 Подсветка играющего трека", description: "Active state на карточке играющего трека",
    adminHint: "bg-purple-500/[0.08] на text-track-card data-active.", category: "ui", defaultEnabled: true, pending: true },

  // ============ Notifications ============
  { key: "toast-on-ready", label: "🍞 Toast при готовом треке", description: "Pop-up «Готова!» в углу",
    adminHint: "shadcn/ui toast. Триггерится на gen.status=done event через SSE/polling.", category: "notifications", defaultEnabled: true, pending: true },
  { key: "push-on-ready", label: "🔔 Push-уведомления", description: "Browser push когда вкладка свёрнута",
    adminHint: "Web Push API. Требует юзер permission. NotificationsManager Service Worker.", category: "notifications", defaultEnabled: false, pending: true },
  { key: "sound-on-ready", label: "🎺 Звон при готовом треке", description: "Гонг при завершении генерации",
    adminHint: "Web Audio API tone (G4-C5 arpeggio). Volume 0.15.", category: "notifications", defaultEnabled: true, pending: true },
  { key: "blink-tab-on-ready", label: "👁 Моргание вкладки", description: "title=«🔥 Готово!» когда вкладка скрыта",
    adminHint: "setInterval title swap. Останавливается при focus event.", category: "notifications", defaultEnabled: true, pending: true },
  { key: "chat-sounds", label: "🔔 Звуки чата", description: "Beep при открытии и новых сообщениях",
    adminHint: "Web Audio API в muza-sounds.ts. playMuzaChime/Tick/Sparkle.", category: "notifications", defaultEnabled: true },
  { key: "leave-page-warning", label: "⚠️ Предупреждение при уходе", description: "При активной генерации — предупреждаем если уходишь",
    adminHint: "beforeunload prompt. Браузер показывает default modal — текст частично контролируем.", category: "notifications", defaultEnabled: true },

  // ============ Audio ============
  { key: "background-music", label: "🎵 Фоновая музыка", description: "Lobby music во время загрузки страниц",
    adminHint: "/audio/bgm.mp3, volume 0.25, looped. Играет на /music + /lyrics.", category: "audio", defaultEnabled: true },
  { key: "auto-play-next", label: "⏭ Auto-play следующего", description: "Continuous воспроизведение по списку",
    adminHint: "При onEnded — переход на (idx+1)%length. Уже работает по default; toggle для off.", category: "audio", defaultEnabled: true, pending: true },
  { key: "crossfade-tracks", label: "🎶 Cross-fade переходы", description: "1.5 сек плавный переход между треками",
    adminHint: "Web Audio API GainNode. Требует Audio API setup (поверх Persistent-audio).", category: "audio", defaultEnabled: false, pending: true },
  { key: "volume-persist", label: "🔊 Запоминать громкость", description: "Volume и mute сохраняются между сессиями",
    adminHint: "localStorage _muziai_volume. Уже частично работает.", category: "audio", defaultEnabled: true, pending: true },
  { key: "repeat-mode-persist", label: "🔁 Запоминать режим повтора", description: "Repeat off/all/one persist между сессиями",
    adminHint: "localStorage _muziai_repeat_mode.", category: "audio", defaultEnabled: true, pending: true },
  { key: "auto-pause-on-hidden", label: "⏸ Пауза при сворачивании", description: "Auto-pause когда вкладка не активна",
    adminHint: "Page Visibility API. visibilitychange event → audio.pause(). Спорное — некоторые слушают в фоне.", category: "audio", defaultEnabled: false, pending: true },

  // ============ Privacy / трекинг ============
  { key: "yandex-metrica", label: "📈 Yandex Metrica", description: "Аналитика посещений Яндекс",
    adminHint: "ym(counterId, 'hit', url). Отключение блокирует YM_COUNTER_ID в App.tsx.", category: "privacy", defaultEnabled: true, pending: true },
  { key: "vk-pixel", label: "📊 VK Pixel", description: "Ретаргетинг VK",
    adminHint: "VK_PIXEL_ID. Отключение блокирует pixel script.", category: "privacy", defaultEnabled: true, pending: true },
  { key: "ip-geo-lookup", label: "🌍 IP geo-lookup", description: "Определение страны/города по IP",
    adminHint: "Server-side через ip-api.com (отдельный flag в server/.env). Здесь — флаг только для отображения юзеру.", category: "privacy", defaultEnabled: true, pending: true },
  { key: "engagement-tracking", label: "🎯 Отслеживание действий", description: "Клики/скроллы/просмотры → backend",
    adminHint: "lib/engagement.ts trackEngagement(). 11 call-sites. Отключение блокирует POST /api/engagement/events.", category: "privacy", defaultEnabled: true, pending: true },
  { key: "broadcast-sync", label: "📻 Sync между вкладками", description: "BroadcastChannel — события (logout, play) синкаются",
    adminHint: "BroadcastChannel API. Без него — каждая вкладка автономна.", category: "privacy", defaultEnabled: true, pending: true },
  { key: "visitor-fingerprint", label: "👆 Fingerprint посетителя", description: "Уникальный ID браузера (без cookies)",
    adminHint: "Canvas/WebGL fingerprint hash. Для админ-аналитики уникальных юзеров. GDPR-зона.", category: "privacy", defaultEnabled: true, pending: true },

  // ============ Mobile ============
  { key: "sticky-bottom-player", label: "📲 Закреплённый плеер снизу", description: "Mini-player всегда виден внизу экрана",
    adminHint: "fixed bottom-0 для playing track. Работает только на мобильных <640px.", category: "mobile", defaultEnabled: true, pending: true },
  { key: "hide-nav-on-scroll", label: "👆 Скрывать nav при скролле", description: "Navbar исчезает при скролле вниз, появляется при вверх",
    adminHint: "IntersectionObserver на body scroll. Только mobile.", category: "mobile", defaultEnabled: false, pending: true },
  { key: "swipe-gestures", label: "👈 Свайп-жесты", description: "Свайп ← → на карточках треков для skip",
    adminHint: "framer-motion drag x. Уже работает в swipe-modal; toggle расширит на playlist.", category: "mobile", defaultEnabled: true, pending: true },
  { key: "haptic-feedback", label: "📳 Вибрация (haptic)", description: "Короткая вибрация на ключевых кликах",
    adminHint: "navigator.vibrate(10) на iOS Safari НЕ поддерживается. Android — да.", category: "mobile", defaultEnabled: true, pending: true },

  // ============ Accessibility ============
  { key: "high-contrast", label: "🔲 Высокий контраст", description: "Тёмный фон + ярко-белый текст",
    adminHint: "CSS variables. Override на --foreground/--background.", category: "a11y", defaultEnabled: false, pending: true },
  { key: "large-text", label: "🔠 Крупный текст", description: "Все размеры шрифтов +25%",
    adminHint: "html.large-text { font-size: 125%; } — каскадно увеличит всё.", category: "a11y", defaultEnabled: false, pending: true },
  { key: "skip-links", label: "⏭ Skip-links для клавиатуры", description: "Tab → перейти к main / nav / footer",
    adminHint: "<a href='#main' class='sr-only focus:not-sr-only'>. Для screen-readers.", category: "a11y", defaultEnabled: false, pending: true },

  // ============ System / Lock-screen ============
  { key: "lockscreen-mediasession", label: "🔒 Lock-screen ownership", description: "Контроль через системный lock-screen iOS",
    adminHint: "W3C MediaSession + persistent audio singleton (Persistent-audio-only rule). Если выключить — Apple Music перехватит ownership.", category: "system", defaultEnabled: true, pending: true },
  { key: "lockscreen-position-sync", label: "⏱ Позиция треков на lock-screen", description: "Прогресс играющего трека отправляется в lock-screen UI",
    adminHint: "setLockScreenPosition() из lib/lockscreen.ts. Требует lockscreen-mediasession=true.", category: "system", defaultEnabled: true, pending: true },
  { key: "persistent-audio", label: "🎧 Один <audio> singleton", description: "Все треки через единственный audio element (Persistent-audio-only rule)",
    adminHint: "ОБЯЗАТЕЛЬНО для корректного lock-screen. Отключение = регрессия на iOS. См. CLAUDE.md.", category: "system", defaultEnabled: true, pending: true },

  // ============ Musa-помощник ============
  { key: "musa-mini-player", label: "🎵 Mini-плеер в чате", description: "Маленький плеер играющего трека внутри Музы-чата",
    adminHint: "Floating consultant имеет mini-player для отслеживания текущего трека. Pause/play.", category: "musa", defaultEnabled: true, pending: true },
  { key: "musa-chat-resize", label: "↘ Resize чата", description: "Диагональный handle для изменения размера чат-окна",
    adminHint: "Diagonal handle в углу. Persist в localStorage. Для desktop.", category: "musa", defaultEnabled: true, pending: true },
  { key: "musa-idle-prompt", label: "🤔 Подсказка при паузе", description: "После 2-3 мин без сообщений — Муза спрашивает «Тут что-то неясно?»",
    adminHint: "setTimeout 180_000 после последнего message. Сбрасывается на любую активность.", category: "musa", defaultEnabled: true, pending: true },
  { key: "musa-propose-gen-card", label: "🎵 Inline предложение песни", description: "В чате — карточка с 3 кнопками режимов (Текст/Audio/Cover)",
    adminHint: "Маркер [PROPOSE_GEN:mode] в reply Музы. routes.ts парсит и рендерит inline card в чате.", category: "musa", defaultEnabled: true, pending: true },
];

function readState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(FEATURES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch { return {}; }
}

function writeState(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(FEATURES_KEY, JSON.stringify(state));
    window.dispatchEvent(new CustomEvent("features-changed"));
  } catch {}
}

export function featureEnabled(key: FeatureKey): boolean {
  const state = readState();
  if (key in state) return !!state[key];
  const meta = FEATURES.find(f => f.key === key);
  return meta?.defaultEnabled ?? true;
}

export function setFeatureEnabled(key: FeatureKey, enabled: boolean): void {
  const state = readState();
  state[key] = enabled;
  writeState(state);
}

export function resetAllFeatures(): void {
  try {
    localStorage.removeItem(FEATURES_KEY);
    window.dispatchEvent(new CustomEvent("features-changed"));
  } catch {}
}

// React hook — переподписывается на features-changed чтобы UI ребилдил.
import { useEffect, useState } from "react";

export function useFeatureEnabled(key: FeatureKey): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => featureEnabled(key));
  useEffect(() => {
    const update = () => setEnabled(featureEnabled(key));
    window.addEventListener("features-changed", update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener("features-changed", update);
      window.removeEventListener("storage", update);
    };
  }, [key]);
  return enabled;
}
