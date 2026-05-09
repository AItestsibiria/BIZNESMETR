import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { AuthProvider } from "./lib/auth";
import { Toaster } from "@/components/ui/toaster";
import Navbar from "./components/navbar";
import LandingPage from "./pages/landing";
import LoginPage from "./pages/login";
import RegisterPage from "./pages/register";
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
import BackgroundMusic from "./components/background-music";
import { ErrorBoundary } from "./components/error-boundary";
import { PlayerProvider } from "./lib/player-agent";
import { FloatingPlayer } from "./components/floating-player";

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
          <Route path="/" component={LandingPage} />
          <Route path="/play/:id" component={TrackPage} />
          <Route path="/share/:id" component={TrackPage} />
          <Route path="/login" component={LoginPage} />
          <Route path="/register" component={RegisterPage} />
          <Route path="/register/:ref" component={RegisterPage} />
          <Route path="/r/:ref" component={RegisterPage} />
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
          <Route component={NotFoundPage} />
        </Switch>
      </Router>
      <Toaster />
      <BackgroundMusic />
      <FloatingPlayer />
    </div>
  );
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
