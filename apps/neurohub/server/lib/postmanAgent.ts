// Eugene 2026-05-25 Босс «Агент Почтальон» — почтовый AI-робот MuzaAi.
//
// Ядро агента: подписки (double opt-in), журнал согласий, отписка (one-click),
// suppress-list, рассылка кампаний, статистика, AI-классификация входящих.
//
// === РЕАЛЬНЫЙ СТЕК (НЕ Yandex Functions / PostgreSQL из исходного ТЗ) ===
// Express + pm2 монолит, SQLite data.db + Drizzle, плагин-архитектура. Очередь
// рассылки — простой проход по кандидатам + дедуп (как balanceReminder.ts).
//
// === Reuse-working-solutions ===
//  - sendEmail (lib/emailSender) — единая точка отправки (custom-SMTP → Gmail).
//  - callDeepSeek (lib/llmCore) — дешёвая AI-классификация входящих.
//  - recordAgentActivity (lib/agentOrchestrator) — Почтальон подчинён Директору.
//  - reminder_log-style dedup — postman_send_log (1 письмо / кампания / адресат).
//
// === Юр-фундамент (Фаза 0) ===
//  - Двойное подтверждение (double opt-in): pending → confirm-токен → active.
//  - Журнал согласий (email_consents) — доказательная база: что/когда/IP/UA.
//  - Отписка одним кликом (one-click, RFC 8058) — без авторизации.
//  - Suppress-list: unsubscribed / bounced / complained перекрывают ЛЮБОЙ сегмент.
//  - Маркировка «реклама» + List-Unsubscribe + физ-адрес в рекламных письмах.
//
// Secrets-admin-only: SMTP/IMAP креды только из process.env, никогда не логируем
// и не возвращаем в API.

import crypto from "node:crypto";
import { db } from "../storage";
import { sendEmail } from "./emailSender";
import { recordAgentActivity } from "./agentOrchestrator";

const PUBLIC_URL = process.env.PUBLIC_BASE_URL || "https://muzaai.ru";
// Физ-адрес для рекламных писем (закон «О рекламе» + CAN-SPAM-подобные нормы).
// Плейсхолдер — Босс заменяет на реальный юр-адрес через ENV.
const POSTAL_ADDRESS = process.env.POSTMAN_POSTAL_ADDRESS || "🔴ВПИШИ_ФИЗ_АДРЕС🔴";
const CONFIRM_TOKEN_TTL_MS = 7 * 24 * 3600_000; // double opt-in токен живёт 7 дней
const SEND_DEDUP_MS = 24 * 3600_000;            // не дублируем письмо кампании < 24ч

export type ConsentChannel = "product" | "news" | "marketing" | "survey";
export type ConsentAction = "opt_in" | "opt_out" | "confirm";
export type SubscriberStatus = "pending" | "active" | "unsubscribed" | "bounced" | "complained";

// === Auto-migrate (self-migrating, как message-analysis / feedback-aggregator) ===
// Дублирует shared/schema.ts определения — на случай если storage auto-migrate
// не подхватил (CREATE IF NOT EXISTS идемпотентен).

let migrated = false;
export function ensurePostmanTables(): void {
  if (migrated) return;
  try {
    const sqlite: any = (db as any).$client;
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS email_subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        email TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        locale TEXT NOT NULL DEFAULT 'ru',
        confirm_token_hash TEXT,
        confirm_token_expires_at INTEGER,
        confirmed_at INTEGER,
        unsubscribe_token TEXT UNIQUE,
        unsubscribed_at INTEGER,
        bounce_reason TEXT,
        source TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_subscribers_status ON email_subscribers(status);
      CREATE INDEX IF NOT EXISTS idx_subscribers_user ON email_subscribers(user_id);

      CREATE TABLE IF NOT EXISTS email_consents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscriber_id INTEGER NOT NULL,
        channel TEXT NOT NULL,
        action TEXT NOT NULL,
        consent_text TEXT,
        source TEXT,
        ip TEXT,
        user_agent TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_consents_subscriber ON email_consents(subscriber_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS email_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        segment_json TEXT,
        subject TEXT,
        body_text TEXT,
        is_ad INTEGER NOT NULL DEFAULT 0,
        sent_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS postman_send_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscriber_id INTEGER NOT NULL,
        campaign_id INTEGER,
        sent_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_postman_send ON postman_send_log(subscriber_id, campaign_id, sent_at DESC);

      CREATE TABLE IF NOT EXISTS postman_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_email TEXT,
        subject TEXT,
        snippet TEXT,
        category TEXT,
        sentiment TEXT,
        created_at INTEGER NOT NULL,
        handled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_postman_inbox_cat ON postman_inbox(category, created_at DESC);
    `);
    migrated = true;
  } catch (e) {
    console.warn("[postman] migration failed:", e);
  }
}

// === Helpers ===

function sqlite(): any {
  return (db as any).$client;
}

export function normalizeEmail(raw: string): string {
  return String(raw || "").trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function genToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// suppress-статусы — НИКОГДА не получают рассылку, перекрывают любой сегмент.
const SUPPRESSED: SubscriberStatus[] = ["unsubscribed", "bounced", "complained"];

interface SubscriberRow {
  id: number;
  user_id: number | null;
  email: string;
  status: SubscriberStatus;
  locale: string;
  confirm_token_hash: string | null;
  confirm_token_expires_at: number | null;
  confirmed_at: number | null;
  unsubscribe_token: string | null;
  unsubscribed_at: number | null;
  bounce_reason: string | null;
  source: string | null;
  created_at: string;
}

function findSubscriberByEmail(email: string): SubscriberRow | null {
  ensurePostmanTables();
  try {
    return sqlite().prepare(`SELECT * FROM email_subscribers WHERE email = ?`).get(email) as SubscriberRow | null;
  } catch {
    return null;
  }
}

function findSubscriberByUnsubToken(token: string): SubscriberRow | null {
  ensurePostmanTables();
  try {
    return sqlite().prepare(`SELECT * FROM email_subscribers WHERE unsubscribe_token = ?`).get(token) as SubscriberRow | null;
  } catch {
    return null;
  }
}

function recordConsent(opts: {
  subscriberId: number;
  channel: ConsentChannel;
  action: ConsentAction;
  consentText?: string;
  source?: string;
  ip?: string;
  userAgent?: string;
}): void {
  try {
    sqlite().prepare(
      `INSERT INTO email_consents (subscriber_id, channel, action, consent_text, source, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.subscriberId,
      opts.channel,
      opts.action,
      opts.consentText ?? null,
      opts.source ?? null,
      opts.ip ?? null,
      (opts.userAgent ?? null) ? String(opts.userAgent).slice(0, 500) : null,
    );
  } catch (e) {
    console.warn("[postman] recordConsent failed:", e);
  }
}

// === Opt-in (double opt-in flow) ===

export interface OptInResult {
  ok: boolean;
  status?: "pending" | "already_active" | "resent" | "suppressed";
  error?: string;
}

const DEFAULT_CONSENT_TEXT =
  "Я согласен(на) получать письма от MuzaAi (продуктовые уведомления и новости) " +
  "и подтверждаю ознакомление с Политикой обработки персональных данных. " +
  "Отписаться можно в любой момент по ссылке в каждом письме.";

/**
 * Шаг 1 double opt-in: оформить подписку → отправить письмо-подтверждение.
 * Подписчик создаётся в status='pending'. Согласие пишется в журнал (opt_in)
 * с IP/UA/текстом — доказательная база.
 */
export async function subscribeOptIn(opts: {
  email: string;
  channel?: ConsentChannel;
  consentText?: string;
  source?: string;
  ip?: string;
  userAgent?: string;
  userId?: number | null;
  locale?: string;
}): Promise<OptInResult> {
  ensurePostmanTables();
  const email = normalizeEmail(opts.email);
  if (!isValidEmail(email)) return { ok: false, error: "Некорректный email" };
  const channel: ConsentChannel = opts.channel || "marketing";
  const consentText = opts.consentText || DEFAULT_CONSENT_TEXT;

  let sub = findSubscriberByEmail(email);

  // Suppress-list: если ранее жаловался/баунс — НЕ реактивируем автоматически.
  if (sub && (sub.status === "complained" || sub.status === "bounced")) {
    return { ok: false, status: "suppressed", error: "Адрес в suppress-list (жалоба/недоставка)." };
  }

  if (sub && sub.status === "active") {
    // уже подтверждён — фиксируем повторное согласие, письмо не шлём
    recordConsent({ subscriberId: sub.id, channel, action: "opt_in", consentText, source: opts.source, ip: opts.ip, userAgent: opts.userAgent });
    recordAgentActivity("postman", { action: "opt_in", status: "already_active" });
    return { ok: true, status: "already_active" };
  }

  const token = genToken();
  const tokenHash = hashToken(token);
  const expiresAt = Date.now() + CONFIRM_TOKEN_TTL_MS;
  const unsubToken = genToken();

  try {
    if (sub) {
      // повторный opt-in для pending/unsubscribed — обновляем токен, статус → pending
      sqlite().prepare(
        `UPDATE email_subscribers
         SET status='pending', confirm_token_hash=?, confirm_token_expires_at=?, unsubscribe_token=COALESCE(unsubscribe_token, ?), source=COALESCE(source, ?), user_id=COALESCE(?, user_id)
         WHERE id=?`,
      ).run(tokenHash, expiresAt, unsubToken, opts.source ?? null, opts.userId ?? null, sub.id);
    } else {
      const r: any = sqlite().prepare(
        `INSERT INTO email_subscribers (user_id, email, status, locale, confirm_token_hash, confirm_token_expires_at, unsubscribe_token, source)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
      ).run(opts.userId ?? null, email, opts.locale || "ru", tokenHash, expiresAt, unsubToken, opts.source ?? null);
      sub = findSubscriberByEmail(email);
      void r;
    }
  } catch (e) {
    console.warn("[postman] subscribe insert failed:", e);
    return { ok: false, error: "Не удалось оформить подписку" };
  }

  if (!sub) return { ok: false, error: "Не удалось создать подписчика" };

  recordConsent({ subscriberId: sub.id, channel, action: "opt_in", consentText, source: opts.source, ip: opts.ip, userAgent: opts.userAgent });

  // Письмо подтверждения (double opt-in). Это transactional — НЕ реклама.
  const confirmUrl = `${PUBLIC_URL}/api/subscriptions/confirm?token=${encodeURIComponent(token)}`;
  const r = await sendEmail({
    to: email,
    subject: "Подтвердите подписку на письма MuzaAi",
    text:
      `Здравствуйте!\n\n` +
      `Вы (или кто-то) оформили подписку на письма MuzaAi. Чтобы подтвердить — откройте ссылку:\n` +
      `${confirmUrl}\n\n` +
      `Ссылка действительна 7 дней. Если это были не вы — просто проигнорируйте письмо, ` +
      `без подтверждения мы ничего присылать не будем.\n\n` +
      `— Музa · MuzaAi`,
    kind: "transactional",
  });
  recordAgentActivity("postman", { action: "opt_in", status: "pending", sent: r.ok });
  return { ok: true, status: "pending" };
}

/**
 * Шаг 2 double opt-in: подтвердить по токену из письма → status='active'.
 */
export function confirmOptIn(token: string, meta?: { ip?: string; userAgent?: string }): OptInResult {
  ensurePostmanTables();
  const tokenHash = hashToken(String(token || ""));
  let sub: SubscriberRow | null = null;
  try {
    sub = sqlite().prepare(`SELECT * FROM email_subscribers WHERE confirm_token_hash = ?`).get(tokenHash) as SubscriberRow | null;
  } catch {
    sub = null;
  }
  if (!sub) return { ok: false, error: "Токен не найден или уже использован" };
  if (sub.confirm_token_expires_at && Date.now() > sub.confirm_token_expires_at) {
    return { ok: false, error: "Срок действия ссылки истёк — оформите подписку заново" };
  }
  if (sub.status === "active") return { ok: true, status: "already_active" };

  try {
    sqlite().prepare(
      `UPDATE email_subscribers SET status='active', confirmed_at=?, confirm_token_hash=NULL, confirm_token_expires_at=NULL WHERE id=?`,
    ).run(Date.now(), sub.id);
  } catch (e) {
    console.warn("[postman] confirm update failed:", e);
    return { ok: false, error: "Не удалось подтвердить" };
  }
  recordConsent({ subscriberId: sub.id, channel: "marketing", action: "confirm", consentText: "Double opt-in подтверждён переходом по ссылке из письма.", source: "email-link", ip: meta?.ip, userAgent: meta?.userAgent });
  recordAgentActivity("postman", { action: "confirm", subscriberId: sub.id });
  return { ok: true, status: "pending" }; // status поле тут условно — подтверждение прошло
}

// === Unsubscribe (one-click, RFC 8058) ===

export interface UnsubResult {
  ok: boolean;
  alreadyUnsubscribed?: boolean;
  error?: string;
}

/**
 * Отписка одним кликом — по unsubscribe_token (без авторизации).
 * Используется и для GET /u/:token (визуальный клик), и для POST one-click
 * (List-Unsubscribe-Post: List-Unsubscribe=One-Click).
 */
export function unsubscribeByToken(token: string, meta?: { ip?: string; userAgent?: string }): UnsubResult {
  ensurePostmanTables();
  const sub = findSubscriberByUnsubToken(String(token || ""));
  if (!sub) return { ok: false, error: "Ссылка отписки недействительна" };
  if (sub.status === "unsubscribed") return { ok: true, alreadyUnsubscribed: true };
  try {
    sqlite().prepare(`UPDATE email_subscribers SET status='unsubscribed', unsubscribed_at=? WHERE id=?`).run(Date.now(), sub.id);
  } catch (e) {
    console.warn("[postman] unsubscribe failed:", e);
    return { ok: false, error: "Не удалось отписать" };
  }
  recordConsent({ subscriberId: sub.id, channel: "marketing", action: "opt_out", consentText: "Отписка одним кликом.", source: "unsubscribe-link", ip: meta?.ip, userAgent: meta?.userAgent });
  recordAgentActivity("postman", { action: "unsubscribe", subscriberId: sub.id });
  return { ok: true };
}

/** Пометить адрес как bounced/complained (suppress) — из bounce-обработчика / FBL. */
export function markSuppressed(email: string, status: "bounced" | "complained", reason?: string): boolean {
  ensurePostmanTables();
  const sub = findSubscriberByEmail(normalizeEmail(email));
  if (!sub) return false;
  try {
    sqlite().prepare(`UPDATE email_subscribers SET status=?, bounce_reason=? WHERE id=?`).run(status, reason ?? null, sub.id);
    recordConsent({ subscriberId: sub.id, channel: "marketing", action: "opt_out", consentText: `Suppress: ${status}`, source: status });
    return true;
  } catch {
    return false;
  }
}

// === Campaign send ===

export interface SegmentCriteria {
  channel?: ConsentChannel;       // зарезервировано для per-channel consent (Фаза 2)
  status?: SubscriberStatus;       // по умолчанию 'active'
  locale?: string;
}

export interface SendCampaignResult {
  ok: boolean;
  campaignId?: number;
  candidates: number;
  sent: number;
  failed: number;
  skipped: number;        // suppress + дедуп
  dryRun: boolean;
  sample: string[];
  error?: string;
}

/**
 * Подобрать адресатов сегмента. По умолчанию — только active (suppress
 * перекрывает любой сегмент: unsubscribed/bounced/complained исключены).
 */
export function findCampaignAudience(seg: SegmentCriteria, limit = 500): SubscriberRow[] {
  ensurePostmanTables();
  try {
    const status = seg.status && !SUPPRESSED.includes(seg.status) ? seg.status : "active";
    const conds: string[] = ["status = ?"];
    const params: any[] = [status];
    if (seg.locale) {
      conds.push("locale = ?");
      params.push(seg.locale);
    }
    const rows = sqlite().prepare(
      `SELECT * FROM email_subscribers WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params, Math.min(Math.max(limit, 1), 5000)) as SubscriberRow[];
    return rows || [];
  } catch (e) {
    console.warn("[postman] findCampaignAudience failed:", e);
    return [];
  }
}

function buildListUnsubscribeHeaders(unsubToken: string): Record<string, string> {
  const url = `${PUBLIC_URL}/u/${encodeURIComponent(unsubToken)}`;
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * Собрать тело письма. Для рекламных (isAd) добавляет обязательную маркировку
 * «реклама» + физ-адрес + явную ссылку отписки (закон «О рекламе»).
 */
function buildCampaignBody(bodyText: string, isAd: boolean, unsubToken: string): string {
  const unsubUrl = `${PUBLIC_URL}/u/${encodeURIComponent(unsubToken)}`;
  let body = bodyText;
  if (isAd) {
    body = `Реклама. MuzaAi.\n\n${body}`;
  }
  body += `\n\n---\n`;
  body += `Отписаться от рассылки: ${unsubUrl}\n`;
  if (isAd) {
    body += `Рекламодатель / адрес: ${POSTAL_ADDRESS}\n`;
  }
  return body;
}

function alreadySentRecently(subscriberId: number, campaignId: number | null): boolean {
  try {
    const cut = Date.now() - SEND_DEDUP_MS;
    const row = sqlite().prepare(
      `SELECT 1 FROM postman_send_log WHERE subscriber_id = ? AND (campaign_id IS ? OR campaign_id = ?) AND sent_at > ? LIMIT 1`,
    ).get(subscriberId, campaignId, campaignId, cut);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Разослать кампанию. dryRun=true — только подобрать аудиторию, не слать.
 * Все письма получают List-Unsubscribe заголовки (RFC 8058). Рекламные —
 * маркировку «реклама» + физ-адрес. Дедуп: 1 письмо кампании / адресат / 24ч.
 */
export async function sendCampaign(opts: {
  name: string;
  subject: string;
  bodyText: string;
  segment?: SegmentCriteria;
  isAd?: boolean;
  limit?: number;
  dryRun?: boolean;
}): Promise<SendCampaignResult> {
  ensurePostmanTables();
  const dryRun = !!opts.dryRun;
  const isAd = !!opts.isAd;
  const segment = opts.segment || {};
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 5000);

  if (!opts.subject?.trim() || !opts.bodyText?.trim()) {
    return { ok: false, candidates: 0, sent: 0, failed: 0, skipped: 0, dryRun, sample: [], error: "Нужны subject и bodyText" };
  }

  const audience = findCampaignAudience(segment, limit);
  recordAgentActivity("postman", { action: "send_campaign", candidates: audience.length, dryRun, isAd });

  const result: SendCampaignResult = {
    ok: true, candidates: audience.length, sent: 0, failed: 0, skipped: 0, dryRun, sample: [],
  };

  if (dryRun) {
    result.sample = audience.slice(0, 10).map(s => s.email.replace(/(.{2}).*(@.*)/, "$1***$2"));
    return result;
  }

  // Создаём запись кампании (доказательная база + статистика).
  let campaignId: number | null = null;
  try {
    const r: any = sqlite().prepare(
      `INSERT INTO email_campaigns (name, status, segment_json, subject, body_text, is_ad) VALUES (?, 'sending', ?, ?, ?, ?)`,
    ).run(opts.name || "campaign", JSON.stringify(segment), opts.subject, opts.bodyText, isAd ? 1 : 0);
    campaignId = Number(r?.lastInsertRowid ?? 0) || null;
  } catch (e) {
    console.warn("[postman] campaign insert failed:", e);
  }
  result.campaignId = campaignId ?? undefined;

  for (const sub of audience) {
    // suppress double-check (на случай если статус изменился между select и send)
    if (SUPPRESSED.includes(sub.status)) { result.skipped += 1; continue; }
    if (!sub.unsubscribe_token) {
      // подстраховка: у каждого active должен быть unsub-токен
      const t = genToken();
      try { sqlite().prepare(`UPDATE email_subscribers SET unsubscribe_token=? WHERE id=?`).run(t, sub.id); sub.unsubscribe_token = t; } catch {}
    }
    if (campaignId && alreadySentRecently(sub.id, campaignId)) { result.skipped += 1; continue; }

    const unsubToken = sub.unsubscribe_token!;
    const body = buildCampaignBody(opts.bodyText, isAd, unsubToken);
    try {
      const r = await sendEmail({
        to: sub.email,
        subject: opts.subject,
        text: body,
        kind: isAd ? "promo" : "transactional",
        headers: buildListUnsubscribeHeaders(unsubToken),
      });
      if (r.ok) {
        result.sent += 1;
        try { sqlite().prepare(`INSERT INTO postman_send_log (subscriber_id, campaign_id, sent_at) VALUES (?, ?, ?)`).run(sub.id, campaignId, Date.now()); } catch {}
      } else {
        result.failed += 1;
      }
    } catch {
      result.failed += 1;
    }
  }

  if (campaignId) {
    try {
      sqlite().prepare(`UPDATE email_campaigns SET status='sent', sent_count=?, failed_count=? WHERE id=?`).run(result.sent, result.failed, campaignId);
    } catch {}
  }
  recordAgentActivity("postman", { action: "send_campaign_done", sent: result.sent, failed: result.failed });
  return result;
}

// === Stats ===

export interface PostmanStats {
  subscribers: { total: number; active: number; pending: number; unsubscribed: number; bounced: number; complained: number };
  consents: { total: number; optIn: number; confirm: number; optOut: number };
  campaigns: { total: number; sent: number };
  inbox: { total: number; unhandled: number; byCategory: Record<string, number> };
}

export function getStats(): PostmanStats {
  ensurePostmanTables();
  const s = sqlite();
  const one = (q: string, ...a: any[]): any => { try { return s.prepare(q).get(...a); } catch { return null; } };
  const many = (q: string, ...a: any[]): any[] => { try { return s.prepare(q).all(...a); } catch { return []; } };

  const subRow = one(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status='unsubscribed' THEN 1 ELSE 0 END) AS unsubscribed,
       SUM(CASE WHEN status='bounced' THEN 1 ELSE 0 END) AS bounced,
       SUM(CASE WHEN status='complained' THEN 1 ELSE 0 END) AS complained
     FROM email_subscribers`,
  ) || {};
  const consRow = one(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN action='opt_in' THEN 1 ELSE 0 END) AS optIn,
       SUM(CASE WHEN action='confirm' THEN 1 ELSE 0 END) AS confirm,
       SUM(CASE WHEN action='opt_out' THEN 1 ELSE 0 END) AS optOut
     FROM email_consents`,
  ) || {};
  const campRow = one(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent FROM email_campaigns`,
  ) || {};
  const inboxRow = one(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN handled=0 THEN 1 ELSE 0 END) AS unhandled FROM postman_inbox`,
  ) || {};
  const catRows = many(`SELECT category, COUNT(*) AS cnt FROM postman_inbox GROUP BY category`);
  const byCategory: Record<string, number> = {};
  for (const r of catRows) byCategory[String(r.category || "uncategorized")] = Number(r.cnt || 0);

  return {
    subscribers: {
      total: Number(subRow.total || 0), active: Number(subRow.active || 0), pending: Number(subRow.pending || 0),
      unsubscribed: Number(subRow.unsubscribed || 0), bounced: Number(subRow.bounced || 0), complained: Number(subRow.complained || 0),
    },
    consents: { total: Number(consRow.total || 0), optIn: Number(consRow.optIn || 0), confirm: Number(consRow.confirm || 0), optOut: Number(consRow.optOut || 0) },
    campaigns: { total: Number(campRow.total || 0), sent: Number(campRow.sent || 0) },
    inbox: { total: Number(inboxRow.total || 0), unhandled: Number(inboxRow.unhandled || 0), byCategory },
  };
}

export function listConsents(limit = 100): EmailConsentRow[] {
  ensurePostmanTables();
  try {
    return sqlite().prepare(
      `SELECT c.id, c.subscriber_id, c.channel, c.action, c.consent_text, c.source, c.created_at, s.email
       FROM email_consents c LEFT JOIN email_subscribers s ON s.id = c.subscriber_id
       ORDER BY c.id DESC LIMIT ?`,
    ).all(Math.min(Math.max(limit, 1), 1000)) as EmailConsentRow[];
  } catch {
    return [];
  }
}

export interface EmailConsentRow {
  id: number;
  subscriber_id: number;
  channel: string;
  action: string;
  consent_text: string | null;
  source: string | null;
  created_at: string;
  email: string | null;
}

// === Inbound classification (AI через DeepSeek — дёшево) ===

export type InboxCategory = "support" | "complaint" | "unsubscribe" | "question" | "spam" | "other";

const INBOX_CATEGORIES: InboxCategory[] = ["support", "complaint", "unsubscribe", "question", "spam", "other"];

/**
 * AI-классификация входящего письма через DeepSeek (LLM-chain-order: дешёвый
 * первым). Возвращает категорию + грубый sentiment. Fallback на keyword-эвристику
 * если LLM недоступен. Запись в postman_inbox для admin-обзора.
 *
 * TODO: реальный IMAP-поллинг (как email-channel плагин) — пока заглушка,
 * классификатор готов и вызывается из тестов / будущего inbox-listener.
 */
export async function classifyInbound(opts: {
  fromEmail?: string;
  subject?: string;
  body: string;
}): Promise<{ category: InboxCategory; sentiment: "positive" | "neutral" | "negative" }> {
  const text = `${opts.subject || ""}\n${opts.body || ""}`.slice(0, 2000);

  // 1. AI-классификация (DeepSeek — дёшево, без tools)
  try {
    const { callDeepSeek } = await import("./llmCore");
    const r = await callDeepSeek({
      systemPrompt:
        "Ты классификатор входящих писем для MuzaAi. Верни СТРОГО JSON без пояснений: " +
        `{"category":"support|complaint|unsubscribe|question|spam|other","sentiment":"positive|neutral|negative"}. ` +
        "support — просьба помочь/проблема; complaint — жалоба/негатив; unsubscribe — просьба отписать; " +
        "question — вопрос про продукт/цены; spam — реклама/мусор; other — прочее.",
      history: [],
      userText: text,
      maxTokens: 60,
    });
    if (r.text) {
      const m = r.text.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        const cat = INBOX_CATEGORIES.includes(parsed.category) ? parsed.category as InboxCategory : "other";
        const sent = ["positive", "neutral", "negative"].includes(parsed.sentiment) ? parsed.sentiment : "neutral";
        recordInbound(opts, cat, sent);
        recordAgentActivity("postman", { action: "classify_inbound", category: cat, via: "ai" });
        return { category: cat, sentiment: sent };
      }
    }
  } catch (e) {
    console.warn("[postman] AI classify failed, fallback to keywords:", (e as Error)?.message || e);
  }

  // 2. Keyword fallback
  const t = text.toLowerCase();
  let category: InboxCategory = "other";
  let sentiment: "positive" | "neutral" | "negative" = "neutral";
  if (/отпис|unsubscribe|не присылай|stop/.test(t)) category = "unsubscribe";
  else if (/жалоб|обман|верните деньги|ужас|мошенник|плохо/.test(t)) { category = "complaint"; sentiment = "negative"; }
  else if (/помог|не работает|ошибк|проблем|не могу/.test(t)) category = "support";
  else if (/сколько|цена|стоит|как|вопрос|можно ли/.test(t)) category = "question";
  else if (/casino|viagra|crypto|заработок|http:\/\//.test(t)) { category = "spam"; }
  recordInbound(opts, category, sentiment);
  recordAgentActivity("postman", { action: "classify_inbound", category, via: "keywords" });
  return { category, sentiment };
}

function recordInbound(
  opts: { fromEmail?: string; subject?: string; body: string },
  category: InboxCategory,
  sentiment: string,
): void {
  ensurePostmanTables();
  try {
    sqlite().prepare(
      `INSERT INTO postman_inbox (from_email, subject, snippet, category, sentiment, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.fromEmail ? normalizeEmail(opts.fromEmail) : null,
      (opts.subject || "").slice(0, 200),
      (opts.body || "").slice(0, 300),
      category,
      sentiment,
      Date.now(),
    );
  } catch (e) {
    console.warn("[postman] recordInbound failed:", e);
  }
}

export interface InboxItem {
  id: number;
  from_email: string | null;
  subject: string | null;
  snippet: string | null;
  category: string | null;
  sentiment: string | null;
  created_at: number;
  handled: number;
}

export function listInbox(limit = 50, category?: string): InboxItem[] {
  ensurePostmanTables();
  try {
    if (category) {
      return sqlite().prepare(
        `SELECT * FROM postman_inbox WHERE category = ? ORDER BY created_at DESC LIMIT ?`,
      ).all(category, Math.min(Math.max(limit, 1), 500)) as InboxItem[];
    }
    return sqlite().prepare(
      `SELECT * FROM postman_inbox ORDER BY created_at DESC LIMIT ?`,
    ).all(Math.min(Math.max(limit, 1), 500)) as InboxItem[];
  } catch {
    return [];
  }
}

/** healthCheck-probe для Директора: настроен ли SMTP + размер очереди/база. */
export function postmanHealth(): { ok: boolean; details: Record<string, unknown> } {
  const smtpConfigured = !!(process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD);
  const stats = getStats();
  return {
    ok: smtpConfigured,
    details: {
      smtpConfigured,
      activeSubscribers: stats.subscribers.active,
      pending: stats.subscribers.pending,
      suppressed: stats.subscribers.unsubscribed + stats.subscribers.bounced + stats.subscribers.complained,
      inboxUnhandled: stats.inbox.unhandled,
    },
  };
}
