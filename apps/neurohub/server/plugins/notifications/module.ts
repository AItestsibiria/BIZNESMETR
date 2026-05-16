// Notifications plugin (Sprint 4 backlog).
//
// 1. Принимает 'send-welcome_*' / 'send-churn_back' / любые scheduled
//    agent_actions со status='pending' AND scheduled_for <= now AND
//    action_kind LIKE 'send-%'.
// 2. Минутный cron: выбирает до 50 готовых, отрабатывает шаблоны, шлёт
//    через SMTP (если есть SMTP_HOST/USER/PASS в .env), помечает как
//    executed/failed, записывает в notifications таблицу (если она
//    есть — пока v304 schema её ожидает, но мы её не создали; данные
//    идут в agent_actions.result).
//
// Без SMTP_HOST в env — плагин активен, но просто пропускает (skipped).
// Когда придут SMTP-ключи, отправка заработает без правки кода.
//
// Spec: docs/strategy/original/04 §5 (email hub), 03 §3.3.

import { sql, and, eq, lte } from "drizzle-orm";
import { db } from "../../storage";
import { agentActions } from "@shared/schema";
import type { BootContext, Module } from "../../core";

interface SendPayload {
  email?: string;
  template?: string;
  vars?: Record<string, unknown>;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT) || 465,
    user,
    pass,
    from: process.env.SMTP_FROM || `Муза MuzaAi <${user}>`,
  };
}

const TEMPLATES: Record<string, { subject: string; body: (vars: any) => string }> = {
  welcome_1: {
    subject: "Привет! Я — Муза",
    body: (vars) =>
      `Привет!\nЯ Муза — буду помогать с песнями. Первый трек у нас в подарок, можете попробовать в любой момент.\n\n— Муза · MuzaAi\nhttps://muzaai.ru/`,
  },
  welcome_2: {
    subject: "Готовые волшебные сценарии — выбирайте",
    body: () =>
      `Если не знаете с чего начать — у нас есть готовые сценарии («Свадьба», «Юбилей», «Гимн компании» и др.). Каждый — настроенный сюжет под событие.\n\n— Муза · MuzaAi\nhttps://muzaai.ru/#/templates`,
  },
  welcome_3: {
    subject: "Создайте первую песню сегодня",
    body: () =>
      `Вы ещё не создали свой первый трек — он у вас в подарок.\nЗаходите, попробуем вместе.\n\n— Муза · MuzaAi\nhttps://muzaai.ru/`,
  },
  churn_back: {
    subject: "Скучаю — давно не виделись",
    body: (vars) =>
      `Прошло уже больше месяца с вашей последней песни. У нас тут много чего нового — рассказать?\n\n— Муза · MuzaAi\nhttps://muzaai.ru/`,
  },
};

async function processBatch(): Promise<void> {
  if (!bootRefs) return;
  const cfg = readSmtpConfig();
  const now = new Date().toISOString();

  const rows = db
    .select()
    .from(agentActions)
    .where(
      and(
        eq(agentActions.status, "pending"),
        sql`${agentActions.actionKind} LIKE 'send-%'`,
        lte(agentActions.scheduledFor, now),
      ),
    )
    .limit(50)
    .all();

  if (rows.length === 0) return;

  if (!cfg) {
    bootRefs.logger.info("notifications: no SMTP config, skipping batch", {
      pending: rows.length,
    });
    return;
  }

  // Lazy import nodemailer чтобы не тащить его в bundle если не нужен.
  let nodemailer: any;
  try {
    nodemailer = (await import("nodemailer")).default;
  } catch (err) {
    bootRefs.logger.error("nodemailer not installed; cannot send", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  for (const row of rows) {
    let payload: SendPayload | null = null;
    try {
      payload = JSON.parse(row.actionPayload ?? "{}");
    } catch {}

    const tpl = payload?.template ? TEMPLATES[payload.template] : null;
    if (!payload?.email || !tpl) {
      db.update(agentActions)
        .set({
          status: "failed",
          error: "no email or unknown template",
          executedAt: new Date().toISOString(),
        })
        .where(eq(agentActions.id, row.id))
        .run();
      continue;
    }

    try {
      await transporter.sendMail({
        from: cfg.from,
        to: payload.email,
        subject: tpl.subject,
        text: tpl.body(payload.vars ?? {}),
      });
      db.update(agentActions)
        .set({
          status: "executed",
          executedAt: new Date().toISOString(),
          result: JSON.stringify({ sent: true }),
        })
        .where(eq(agentActions.id, row.id))
        .run();
      bootRefs.logger.info("notification sent", {
        actionId: row.id,
        template: payload.template,
        to: payload.email,
      });
    } catch (err) {
      db.update(agentActions)
        .set({
          status: "failed",
          executedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        })
        .where(eq(agentActions.id, row.id))
        .run();
    }
  }
}

const notificationsModule: Module = {
  name: "notifications",
  version: "0.1.0",
  description: "Sends scheduled email notifications. SMTP-based; no-op without env config.",
  publishes: [],
  jobs: [
    {
      name: "notifications-batch",
      schedule: "every_minute",
      handler: () => processBatch(),
    },
  ],
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    const cfg = readSmtpConfig();
    ctx.logger.info("notifications online", { smtp: cfg ? "configured" : "missing" });
  },
  healthCheck: () => {
    const cfg = readSmtpConfig();
    return { status: cfg ? "ok" : "degraded", details: { smtp_configured: !!cfg } };
  },
};

export default notificationsModule;
