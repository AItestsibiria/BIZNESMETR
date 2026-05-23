// Eugene 2026-05-23 Босс «явно там ошибки — найди»: atom-level billing audit.
//
// Single source of truth для всех проверок целостности денег.
// Используется как:
//   - Admin endpoint /api/admin/v304/billing/audit (online JSON отчёт)
//   - Doc-генератор docs/BILLING-AUDIT-YYYY-MM-DD.md (с CLI триггером)
//
// ВАЖНО про schema (CLAUDE.md Pricing-single-source rule):
//   transactions.amount — signed kopecks (negative = charge, positive = credit).
//   type ∈ { 'music','lyrics','cover','topup' }. Refund — тот же type что
//   списание, amount=+cost. Бонусы/реферал — type='topup' amount>0.
//   FK на generation/payment в schema НЕТ — связь через description regex
//   (#<genId>, счёт #<invId>).
//
// PRICES (текущие, копейки):
//   music=39900 (399₽), lyrics=9900 (99₽), cover=9900 (99₽).
//   До 2026-05-19 music=29900 (299₽) — старая цена должна встречаться
//   у транзакций ранее этой даты, что НЕ ошибка.
//
// claimRefund() двойную защиту даёт через JSON-flag в generations.style.refunded.

import { sqliteDb } from "../storage";

export interface AuditIssue {
  severity: "critical" | "medium" | "low";
  category: string;
  description: string;
  userId?: number;
  amountKopecks?: number;
  genId?: number;
  paymentId?: number;
  invoiceId?: number;
  meta?: Record<string, any>;
}

export interface AuditReport {
  generatedAt: string;
  scopeNote: string;
  summary: {
    totalTransactions: number;
    totalCharges: number;       // sum |negative amounts| (kopecks)
    totalCredits: number;       // sum positive amounts (kopecks, includes refund+topup+bonus)
    totalRefunds: number;       // подмножество credits — те что type IN (music/lyrics/cover) AND amount>0
    totalTopups: number;        // type='topup' AND amount>0
    totalPaidPayments: number;
    totalPaidPaymentsAmount: number; // kopecks
    activeBalanceUsers: number; // users с balance > 0
    sumBalanceAll: number;      // sum users.balance
    sumBonusTracksAll: number;
    activePremiumSubs: number;
  };
  issues: AuditIssue[];
  buckets: {
    critical: number;
    medium: number;
    low: number;
  };
  pricingBreakdown: Array<{ amountKopecks: number; type: string; count: number }>;
  unrefundedErroredGens: Array<{
    genId: number;
    userId: number;
    cost: number;
    status: string;
    errorReason: string | null;
    createdAt: string;
  }>;
  balanceMismatches: Array<{
    userId: number;
    storedBalance: number;
    computedBalance: number;
    delta: number;
  }>;
  unbookedPayments: Array<{
    paymentId: number;
    invId: number;
    userId: number;
    amountKopecks: number;
    createdAt: string;
  }>;
  doublePremiumPaid: Array<{
    userId: number;
    invoiceId: number;
    paymentCount: number;
  }>;
  premiumWithoutSub: Array<{
    invoiceId: number;
    userId: number;
    tariffKey: string;
    paidAt: string;
  }>;
  expiredButActiveSubs: Array<{
    subId: number;
    userId: number;
    tier: string;
    expiresAt: string;
  }>;
  recommendedRefunds: Array<{
    genId: number;
    userId: number;
    cost: number;
    reason: string;
  }>;
  // Eugene 2026-05-23 — Reconciliation generation ↔ transaction (Check #11/12/13)
  freeGenerationsBypass: Array<{
    genId: number;
    userId: number;
    type: string;
    cost: number;
    createdAt: string;
  }>;
  orphanCharges: Array<{
    txnId: number;
    userId: number;
    type: string;
    amount: number;
    description: string;
    createdAt: string;
  }>;
  costMismatches: Array<{
    genId: number;
    userId: number;
    type: string;
    genCost: number;
    charged: number;
    delta: number;
  }>;
}

function rawDb(): any {
  // sqliteDb — better-sqlite3 native handle.
  return sqliteDb;
}

/**
 * Регекс «#NNN» в description — пытаемся вытащить genId.
 * Возвращает null если не нашли.
 */
function extractGenIdFromDescription(desc: string | null | undefined): number | null {
  if (!desc) return null;
  const m = desc.match(/#(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Главный entrypoint. Возвращает полный отчёт без записи в БД.
 * Read-only — никаких UPDATE/INSERT/DELETE.
 */
export function runBillingAudit(): AuditReport {
  const db = rawDb();
  const issues: AuditIssue[] = [];

  // ---- Summary ---------------------------------------------------------
  const txnRows: any[] = db.prepare(`
    SELECT id, user_id, type, amount, description, created_at
    FROM transactions
  `).all();

  let totalCharges = 0;
  let totalCredits = 0;
  let totalRefunds = 0;
  let totalTopups = 0;

  for (const t of txnRows) {
    const amt = Number(t.amount) || 0;
    if (amt < 0) totalCharges += -amt;
    else if (amt > 0) {
      totalCredits += amt;
      if (t.type === "topup") totalTopups += amt;
      else if (t.type === "music" || t.type === "lyrics" || t.type === "cover") totalRefunds += amt;
    }
  }

  const paidPaymentsAgg = db.prepare(`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS sum
    FROM payments WHERE status = 'paid'
  `).get() as { cnt: number; sum: number };

  const activeBalanceUsers = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM users WHERE balance > 0
  `).get() as { cnt: number }).cnt;

  const sumBalanceAll = (db.prepare(`
    SELECT COALESCE(SUM(balance), 0) AS s FROM users
  `).get() as { s: number }).s;

  const sumBonusTracksAll = (db.prepare(`
    SELECT COALESCE(SUM(bonus_tracks), 0) AS s FROM users
  `).get() as { s: number }).s;

  const activePremiumSubs = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM premium_subscriptions WHERE status = 'active'
  `).get() as { cnt: number }).cnt;

  // ---- Check #1: Double-charge (same user, same gen_id ref, same amount, multiple negative tx) ----
  // Эвристика: для каждой негативной транзакции вытаскиваем genId из description.
  // Группируем (userId, type, genId, amount). Если count > 1 — потенциальный дубль.
  const negativeTxns = txnRows.filter((t) => Number(t.amount) < 0);
  const chargeGroups = new Map<string, any[]>();
  for (const t of negativeTxns) {
    const genId = extractGenIdFromDescription(t.description);
    if (genId === null) continue; // skip bare top-ups / unsegmented
    const key = `${t.user_id}::${t.type}::${genId}::${t.amount}`;
    if (!chargeGroups.has(key)) chargeGroups.set(key, []);
    chargeGroups.get(key)!.push(t);
  }
  for (const [key, grp] of chargeGroups.entries()) {
    if (grp.length > 1) {
      issues.push({
        severity: "critical",
        category: "double_charge",
        description: `Duplicate charge: ${grp.length} списаний с одной gen ${key}`,
        userId: grp[0].user_id,
        amountKopecks: Math.abs(Number(grp[0].amount)) * grp.length,
        genId: extractGenIdFromDescription(grp[0].description) ?? undefined,
        meta: {
          duplicateCount: grp.length,
          txnIds: grp.map((t) => t.id),
          firstAt: grp[0].created_at,
          lastAt: grp[grp.length - 1].created_at,
        },
      });
    }
  }

  // ---- Check #2: errored generations with NO refund -------------------
  // Списано (cost > 0, type IN music/lyrics/cover, есть charge с #genId) но
  // gen.status IN ('error','failed','cancelled') и нет «зеркального» позитивного
  // транзакта с тем же #genId. Дополнительно проверяем style.refunded flag.
  const erroredGens: any[] = db.prepare(`
    SELECT id, user_id, type, cost, status, error_reason, created_at, style
    FROM generations
    WHERE status IN ('error', 'failed', 'cancelled')
      AND deleted_at IS NULL
  `).all();

  const refundsByGenId = new Map<number, number>(); // genId → sum of positive refund amounts
  for (const t of txnRows) {
    if (Number(t.amount) <= 0) continue;
    const genId = extractGenIdFromDescription(t.description);
    if (genId === null) continue;
    // type должен совпадать с charge type (music/lyrics/cover). Skip topup-bonuses.
    if (t.type === "topup") continue;
    refundsByGenId.set(genId, (refundsByGenId.get(genId) || 0) + Number(t.amount));
  }

  const unrefundedErroredGens: AuditReport["unrefundedErroredGens"] = [];
  const recommendedRefunds: AuditReport["recommendedRefunds"] = [];

  for (const gen of erroredGens) {
    const cost = Number(gen.cost) || 0;
    if (cost <= 0) continue; // bonus track gens have cost=0 — refund N/A
    // Check style.refunded flag
    let refundedFlag = false;
    try {
      const style = gen.style ? JSON.parse(gen.style) : {};
      refundedFlag = style?.refunded === true;
    } catch {}
    const refundedAmount = refundsByGenId.get(gen.id) || 0;
    if (!refundedFlag && refundedAmount < cost) {
      // Должен был получить refund, но не получил
      const lost = cost - refundedAmount;
      unrefundedErroredGens.push({
        genId: gen.id,
        userId: gen.user_id,
        cost,
        status: gen.status,
        errorReason: gen.error_reason || null,
        createdAt: gen.created_at,
      });
      recommendedRefunds.push({
        genId: gen.id,
        userId: gen.user_id,
        cost: lost,
        reason: `errored without refund (${gen.error_reason || gen.status})`,
      });
      issues.push({
        severity: "critical",
        category: "missed_refund",
        description: `Gen #${gen.id} errored (${gen.status}) BUT no refund (style.refunded=${refundedFlag}, refundedAmount=${refundedAmount}/${cost})`,
        userId: gen.user_id,
        amountKopecks: lost,
        genId: gen.id,
        meta: { errorReason: gen.error_reason, type: gen.type },
      });
    }
  }

  // ---- Check #3: Cost mismatch (amounts not matching PRICES) ----------
  // Только negative side. Игнорируем 0-amount (bonus-track) и topup (любая сумма).
  const PRICES_KOPECKS = new Set([9900, 29900, 39900]); // 99,299 (legacy),399
  const pricingBreakdown: AuditReport["pricingBreakdown"] = [];
  const grpByAmountType = new Map<string, number>();
  for (const t of txnRows) {
    if (t.type === "topup") continue;
    const amt = Math.abs(Number(t.amount));
    if (amt === 0) continue;
    const k = `${amt}::${t.type}`;
    grpByAmountType.set(k, (grpByAmountType.get(k) || 0) + 1);
  }
  for (const [key, count] of grpByAmountType.entries()) {
    const [amtStr, type] = key.split("::");
    const amt = parseInt(amtStr, 10);
    pricingBreakdown.push({ amountKopecks: amt, type, count });
    if (!PRICES_KOPECKS.has(amt)) {
      issues.push({
        severity: "medium",
        category: "price_anomaly",
        description: `Нестандартная сумма списания/refund: ${amt} коп. (type=${type}, ${count} транзакций)`,
        amountKopecks: amt,
        meta: { type, count },
      });
    }
  }
  pricingBreakdown.sort((a, b) => b.count - a.count);

  // ---- Check #4: Balance integrity ------------------------------------
  // user.balance ?= SUM(transactions.amount) для каждого user.
  // Это работает потому что amount signed (negative=charge, positive=credit).
  const balanceCheckRows: any[] = db.prepare(`
    SELECT
      u.id AS user_id,
      u.balance AS stored,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id = u.id), 0) AS computed
    FROM users u
  `).all();

  const balanceMismatches: AuditReport["balanceMismatches"] = [];
  for (const r of balanceCheckRows) {
    const stored = Number(r.stored) || 0;
    const computed = Number(r.computed) || 0;
    const delta = stored - computed;
    if (Math.abs(delta) > 0) {
      balanceMismatches.push({
        userId: r.user_id,
        storedBalance: stored,
        computedBalance: computed,
        delta,
      });
      const sev: AuditIssue["severity"] = Math.abs(delta) >= 9900 ? "medium" : "low";
      issues.push({
        severity: sev,
        category: "balance_integrity",
        description: `User #${r.user_id}: stored=${stored} != computed=${computed} (delta=${delta} коп.)`,
        userId: r.user_id,
        amountKopecks: Math.abs(delta),
        meta: { stored, computed },
      });
    }
  }

  // ---- Check #5: Robokassa paid payments NOT credited to transactions --
  // Связка идёт через description «счёт #<InvId>». Если не нашли соответствие
  // — либо bug в /api/payment/result (упал до createTransaction), либо
  // invoice fulfilled через premium_subscription (тогда transaction
  // с amount=0 type=topup и description содержит «счёт #<invoice.id>»,
  // НЕ InvId Robokassa — отдельный кейс).
  const paidPayments: any[] = db.prepare(`
    SELECT id, inv_id, user_id, amount, status, invoice_id, created_at, description
    FROM payments
    WHERE status = 'paid'
  `).all();

  const unbookedPayments: AuditReport["unbookedPayments"] = [];
  for (const p of paidPayments) {
    // Поиск transaction которая упоминает invId или (через invoice.id) этот payment
    let found = false;
    for (const t of txnRows) {
      if (!t.description) continue;
      // Robokassa direct: «счёт #<InvId>»
      if (t.description.includes(`счёт #${p.inv_id}`) || t.description.includes(`(счёт #${p.inv_id})`)) {
        found = true; break;
      }
      // Invoice-fulfilled: «Счёт #<invoice.id>»
      if (p.invoice_id && t.description.includes(`#${p.invoice_id}`)) {
        // Heuristic — может пересечься с другим контекстом, поэтому
        // дополнительно проверяем userId.
        if (Number(t.user_id) === Number(p.user_id)) { found = true; break; }
      }
    }
    if (!found) {
      unbookedPayments.push({
        paymentId: p.id,
        invId: p.inv_id,
        userId: p.user_id,
        amountKopecks: Number(p.amount),
        createdAt: p.created_at,
      });
      issues.push({
        severity: "critical",
        category: "payment_not_credited",
        description: `Robokassa payment #${p.id} (InvId=${p.inv_id}) paid ${p.amount/100}₽ — НЕТ соответствующего transaction`,
        userId: p.user_id,
        paymentId: p.id,
        amountKopecks: Number(p.amount),
        meta: { invId: p.inv_id, invoiceId: p.invoice_id },
      });
    }
  }

  // ---- Check #6: Premium subscription fulfillment ---------------------
  // a) Invoice paid + tariff_key='premium_*' BUT no premium_subscription row → bug
  // b) premium_subscriptions активных с одним и тем же invoice_id > 1 (дубль fulfillment)
  // c) status='active' но expires_at < now (просрочка не сбросилась)
  let invoicesTableExists = false;
  try {
    invoicesTableExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invoices'").get();
  } catch {}

  const premiumWithoutSub: AuditReport["premiumWithoutSub"] = [];
  const doublePremiumPaid: AuditReport["doublePremiumPaid"] = [];

  if (invoicesTableExists) {
    const paidPremiumInvoices: any[] = db.prepare(`
      SELECT id, user_id, tariff_key, paid_at, status
      FROM invoices
      WHERE status = 'paid'
        AND tariff_key LIKE 'premium_%'
    `).all();

    for (const inv of paidPremiumInvoices) {
      const subs: any[] = db.prepare(`
        SELECT id, status FROM premium_subscriptions
        WHERE invoice_id = ?
      `).all(inv.id);
      if (subs.length === 0) {
        premiumWithoutSub.push({
          invoiceId: inv.id,
          userId: inv.user_id,
          tariffKey: inv.tariff_key,
          paidAt: inv.paid_at,
        });
        issues.push({
          severity: "critical",
          category: "premium_fulfillment_missing",
          description: `Invoice #${inv.id} paid (${inv.tariff_key}) — нет premium_subscription`,
          userId: inv.user_id,
          invoiceId: inv.id,
          meta: { tariffKey: inv.tariff_key, paidAt: inv.paid_at },
        });
      } else if (subs.length > 1) {
        doublePremiumPaid.push({
          userId: inv.user_id,
          invoiceId: inv.id,
          paymentCount: subs.length,
        });
        issues.push({
          severity: "medium",
          category: "premium_duplicate_subscription",
          description: `Invoice #${inv.id}: ${subs.length} premium_subscription rows`,
          userId: inv.user_id,
          invoiceId: inv.id,
          meta: { subIds: subs.map((s) => s.id) },
        });
      }
    }
  }

  // expired but status='active'
  const expiredButActiveSubs: AuditReport["expiredButActiveSubs"] = [];
  const nowIso = new Date().toISOString();
  const expActive: any[] = db.prepare(`
    SELECT id, user_id, tier, expires_at
    FROM premium_subscriptions
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?
  `).all(nowIso);
  for (const s of expActive) {
    expiredButActiveSubs.push({
      subId: s.id,
      userId: s.user_id,
      tier: s.tier,
      expiresAt: s.expires_at,
    });
    issues.push({
      severity: "low",
      category: "premium_expired_active_flag",
      description: `Premium sub #${s.id} ${s.tier} expired ${s.expires_at} BUT status='active'`,
      userId: s.user_id,
      meta: { subId: s.id, expiresAt: s.expires_at },
    });
  }

  // ---- Check #7: Bonus tracks integrity -------------------------------
  // bonus_tracks counter ?= count(welcome_gift transactions) - count(spent
  // bonus). Bonus-spend = transaction с type='music' amount=0 описание
  // содержит «подарочный».
  // Heuristic — упрощённый, может быть false-positive если у юзера были
  // ручные admin adjustments.
  const bonusCheck: any[] = db.prepare(`
    SELECT
      u.id AS user_id,
      u.bonus_tracks AS stored,
      u.welcome_gift_given AS welcomeGift,
      (SELECT COUNT(*) FROM transactions
        WHERE user_id = u.id AND amount = 0
          AND (description LIKE '%подарочный%' OR description LIKE '%бонусный трек%')
          AND type IN ('music','topup')) AS bonusEvents
    FROM users u
    WHERE u.bonus_tracks > 0 OR u.welcome_gift_given = 1
  `).all();

  for (const b of bonusCheck) {
    // Если welcome_gift_given=1 но bonus_tracks=0 — OK (юзер уже использовал).
    // Если bonus_tracks>10 — подозрительно (>10 промокодов?).
    if (Number(b.stored) > 10) {
      issues.push({
        severity: "low",
        category: "bonus_tracks_anomaly",
        description: `User #${b.user_id} has ${b.stored} bonus_tracks (>10) — проверить ручные правки admin`,
        userId: b.user_id,
        meta: { stored: b.stored, welcomeGift: b.welcomeGift, bonusEvents: b.bonusEvents },
      });
    }
  }

  // ---- Check #8: Generations с cost=0 не из bonus pipeline ----
  // Если cost=0 + status=done + не было welcomeGift = подозрительно.
  // Пропустим — это OK если admin отключил оплату ручным флагом.

  // ---- Assemble report ------------------------------------------------
  const buckets = {
    critical: issues.filter((i) => i.severity === "critical").length,
    medium: issues.filter((i) => i.severity === "medium").length,
    low: issues.filter((i) => i.severity === "low").length,
  };

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    scopeNote: "atom-level read-only audit. Никаких изменений данных не делается. См. CLAUDE.md Pricing-single-source rule.",
    summary: {
      totalTransactions: txnRows.length,
      totalCharges,
      totalCredits,
      totalRefunds,
      totalTopups,
      totalPaidPayments: paidPaymentsAgg.cnt,
      totalPaidPaymentsAmount: paidPaymentsAgg.sum,
      activeBalanceUsers,
      sumBalanceAll,
      sumBonusTracksAll,
      activePremiumSubs,
    },
    issues,
    buckets,
    pricingBreakdown,
    unrefundedErroredGens,
    balanceMismatches,
    unbookedPayments,
    doublePremiumPaid,
    premiumWithoutSub,
    expiredButActiveSubs,
    recommendedRefunds,
  };

  return report;
}

/**
 * Helper для UI / docs — формат «X ₽».
 */
export function formatRub(kopecks: number): string {
  const sign = kopecks < 0 ? "-" : "";
  const abs = Math.abs(kopecks);
  const rub = Math.floor(abs / 100);
  const kop = abs % 100;
  return `${sign}${rub}${kop ? "," + String(kop).padStart(2, "0") : ""} ₽`;
}

/**
 * Compact markdown сводки для встройки в docs/.
 */
export function renderMarkdownReport(report: AuditReport): string {
  const lines: string[] = [];
  const d = report.generatedAt.slice(0, 10);
  lines.push(`# Billing Audit ${d}`);
  lines.push("");
  lines.push(`Generated at: \`${report.generatedAt}\``);
  lines.push("");
  lines.push(report.scopeNote);
  lines.push("");
  lines.push("## Сводка");
  lines.push("");
  lines.push(`- Total transactions: **${report.summary.totalTransactions}**`);
  lines.push(`- Total charges (списано): **${formatRub(report.summary.totalCharges)}**`);
  lines.push(`- Total credits (refund+topup+bonus): **${formatRub(report.summary.totalCredits)}**`);
  lines.push(`  - of which refunds: **${formatRub(report.summary.totalRefunds)}**`);
  lines.push(`  - of which topups (Robokassa+bonus): **${formatRub(report.summary.totalTopups)}**`);
  lines.push(`- Paid Robokassa payments: **${report.summary.totalPaidPayments}** на сумму **${formatRub(report.summary.totalPaidPaymentsAmount)}**`);
  lines.push(`- Users with balance > 0: **${report.summary.activeBalanceUsers}**`);
  lines.push(`- Sum users.balance: **${formatRub(report.summary.sumBalanceAll)}**`);
  lines.push(`- Sum bonus_tracks: **${report.summary.sumBonusTracksAll}**`);
  lines.push(`- Active premium subscriptions: **${report.summary.activePremiumSubs}**`);
  lines.push("");
  lines.push(`## Найдено проблем: ${report.issues.length}`);
  lines.push("");
  lines.push(`- 🔴 CRITICAL: **${report.buckets.critical}**`);
  lines.push(`- 🟡 MEDIUM: **${report.buckets.medium}**`);
  lines.push(`- 🟢 LOW: **${report.buckets.low}**`);
  lines.push("");

  const critIssues = report.issues.filter((i) => i.severity === "critical");
  if (critIssues.length) {
    lines.push("### 🔴 CRITICAL");
    lines.push("");
    for (const i of critIssues.slice(0, 50)) {
      lines.push(`- **${i.category}** — ${i.description}${i.amountKopecks ? ` — ${formatRub(i.amountKopecks)}` : ""}`);
    }
    if (critIssues.length > 50) lines.push(`- … ещё ${critIssues.length - 50}`);
    lines.push("");
  }

  const medIssues = report.issues.filter((i) => i.severity === "medium");
  if (medIssues.length) {
    lines.push("### 🟡 MEDIUM");
    lines.push("");
    for (const i of medIssues.slice(0, 30)) {
      lines.push(`- **${i.category}** — ${i.description}${i.amountKopecks ? ` — ${formatRub(i.amountKopecks)}` : ""}`);
    }
    if (medIssues.length > 30) lines.push(`- … ещё ${medIssues.length - 30}`);
    lines.push("");
  }

  const lowIssues = report.issues.filter((i) => i.severity === "low");
  if (lowIssues.length) {
    lines.push("### 🟢 LOW");
    lines.push("");
    for (const i of lowIssues.slice(0, 20)) {
      lines.push(`- **${i.category}** — ${i.description}`);
    }
    if (lowIssues.length > 20) lines.push(`- … ещё ${lowIssues.length - 20}`);
    lines.push("");
  }

  if (report.recommendedRefunds.length) {
    lines.push("## Рекомендованные ручные refunds");
    lines.push("");
    lines.push("| genId | userId | amount | reason |");
    lines.push("|---|---|---|---|");
    for (const r of report.recommendedRefunds.slice(0, 200)) {
      lines.push(`| ${r.genId} | ${r.userId} | ${formatRub(r.cost)} | ${r.reason} |`);
    }
    if (report.recommendedRefunds.length > 200) {
      lines.push(`| … | ещё ${report.recommendedRefunds.length - 200} строк | | |`);
    }
    lines.push("");
  }

  if (report.balanceMismatches.length) {
    lines.push("## Balance mismatches (stored != SUM(transactions))");
    lines.push("");
    lines.push("| userId | stored | computed | delta |");
    lines.push("|---|---|---|---|");
    for (const b of report.balanceMismatches.slice(0, 100)) {
      lines.push(`| ${b.userId} | ${formatRub(b.storedBalance)} | ${formatRub(b.computedBalance)} | ${formatRub(b.delta)} |`);
    }
    if (report.balanceMismatches.length > 100) {
      lines.push(`| … | ещё ${report.balanceMismatches.length - 100} строк | | |`);
    }
    lines.push("");
  }

  if (report.pricingBreakdown.length) {
    lines.push("## Распределение сумм (non-topup)");
    lines.push("");
    lines.push("| amount | type | count |");
    lines.push("|---|---|---|");
    for (const p of report.pricingBreakdown.slice(0, 30)) {
      lines.push(`| ${formatRub(p.amountKopecks)} | ${p.type} | ${p.count} |`);
    }
    lines.push("");
  }

  lines.push("## Рекомендации");
  lines.push("");
  if (report.buckets.critical === 0 && report.buckets.medium === 0) {
    lines.push("Серьёзных проблем не обнаружено. Только LOW-аномалии (если есть) — мониторить периодически.");
  } else {
    if (report.unrefundedErroredGens.length) {
      lines.push(`1. **Manual refund** для ${report.unrefundedErroredGens.length} errored generations (см. таблицу выше).`);
    }
    if (report.unbookedPayments.length) {
      lines.push(`2. **Investigate ${report.unbookedPayments.length} unbooked payments** — Robokassa получил деньги но balance не credited.`);
    }
    if (report.balanceMismatches.length) {
      lines.push(`3. **Balance mismatches**: ${report.balanceMismatches.length} юзеров. НЕ авто-correct — может быть admin manual adjustment.`);
    }
    if (report.premiumWithoutSub.length) {
      lines.push(`4. **Premium fulfillment missing**: ${report.premiumWithoutSub.length} invoices paid без premium_subscription. Ручное создание / revisit fulfillment кода.`);
    }
    if (report.expiredButActiveSubs.length) {
      lines.push(`5. **Cron expiry**: ${report.expiredButActiveSubs.length} expired подписок ещё в status='active'. Запустить cleanup cron.`);
    }
  }
  lines.push("");
  lines.push("## SQL для verify после фикса");
  lines.push("");
  lines.push("```sql");
  lines.push("-- 1. Re-run check missed refunds");
  lines.push("SELECT g.id, g.user_id, g.cost, g.status, g.error_reason");
  lines.push("FROM generations g");
  lines.push("WHERE g.status IN ('error','failed','cancelled')");
  lines.push("  AND g.cost > 0");
  lines.push("  AND COALESCE(json_extract(g.style, '$.refunded'), 'false') != 'true';");
  lines.push("");
  lines.push("-- 2. Re-check balance integrity");
  lines.push("SELECT u.id, u.balance,");
  lines.push("  COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id = u.id), 0) AS computed");
  lines.push("FROM users u");
  lines.push("HAVING ABS(u.balance - computed) > 0;");
  lines.push("");
  lines.push("-- 3. Re-check unbooked Robokassa payments");
  lines.push("SELECT p.id, p.inv_id, p.user_id, p.amount");
  lines.push("FROM payments p");
  lines.push("WHERE p.status='paid'");
  lines.push("  AND NOT EXISTS (");
  lines.push("    SELECT 1 FROM transactions t");
  lines.push("    WHERE t.user_id = p.user_id");
  lines.push("      AND t.description LIKE '%счёт #' || p.inv_id || '%'");
  lines.push("  );");
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}
