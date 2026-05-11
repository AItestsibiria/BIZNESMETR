// tgLoginNonces (Eugene 2026-05-11): shared state для deep-link auth.
// Telegram депрекейтнул OAuth-виджет (oauth.telegram.org → «deprecated»).
// Используем альтернативу: сайт генерирует nonce, юзер открывает
// t.me/Muziaipodari_bot?start=login_<nonce>, бот подтверждает nonce,
// сайт через polling забирает session token.
//
// In-memory Map (TTL 15 минут). Не персистим — нонс короткоживущий,
// рестарт pm2 редкий, лоса одной сессии не критична.

export type NonceData = {
  createdAt: number;
  status: "pending" | "confirmed" | "consumed";
  tgUserId?: string;
  tgFirstName?: string;
  tgLastName?: string;
  tgUsername?: string;
  // userId после успешной авторизации (для polling-tab чтобы выдать токен)
  userId?: number;
};

const TTL_MS = 15 * 60 * 1000; // 15 минут
const POLL_MAX_MS = 30 * 60 * 1000; // через 30 мин окончательно удаляем

const nonces = new Map<string, NonceData>();

export function createNonce(): string {
  const nonce = randomHex(16);
  nonces.set(nonce, { createdAt: Date.now(), status: "pending" });
  return nonce;
}

export function confirmNonce(
  nonce: string,
  tg: { id: string | number; first_name?: string; last_name?: string; username?: string }
): boolean {
  const entry = nonces.get(nonce);
  if (!entry) return false;
  if (entry.status !== "pending") return false;
  if (Date.now() - entry.createdAt > TTL_MS) {
    nonces.delete(nonce);
    return false;
  }
  entry.status = "confirmed";
  entry.tgUserId = String(tg.id);
  entry.tgFirstName = tg.first_name;
  entry.tgLastName = tg.last_name;
  entry.tgUsername = tg.username;
  return true;
}

export function pollNonce(nonce: string): NonceData | null {
  const entry = nonces.get(nonce);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > POLL_MAX_MS) {
    nonces.delete(nonce);
    return null;
  }
  return entry;
}

export function consumeNonce(nonce: string): void {
  const entry = nonces.get(nonce);
  if (entry) entry.status = "consumed";
  nonces.delete(nonce);
}

// Помечает nonce как «юзер залогинен с этим user.id» — чтобы /poll
// мог выдать session token. Используется в /api/auth/telegram-loginurl
// после успешной HMAC-проверки.
export function attachUserToNonce(nonce: string, userId: number): boolean {
  const entry = nonces.get(nonce);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > TTL_MS) {
    nonces.delete(nonce);
    return false;
  }
  entry.status = "confirmed";
  entry.userId = userId;
  return true;
}

// Существует ли nonce и валиден ли — для bot-handler'а перед отправкой
// login_url-кнопки (не подтверждаем заранее).
export function hasValidNonce(nonce: string): boolean {
  const entry = nonces.get(nonce);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > TTL_MS) return false;
  return entry.status === "pending";
}

// Cleanup expired nonces — вызывается periodically.
export function cleanupExpired(): number {
  let removed = 0;
  const now = Date.now();
  for (const [k, v] of nonces.entries()) {
    if (now - v.createdAt > POLL_MAX_MS) {
      nonces.delete(k);
      removed++;
    }
  }
  return removed;
}

setInterval(() => cleanupExpired(), 5 * 60 * 1000).unref();

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}
