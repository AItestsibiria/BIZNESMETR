import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { Loader2, LogIn, UserPlus } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

export function InlineAuth({ onSuccess }: { onSuccess?: () => void }) {
  const [tab, setTab] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { login, register } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (tab === "login") {
        await login(email.trim().toLowerCase(), password, remember);
      } else {
        await register(name.trim() || "", email.trim().toLowerCase(), password, undefined, remember);
      }
      onSuccess?.();
    } catch (err: any) {
      setError(err.message || "Ошибка");
    }
    setLoading(false);
  };

  return (
    <div className="glass-card rounded-xl p-5 mt-4 border border-purple-500/20" data-testid="inline-auth">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex gap-1 rounded-lg bg-white/5 p-0.5">
          <button
            type="button"
            className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
              tab === "register"
                ? "bg-purple-500/20 text-purple-300"
                : "text-muted-foreground hover:text-white"
            }`}
            onClick={() => { setTab("register"); setError(""); }}
          >
            <UserPlus className="w-3 h-3 inline mr-1" />
            Регистрация
          </button>
          <button
            type="button"
            className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
              tab === "login"
                ? "bg-purple-500/20 text-purple-300"
                : "text-muted-foreground hover:text-white"
            }`}
            onClick={() => { setTab("login"); setError(""); }}
          >
            <LogIn className="w-3 h-3 inline mr-1" />
            Войти
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          {tab === "register" ? "Дарим 1000 ₽ на счёт" : "Уже есть аккаунт?"}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {tab === "register" && (
          <div>
            <Label className="text-xs text-muted-foreground">Имя (автор)</Label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Ваше имя"
              className="h-9 bg-white/5 border-white/10 text-sm"
              data-testid="input-auth-name"
            />
          </div>
        )}
        <div>
          <Label className="text-xs text-muted-foreground">Email</Label>
          <Input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="email@example.com"
            required
            className="h-9 bg-white/5 border-white/10 text-sm"
            data-testid="input-auth-email"
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Пароль</Label>
          <Input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={tab === "register" ? "Минимум 6 символов" : "Ваш пароль"}
            required
            minLength={tab === "register" ? 6 : 1}
            className="h-9 bg-white/5 border-white/10 text-sm"
            data-testid="input-auth-password"
          />
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

        {/* Honeypot — hidden from humans, bots fill it */}
        <input type="text" name="website" autoComplete="off" className="absolute -left-[9999px] opacity-0 h-0 w-0" tabIndex={-1} />

        {error && <p className="text-xs text-red-400">{error}</p>}

        <Button
          type="submit"
          disabled={loading}
          className="w-full btn-gradient h-9 text-sm"
          data-testid="button-auth-submit"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : tab === "register" ? (
            "Зарегистрироваться и создать"
          ) : (
            "Войти и создать"
          )}
        </Button>
      </form>

      {/* Telegram Login */}
      <div className="mt-3 pt-3 border-t border-white/[0.06]">
        <TelegramLoginButton onSuccess={onSuccess} />
      </div>
    </div>
  );
}

function TelegramLoginButton({ onSuccess }: { onSuccess?: () => void }) {
  const { refreshUser } = useAuth();
  const [tgLoading, setTgLoading] = useState(false);

  useEffect(() => {
    // Listen for message from Telegram OAuth popup
    const handler = async (e: MessageEvent) => {
      if (e.origin !== "https://oauth.telegram.org") return;
      if (!e.data || typeof e.data !== "string") return;
      try {
        // Telegram sends JSON with user data
        const tgUser = JSON.parse(e.data);
        if (!tgUser.id) return;
        setTgLoading(true);
        const res = await apiRequest("POST", "/api/auth/telegram", tgUser);
        const data = await res.json();
        if (data.token) {
          localStorage.setItem("token", data.token);
          await refreshUser();
          onSuccess?.();
        }
        setTgLoading(false);
      } catch {}
    };
    window.addEventListener("message", handler);

    // Also expose global callback for widget fallback
    (window as any).onTelegramAuth = async (tgUser: any) => {
      setTgLoading(true);
      try {
        const res = await apiRequest("POST", "/api/auth/telegram", tgUser);
        const data = await res.json();
        if (data.token) {
          localStorage.setItem("token", data.token);
          await refreshUser();
          onSuccess?.();
        }
      } catch {}
      setTgLoading(false);
    };

    return () => window.removeEventListener("message", handler);
  }, []);

  const openTelegramLogin = () => {
    window.location.href = "/telegram-login";
  };

  return (
    <button
      type="button"
      onClick={openTelegramLogin}
      disabled={tgLoading}
      className="w-full flex items-center justify-center gap-2 h-10 rounded-xl text-sm font-medium transition-colors"
      style={{ background: "#54a9eb", color: "white" }}
    >
      {tgLoading ? (
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
