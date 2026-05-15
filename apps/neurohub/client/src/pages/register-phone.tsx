// Страница регистрации по телефону. Eugene 2026-05-15.
// Аналог /register, но flow: phone → SMS-OTP → создание users record → token.
//
// Ссылка снизу — переключение на /register (email-вариант).

import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { Music, Phone, Mail, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import PhoneOtpForm from "@/components/phone-otp-form";

export default function RegisterPhonePage() {
  const { user, isLoading, loginByToken } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  // Eugene 2026-05-15 Босс «согласие 152-ФЗ при регистрации».
  const [agreeToPDN, setAgreeToPDN] = useState(false);

  useEffect(() => {
    if (user) navigate("/dashboard");
  }, [user, navigate]);

  // Eugene 2026-05-15 Босс «при повторном входе не надо звонить» — loader
  // вместо формы пока isLoading или user уже есть.
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
          <h1 className="text-xl font-bold gradient-text">Регистрация по телефону</h1>
          <p className="text-sm text-muted-foreground mt-1">Подтверждение по входящему звонку — РФ и СНГ</p>
        </div>

        <div className="gradient-border p-6 rounded-2xl space-y-4">
          {/* Eugene 2026-05-15 Босс «согласие 152-ФЗ при регистрации».
              Чек-бокс ДО формы — если не согласен, форма заблокирована
              через div.opacity-40 pointer-events-none. */}
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
                Политикой
              </Link>
              {" "}и{" "}
              <Link href="/terms" className="text-purple-300 hover:text-purple-200 underline">
                Условиями использования
              </Link>
              {" "}(152-ФЗ). Без согласия регистрация невозможна.
            </span>
          </label>

          <div className={agreeToPDN ? "" : "opacity-40 pointer-events-none select-none"} aria-disabled={!agreeToPDN}>
          <PhoneOtpForm
            purpose="register"
            allowMethods="call"
            phoneSubmitLabel="Получить звонок"
            submitLabel="Зарегистрироваться"
            onVerified={async ({ phone, token, alreadyExists }) => {
              if (!token) {
                toast({
                  title: "Аккаунт создан, но войти не удалось",
                  description: "Попробуй войти по тому же номеру",
                  variant: "destructive",
                });
                navigate("/login-phone");
                return;
              }
              const u = await loginByToken(token, true);
              toast({
                title: alreadyExists ? "С возвращением!" : "Добро пожаловать!",
                description: `Аккаунт ${u?.name || phone}`,
              });
              navigate("/dashboard");
            }}
          />
          </div>
          <div className="pt-3 border-t border-white/10 space-y-2">
            <Link href="/login-phone">
              <a className="block text-center text-sm text-muted-foreground hover:text-white">
                <Phone className="w-3.5 h-3.5 inline mr-1" />
                Уже есть аккаунт? Войти по телефону
              </a>
            </Link>
            <Link href="/register">
              <a className="block text-center text-sm text-muted-foreground hover:text-white">
                <Mail className="w-3.5 h-3.5 inline mr-1" />
                Зарегистрироваться по email
              </a>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
