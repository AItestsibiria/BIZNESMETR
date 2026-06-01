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
import { Music, Phone, Mail, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import PhoneOtpForm from "@/components/phone-otp-form";
import { CyberSpinner } from "@/components/cyber-spinner";
import Admin2FAForm from "@/components/admin-2fa-form";

export default function LoginPhonePage() {
  const { user, isLoading, loginByToken } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Eugene 2026-05-17 Босс «если автор то приветствуй по имени».
  // greeting=null → анонимный шаг. greeting={name, maskedPhone} →
  // нашли author по phone-check (POST /phone-check) → меняем UI.
  const [greeting, setGreeting] = useState<{ name: string; maskedPhone: string } | null>(null);

  // Eugene 2026-05-18 Босс — admin reverse-call: backend возвращает
  // requireAdminCode=true вместо token. Раньше показывалось «Сессия не выдана»
  // потому что handler не был подключён.
  const [admin2FA, setAdmin2FA] = useState<{
    sessionDraftId: string;
    emailHint?: string;
    expiresInSec?: number;
    warning?: string;
  } | null>(null);

  const handleAdmin2FAVerified = async (data: { token: string }) => {
    const u = await loginByToken(data.token, true);
    if (!u) {
      toast({ title: "Сессия не подтвердилась", description: "Попробуйте ещё раз.", variant: "destructive" });
      return;
    }
    toast({ title: "✅ Admin-вход выполнен", description: u.name || u.email });
    navigate("/dashboard");
  };

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
                С номера <span className="font-mono text-white/80">{greeting.maskedPhone}</span> — позвоните на наш 8800 для входа.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-2xl sm:text-3xl font-display font-bold gradient-text">Вход по телефону</h1>
              <p className="text-sm text-muted-foreground mt-2 font-sans">Подтверждение исходящим звонком с вашего номера на наш 8800 — РФ и СНГ</p>
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

        {admin2FA ? (
          <div className="gradient-border p-6 rounded-2xl">
            <Admin2FAForm
              sessionDraftId={admin2FA.sessionDraftId}
              emailHint={admin2FA.emailHint}
              expiresInSec={admin2FA.expiresInSec}
              warning={admin2FA.warning}
              onVerified={handleAdmin2FAVerified}
              onCancel={() => setAdmin2FA(null)}
            />
          </div>
        ) : (
        <div className="gradient-border p-6 rounded-2xl space-y-4">
          <div className="rounded-xl bg-purple-500/10 border border-purple-400/30 px-3 py-3 text-xs text-purple-100/90 leading-relaxed">
            🛡 Звонок бесплатный для вас. Введите свой номер ниже — мы покажем наш 8800. Позвоните на него с этого телефона и сразу можно сбросить: мы узнаем ваш номер по caller-id и автоматически подтвердим вход. SMS не приходит, коды не нужны.
          </div>

          <PhoneOtpForm
            purpose="login"
            allowMethods="call"
            phoneSubmitLabel="📞 ПОКАЗАТЬ НОМЕР 8800"
            submitLabel="Войти"
            onPhoneChecked={({ exists, name, maskedPhone }) => {
              if (exists && name && maskedPhone) {
                setGreeting({ name, maskedPhone });
              } else if (!exists && greeting) {
                setGreeting(null);
              }
            }}
            onVerified={async ({ phone, token, newAccount, requireAdminCode, sessionDraftId, emailHint, expiresInSec, warning }) => {
              // Eugene 2026-05-18 Босс — admin reverse-call 2FA gate.
              // Backend при admin-role возвращает requireAdminCode без token →
              // показываем Admin2FAForm для ввода email-кода.
              if (requireAdminCode && sessionDraftId) {
                setAdmin2FA({ sessionDraftId, emailHint, expiresInSec, warning });
                toast({
                  title: "🔐 Требуется код из email",
                  description: `Мы отправили 6-значный код на ${emailHint || "ваш email"}. Введите его ниже.`,
                });
                return;
              }
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
          {/* Eugene 2026-05-18 Босс «авторизация через Telegram как вариант
              при вводе номера» — Telegram-OAuth fallback если звонок не работает
              (роуминг / нет тарифа / планшет без SIM). */}
          <a
            href="/telegram-login"
            className="block gradient-border p-4 rounded-2xl hover:bg-cyan-500/5 transition-colors group"
            data-testid="link-login-via-telegram"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/30 to-blue-500/30 flex items-center justify-center">
                <Send className="w-5 h-5 text-cyan-300" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-white group-hover:text-cyan-200">
                  Войти через Telegram
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Если звонок не проходит — нажмите. Бот авторизует за 5 секунд.
                </p>
              </div>
              <span className="text-cyan-300 text-base">→</span>
            </div>
          </a>
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
        )}
      </div>
    </div>
  );
}
