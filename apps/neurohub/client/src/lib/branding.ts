// branding (Eugene 2026-05-15 Босс «правило: при смене лого автоматом
// замена где нужно»). Централизованные константы для брендирования.
// Один edit здесь → распространяется во все места которые импортируют.
//
// Как использовать:
//   import { BRAND, LOGO } from "@/lib/branding";
//   <h1>{BRAND.name}</h1>            // MuzaAi
//   <p>{BRAND.nameRu}</p>            // Муза Ай
//   <a href={BRAND.url}>{BRAND.url}</a>
//   <img src={LOGO.iconSvg} />       // /favicon.svg
//
// Перед добавлением hardcoded названия/URL/лого в новый компонент —
// сначала проверить что нет такой константы здесь, добавить если нет.
//
// При смене бренда — менять ТОЛЬКО этот файл + manifest.json + HTML title.

export const BRAND = {
  /** Латинское название (CamelCase) — используется в logo, share-strings, og-tags. */
  name: "MuzaAi",
  /** Русское название с пробелом — используется в bot-footer, RU UI, voice. */
  nameRu: "Муза Ай",
  /** Domain (без https://) — используется в email-text, og-url. */
  domain: "muzaai.ru",
  /** Полный URL — для ссылок и href. */
  url: "https://muzaai.ru",
  /** Email для контактов поддержки (MX-записи на старом домене, не меняем). */
  supportEmail: "hello@muziai.ru",
  /** Telegram bot username (Telegram username не меняется при rebrand). */
  telegramBot: "Muziaipodari_bot",
  /** Tagline для footer / hero. */
  tagline: "Создавай музыку с ИИ",
  /** Tagline для og:description. */
  taglineLong: "Муза — твой ИИ-помощник. Создавай уникальные песни, обложки и тексты за минуту.",
} as const;

export const LOGO = {
  /** SVG-иконка (favicon, маленькая). */
  iconSvg: "/favicon.svg",
  /** SVG-иконка с текстом (большой logo, для share-image, OG). */
  textSvg: "/bot-logo-text.svg",
  /** SVG-иконка с микрофоном (для bot-аватаров). */
  micSvg: "/bot-logo-mic.svg",
  /** PNG-аватар Музы (для Telegram/Max bot photo). */
  consultantPng: "/consultant-avatar.png",
  /** SVG-аватар Музы (для UI). */
  consultantSvg: "/consultant-avatar.svg",
  /** Цвета бренда (gradient). */
  colors: {
    purple: "#8b5cf6",
    violet: "#7c3aed",
    blue: "#3b82f6",
    cyan: "#22d3ee",
    pink: "#ec4899",
  },
  /** CSS-gradient для logo-текста (Muza...Ai). */
  textGradient: "bg-gradient-to-r from-purple-400 via-violet-300 to-blue-400 bg-clip-text text-transparent",
  textGradientAlt: "bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent",
} as const;

/**
 * BrandLogo — переиспользуемый component для отображения logo «MuzaAi»
 * в gradient. Используется в hero, navbar, share-cards.
 *
 * Eugene 2026-05-15: при смене бренда (например «MuzaAi» → «MuzoAi») —
 * меняем только BRAND.name выше. Этот компонент автоматически отрисует
 * новое имя везде.
 */
export function brandLogoText(name: string = BRAND.name): { first: string; second: string } {
  // Делим имя на 2 части примерно посередине для двух-цветного gradient.
  // Для «MuzaAi» это «Muza» + «Ai».
  const aiIdx = name.lastIndexOf("Ai");
  if (aiIdx > 0) return { first: name.slice(0, aiIdx), second: "Ai" };
  const mid = Math.ceil(name.length / 2);
  return { first: name.slice(0, mid), second: name.slice(mid) };
}
