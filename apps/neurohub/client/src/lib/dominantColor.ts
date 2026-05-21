// Eugene 2026-05-21 Босс: «подсветка обложки на главном плеере с применением
// цветов самой обложки. Акцент вокруг обложки.»
//
// Hook извлекает dominant + secondary color из изображения через canvas.
// Применяется как box-shadow glow вокруг cover для визуального акцента.
//
// Алгоритм:
// 1. Loaded image → canvas 32x32 (resize)
// 2. Sample все pixels, отфильтровать transparent / слишком тёмные / слишком светлые
// 3. Average RGB как primary color
// 4. Cache в Map по imageUrl (одинаковые обложки = один extract)
//
// CORS: img.crossOrigin="anonymous". Обложки идут с того же origin (/api/cover/)
// — нет CORS issues. Для external CDN cover нужен Access-Control-Allow-Origin.

import { useEffect, useState } from "react";

const FALLBACK = "rgba(124,58,237,0.55)"; // brand purple
const cache = new Map<string, string>();

function extractDominantColor(img: HTMLImageElement): string {
  try {
    const canvas = document.createElement("canvas");
    const size = 24;
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return FALLBACK;
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    let r = 0, g = 0, b = 0, count = 0;
    let maxSat = 0;
    let satR = 0, satG = 0, satB = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha < 128) continue;
      const pr = data[i], pg = data[i + 1], pb = data[i + 2];
      const brightness = (pr + pg + pb) / 3;
      // Skip too dark/light (background noise)
      if (brightness < 35 || brightness > 225) continue;
      r += pr; g += pg; b += pb; count++;
      // Saturation approximation (max - min channels)
      const sat = Math.max(pr, pg, pb) - Math.min(pr, pg, pb);
      if (sat > maxSat) {
        maxSat = sat;
        satR = pr; satG = pg; satB = pb;
      }
    }
    if (count === 0) return FALLBACK;
    // Prefer most saturated если есть достаточно vivid pixel,
    // иначе средний avg.
    let R, G, B;
    if (maxSat > 60) {
      R = satR; G = satG; B = satB;
    } else {
      R = Math.round(r / count);
      G = Math.round(g / count);
      B = Math.round(b / count);
    }
    return `rgb(${R},${G},${B})`;
  } catch {
    return FALLBACK;
  }
}

export function useDominantColor(imageUrl: string | null | undefined): string {
  const [color, setColor] = useState<string>(() => {
    if (imageUrl && cache.has(imageUrl)) return cache.get(imageUrl)!;
    return FALLBACK;
  });

  useEffect(() => {
    if (!imageUrl) { setColor(FALLBACK); return; }
    if (cache.has(imageUrl)) {
      setColor(cache.get(imageUrl)!);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      const c = extractDominantColor(img);
      cache.set(imageUrl, c);
      setColor(c);
    };
    img.onerror = () => { if (!cancelled) setColor(FALLBACK); };
    img.src = imageUrl;
    return () => { cancelled = true; };
  }, [imageUrl]);

  return color;
}

/**
 * Возвращает CSS box-shadow string для glow вокруг обложки с dominant color.
 * Multi-layer: близкий резкий + дальний размытый.
 */
export function dominantGlowShadow(color: string, intensity: number = 1): string {
  return `0 0 24px ${color.replace("rgb", "rgba").replace(")", `,${0.45 * intensity})`)}, 0 0 60px ${color.replace("rgb", "rgba").replace(")", `,${0.25 * intensity})`)}`;
}
