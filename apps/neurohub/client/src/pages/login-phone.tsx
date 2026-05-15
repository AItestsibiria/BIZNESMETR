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
  return (
    <div className="min-h-screen flex items-center justify-center px-4 pt-16 hero-gradient">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center mx-auto mb-4">
            <Music className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-xl font-bold gradient-text">Вход по телефону</h1>
          <p className="text-sm text-muted-foreground mt-1">Подтверждение по исходящему звонку — РФ и СНГ</p>
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
              // Eugene 2026-05-15 Босс «есть сообщение Вы авторизованы, но
              // кабинет нужно открыть». Toast переживает navigate — юзер
              // видит подтверждение УЖЕ в кабинете. Без setTimeout-delay.
              toast({
                title: "✅ Вы авторизованы",
                description: `Добро пожаловать, ${u?.name || phone}!`,
                duration: 3500,
              });
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
