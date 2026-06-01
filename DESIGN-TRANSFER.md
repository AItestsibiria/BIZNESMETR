# MuzaAi Design System — Transfer Package

Snapshot для переноса в другой проект / создания логотипа.

---

## 🎨 Brand palette (single source of truth)

| Roll | Hex | RGB | Tailwind | Use |
|---|---|---|---|---|
| **Cyber Violet** | `#7C3AED` | 124,58,237 | `purple-600` / `violet-600` | Primary AI / агенты |
| **Electric Blue** | `#00D4FF` / `#22D3EE` | 0,212,255 / 34,211,238 | `cyan-400` | Data / playlist |
| **Neon Green** | `#39FF14` | 57,255,20 | `green-400` | Auth / social CTA |
| **Hot Magenta** | `#FF006E` / `#D946EF` | 255,0,110 / 217,70,239 | `fuchsia-500` / `pink-500` | External channels |
| **Amber Glow** | `#FBBF24` / `#FDE68A` | 251,191,36 / 253,230,138 | `amber-400` / `amber-200` | Infra / admin warnings |
| **Deep Space** | `#0A0A17` | 10,10,23 | `bg-[#0a0a17]` | Background |
| **Soft Violet** | `#8B5CF6` / `#A78BFA` | 139,92,246 | `violet-500` / `violet-400` | Mid accents |
| **Lavender** | `#C4B5FD` / `#EDE9FE` | 196,181,253 | `violet-300` / `violet-100` | Soft highlights |

### Hi-tech secondary
- `#A5F3FC` (cyan-100) — ice/light highlights
- `#67E8F9` (cyan-300) — counter digit cyan phase
- `#F0ABFC` (fuchsia-300) — soft pink
- `#C7A437` — desert/sand
- `#56AB2F` (green-600) — earth/land

---

## 📐 Brand gradients

### Primary (logo-style, used in heading text)
```css
background: linear-gradient(135deg, #7C3AED 0%, #D946EF 50%, #00D4FF 100%);
/* Tailwind: bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 */
```

### Logo wordmark "MuzaAi" (gradient text-clip)
```jsx
<span className="bg-gradient-to-r from-purple-400 via-violet-300 to-blue-400 bg-clip-text text-transparent">Muza</span>
<span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">Ai</span>
```

### Counter "+15% size" digit color-cycle (6s loop)
```css
@keyframes color-cycle {
  0%   { color: #C4B5FD; text-shadow: 0 0 6px #8B5CF6; }
  33%  { color: #FDE68A; text-shadow: 0 0 6px #FBBF24; }
  66%  { color: #67E8F9; text-shadow: 0 0 6px #22D3EE; }
  100% { color: #C4B5FD; }
}
```

### Visit-count gradient (under planet, logo-style)
```css
bg-gradient-to-r from-purple-400 via-fuchsia-400 to-cyan-300 bg-clip-text text-transparent
```

---

## 🔤 Typography stack

| Class | Family | Use |
|---|---|---|
| `font-sans` | **Inter** | Default body text, captions |
| `font-display` | **Space Grotesk** + tracking-tight | Hero h1, page titles, cosmic accents |
| `font-mono` | **JetBrains Mono** | Numbers, IDs, dates, code |

### Hero pattern
```jsx
<h1 className="text-4xl sm:text-5xl lg:text-6xl font-display font-bold leading-tight tracking-tight">
  <span className="gradient-text">MuzaAi</span>
</h1>
```

### Numbers (tabular-nums for non-jumping digits)
```jsx
<span className="font-display font-bold tracking-tight" style={{ fontVariantNumeric: "tabular-nums" }}>
  006677
</span>
```

---

## 🪟 CSS Utility classes (index.css)

```css
.glass-card {
  background: rgba(18, 18, 22, 0.72);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  backdrop-filter: blur(40px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 2px 16px rgba(0,0,0,0.3), inset 0 0.5px 0 rgba(255,255,255,0.06);
}

.gradient-text {
  background: linear-gradient(135deg, #7C3AED 0%, #D946EF 50%, #00D4FF 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.btn-cosmic {
  /* Magic shimmer-gradient CTA — see index.css */
  background: linear-gradient(110deg, transparent 0%, transparent 40%,
              rgba(255,255,255,0.3) 50%, transparent 60%, transparent 100%),
              linear-gradient(135deg, #7C3AED, #D946EF, #00D4FF);
  background-size: 200% 100%, 100% 100%;
  animation: btn-shimmer 3s linear infinite;
}

.hero-gradient {
  background: radial-gradient(ellipse at top, rgba(124,58,237,0.15), transparent 70%),
              radial-gradient(ellipse at bottom, rgba(0,212,255,0.10), transparent 70%),
              #0A0A17;
}

.input-glow:focus {
  border-color: #7C3AED;
  box-shadow: 0 0 0 3px rgba(124,58,237,0.2);
}
```

---

## ✨ Hi-tech accents (subtle CSS effects)

- `.scan-line` — animated horizontal cyan scan polosa 4s
- `.neon-text` — text-shadow 8px+16px glow поверх gradient-text
- `.animated-border` — вращающийся 4-цветный gradient padding-wrapper
- `.holographic` — голограммный shimmer фон (3 brand-color layers, 12s)
- `.cyber-grid` — 32×32px hi-tech сетка (purple+cyan, 4% opacity)
- `.particle-bg` — 2 floating CSS particles 6-7s
- `.hud-frame` — sci-fi corner brackets (требует `<div className="hud-bl">` + `hud-br`)

Все reduced-motion-safe (отключаются через `@media (prefers-reduced-motion: reduce)`).

---

## 🎯 Logo concept directions

Based on this palette + project identity (AI music generator), 4 направления:

### A) Waveform monogram
- Sound wave линии (`<svg viewBox="0 0 24 24"><path d="M3 12c1.5-3..." />`)
- В контейнере rounded-square с brand-gradient bg
- Используется сейчас в navbar как logo icon

### B) Wordmark "MuzaAi"
- `font-display` Space Grotesk bold
- Gradient text-clip purple→cyan
- Tracking-tight

### C) Headphone + AI sigil
- 🎧 emoji or stylized headphone outline
- AI sparkle ✨ accent
- Cyber-violet primary

### D) Cosmic Earth / planet (current counter)
- 3D SVG Earth + atmosphere halo
- Rotating SMIL animation
- Cyan glow ring

---

## 🖼️ Reference visual locations

- `client/index.html` — meta og:image, favicon
- `client/public/favicon.svg` — current logo (purple waveform)
- `client/src/index.css` — все brand utilities
- `client/src/pages/landing.tsx:1502` — wordmark MuzaAi
- `client/src/components/plays-counter.tsx` — Cosmic Earth (PlanetIcon)
- `client/src/lib/branding.ts` — BRAND constants
- `server/lib/branding.ts` — server-side BRAND.name/url

---

## 📦 Для логотипа — TL;DR

**Палитра для логотипа:**
- Background: `#0A0A17` (deep space)
- Primary: `#7C3AED` (cyber violet)
- Accent 1: `#00D4FF` (electric blue)
- Accent 2: `#D946EF` (hot magenta) — для gradient
- Hint: `#FBBF24` (amber glow) — для CTAs

**Шрифт:** Space Grotesk Bold tracking-tight (hero), Inter (body)

**Стиль:** cyberpunk + sleek glassmorphism + brand gradients. Hi-tech but musical.

**Что отражает бренд:** AI-музыка, космос, прогрессивность, доступность. Молодёжная аудитория (25-35). Российский корни (90% юзеров RU).
