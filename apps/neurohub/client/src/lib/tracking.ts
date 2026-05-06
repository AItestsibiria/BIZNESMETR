// v304 client-side tracking (Sprint 1).
// Захватывает UTM + первое касание → POST /api/lead-capture/touch.
// Сервер пишет в leads + tracking_attribution + emit('lead.captured').
//
// Spec: docs/strategy/original/05 §3 (UTM stack), 07 §3.4/§3.11.

const STORAGE_KEY_FP = "mzai_fp";
const STORAGE_KEY_FIRST_TOUCH = "mzai_first_touch";

// 1.x устаревший gen() — не использовать в новом коде.
// Используется только для бэкап-fingerprint, если crypto.subtle недоступен.
function fallbackFp(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function ensureFingerprint(): Promise<string> {
  const cached = localStorage.getItem(STORAGE_KEY_FP);
  if (cached) return cached;

  // Простой fingerprint: хэш от user-agent + язык + screen + tz.
  // Этого достаточно для сегментации на стороне сервера. Не PII.
  try {
    const seed = [
      navigator.userAgent,
      navigator.language,
      `${screen.width}x${screen.height}`,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      navigator.hardwareConcurrency ?? 0,
    ].join("|");
    const buf = new TextEncoder().encode(seed);
    const hashBuf = await crypto.subtle.digest("SHA-256", buf);
    const hex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const fp = hex.slice(0, 32);
    localStorage.setItem(STORAGE_KEY_FP, fp);
    return fp;
  } catch {
    const fp = fallbackFp();
    localStorage.setItem(STORAGE_KEY_FP, fp);
    return fp;
  }
}

interface UTM {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
}

interface ClickIds {
  yclid?: string;          // Yandex
  vkClickid?: string;      // VK Ads
  gclid?: string;          // Google Ads
  fbclid?: string;         // Meta
}

interface Touch {
  fingerprint: string;
  utm: UTM;
  clickIds: ClickIds;
  referer: string | null;
  landingPage: string;
  ts: string;              // ISO
}

function parseSearch(search: string): { utm: UTM; clickIds: ClickIds } {
  const p = new URLSearchParams(search);
  return {
    utm: {
      source: p.get("utm_source") ?? undefined,
      medium: p.get("utm_medium") ?? undefined,
      campaign: p.get("utm_campaign") ?? undefined,
      content: p.get("utm_content") ?? undefined,
      term: p.get("utm_term") ?? undefined,
    },
    clickIds: {
      yclid: p.get("yclid") ?? undefined,
      vkClickid: p.get("vk_clickid") ?? undefined,
      gclid: p.get("gclid") ?? undefined,
      fbclid: p.get("fbclid") ?? undefined,
    },
  };
}

export async function captureLeadTouch(): Promise<void> {
  // 1. fingerprint
  const fingerprint = await ensureFingerprint();

  // 2. UTM + click-IDs из текущего URL
  const { utm, clickIds } = parseSearch(window.location.search);

  const touch: Touch = {
    fingerprint,
    utm,
    clickIds,
    referer: document.referrer || null,
    landingPage: window.location.pathname + window.location.search,
    ts: new Date().toISOString(),
  };

  // 3. Сохраняем first-touch в localStorage один раз
  if (!localStorage.getItem(STORAGE_KEY_FIRST_TOUCH)) {
    try {
      localStorage.setItem(STORAGE_KEY_FIRST_TOUCH, JSON.stringify(touch));
    } catch {
      // localStorage может быть отключён — не падаем
    }
  }

  // 4. Шлём на сервер. fire-and-forget.
  try {
    await fetch("/api/lead-capture/touch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(touch),
      credentials: "same-origin",
      keepalive: true,
    });
  } catch {
    // Сеть может отвалиться — это не должно ломать UX.
  }
}
