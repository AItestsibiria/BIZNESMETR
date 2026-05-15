import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
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
import adminOverviewModule from "./plugins/admin-overview/module";
import incidentTrackerModule from "./plugins/incident-tracker/module";
import audioUploadModule from "./plugins/audio-upload/module";
import maxChannelModule from "./plugins/max-channel/module";
import telegramBotModule from "./plugins/telegram-bot/module";
import maxBotModule from "./plugins/max-bot/module";
import generationAgentModule from "./plugins/generation-agent/module";
import sunoWatchdogModule from "./plugins/suno-watchdog/module";
import authSmsModule from "./plugins/auth-sms/module";
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
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Eugene 2026-05-08: clone.muziai.ru должен быть закрыт от поисковиков.
// Prod-домены (podaripesnu.ru, muziai.ru) — индексируются нормально.
app.use((req, res, next) => {
  const host = (req.headers.host || "").toString().toLowerCase();
  const isStaging = host.includes("clone.") || host.includes("staging.") || host.startsWith("localhost") || host.startsWith("127.0.0.1");
  if (isStaging) {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  }
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
    res.send("User-agent: *\nAllow: /\nSitemap: https://muziai.ru/sitemap.xml\n");
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
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
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
  res.json({ data: { logged: true, total: CLIENT_ERRORS_RING.length }, error: null });
});

// Доступ к ring-буферу для admin-роутов (через global, чтобы не плодить
// импорты из плагинов в ядро).
(globalThis as any).__clientErrorsRing = CLIENT_ERRORS_RING;

(async () => {
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
    { name: "admin-overview", module: adminOverviewModule },
    { name: "incident-tracker", module: incidentTrackerModule },
    { name: "audio-upload", module: audioUploadModule },
    { name: "max-channel", module: maxChannelModule },
    { name: "telegram-bot", module: telegramBotModule },
    { name: "max-bot", module: maxBotModule },
    { name: "generation-agent", module: generationAgentModule },
    { name: "suno-watchdog", module: sunoWatchdogModule },
    { name: "auth-sms", module: authSmsModule },
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
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
