// Eugene 2026-05-15 Босс «подарочный трек не обнаружен» — extract welcome
// gift logic из /api/auth/login в helper, чтобы phone-auth (callcheck +
// SMS-OTP) тоже выдавал подарочные треки новым юзерам из РФ/СНГ.
//
// Правило (с 2026-05-14): первые 1000 авторов из РФ + ближнее зарубежье
// получают 1 подарочный трек. Race-safe через better-sqlite3 transaction
// (writes serialized).

import { db, storage } from "../storage";

export const WELCOME_GIFT_LIMIT = 1000;

const CIS_CODES = new Set(["RU", "BY", "KZ", "UA", "MD", "AM", "AZ", "GE", "KG", "TJ", "TM", "UZ"]);

export function isCISCountry(countryCode: string | null | undefined): boolean {
  if (!countryCode) return false;
  return CIS_CODES.has(countryCode.toUpperCase());
}

export type WelcomeGiftResult = {
  gifted: boolean;
  position?: number;
  reason?: "not-cis" | "already-gifted" | "limit-reached" | "error";
};

/**
 * Выдаёт 1 подарочный трек юзеру, если:
 *  - user.welcome_gift_given = 0 (не получал ранее)
 *  - total welcome_gift_given < 1000 (общий лимит)
 * Race-safe — обёрнуто в better-sqlite3 transaction.
 *
 * Eugene 2026-05-15 Босс «открой генерацию для всех» — CIS-restriction
 * УБРАН. Любой новый юзер получает 1 трек (первые 1000 — лимит остался).
 *
 * Применяется в:
 *  - /api/auth/login (post-первый-login email-юзера)
 *  - /api/auth/sms/check-call (after register + after login-upsert phone-юзера)
 *  - /api/auth/sms/verify-otp (after register SMS-OTP юзера)
 */
export function tryGiveWelcomeGift(args: {
  userId: number;
  countryCode: string | null | undefined;
}): WelcomeGiftResult {
  try {
    const raw = (db as any).$client;
    const giftResult: WelcomeGiftResult = raw.transaction(() => {
      // Проверяем что юзер ещё не получал.
      const userRow = raw.prepare("SELECT welcome_gift_given FROM users WHERE id = ?").get(args.userId);
      if (!userRow) return { gifted: false, reason: "error" as const };
      if (userRow.welcome_gift_given === 1) return { gifted: false, reason: "already-gifted" as const };
      // Глобальный лимит.
      const row = raw.prepare("SELECT COUNT(*) AS c FROM users WHERE welcome_gift_given = 1").get() as { c: number };
      const giftedSoFar = Number(row?.c || 0);
      if (giftedSoFar >= WELCOME_GIFT_LIMIT) {
        return { gifted: false, reason: "limit-reached" as const, position: giftedSoFar };
      }
      raw.prepare("UPDATE users SET bonus_tracks = bonus_tracks + 1, welcome_gift_given = 1 WHERE id = ? AND welcome_gift_given = 0").run(args.userId);
      return { gifted: true, position: giftedSoFar + 1 };
    })();

    if (giftResult.gifted) {
      try {
        storage.createTransaction({
          userId: args.userId,
          type: "topup",
          amount: 0,
          description: `🎁 Подарочный трек: первые 1000 авторов из РФ и ближнего зарубежья (#${giftResult.position} из 1000)`,
        });
      } catch (e) {
        console.warn("[WELCOME-GIFT] tx insert failed:", e);
      }
      console.log(`[WELCOME-GIFT] User #${args.userId} (${args.countryCode}) received gift track #${giftResult.position}/1000`);
    }
    return giftResult;
  } catch (e: any) {
    console.error("[WELCOME-GIFT] Error checking eligibility:", e);
    return { gifted: false, reason: "error" };
  }
}
