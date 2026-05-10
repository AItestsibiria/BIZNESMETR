import { useState, useCallback, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";

function playCosmicChime() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    // Gentle shimmer chord: C5, E5, G5, B5
    const freqs = [523.25, 659.25, 783.99, 987.77];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now);
      // Stagger entry for sparkle effect
      gain.gain.setValueAtTime(0, now + i * 0.06);
      gain.gain.linearRampToValueAtTime(0.08, now + i * 0.06 + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2 + i * 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.06);
      osc.stop(now + 1.5);
    });

    // High sparkle ping
    const ping = ctx.createOscillator();
    const pingGain = ctx.createGain();
    ping.type = "sine";
    ping.frequency.setValueAtTime(2093, now + 0.25);
    ping.frequency.exponentialRampToValueAtTime(1568, now + 0.8);
    pingGain.gain.setValueAtTime(0, now + 0.25);
    pingGain.gain.linearRampToValueAtTime(0.04, now + 0.3);
    pingGain.gain.exponentialRampToValueAtTime(0.001, now + 1.3);
    ping.connect(pingGain).connect(ctx.destination);
    ping.start(now + 0.25);
    ping.stop(now + 1.5);

    setTimeout(() => ctx.close(), 2000);
  } catch {}
}
import { useAuth } from "@/lib/auth";
import { Music, Menu, X, LogOut, LayoutDashboard, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function Navbar() {
  const { user, logout } = useAuth();
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isLanding = location === "/" || location === "";

  const navLinks = [
    { href: "/", label: "Главная" },
    { href: "/templates", label: "Шаблоны" },
    { href: "/lyrics", label: "Тексты" },
    { href: "/music", label: "Музыка" },
    // Аудио ведёт на /music — режим выставляется через localStorage,
    // т.к. wouter (hash-router) не парсит query-string как часть пути.
    { href: "/music", label: "🎤 Аудио", onClickSetMode: "audio" as const },
    { href: "/covers", label: "Обложки" },
  ];

  // Админство определяем по факту что /gptunnel-balance отвечает 200
  // (на сервере проверка идёт по ADMIN_EMAIL CSV из .env). Это снимает
  // необходимость отдельно синхронизировать список админов на клиенте.
  const [adminBal, setAdminBal] = useState<{ available: boolean; balance?: number; suno?: { estimatedTracks: number; pricePerTrack: number } } | null>(null);
  const [yandexUsage, setYandexUsage] = useState<{ totalMinutes: number; estimatedSpentRub: number; total: number; ok: boolean } | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!user) { setIsAdmin(false); setAdminBal(null); setYandexUsage(null); return; }
    let cancelled = false;
    // apiRequest throws on non-2xx — 401/403 для не-админа улетят в catch.
    const load = async () => {
      try {
        const [r1, r2] = await Promise.allSettled([
          apiRequest("GET", "/api/admin/v304/gptunnel-balance"),
          apiRequest("GET", "/api/admin/v304/yandex/status"),
        ]);
        if (cancelled) return;
        if (r1.status === "fulfilled" && r1.value.ok) {
          const j = await r1.value.json();
          setIsAdmin(true);
          setAdminBal(j.data);
        }
        if (r2.status === "fulfilled" && r2.value.ok) {
          const j = await r2.value.json();
          const stt = j.data?.services?.speechkit_stt;
          const u = j.data?.usage;
          if (u) setYandexUsage({
            totalMinutes: u.totalMinutes || 0,
            estimatedSpentRub: u.estimatedSpentRub || 0,
            total: u.total || 0,
            ok: stt?.configured && stt?.authProbe?.authValid !== false,
          });
        }
      } catch {
        if (!cancelled) setIsAdmin(false);
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [user]);

  const formatBalance = (user: any) => {
    // Для админа — Suno-треки из GPTunnel-баланса (одна live-цифра, обновл. 60 сек).
    if (isAdmin) {
      if (!adminBal) return "…";
      if (!adminBal.available) return "GPT⚠";
      const tracks = adminBal.suno?.estimatedTracks ?? 0;
      return `🎵 ${tracks.toLocaleString("ru-RU")}`;
    }
    return `${Math.floor(user.balance / 100)} ₽`;
  };

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        isLanding ? "nav-glass" : "nav-glass border-b border-white/[0.06]"
      }`}
      data-testid="navbar"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo — always goes to main page and scrolls to the playlist zone */}
          <Link
            href="/"
            className="flex items-center gap-2 group"
            data-testid="link-logo"
            onClick={(e: any) => {
              playCosmicChime();
              // Mark intent to scroll to playlist after navigation completes
              try { sessionStorage.setItem("scrollToPlaylist", "1"); } catch {}
              // If already on main page, scroll immediately
              const currentHash = window.location.hash.replace(/^#/, "") || "/";
              if (currentHash === "/" || currentHash === "") {
                e?.preventDefault?.();
                const el = document.getElementById("playlist-section") || document.querySelector("[data-scroll-target='playlist']");
                if (el) (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "start" });
                else window.scrollTo({ top: 0, behavior: "smooth" });
              }
            }}
          >
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-600 via-violet-500 to-blue-500 flex items-center justify-center shadow-lg shadow-purple-500/20">
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                <path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="white" strokeWidth="2" strokeLinecap="round" />
                <circle cx="6" cy="8" r="1" fill="rgba(255,255,255,0.5)" />
                <circle cx="12" cy="6" r="1.2" fill="rgba(255,255,255,0.7)" />
                <circle cx="18" cy="9" r="0.8" fill="rgba(255,255,255,0.4)" />
                <path d="M6 8L12 6M12 6L18 9" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
              </svg>
            </div>
            <span className="text-base font-bold tracking-tight">
              <span className="bg-gradient-to-r from-purple-400 via-violet-300 to-blue-400 bg-clip-text text-transparent">Muzi</span><span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">Ai</span>
            </span>
          </Link>

          {/* Desktop Nav */}
          <div className="hidden md:flex items-center gap-1">
            {navLinks.map((link) => (
              <Link
                key={`${link.href}-${link.label}`}
                href={link.href}
                onClick={() => {
                  if ((link as any).onClickSetMode) {
                    try { localStorage.setItem("music_mode", (link as any).onClickSetMode); } catch {}
                  }
                }}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  location === link.href
                    ? "text-white bg-white/10"
                    : "text-muted-foreground hover:text-white hover:bg-white/5"
                }`}
                data-testid={`link-nav-${link.label}`}
              >
                {link.label}
              </Link>
            ))}
          </div>

          {/* Right side */}
          <div className="hidden md:flex items-center gap-3">
            {user ? (
              <>
                <Link href="/dashboard" data-testid="link-balance">
                  <span className="price-badge cursor-pointer">
                    {formatBalance(user)}
                    {(user as any).bonusTracks > 0 && (
                      <span className="ml-1.5 text-green-400">+{(user as any).bonusTracks}🎁</span>
                    )}
                  </span>
                </Link>
                {/* Yandex API usage — рядом с балансом (Eugene 13:38) */}
                {isAdmin && yandexUsage && (
                  <Link href="/admin/v304" title={`Yandex SpeechKit: ${yandexUsage.total} вызовов · ≈ ${yandexUsage.totalMinutes.toFixed(1)} мин · ≈ ${yandexUsage.estimatedSpentRub.toFixed(2)}₽`}>
                    <span className={`price-badge cursor-pointer ${yandexUsage.ok ? "text-cyan-300" : "text-amber-300"}`}>
                      🎤 Я: {yandexUsage.estimatedSpentRub.toFixed(0)}₽
                    </span>
                  </Link>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-white"
                      data-testid="button-user-menu"
                    >
                      <User className="w-4 h-4 mr-1" />
                      {user.name}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem asChild>
                      <Link href="/dashboard" className="flex items-center gap-2 cursor-pointer w-full">
                        <LayoutDashboard className="w-4 h-4" />
                        Личный кабинет
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => logout()}
                      className="cursor-pointer text-red-400"
                      data-testid="button-logout"
                    >
                      <LogOut className="w-4 h-4 mr-2" />
                      Выйти
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <>
                <Link href="/login">
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-white" data-testid="link-login">
                    Войти
                  </Button>
                </Link>
                <Link href="/register">
                  <Button size="sm" className="btn-gradient rounded-full px-4" data-testid="link-register">
                    Регистрация
                  </Button>
                </Link>
              </>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            className="md:hidden text-muted-foreground hover:text-white p-2"
            onClick={() => setMobileOpen(!mobileOpen)}
            data-testid="button-mobile-menu"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileOpen && (
        <div className="md:hidden nav-glass border-t border-white/[0.06]">
          <div className="px-4 py-4 space-y-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={`block px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  location === link.href
                    ? "text-white bg-white/10"
                    : "text-muted-foreground hover:text-white hover:bg-white/5"
                }`}
              >
                {link.label}
              </Link>
            ))}
            <div className="pt-3 border-t border-white/[0.06] mt-3">
              {user ? (
                <>
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    {formatBalance(user)}
                    {(user as any).bonusTracks > 0 && (
                      <span className="ml-1.5 text-green-400">+{(user as any).bonusTracks}🎁</span>
                    )}
                  </div>
                  <Link
                    href="/dashboard"
                    onClick={() => setMobileOpen(false)}
                    className="block px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-white"
                  >
                    Личный кабинет
                  </Link>
                  <button
                    onClick={() => { logout(); setMobileOpen(false); }}
                    className="block w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-red-400 hover:bg-white/5"
                    data-testid="button-mobile-logout"
                  >
                    Выйти
                  </button>
                </>
              ) : (
                <div className="flex gap-2 px-3">
                  <Link href="/login" onClick={() => setMobileOpen(false)} className="flex-1">
                    <Button variant="ghost" size="sm" className="w-full">
                      Войти
                    </Button>
                  </Link>
                  <Link href="/register" onClick={() => setMobileOpen(false)} className="flex-1">
                    <Button size="sm" className="btn-gradient w-full rounded-full">
                      Регистрация
                    </Button>
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
