// Eugene 2026-05-29 (Босс) Page-device-adaptation п.4: при горизонтальном
// сдвиге страницы (overscroll / случайный свайп вбок на смартфоне) — через
// 2 секунды без взаимодействия страница ВСЕГДА плавно возвращается в центр
// по горизонтали (smooth snap-back). Если горизонтального overflow нет — no-op.
// Таймер сбрасывается при любом новом scroll/touch. Never throws.

export function installAutoRecenter(): void {
  if (typeof window === "undefined") return;
  const DELAY_MS = 2000;
  let timer: number | undefined;

  const horizontalMax = (): number => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth);
  };

  const act = () => {
    try {
      const max = horizontalMax();
      if (max <= 1) return; // нет горизонтального overflow
      const center = Math.round(max / 2); // визуальный центр по горизонтали
      if (Math.abs(window.scrollX - center) > 2) {
        window.scrollTo({ left: center, behavior: "smooth" });
      }
    } catch { /* no-op */ }
  };

  const schedule = () => {
    if (timer) window.clearTimeout(timer);
    if (horizontalMax() <= 1) return; // ничего не делаем если страница не сдвигается вбок
    timer = window.setTimeout(act, DELAY_MS);
  };

  const cancel = () => { if (timer) { window.clearTimeout(timer); timer = undefined; } };

  try {
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("touchstart", cancel, { passive: true });
    window.addEventListener("touchmove", cancel, { passive: true });
    window.addEventListener("touchend", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
  } catch { /* no-op */ }
}
