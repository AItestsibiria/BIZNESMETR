// Eugene 2026-05-25 Босс «я даю задачу — Директор запускает кампании». Шаг 3/3.
//
// Balance-reminder + upsell: юзеры с НЕПОТРАЧЕННЫМ бонусным треком или балансом,
// которые давно не генерировали — получают email-нудж «создайте песню». Это
// закрывает прямой разрыв конверсии из аудита (раньше такие юзеры не получали
// НИЧЕГО).
//
// Director-subordination rule: агент balance-reminder зарегистрирован в Директоре
// (bootstrap), recordActivity при запуске, запускается командой Босса через
// director-tool ИЛИ daily-cron (gate: BALANCE_REMINDER_ENABLED=1, по умолчанию OFF
// чтобы не разослать неожиданно на деплое).
//
// Reuse-working-solutions: sendEmail (lib/emailSender), PRICES (routes), без
// нового pipeline. Dedup через self-migrating reminder_log (1 нудж / 7 дней / юзер).

import { db } from "../storage";
import { sendEmail } from "./emailSender";
import { recordAgentActivity } from "./agentOrchestrator";

const MUSIC_PRICE_KOPECKS = 39900; // 399 ₽ (Pricing-single-source — PRICES.music)
const REMINDER_COOLDOWN_MS = 7 * 24 * 3600_000; // не чаще 1 / 7 дней на юзера
const INACTIVE_DAYS = 3; // нудж только тем, кто не генерировал ≥3 дней

let migrated = false;
function ensureTable(): void {
  if (migrated) return;
  try {
    const sqlite: any = (db as any).$client;
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS reminder_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reminder_user_kind ON reminder_log(user_id, kind, sent_at DESC);
    `);
    migrated = true;
  } catch (e) {
    console.warn("[balanceReminder] migration failed:", e);
  }
}

export interface ReminderCandidate {
  id: number;
  name: string | null;
  email: string;
  balance: number;
  bonusTracks: number;
}

/**
 * Кандидаты на balance-нудж: реальный email + (бонусный трек ИЛИ баланс ≥ цены)
 * + не генерировал ≥INACTIVE_DAYS + не нуджили последние 7 дней + не заблокирован.
 */
export function findReminderCandidates(limit = 100): ReminderCandidate[] {
  ensureTable();
  try {
    const sqlite: any = (db as any).$client;
    const cooldownCut = Date.now() - REMINDER_COOLDOWN_MS;
    const rows = sqlite.prepare(`
      SELECT u.id, u.name, u.email, u.balance, u.bonus_tracks AS bonusTracks
      FROM users u
      WHERE (u.bonus_tracks > 0 OR u.balance >= ?)
        AND u.email LIKE '%@%'
        AND u.email NOT LIKE 'tg!_%' ESCAPE '!'
        AND u.email NOT LIKE '%@telegram.%'
        AND u.email NOT LIKE '%@phone.%'
        AND (u.blocked IS NULL OR u.blocked = 0)
        AND (
          (SELECT MAX(g.created_at) FROM generations g WHERE g.user_id = u.id) IS NULL
          OR datetime((SELECT MAX(g.created_at) FROM generations g WHERE g.user_id = u.id)) < datetime('now', '-${INACTIVE_DAYS} days')
        )
        AND u.id NOT IN (
          SELECT user_id FROM reminder_log WHERE kind = 'balance' AND sent_at > ?
        )
      ORDER BY u.bonus_tracks DESC, u.balance DESC
      LIMIT ?
    `).all(MUSIC_PRICE_KOPECKS, cooldownCut, limit) as ReminderCandidate[];
    return rows || [];
  } catch (e) {
    console.warn("[balanceReminder] findCandidates failed:", e);
    return [];
  }
}

function buildReminderEmail(c: ReminderCandidate): { subject: string; text: string } {
  const name = c.name || "автор";
  const hasBonus = c.bonusTracks > 0;
  const balanceRub = Math.round(c.balance / 100);
  const what = hasBonus
    ? `у вас ${c.bonusTracks} подарочн${c.bonusTracks === 1 ? "ый трек" : "ых трека"} — можно создать песню бесплатно`
    : `на балансе ${balanceRub} ₽ — хватит на песню`;
  return {
    subject: hasBonus ? "🎁 У вас есть подарочный трек на MuzaAi" : "🎵 Ваш баланс ждёт — создайте песню",
    text:
      `Здравствуйте, ${name}!\n\n` +
      `Это Музa с MuzaAi. Напоминаю: ${what}. \n\n` +
      `Песня на день рождения, юбилей, признание или просто для настроения — ` +
      `я помогу с текстом и подберу голос. Это займёт пару минут.\n\n` +
      `Создать прямо сейчас: https://muzaai.ru/music\n` +
      `Или напишите мне в чат на muzaai.ru — придумаем вместе.\n\n` +
      `С теплом, Музa · MuzaAi`,
  };
}

export interface SendRemindersResult {
  candidates: number;
  sent: number;
  failed: number;
  dryRun: boolean;
  sample: string[];
}

/**
 * Разослать balance-нуджи. dryRun=true — только подобрать кандидатов, не слать.
 * Вызывается из director-tool (по команде Босса) или daily-cron.
 */
export async function sendBalanceReminders(opts: { limit?: number; dryRun?: boolean } = {}): Promise<SendRemindersResult> {
  ensureTable();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const dryRun = !!opts.dryRun;
  const candidates = findReminderCandidates(limit);
  recordAgentActivity("balance-reminder", { candidates: candidates.length, dryRun });
  const result: SendRemindersResult = { candidates: candidates.length, sent: 0, failed: 0, dryRun, sample: [] };
  if (dryRun) {
    result.sample = candidates.slice(0, 10).map(c => `${c.name || "?"} <${c.email}> (бонус ${c.bonusTracks}, баланс ${Math.round(c.balance / 100)}₽)`);
    return result;
  }
  const sqlite: any = (db as any).$client;
  for (const c of candidates) {
    try {
      const { subject, text } = buildReminderEmail(c);
      const r = await sendEmail({ to: c.email, subject, text });
      if (r.ok) {
        result.sent += 1;
        try { sqlite.prepare(`INSERT INTO reminder_log (user_id, kind, sent_at) VALUES (?, 'balance', ?)`).run(c.id, Date.now()); } catch {}
      } else {
        result.failed += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
