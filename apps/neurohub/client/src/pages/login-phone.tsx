// Страница входа по телефону. Eugene 2026-05-15.
// Flow: phone → callcheck (звонок на наш номер) → backend ищет users.phone
// → если найден: login. Если не найден: UPSERT (создаём phone-only акк) +
// флаг newAccount=true → UI предлагает связать с существующим email.

import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { Music, Phone, Mail, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import PhoneOtpForm from "@/components/phone-otp-form";

export default function LoginPhonePage() {
  const { user, loginByToken } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Eugene 2026-05-15 Босс «связать email и номер, лёгкое надёжное решение».
  // Если call-login создал новый аккаунт (phone был не найден в users) —
  // показываем модалку: «у вас уже есть email-аккаунт? Свяжите его».
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkEmail, setLinkEmail] = useState("");
  const [linkPassword, setLinkPassword] = useState("");
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [newPhone, setNewPhone] = useState<string>("");

  useEffect(() => {
    if (user && !linkOpen) navigate("/dashboard");
  }, [user, navigate, linkOpen]);

  const handleLink = async () => {
    setLinkError(null);
    if (!linkEmail || !linkPassword) {
      setLinkError("Заполните email и пароль");
      return;
    }
    setLinkLoading(true);
    try {
      const r = await apiRequest("POST", "/api/auth/link-existing", { email: linkEmail.trim(), password: linkPassword });
      const j = await r.json();
      if (j?.ok && j?.token) {
        await loginByToken(j.token, true);
        toast({ title: "Аккаунты объединены", description: "Телефон привязан к вашему email-аккаунту" });
        setLinkOpen(false);
        navigate("/dashboard");
      } else {
        setLinkError(j?.message || "Не удалось связать");
      }
    } catch (e: any) {
      setLinkError(String(e?.message || "Ошибка"));
    } finally {
      setLinkLoading(false);
    }
  };

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
              if (newAccount) {
                // Backend создал phone-only аккаунт через upsert. Предлагаем
                // связать с существующим email-аккаунтом (если есть).
                setNewPhone(phone);
                setLinkOpen(true);
              } else {
                toast({ title: "С возвращением!", description: u?.name || phone });
                navigate("/dashboard");
              }
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

      {/* Eugene 2026-05-15 Босс «связать email и номер». Модалка показывается
          после успешного call-login если backend создал новый phone-аккаунт
          (юзер ранее был зарегистрирован по email — пусть свяжет). */}
      <Dialog open={linkOpen} onOpenChange={(o) => {
        if (!o && !linkLoading) {
          setLinkOpen(false);
          navigate("/dashboard");
        }
      }}>
        <DialogContent className="glass-card border-emerald-500/30 max-w-md">
          <DialogHeader>
            <DialogTitle className="gradient-text text-base flex items-center gap-2">
              🔗 Связать с email-аккаунтом?
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground pt-2">
              Мы создали новый аккаунт для номера <span className="text-white font-medium">{newPhone}</span>.
              Если у вас уже был аккаунт на этом сайте по email — введите его данные, чтобы связать.
              Иначе пропустите шаг — новый аккаунт уже работает.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Email от существующего аккаунта</Label>
              <Input
                type="email"
                placeholder="you@example.com"
                value={linkEmail}
                onChange={e => setLinkEmail(e.target.value)}
                className="bg-background/50 border-white/10"
                disabled={linkLoading}
                autoComplete="email"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Пароль</Label>
              <Input
                type="password"
                placeholder="••••••••"
                value={linkPassword}
                onChange={e => setLinkPassword(e.target.value)}
                className="bg-background/50 border-white/10"
                disabled={linkLoading}
                autoComplete="current-password"
              />
            </div>
            {linkError && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {linkError}
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                className="flex-1 border-white/10"
                disabled={linkLoading}
                onClick={() => { setLinkOpen(false); navigate("/dashboard"); }}
              >
                Пропустить
              </Button>
              <Button
                className="flex-1 btn-gradient"
                disabled={linkLoading || !linkEmail || !linkPassword}
                onClick={handleLink}
              >
                {linkLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Связать"}
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground text-center pt-1">
              При связывании: все ваши треки переедут в email-аккаунт, phone-аккаунт удалится. Это безопасно и обратимо через поддержку.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
