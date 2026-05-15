// Страница входа по телефону. Eugene 2026-05-15.
// Flow: phone → SMS-OTP → backend ищет users.phone → token.

import { useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { Music, Phone, Mail } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import PhoneOtpForm from "@/components/phone-otp-form";

export default function LoginPhonePage() {
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
          <h1 className="text-xl font-bold gradient-text">Вход по телефону</h1>
          <p className="text-sm text-muted-foreground mt-1">Подтверждение по входящему звонку — РФ и СНГ</p>
        </div>

        <div className="gradient-border p-6 rounded-2xl space-y-4">
          {/* Eugene 2026-05-15 Босс «авторизацию по SMS убираем с фронта,
              в будущем дожмем». allowMethods='call' скрывает toggle и
              использует только flashcall. SMS backend остаётся. */}
          <PhoneOtpForm
            purpose="login"
            allowMethods="call"
            phoneSubmitLabel="Получить звонок"
            submitLabel="Войти"
            onVerified={async ({ phone, token }) => {
              if (!token) {
                toast({ title: "Не удалось войти", description: "Попробуйте через минуту", variant: "destructive" });
                return;
              }
              const u = await loginByToken(token, true);
              toast({ title: "С возвращением!", description: u?.name || phone });
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
