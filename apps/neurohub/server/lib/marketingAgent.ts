// Eugene 2026-05-23 Босс «прокачай навыки агента оркестратора по маркетингу
// свяжи его со смежными агентами проработай все возможные взаимосвязи».
//
// Marketing-orchestrator agent — cross-channel campaigns, retargeting,
// content calendar, A/B testing, performance tracking, auto-triggers.
//
// Architecture:
//  - In-memory state (campaigns, segments, schedule) — lightweight, никакого
//    нового schema (по правилу subagent не трогает shared/schema.ts).
//  - Connects to channels через **существующие endpoints** (Reuse-working-
//    solutions rule): /api/admin/v304/news для landing, telegram-bot/sendMessage,
//    notifications plugin для email. Никаких параллельных pipelines.
//  - Listens на orchestrator events (emitOrchestratorEvent) — payment.succeeded,
//    generation.published, user.registered, etc.
//  - Audit-log через recordAuditEntry / user_action_failures для failed campaigns.
//  - Никаких PII utilities (Secrets-admin-only rule + Musa-knowledge-governance).
//
// НЕ занимается:
//  - Прямой отправкой сообщений (это делают существующие channels)
//  - Хранением реальных user emails / phone в campaign config (только userIds)
//  - Bypass auth (admin-only endpoints через requireAdmin)

import { orchestrator, recordAgentActivity } from "./agentOrchestrator";

// =============== ТИПЫ ===============

export type CampaignChannel = "email" | "telegram" | "vk" | "max" | "landing" | "web-chat";

export type CampaignStatus =
  | "draft"       // создана, не запущена
  | "scheduled"   // ждёт scheduledAt
  | "running"     // в процессе отправки
  | "completed"   // отправлена / закрыта
  | "paused"      // временно остановлена
  | "failed";     // upstream error

export type SegmentKind =
  | "all_users"
  | "registered_no_purchase"   // зарегистрировался, не купил
  | "purchased_once"           // 1 покупка
  | "purchased_repeat"         // 2+ покупок
  | "churned_30d"              // 30+ дней нет активности
  | "churned_14d"              // 14-29 дней
  | "premium_active"           // активная подписка
  | "premium_expired"          // была подписка, закончилась
  | "milestone_5_tracks"       // 5+ треков
  | "milestone_10_tracks";

export interface AbVariant {
  /** ID варианта внутри campaign (A / B / C). */
  key: string;
  /** Текст / template-key контента. */
  content: string;
  /** Доля аудитории (0..1). Сумма всех variants = 1. */
  share: number;
  /** Performance counters. */
  sent: number;
  opened: number;
  clicked: number;
  converted: number;
}

export interface Campaign {
  id: string;
  name: string;
  channels: CampaignChannel[];
  segment: SegmentKind;
  variants: AbVariant[];
  status: CampaignStatus;
  /** Когда создана. */
  createdAt: number;
  /** Когда запустить (если scheduled). */
  scheduledAt?: number;
  /** Когда запущена. */
  startedAt?: number;
  /** Когда завершена. */
  completedAt?: number;
  /** Trigger-event который запустил кампанию (для auto-campaigns). */
  triggerEvent?: string;
  /** Кто создал — admin email / "auto" / agent id. */
  createdBy: string;
  /** Total KPIs. */
  metrics: {
    targetSize: number;
    sent: number;
    opened: number;
    clicked: number;
    converted: number;
    revenue: number;
    /** Last update millis. */
    updatedAt: number;
  };
  /** Свободное поле для UTM tags, brand template, etc. */
  meta?: Record<string, unknown>;
}

export interface CampaignDraft {
  name: string;
  channels: CampaignChannel[];
  segment: SegmentKind;
  variants: Array<Pick<AbVariant, "key" | "content" | "share">>;
  scheduledAt?: number;
  createdBy?: string;
  meta?: Record<string, unknown>;
}

// =============== STATE (in-memory) ===============

const campaigns = new Map<string, Campaign>();

// Performance metrics — агрегаты по time-window.
interface PerformanceWindow {
  windowStart: number;
  channelMetrics: Record<CampaignChannel, {
    campaigns: number;
    sent: number;
    opened: number;
    clicked: number;
    converted: number;
    revenue: number;
  }>;
}

const performanceWindow: PerformanceWindow = {
  windowStart: Date.now(),
  channelMetrics: {
    email: emptyChannelMetric(),
    telegram: emptyChannelMetric(),
    vk: emptyChannelMetric(),
    max: emptyChannelMetric(),
    landing: emptyChannelMetric(),
    "web-chat": emptyChannelMetric(),
  },
};

function emptyChannelMetric() {
  return { campaigns: 0, sent: 0, opened: 0, clicked: 0, converted: 0, revenue: 0 };
}

// =============== CAMPAIGN CRUD ===============

function generateCampaignId(): string {
  return `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createCampaign(draft: CampaignDraft): Campaign {
  const id = generateCampaignId();
  // Normalize variant shares (если не дотягивают до 1 — нормализуем пропорционально).
  const totalShare = draft.variants.reduce((sum, v) => sum + (v.share || 0), 0);
  const normalizedVariants: AbVariant[] = draft.variants.map(v => ({
    key: v.key,
    content: v.content,
    share: totalShare > 0 ? (v.share || 0) / totalShare : 1 / draft.variants.length,
    sent: 0,
    opened: 0,
    clicked: 0,
    converted: 0,
  }));

  const campaign: Campaign = {
    id,
    name: draft.name,
    channels: draft.channels,
    segment: draft.segment,
    variants: normalizedVariants,
    status: draft.scheduledAt && draft.scheduledAt > Date.now() ? "scheduled" : "draft",
    createdAt: Date.now(),
    scheduledAt: draft.scheduledAt,
    createdBy: draft.createdBy || "manual",
    metrics: {
      targetSize: 0,
      sent: 0,
      opened: 0,
      clicked: 0,
      converted: 0,
      revenue: 0,
      updatedAt: Date.now(),
    },
    meta: draft.meta,
  };
  campaigns.set(id, campaign);
  recordAgentActivity("marketing-orchestrator", { action: "campaign.created", id, name: draft.name });
  return campaign;
}

export function getCampaign(id: string): Campaign | undefined {
  return campaigns.get(id);
}

export function listCampaigns(filter?: { status?: CampaignStatus; channel?: CampaignChannel }): Campaign[] {
  let items = Array.from(campaigns.values()).sort((a, b) => b.createdAt - a.createdAt);
  if (filter?.status) items = items.filter(c => c.status === filter.status);
  if (filter?.channel) items = items.filter(c => c.channels.includes(filter.channel!));
  return items;
}

export function updateCampaignStatus(id: string, status: CampaignStatus): boolean {
  const c = campaigns.get(id);
  if (!c) return false;
  c.status = status;
  if (status === "running" && !c.startedAt) c.startedAt = Date.now();
  if (status === "completed") c.completedAt = Date.now();
  return true;
}

export function recordCampaignMetric(
  id: string,
  variantKey: string,
  metric: "sent" | "opened" | "clicked" | "converted",
  delta = 1,
  revenue = 0,
): boolean {
  const c = campaigns.get(id);
  if (!c) return false;
  const v = c.variants.find(x => x.key === variantKey);
  if (!v) return false;
  v[metric] = (v[metric] || 0) + delta;
  c.metrics[metric] = (c.metrics[metric] || 0) + delta;
  if (revenue > 0) c.metrics.revenue = (c.metrics.revenue || 0) + revenue;
  c.metrics.updatedAt = Date.now();
  // Aggregate в performanceWindow по каналам.
  for (const ch of c.channels) {
    const m = performanceWindow.channelMetrics[ch];
    if (!m) continue;
    m[metric] = (m[metric] || 0) + delta;
    if (revenue > 0) m.revenue = (m.revenue || 0) + revenue;
  }
  return true;
}

// =============== A/B SPLIT ===============

/**
 * Выбор variant'а для конкретного userId — deterministic через hash, чтобы
 * один и тот же юзер всегда видел один и тот же variant внутри campaign.
 */
export function selectVariant(campaign: Campaign, userId: number): AbVariant {
  if (campaign.variants.length === 1) return campaign.variants[0];
  // Простой hash из userId + campaign.id для stable bucket.
  let h = 0;
  const str = `${campaign.id}::${userId}`;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  const bucket = Math.abs(h % 10000) / 10000;
  let acc = 0;
  for (const v of campaign.variants) {
    acc += v.share;
    if (bucket < acc) return v;
  }
  return campaign.variants[campaign.variants.length - 1];
}

// =============== SEGMENTATION ===============

/**
 * Описание сегмента. Реальный resolve (получение userIds) выполняется в
 * routes.ts через storage / SQL — здесь только метаданные сегмента, чтобы
 * marketingAgent.ts не зависел от storage. См. Reuse-working-solutions rule:
 * routes.ts уже умеет SQL-фильтры по users / transactions / generations.
 */
export interface SegmentDescriptor {
  kind: SegmentKind;
  label: string;
  description: string;
  /** Hint для SQL builder — какие таблицы/условия. */
  sqlHint: string;
}

export const SEGMENT_REGISTRY: Record<SegmentKind, SegmentDescriptor> = {
  all_users: {
    kind: "all_users",
    label: "Все юзеры",
    description: "Все зарегистрированные пользователи",
    sqlHint: "SELECT id FROM users WHERE blocked = 0",
  },
  registered_no_purchase: {
    kind: "registered_no_purchase",
    label: "Зарегистрировались, не купили",
    description: "Юзеры без единой успешной оплаты",
    sqlHint: "users LEFT JOIN payments status=paid WHERE payment IS NULL",
  },
  purchased_once: {
    kind: "purchased_once",
    label: "Купили 1 раз",
    description: "1 успешная оплата",
    sqlHint: "users JOIN payments status=paid GROUP BY user_id HAVING count = 1",
  },
  purchased_repeat: {
    kind: "purchased_repeat",
    label: "Купили 2+",
    description: "2 или более успешных оплат — лояльные клиенты",
    sqlHint: "users JOIN payments status=paid GROUP BY user_id HAVING count >= 2",
  },
  churned_30d: {
    kind: "churned_30d",
    label: "Не активны 30+ дней",
    description: "Без активности (chat / play / gen) более 30 дней",
    sqlHint: "users WHERE last_activity_at < now-30d",
  },
  churned_14d: {
    kind: "churned_14d",
    label: "Не активны 14-29 дней",
    description: "Без активности 14-29 дней — ранний сигнал churn",
    sqlHint: "users WHERE last_activity_at BETWEEN now-29d AND now-14d",
  },
  premium_active: {
    kind: "premium_active",
    label: "Активная подписка",
    description: "Premium subscription status=active",
    sqlHint: "premium_subscriptions WHERE status=active AND expires_at > now",
  },
  premium_expired: {
    kind: "premium_expired",
    label: "Подписка истекла",
    description: "Была подписка, истекла менее 7 дней назад",
    sqlHint: "premium_subscriptions WHERE status=expired AND expired_at > now-7d",
  },
  milestone_5_tracks: {
    kind: "milestone_5_tracks",
    label: "5+ треков создано",
    description: "Юзеры с 5+ успешными генерациями",
    sqlHint: "generations status=done GROUP BY user_id HAVING count >= 5",
  },
  milestone_10_tracks: {
    kind: "milestone_10_tracks",
    label: "10+ треков создано",
    description: "Power-users с 10+ успешными генерациями",
    sqlHint: "generations status=done GROUP BY user_id HAVING count >= 10",
  },
};

export function listSegments(): SegmentDescriptor[] {
  return Object.values(SEGMENT_REGISTRY);
}

// =============== CONTENT CALENDAR ===============

export interface CalendarEntry {
  id: string;
  campaignId?: string;        // ссылка на существующую campaign (если запланирована)
  scheduledFor: number;       // когда отправить (millis)
  channel: CampaignChannel;
  contentTemplate: string;    // template-key или raw text
  status: "scheduled" | "sent" | "cancelled";
  createdAt: number;
  createdBy: string;
}

const calendar = new Map<string, CalendarEntry>();

export function scheduleEntry(entry: Omit<CalendarEntry, "id" | "createdAt" | "status">): CalendarEntry {
  const id = `cal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const ce: CalendarEntry = { ...entry, id, status: "scheduled", createdAt: Date.now() };
  calendar.set(id, ce);
  recordAgentActivity("marketing-orchestrator", { action: "calendar.scheduled", id, channel: entry.channel });
  return ce;
}

export function listCalendar(filter?: { from?: number; to?: number; status?: CalendarEntry["status"] }): CalendarEntry[] {
  let items = Array.from(calendar.values()).sort((a, b) => a.scheduledFor - b.scheduledFor);
  if (filter?.from) items = items.filter(e => e.scheduledFor >= filter.from!);
  if (filter?.to) items = items.filter(e => e.scheduledFor <= filter.to!);
  if (filter?.status) items = items.filter(e => e.status === filter.status);
  return items;
}

export function cancelCalendarEntry(id: string): boolean {
  const e = calendar.get(id);
  if (!e) return false;
  e.status = "cancelled";
  return true;
}

// =============== PERFORMANCE METRICS ===============

export function getPerformanceMetrics(): {
  windowStart: number;
  windowEnd: number;
  byChannel: PerformanceWindow["channelMetrics"];
  totals: {
    campaigns: number;
    sent: number;
    opened: number;
    clicked: number;
    converted: number;
    revenue: number;
    openRate: number;
    clickRate: number;
    conversionRate: number;
  };
} {
  const totals = {
    campaigns: 0, sent: 0, opened: 0, clicked: 0, converted: 0, revenue: 0,
    openRate: 0, clickRate: 0, conversionRate: 0,
  };
  for (const m of Object.values(performanceWindow.channelMetrics)) {
    totals.campaigns += m.campaigns;
    totals.sent += m.sent;
    totals.opened += m.opened;
    totals.clicked += m.clicked;
    totals.converted += m.converted;
    totals.revenue += m.revenue;
  }
  totals.openRate = totals.sent > 0 ? totals.opened / totals.sent : 0;
  totals.clickRate = totals.opened > 0 ? totals.clicked / totals.opened : 0;
  totals.conversionRate = totals.sent > 0 ? totals.converted / totals.sent : 0;
  return {
    windowStart: performanceWindow.windowStart,
    windowEnd: Date.now(),
    byChannel: performanceWindow.channelMetrics,
    totals,
  };
}

// =============== CHANNEL ALLOCATION (CAC/LTV-based) ===============

/**
 * Предложение распределения рекламного бюджета между channels на основе
 * CAC (Customer Acquisition Cost) и LTV (Lifetime Value).
 *
 * Реальный расчёт CAC = ad_spend / new_customers (нужны ads spend logs).
 * Пока — heuristic based на channel-metrics из performanceWindow.
 */
export function suggestChannelAllocation(totalBudget: number): Array<{
  channel: CampaignChannel;
  share: number;
  amount: number;
  rationale: string;
}> {
  const metrics = performanceWindow.channelMetrics;
  // Score = revenue / (sent || 1) — приближённый ROI per impression.
  const scores: Array<{ channel: CampaignChannel; score: number; rev: number }> = [];
  for (const [ch, m] of Object.entries(metrics) as Array<[CampaignChannel, typeof metrics[CampaignChannel]]>) {
    const score = m.sent > 0 ? m.revenue / m.sent : 0;
    scores.push({ channel: ch, score, rev: m.revenue });
  }
  const totalScore = scores.reduce((s, x) => s + x.score, 0);
  if (totalScore === 0) {
    // Нет данных — равное распределение по 4 каналам с low-cost (email/TG/VK/landing).
    const fallback: CampaignChannel[] = ["email", "telegram", "vk", "landing"];
    return fallback.map(ch => ({
      channel: ch,
      share: 0.25,
      amount: Math.round(totalBudget * 0.25),
      rationale: "Нет данных по ROI — равное распределение по low-cost channels",
    }));
  }
  return scores
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => ({
      channel: s.channel,
      share: s.score / totalScore,
      amount: Math.round(totalBudget * (s.score / totalScore)),
      rationale: `ROI per impression: ${s.score.toFixed(4)}, revenue: ${s.rev}`,
    }));
}

// =============== AUTO-TRIGGER HANDLERS ===============

/**
 * Listener на orchestrator events. Создаёт auto-campaigns по триггерам.
 *
 * Не отправляет сообщения сама — создаёт draft campaign со статусом
 * "scheduled" + scheduledAt. Admin может posmotret в UI, отменить, или дать
 * cron поднять и реально dispatch'нуть в channels через существующие endpoints.
 */
export function installEventHandlers(): void {
  // ---- payment.succeeded → thank-you email + social-proof post ----
  orchestrator.on("payment.succeeded", (payload: any) => {
    try {
      const userId = payload?.userId;
      const amount = payload?.amount || 0;
      if (!userId) return;
      createCampaign({
        name: `Thank-you #${userId} (${amount}₽)`,
        channels: ["email", "web-chat"],
        segment: "purchased_once",
        variants: [
          { key: "A", content: "thank-you-warm-v1", share: 0.5 },
          { key: "B", content: "thank-you-witty-v1", share: 0.5 },
        ],
        scheduledAt: Date.now() + 30 * 60 * 1000, // через 30 мин (cooldown)
        createdBy: "auto:payment.succeeded",
        meta: { triggerUserId: userId, triggerAmount: amount },
      });
      recordAgentActivity("marketing-orchestrator", { event: "payment.succeeded", userId });
    } catch (e) {
      console.warn("[marketing] payment.succeeded handler failed:", (e as Error)?.message);
    }
  });

  // ---- generation.published → broadcast в VK / TG + social proof ----
  orchestrator.on("generation.published", (payload: any) => {
    try {
      const genId = payload?.genId;
      const userId = payload?.userId;
      if (!genId) return;
      createCampaign({
        name: `Broadcast track #${genId}`,
        channels: ["vk", "telegram"],
        segment: "all_users",
        variants: [
          { key: "A", content: "broadcast-new-track-v1", share: 1.0 },
        ],
        scheduledAt: Date.now() + 15 * 60 * 1000,
        createdBy: "auto:generation.published",
        meta: { genId, userId },
      });
    } catch (e) {
      console.warn("[marketing] generation.published handler failed:", (e as Error)?.message);
    }
  });

  // ---- user.churned → re-engagement campaign ----
  orchestrator.on("user.churned", (payload: any) => {
    try {
      const userId = payload?.userId;
      const days = payload?.daysInactive || 30;
      if (!userId) return;
      createCampaign({
        name: `Re-engagement #${userId} (${days}d)`,
        channels: days >= 30 ? ["email", "telegram"] : ["email"],
        segment: days >= 30 ? "churned_30d" : "churned_14d",
        variants: [
          { key: "A", content: "reengagement-promo-v1", share: 0.5 },
          { key: "B", content: "reengagement-question-v1", share: 0.5 },
        ],
        scheduledAt: Date.now() + 60 * 60 * 1000,
        createdBy: "auto:user.churned",
        meta: { userId, daysInactive: days },
      });
    } catch (e) {
      console.warn("[marketing] user.churned handler failed:", (e as Error)?.message);
    }
  });

  // ---- generation.milestone → gratitude + promo код ----
  orchestrator.on("generation.milestone", (payload: any) => {
    try {
      const userId = payload?.userId;
      const count = payload?.count;
      if (!userId || !count) return;
      // Только на ключевые milestones — 5, 10, 25, 50, 100
      if (![5, 10, 25, 50, 100].includes(count)) return;
      createCampaign({
        name: `Milestone ${count} #${userId}`,
        channels: ["email", "web-chat"],
        segment: count >= 10 ? "milestone_10_tracks" : "milestone_5_tracks",
        variants: [
          { key: "A", content: `milestone-${count}-v1`, share: 1.0 },
        ],
        scheduledAt: Date.now() + 5 * 60 * 1000, // 5 мин — пока эмоция свежая
        createdBy: "auto:generation.milestone",
        meta: { userId, count },
      });
    } catch (e) {
      console.warn("[marketing] generation.milestone handler failed:", (e as Error)?.message);
    }
  });

  // ---- subscription.expired → renewal reminder ----
  orchestrator.on("subscription.expired", (payload: any) => {
    try {
      const userId = payload?.userId;
      const tier = payload?.tier;
      if (!userId || !tier) return;
      createCampaign({
        name: `Renewal reminder #${userId} (${tier})`,
        channels: ["email", "telegram"],
        segment: "premium_expired",
        variants: [
          { key: "A", content: "renewal-soft-v1", share: 0.5 },
          { key: "B", content: "renewal-discount-v1", share: 0.5 },
        ],
        scheduledAt: Date.now() + 24 * 60 * 60 * 1000, // следующий день
        createdBy: "auto:subscription.expired",
        meta: { userId, tier },
      });
    } catch (e) {
      console.warn("[marketing] subscription.expired handler failed:", (e as Error)?.message);
    }
  });

  // ---- referral.bonus.given → social proof (без PII) ----
  orchestrator.on("referral.bonus.given", (payload: any) => {
    try {
      const refereeId = payload?.refereeId;
      if (!refereeId) return;
      createCampaign({
        name: `Social proof referral`,
        channels: ["vk", "telegram", "landing"],
        segment: "all_users",
        variants: [
          { key: "A", content: "social-proof-referral-v1", share: 1.0 },
        ],
        scheduledAt: Date.now() + 2 * 60 * 60 * 1000,
        createdBy: "auto:referral.bonus.given",
        meta: { /* НЕ кладём refereeId — social proof без PII */ },
      });
    } catch (e) {
      console.warn("[marketing] referral.bonus.given handler failed:", (e as Error)?.message);
    }
  });

  console.log("[marketing] event handlers installed");
}

// =============== STATS FOR ADMIN UI ===============

export function getMarketingStats(): {
  campaigns: { total: number; byStatus: Record<CampaignStatus, number> };
  calendar: { scheduledCount: number; nextScheduledAt: number | null };
  performance: ReturnType<typeof getPerformanceMetrics>;
} {
  const all = Array.from(campaigns.values());
  const byStatus: Record<CampaignStatus, number> = {
    draft: 0, scheduled: 0, running: 0, completed: 0, paused: 0, failed: 0,
  };
  for (const c of all) byStatus[c.status]++;

  const upcoming = Array.from(calendar.values())
    .filter(e => e.status === "scheduled" && e.scheduledFor > Date.now())
    .sort((a, b) => a.scheduledFor - b.scheduledFor);

  return {
    campaigns: { total: all.length, byStatus },
    calendar: {
      scheduledCount: upcoming.length,
      nextScheduledAt: upcoming.length > 0 ? upcoming[0].scheduledFor : null,
    },
    performance: getPerformanceMetrics(),
  };
}
