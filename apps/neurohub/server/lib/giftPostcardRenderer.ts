// Eugene 2026-05-23 Босс «подарочные сертификаты + формирование открытки».
// SVG-генерация postcard'ов. 4 шаблона:
//   - classic    (purple/fuchsia gradient, универсальный)
//   - birthday   (amber/pink, торт-эмодзи, тёплый)
//   - love       (rose/pink, сердца)
//   - wedding    (cyan/blue, торжественный)
//
// Все в brand-style consistency rule (CLAUDE.md) — palette из index.css:
//   cyber-violet #7C3AED, electric-blue #00D4FF, hot-magenta #FF006E,
//   neon-green #39FF14, amber-glow #FBBF24.
//
// Возвращает SVG string. Optional PNG buffer через sharp — если пакет
// установлен. Если sharp не доступен — fallback на SVG only.

export type PostcardTemplate = "classic" | "birthday" | "love" | "wedding";

export const POSTCARD_TEMPLATES: PostcardTemplate[] = ["classic", "birthday", "love", "wedding"];

export interface PostcardOptions {
  template: PostcardTemplate;
  /** 12-символьный код XXXX-XXXX-XXXX */
  code: string;
  /** Заголовок (имя получателя или повод). Макс 60 chars. */
  title?: string | null;
  /** Сообщение от дарителя. Макс 500 chars. */
  message?: string | null;
  /** Имя дарителя (для подписи). */
  fromName?: string | null;
  /** Сумма / квота — отображается на лицевой стороне. */
  valueLabel?: string | null;
  /** Дата истечения (например «до 23 мая 2027»). */
  expiresLabel?: string | null;
}

export interface PostcardRenderResult {
  svg: string;
  width: number;
  height: number;
}

export function renderPostcardSvg(opts: PostcardOptions): PostcardRenderResult {
  const width = 800;
  const height = 1000;
  const tpl = POSTCARD_TEMPLATES.includes(opts.template) ? opts.template : "classic";
  const palette = getPalette(tpl);
  const title = sanitize(opts.title || "Подарок от души");
  const message = sanitize(opts.message || "");
  const fromName = sanitize(opts.fromName || "");
  const code = sanitize(opts.code || "");
  const valueLabel = sanitize(opts.valueLabel || "");
  const expiresLabel = sanitize(opts.expiresLabel || "");

  const emoji = getEmoji(tpl);

  const messageLines = splitToLines(message, 32, 6); // макс 6 строк
  const messageSvg = messageLines
    .map((line, i) => `<text x="400" y="${640 + i * 32}" fill="#ffffff" font-family="Inter, sans-serif" font-size="22" font-weight="400" text-anchor="middle" opacity="0.92">${line}</text>`)
    .join("\n");

  return {
    width,
    height,
    svg: `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${palette.bgFrom}"/>
      <stop offset="50%" stop-color="${palette.bgVia}"/>
      <stop offset="100%" stop-color="${palette.bgTo}"/>
    </linearGradient>
    <linearGradient id="title" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${palette.titleFrom}"/>
      <stop offset="100%" stop-color="${palette.titleTo}"/>
    </linearGradient>
    <linearGradient id="codeBg" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${palette.codeBgFrom}"/>
      <stop offset="100%" stop-color="${palette.codeBgTo}"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="${width}" height="${height}" fill="url(#bg)"/>

  <!-- Decorative stars/dots -->
  ${renderDecorations(tpl, palette)}

  <!-- Brand badge -->
  <text x="400" y="80" fill="#ffffff" font-family="Space Grotesk, Inter, sans-serif" font-size="20" font-weight="700" text-anchor="middle" opacity="0.85" letter-spacing="3">MuzaAi</text>
  <text x="400" y="105" fill="#ffffff" font-family="Inter, sans-serif" font-size="13" font-weight="400" text-anchor="middle" opacity="0.6">Подарочный сертификат</text>

  <!-- Hero emoji -->
  <text x="400" y="260" font-size="120" text-anchor="middle" filter="url(#glow)">${emoji}</text>

  <!-- Title -->
  <text x="400" y="370" fill="url(#title)" font-family="Space Grotesk, Inter, sans-serif" font-size="42" font-weight="700" text-anchor="middle" filter="url(#glow)">${title}</text>

  <!-- Value -->
  ${valueLabel ? `<text x="400" y="440" fill="#ffffff" font-family="Inter, sans-serif" font-size="36" font-weight="700" text-anchor="middle">${valueLabel}</text>` : ""}

  <!-- Decorative divider -->
  <line x1="200" y1="490" x2="600" y2="490" stroke="${palette.dividerColor}" stroke-width="1" opacity="0.4"/>

  <!-- Personal message header -->
  ${message ? `<text x="400" y="565" fill="${palette.accentColor}" font-family="Inter, sans-serif" font-size="14" font-weight="600" text-anchor="middle" letter-spacing="2" opacity="0.85">ПОЗДРАВЛЕНИЕ</text>` : ""}

  <!-- Message body -->
  ${messageSvg}

  <!-- From -->
  ${fromName ? `<text x="400" y="850" fill="#ffffff" font-family="Inter, sans-serif" font-size="18" font-style="italic" font-weight="500" text-anchor="middle" opacity="0.85">— от ${fromName}</text>` : ""}

  <!-- Code panel -->
  <rect x="120" y="888" width="560" height="70" rx="14" fill="url(#codeBg)" opacity="0.95"/>
  <text x="400" y="918" fill="#ffffff" font-family="Inter, sans-serif" font-size="11" font-weight="500" text-anchor="middle" opacity="0.75" letter-spacing="2">КОД АКТИВАЦИИ</text>
  <text x="400" y="945" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="22" font-weight="700" text-anchor="middle" letter-spacing="4">${code}</text>

  <!-- Footer expires -->
  ${expiresLabel ? `<text x="400" y="985" fill="#ffffff" font-family="Inter, sans-serif" font-size="11" font-weight="400" text-anchor="middle" opacity="0.5">Действителен ${expiresLabel}</text>` : ""}
</svg>`.trim(),
  };
}

interface Palette {
  bgFrom: string;
  bgVia: string;
  bgTo: string;
  titleFrom: string;
  titleTo: string;
  codeBgFrom: string;
  codeBgTo: string;
  accentColor: string;
  dividerColor: string;
}

function getPalette(tpl: PostcardTemplate): Palette {
  switch (tpl) {
    case "birthday":
      // Тёплый amber + magenta, торжественный.
      return {
        bgFrom: "#3B0A2E",
        bgVia: "#1A0A2A",
        bgTo: "#0F0F2E",
        titleFrom: "#FBBF24",   // amber
        titleTo: "#FB7185",     // rose
        codeBgFrom: "rgba(124,58,237,0.5)",
        codeBgTo: "rgba(0,212,255,0.5)",
        accentColor: "#FBBF24",
        dividerColor: "#FBBF24",
      };
    case "love":
      // Rose / pink / fuchsia, мягкий.
      return {
        bgFrom: "#3B0F2A",
        bgVia: "#2A0F38",
        bgTo: "#1A0F2E",
        titleFrom: "#FF006E",   // hot-magenta
        titleTo: "#A78BFA",     // purple
        codeBgFrom: "rgba(255,0,110,0.55)",
        codeBgTo: "rgba(124,58,237,0.55)",
        accentColor: "#FF006E",
        dividerColor: "#FF006E",
      };
    case "wedding":
      // Cyan / blue / violet, торжественный.
      return {
        bgFrom: "#0F1F3B",
        bgVia: "#1A1A38",
        bgTo: "#0F0F2E",
        titleFrom: "#00D4FF",   // electric-blue
        titleTo: "#A78BFA",     // purple
        codeBgFrom: "rgba(0,212,255,0.55)",
        codeBgTo: "rgba(124,58,237,0.55)",
        accentColor: "#00D4FF",
        dividerColor: "#00D4FF",
      };
    case "classic":
    default:
      // Brand purple → fuchsia → cyan (по умолчанию).
      return {
        bgFrom: "#1E0F38",
        bgVia: "#0F1230",
        bgTo: "#0A0A17",
        titleFrom: "#A78BFA",   // purple-300
        titleTo: "#67E8F9",     // cyan-300
        codeBgFrom: "rgba(124,58,237,0.55)",
        codeBgTo: "rgba(217,70,239,0.55)",
        accentColor: "#A78BFA",
        dividerColor: "#A78BFA",
      };
  }
}

function getEmoji(tpl: PostcardTemplate): string {
  switch (tpl) {
    case "birthday": return "🎂";
    case "love": return "💝";
    case "wedding": return "💍";
    case "classic":
    default: return "🎁";
  }
}

function renderDecorations(tpl: PostcardTemplate, palette: Palette): string {
  // Простые звёзды/точки распределены детерминистично (по позициям).
  const stars: Array<{ x: number; y: number; r: number; o: number }> = [
    { x: 80, y: 160, r: 2, o: 0.5 },
    { x: 720, y: 200, r: 3, o: 0.7 },
    { x: 130, y: 320, r: 1.5, o: 0.4 },
    { x: 680, y: 360, r: 2.5, o: 0.6 },
    { x: 60, y: 480, r: 2, o: 0.5 },
    { x: 740, y: 510, r: 2, o: 0.55 },
    { x: 90, y: 720, r: 1.5, o: 0.35 },
    { x: 710, y: 760, r: 2, o: 0.45 },
  ];
  return stars
    .map((s) => `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="${palette.accentColor}" opacity="${s.o}"/>`)
    .join("\n  ");
}

/**
 * Эскейпит спецсимволы для SVG-текста (HTML-encode).
 * Запрещает inline <script>, оставляет безопасный plain text.
 */
function sanitize(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .slice(0, 500);
}

/**
 * Разбить длинное сообщение на строки по wordWrap charsPerLine.
 * Максимум maxLines строк — остальное обрезается с «…».
 */
function splitToLines(text: string, charsPerLine: number, maxLines: number): string[] {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length === 0) {
      cur = w;
    } else if (cur.length + 1 + w.length <= charsPerLine) {
      cur = `${cur} ${w}`;
    } else {
      lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.length > lines.join(" ").split(/\s+/).length) {
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, charsPerLine - 1) + "…";
  }
  return lines;
}
