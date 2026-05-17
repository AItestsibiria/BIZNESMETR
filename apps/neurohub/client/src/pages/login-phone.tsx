// Страница входа по телефону. Eugene 2026-05-15.
// Flow: phone → callcheck (sms.ru звонит на номер юзера, classical flashcall)
// → backend ищет users.phone → если найден: login. Если не найден: UPSERT
// (создаём phone-only акк) + флаг newAccount=true → сразу navigate в /dashboard,
// banner про linking показывается там (не блокирует auth-flow).
//
// Eugene 2026-05-17 Босс «Нам никто не звонит» + «если автор то приветствуй
// по имени»: classical flashcall (мы звоним юзеру), большой 📞 image с halo,
// «ЗВОНОК БЕСПЛАТНЫЙ» баннер крупным шрифтом, pulse-glow на номере, greeting
// по имени если автор существует.

import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { Music, Phone, Mail } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import PhoneOtpForm from "@/components/phone-otp-form";
import { CyberSpinner } from "@/components/cyber-spinner";

export default function LoginPhonePage() {
  const { user, isLoading, loginByToken } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Eugene 2026-05-17 Босс «если автор то приветствуй по имени».
  // greeting=null → анонимный шаг. greeting={name, maskedPhone} →
  // нашли author по phone-check (POST /phone-check) → меняем UI.
  const [greeting, setGreeting] = useState<{ name: string; maskedPhone: string } | null>(null);

  useEffect(() => {
    if (user) navigate("/dashboard");
  }, [user, navigate]);

  // Eugene 2026-05-15 Босс «если клиент авторизировался, при повторном входе
  // не надо звонить». Если token уже есть в cookie (cookie 90 дней) и
  // backend подтвердил его валидность → early-redirect без показа формы.
  // isLoading=true пока useEffect в AuthProvider дёргает /api/auth/me.
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 pt-16 hero-gradient">
        <div className="text-center">
          <CyberSpinner sizePx={36} className="mx-auto mb-3" label="Проверяем сессию" />
          <p className="text-sm text-muted-foreground">Проверяем сессию…</p>
        </div>
      </div>
    );
  }
  if (user) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 pt-16 hero-gradient">
        <div className="text-center">
          <CyberSpinner sizePx={36} className="mx-auto mb-3" label="Переход в кабинет" />
          <p className="text-sm text-muted-foreground">Вы уже вошли — переход в кабинет…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 pt-16 hero-gradient cyber-grid relative">
      {/* Eugene 2026-05-17 — hi-tech акцент: holographic shimmer overlay + cyber-grid. */}
      <div className="absolute inset-0 holographic pointer-events-none" aria-hidden="true" />
      <div className="w-full max-w-sm relative z-10">
        <div className="text-center mb-8">
          {/* Eugene 2026-05-17 Босс «образ главной двери» — большой 📞 emoji
              с purple glow halo. Visual focal point. */}
          <div className="relative mx-auto mb-4 flex items-center justify-center" style={{ width: "10rem", height: "10rem" }}>
            <div
              className="absolute inset-0 rounded-full bg-gradient-to-br from-purple-500/30 via-fuchsia-500/20 to-blue-500/30 blur-2xl"
              aria-hidden="true"
            />
            <div
              className="relative flex items-center justify-center w-32 h-32 rounded-full bg-gradient-to-br from-purple-500/20 via-fuchsia-500/10 to-blue-500/20 border-2 border-purple-300/40 shadow-[0_0_48px_rgba(124,58,237,0.5)]"
              data-testid="hero-door-icon"
            >
              <span className="text-7xl leading-none select-none" aria-hidden="true">📞</span>
            </div>
            <div className="absolute -bottom-1 -right-1 w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-500 via-fuchsia-500 to-blue-500 flex items-center justify-center shadow-[0_0_24px_rgba(124,58,237,0.6)]">
              <Music className="w-6 h-6 text-white" />
            </div>
          </div>

          {greeting ? (
            <>
              <h1 className="text-2xl sm:text-3xl font-display font-bold gradient-text" data-testid="greeting-heading">
                Привет, {greeting.name}! С возвращением 👋
              </h1>
              <p className="text-sm text-muted-foreground mt-2 font-sans">
                Сейчас мы позвоним на ваш номер{" "}
                <span className="font-mono text-white/80">{greeting.maskedPhone}</span> для входа.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-2xl sm:text-3xl font-display font-bold gradient-text">Вход по телефону</h1>
              <p className="text-sm text-muted-foreground mt-2 font-sans">Подтверждение по входящему звонку — РФ и СНГ</p>
            </>
          )}

          {/* Eugene 2026-05-17 «ЗВОНОК БЕСПЛАТНЫЙ» — amber→cyan + neon-text. */}
          <div className="mt-5">
            <p
              className="text-3xl md:text-5xl font-display font-bold bg-gradient-to-r from-amber-400 via-amber-300 to-cyan-400 bg-clip-text text-transparent neon-text tracking-wider"
              data-testid="banner-call-free-hero"
            >
              ЗВОНОК БЕСПЛАТНЫЙ
            </p>
            <p className="text-xs text-amber-200/70 mt-1 font-sans">Мы платим за вас — вам ничего не спишется</p>
          </div>
        </div>

        <div className="gradient-border p-6 rounded-2xl space-y-4">
          <div className="rounded-xl bg-purple-500/10 border border-purple-400/30 px-3 py-3 text-xs text-purple-100/90 leading-relaxed">
            🛡 Звонок полностью бесплатный — мы платим за вас. SMS не отправляется. Просто примите вызов или сбросьте его — мы автоматически подтвердим вход.
          </div>

          <PhoneOtpForm
            purpose="login"
            allowMethods="call"
            phoneSubmitLabel="📞 ПОЛУЧИТЬ ЗВОНОК"
            submitLabel="Войти"
            onPhoneChecked={({ exists, name, maskedPhone }) => {
              if (exists && name && maskedPhone) {
                setGreeting({ name, maskedPhone });
              } else if (!exists && greeting) {
                setGreeting(null);
              }
            }}
            onVerified={async ({ phone, token, newAccount }) => {
              // Eugene 2026-05-16: guard на пустой token — backend в очень
              // редких случаях может вернуть verified без token (race).
              // Без guard юзер видел «вы авторизованы» и залипал.
              if (!token) {
                // eslint-disable-next-line no-console
                console.warn("[AUTH] login-phone: onVerified received empty token");
                toast({
                  title: "Не удалось войти",
                  description: "Сессия не выдана. Попробуйте ещё раз или войдите через email.",
                  variant: "destructive",
                });
                return;
              }
              // eslint-disable-next-line no-console
              console.log("[AUTH] login-phone: onVerified, calling loginByToken");
              const u = await loginByToken(token, true);
              if (!u) {
                toast({
                  title: "Сессия не подтвердилась",
                  description: "Попробуйте ещё раз или войдите через email.",
                  variant: "destructive",
                });
                return;
              }
              // eslint-disable-next-line no-console
              console.log("[AUTH] login-phone: navigate to /dashboard, user id:", u.id);
              if (newAccount) {
                toast({
                  title: "✅ Вход выполнен — добро пожаловать!",
                  description: "Новый аккаунт создан. Если у вас был аккаунт по email — свяжите в Настройках.",
                });
              } else {
                toast({ title: "✅ С возвращением!", description: u?.name || phone });
              }
              navigate("/dashboard");
            }}
          />
          <div className="pt-3 border-t border-white/10 space-y-2">
            <Link href="/register-phone">
              <a className="block text-center text-sm text-muted-foreground hover:text-white">
                <Phone className="w-3.5 h-3.5 inline mr-1" />
                Нет аккаунта? Зарегистрироваться по телефону
              </a>
            </Link>
            <Link href="/login">
              <a className="block text-center text-sm text-muted-foreground hover:text-white">
                <Mail className="w-3.5 h-3.5 inline mr-1" />
                Войти по email
              </a>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
