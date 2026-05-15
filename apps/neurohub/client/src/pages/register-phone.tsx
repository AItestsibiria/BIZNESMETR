// Страница регистрации по телефону. Eugene 2026-05-15.
// Аналог /register, но flow: phone → SMS-OTP → создание users record → token.
//
// Ссылка снизу — переключение на /register (email-вариант).

import { useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { Music, Phone, Mail } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import PhoneOtpForm from "@/components/phone-otp-form";

export default function RegisterPhonePage() {
  const { user, loginByToken } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    if (user) navigate("/dashboard");
  }, [user, navigate]);

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
          {/* Eugene 2026-05-15 Босс «авторизацию по SMS убираем с фронта,
              в будущем дожмем». allowMethods='call' скрывает toggle и
              использует только flashcall. SMS backend остаётся. */}
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
