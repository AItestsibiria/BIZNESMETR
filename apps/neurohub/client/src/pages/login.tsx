import { useState, useEffect, useRef } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Music, Loader2, Eye, EyeOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

export default function LoginPage() {
  const { login, user } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (user) navigate("/dashboard");
  }, [user, navigate]);
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(email, password, remember);
      // Navigation handled by useEffect watching user state
    } catch (err: any) {
      toast({
        title: "Ошибка входа",
        description: err.message?.includes("401") ? "Неверный email или пароль" : err.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 pt-16 hero-gradient">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center mx-auto mb-4">
            <Music className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-xl font-bold gradient-text" data-testid="text-login-title">Вход в MuziAi</h1>
          <p className="text-sm text-muted-foreground mt-1">Войдите, чтобы создавать музыку</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="gradient-border p-6 rounded-2xl space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-sm text-muted-foreground">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="bg-background/50 border-white/10 input-glow"
              data-testid="input-email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-sm text-muted-foreground">Пароль</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                placeholder="••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="bg-background/50 border-white/10 input-glow pr-10"
                data-testid="input-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white transition-colors"
                tabIndex={-1}
                data-testid="button-toggle-password"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="w-4 h-4 rounded border-white/20 bg-white/5 accent-purple-500"
            />
            <span className="text-xs text-muted-foreground">Запомнить меня</span>
          </label>
          <Button
            type="submit"
            className="w-full btn-gradient rounded-xl h-11"
            disabled={loading}
            data-testid="button-login"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Войти"}
          </Button>
          <div className="text-center">
            <Link
              href="/forgot-password"
              className="text-xs text-muted-foreground hover:text-purple-400 transition-colors"
              data-testid="link-forgot-password"
            >
              Забыли пароль?
            </Link>
          </div>
        </form>

        {/* Telegram Login */}
        <div className="mt-4">
          <TelegramLoginBtn />
        </div>

        <p className="text-center text-sm text-muted-foreground mt-6">
          Нет аккаунта?{" "}
          <Link href="/register" className="text-purple-400 hover:text-purple-300 font-medium" data-testid="link-to-register">
            Зарегистрироваться
          </Link>
        </p>
      </div>
    </div>
  );
}

function TelegramLoginBtn() {
  const { refreshUser } = useAuth();
  const [, navigate] = useLocation();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (window as any).onTelegramAuth = async (tgUser: any) => {
      setLoading(true);
      try {
        const res = await apiRequest("POST", "/api/auth/telegram", tgUser);
        const data = await res.json();
        if (data.token) {
          localStorage.setItem("token", data.token);
          await refreshUser();
          navigate("/dashboard");
        }
      } catch {}
      setLoading(false);
    };
  }, []);

  const openTelegramLogin = () => {
    window.location.href = "/telegram-login";
  };

  return (
    <button
      type="button"
      onClick={openTelegramLogin}
      disabled={loading}
      className="w-full flex items-center justify-center gap-2 h-11 rounded-xl text-sm font-medium transition-colors hover:opacity-90"
      style={{ background: "#54a9eb", color: "white" }}
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.94 8.13l-1.97 9.28c-.15.67-.54.83-1.09.52l-3.01-2.22-1.45 1.4c-.16.16-.3.3-.61.3l.21-3.04 5.56-5.02c.24-.21-.05-.33-.37-.13l-6.87 4.33-2.96-.92c-.64-.2-.66-.64.14-.95l11.57-4.46c.53-.2 1-.05.85.91z"/></svg>
          Войти через Telegram
        </>
      )}
    </button>
  );
}
