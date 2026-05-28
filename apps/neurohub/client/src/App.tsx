import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { AuthProvider } from "./lib/auth";
import { Toaster } from "@/components/ui/toaster";
import Navbar from "./components/navbar";
import LandingPage from "./pages/landing";
import LoginPage from "./pages/login";
import LoginPhonePage from "./pages/login-phone";
import RegisterPage from "./pages/register";
import RegisterPhonePage from "./pages/register-phone";
import PrivacyPage from "./pages/privacy";
import ConsentPage from "./pages/consent";
import OfertaPage from "./pages/oferta";
import RefundPage from "./pages/refund";
import ContactsPage from "./pages/contacts";
import LyricsPage from "./pages/lyrics";
import MusicPage from "./pages/music";
import CoversPage from "./pages/covers";
import DashboardPage from "./pages/dashboard";
import NotFoundPage from "./pages/not-found";
import ForgotPasswordPage from "./pages/forgot-password";
import { PaymentSuccess, PaymentFail } from "./pages/payment-result";
import TrackPage from "./pages/track";
import TelegramCallbackPage from "./pages/telegram-callback";
import AdminV304Page from "./pages/admin-v304";
import TemplatesPage from "./pages/templates";
import GiftCertificatesPage from "./pages/gift-certificates";
import CorporatePage from "./pages/corporate";
import BackgroundMusic from "./components/background-music";
import { ErrorBoundary } from "./components/error-boundary";
import { PlayerProvider } from "./lib/player-agent";
import { FloatingConsultant } from "./components/floating-consultant";
import { useEffect, useState } from "react";

// Wrapper для рендера каждой страницы внутри ErrorBoundary с именем —
// чтобы вместо чёрного экрана при runtime-ошибке показать стек.
function withBoundary(Comp: any, name: string) {
  return (params: any) => (
    <ErrorBoundary pageName={name}>
      <Comp {...params} />
    </ErrorBoundary>
  );
}

// Track visitor on page load
if (typeof window !== 'undefined') {
  const sid = sessionStorage.getItem('_sid') || (Math.random().toString(36).slice(2) + Date.now().toString(36));
  sessionStorage.setItem('_sid', sid);
  // Simple fingerprint from screen + timezone + language
  const fp = [screen.width, screen.height, screen.colorDepth, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language, navigator.hardwareConcurrency].join('|');
  const fpHash = Array.from(new TextEncoder().encode(fp)).reduce((h, b) => ((h << 5) - h + b) | 0, 0).toString(36);
  fetch('/api/track-visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint: fpHash, pageUrl: location.href, sessionId: sid }) }).catch(() => {});
}

function AppContent() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Router hook={useHashLocation}>
        <Navbar />
        <Switch>
          {/* Eugene 2026-05-25 Босс — чёрный экран iOS: «/» (LandingPage) был
              БЕЗ ErrorBoundary → любой throw в плеере/плейлисте = пустая страница.
              Оборачиваем как остальные роуты (withBoundary), чтобы вместо
              чёрного экрана показать фолбэк + залогировать стек на сервер. */}
          <Route path="/" component={withBoundary(LandingPage, "landing")} />
          {/* Eugene 2026-05-21 Босс: pair-link из мессенджеров (TG/Max) →
              открывается web Музa-чат с подгрузкой истории. Route рендерит
              LandingPage — floating-consultant читает useParams().code и
              auto-open chat с pairCode на /api/muza/chat/init. */}
          <Route path="/pair/:code" component={withBoundary(LandingPage, "landing-pair")} />
          <Route path="/play/:id" component={TrackPage} />
          <Route path="/share/:id" component={TrackPage} />
          <Route path="/login" component={LoginPage} />
          <Route path="/login-phone" component={LoginPhonePage} />
          <Route path="/register" component={RegisterPage} />
          <Route path="/register-phone" component={RegisterPhonePage} />
          <Route path="/register/:ref" component={RegisterPage} />
          <Route path="/r/:ref" component={RegisterPage} />
          <Route path="/privacy" component={PrivacyPage} />
          <Route path="/consent" component={ConsentPage} />
          <Route path="/terms" component={OfertaPage} />
          <Route path="/oferta" component={OfertaPage} />
          <Route path="/refund" component={RefundPage} />
          <Route path="/contacts" component={ContactsPage} />
          <Route path="/lyrics" component={LyricsPage} />
          <Route path="/music" component={MusicPage} />
          <Route path="/covers" component={CoversPage} />
          <Route path="/dashboard" component={withBoundary(DashboardPage, "dashboard")} />
          <Route path="/forgot-password" component={ForgotPasswordPage} />
          <Route path="/payment/success" component={PaymentSuccess} />
          <Route path="/payment/fail" component={PaymentFail} />
          <Route path="/track/:id" component={withBoundary(TrackPage, "track")} />
          <Route path="/telegram-callback" component={TelegramCallbackPage} />
          <Route path="/admin" component={withBoundary(AdminV304Page, "admin")} />
          <Route path="/admin/v304" component={withBoundary(AdminV304Page, "admin-v304")} />
          <Route path="/templates" component={withBoundary(TemplatesPage, "templates")} />
          <Route path="/gift-cert" component={withBoundary(GiftCertificatesPage, "gift-cert")} />
          {/* Eugene 2026-05-26 Босс «B2B-подсистема» — ЛК юрлица. Ссылку даёт
              Музa после register_legal_entity (corporateTools.ts cabinetUrl). */}
          <Route path="/corporate/:id" component={withBoundary(CorporatePage, "corporate")} />
          <Route component={NotFoundPage} />
        </Switch>
      </Router>
      <Toaster />
      <BackgroundMusic />
      {/* Eugene 2026-05-20 (frontend-audit fix #1) — FAB collision на /admin/v304:
          FloatingConsultant z-30 в bottom-right И MusaVoiceFab z-50 в bottom-right
          оверлэпали — Босс думал что жмёт чат-кнопку Музы, попадал в voice-FAB
          → открывался voice-панель → «диалог не происходит». ФИКС: на admin-pages
          FloatingConsultant скрыт (у админа есть MusaVoiceFab для admin-задач). */}
      <AdminAwareFloatingConsultant />
      {/* Eugene 2026-05-20 Босс: маленькую Музу (WalkingMusa) убрали с сайта —
          остаётся только большая в bottom-right (FloatingConsultant). */}
    </div>
  );
}

function AdminAwareFloatingConsultant() {
  // useHashLocation в Router'е, поэтому слушаем hashchange напрямую —
  // useLocation из wouter без Router context даёт path-routing, не hash.
  const [hash, setHash] = useState<string>(() => (typeof window !== "undefined" ? window.location.hash : ""));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => setHash(window.location.hash);
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  const path = hash.replace(/^#/, "") || "/";
  const isAdminPage = path.startsWith("/admin");
  if (isAdminPage) return null;
  return <FloatingConsultant />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <PlayerProvider>
          <AppContent />
        </PlayerProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
