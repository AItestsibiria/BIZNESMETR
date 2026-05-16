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
import { tryGiveWelcomeGift } from "../../lib/welcomeGift";

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

// Eugene 2026-05-15 Босс «авторизация по звонку на номер» (callcheck).
// ПРАВИЛЬНЫЙ flow согласно sms.ru/api/callcheck:
// 1. Мы передаём API телефон юзера → API возвращает наш callPhone + checkId
// 2. Юзер звонит со своего номера на callPhone (звонок бесплатный, сразу
//    сбрасывается)
// 3. Мы polling'уем /callcheck/status?check_id=X — статус 401 = подтверждён
// 4. Никакого «введите код» — юзер просто звонит со своего номера
type CallcheckResult = {
  ok: boolean;
  callId?: string;            // check_id у sms.ru — для polling /status
  callPhone?: string;         // наш служебный номер (78005008275)
  callPhonePretty?: string;   // в красивом виде (+7 (800) 500-8275)
  errorMessage?: string;
  responseRaw?: string;
};

// Status polling result.
type CallcheckStatusResult = {
  ok: boolean;
  checkStatus?: number;       // 100=ожидание, 400=не подтверждён, 401=подтверждён, 402=timeout
  checkStatusText?: string;
  verified: boolean;          // true если check_status === 401
  errorMessage?: string;
};

interface SmsProvider {
  name: string;
  send(phone: string, text: string): Promise<SendResult>;
  callcheck?(phone: string): Promise<CallcheckResult>;
  callcheckStatus?(checkId: string): Promise<CallcheckStatusResult>;
  // Eugene 2026-05-16 Босс «reverse callcheck — юзер сам звонит на наш номер».
  // Семантически отдельный канал от incoming flashcall. Для sms.ru это тот же
  // endpoint callcheck/add (см. https://sms.ru/api/callcheck), но мы
  // изолируем его, чтобы при появлении провайдера с разными API не пришлось
  // менять call-site'ы в routes. Возвращает dial_number (=call_phone у sms.ru)
  // — номер, по которому юзер должен сам инициировать вызов.
  reverseCallcheck?(phone: string): Promise<CallcheckResult>;
  reverseCallcheckStatus?(checkId: string): Promise<CallcheckStatusResult>;
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
  // Возвращает check_id + call_phone (наш служебный номер). Юзер звонит
  // с своего телефона на этот call_phone — мы polling'уем /status пока
  // не получим check_status=401 (подтверждён).
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
      // Успех: status="OK" + status_code=100 + check_id + call_phone.
      // ВНИМАНИЕ: api НЕ возвращает поле `code` — мы НЕ просим юзера ввести
      // цифры. Юзер просто звонит со своего номера на call_phone.
      if ((j?.status === "OK" || j?.status_code === 100) && j?.check_id && j?.call_phone) {
        return {
          ok: true,
          callId: String(j.check_id),
          callPhone: String(j.call_phone),
          callPhonePretty: String(j.call_phone_pretty || j.call_phone),
          responseRaw: text.slice(0, 1000),
        };
      }
      return {
        ok: false,
        errorMessage: `code=${j?.status_code} msg=${j?.status_text || j?.status || "unknown"}`,
        responseRaw: text.slice(0, 1000),
      };
    } catch (e: any) {
      return { ok: false, errorMessage: String(e?.message || e).slice(0, 500) };
    }
  }

  // Eugene 2026-05-15 Босс «авторизация по звонку».
  // sms.ru method: https://sms.ru/callcheck/status?check_id=X
  // Возвращает check_status:
  //   100 — ждём звонок
  //   400 — звонка ещё не было
  //   401 — номер подтверждён (юзер позвонил)
  //   402 — истекло время (5 мин) или неверный check_id
  async callcheckStatus(checkId: string): Promise<CallcheckStatusResult> {
    if (!this.isConfigured()) {
      return { ok: false, verified: false, errorMessage: "SMSRU_API_ID not configured" };
    }
    if (!checkId) {
      return { ok: false, verified: false, errorMessage: "checkId required" };
    }
    const params = new URLSearchParams({
      api_id: this.apiId,
      check_id: checkId,
      json: "1",
    });
    try {
      const r = await fetch(`https://sms.ru/callcheck/status?${params.toString()}`, {
        method: "GET",
        signal: AbortSignal.timeout(8_000),
      });
      const text = await r.text();
      let j: any = null;
      try { j = JSON.parse(text); } catch {}
      if (!j) {
        return { ok: false, verified: false, errorMessage: `non-json response: ${text.slice(0, 200)}` };
      }
      if (j?.status === "OK" || j?.status_code === 100) {
        const cs = Number(j?.check_status);
        return {
          ok: true,
          checkStatus: cs,
          checkStatusText: String(j?.check_status_text || ""),
          verified: cs === 401,
        };
      }
      return {
        ok: false,
        verified: false,
        errorMessage: `code=${j?.status_code} msg=${j?.status_text || j?.status || "unknown"}`,
      };
    } catch (e: any) {
      return { ok: false, verified: false, errorMessage: String(e?.message || e).slice(0, 500) };
    }
  }

  // Eugene 2026-05-16 Босс «reverse callcheck — юзер сам звонит на наш номер».
  // У sms.ru это тот же endpoint /callcheck/add — он возвращает call_phone
  // (служебный номер), на который юзер инициирует звонок со своего телефона.
  // sms.ru ловит caller-id, сбрасывает входящий и помечает статус 401.
  // Семантика «reverse» (= юзер звонит нам) у sms.ru единственная — incoming
  // flashcall у них реализован через /code_call (отдельный метод). Поэтому
  // reverseCallcheck — обёртка вокруг callcheck/add с тем же payload.
  // dialNumber в результате == call_phone у sms.ru.
  async reverseCallcheck(phone: string): Promise<CallcheckResult> {
    return this.callcheck(phone);
  }

  // Eugene 2026-05-16: polling status reverse callcheck. У sms.ru тот же
  // /callcheck/status — никаких отдельных endpoints для reverse-flow нет.
  async reverseCallcheckStatus(checkId: string): Promise<CallcheckStatusResult> {
    return this.callcheckStatus(checkId);
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

// Eugene 2026-05-15: callcheck status-polling. Юзер не вводит код — фронт
// polling'ует этот endpoint пока не получит verified:true.
const CheckCallSchema = z.object({
  phone: z.string().min(5).max(30),
  purpose: z.enum(["register", "login"]),
});

// Eugene 2026-05-16 Босс «reverse callcheck — юзер сам звонит на наш номер».
// Тот же shape, отдельная purpose (call_reverse_*) чтобы изолировать TTL и
// rate-limit от incoming flashcall.
const SendReverseCallSchema = SendCallSchema;
const CheckReverseCallSchema = CheckCallSchema;

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
  // для обеих платформ. Домен из env BASE_DOMAIN (или 'muzaai.ru' fallback
  // с 15.05.2026 — см. правило MuzaAi.ru-since-150526 в CLAUDE.md).
  const otpDomain = (process.env.BASE_DOMAIN || "muzaai.ru").replace(/^https?:\/\//, "");
  const text = `Код MuzaAI: ${code}. Никому не сообщайте.\n\n@${otpDomain} #${code}`;
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
      // Eugene 2026-05-15 Босс «подарочный трек не обнаружен» — выдаём 1
      // welcome-gift первым 1000 авторам из РФ/СНГ. Same logic как при
      // email-регистрации (см. /api/auth/login).
      const giftRes = tryGiveWelcomeGift({ userId, countryCode: country?.code });
      const token = uuidv4();
      tokenStore.set(token, userId);
      bootRefs?.eventBus?.emit?.("auth.user.registered", { userId, channel: "sms" }, "auth-sms");
      return res.json({
        data: { verified: true, phone, purpose, token, userId, welcomeGift: giftRes.gifted ? giftRes.position : null },
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
    // Test mode: generate fake check_id + call_phone without real API call.
    result = {
      ok: true,
      callId: `TEST-${Date.now()}`,
      callPhone: "78005005555",
      callPhonePretty: "+7 (800) 500-5555",
    };
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
      providerStatusText: result.ok ? `call from ${result.callPhone}` : (result.errorMessage || "unknown"),
      errorMessage: result.errorMessage,
      responseRaw: result.responseRaw,
    },
    requestMeta: { country: v.country.code, zone: v.country.zone, ip: req.ip, callPhone: result.callPhone },
  });

  if (!result.ok || !result.callId || !result.callPhone) {
    return res.status(502).json({
      data: null,
      error: `Сервис звонков отклонил запрос: ${result.errorMessage || "unknown"}`,
    });
  }

  // Сохраняем check_id в sms_otp.otpHash (плейн, не hash — это идентификатор).
  // 5 мин TTL (как у sms.ru window).
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  try {
    db.insert(smsOtp).values({
      phone,
      otpHash: result.callId,
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
      callPhonePretty: result.callPhonePretty || null,
      checkId: result.callId,
      hint: result.callPhonePretty
        ? `Позвоните с вашего номера на ${result.callPhonePretty} — звонок бесплатный, сбросится автоматически.`
        : "Позвоните с вашего номера на указанный номер — звонок бесплатный.",
      cooldownSec: 60,
      expiresInSec: 300,
    },
    error: null,
  });
});

// Eugene 2026-05-15 Босс «авторизация по звонку» — polling-endpoint.
// Frontend дёргает каждые 2-3 сек. Backend смотрит sms_otp → check_id →
// дёргает sms.ru /callcheck/status. Если verified — финализирует.
router.post("/check-call", async (req, res) => {
  const parsed = CheckCallSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message || "invalid" });
  }
  const { phone: phoneRaw, purpose } = parsed.data;
  const phone = normalizePhone(phoneRaw);
  const callPurpose = `call_${purpose}`;

  const row = db.select().from(smsOtp)
    .where(and(eq(smsOtp.phone, phone), eq(smsOtp.purpose, callPurpose), eq(smsOtp.used, 0)))
    .orderBy(desc(smsOtp.id))
    .get() as any;
  if (!row) return res.status(404).json({ data: null, error: "Запрос не найден — нажмите 'Получить звонок' снова" });
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    return res.status(410).json({ data: null, error: "Срок действия истёк (5 мин) — запросите новый звонок" });
  }

  const provider = getProvider();
  if (typeof (provider as any).callcheckStatus !== "function") {
    return res.status(501).json({ data: null, error: "Провайдер не поддерживает status polling" });
  }
  const checkId = row.otpHash; // мы сохранили check_id здесь, не hash
  const disableSend = process.env.SMS_OTP_DISABLE === "1";
  // В test-mode (SMS_OTP_DISABLE=1) и checkId.startsWith('TEST-') — фейк verified
  // через 10 сек после создания записи (для тестов на clone).
  let statusRes: CallcheckStatusResult;
  if (disableSend && typeof checkId === "string" && checkId.startsWith("TEST-")) {
    const created = new Date((row as any).createdAt || row.expiresAt).getTime();
    const isFakeVerified = Date.now() - created > 10_000;
    statusRes = { ok: true, checkStatus: isFakeVerified ? 401 : 400, verified: isFakeVerified };
  } else {
    statusRes = await (provider as any).callcheckStatus(checkId);
  }

  if (!statusRes.verified) {
    // Не подтверждён — фронт продолжает polling. Включая случай errorMessage
    // (например провайдер временно недоступен — фронт ретраит ещё).
    return res.json({
      data: {
        verified: false,
        checkStatus: statusRes.checkStatus ?? null,
        checkStatusText: statusRes.checkStatusText ?? null,
        waiting: true,
        error: statusRes.errorMessage || null,
      },
      error: null,
    });
  }

  // Verified — отметим OTP used + финализируем как раньше.
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
      const giftRes = tryGiveWelcomeGift({ userId, countryCode: country?.code });
      const token = uuidv4();
      tokenStore.set(token, userId);
      bootRefs?.eventBus?.emit?.("auth.user.registered", { userId, channel: "call" }, "auth-sms");
      return res.json({
        data: { verified: true, phone, purpose, method: "call", token, userId, welcomeGift: giftRes.gifted ? giftRes.position : null },
        error: null,
      });
    }

    if (purpose === "login") {
      const user = db.select().from(users).where(eq(users.phone, phone)).get() as any;
      // Eugene 2026-05-15 Босс «связать email и номер, лёгкое решение».
      // Если phone не найден — НЕ возвращаем 404. Создаём новый phone-аккаунт
      // upsert-style. Юзер потом сможет в ЛК «привязать существующий email»
      // через endpoint /api/account/link-existing.
      if (!user) {
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
        const newUserId = inserted?.id;
        const giftRes = tryGiveWelcomeGift({ userId: newUserId, countryCode: country?.code });
        const token = uuidv4();
        tokenStore.set(token, newUserId);
        bootRefs?.eventBus?.emit?.("auth.user.registered", { userId: newUserId, channel: "call", upsert: true }, "auth-sms");
        return res.json({
          data: { verified: true, phone, purpose, method: "call", token, userId: newUserId, newAccount: true, welcomeGift: giftRes.gifted ? giftRes.position : null },
          error: null,
        });
      }
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
    bootRefs?.logger.error?.("[auth-sms] check-call finalize failed", { purpose, error: String(e) });
    return res.status(500).json({ data: null, error: "Ошибка при создании сессии. Попробуйте ещё раз через минуту." });
  }
});

// === Reverse callcheck endpoints — Eugene 2026-05-16 Босс «юзер сам
// звонит на наш номер». UX-flow:
//   1. UI получает dialNumber через /send-reverse-call
//   2. UI рендерит `<a href="tel:...">dialNumber</a>` — юзер тапает,
//      открывается dialer, юзер нажимает «Вызов» со своего телефона
//   3. UI polling'ует /check-reverse-call каждые 3 сек
//   4. Если verified → создаём session token (login или register)
//   5. Если 120 сек прошло — UI показывает fallback на email-auth
// TTL короче (120 сек) чем у sms.ru окна (300 сек) — даём юзеру 2 мин,
// потом fallback. Если юзер не успел — может попробовать ещё раз или
// войти через email.
const REVERSE_CALL_TTL_SEC = 120;

router.post("/send-reverse-call", async (req, res) => {
  const parsed = SendReverseCallSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message || "invalid" });
  }
  const { phone: phoneRaw, purpose } = parsed.data;
  const v = validatePhoneForOtp(phoneRaw);
  if (!v.ok || !v.country) {
    return res.status(400).json({ data: null, error: v.error || "invalid phone" });
  }
  const phone = v.normalized;

  // Те же проверки уникальности что для SMS/incoming-call flow.
  if (purpose === "register") {
    const exists = db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).get();
    if (exists) return res.status(409).json({ data: null, error: "Этот номер уже зарегистрирован — войдите по нему" });
  }
  if (purpose === "login") {
    // Для reverse — НЕ возвращаем 404 если номер не найден. Допускаем
    // upsert-style (как и /check-call): создадим новый phone-only аккаунт
    // на verified-стадии. Это снимает trade-off «новые юзеры через тот же
    // экран входа». Если Босс захочет жёсткости — добавим проверку обратно.
  }

  const rl = checkRateLimit(phone);
  if (!rl.ok) return res.status(429).json({ data: null, error: rl.reason });

  const provider = getProvider();
  if (typeof (provider as any).reverseCallcheck !== "function") {
    return res.status(501).json({ data: null, error: "Текущий SMS-провайдер не поддерживает звонок на наш номер" });
  }
  const disableSend = process.env.SMS_OTP_DISABLE === "1";
  let result: CallcheckResult;
  if (disableSend) {
    result = {
      ok: true,
      callId: `TEST-REV-${Date.now()}`,
      callPhone: "78005005555",
      callPhonePretty: "+7 (800) 500-5555",
    };
  } else {
    result = await (provider as any).reverseCallcheck(phone);
  }

  const logId = logProvider({
    provider: `${provider.name}-reverse`,
    phone,
    purpose: `call_reverse_${purpose}`,
    result: {
      ok: result.ok,
      status: result.ok ? "sent" : "failed",
      providerMsgId: result.callId,
      providerStatusText: result.ok ? `reverse-call dial ${result.callPhone}` : (result.errorMessage || "unknown"),
      errorMessage: result.errorMessage,
      responseRaw: result.responseRaw,
    },
    requestMeta: { country: v.country.code, zone: v.country.zone, ip: req.ip, dialNumber: result.callPhone },
  });

  if (!result.ok || !result.callId || !result.callPhone) {
    return res.status(502).json({
      data: null,
      error: `Сервис звонков отклонил запрос: ${result.errorMessage || "unknown"}`,
    });
  }

  const expiresAt = new Date(Date.now() + REVERSE_CALL_TTL_SEC * 1000).toISOString();
  try {
    db.insert(smsOtp).values({
      phone,
      otpHash: result.callId,
      purpose: `call_reverse_${purpose}`,
      providerLogId: logId,
      expiresAt,
    }).run();
  } catch (e) {
    bootRefs?.logger.warn?.("[auth-sms] reverse-call otp save failed", { error: String(e) });
  }

  bootRefs?.eventBus?.emit?.("auth.reverse_call_sent", {
    purpose, country: v.country.code, provider: provider.name,
  }, "auth-sms");

  return res.json({
    data: {
      sent: true,
      method: "reverse-call",
      country: v.country.code,
      countryName: v.country.name,
      dialNumber: result.callPhone || null,
      dialNumberPretty: result.callPhonePretty || null,
      checkId: result.callId,
      hint: result.callPhonePretty
        ? `Тапните номер ${result.callPhonePretty} — откроется звонок. Нажмите «Вызов» — мы поймаем caller-id и подтвердим вход.`
        : "Тапните номер — откроется звонок. Нажмите «Вызов» — мы поймаем caller-id и подтвердим вход.",
      cooldownSec: 60,
      expiresInSec: REVERSE_CALL_TTL_SEC,
      fallbackAfterSec: REVERSE_CALL_TTL_SEC,
    },
    error: null,
  });
});

router.post("/check-reverse-call", async (req, res) => {
  const parsed = CheckReverseCallSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ data: null, error: parsed.error.issues[0]?.message || "invalid" });
  }
  const { phone: phoneRaw, purpose } = parsed.data;
  const phone = normalizePhone(phoneRaw);
  const callPurpose = `call_reverse_${purpose}`;

  const row = db.select().from(smsOtp)
    .where(and(eq(smsOtp.phone, phone), eq(smsOtp.purpose, callPurpose), eq(smsOtp.used, 0)))
    .orderBy(desc(smsOtp.id))
    .get() as any;
  if (!row) return res.status(404).json({ data: null, error: "Запрос не найден — нажмите ещё раз" });
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    return res.status(410).json({
      data: null,
      error: "Время ожидания истекло — попробуйте ещё раз или войдите через email",
    });
  }

  const provider = getProvider();
  if (typeof (provider as any).reverseCallcheckStatus !== "function") {
    return res.status(501).json({ data: null, error: "Провайдер не поддерживает status polling" });
  }
  const checkId = row.otpHash;
  const disableSend = process.env.SMS_OTP_DISABLE === "1";
  let statusRes: CallcheckStatusResult;
  if (disableSend && typeof checkId === "string" && checkId.startsWith("TEST-REV-")) {
    // В test-mode фейк verified через 10 сек после создания (для clone).
    const created = new Date((row as any).createdAt || row.expiresAt).getTime();
    const isFakeVerified = Date.now() - created > 10_000;
    statusRes = { ok: true, checkStatus: isFakeVerified ? 401 : 400, verified: isFakeVerified };
  } else {
    statusRes = await (provider as any).reverseCallcheckStatus(checkId);
  }

  if (!statusRes.verified) {
    return res.json({
      data: {
        verified: false,
        checkStatus: statusRes.checkStatus ?? null,
        checkStatusText: statusRes.checkStatusText ?? null,
        waiting: true,
        expired: false,
        error: statusRes.errorMessage || null,
      },
      error: null,
    });
  }

  try {
    db.update(smsOtp).set({ used: 1 }).where(eq(smsOtp.id, row.id)).run();
  } catch {}

  bootRefs?.eventBus?.emit?.("auth.reverse_call_verified", { phone: maskPhone(phone), purpose }, "auth-sms");

  // Финализация: register / login — то же что для incoming flashcall.
  try {
    if (purpose === "register") {
      const existing = db.select().from(users).where(eq(users.phone, phone)).get() as any;
      if (existing) {
        const token = uuidv4();
        tokenStore.set(token, existing.id);
        return res.json({
          data: { verified: true, expired: false, phone, purpose, method: "reverse-call", token, userId: existing.id, alreadyExists: true },
          error: null,
        });
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
      const giftRes = tryGiveWelcomeGift({ userId, countryCode: country?.code });
      const token = uuidv4();
      tokenStore.set(token, userId);
      bootRefs?.eventBus?.emit?.("auth.user.registered", { userId, channel: "reverse-call" }, "auth-sms");
      return res.json({
        data: { verified: true, expired: false, phone, purpose, method: "reverse-call", token, userId, welcomeGift: giftRes.gifted ? giftRes.position : null },
        error: null,
      });
    }

    if (purpose === "login") {
      const user = db.select().from(users).where(eq(users.phone, phone)).get() as any;
      if (!user) {
        // Upsert: phone not found → создаём новый phone-only аккаунт.
        // Consistent с /check-call поведением (Босс «связать email и номер,
        // лёгкое решение» — UI потом покажет banner про linking в ЛК).
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
        const newUserId = inserted?.id;
        const giftRes = tryGiveWelcomeGift({ userId: newUserId, countryCode: country?.code });
        const token = uuidv4();
        tokenStore.set(token, newUserId);
        bootRefs?.eventBus?.emit?.("auth.user.registered", { userId: newUserId, channel: "reverse-call", upsert: true }, "auth-sms");
        return res.json({
          data: { verified: true, expired: false, phone, purpose, method: "reverse-call", token, userId: newUserId, newAccount: true, welcomeGift: giftRes.gifted ? giftRes.position : null },
          error: null,
        });
      }
      if (user.blocked) return res.status(403).json({ data: null, error: "Аккаунт заблокирован" });
      if (!user.phoneVerified) {
        try { db.update(users).set({ phoneVerified: 1 }).where(eq(users.id, user.id)).run(); } catch {}
      }
      const token = uuidv4();
      tokenStore.set(token, user.id);
      bootRefs?.eventBus?.emit?.("auth.user.logged_in", { userId: user.id, channel: "reverse-call" }, "auth-sms");
      return res.json({
        data: { verified: true, expired: false, phone, purpose, method: "reverse-call", token, userId: user.id },
        error: null,
      });
    }

    return res.status(400).json({ data: null, error: "Unknown purpose" });
  } catch (e) {
    bootRefs?.logger.error?.("[auth-sms] check-reverse-call finalize failed", { purpose, error: String(e) });
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
      reverseCallcheckSupported: typeof p.reverseCallcheck === "function",
      balance,
      sendDisabled: process.env.SMS_OTP_DISABLE === "1",
    },
    error: null,
  });
});

const authSmsModule: Module = {
  name: "auth-sms",
  version: "0.4.0",
  description: "SMS-OTP + Callcheck (incoming) + Reverse-callcheck (юзер сам звонит на наш номер, tap-to-dial, 120 сек TTL + fallback на email-auth) регистрация/авторизация через SMS.ru (РФ + СНГ). Logs провайдера в admin panel. Без SMSRU_API_ID — degraded (логи пишутся, отправки нет). Endpoints: /send-otp, /verify-otp, /send-call, /check-call (polling), /send-reverse-call, /check-reverse-call (polling), /providers.",
  routes: { prefix: "auth/sms", router },
  publishes: [
    "auth.sms_otp_sent",
    "auth.sms_otp_verified",
    "auth.call_otp_sent",
    "auth.call_otp_verified",
    "auth.reverse_call_sent",
    "auth.reverse_call_verified",
  ],
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
