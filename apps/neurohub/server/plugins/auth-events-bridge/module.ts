// Мост между существующими auth/payment-роутами v51 и v304 EventBus.
//
// v51 routes.ts — большой монолит (3973 строки), правка которого опасна.
// Этот плагин подписывается на ответы Express и эмитит соответствующие
// события без касания routes.ts:
//
//   POST /api/auth/register  → success → 'auth.user.registered'
//   POST /api/auth/login     → success → 'auth.user.logged_in'
//   /api/payment/result      → success → 'payment.succeeded'
//
// Перехватываем `res.json()` чтобы видеть тело ответа и достать userId
// из payload'а (текущая v51-конвенция: успех = `{ user: {...} }`).
//
// Spec: docs/strategy/original/06 §2.3 (event catalog), 03 §3.2.

import type { NextFunction, Request, Response } from "express";
import type { BootContext, Module } from "../../core";

interface RegisterResponse {
  user?: { id?: number; email?: string; telegramId?: string | null };
}

interface LoginResponse {
  user?: { id?: number; email?: string };
}

let bootRefs: { eventBus: BootContext["eventBus"]; logger: BootContext["logger"] } | null = null;

function captureJson<T>(res: Response, onCapture: (body: T) => void): void {
  const original = res.json.bind(res);
  res.json = function (body: T) {
    try {
      onCapture(body);
    } catch {
      // не валим запрос если перехватчик упал
    }
    return original(body as any);
  };
}

function bridgeMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!bootRefs) return next();
  const path = req.path;

  if (req.method === "POST" && path === "/api/auth/register") {
    captureJson<RegisterResponse>(res, (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300 && body?.user?.id) {
        bootRefs!.eventBus.emit(
          "auth.user.registered",
          {
            userId: body.user.id,
            email: body.user.email ?? null,
            telegramId: body.user.telegramId ?? null,
          },
          "auth-events-bridge",
        );
      }
    });
  } else if (req.method === "POST" && path === "/api/auth/login") {
    captureJson<LoginResponse>(res, (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300 && body?.user?.id) {
        bootRefs!.eventBus.emit(
          "auth.user.logged_in",
          { userId: body.user.id, email: body.user.email ?? null, ip: req.ip },
          "auth-events-bridge",
        );
      }
    });
  } else if (path === "/api/payment/result") {
    // Robokassa success callback. Тело — plaintext "OK<invId>" в v51,
    // но мы читаем из URL/QS параметры (OutSum, InvId) и считаем что
    // если route ответил 200 — payment OK.
    res.on("finish", () => {
      if (res.statusCode === 200 && req.query.OutSum && req.query.InvId) {
        bootRefs!.eventBus.emit(
          "payment.succeeded",
          {
            invId: Number(req.query.InvId),
            amount: Number(req.query.OutSum),
            ip: req.ip,
          },
          "auth-events-bridge",
        );
      }
    });
  }

  next();
}

const authEventsBridgeModule: Module = {
  name: "auth-events-bridge",
  version: "0.1.0",
  description: "Bridges existing v51 auth/payment routes into the v304 EventBus.",
  publishes: ["auth.user.registered", "auth.user.logged_in", "payment.succeeded"],
  onLoad: async (ctx) => {
    bootRefs = { eventBus: ctx.eventBus, logger: ctx.logger };
    ctx.app.use(bridgeMiddleware);
    ctx.logger.info("auth-events-bridge online (intercepts /api/auth/* and /api/payment/result)");
  },
  healthCheck: () => ({ status: "ok" }),
};

export default authEventsBridgeModule;
