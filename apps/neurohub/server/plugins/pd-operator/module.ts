// v304 plugin: pd-operator (Eugene 2026-05-25 Босс).
//
// Публичный endpoint с реквизитами оператора персональных данных (152-ФЗ).
// Эти реквизиты по закону и так публикуются в подвале сайта / Политике /
// Согласии — секретов здесь нет (Secrets-admin-only rule соблюдён).
//
// Public:
//   GET /api/legal/pd-operator — { operator, pdRegistered, regNumber,
//                                  policyUrl, consentUrl, transborder }
//
// Размещён в отдельном маленьком плагине (НЕ в routes.ts), чтобы не
// пересекаться с параллельным агентом email-робота.

import { Router } from "express";
import { getLegalConfig, isPdOperatorRegistered } from "../../lib/legalConfig";
import type { Module } from "../../core/types";

const router = Router();

router.get("/legal/pd-operator", (_req, res) => {
  try {
    const cfg = getLegalConfig();
    const pdRegistered = isPdOperatorRegistered(cfg);
    res.json({
      data: {
        operator: {
          entityName: cfg.entityName,
          entityFullName: cfg.entityFullName,
          inn: cfg.inn,
          ogrn: cfg.ogrn,
          address: cfg.legalAddress,
          email: cfg.email,
          phone: cfg.phone,
        },
        pdRegistered,
        regNumber: pdRegistered ? cfg.pdOperatorRegNumber : null,
        policyUrl: cfg.pdPolicyUrl,
        consentUrl: cfg.pdConsentUrl,
        transborder: {
          enabled: cfg.transborderTransfer,
          countries: cfg.transborderCountries,
        },
      },
      error: null,
    });
  } catch (err) {
    res
      .status(500)
      .json({ data: null, error: err instanceof Error ? err.message : "internal" });
  }
});

const pdOperatorModule: Module = {
  name: "pd-operator",
  version: "0.1.0",
  description:
    "Публичные реквизиты оператора ПДн (152-ФЗ): GET /api/legal/pd-operator. Без секретов.",
  // moduleRegistry mounts under `/api${prefix}` — prefix "" → /api/legal/...
  routes: { prefix: "", router },
  publishes: [],
  onLoad: async (ctx) => {
    ctx.logger.info(
      "pd-operator online — GET /api/legal/pd-operator (public)",
    );
  },
  healthCheck: () => ({ status: "ok" }),
};

export default pdOperatorModule;
