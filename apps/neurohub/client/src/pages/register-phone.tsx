// Страница регистрации по телефону. Eugene 2026-05-15.
// Аналог /register, но flow: phone → SMS-OTP → создание users record → token.
//
// Ссылка снизу — переключение на /register (email-вариант).
//
// Eugene 2026-05-17 Босс «Нам никто не звонит» + «если автор то приветствуй
// по имени»:
//   1. После ввода phone форма делает POST /api/auth/sms/phone-check (быстрый
//      lookup, no auth). Если автор уже есть → меняем UI на greeting-mode:
//      «Привет, Иван! С возвращением 👋» + кнопка «📞 Получить звонок для входа».
//      После successful verify → toast «С возвращением» + navigate /dashboard.
//   2. Визуально усиливаем: «ЗВОНОК БЕСПЛАТНЫЙ» крупным баннером (amber→cyan
//      gradient + neon-text), большой 📞 emoji glow halo, pulse-glow на номере
//      для звонка, explainer «Просто примите вызов», prominent CTA-кнопка.

import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { Music, Phone, Mail, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import PhoneOtpForm from "@/components/phone-otp-form";
import { CyberSpinner } from "@/components/cyber-spinner";

// Eugene 2026-05-18 Босс «Муза сохраняет тексты — UI часть».
// После phone-регистрации делаем claim текстов которые юзер мог надиктовать
// Музе в анонимной сессии: ?recovery=<6-digit> либо ?recovery_lyrics=1 +
// sessionStorage._pendingLyrics. См. одноимённую функцию в register.tsx.
async function tryClaimSavedLyricsPhone(toast: ReturnType<typeof useToast>["toast"]): Promise<void> {
  try {
    const hash = window.location.hash || "";
    const qIdx = hash.indexOf("?");
    const qs = qIdx !== -1 ? new URLSearchParams(hash.slice(qIdx)) : new URLSearchParams();
    const recoveryCode = qs.get("recovery");
    if (recoveryCode && /^\d{6}$/.test(recoveryCode)) {
      try {
        const r = await apiRequest("POST", "/api/lyrics/claim", { code: recoveryCode });
        const j = await r.json();
        if (r.ok && j?.data) {
          toast({ title: `Восстановили текст «${j.data.title}» в твоём кабинете 🎵` });
          return;
        }
      } catch {}
    }
    if (qs.get("recovery_lyrics") === "1") {
      try {
        const raw = sessionStorage.getItem("_pendingLyrics");
        if (raw) {
          const p = JSON.parse(raw);
          if (p && p.title && p.text) {
            const r = await apiRequest("POST", "/api/lyrics/save", {
              title: p.title,
              text: p.text,
              source: "musa_chat_register",
            });
            if (r.ok) {
              toast({ title: `Сохранили «${p.title}» в твой кабинет 🎵` });
              sessionStorage.removeItem("_pendingLyrics");
              return;
            }
          }
        }
      } catch {}
    }
  } catch {}
}

export default function RegisterPhonePage() {
  const { user, isLoading, loginByToken } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  // Eugene 2026-05-15 Босс «согласие 152-ФЗ при регистрации».
  const [agreeToPDN, setAgreeToPDN] = useState(false);
  // Eugene 2026-05-17 Босс «если автор то приветствуй по имени».
  // greeting=null → обычная регистрация. greeting={name, maskedPhone} →
  // existing user, UI в login-mode.
  const [greeting, setGreeting] = useState<{ name: string; maskedPhone: string } | null>(null);

  useEffect(() => {
    if (!user) return;
    // Eugene 2026-05-18: claim сохранённых текстов до перехода.
    (async () => {
      await tryClaimSavedLyricsPhone(toast);
      navigate("/dashboard");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Eugene 2026-05-15 Босс «при повторном входе не надо звонить» — loader
  // вместо формы пока isLoading или user уже есть.
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
          {/* Eugene 2026-05-17 Босс «образ главной двери» — большой 📞 emoji
              size 8rem с purple glow halo. Visual focal point: юзер сразу
              понимает что это «вход через телефон / звонок». */}
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
              <h1 className="text-2xl sm:text-3xl font-display font-bold gradient-text">Регистрация по телефону</h1>
              <p className="text-sm text-muted-foreground mt-2 font-sans">Подтверждение исходящим звонком с вашего номера на наш 8800 — РФ и СНГ</p>
            </>
          )}

          {/* Eugene 2026-05-17 Босс «ЗВОНОК БЕСПЛАТНЫЙ» крупным баннером —
              amber→cyan gradient + neon-text hi-tech акцент. Снимает страх
              «а сколько спишут?».
              Eugene 2026-05-20 (I2 fix): добавлен attention-animation
              free-call-attention — subtle pulse каждые 5 сек чтобы баннер
              стал визуально активным focal point. */}
          <div className="mt-5">
            <p
              className="text-3xl md:text-5xl font-display font-bold bg-gradient-to-r from-amber-400 via-amber-300 to-cyan-400 bg-clip-text text-transparent neon-text tracking-wider free-call-attention"
              data-testid="banner-call-free-hero"
            >
              ЗВОНОК БЕСПЛАТНЫЙ
            </p>
            <p className="text-xs text-amber-200/70 mt-1 font-sans">Мы платим за вас — вам ничего не спишется</p>
          </div>
        </div>

        <div className="gradient-border p-6 rounded-2xl space-y-4">
          {/* Explainer — снимает 80% вопросов «зачем мне звонят». */}
          <div className="rounded-xl bg-purple-500/10 border border-purple-400/30 px-3 py-3 text-xs text-purple-100/90 leading-relaxed">
            🛡 Звонок бесплатный для вас. Введите свой номер ниже — мы покажем наш 8800. Позвоните на него с этого телефона и сразу можно сбросить: мы узнаем ваш номер по caller-id и автоматически подтвердим вход. SMS не приходит, коды не нужны.
          </div>

          {/* Eugene 2026-05-15 Босс «согласие 152-ФЗ при регистрации».
              Чек-бокс ДО формы — если не согласен, форма заблокирована
              через div.opacity-40 pointer-events-none.
              Для greeting-mode (existing user, login-flow) согласие уже было
              дано при регистрации — скрываем чек-бокс. */}
          {!greeting && (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={agreeToPDN}
                onChange={(e) => setAgreeToPDN(e.target.checked)}
                className="w-4 h-4 mt-0.5 rounded border-white/20 bg-white/5 accent-purple-500 shrink-0"
                data-testid="checkbox-agree-pdn"
              />
              <span className="text-[11px] text-muted-foreground leading-snug">
                Я даю{" "}
                <Link href="/consent" className="text-purple-300 hover:text-purple-200 underline">
                  Согласие на обработку ПДн
                </Link>
                {" "}в соответствии с
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
          )}

          <div className={greeting || agreeToPDN ? "" : "opacity-40 pointer-events-none select-none"} aria-disabled={!greeting && !agreeToPDN}>
          <PhoneOtpForm
            // Eugene 2026-05-17 Босс: purpose динамически — existing user
            // (greeting !== null) → login, иначе register. Backend различает
            // (login: ищет existing; register: создаёт нового).
            purpose={greeting ? "login" : "register"}
            allowMethods="call"
            phoneSubmitLabel={greeting ? "📞 Показать номер 8800 для входа" : "📞 ПОКАЗАТЬ НОМЕР 8800"}
            submitLabel={greeting ? "Войти" : "Зарегистрироваться"}
            onPhoneChecked={({ exists, name, maskedPhone }) => {
              if (exists && name && maskedPhone) {
                setGreeting({ name, maskedPhone });
              } else if (!exists && greeting) {
                // Юзер сменил номер на новый — сбрасываем greeting.
                setGreeting(null);
              }
            }}
            onVerified={async ({ phone, token, alreadyExists, newAccount }) => {
              if (!token) {
                // eslint-disable-next-line no-console
                console.warn("[AUTH] register-phone: onVerified empty token");
                toast({
                  title: "Аккаунт создан, но войти не удалось",
                  description: "Попробуй войти по тому же номеру",
                  variant: "destructive",
                });
                navigate("/login-phone");
                return;
              }
              // eslint-disable-next-line no-console
              console.log("[AUTH] register-phone: onVerified, calling loginByToken");
              const u = await loginByToken(token, true);
              // Eugene 2026-05-16: если /api/auth/me отверг token —
              // редирект на /login-phone (там можно попробовать снова).
              // Без guard navigate('/dashboard') → редирект на /login →
              // юзер залипает.
              if (!u) {
                toast({
                  title: "Сессия не подтвердилась",
                  description: "Попробуйте войти по тому же номеру.",
                  variant: "destructive",
                });
                navigate("/login-phone");
                return;
              }
              // eslint-disable-next-line no-console
              console.log("[AUTH] register-phone: navigate to /dashboard, user id:", u.id);
              const wasReturning = !!greeting || alreadyExists || (newAccount === false);
              toast({
                title: wasReturning ? "С возвращением!" : "Добро пожаловать!",
                description: `Аккаунт ${u?.name || phone}`,
              });
              // Eugene 2026-05-18: claim сохранённых текстов (recovery=CODE
              // или sessionStorage._pendingLyrics) перед navigate.
              await tryClaimSavedLyricsPhone(toast);
              navigate("/dashboard");
            }}
          />
          </div>
          {/* Eugene 2026-05-18 Босс — Telegram как вариант при вводе номера. */}
          <a
            href="/telegram-login"
            className="block gradient-border p-4 rounded-2xl hover:bg-cyan-500/5 transition-colors group"
            data-testid="link-register-via-telegram"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/30 to-blue-500/30 flex items-center justify-center">
                <Send className="w-5 h-5 text-cyan-300" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-white group-hover:text-cyan-200">
                  Через Telegram
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Если звонок не проходит — регистрация через бота за 5 секунд.
                </p>
              </div>
              <span className="text-cyan-300 text-base">→</span>
            </div>
          </a>
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
