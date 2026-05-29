// Eugene 2026-05-29 (Босс) «Секунду — что-то сбойнуло» при заходе во время
// деплоя. Root cause: при деплое hash-имена чанков меняются; вкладка, открытая
// ДО деплоя, при lazy-import (напр. 3D-глобус — lazy(() => import(...))) тянет
// СТАРЫЙ чанк, которого уже нет на сервере → 404 → ChunkLoadError всплывает в
// top-level ErrorBoundary. SW отключён, index.html отдаётся no-store, поэтому
// ОДИН guarded reload берёт свежий index.html → новые хэши чанков → чинится
// без действий юзера. sessionStorage-флаг защищает от петли (если чанк реально
// недоступен — после одной попытки даём ErrorBoundary показать фолбэк).

export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const any = err as any;
  const name = String(any?.name || "");
  const msg = String(any?.message ?? any ?? "");
  return (
    /ChunkLoadError/i.test(name) ||
    /Loading chunk\s+[\w-]+\s+failed/i.test(msg) ||
    /Loading CSS chunk/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /'text\/html'.*not a valid JavaScript MIME type/i.test(msg) ||
    /expected a JavaScript(?:-or-Wasm)? module/i.test(msg)
  );
}

const RELOAD_KEY = "__muza_chunk_reload_at";
const MIN_GAP_MS = 20000;

// Возвращает true если инициировали reload (тогда вызывающему можно не падать).
export function reloadOnceForChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || "0");
    const now = Date.now();
    if (now - last < MIN_GAP_MS) return false; // недавно уже перезагружали → не зацикливаемся
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    // sessionStorage недоступен — один reload всё равно лучше зависшего экрана
  }
  try { window.location.reload(); } catch {}
  return true;
}
