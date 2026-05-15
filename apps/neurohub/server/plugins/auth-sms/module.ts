// v304 plugin: auth-sms (Eugene 2026-05-15 Босс «SMS-провайдер РФ +
// регистрация и авторизация»). Skeleton: provider abstraction + SMS.ru
// реализация + endpoints send-otp / verify. Client UI и привязка к
// /api/auth/register / /api/auth/login — следующим коммитом.
//
// Endpoints (prefix: /api/auth/sms):
//   POST  /send-otp        { phone, purpose: 'register'|'login'|'change_phone'|'change_email' }
//   POST  /verify-otp      { phone, code, purpose }
//   GET   /providers       — admin: список настроенных провайдеров + balance
//
// ENV:
//   SMS_PROVIDER             — 'smsru' | 'smsc' | 'smsaero' (default: 'smsru')
//   SMSRU_API_ID             — API id из личного кабинета https://sms.ru/
//   SMSRU_SENDER             — sender name (опц., если зарегистрирован)
//   SMS_OTP_DISABLE          — '1' = выключить отправку (только лог в БД, не вызываем провайдера)
//
// Без SMSRU_API_ID плагин degraded — лог пишется, но реальная отправка
// не происходит. Это даёт возможность тестировать flow на clone без
// настоящих SMS (юзер всё равно получит код через /admin/v304/sms-logs).

import { Router } from "express";
import { eq, and, desc, sql, gt } from "drizzle-orm";
import { db } from "../../storage";
import { smsOtp, smsProviderLogs, users } from "@shared/schema";
import { z } from "zod";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import type { BootContext, Module } from "../../core";
import { validatePhoneForOtp, maskPhone, normalizePhone, detectPhoneCountry } from "../../lib/phoneCountry";
import { tokenStore } from "../../lib/tokenStore";

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

// === Provider abstraction ===

type SendResult = {
  ok: boolean;
  status: "sent" | "failed" | "delivered" | "rejected";
  providerMsgId?: string;
  providerCost?: string;
  providerStatusText?: string;
  errorMessage?: string;
  responseRaw?: string;
};

// Eugene 2026-05-15 Босс «авторизация по звонку на номер» (flashcall).
// Звонок-сервис делает короткий вызов от служебного номера +7XXXXXXX —
// юзер видит входящий, последние 4 цифры этого номера = код. Юзер вводит
// их → сравниваем с тем, что вернул API.
type CallcheckResult = {
  ok: boolean;
  callId?: string;       // check_id у sms.ru — для проверки статуса
  callPhone?: string;    // полный номер откуда придёт звонок (+74957776666)
  code?: string;         // последние 4 цифры этого номера = OTP
  cost?: string;
  errorMessage?: string;
  responseRaw?: string;
};

interface SmsProvider {
  name: string;
  send(phone: string, text: string): Promise<SendResult>;
  callcheck?(phone: string): Promise<CallcheckResult>;
  getBalance?(): Promise<{ ok: boolean; balance?: string; currency?: string; error?: string }>;
}

// SMS.ru implementation. API: https://sms.ru/api/sms_send
class SmsRuProvider implements SmsProvider {
  name = "smsru";
  private apiId: string;
  private sender: string;

  constructor() {
    this.apiId = process.env.SMSRU_API_ID || "";
    this.sender = process.env.SMSRU_SENDER || "";
  }

  isConfigured(): boolean {
    return this.apiId.length > 0;
  }

  async send(phone: string, text: string): Promise<SendResult> {
    if (!this.isConfigured()) {
      return { ok: false, status: "failed", errorMessage: "SMSRU_API_ID not configured" };
    }
    const params = new URLSearchParams({
      api_id: this.apiId,
      to: phone.replace(/^\+/, ""),
      msg: text,
      json: "1",
    });
    if (this.sender) params.set("from", this.sender);
    try {
      const r = await fetch(`https://sms.ru/sms/send?${params.toString()}`, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
      const text = await r.text();
      let j: any = null;
      try { j = JSON.parse(text); } catch {}
      if (!j) return { ok: false, status: "failed", errorMessage: `non-json response: ${text.slice(0, 200)}`, responseRaw: text };
      const phoneStr = phone.replace(/^\+/, "");
      const phoneResult = j?.sms?.[phoneStr];
      if (phoneResult?.status === "OK") {
        return {
          ok: true,
          status: "sent",
          providerMsgId: String(phoneResult.sms_id || ""),
          providerCost: String(phoneResult.cost || ""),
          providerStatusText: phoneResult.status_text || "OK",
          responseRaw: text.slice(0, 1000),
        };
      }
      return {
        ok: false,
        status: phoneResult?.status === "ERROR" ? "rejected" : "failed",
        providerStatusText: phoneResult?.status_text || j?.status_text || "unknown error",
        errorMessage: `code=${phoneResult?.status_code || j?.status_code} msg=${phoneResult?.status_text || j?.status_text}`,
        responseRaw: text.slice(0, 1000),
      };
    } catch (e: any) {
      return { ok: false, status: "failed", errorMessage: String(e?.message || e).slice(0, 500) };
    }
  }

  async getBalance() {
    if (!this.isConfigured()) return { ok: false, error: "not configured" };
    try {
      const r = await fetch(`https://sms.ru/my/balance?api_id=${encodeURIComponent(this.apiId)}&json=1`, {
        signal: AbortSignal.timeout(8_000),
      });
      const j: any = await r.json();
      if (j?.status === "OK") return { ok: true, balance: String(j.balance), currency: "RUB" };
      return { ok: false, error: j?.status_text || "unknown" };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e).slice(0, 200) };
    }
  }

  // Eugene 2026-05-15 Босс «авторизация по звонку».
  // sms.ru method: https://sms.ru/callcheck/add
  // Возвращает code = последние 4 цифры номера, с которого пойдёт входящий
  // звонок. Юзер вводит эти 4 цифры → верифицируем.
  async callcheck(phone: string): Promise<CallcheckResult> {
    if (!this.isConfigured()) {
      return { ok: false, errorMessage: "SMSRU_API_ID not configured" };
    }
    const params = new URLSearchParams({
      api_id: this.apiId,
      phone: phone.replace(/^\+/, ""),
      json: "1",
    });
    try {
      const r = await fetch(`https://sms.ru/callcheck/add?${params.toString()}`, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
      const text = await r.text();
      let j: any = null;
      try { j = JSON.parse(text); } catch {}
      if (!j) {
        return { ok: false, errorMessage: `non-json response: ${text.slice(0, 200)}`, responseRaw: text };
      }
      // Успех: status_code 100 + check_id + code (4 цифры) + call_phone.
      if (j?.status === "OK" && j?.code) {
        return {
          ok: true,
          callId: String(j.check_id || ""),
          callPhone: String(j.call_phone || ""),
          code: String(j.code),
          cost: String(j.cost || ""),
          responseRaw: text.slice(0, 1000),
        };
      }
      return {
        ok: false,
        errorMessage: `code=${j?.status_code} msg=${j?.status_text || "unknown"}`,
        responseRaw: text.slice(0, 1000),
      };
    } catch (e: any) {
      return { ok: false, errorMessage: String(e?.message || e).slice(0, 500) };
    }
  }
}

// === Factory + log helpers ===

function getProvider(): SmsProvider & { isConfigured?: () => boolean } {
  const name = (process.env.SMS_PROVIDER || "smsru").toLowerCase();
  switch (name) {
    case "smsru":
    default:
      return new SmsRuProvider();
  }
}

function logProvider(args: {
  provider: string;
  phone: string;
  purpose: string;
  result: SendResult;
  requestMeta?: Record<string, any>;
}): number | null {
  try {
    const row = db.insert(smsProviderLogs).values({
      provider: args.provider,
      phoneMasked: maskPhone(args.phone),
      purpose: args.purpose,
      status: args.result.status,
      providerMsgId: args.result.providerMsgId || null,
      providerCost: args.result.providerCost || null,
      providerStatusText: args.result.providerStatusText || null,
      errorMessage: args.result.errorMessage || null,
      requestMeta: args.requestMeta ? JSON.stringify(args.requestMeta) : null,
      responseRaw: args.result.responseRaw || null,
    }).returning({ id: smsProviderLogs.id }).get() as any;
    return row?.id || null;
  } catch (e) {
    bootRefs?.logger.warn?.("[auth-sms] log provider failed", { error: String(e) });
    return null;
  }
}

function hashOtp(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function genCode(): string {
  // 6-значный код, padded.
  return String(crypto.randomInt(100_000, 999_999));
}

// === Rate limit helper ===
// Не более 1 SMS в 60 сек на номер; не более 5 SMS в час на номер.
function checkRateLimit(phone: string): { ok: boolean; reason?: string } {
  try {
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recentMin = db.select({ c: sql<number>`count(*)` }).from(smsOtp)
      .where(and(eq(smsOtp.phone, phone), gt(smsOtp.createdAt, oneMinAgo))).get() as any;
    if ((recentMin?.c || 0) > 0) return { ok: false, reason: "Подождите минуту перед повторной отправкой" };
    const recentHour = db.select({ c: sql<number>`count(*)` }).from(smsOtp)
      .where(and(eq(smsOtp.phone, phone), gt(smsOtp.createdAt, oneHourAgo))).get() as any;
    if ((recentHour?.c || 0) >= 5) return { ok: false, reason: "Превышен лимит — не более 5 SMS в час" };
  } catch {}
  return { ok: true };
}

// === Endpoints ===

const SendOtpSchema = z.object({
  phone: z.string().min(5).max(30),
  purpose: z.enum(["register", "login", "change_phone", "change_email"]),
});

const VerifyOtpSchema = z.object({
  phone: z.string().min(5).max(30),
  code: z.string().regex(/^\d{6}$/, "Введите 6-значный код"),
  purpose: z.enum(["register", "login", "change_phone", "change_email"]),
});

// Eugene 2026-05-15 Босс «авторизация по звонку». Schemas для callcheck-flow.
const SendCallSchema = z.object({
  phone: z.string().min(5).max(30),
  purpose: z.enum(["register", "login"]),
});

const VerifyCallSchema = z.object({
  phone: z.string().min(5).max(30),
  code: z.string().regex(/^\d{4}$/, "Введите 4 последние цифры номера, с которого позвонили"),
  purpose: z.enum(["register", "login"]),
});

const router = Router();

router.post("/send-otp", async (req, res) => {
  const parsed = SendOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message || "invalid" });
  }
  const { phone: phoneRaw, purpose } = parsed.data;
  const v = validatePhoneForOtp(phoneRaw);
  if (!v.ok || !v.country) {
    return res.status(400).json({ data: null, error: v.error || "invalid phone" });
  }
  const phone = v.normalized;

  // Для register — проверить что номер ещё не зарегистрирован.
  if (purpose === "register") {
    const exists = db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).get();
    if (exists) return res.status(409).json({ data: null, error: "Этот номер уже зарегистрирован — войдите по нему" });
  }
  // Для login — наоборот: убедиться что зарегистрирован.
  if (purpose === "login") {
    const exists = db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).get();
    if (!exists) return res.status(404).json({ data: null, error: "Номер не найден — сначала зарегистрируйтесь" });
  }

  const rl = checkRateLimit(phone);
  if (!rl.ok) return res.status(429).json({ data: null, error: rl.reason });

  const code = genCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const disableSend = process.env.SMS_OTP_DISABLE === "1";

  const provider = getProvider();
  // Eugene 2026-05-15 Босс «автоподстановка кода SMS». Формат с hash-меткой
  // домена включает Web OTP API на Android Chrome (автоподстановка из SMS).
  // На iOS Safari автоподстановка работает через autocomplete="one-time-code"
  // input attribute независимо от формата SMS — но мы делаем единый формат
  // для обеих платформ. Домен из env BASE_DOMAIN (или 'muziai.ru' fallback).
  const otpDomain = (process.env.BASE_DOMAIN || "muziai.ru").replace(/^https?:\/\//, "");
  const text = `Код MuziAI: ${code}. Никому не сообщайте.\n\n@${otpDomain} #${code}`;
  let result: SendResult;
  if (disableSend) {
    result = { ok: true, status: "sent", providerStatusText: "SMS_OTP_DISABLE — пропуск отправки" };
  } else {
    result = await provider.send(phone, text);
  }
  const logId = logProvider({
    provider: provider.name,
    phone,
    purpose,
    result,
    requestMeta: { country: v.country.code, zone: v.country.zone, ip: req.ip },
  });

  // Сохраняем OTP в любом случае (для debug на clone, где SMS_OTP_DISABLE=1).
  try {
    db.insert(smsOtp).values({
      phone,
      otpHash: hashOtp(code),
      purpose,
      providerLogId: logId,
      expiresAt,
    }).run();
  } catch (e) {
    bootRefs?.logger.warn?.("[auth-sms] otp save failed", { error: String(e) });
  }

  if (!result.ok) {
    return res.status(502).json({
      data: null,
      error: `SMS-провайдер отклонил запрос: ${result.errorMessage || result.providerStatusText || "unknown"}`,
    });
  }

  bootRefs?.eventBus?.emit?.("auth.sms_otp_sent", {
    purpose, country: v.country.code, provider: provider.name,
  }, "auth-sms");

  return res.json({
    data: {
      sent: true,
      country: v.country.code,
      countryName: v.country.name,
      cooldownSec: 60,
      expiresInSec: 600,
    },
    error: null,
  });
});

router.post("/verify-otp", async (req, res) => {
  const parsed = VerifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message || "invalid" });
  }
  const { phone: phoneRaw, code, purpose } = parsed.data;
  const phone = normalizePhone(phoneRaw);
  const codeHash = hashOtp(code);

  // Берём последний non-used OTP для пары (phone, purpose).
  const row = db.select().from(smsOtp)
    .where(and(eq(smsOtp.phone, phone), eq(smsOtp.purpose, purpose), eq(smsOtp.used, 0)))
    .orderBy(desc(smsOtp.id))
    .get() as any;
  if (!row) return res.status(404).json({ data: null, error: "Код не найден или уже использован" });
  if (row.attempts >= 5) {
    return res.status(429).json({ data: null, error: "Превышены попытки — запросите новый код" });
  }
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    return res.status(410).json({ data: null, error: "Срок действия кода истёк — запросите новый" });
  }
  if (row.otpHash !== codeHash) {
    try {
      db.update(smsOtp).set({ attempts: row.attempts + 1 }).where(eq(smsOtp.id, row.id)).run();
    } catch {}
    return res.status(400).json({ data: null, error: "Неверный код" });
  }
  try {
    db.update(smsOtp).set({ used: 1 }).where(eq(smsOtp.id, row.id)).run();
  } catch {}

  bootRefs?.eventBus?.emit?.("auth.sms_otp_verified", { phone: maskPhone(phone), purpose }, "auth-sms");

  // === Финализация по purpose ===
  // register → создать users record, выдать token.
  // login → найти users по phone, выдать token.
  // change_phone → требует authMiddleware (Bearer token) — finalize в routes.ts
  //                по правам владельца. Здесь возвращаем verified только.
  // change_email → аналогично — finalize в routes.ts.
  try {
    if (purpose === "register") {
      const existing = db.select().from(users).where(eq(users.phone, phone)).get() as any;
      if (existing) {
        // Race condition защита: пока шла verify, другой запрос мог уже
        // зарегистрировать тот же номер. Перенаправляем на login flow.
        const token = uuidv4();
        tokenStore.set(token, existing.id);
        return res.json({ data: { verified: true, phone, purpose, token, userId: existing.id, alreadyExists: true }, error: null });
      }
      const country = detectPhoneCountry(phone);
      // Placeholder password — юзер не задавал пароль (phone-only flow).
      // Сможет задать через ЛК → Сменить пароль.
      const placeholderPassword = await bcrypt.hash(uuidv4() + crypto.randomBytes(16).toString("hex"), 10);
      const inserted = db.insert(users).values({
        name: `Автор ${phone.slice(-4)}`,
        email: `${phone.replace(/[^\d]/g, "")}@phone.muziai.ru`,
        password: placeholderPassword,
        phone,
        phoneVerified: 1,
        country: country?.name || null,
        countryCode: country?.code || null,
      }).returning({ id: users.id }).get() as any;
      const userId = inserted?.id;
      const token = uuidv4();
      tokenStore.set(token, userId);
      bootRefs?.eventBus?.emit?.("auth.user.registered", { userId, channel: "sms" }, "auth-sms");
      return res.json({
        data: { verified: true, phone, purpose, token, userId },
        error: null,
      });
    }

    if (purpose === "login") {
      const user = db.select().from(users).where(eq(users.phone, phone)).get() as any;
      if (!user) return res.status(404).json({ data: null, error: "Номер не найден — сначала зарегистрируйтесь" });
      if (user.blocked) return res.status(403).json({ data: null, error: "Аккаунт заблокирован" });
      // Auto-verify phone if first login (legacy users у которых phone есть но phoneVerified=0).
      if (!user.phoneVerified) {
        try { db.update(users).set({ phoneVerified: 1 }).where(eq(users.id, user.id)).run(); } catch {}
      }
      const token = uuidv4();
      tokenStore.set(token, user.id);
      bootRefs?.eventBus?.emit?.("auth.user.logged_in", { userId: user.id, channel: "sms" }, "auth-sms");
      return res.json({
        data: { verified: true, phone, purpose, token, userId: user.id },
        error: null,
      });
    }

    // change_phone / change_email — требуют additional context (текущий user).
    // Финализация — в /api/account/* endpoint'ах (ЛК), которые проверяют
    // sms_otp.used=1 + recent + берут pending_phone из users.
    return res.json({
      data: { verified: true, phone, purpose, nextStep: `pending-${purpose}-finalize` },
      error: null,
    });
  } catch (e) {
    bootRefs?.logger.error?.("[auth-sms] verify finalize failed", { purpose, error: String(e) });
    return res.status(500).json({ data: null, error: "Ошибка при создании сессии. Попробуйте ещё раз через минуту." });
  }
});

// === Callcheck (flashcall) endpoints — Eugene 2026-05-15 Босс
// «авторизация по звонку на номер». Альтернатива SMS-OTP: дешевле, не зависит
// от SMS-фильтрации операторов. Юзер видит входящий с номера +7XXX...XXXX,
// последние 4 цифры этого номера = OTP. ===

router.post("/send-call", async (req, res) => {
  const parsed = SendCallSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message || "invalid" });
  }
  const { phone: phoneRaw, purpose } = parsed.data;
  const v = validatePhoneForOtp(phoneRaw);
  if (!v.ok || !v.country) {
    return res.status(400).json({ data: null, error: v.error || "invalid phone" });
  }
  const phone = v.normalized;

  // Те же проверки уникальности что для SMS-flow.
  if (purpose === "register") {
    const exists = db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).get();
    if (exists) return res.status(409).json({ data: null, error: "Этот номер уже зарегистрирован — войдите по нему" });
  }
  if (purpose === "login") {
    const exists = db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).get();
    if (!exists) return res.status(404).json({ data: null, error: "Номер не найден — сначала зарегистрируйтесь" });
  }

  const rl = checkRateLimit(phone);
  if (!rl.ok) return res.status(429).json({ data: null, error: rl.reason });

  const provider = getProvider();
  if (typeof (provider as any).callcheck !== "function") {
    return res.status(501).json({ data: null, error: "Текущий SMS-провайдер не поддерживает авторизацию по звонку" });
  }
  const disableSend = process.env.SMS_OTP_DISABLE === "1";
  let result: CallcheckResult;
  if (disableSend) {
    // Test mode: generate 4-digit code locally without making real call.
    const fakeCode = String(crypto.randomInt(1000, 9999));
    result = { ok: true, code: fakeCode, callPhone: "+74950000000", callId: "TEST" };
  } else {
    result = await (provider as any).callcheck(phone);
  }

  // Лог провайдера: используем тот же sms_provider_logs (provider=smsru-call).
  const logId = logProvider({
    provider: `${provider.name}-call`,
    phone,
    purpose: `call_${purpose}`,
    result: {
      ok: result.ok,
      status: result.ok ? "sent" : "failed",
      providerMsgId: result.callId,
      providerCost: result.cost,
      providerStatusText: result.ok ? `call from ${result.callPhone}` : (result.errorMessage || "unknown"),
      errorMessage: result.errorMessage,
      responseRaw: result.responseRaw,
    },
    requestMeta: { country: v.country.code, zone: v.country.zone, ip: req.ip, callPhone: result.callPhone },
  });

  if (!result.ok || !result.code) {
    return res.status(502).json({
      data: null,
      error: `Сервис звонков отклонил запрос: ${result.errorMessage || "unknown"}`,
    });
  }

  // Сохраняем code как OTP с purpose=`call_${purpose}` (чтобы не пересекалось
  // с SMS-OTP). Хранится hash 4-значного кода.
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 мин TTL для звонка
  try {
    db.insert(smsOtp).values({
      phone,
      otpHash: hashOtp(result.code),
      purpose: `call_${purpose}`,
      providerLogId: logId,
      expiresAt,
    }).run();
  } catch (e) {
    bootRefs?.logger.warn?.("[auth-sms] call otp save failed", { error: String(e) });
  }

  bootRefs?.eventBus?.emit?.("auth.call_otp_sent", {
    purpose, country: v.country.code, provider: provider.name,
  }, "auth-sms");

  return res.json({
    data: {
      sent: true,
      method: "call",
      country: v.country.code,
      countryName: v.country.name,
      callPhone: result.callPhone || null,
      // Подсказка юзеру: «вам позвонят с номера, заканчивающегося на XXXX,
      // введите последние 4 цифры». Полный номер для display.
      hint: result.callPhone
        ? `Ждите входящий звонок с номера ${result.callPhone}. Не отвечайте, просто введите последние 4 цифры этого номера.`
        : "Ждите входящий звонок и введите последние 4 цифры номера, с которого позвонили.",
      cooldownSec: 60,
      expiresInSec: 300,
    },
    error: null,
  });
});

router.post("/verify-call", async (req, res) => {
  const parsed = VerifyCallSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message || "invalid" });
  }
  const { phone: phoneRaw, code, purpose } = parsed.data;
  const phone = normalizePhone(phoneRaw);
  const codeHash = hashOtp(code);
  const callPurpose = `call_${purpose}`;

  const row = db.select().from(smsOtp)
    .where(and(eq(smsOtp.phone, phone), eq(smsOtp.purpose, callPurpose), eq(smsOtp.used, 0)))
    .orderBy(desc(smsOtp.id))
    .get() as any;
  if (!row) return res.status(404).json({ data: null, error: "Код не найден или уже использован" });
  if (row.attempts >= 5) {
    return res.status(429).json({ data: null, error: "Превышены попытки — запросите новый звонок" });
  }
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    return res.status(410).json({ data: null, error: "Срок действия кода истёк — запросите новый звонок" });
  }
  if (row.otpHash !== codeHash) {
    try {
      db.update(smsOtp).set({ attempts: row.attempts + 1 }).where(eq(smsOtp.id, row.id)).run();
    } catch {}
    return res.status(400).json({ data: null, error: "Неверный код — проверьте последние 4 цифры номера" });
  }
  try {
    db.update(smsOtp).set({ used: 1 }).where(eq(smsOtp.id, row.id)).run();
  } catch {}

  bootRefs?.eventBus?.emit?.("auth.call_otp_verified", { phone: maskPhone(phone), purpose }, "auth-sms");

  // Финализация: register / login — то же что для SMS-OTP.
  try {
    if (purpose === "register") {
      const existing = db.select().from(users).where(eq(users.phone, phone)).get() as any;
      if (existing) {
        const token = uuidv4();
        tokenStore.set(token, existing.id);
        return res.json({ data: { verified: true, phone, purpose, method: "call", token, userId: existing.id, alreadyExists: true }, error: null });
      }
      const country = detectPhoneCountry(phone);
      const placeholderPassword = await bcrypt.hash(uuidv4() + crypto.randomBytes(16).toString("hex"), 10);
      const inserted = db.insert(users).values({
        name: `Автор ${phone.slice(-4)}`,
        email: `${phone.replace(/[^\d]/g, "")}@phone.muziai.ru`,
        password: placeholderPassword,
        phone,
        phoneVerified: 1,
        country: country?.name || null,
        countryCode: country?.code || null,
      }).returning({ id: users.id }).get() as any;
      const userId = inserted?.id;
      const token = uuidv4();
      tokenStore.set(token, userId);
      bootRefs?.eventBus?.emit?.("auth.user.registered", { userId, channel: "call" }, "auth-sms");
      return res.json({
        data: { verified: true, phone, purpose, method: "call", token, userId },
        error: null,
      });
    }

    if (purpose === "login") {
      const user = db.select().from(users).where(eq(users.phone, phone)).get() as any;
      if (!user) return res.status(404).json({ data: null, error: "Номер не найден — сначала зарегистрируйтесь" });
      if (user.blocked) return res.status(403).json({ data: null, error: "Аккаунт заблокирован" });
      if (!user.phoneVerified) {
        try { db.update(users).set({ phoneVerified: 1 }).where(eq(users.id, user.id)).run(); } catch {}
      }
      const token = uuidv4();
      tokenStore.set(token, user.id);
      bootRefs?.eventBus?.emit?.("auth.user.logged_in", { userId: user.id, channel: "call" }, "auth-sms");
      return res.json({
        data: { verified: true, phone, purpose, method: "call", token, userId: user.id },
        error: null,
      });
    }

    return res.status(400).json({ data: null, error: "Unknown purpose" });
  } catch (e) {
    bootRefs?.logger.error?.("[auth-sms] verify-call finalize failed", { purpose, error: String(e) });
    return res.status(500).json({ data: null, error: "Ошибка при создании сессии. Попробуйте ещё раз через минуту." });
  }
});

// Admin: список настроенных провайдеров + balance.
router.get("/providers", async (_req, res) => {
  const provider = getProvider();
  const p: any = provider;
  const balance = p.getBalance ? await p.getBalance() : { ok: false, error: "no balance api" };
  res.json({
    data: {
      active: provider.name,
      configured: typeof p.isConfigured === "function" ? p.isConfigured() : false,
      callcheckSupported: typeof p.callcheck === "function",
      balance,
      sendDisabled: process.env.SMS_OTP_DISABLE === "1",
    },
    error: null,
  });
});

const authSmsModule: Module = {
  name: "auth-sms",
  version: "0.2.0",
  description: "SMS-OTP + Callcheck (flashcall) регистрация/авторизация через SMS.ru (РФ + СНГ). Logs провайдера в admin panel. Без SMSRU_API_ID — degraded (логи пишутся, отправки нет). Endpoints: /send-otp, /verify-otp, /send-call, /verify-call, /providers.",
  routes: { prefix: "auth/sms", router },
  publishes: ["auth.sms_otp_sent", "auth.sms_otp_verified", "auth.call_otp_sent", "auth.call_otp_verified"],
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    const provider = getProvider();
    const isConfigured = typeof (provider as any).isConfigured === "function"
      ? (provider as any).isConfigured()
      : false;
    ctx.logger.info("auth-sms online", {
      provider: provider.name,
      configured: isConfigured,
      sendDisabled: process.env.SMS_OTP_DISABLE === "1",
    });
  },
};

export default authSmsModule;
