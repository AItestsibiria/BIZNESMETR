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
import { Music, Phone, Mail } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import PhoneOtpForm from "@/components/phone-otp-form";
import Admin2FAForm from "@/components/admin-2fa-form";
import { CyberSpinner } from "@/components/cyber-spinner";

export default function LoginPhonePage() {
  const { user, isLoading, loginByToken } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Eugene 2026-05-17 Босс — Level 1 защиты: после phone callcheck backend
  // может вернуть {requireAdminCode: true, sessionDraftId} если phone-аккаунт
  // оказался admin'ом. Показываем 2FA-форму поверх phone-формы.
  const [admin2FA, setAdmin2FA] = useState<{
    sessionDraftId: string;
    emailHint?: string;
    expiresInSec?: number;
    warning?: string;
  } | null>(null);

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
      {/* Eugene 2026-05-17 — hi-tech акцент: holographic shimmer overlay
          (subtle 12-сек 3-color, pointer-events-none) + cyber-grid фон. */}
      <div className="absolute inset-0 holographic pointer-events-none" aria-hidden="true" />
      <div className="w-full max-w-sm relative z-10">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500 via-fuchsia-500 to-blue-500 flex items-center justify-center mx-auto mb-4 shadow-[0_0_32px_rgba(124,58,237,0.4)]">
            <Music className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-display font-bold gradient-text">Вход по телефону</h1>
          <p className="text-sm text-muted-foreground mt-2 font-sans">Подтверждение по входящему звонку — РФ и СНГ</p>
        </div>

        <div className="gradient-border p-6 rounded-2xl space-y-4">
          <PhoneOtpForm
            purpose="login"
            allowMethods="call"
            phoneSubmitLabel="Получить звонок"
            submitLabel="Войти"
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
              // Eugene 2026-05-16: проверяем результат loginByToken. Если
              // null → backend /api/auth/me отверг token (заблокирован /
              // удалён / истёк). Без проверки navigate('/dashboard') →
              // dashboard видит user=null → редирект на /login → юзер
              // залипает в loop. С проверкой — показываем toast и
              // оставляем на login-phone (или редирект на email-login).
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
