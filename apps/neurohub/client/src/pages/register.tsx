import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Music, Loader2, Gift, Eye, EyeOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function RegisterPage() {
  const { register, verifyRegister, login, user } = useAuth();
  const [verifyStep, setVerifyStep] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");
  const [, navigate] = useLocation();

  // Navigate to dashboard when user logs in
  useEffect(() => {
    if (user) navigate("/dashboard");
  }, [user, navigate]);
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [promo, setPromo] = useState("");
  const [remember, setRemember] = useState(true);
  // Eugene 2026-05-15 Босс «согласие на 152-ФЗ при регистрации».
  const [agreeToPDN, setAgreeToPDN] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Read referral code from URL: /#/r/CODE or /#/register/CODE
  const refCode = (() => {
    try {
      const hash = window.location.hash || "";
      // Match /#/r/CODE or /#/register/CODE
      const match = hash.match(/\#\/(?:r|register)\/([\w]+)/);
      if (match) return match[1];
      // Also check query param /#/register?ref=CODE
      const qIdx = hash.indexOf("?");
      if (qIdx !== -1) return new URLSearchParams(hash.slice(qIdx)).get("ref") || undefined;
      return undefined;
    } catch { return undefined; }
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      toast({ title: "Пароль минимум 6 символов", variant: "destructive" });
      return;
    }
    if (!email) {
      toast({ title: "Введите email", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const result = await register(name || email.split("@")[0], email, password, refCode, remember, promo || undefined);
      if (result?.needVerification) {
        setVerifyStep(true);
        toast({ title: "Код отправлен", description: result.message });
        setLoading(false);
        return;
      }
      toast({ title: "Добро пожаловать!" });
      navigate("/dashboard");
    } catch (err: any) {
      // If email already registered — try to login automatically
      if (err.message?.includes("409")) {
        try {
          await login(email, password);
          toast({ title: "С возвращением!" });
          navigate("/dashboard");
        } catch {
          toast({
            title: "Аккаунт уже существует",
            description: "Неверный пароль. Попробуйте войти или восстановите пароль.",
            variant: "destructive",
          });
        }
      } else {
        toast({
          title: "Ошибка",
          description: err.message,
          variant: "destructive",
        });
      }
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
          <h1 className="text-xl font-bold gradient-text" data-testid="text-register-title">Создать аккаунт</h1>
          <p className="text-sm text-muted-foreground mt-1">Присоединяйтесь к MuzaAi</p>
        </div>

        {verifyStep ? (
          <div className="gradient-border p-6 rounded-2xl space-y-4">
            <p className="text-sm text-center text-muted-foreground mb-2">Код отправлен на <span className="text-white font-medium">{email}</span></p>
            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">Введите 6-значный код</Label>
              <Input
                type="text" inputMode="numeric" maxLength={6}
                autoComplete="one-time-code"
                name="otp"
                value={verifyCode} onChange={e => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000" className="bg-background/50 border-white/10 text-center text-2xl tracking-[0.3em] font-bold"
                autoFocus
              />
            </div>
            <Button className="w-full btn-gradient" disabled={loading || verifyCode.length !== 6}
              onClick={async () => {
                setLoading(true);
                try {
                  await verifyRegister(email, verifyCode, remember);
                  toast({ title: "Добро пожаловать!" });
                  navigate("/dashboard");
                } catch (err: any) {
                  toast({ title: "Ошибка", description: err.message, variant: "destructive" });
                } finally { setLoading(false); }
              }}
            >{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Подтвердить"}</Button>
            <button onClick={() => setVerifyStep(false)} className="text-xs text-muted-foreground hover:text-white w-full text-center mt-2">Назад</button>
          </div>
        ) : (<>

        {/* Bonus badge */}
        <div className="flex items-center justify-center gap-2 mb-4 px-4 py-2 rounded-full border border-green-500/20 bg-green-500/5 mx-auto w-fit">
          <Gift className="w-4 h-4 text-green-400" />
          <span className="text-sm text-green-300 font-medium">🎁 Подарок 1000 рублей по промокоду</span>
        </div>
        {refCode && (
          <div className="flex items-center justify-center gap-2 mb-6 px-4 py-2 rounded-full border border-purple-500/20 bg-purple-500/5 mx-auto w-fit">
            <span className="text-sm text-purple-300">🎵 +1 трек в подарок по реферальной ссылке</span>
          </div>
        )}

        {/* Eugene 2026-05-15 Босс «внедри фронт по звонку» — primary CTA.
            Звонок — основной способ регистрации, email/password ниже как
            альтернатива. */}
        <Link
          href={`/register-phone${refCode ? `?ref=${refCode}` : ""}`}
          className="block gradient-border p-5 rounded-2xl mb-4 hover:bg-emerald-500/5 transition-colors group"
          data-testid="link-register-phone-primary"
        >
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500/30 to-cyan-500/30 flex items-center justify-center text-2xl">
              📞
            </div>
            <div className="flex-1">
              <p className="text-base font-semibold text-white group-hover:text-emerald-200">
                Регистрация по звонку
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Быстро и без пароля. РФ и СНГ.
              </p>
            </div>
            <span className="text-emerald-300 text-lg">→</span>
          </div>
        </Link>

        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 h-px bg-white/[0.08]" />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">или email/пароль</span>
          <div className="flex-1 h-px bg-white/[0.08]" />
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="gradient-border p-6 rounded-2xl space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name" className="text-sm text-muted-foreground">Имя <span className="text-muted-foreground/50">(необязательно)</span></Label>
            <Input
              id="name"
              type="text"
              placeholder="Ваше имя или ник"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="bg-background/50 border-white/10 input-glow"
              data-testid="input-name"
            />
          </div>
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
                placeholder="Минимум 6 символов"
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
          <div className="space-y-2">
            <Label htmlFor="promo" className="text-sm text-muted-foreground">Промокод <span className="text-muted-foreground/50">(если есть)</span></Label>
            <Input
              id="promo"
              type="text"
              placeholder="Введите промокод"
              value={promo}
              onChange={(e) => setPromo(e.target.value)}
              className="bg-background/50 border-white/10 input-glow"
              data-testid="input-promo"
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
          {/* Eugene 2026-05-15 Босс «согласие 152-ФЗ при регистрации».
              Обязательный чек-бокс — без него register заблокирован. */}
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={agreeToPDN}
              onChange={(e) => setAgreeToPDN(e.target.checked)}
              className="w-4 h-4 mt-0.5 rounded border-white/20 bg-white/5 accent-purple-500 shrink-0"
              data-testid="checkbox-agree-pdn"
            />
            <span className="text-[11px] text-muted-foreground leading-snug">
              Я согласен с обработкой персональных данных в соответствии с
              {" "}
              <Link href="/privacy" className="text-purple-300 hover:text-purple-200 underline">
                Политикой конфиденциальности
              </Link>
              {" "}и{" "}
              <Link href="/terms" className="text-purple-300 hover:text-purple-200 underline">
                Условиями использования
              </Link>
              {" "}(152-ФЗ).
            </span>
          </label>
          <Button
            type="submit"
            className="w-full btn-gradient rounded-xl h-11"
            disabled={loading || !agreeToPDN}
            data-testid="button-register"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Зарегистрироваться"}
          </Button>
        </form>

        </>)}

        <p className="text-center text-sm text-muted-foreground mt-6">
          Уже есть аккаунт?{" "}
          <Link href="/login" className="text-purple-400 hover:text-purple-300 font-medium" data-testid="link-to-login">
            Войти
          </Link>
        </p>
      </div>
    </div>
  );
}
