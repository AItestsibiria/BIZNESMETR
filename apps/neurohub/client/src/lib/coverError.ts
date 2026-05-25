// LS-cover-working-config rule: onError НИКОГДА не скрывает обложку.
// Разовый транзиентный сбой → один ретрай с cache-bust, без display:none
// (иначе обложка пропадает навсегда). За <img> стоит placeholder.
export function handleCoverError(e: { currentTarget: HTMLImageElement }) {
  try {
    const img = e.currentTarget;
    if (img.dataset.coverRetried === "1") return; // уже ретраили — стоп, без скрытия
    img.dataset.coverRetried = "1";
    const base = img.src.split("#")[0];
    const sep = base.includes("?") ? "&" : "?";
    img.src = `${base}${sep}cb=${Date.now()}`;
  } catch { /* best-effort — никогда не роняем рендер */ }
}
