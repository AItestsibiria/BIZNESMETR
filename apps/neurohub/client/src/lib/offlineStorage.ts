// Eugene 2026-05-30 — offline-хранилище треков для Capacitor app + PWA.
//
// Цель: юзер жмёт «Сохранить» → audio + cover + meta остаются на устройстве →
// можно слушать без интернета. Работа двух backend'ов:
//
//   • Capacitor (iOS/Android wrapper): @capacitor/filesystem — пишем mp3 в
//     Directory.Data, читаем через Capacitor.convertFileSrc() (превращается в
//     capacitor://localhost/... URL, который WebView понимает как локальный).
//
//   • PWA standalone (web): IndexedDB store с Blob — при load создаём
//     URL.createObjectURL(blob) и подсовываем в <audio>.src. SW отключён
//     kill-switch'ем (см. public/sw.js, Eugene 2026-05-25), поэтому Cache API
//     НЕ используем — только IndexedDB.
//
// Метаданные (title, displayTitle, imageUrl, duration, savedAt) — всегда в
// IndexedDB, чтобы единый UI-список «Скачанные» работал на обоих платформах.
//
// Все методы безопасны при отсутствии API (return null/false без throw).
// Persistent-audio-only rule сохраняется: мы НЕ создаём новые <audio> —
// только подменяем .src у существующего persistent элемента.

import { getCapacitorPlatform, isCapacitorApp } from "./platform";

const DB_NAME = "muzaai-offline";
const DB_VERSION = 1;
const STORE_META = "tracks-meta";
const STORE_BLOB = "tracks-blob";

export interface OfflineTrackMeta {
  id: number;
  displayTitle: string;
  authorName?: string;
  imageUrl?: string;
  duration?: number;
  savedAt: number; // millis
  /** Только для Capacitor — путь в Directory.Data */
  filesystemPath?: string;
  /** mime для blob (PWA) */
  mime?: string;
  /** Размер в байтах */
  sizeBytes?: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB недоступна на этом устройстве"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_BLOB)) {
        db.createObjectStore(STORE_BLOB); // key = trackId (number)
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const result = fn(s);
        if (result instanceof Promise) {
          result.then(resolve, reject);
        } else {
          result.onsuccess = () => resolve(result.result as T);
          result.onerror = () => reject(result.error);
        }
      }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// META — общая для обоих backend'ов
// ─────────────────────────────────────────────────────────────────────────────

export async function putMeta(meta: OfflineTrackMeta): Promise<void> {
  try {
    await tx(STORE_META, "readwrite", (s) => s.put(meta));
  } catch {
    /* swallow — отсутствие IDB не должно ломать flow */
  }
}

export async function getMeta(id: number): Promise<OfflineTrackMeta | null> {
  try {
    const result = await tx<OfflineTrackMeta | undefined>(STORE_META, "readonly", (s) =>
      s.get(id),
    );
    return result ?? null;
  } catch {
    return null;
  }
}

export async function listMeta(): Promise<OfflineTrackMeta[]> {
  try {
    const db = await openDb();
    return await new Promise<OfflineTrackMeta[]>((resolve, reject) => {
      const t = db.transaction(STORE_META, "readonly");
      const s = t.objectStore(STORE_META);
      const req = s.getAll();
      req.onsuccess = () => resolve((req.result as OfflineTrackMeta[]) || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function deleteMeta(id: number): Promise<void> {
  try {
    await tx(STORE_META, "readwrite", (s) => s.delete(id));
  } catch {
    /* swallow */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Capacitor Filesystem backend (iOS / Android wrapper)
// ─────────────────────────────────────────────────────────────────────────────

async function loadFilesystemPlugin(): Promise<any | null> {
  if (!isCapacitorApp()) return null;
  try {
    // Динамический импорт — на web сборке модуль не нужен и не должен ломать build,
    // если зависимость не установлена.
    // @ts-ignore — плагин ставится `npm install @capacitor/filesystem` на Mac
    const mod = await import("@capacitor/filesystem");
    return mod;
  } catch {
    return null;
  }
}

function fileNameFor(id: number): string {
  return `muzaai-track-${id}.mp3`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // result = "data:audio/mpeg;base64,XXXX..." → отрезаем prefix
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function saveViaFilesystem(
  id: number,
  blob: Blob,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const fs = await loadFilesystemPlugin();
  if (!fs) {
    return { ok: false, error: "Filesystem plugin недоступен" };
  }
  try {
    const base64 = await blobToBase64(blob);
    const path = fileNameFor(id);
    await fs.Filesystem.writeFile({
      path,
      data: base64,
      directory: fs.Directory.Data,
      recursive: true,
    });
    return { ok: true, path };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function getFilesystemUri(path: string): Promise<string | null> {
  const fs = await loadFilesystemPlugin();
  if (!fs) return null;
  try {
    const res = await fs.Filesystem.getUri({ path, directory: fs.Directory.Data });
    const native = res.uri as string;
    // Capacitor.convertFileSrc оборачивает file:// в capacitor://localhost/_capacitor_file_/...
    // что WebView умеет грузить как media-source.
    const cap = (window as any).Capacitor;
    if (cap?.convertFileSrc) return cap.convertFileSrc(native);
    return native;
  } catch {
    return null;
  }
}

async function deleteFromFilesystem(path: string): Promise<void> {
  const fs = await loadFilesystemPlugin();
  if (!fs) return;
  try {
    await fs.Filesystem.deleteFile({ path, directory: fs.Directory.Data });
  } catch {
    /* swallow */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IndexedDB blob backend (PWA standalone)
// ─────────────────────────────────────────────────────────────────────────────

async function saveBlob(id: number, blob: Blob): Promise<boolean> {
  try {
    await tx(STORE_BLOB, "readwrite", (s) => s.put(blob, id));
    return true;
  } catch {
    return false;
  }
}

async function readBlob(id: number): Promise<Blob | null> {
  try {
    const blob = await tx<Blob | undefined>(STORE_BLOB, "readonly", (s) => s.get(id));
    return blob ?? null;
  } catch {
    return null;
  }
}

async function deleteBlob(id: number): Promise<void> {
  try {
    await tx(STORE_BLOB, "readwrite", (s) => s.delete(id));
  } catch {
    /* swallow */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Публичный API
// ─────────────────────────────────────────────────────────────────────────────

export interface SaveTrackInput {
  id: number;
  audioUrl: string; // обычно `/api/download/${id}` или `/api/stream/${id}`
  displayTitle: string;
  authorName?: string;
  imageUrl?: string;
  duration?: number;
}

export interface SaveTrackResult {
  ok: boolean;
  backend: "filesystem" | "indexeddb" | "none";
  sizeBytes?: number;
  error?: string;
}

/**
 * Скачать трек с сервера и положить в offline-хранилище. Сохраняет meta
 * в IndexedDB всегда (для UI «Скачанные»), а сам файл — в filesystem
 * (Capacitor) или blob-store (PWA).
 *
 * Возвращает {ok:false} если оба backend'а недоступны (обычный браузер) —
 * в этом случае caller должен использовать классический download fallback.
 */
export async function saveTrackOffline(input: SaveTrackInput): Promise<SaveTrackResult> {
  if (typeof fetch === "undefined") {
    return { ok: false, backend: "none", error: "fetch недоступен" };
  }
  let blob: Blob;
  try {
    const res = await fetch(input.audioUrl, { credentials: "include" });
    if (!res.ok) {
      return { ok: false, backend: "none", error: `HTTP ${res.status}` };
    }
    blob = await res.blob();
  } catch (e: any) {
    return { ok: false, backend: "none", error: e?.message || "Сеть недоступна" };
  }

  const baseMeta: OfflineTrackMeta = {
    id: input.id,
    displayTitle: input.displayTitle || `Трек ${input.id}`,
    authorName: input.authorName,
    imageUrl: input.imageUrl,
    duration: input.duration,
    savedAt: Date.now(),
    mime: blob.type || "audio/mpeg",
    sizeBytes: blob.size,
  };

  if (isCapacitorApp()) {
    const r = await saveViaFilesystem(input.id, blob);
    if (r.ok) {
      await putMeta({ ...baseMeta, filesystemPath: r.path });
      return { ok: true, backend: "filesystem", sizeBytes: blob.size };
    }
    // Если filesystem отвалился — пробуем IDB как fallback (на android wrapper IDB тоже работает)
  }

  const idbOk = await saveBlob(input.id, blob);
  if (idbOk) {
    await putMeta(baseMeta);
    return { ok: true, backend: "indexeddb", sizeBytes: blob.size };
  }

  return { ok: false, backend: "none", error: "Не удалось сохранить (нет хранилища)" };
}

/** Сохранён ли трек offline? Быстрая проверка по meta. */
export async function hasOffline(id: number): Promise<boolean> {
  const meta = await getMeta(id);
  return !!meta;
}

/**
 * Получить URL для проигрывания offline-трека. Возвращает null если трека
 * нет в хранилище. Возвращённый URL подходит для `audio.src = ...`.
 *
 * Persistent-audio-only rule: caller обязан использовать существующий
 * persistent `<audio>` элемент (см. lib/lockscreen.ts), а не создавать новый.
 */
export async function getOfflineAudioUrl(id: number): Promise<string | null> {
  const meta = await getMeta(id);
  if (!meta) return null;

  if (meta.filesystemPath && isCapacitorApp()) {
    const uri = await getFilesystemUri(meta.filesystemPath);
    if (uri) return uri;
  }

  // PWA / fallback — blob URL из IDB
  const blob = await readBlob(id);
  if (blob) return URL.createObjectURL(blob);

  return null;
}

/** Удалить offline-копию трека (meta + файл/blob). */
export async function deleteOfflineTrack(id: number): Promise<void> {
  const meta = await getMeta(id);
  if (meta?.filesystemPath) {
    await deleteFromFilesystem(meta.filesystemPath);
  }
  await deleteBlob(id);
  await deleteMeta(id);
}

/** Список всех offline-треков (для UI «Скачанные»). */
export async function listOfflineTracks(): Promise<OfflineTrackMeta[]> {
  const items = await listMeta();
  // сортировка: свежие сверху
  return items.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Маленький in-memory кэш проверок hasOffline для синхронного UI (иконка
 * «✓ Сохранено» рисуется без await). Заполняется через primeOfflineCache.
 */
const offlineCache = new Set<number>();
let cachePrimed = false;
const cacheListeners = new Set<() => void>();

export function subscribeOfflineCache(listener: () => void): () => void {
  cacheListeners.add(listener);
  return () => cacheListeners.delete(listener);
}

function notifyCache() {
  cacheListeners.forEach((l) => {
    try {
      l();
    } catch {}
  });
}

export async function primeOfflineCache(): Promise<void> {
  if (cachePrimed) return;
  cachePrimed = true;
  try {
    const items = await listMeta();
    offlineCache.clear();
    items.forEach((m) => offlineCache.add(m.id));
    notifyCache();
  } catch {
    /* swallow */
  }
}

export function isOfflineCached(id: number): boolean {
  return offlineCache.has(id);
}

export function markOfflineCached(id: number): void {
  offlineCache.add(id);
  notifyCache();
}

export function unmarkOfflineCached(id: number): void {
  offlineCache.delete(id);
  notifyCache();
}

// Для удобства caller'ов
export { getCapacitorPlatform };
