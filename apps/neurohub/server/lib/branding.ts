// branding (Eugene 2026-05-15 Босс «правило: при смене лого автоматом
// замена где нужно»). Серверный аналог client/lib/branding.ts —
// централизованные константы для email-шаблонов, bot-replies, og-tags,
// ID3-tags.
//
// При смене бренда — менять ТОЛЬКО этот файл (+ client/lib/branding.ts +
// HTML title + manifest.json). Все imports автоматически подхватят.

import { PUBLIC_URL, PUBLIC_DOMAIN } from "./publicUrl";

export const BRAND = {
  /** Латинское название (CamelCase). */
  name: "MuzaAi",
  /** Русское название с пробелом — для bot footer, RU UI, voice. */
  nameRu: "Муза Ай",
  /** Domain без https:// — для email-text, og-url. */
  domain: PUBLIC_DOMAIN,
  /** Полный URL для ссылок и href. */
  url: PUBLIC_URL,
  /** Email для контактов (MX-записи на старом домене). */
  supportEmail: "hello@muziai.ru",
  /** Telegram bot username (не меняется при rebrand). */
  telegramBot: "Muziaipodari_bot",
  /** Tagline для emails / push. */
  tagline: "Создавай музыку с ИИ",
  /** ID3-tag album для новых mp3. */
  id3Album: "MuzaAi.ru",
  /** Footer для bot-replies (telegram, max, future channels). */
  botFooter: (personaName: string) => `\n\n— ${personaName} · MuzaAi`,
  botFooterRu: (personaName: string) => `\n\n— ${personaName} · Муза Ай`,
} as const;
