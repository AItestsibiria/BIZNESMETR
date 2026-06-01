// Eugene 2026-05-15 Босс: PM2 запускается без `source .env`, поэтому
// process.env содержит только NODE_ENV+PORT из ecosystem.config.cjs.
// Минимальный inline .env-loader (без npm-зависимости) — выполняется до
// любых других импортов. Иначе плагины (auth-sms, gptunnel, etc) на boot'е
// читают process.env.* и видят undefined → degraded mode.
(() => {
  try {
    const fs = require("fs");
    const path = require("path");
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, "utf-8");
    let loaded = 0;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1);
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // PITFALLS #12 — strip leading whitespace (smart-paste от clipboard).
      val = val.replace(/^\s+/, "");
      if (!(key in process.env)) {
        process.env[key] = val;
        loaded++;
      }
    }
    console.log(`[env-loader] loaded ${loaded} vars from ${envPath}`);
  } catch (e: any) {
    console.warn("[env-loader] failed:", e?.message || e);
  }
})();

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { PUBLIC_URL } from "./lib/publicUrl";
import { serveStatic } from "./static";
import { createServer } from "http";
import { EventBus, FeatureFlags, ModuleRegistry, createLogger, setGlobalRegistry } from "./core";
import { bootstrapAdminRoles } from "./core/adminAuth";
// Static imports below — esbuild inlines them into dist/index.cjs.
// Если эти строки превратить в переменно-параметризованные await import(),
// esbuild не сможет статически разрешить пути и плагины останутся
// require()-ссылками на несуществующие файлы (что произошло в коммите
// 649450a и привело к 20/20 'Cannot find module').
import exampleModule from "./plugins/example/module";
import leadCaptureModule from "./plugins/lead-capture/module";
import genTemplatesModule from "./plugins/gen-templates/module";
import v304DiagnosticsModule from "./plugins/v304-diagnostics/module";
import personaModule from "./plugins/persona/module";
import extendCoverModule from "./plugins/extend-cover/module";
import securityGuardModule from "./plugins/security-guard/module";
import authEventsBridgeModule from "./plugins/auth-events-bridge/module";
import notificationsModule from "./plugins/notifications/module";
import chatbotModule from "./plugins/chatbot/module";
import agentLeadHunterModule from "./plugins/agent-lead-hunter/module";
import agentScoutModule from "./plugins/agent-scout/module";
import agentWelcomeModule from "./plugins/agent-welcome/module";
import agentDemoModule from "./plugins/agent-demo/module";
import agentOnboardingModule from "./plugins/agent-onboarding/module";
import agentConversionModule from "./plugins/agent-conversion/module";
import agentReferralModule from "./plugins/agent-referral/module";
import agentRetentionModule from "./plugins/agent-retention/module";
import agentContentModule from "./plugins/agent-content/module";
import agentA1MasterModule from "./plugins/agent-a1-master/module";
import agentOrchestratorBridgeModule from "./plugins/agent-orchestrator-bridge/module";
import adminOverviewModule from "./plugins/admin-overview/module";
import incidentTrackerModule from "./plugins/incident-tracker/module";
import audioUploadModule from "./plugins/audio-upload/module";
import maxChannelModule from "./plugins/max-channel/module";
import telegramBotModule from "./plugins/telegram-bot/module";
import maxBotModule from "./plugins/max-bot/module";
import vkChannelModule from "./plugins/vk-channel/module";
import generationAgentModule from "./plugins/generation-agent/module";
import sunoWatchdogModule from "./plugins/suno-watchdog/module";
import authSmsModule from "./plugins/auth-sms/module";
import apiHealthModule from "./plugins/api-health/module";
import landingCmsModule from "./plugins/landing-cms/module";
import muzaInfoModule from "./plugins/muza-info/module";
import masterDashboardModule from "./plugins/master-dashboard/module";
import multiDomainStatsModule from "./plugins/multi-domain-stats/module";
import botChannelsHealthModule from "./plugins/bot-channels-health/module";
import emailChannelModule from "./plugins/email-channel/module";

import voiceAdminModule from "./plugins/voice-admin/module";

import funnelsModule from "./plugins/funnels/module";
import userProfilesModule from "./plugins/user-profiles/module";
import authorsAdminModule from "./plugins/authors-admin/module";

import supportModule from "./plugins/support/module";
import imageGenModule from "./plugins/image-gen/module";
import vpsSyncModule from "./plugins/vps-sync/module";

import operatorCommandsModule from "./plugins/operator-commands/module";
import yarsWebhookBridgeModule from "./plugins/yars-webhook-bridge/module";
import feedbackAggregatorModule from "./plugins/feedback-aggregator/module";
import escalationQueueModule from "./plugins/escalation-queue/module";
import messageAnalysisModule from "./plugins/message-analysis/module";
import playsAuditModule from "./plugins/plays-audit/module";
import playsAnalyticsModule from "./plugins/plays-analytics/module";
import giftCertificatesModule from "./plugins/gift-certificates/module";
import pdOperatorModule from "./plugins/pd-operator/module";
import postmanModule from "./plugins/postman/module";
import directorPublicationsModule from "./plugins/director-publications/module";
import ferzModule from "./plugins/ferz/module";
import frontendQaModule from "./plugins/frontend-qa/module";
import backendQaModule from "./plugins/backend-qa/module";
import securityModule from "./plugins/security/module";

// Eugene 2026-05-23 Босс «Оркестратор нужен всеми компаниями агентами начать
// в проекте — коде». Central agent registry — bootstrap на старте.
import { bootstrapDefaultAgents, recordAgentActivity } from "./lib/agentOrchestrator";
import { recordClientError } from "./lib/frontendQaAgent";
import { installEventHandlers as installMarketingHandlers } from "./lib/marketingAgent";

import * as fs from "node:fs";

const app = express();
// Static serve пользовательских аудио (Sprint 3.1).
// Nginx может отдавать /uploads напрямую — этот fallback на случай если nginx
// маршрут не настроен. Express отдаёт с Cache-Control 30d.
const UPLOADS_DIR = process.env.UPLOADS_DIR || "/var/www/neurohub/uploads";
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}
app.use("/uploads", express.static(UPLOADS_DIR, {
  maxAge: "30d",
  // BACKEND-7 fix Eugene 14:23: dotfiles deny — нет path traversal через
  // ../ ../ или скрытых файлов. fallthrough false — 404 если не найдено.
  dotfiles: "deny",
  index: false,
  fallthrough: false,
  setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=2592000"),
}));
// Доверяем фронтальному прокси (Nginx) — иначе req.ip = 127.0.0.1
// '1' означает «один хоп выше по цепочке X-Forwarded-For» — это наш Nginx на том же VPS
app.set("trust proxy", 1);

// Eugene 2026-05-18 Босс «старые QR-коды на muziai.ru должны переходить
// на muzaai.ru». 301-redirect для legacy домена — независимо от nginx
// конфига. Печатные QR-коды (визитки, флаеры, билборды), email-ссылки,
// share-link OG, ID3-tag в старых mp3 — всё продолжает работать.
// ВНИМАНИЕ: redirect должен идти ДО любых route handlers.
app.use((req, res, next) => {
  const host = String(req.headers.host || "").toLowerCase().split(":")[0];
  if (host === "muziai.ru" || host === "www.muziai.ru" || host === "www.muzaai.ru") {
    const target = `https://muzaai.ru${req.originalUrl}`;
    res.setHeader("X-Redirect-Reason", host === "muziai.ru" || host === "www.muziai.ru" ? "legacy-domain-muziai" : "canonical-no-www");
    return res.redirect(301, target);
  }
  next();
});

const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// Eugene 2026-05-08: clone.muziai.ru должен быть закрыт от поисковиков.
// Prod-домены (podaripesnu.ru, muziai.ru) — индексируются нормально.
app.use((req, res, next) => {
  const host = (req.headers.host || "").toString().toLowerCase();
  const isStaging = host.includes("clone.") || host.includes("staging.") || host.startsWith("localhost") || host.startsWith("127.0.0.1");
  if (isStaging) {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  }
  // Eugene 2026-05-23 marketing/SEO: Referrer-Policy header защищает от
  // UTM-leak — cross-site Referer теряет path+query, same-origin сохраняет
  // всё. Дублирует <meta name="referrer"> в index.html (header сильнее
  // для не-HTML ответов и старых браузеров).
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Eugene 2026-05-25 security hardening (LOW-RISK approved set).
  // Базовые security-заголовки на ВСЕ ответы (включая /api и audio-stream —
  // эти заголовки безопасны для них: HSTS/nosniff/SAMEORIGIN не ломают
  // JSON/audio).
  // - HSTS: форсируем HTTPS на год (за nginx-TLS — безопасно).
  // - nosniff: запрещаем MIME-sniffing (XSS-вектор через mis-typed responses).
  // - X-Frame-Options SAMEORIGIN: защита от clickjacking (frame только свой).
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");

  // CSP — намеренно в режиме Report-Only (НЕ enforced). Каждый push сразу
  // уходит в прод; enforced CSP мог бы заблокировать inline-скрипты Vite,
  // audio-stream (blob:/https:), сторонние пиксели (Yandex Metrika и т.п.) и
  // сломать живой сайт без права на ошибку. Report-Only даёт ту же видимость
  // нарушений (через report-uri в будущем) БЕЗ риска регрессии. Политика
  // консервативная, но реальная — после периода наблюдения её можно перевести
  // в enforced отдельным approved-изменением.
  res.setHeader(
    "Content-Security-Policy-Report-Only",
    [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "media-src 'self' https: blob:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' https:",
      "frame-ancestors 'self'",
    ].join("; "),
  );
  next();
});

// /robots.txt — для staging-доменов отдаём Disallow: /, для prod — нормально
app.get("/robots.txt", (req, res) => {
  const host = (req.headers.host || "").toString().toLowerCase();
  const isStaging = host.includes("clone.") || host.includes("staging.") || host.startsWith("localhost") || host.startsWith("127.0.0.1");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  if (isStaging) {
    res.send("User-agent: *\nDisallow: /\n");
  } else {
    res.send(
      "User-agent: *\n" +
      "Allow: /\n" +
      "Disallow: /admin\n" +
      "Disallow: /api/admin\n" +
      "Disallow: /api/auth\n" +
      "Disallow: /dashboard\n" +
      "Crawl-delay: 1\n" +
      "\n" +
      "User-agent: Yandex\n" +
      "Allow: /\n" +
      "Disallow: /admin\n" +
      "Disallow: /api/admin\n" +
      "Disallow: /api/auth\n" +
      "Disallow: /dashboard\n" +
      "Host: muzaai.ru\n" +
      "\n" +
      `Sitemap: ${PUBLIC_URL}/sitemap.xml\n`
    );
  }
});

// Eugene 2026-05-15 Босс «Музу в топ рейтинга». /sitemap.xml — публичный
// список URL'ов для Яндекс/Google индексации. Включает главную + статичные
// разделы + публичные треки (top-100 по плеям).
app.get("/sitemap.xml", (_req, res) => {
  try {
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    const now = new Date().toISOString();
    const staticUrls = [
      { loc: `${PUBLIC_URL}/`, priority: "1.0", changefreq: "daily" },
      { loc: `${PUBLIC_URL}/#/music`, priority: "0.9", changefreq: "daily" },
      { loc: `${PUBLIC_URL}/#/covers`, priority: "0.8", changefreq: "weekly" },
      { loc: `${PUBLIC_URL}/#/lyrics`, priority: "0.8", changefreq: "weekly" },
      { loc: `${PUBLIC_URL}/#/templates`, priority: "0.8", changefreq: "weekly" },
      { loc: `${PUBLIC_URL}/#/register-phone`, priority: "0.7", changefreq: "monthly" },
      { loc: `${PUBLIC_URL}/#/login-phone`, priority: "0.7", changefreq: "monthly" },
      { loc: `${PUBLIC_URL}/#/register`, priority: "0.6", changefreq: "monthly" },
    ];
    const urlEntries = staticUrls.map(u =>
      `  <url><loc>${u.loc}</loc><lastmod>${now}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`
    );
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urlEntries.join("\n") + "\n" +
      `</urlset>\n`
    );
  } catch (e: any) {
    res.status(500).send(`<!-- sitemap error: ${e?.message || e} -->`);
  }
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// Security-audit 2026-05-19 CRITICAL #2: middleware логировал ПОЛНОЕ body
// ответа в pm2 logs → Bearer-токены из /api/auth/* утекали в логи.
// Sanitize: для sensitive paths не пишем body; для остальных обрезаем + redact.
const SENSITIVE_PATH_PREFIXES = [
  "/api/auth/",
  "/api/admin/",
  "/api/account/",
  "/api/sessions/",
  "/api/telegram/auth",
  "/api/max/auth",
];
const TOKEN_REGEX = /"(token|accessToken|refreshToken|sessionToken|bearerToken|password|passphrase|apiKey|api_key|secret|otp|code|hash)"\s*:\s*"[^"]+"/gi;

function sanitizeLogBody(body: any): string {
  try {
    const raw = JSON.stringify(body);
    if (raw.length > 400) {
      return raw.slice(0, 400).replace(TOKEN_REGEX, '"$1":"[REDACTED]"') + "…";
    }
    return raw.replace(TOKEN_REGEX, '"$1":"[REDACTED]"');
  } catch {
    return "[unserializable]";
  }
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      const isSensitive = SENSITIVE_PATH_PREFIXES.some(p => path.startsWith(p));
      if (capturedJsonResponse && !isSensitive) {
        logLine += ` :: ${sanitizeLogBody(capturedJsonResponse)}`;
      }
      log(logLine);
    }
  });

  next();
});

// ===== requireNotBlocked middleware (Eugene 2026-05-18 Босс) =====
// Anti-abuse / spam защита по таблице blocked_entities (см.
// lib/blockedEntities.ts). Проверяет IP / userId / country / UA-substring.
// Whitelist:
//  - /api/health, /api/example/ping, /api/_status — health checks
//  - /api/auth/admin-*, /api/auth/login, /api/auth/sms/* — чтобы Босс
//    мог разблокировать себя если случайно заблочил
//  - super_admin / admin role — даже если userId попал в blocked_entities,
//    админа пропускаем (защита от lockout)
//
// Country block — async (через ipGeo). Логируем failure в
// user_action_failures для аналитики «сколько попыток заблокированных»
// (action='blocked_attempt').
app.use(async (req, res, next) => {
  try {
    // Не блокируем preflight CORS / non-api.
    if (req.method === "OPTIONS") return next();
    const p = req.path;
    if (!p.startsWith("/api")) return next();

    // Whitelist auth/health endpoints — самозащита от lockout админа.
    if (
      p === "/api/health" ||
      p === "/api/example/ping" ||
      p === "/api/_status" ||
      p === "/api/status" ||
      p.startsWith("/api/auth/admin-") ||
      p === "/api/auth/login" ||
      p === "/api/auth/register" ||
      p.startsWith("/api/auth/sms/")
    ) {
      return next();
    }

    // Public read-only endpoints — главная страница и контент должны быть
    // доступны всем, включая IP/country/UA в blocked_entities (Босс 2026-05-22:
    // у части юзеров пропадал плейлист из-за попадания их IP в blocked).
    // Эти endpoints НЕ позволяют изменить состояние / списать деньги — read-only.
    if (
      p.startsWith("/api/playlist") ||
      p.startsWith("/api/public/") ||
      p.startsWith("/api/cover/") ||
      p.startsWith("/api/stream/") ||
      p.startsWith("/api/download/") ||
      p === "/api/star-suggestions/top" ||
      p === "/api/user-preferences/anim-state"
    ) {
      return next();
    }

    // Динамические импорты избегают cycles с storage.ts при cold-start.
    const { isBlocked } = await import("./lib/blockedEntities");
    const { logUserActionFailure } = await import("./lib/userActionFailures");
    const { storage } = await import("./storage");
    const { tokenStore } = await import("./lib/tokenStore");
    const { isAdminUser } = await import("./core/adminAuth");

    // Если Bearer-токен валиден — заранее заполняем userId, чтобы isBlocked()
    // мог проверить user-block. Дальше — пропускаем admin/super_admin.
    let userId: number | null = null;
    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      try {
        if (tokenStore.has(token)) userId = tokenStore.get(token) ?? null;
      } catch {}
    }
    if (userId) (req as any).userId = userId;

    // Whitelist Босса (super_admin / admin) — даже если кто-то добавил его
    // userId в blocked_entities, middleware его пропускает.
    if (userId) {
      try {
        const u = storage.getUser(userId);
        if (u && isAdminUser(u as any)) return next();
      } catch {}
    }

    const result = await isBlocked(req);
    if (result.blocked) {
      try {
        logUserActionFailure({
          userId,
          channel: "web",
          action: "blocked_attempt",
          statusCode: 403,
          errorCode: `blocked:${result.type || "unknown"}`,
          errorMessage: result.reason || `blocked by ${result.type}`,
          endpoint: p.slice(0, 200),
          context: { matchedValue: result.matchedValue, blockId: result.blockId },
        });
      } catch {}
      res.status(403).json({ data: null, error: "Доступ ограничен" });
      return;
    }
    next();
  } catch (e) {
    // Никогда не ломаем pipeline из-за middleware-сбоя — anti-abuse hook
    // должен быть прозрачным fallback'ом.
    console.warn("[requireNotBlocked] warn:", e);
    next();
  }
});

// v304 boot status — global, populated below.
// /api/_status работает ВСЕГДА, даже если все 20 плагинов сгорят.
// Это лазейка для пост-mortem диагностики без ssh.
const v304Boot = {
  buildSha: process.env.V304_BUILD_SHA || "unknown",
  attemptedAt: new Date().toISOString(),
  pluginsAttempted: [] as string[],
  pluginsLoaded: [] as string[],
  pluginsFailed: [] as { name: string; error: string }[],
  registryStarted: false,
  registryError: null as string | null,
};

app.get(["/api/_status", "/api/status"], (_req, res) => {
  res.json({ data: v304Boot, error: null });
});

// Кольцевой буфер последних 100 client-errors — для UI карточки
// «Recent client errors» в /admin/v304 (TZ Eugene 11:27).
const CLIENT_ERRORS_RING: Array<{
  ts: string; page?: string; url?: string; message?: string;
  stack?: string; componentStack?: string; ua?: string;
}> = [];
const CLIENT_ERRORS_MAX = 100;

// BACKEND-9 fix Eugene 14:23: rate-limit per-IP, иначе DoS через бесконечный
// spam в логи. Map(ip → {count, resetAt}). Window 1 мин, лимит 20 reports.
const CLIENT_ERR_RATE = new Map<string, { count: number; resetAt: number }>();
const CLIENT_ERR_LIMIT = 20;
const CLIENT_ERR_WINDOW_MS = 60_000;

// ErrorBoundary clients шлют сюда runtime-ошибки страниц.
app.post("/api/_client-error", express.json(), (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "?").toString().split(",")[0].trim();
  const now = Date.now();
  let entry = CLIENT_ERR_RATE.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + CLIENT_ERR_WINDOW_MS };
    CLIENT_ERR_RATE.set(ip, entry);
  }
  entry.count++;
  if (entry.count > CLIENT_ERR_LIMIT) {
    return res.status(429).json({ data: null, error: "rate-limited" });
  }
  // BACKEND-8 fix: max-size eviction чтобы Map не разрастался при DDoS.
  if (CLIENT_ERR_RATE.size > 10_000) {
    const oldestIp = Array.from(CLIENT_ERR_RATE.entries()).sort((a, b) => a[1].resetAt - b[1].resetAt)[0]?.[0];
    if (oldestIp) CLIENT_ERR_RATE.delete(oldestIp);
  }

  const p = req.body ?? {};
  console.error(`\x1b[31m[CLIENT-ERR]\x1b[0m page=${p.page ?? "?"} url=${p.url ?? "?"} msg=${p.message ?? "?"}`);
  if (p.stack) console.error(`  stack: ${String(p.stack).slice(0, 1500)}`);
  if (p.componentStack) console.error(`  componentStack: ${String(p.componentStack).slice(0, 800)}`);
  try { recordAgentActivity("frontend-health"); } catch {}
  // Eugene 2026-05-26 Босс «агента Fab — пусть отслеживает». Если ошибка про
  // FAB/Музу — отмечаем активность агента muza-fab (Директор видит сбои FAB).
  try {
    const blob = `${p.message ?? ""} ${p.page ?? ""} ${p.componentStack ?? ""}`.toLowerCase();
    if (/consultant|floating|muza|fab/.test(blob)) recordAgentActivity("muza-fab");
  } catch {}
  CLIENT_ERRORS_RING.push({
    ts: new Date().toISOString(),
    page: p.page, url: p.url, message: p.message,
    stack: p.stack ? String(p.stack).slice(0, 4000) : undefined,
    componentStack: p.componentStack ? String(p.componentStack).slice(0, 2000) : undefined,
    ua: req.headers["user-agent"]?.slice(0, 200),
  });
  if (CLIENT_ERRORS_RING.length > CLIENT_ERRORS_MAX) {
    CLIENT_ERRORS_RING.splice(0, CLIENT_ERRORS_RING.length - CLIENT_ERRORS_MAX);
  }
  // Frontend-QA: persist + dedupe в таблицу client_errors (агент Фронт-тестер).
  // never-throws (внутри recordClientError), не ломает endpoint при сбое БД.
  try {
    recordClientError({
      message: p.message, stack: p.stack, page: p.page, url: p.url,
      userAgent: req.headers["user-agent"]?.toString(),
    });
  } catch {}
  res.json({ data: { logged: true, total: CLIENT_ERRORS_RING.length }, error: null });
});

// Доступ к ring-буферу для admin-роутов (через global, чтобы не плодить
// импорты из плагинов в ядро).
(globalThis as any).__clientErrorsRing = CLIENT_ERRORS_RING;

(async () => {
  // Eugene 2026-05-23 — bootstrap agent orchestrator ДО registerRoutes,
  // чтобы admin endpoints видели зарегистрированных default agents сразу.
  try {
    bootstrapDefaultAgents();
  } catch (e) {
    console.warn("[orchestrator] bootstrap failed:", e instanceof Error ? e.message : String(e));
  }

  // Marketing-orchestrator listeners — auto-campaigns по orchestrator events
  // (payment.succeeded, generation.published, user.churned, etc).
  try {
    installMarketingHandlers();
  } catch (e) {
    console.warn("[marketing] install handlers failed:", e instanceof Error ? e.message : String(e));
  }

  await registerRoutes(httpServer, app);

  const bootLogger = createLogger("boot");

  // ТЗ Eugene 2026-05-07: при старте промотим всех email'ов из ADMIN_EMAIL
  // в users.role='admin'. Идемпотентно — если уже admin, пропускаем.
  // Закрывает регрессию «egnovoselov видит 403 потому что чек только email».
  try {
    const r = bootstrapAdminRoles();
    bootLogger.info(`admin bootstrap: promoted=${r.promoted} skipped=${r.skipped}`);
  } catch (e) {
    bootLogger.error("admin bootstrap failed", { error: e instanceof Error ? e.message : String(e) });
  }

  // Все 20 плагинов уже импортированы статически выше → они в bundle.
  // Здесь — пара (name, module) для unified loop + диагностика.
  // Если какой-то module === undefined (например, expor default отсутствует
  // или модуль выкинул на загрузке), он попадает в pluginsFailed без
  // падения сервера.
  const PLUGINS: Array<{ name: string; module: any }> = [
    { name: "example", module: exampleModule },
    { name: "lead-capture", module: leadCaptureModule },
    { name: "gen-templates", module: genTemplatesModule },
    { name: "v304-diagnostics", module: v304DiagnosticsModule },
    { name: "persona", module: personaModule },
    { name: "extend-cover", module: extendCoverModule },
    { name: "security-guard", module: securityGuardModule },
    { name: "auth-events-bridge", module: authEventsBridgeModule },
    { name: "notifications", module: notificationsModule },
    { name: "chatbot", module: chatbotModule },
    { name: "agent-lead-hunter", module: agentLeadHunterModule },
    { name: "agent-scout", module: agentScoutModule },
    { name: "agent-welcome", module: agentWelcomeModule },
    { name: "agent-demo", module: agentDemoModule },
    { name: "agent-onboarding", module: agentOnboardingModule },
    { name: "agent-conversion", module: agentConversionModule },
    { name: "agent-referral", module: agentReferralModule },
    { name: "agent-retention", module: agentRetentionModule },
    { name: "agent-content", module: agentContentModule },
    { name: "agent-a1-master", module: agentA1MasterModule },
    { name: "agent-orchestrator-bridge", module: agentOrchestratorBridgeModule },
    { name: "admin-overview", module: adminOverviewModule },
    { name: "incident-tracker", module: incidentTrackerModule },
    { name: "audio-upload", module: audioUploadModule },
    { name: "max-channel", module: maxChannelModule },
    { name: "telegram-bot", module: telegramBotModule },
    { name: "max-bot", module: maxBotModule },
    { name: "vk-channel", module: vkChannelModule },
    { name: "generation-agent", module: generationAgentModule },
    { name: "suno-watchdog", module: sunoWatchdogModule },
    { name: "auth-sms", module: authSmsModule },
    { name: "api-health", module: apiHealthModule },
    { name: "landing-cms", module: landingCmsModule },
    { name: "muza-info", module: muzaInfoModule },
    { name: "master-dashboard", module: masterDashboardModule },
    { name: "multi-domain-stats", module: multiDomainStatsModule },
    { name: "bot-channels-health", module: botChannelsHealthModule },
    { name: "email-channel", module: emailChannelModule },

    { name: "voice-admin", module: voiceAdminModule },

    { name: "funnels", module: funnelsModule },
    { name: "user-profiles", module: userProfilesModule },
    { name: "authors-admin", module: authorsAdminModule },

    { name: "support", module: supportModule },

    { name: "image-gen", module: imageGenModule },
    { name: "plays-audit", module: playsAuditModule },
    { name: "plays-analytics", module: playsAnalyticsModule },

    { name: "vps-sync", module: vpsSyncModule },
    { name: "operator-commands", module: operatorCommandsModule },
    { name: "yars-webhook-bridge", module: yarsWebhookBridgeModule },
    { name: "feedback-aggregator", module: feedbackAggregatorModule },
    { name: "escalation-queue", module: escalationQueueModule },
    { name: "message-analysis", module: messageAnalysisModule },

    { name: "gift-certificates", module: giftCertificatesModule },

    { name: "pd-operator", module: pdOperatorModule },

    { name: "postman", module: postmanModule },

    { name: "director-publications", module: directorPublicationsModule },

    { name: "ferz", module: ferzModule },

    { name: "frontend-qa", module: frontendQaModule },

    { name: "backend-qa", module: backendQaModule },

    { name: "security", module: securityModule },

  ];

  const validModules: any[] = [];
  for (const { name, module } of PLUGINS) {
    v304Boot.pluginsAttempted.push(name);
    if (module && typeof module === "object" && module.name) {
      validModules.push(module);
      v304Boot.pluginsLoaded.push(name);
    } else {
      const error = `module export missing or invalid (got: ${typeof module})`;
      v304Boot.pluginsFailed.push({ name, error });
      bootLogger.error(`plugin invalid: ${name}`, { error });
    }
  }

  try {
    const eventBus = new EventBus();
    const featureFlags = new FeatureFlags();
    const registry = new ModuleRegistry();
    setGlobalRegistry(registry);
    registry.register(validModules);
    await registry.start({ app, eventBus, featureFlags, logger: bootLogger });
    v304Boot.registryStarted = true;
    bootLogger.info(`v304 registry online (${validModules.length} modules)`);
  } catch (err) {
    v304Boot.registryError = err instanceof Error ? err.message : String(err);
    bootLogger.error("v304 registry failed to start", {
      error: v304Boot.registryError,
    });
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // Eugene 2026-05-17 (security audit): Node.js слушает ТОЛЬКО на localhost
  // (`127.0.0.1`), а не `0.0.0.0`. nginx проксирует с :443/:80 на 127.0.0.1:5000.
  // Раньше `0.0.0.0:5000` был открыт снаружи — это позволяло обходить
  // nginx (без CSRF guard, без rate-limit, без SSL).
  // Можно override через env `BIND_HOST=0.0.0.0` если очень нужно (dev / debug).
  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.BIND_HOST || "127.0.0.1";
  httpServer.listen(
    {
      port,
      host,
      reusePort: true,
    },
    () => {
      log(`serving on ${host}:${port}`);
    },
  );
})();
