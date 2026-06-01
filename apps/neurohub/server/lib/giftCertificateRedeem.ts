// Eugene 2026-05-23 Босс «подарочные сертификаты». Атомарная активация
// сертификата: проверка → списание из gift_certificates → начисление в
// users.balance / users.bonus_tracks / etc → audit-log. Всё в одной
// better-sqlite3 transaction. Если хоть один шаг упал — rollback.
//
// Spec: CLAUDE.md → Backup-before-edit rule + Admin-everything-except-delete rule.

import { db } from "../storage";
import { normalizeCode } from "./giftCertificateCode";

const sqlite: any = (db as any).$client;

export interface RedeemContext {
  userId: number;
  ip?: string | null;
  userAgent?: string | null;
}

export interface RedeemResult {
  ok: boolean;
  certificateId?: number;
  creditedSummary?: string;          // Человекочитаемый текст «Зачислено: …»
  credit?: {
    balanceKopecks?: number;
    bonusTracks?: number;
    bonusCovers?: number;
    bonusLyrics?: number;
  };
  error?: string;
  errorCode?: "code_invalid" | "not_found" | "already_redeemed" | "expired" | "self_redeem" | "not_active" | "internal";
}

interface CertRow {
  id: number;
  code: string;
  purchased_by_user_id: number | null;
  amount_kopecks: number;
  credit_type: string;
  credit_value_json: string | null;
  status: string;
  redeemed_by_user_id: number | null;
  expires_at: number | null;
  attached_track_id: number | null;
  postcard_message: string | null;
  postcard_template: string | null;
}

/**
 * Atomic redeem. Returns RedeemResult. Никогда не throw'ит — все ошибки
 * возвращаются через `ok:false, errorCode, error`.
 */
export function redeemCertificate(rawCode: string, ctx: RedeemContext): RedeemResult {
  const code = normalizeCode(rawCode);
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
    return { ok: false, error: "Неверный формат кода (XXXX-XXXX-XXXX)", errorCode: "code_invalid" };
  }

  const cert: CertRow | undefined = sqlite.prepare(
    `SELECT id, code, purchased_by_user_id, amount_kopecks, credit_type,
            credit_value_json, status, redeemed_by_user_id, expires_at,
            attached_track_id, postcard_message, postcard_template
     FROM gift_certificates WHERE code = ?`,
  ).get(code);

  if (!cert) {
    return { ok: false, error: "Сертификат не найден. Проверьте код.", errorCode: "not_found" };
  }
  if (cert.status === "redeemed") {
    return { ok: false, error: "Этот сертификат уже активирован.", errorCode: "already_redeemed" };
  }
  if (cert.status === "expired" || cert.status === "cancelled") {
    return { ok: false, error: "Срок действия сертификата истёк.", errorCode: "expired" };
  }
  if (cert.status !== "active") {
    return {
      ok: false,
      error: "Сертификат пока не оплачен — активация недоступна.",
      errorCode: "not_active",
    };
  }
  if (cert.expires_at && cert.expires_at < Date.now()) {
    // Auto-mark expired
    try { sqlite.prepare(`UPDATE gift_certificates SET status='expired' WHERE id=?`).run(cert.id); } catch {}
    return { ok: false, error: "Срок действия сертификата истёк.", errorCode: "expired" };
  }
  // Защита от self-redeem (нельзя активировать СВОЙ собственный купленный сертификат —
  // деньги были переведены за подарок другому). Admin-issued исключение (purchased_by_user_id = null).
  if (cert.purchased_by_user_id && cert.purchased_by_user_id === ctx.userId) {
    return {
      ok: false,
      error: "Нельзя активировать сертификат который вы сами купили (он для подарка другому).",
      errorCode: "self_redeem",
    };
  }

  // Парсим credit_value_json
  let credit: {
    balance_kopecks?: number;
    tracks_count?: number;
    covers_count?: number;
    lyrics_count?: number;
  } = {};
  try {
    if (cert.credit_value_json) credit = JSON.parse(cert.credit_value_json);
  } catch {}

  // Atomic transaction
  try {
    const txn = sqlite.transaction(() => {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      // 1. Mark certificate as redeemed
      const updateResult = sqlite.prepare(
        `UPDATE gift_certificates
         SET status='redeemed', redeemed_by_user_id=?, redeemed_at=?
         WHERE id=? AND status='active'`,
      ).run(ctx.userId, nowMs, cert.id);
      if (!updateResult || updateResult.changes !== 1) {
        // Race condition — кто-то другой redeem-нул между select и update.
        throw new Error("race_condition");
      }

      // 2. Credit user balance / bonus tracks
      const summaryParts: string[] = [];

      if (credit.balance_kopecks && credit.balance_kopecks > 0) {
        sqlite.prepare(`UPDATE users SET balance = balance + ? WHERE id = ?`).run(
          credit.balance_kopecks,
          ctx.userId,
        );
        sqlite.prepare(
          `INSERT INTO transactions (user_id, type, amount, description)
           VALUES (?, 'topup', ?, ?)`,
        ).run(
          ctx.userId,
          credit.balance_kopecks,
          `🎁 Подарочный сертификат ${cert.code}: +${Math.round(credit.balance_kopecks / 100)} ₽`,
        );
        summaryParts.push(`${Math.round(credit.balance_kopecks / 100)} ₽ на баланс`);
      }

      if (credit.tracks_count && credit.tracks_count > 0) {
        sqlite.prepare(`UPDATE users SET bonus_tracks = bonus_tracks + ? WHERE id = ?`).run(
          credit.tracks_count,
          ctx.userId,
        );
        sqlite.prepare(
          `INSERT INTO transactions (user_id, type, amount, description)
           VALUES (?, 'topup', 0, ?)`,
        ).run(
          ctx.userId,
          `🎁 Подарочный сертификат ${cert.code}: +${credit.tracks_count} ${pluralizeTracks(credit.tracks_count)}`,
        );
        summaryParts.push(`${credit.tracks_count} ${pluralizeTracks(credit.tracks_count)}`);
      }

      // Covers / Lyrics — пока тоже как пометка в transactions (отдельных квот в users нет).
      // Можно использовать как промокод на следующую обложку/текст — TODO.
      if (credit.covers_count && credit.covers_count > 0) {
        sqlite.prepare(
          `INSERT INTO transactions (user_id, type, amount, description)
           VALUES (?, 'topup', 0, ?)`,
        ).run(
          ctx.userId,
          `🎁 Подарочный сертификат ${cert.code}: +${credit.covers_count} обложек (квота)`,
        );
        summaryParts.push(`${credit.covers_count} обложек`);
      }
      if (credit.lyrics_count && credit.lyrics_count > 0) {
        sqlite.prepare(
          `INSERT INTO transactions (user_id, type, amount, description)
           VALUES (?, 'topup', 0, ?)`,
        ).run(
          ctx.userId,
          `🎁 Подарочный сертификат ${cert.code}: +${credit.lyrics_count} текстов (квота)`,
        );
        summaryParts.push(`${credit.lyrics_count} текстов`);
      }

      // 3. Audit-log entry в gift_certificate_audit
      sqlite.prepare(
        `INSERT INTO gift_certificate_audit
           (certificate_id, action, actor_user_id, actor_role, metadata_json, created_at)
         VALUES (?, 'redeemed', ?, 'user', ?, ?)`,
      ).run(
        cert.id,
        ctx.userId,
        JSON.stringify({
          code: cert.code,
          credit,
          ip: ctx.ip || null,
          ua: (ctx.userAgent || "").slice(0, 200),
        }),
        nowMs,
      );

      return {
        summaryParts,
        nowIso,
      };
    });

    const r = txn();

    return {
      ok: true,
      certificateId: cert.id,
      creditedSummary: r.summaryParts.length > 0
        ? `Зачислено: ${r.summaryParts.join(", ")}.`
        : "Сертификат активирован (без зачисления — проверьте детали).",
      credit: {
        balanceKopecks: credit.balance_kopecks,
        bonusTracks: credit.tracks_count,
        bonusCovers: credit.covers_count,
        bonusLyrics: credit.lyrics_count,
      },
    };
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg === "race_condition") {
      return {
        ok: false,
        error: "Сертификат активировал другой пользователь только что. Если это были вы — проверьте баланс.",
        errorCode: "already_redeemed",
      };
    }
    console.error("[giftCertificateRedeem] failed:", msg);
    return { ok: false, error: "Внутренняя ошибка активации. Попробуйте позже.", errorCode: "internal" };
  }
}

function pluralizeTracks(n: number): string {
  const last = n % 10;
  const last2 = n % 100;
  if (last2 >= 11 && last2 <= 14) return "треков";
  if (last === 1) return "трек";
  if (last >= 2 && last <= 4) return "трека";
  return "треков";
}
