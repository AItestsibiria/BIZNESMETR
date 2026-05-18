import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  // Eugene 2026-05-19 backend-audit ROOT CAUSE /admin crash:
  // base: "./" → браузер на /admin резолвит ./assets/x.js в /admin/assets/x.js
  // → 404 → SPA fallback отдаёт index.html → MIME text/html → ES module fail.
  // base: "/" — абсолютные пути от корня, всегда работают независимо от pathname.
  base: "/",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Sourcemaps включены для прода — нужны для debug React-ошибок
    // (read prod stack-trace по реальным именам файлов/строк).
    sourcemap: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
