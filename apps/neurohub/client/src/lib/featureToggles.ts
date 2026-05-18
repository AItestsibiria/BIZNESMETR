// featureToggles — единый реестр опциональных frontend-фич.
// Eugene 2026-05-19: «по всему проекту фронт — простая возможность выключить».
//
// Каждая опциональная фича читает featureEnabled(key) для проверки нужна
// ли она юзеру. Состояние persistится в localStorage под ключом FEATURES_KEY.
// Изменения broadcast'ятся через CustomEvent("features-changed") чтобы
// подписчики могли react'ить без полного refresh.

const FEATURES_KEY = "_user_features";

export type FeatureKey =
  | "walking-musa"          // walking + mouse-follow + контекст подсказки
  | "floating-consultant"   // чат-FAB (если выключить — Муза-чат недоступен)
  | "cover-highlight"       // подсветка обложек с custom-cover на главной/swipe
  | "background-music"      // фоновая музыка на главной
  | "chat-sounds"           // звуки уведомлений чата
  | "karaoke"               // караоке-текст
  | "auto-play-tour"        // авто-тур Музы (первый визит)
  | "leave-page-warning";   // beforeunload при активной генерации

export interface FeatureMeta {
  key: FeatureKey;
  label: string;
  description: string;
  defaultEnabled: boolean;
}

export const FEATURES: FeatureMeta[] = [
  {
    key: "walking-musa",
    label: "🚶 Помощница за курсором",
    description: "Муза идёт за курсором, показывает подсказки на кнопках",
    defaultEnabled: true,
  },
  {
    key: "auto-play-tour",
    label: "🎭 Авто-тур Музы",
    description: "Первый показ возможностей сайта через прогулку Музы",
    defaultEnabled: true,
  },
  {
    key: "floating-consultant",
    label: "💬 Чат с Музой",
    description: "Плавающая кнопка чата в углу",
    defaultEnabled: true,
  },
  {
    key: "cover-highlight",
    label: "✨ Подсветка обложек",
    description: "Розовое свечение на треках с авторской обложкой",
    defaultEnabled: true,
  },
  {
    key: "background-music",
    label: "🎵 Фоновая музыка",
    description: "Lobby music во время загрузки страниц",
    defaultEnabled: true,
  },
  {
    key: "chat-sounds",
    label: "🔔 Звуки чата",
    description: "Beep при открытии и новых сообщениях",
    defaultEnabled: true,
  },
  {
    key: "karaoke",
    label: "🎤 Караоке-текст",
    description: "Подсветка строк по таймингу при воспроизведении",
    defaultEnabled: true,
  },
  {
    key: "leave-page-warning",
    label: "⚠️ Предупреждение при уходе",
    description: "При активной генерации — предупреждаем если уходишь",
    defaultEnabled: true,
  },
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
