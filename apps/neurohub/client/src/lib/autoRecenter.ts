// Eugene 2026-05-29 (Босс) Page-device-adaptation п.4: при горизонтальном
// сдвиге страницы (overscroll / случайный свайп вбок на смартфоне) — через
// 2 секунды без взаимодействия страница ВСЕГДА плавно возвращается так, чтобы
// ОСНОВНОЙ ПЛЕЕР был по центру по горизонтали. Анимация в 3 раза медленнее
// обычного smooth (Босс «медленнее в 3 раза»). Если горизонтального overflow
// нет — no-op. Таймер сбрасывается при любом новом scroll/touch. Never throws.

export function installAutoRecenter(): void {
  if (typeof window === "undefined") return;
  const DELAY_MS = 2000;
  const DURATION_MS = 1500; // ×3 медленнее типичного браузерного smooth (~500мс)
  let timer: number | undefined;
  let rafId: number | undefined;

  const horizontalMax = (): number => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth);
  };

  // Целевой scrollLeft: центрируем по основному плееру ([data-main-player]),
  // иначе — геометрический центр overflow.
  const targetLeft = (max: number): number => {
    try {
      const el = document.querySelector("[data-main-player]") as HTMLElement | null;
      if (el) {
        const rect = el.getBoundingClientRect();
        const centerDoc = rect.left + window.scrollX + rect.width / 2;
        return Math.min(max, Math.max(0, Math.round(centerDoc - window.innerWidth / 2)));
      }
    } catch { /* no-op */ }
    return Math.round(max / 2);
  };

  const easeInOutCubic = (t: number): number =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  const animateTo = (to: number) => {
    if (rafId) cancelAnimationFrame(rafId);
    const from = window.scrollX;
    const dist = to - from;
    if (Math.abs(dist) < 2) return;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / DURATION_MS);
      const x = from + dist * easeInOutCubic(p);
      window.scrollTo(x, window.scrollY);
      if (p < 1) rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  };

  const act = () => {
    try {
      const max = horizontalMax();
      if (max <= 1) return; // нет горизонтального overflow
      const to = targetLeft(max);
      if (Math.abs(window.scrollX - to) > 2) animateTo(to);
    } catch { /* no-op */ }
  };

  const schedule = () => {
    if (timer) window.clearTimeout(timer);
    if (horizontalMax() <= 1) return; // страница не сдвигается вбок — ничего не делаем
    timer = window.setTimeout(act, DELAY_MS);
  };

  const cancel = () => {
    if (timer) { window.clearTimeout(timer); timer = undefined; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = undefined; }
  };

  try {
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("touchstart", cancel, { passive: true });
    window.addEventListener("touchmove", cancel, { passive: true });
    window.addEventListener("touchend", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
  } catch { /* no-op */ }
}
