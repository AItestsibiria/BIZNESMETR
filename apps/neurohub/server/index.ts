import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";

const app = express();
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
  storageOk: false,
  storageError: null as string | null,
};

app.get("/api/_status", (_req, res) => {
  res.json({ data: v304Boot, error: null });
});

(async () => {
  await registerRoutes(httpServer, app);

  // v304 plugin foundation — defensive boot.
  // Каждый импорт плагина обёрнут try/catch так, чтобы любая ошибка
  // одного модуля не сломала сервер.
  const bootLogger = createLogger("boot");

  // 1. Storage health
  try {
    const { db } = await import("./storage");
    // sanity: select 1
    db.run((await import("drizzle-orm")).sql`SELECT 1`);
    v304Boot.storageOk = true;
  } catch (err) {
    v304Boot.storageError = err instanceof Error ? err.message : String(err);
    bootLogger.error("storage init failed", { error: v304Boot.storageError });
  }

  // 2. Lazy-load each plugin
  const PLUGIN_PATHS: { name: string; path: string }[] = [
    { name: "example",            path: "./plugins/example/module" },
    { name: "lead-capture",       path: "./plugins/lead-capture/module" },
    { name: "gen-templates",      path: "./plugins/gen-templates/module" },
    { name: "v304-diagnostics",   path: "./plugins/v304-diagnostics/module" },
    { name: "persona",            path: "./plugins/persona/module" },
    { name: "extend-cover",       path: "./plugins/extend-cover/module" },
    { name: "security-guard",     path: "./plugins/security-guard/module" },
    { name: "auth-events-bridge", path: "./plugins/auth-events-bridge/module" },
    { name: "notifications",      path: "./plugins/notifications/module" },
    { name: "chatbot",            path: "./plugins/chatbot/module" },
    { name: "agent-lead-hunter",  path: "./plugins/agent-lead-hunter/module" },
    { name: "agent-scout",        path: "./plugins/agent-scout/module" },
    { name: "agent-welcome",      path: "./plugins/agent-welcome/module" },
    { name: "agent-demo",         path: "./plugins/agent-demo/module" },
    { name: "agent-onboarding",   path: "./plugins/agent-onboarding/module" },
    { name: "agent-conversion",   path: "./plugins/agent-conversion/module" },
    { name: "agent-referral",     path: "./plugins/agent-referral/module" },
    { name: "agent-retention",    path: "./plugins/agent-retention/module" },
    { name: "agent-content",      path: "./plugins/agent-content/module" },
    { name: "agent-a1-master",    path: "./plugins/agent-a1-master/module" },
  ];

  const loaded: any[] = [];
  for (const { name, path } of PLUGIN_PATHS) {
    v304Boot.pluginsAttempted.push(name);
    try {
      const mod = (await import(path)).default;
      if (!mod || typeof mod !== "object" || !mod.name) {
        throw new Error(`module export missing or invalid (got: ${typeof mod})`);
      }
      loaded.push(mod);
      v304Boot.pluginsLoaded.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      v304Boot.pluginsFailed.push({ name, error: message });
      bootLogger.error(`plugin import failed: ${name}`, { error: message });
    }
  }

  // 3. Registry start — ещё один уровень изоляции
  try {
    const { EventBus, FeatureFlags, ModuleRegistry } = await import("./core");
    const eventBus = new EventBus();
    const featureFlags = new FeatureFlags();
    const registry = new ModuleRegistry();
    registry.register(loaded as any);
    await registry.start({ app, eventBus, featureFlags, logger: bootLogger });
    v304Boot.registryStarted = true;
    bootLogger.info(`v304 registry online (${loaded.length} modules)`);
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

// createLogger живёт в core/, но если core не подгрузился —
// нам всё равно нужен логгер. Мини-fallback.
function createLogger(scope: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("./core/logger").createLogger(scope);
  } catch {
    return {
      info: (msg: string, extra?: unknown) =>
        console.log(`[${scope}] info ${msg}`, extra ?? ""),
      warn: (msg: string, extra?: unknown) =>
        console.warn(`[${scope}] warn ${msg}`, extra ?? ""),
      error: (msg: string, extra?: unknown) =>
        console.error(`[${scope}] error ${msg}`, extra ?? ""),
    };
  }
}
