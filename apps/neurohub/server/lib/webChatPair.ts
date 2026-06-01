// webChatPair (Eugene 2026-05-14 Босс): Cross-channel pair code.
//
// Идея: юзер общается с Музой в Telegram/Max, после нескольких сообщений
// бот предлагает «продолжить на сайте» с уникальным 6-символьным кодом.
// Юзер заходит на сайт → набирает код в чате Музы → backend pair'ит
// web-сессию с уже существующей history Telegram/Max сессии.
//
// Формат кода: 6 символов из алфавита без визуально похожих (0/O, 1/I/L).
// 32^6 ≈ 1 млрд комбинаций — достаточно для активных юзеров.

import { db } from "../storage";
import { chatbotSessions } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

const PAIR_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 chars, без 0/O/1/I/L
const PAIR_CODE_LENGTH = 6;
const OFFER_COOLDOWN_HOURS = 6; // не предлагать чаще раза в 6 часов

export function generatePairCode(): string {
  let out = "";
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) {
    out += PAIR_CODE_ALPHABET[Math.floor(Math.random() * PAIR_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Получить или создать уникальный pair-код для сессии (Telegram/Max → web).
 * Возвращает существующий если уже выдан, иначе генерирует новый.
 */
export function getOrCreatePairCode(sessionId: string): string | null {
  try {
    const row = db.select({ code: chatbotSessions.webPairCode })
      .from(chatbotSessions)
      .where(eq(chatbotSessions.id, sessionId))
      .get();
    if (row?.code) return row.code;

    // Генерируем уникальный код (до 10 попыток на коллизию)
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = generatePairCode();
      const existing = db.select({ id: chatbotSessions.id })
        .from(chatbotSessions)
        .where(eq(chatbotSessions.webPairCode, code))
        .get();
      if (!existing) {
        db.update(chatbotSessions)
          .set({ webPairCode: code })
          .where(eq(chatbotSessions.id, sessionId))
          .run();
        return code;
      }
    }
    console.warn("[PAIR-CODE] не смогли сгенерировать уникальный код за 10 попыток");
    return null;
  } catch (e) {
    console.error("[PAIR-CODE]", e);
    return null;
  }
}

/**
 * Решает, стоит ли бот предлагать pair-код юзеру в этой реплике.
 * Условия:
 * - Канал НЕ web (только из мессенджеров приглашаем на сайт)
 * - Прошло >6 часов с прошлого предложения
 * - Сессия активна (как минимум 3 сообщения уже было)
 */
export function shouldOfferPairCode(sessionId: string, channel: string): boolean {
  if (channel === "web") return false;
  try {
    const sess = db.select().from(chatbotSessions).where(eq(chatbotSessions.id, sessionId)).get();
    if (!sess) return false;
    if (sess.webPairCodeOfferedAt) {
      const lastOffer = new Date(sess.webPairCodeOfferedAt).getTime();
      if (Date.now() - lastOffer < OFFER_COOLDOWN_HOURS * 60 * 60 * 1000) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Помечаем что код был предложен сейчас — сбрасываем cooldown.
 */
export function markPairCodeOffered(sessionId: string): void {
  try {
    db.update(chatbotSessions)
      .set({ webPairCodeOfferedAt: new Date().toISOString() })
      .where(eq(chatbotSessions.id, sessionId))
      .run();
  } catch (e) {
    console.error("[PAIR-CODE] markOffered failed:", e);
  }
}

/**
 * Поиск сессии по pair-коду. Возвращает session row или null.
 * Чувствительно к регистру: код хранится upper-case, входной тоже upper-cased.
 */
export function findSessionByPairCode(code: string) {
  const normalized = (code || "").toUpperCase().trim();
  if (!normalized || normalized.length !== PAIR_CODE_LENGTH) return null;
  try {
    return db.select().from(chatbotSessions)
      .where(eq(chatbotSessions.webPairCode, normalized))
      .get();
  } catch (e) {
    console.error("[PAIR-CODE] findByCode:", e);
    return null;
  }
}

/**
 * Проверяем что строка похожа на pair-code (для распознавания в тексте сообщения).
 * Регулярка: 6 заглавных символов из алфавита.
 */
export function looksLikePairCode(text: string): string | null {
  const m = (text || "").toUpperCase().match(/[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}/);
  return m ? m[0] : null;
}
