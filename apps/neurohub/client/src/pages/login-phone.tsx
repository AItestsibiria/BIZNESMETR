// Страница входа по телефону. Eugene 2026-05-15.
// Flow: phone → callcheck (звонок на наш номер) → backend ищет users.phone
// → если найден: login. Если не найден: UPSERT (создаём phone-only акк) +
// флаг newAccount=true → сразу navigate в /dashboard, banner про linking
// показывается там (не блокирует auth-flow).
//
// Eugene 2026-05-15 fix: «после ответ такой вы авторизованы и ничего не
// происходит» — раньше modal link-existing блокировал redirect. Теперь
// сразу /dashboard + toast про возможность связать email в настройках.

import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { Music, Phone, Mail, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import PhoneOtpForm from "@/components/phone-otp-form";

export default function LoginPhonePage() {
  const { user, isLoading, loginByToken } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  // Eugene 2026-05-15 Босс «после сообщения вы авторизованы открывай ЛК».
  // Success-state — большой экран «Авторизация прошла → открываем кабинет…»
  // + fallback кнопка если auto-navigate тормозит.
  const [successState, setSuccessState] = useState<{ name: string } | null>(null);

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
          <Loader2 className="w-8 h-8 animate-spin text-purple-300 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">Проверяем сессию…</p>
        </div>
      </div>
    );
  }
  if (user) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 pt-16 hero-gradient">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-purple-300 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">Вы уже вошли — переход в кабинет…</p>
        </div>
      </div>
    );
  }
  // Eugene 2026-05-15 Босс «после сообщения вы авторизованы открывай ЛК».
  // Большой success-screen с success иконкой + auto-redirect через 1.2 сек.
  if (successState) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 pt-16 hero-gradient">
        <div className="text-center max-w-md mx-auto p-6">
          <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-gradient-to-br from-emerald-500/30 to-cyan-500/30 border-2 border-emerald-400/60 flex items-center justify-center shadow-[0_0_40px_rgba(16,185,129,0.4)] animate-in zoom-in duration-300">
            <span className="text-4xl">✅</span>
          </div>
          <h2 className="text-2xl font-bold gradient-text mb-2">Вы авторизованы</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Добро пожаловать, <span className="text-white font-medium">{successState.name}</span>!
          </p>
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            Открываем личный кабинет…
          </div>
          <button
            onClick={() => navigate("/dashboard")}
            className="mt-5 text-sm text-purple-300 hover:text-purple-200 underline"
          >
            Перейти сейчас →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 pt-16 hero-gradient">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center mx-auto mb-4">
            <Music className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-xl font-bold gradient-text">Вход по телефону</h1>
          <p className="text-sm text-muted-foreground mt-1">Вы звоните нам — бесплатно, без пароля. РФ и СНГ</p>
        </div>

        <div className="gradient-border p-6 rounded-2xl space-y-4">
          <PhoneOtpForm
            purpose="login"
            allowMethods="call"
            phoneSubmitLabel="Получить звонок"
            submitLabel="Войти"
            onVerified={async ({ phone, token, newAccount }) => {
              if (!token) {
                toast({ title: "Не удалось войти", description: "Попробуйте через минуту", variant: "destructive" });
                return;
              }
              const u = await loginByToken(token, true);
              // Eugene 2026-05-15 Босс «после сообщения вы авторизованы
              // открывай личный кабинет». Большой success-state + auto-navigate
              // через 1.2 сек (даёт юзеру увидеть подтверждение).
              setSuccessState({ name: u?.name || (newAccount ? "новый автор" : phone) });
              setTimeout(() => navigate("/dashboard"), 1200);
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
