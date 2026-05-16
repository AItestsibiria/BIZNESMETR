// Reusable форма SMS-OTP: ввод номера → получение кода → ввод кода.
// Eugene 2026-05-15 Босс «автоподстановка кода SMS».
//
// Поддерживает 2 канала автоподстановки:
// 1. iOS Safari — input type="text" autocomplete="one-time-code". Браузер
//    сам предложит код когда SMS придёт.
// 2. Android Chrome — Web OTP API через navigator.credentials.get({otp})
//    + hash-метка в теле SMS (@muziai.ru #123456 — мы это уже шлём в SMS).
//
// Использование:
//   <PhoneOtpForm purpose="register" onVerified={(data) => {...}} />
//   <PhoneOtpForm purpose="login" onVerified={(data) => {...}} />
//   <PhoneOtpForm purpose="change_phone" onVerified={...} initialPhone="+79..." />

import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Phone, MessageSquare, Mail, RefreshCw } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

export type OtpPurpose = "register" | "login" | "change_phone" | "change_email";
// Eugene 2026-05-15 Босс «авторизация по звонку на номер».
// 'sms' — старый flow (SMS с 6-значным кодом).
// 'call' — flashcall: вам звонят с +7XXX...XXXX, вводите последние 4 цифры.
export type OtpMethod = "sms" | "call";

interface Props {
  purpose: OtpPurpose;
  initialPhone?: string;
  onVerified: (data: {
    phone: string;
    purpose: OtpPurpose;
    nextStep?: string;
    token?: string;
    userId?: number;
    alreadyExists?: boolean;
    method?: OtpMethod;
    // Eugene 2026-05-15: true если phone-not-found upsert создал новый
    // аккаунт (login → register fallback). UI должен показать «у вас уже
    // есть email-аккаунт? привяжите его в ЛК».
    newAccount?: boolean;
  }) => void;
  submitLabel?: string;       // label кнопки на 2-м шаге (default: «Подтвердить»)
  phoneSubmitLabel?: string;  // label на 1-м шаге (default: «Получить код»)
  // Eugene 2026-05-15 Босс «авторизация по звонку».
  // 'sms' (default) / 'call' / 'both' — даёт юзеру выбрать на 1-м шаге.
  // 'change_phone' и 'change_email' доступны только для 'sms' (callcheck
  // backend поддерживает только register/login).
  allowMethods?: "sms" | "call" | "both";
}

export default function PhoneOtpForm({
  purpose,
  initialPhone = "",
  onVerified,
  submitLabel = "Подтвердить",
  phoneSubmitLabel = "Получить код",
  allowMethods,
}: Props) {
  // Eugene 2026-05-16 Босс «только звонок, SMS-toggle скрыть».
  // Дефолт: для register/login — звонок (callcheck flashcall),
  // для change_* — только SMS (callcheck backend не поддерживает change_*).
  // SMS-код остаётся в файле как опциональный fallback после 2 провалов.
  const allowed: "sms" | "call" | "both" =
    allowMethods || (purpose === "register" || purpose === "login" ? "call" : "sms");
  const [method, setMethod] = useState<OtpMethod>(
    allowed === "sms" ? "sms" : "call"
  );
  // Eugene 2026-05-16 Босс «после 2 неудачных попыток показать опциональную
  // кнопку Попробовать SMS». Считаем по sendOtp-провалам метода call.
  const [callFailures, setCallFailures] = useState(0);
  const [showSmsFallback, setShowSmsFallback] = useState(false);

  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState(initialPhone);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);    // 60 сек между повторами
  const [countryHint, setCountryHint] = useState<string | null>(null);
  const [callHint, setCallHint] = useState<string | null>(null);
  const [callPhone, setCallPhone] = useState<string | null>(null);   // raw, для tel:link
  const [callPhonePretty, setCallPhonePretty] = useState<string | null>(null); // для display
  const [callExpiresAt, setCallExpiresAt] = useState<number | null>(null); // unix ms
  const [callPollAttempts, setCallPollAttempts] = useState(0);
  // Eugene 2026-05-16 Босс «сразу navigate в /dashboard, без промежуточного
  // success-screen». После verified мы помечаем форму как verified=true:
  // - останавливаем polling и loader (чтобы юзер не видел «Звоним…» во
  //   время короткой паузы пока parent делает loginByToken→navigate);
  // - parent сразу делает navigate в /dashboard, toast параллельно.
  const [verified, setVerified] = useState(false);

  // Cooldown tick.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Eugene 2026-05-16 Босс «reverse-callcheck — юзер сам звонит на наш номер,
  // 120 сек до fallback на email». Polling /check-reverse-call каждые 3 сек.
  // Stop conditions: verified | expires (120 сек) | unmount | server error 410.
  // При expired показываем fallback-блок «Войти через email» (см. render ниже).
  const pollRef = useRef<number | null>(null);
  const [callExpired, setCallExpired] = useState(false);
  // Eugene 2026-05-16: guard «вызвать onVerified только один раз». Без
  // guard'а если backend два раза подряд вернёт verified (race на parallel
  // polls), parent дважды получит loginByToken → дважды navigate → один
  // из них может race с dashboard mount.
  const verifiedFiredRef = useRef(false);
  useEffect(() => {
    if (step !== "code" || method !== "call") return;
    if (!callExpiresAt) return;
    // Eugene 2026-05-16: если verified=true (после onVerified) — не
    // стартуем polling (cleanup ниже снимает оставшийся timer).
    if (verified) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() > callExpiresAt) {
        setCallExpired(true);
        return;
      }
      try {
        const r = await apiRequest("POST", "/api/auth/sms/check-reverse-call", { phone, purpose });
        const j = await r.json();
        if (cancelled) return;
        if (j?.error) {
          // 410 expired → переходим в expired-state (не показываем error,
          // показываем fallback на email). 404 → тоже expired (запрос истёк).
          setCallExpired(true);
          return;
        }
        if (j?.data?.verified === true && j?.data?.token) {
          // Eugene 2026-05-16: однократный вызов onVerified. После — polling
          // useEffect не перезапустится (verified в deps), но защищаемся
          // ref'ом на случай если этот же tick'овский callback успеет
          // фигнуть второй раз до того как cleanup отменит.
          if (verifiedFiredRef.current) return;
          verifiedFiredRef.current = true;
          // Помечаем как verified — UI сразу скрывает «Звоним…» loader,
          // parent через onVerified → loginByToken → navigate("/dashboard").
          setVerified(true);
          // eslint-disable-next-line no-console
          console.log("[AUTH] phone-otp-form: reverse-call verified, token len:", j.data.token?.length);
          onVerified({
            phone: j.data.phone || phone,
            purpose,
            token: j.data.token,
            userId: j.data.userId,
            alreadyExists: j.data.alreadyExists,
            newAccount: j.data.newAccount,
            method: "call",
          });
          return;
        }
        setCallPollAttempts(a => a + 1);
        // продолжаем — следующий tick
        pollRef.current = window.setTimeout(tick, 3000);
      } catch (e: any) {
        if (cancelled) return;
        // Сетевой / временный — продолжаем polling (не показываем error).
        pollRef.current = window.setTimeout(tick, 4000);
      }
    };
    // Первый запрос с задержкой 2 сек (даём sms.ru обработать /add).
    pollRef.current = window.setTimeout(tick, 2000);
    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, method, callExpiresAt, verified]);

  // Web OTP API — Android Chrome. Только для SMS-flow (call не передаёт код
  // через SMS, нечего слушать). AbortController чтобы прерывать при unmount.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (step !== "code" || method !== "sms") return;
    if (typeof window === "undefined") return;
    const w = window as any;
    if (!("OTPCredential" in w)) return;
    const ac = new AbortController();
    abortRef.current = ac;
    (navigator as any).credentials
      ?.get({ otp: { transport: ["sms"] }, signal: ac.signal })
      ?.then((cred: any) => {
        if (cred?.code && /^\d{6}$/.test(cred.code)) {
          setCode(cred.code);
          // Автосабмит сразу как только код подставился.
          setTimeout(() => doVerify(cred.code), 50);
        }
      })
      .catch(() => {});
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, method]);

  const formatPhone = (raw: string) => {
    let s = raw.replace(/[^\d+]/g, "");
    if (s.startsWith("8") && s.length >= 1) s = "+7" + s.slice(1);
    if (!s.startsWith("+") && /^[0-9]/.test(s)) s = "+" + s;
    return s.slice(0, 16);
  };

  const sendOtp = async () => {
    setError(null);
    if (!phone || phone.length < 7) {
      setError("Введите номер в формате +7XXXXXXXXXX");
      return;
    }
    setLoading(true);
    // Eugene 2026-05-15 Босс «всё чтобы работало». Если выбран звонок но
    // sms.ru его отклонил (callcheck не активирован / нет баланса /
    // временно недоступен) — автоматически fallback на SMS, чтобы юзер
    // всегда получил код. fallbackInfo пишем в state для UX.
    // Eugene 2026-05-16: для call используем reverse-callcheck flow (юзер
     // сам звонит на наш номер, 120 сек TTL + email-fallback после expiry).
    const tryEndpoint = async (m: OtpMethod) => {
      const ep = m === "call" ? "/api/auth/sms/send-reverse-call" : "/api/auth/sms/send-otp";
      const r = await apiRequest("POST", ep, { phone, purpose });
      const j = await r.json();
      return { ok: r.ok && !j?.error, data: j?.data, error: j?.error, statusCode: r.status };
    };

    try {
      let used: OtpMethod = method;
      let res = await tryEndpoint(method);
      // Fallback: если выбрали call но провайдер вернул ошибку (502 / error)
      // — пробуем SMS. fallbackHint в UI чтобы юзер понимал почему.
      let fellBack = false;
      if (!res.ok && method === "call") {
        const callErr = res.error || `HTTP ${res.statusCode}`;
        const smsRes = await tryEndpoint("sms");
        if (smsRes.ok) {
          used = "sms";
          res = smsRes;
          fellBack = true;
          // eslint-disable-next-line no-console
          console.warn("[phone-otp-form] call failed → fallback to sms:", callErr);
        }
      }
      if (!res.ok) {
        setError(res.error || "Не удалось отправить код");
        // Eugene 2026-05-16: считаем неудачные звонки чтобы после 2-й
        // показать опциональный fallback на SMS.
        if (method === "call") {
          setCallFailures(f => {
            const next = f + 1;
            if (next >= 2) setShowSmsFallback(true);
            return next;
          });
        }
        return;
      }
      // Сбрасываем счётчик неудач после успешной отправки.
      if (used === "call") setCallFailures(0);
      // Применяем фактически использованный метод (важно для doVerify).
      if (used !== method) setMethod(used);
      setCountryHint(res.data?.countryName ? (used === "call" ? `Звонок в ${res.data.countryName}` : `Отправлено в ${res.data.countryName}`) : null);
      if (used === "call") {
        setCallHint(res.data?.hint || null);
        // Eugene 2026-05-16: reverse-callcheck возвращает dialNumber /
        // dialNumberPretty. Старые callPhone / callPhonePretty оставлены как
        // backward-compat если backend временно вернёт incoming-call payload.
        setCallPhone(res.data?.dialNumber || res.data?.callPhone || null);
        setCallPhonePretty(
          res.data?.dialNumberPretty ||
            res.data?.callPhonePretty ||
            res.data?.dialNumber ||
            res.data?.callPhone ||
            null,
        );
        // Reverse-callcheck TTL 120 сек (backend REVERSE_CALL_TTL_SEC). После
        // — UI показывает fallback на email-auth.
        setCallExpiresAt(Date.now() + (Number(res.data?.expiresInSec || 120) * 1000));
        setCallPollAttempts(0);
        setCallExpired(false);
      } else {
        setCallHint(fellBack
          ? "Звонок временно недоступен — мы прислали SMS с 6-значным кодом."
          : null);
        setCallPhone(null);
        setCallPhonePretty(null);
        setCallExpiresAt(null);
      }
      setStep("code");
      setCooldown(60);
    } catch (e: any) {
      setError(String(e?.message || "Не удалось отправить код"));
    } finally {
      setLoading(false);
    }
  };

  const doVerify = async (codeToVerify?: string) => {
    setError(null);
    const c = codeToVerify || code;
    // Длина кода зависит от метода: SMS=6 цифр, call=4 цифры.
    const expectedLen = method === "call" ? 4 : 6;
    const re = method === "call" ? /^\d{4}$/ : /^\d{6}$/;
    if (!re.test(c)) {
      setError(`Введите ${expectedLen}-значный код`);
      return;
    }
    setLoading(true);
    try {
      const endpoint = method === "call" ? "/api/auth/sms/verify-call" : "/api/auth/sms/verify-otp";
      const r = await apiRequest("POST", endpoint, { phone, code: c, purpose });
      const j = await r.json();
      if (j?.error) {
        setError(j.error);
        return;
      }
      // Eugene 2026-05-16: помечаем verified чтобы скрыть форму на время
      // паузы parent.loginByToken (~100-300ms /api/me), потом сразу navigate.
      // Однократный guard на onVerified — см. polling выше.
      if (verifiedFiredRef.current) return;
      verifiedFiredRef.current = true;
      setVerified(true);
      // eslint-disable-next-line no-console
      console.log("[AUTH] phone-otp-form: SMS/call verified, token len:", j?.data?.token?.length);
      onVerified({
        phone: j?.data?.phone || phone,
        purpose,
        nextStep: j?.data?.nextStep,
        token: j?.data?.token,
        userId: j?.data?.userId,
        alreadyExists: j?.data?.alreadyExists,
        newAccount: j?.data?.newAccount,
        method,
      });
    } catch (e: any) {
      setError(String(e?.message || "Неверный код"));
    } finally {
      setLoading(false);
    }
  };

  // Eugene 2026-05-16 Босс «убрать промежуточный success-screen». После
  // verified=true показываем компактный transition-loader (вместо большой
  // формы «Звоним…»). Parent в это время делает loginByToken→navigate, и
  // юзер сразу попадёт в /dashboard.
  if (verified) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-purple-300" />
        <span className="ml-2 text-sm text-muted-foreground">Входим в кабинет…</span>
      </div>
    );
  }

  if (step === "phone") {
    return (
      <div className="space-y-3">
        <div className="space-y-2">
          <Label className="text-sm text-muted-foreground flex items-center gap-2">
            <Phone className="w-3.5 h-3.5" /> Номер телефона
          </Label>
          <Input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+79261234567"
            value={phone}
            onChange={e => setPhone(formatPhone(e.target.value))}
            className="bg-background/50 border-white/10"
            disabled={loading}
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">
            РФ и страны СНГ. {method === "call" ? "Вы тапнете по номеру — откроется звонок, нажмёте «Вызов» со своего телефона. Платить не надо." : "На номер придёт SMS с 6-значным кодом."}
          </p>
        </div>

        {/* Eugene 2026-05-16 Босс «скрыть SMS-toggle, только звонок».
            Toggle между SMS / call скрыт — default = call. Если callcheck
            упал 2+ раза → ниже появляется опциональная кнопка «Попробовать
            SMS». Код SMS оставлен полностью рабочим на будущее. */}
        {allowed === "both" && showSmsFallback && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 space-y-2">
            <p className="text-[11px] text-amber-200">
              Звонок не проходит? Можно попробовать SMS с 6-значным кодом.
            </p>
            <button
              type="button"
              onClick={() => { setMethod("sms"); setError(null); }}
              className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border transition-colors text-sm ${
                method === "sms"
                  ? "border-purple-400/60 bg-purple-500/15 text-purple-100"
                  : "border-white/10 bg-white/[0.04] text-muted-foreground hover:text-white hover:bg-white/[0.07]"
              }`}
              disabled={loading}
              data-testid="button-fallback-sms"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              {method === "sms" ? "SMS выбрано" : "Попробовать SMS"}
            </button>
          </div>
        )}

        {error && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <Button
          className="w-full btn-gradient"
          disabled={loading || phone.length < 7}
          onClick={sendOtp}
        >
          {loading
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : (method === "call" ? "Показать номер для звонка" : phoneSubmitLabel)}
        </Button>
      </div>
    );
  }

  // Step "code" — раздельные UI для SMS (6-значный код) и call (юзер сам
  // звонит на наш номер, мы ждём webhook/polling — никакого ввода кода).
  const isCall = method === "call";

  // CALL flow: показываем call_phone_pretty крупно + кнопку tel:link +
  // статус polling'a. Юзер ничего не вводит.
  // Eugene 2026-05-15 Босс правки UX:
  // - «не ждем звонка а звоним» → текст «Звоним...» с акцентом на действие юзера
  // - выделить номер ярче + БЕСПЛАТНЫЙ pill
  // - добавить кнопку «Сохранить в контакты» (vCard)
  // - после verified → success-state + auto-navigate (через onVerified в parent)
  if (isCall) {
    const expiresInSec = callExpiresAt ? Math.max(0, Math.floor((callExpiresAt - Date.now()) / 1000)) : 0;
    const mm = String(Math.floor(expiresInSec / 60)).padStart(2, "0");
    const ss = String(expiresInSec % 60).padStart(2, "0");
    const cleanPhone = callPhone ? callPhone.replace(/[^\d+]/g, "") : "";
    const telHref = cleanPhone ? `tel:${cleanPhone.startsWith("+") ? cleanPhone : "+" + cleanPhone}` : "#";
    // vCard для «Сохранить в контакты» — Data URI с MIME text/vcard
    const vcardData = cleanPhone
      ? `BEGIN:VCARD\nVERSION:3.0\nFN:MuzaAi (вход по звонку)\nORG:MuzaAi\nTEL;TYPE=WORK,VOICE:${cleanPhone.startsWith("+") ? cleanPhone : "+" + cleanPhone}\nURL:https://muzaai.ru\nEND:VCARD`
      : "";
    const vcardHref = vcardData ? `data:text/vcard;charset=utf-8,${encodeURIComponent(vcardData)}` : "#";
    return (
      <div className="space-y-4">
        <p className="text-sm text-center text-muted-foreground">
          Звонок с номера <span className="text-white font-medium">{phone}</span>
          {countryHint && <span className="block text-[11px] mt-1 opacity-70">{countryHint}</span>}
        </p>

        {/* Eugene 2026-05-15 Босс «цвета в стили MuzaAi» — brand-gradient
            purple → violet → blue (фирменная гамма MuzaAi), вместо
            emerald/cyan. БЕСПЛАТНЫЙ pill amber (контрастный akcent).
            Eugene 2026-05-16: tap-to-dial — номер крупный, кликабельный,
            юзер тапает → открывается dialer → нажимает «Вызов». */}
        <div className="bg-gradient-to-br from-purple-500/15 via-violet-500/10 to-blue-500/15 border border-purple-400/40 rounded-xl p-4 text-center shadow-[0_0_24px_rgba(168,85,247,0.15)]">
          <p className="text-sm text-white font-medium mb-2">
            📞 Тапните номер и нажмите «Вызов»:
          </p>
          <a
            href={telHref}
            className="inline-block px-5 py-3 mb-2 rounded-xl bg-gradient-to-r from-purple-500/30 via-violet-500/25 to-blue-500/25 border-2 border-purple-300/60 text-3xl font-extrabold text-white tracking-wide hover:scale-[1.02] transition-transform shadow-lg shadow-purple-500/25"
            data-testid="call-phone-link"
          >
            {callPhonePretty || callPhone || "—"}
          </a>
          <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-400/15 border border-amber-400/40 text-amber-200 text-[11px] font-bold tracking-wide ml-2">
            🆓 БЕСПЛАТНЫЙ
          </div>
          <p className="text-[11px] text-purple-200/80 mt-3">
            Звонок сбросится автоматически — это бесплатно. Мы узнаем ваш номер по caller-id и впустим в кабинет. Кодов вводить не надо.
          </p>
          <div className="flex items-center justify-center gap-2 mt-3">
            <a
              href={telHref}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-500/25 to-blue-500/20 border border-purple-300/40 text-purple-100 hover:from-purple-500/35 hover:to-blue-500/30 transition-colors"
              data-testid="link-call-now"
            >
              📞 Позвонить сейчас
            </a>
            <a
              href={vcardHref}
              download="MuzaAi-vhod.vcf"
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-white/[0.04] border border-purple-300/20 text-white/70 hover:bg-purple-500/10 hover:text-white"
              data-testid="link-save-vcard"
            >
              💾 Сохранить в контакты
            </a>
          </div>
        </div>

        {!callExpired && (
          <div className="text-center">
            <p className="text-[11px] text-muted-foreground">
              Ждём ваш звонок… <span className="font-mono tabular-nums text-white/80">{mm}:{ss}</span>
            </p>
            <div className="flex justify-center mt-2">
              <Loader2 className="w-4 h-4 animate-spin text-purple-300" />
            </div>
          </div>
        )}

        {/* Eugene 2026-05-16 Босс «если не дозвонился через 120 сек —
            fallback на email-auth большой кнопкой». Большой prominent
            блок с двумя действиями: повторить звонок ИЛИ войти через
            email (главное действие). Не показываем мелкую error-строку —
            юзеру нужна большая кликабельная альтернатива. */}
        {callExpired && (
          <div className="bg-gradient-to-br from-amber-500/10 via-orange-500/10 to-rose-500/10 border-2 border-amber-400/40 rounded-xl p-4 space-y-3">
            <div className="text-center">
              <p className="text-base text-white font-semibold">
                Не получилось дозвониться?
              </p>
              <p className="text-xs text-amber-100/80 mt-1">
                Попробуйте ещё раз или войдите через email — это надёжнее, если звонок не проходит.
              </p>
            </div>
            <Link href="/login">
              <a
                className="block w-full text-center px-4 py-4 rounded-xl bg-gradient-to-r from-purple-500 via-violet-500 to-blue-500 text-white text-base font-bold shadow-lg shadow-purple-500/30 hover:scale-[1.02] active:scale-[0.98] transition-transform"
                data-testid="link-email-auth-fallback"
              >
                <Mail className="w-5 h-5 inline mr-2 -mt-0.5" />
                Войти через email
              </a>
            </Link>
            <button
              type="button"
              onClick={() => { setCallExpired(false); sendOtp(); }}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-white/15 bg-white/[0.04] text-white/80 hover:bg-white/[0.08] hover:text-white transition-colors text-sm"
              disabled={loading || cooldown > 0}
              data-testid="button-retry-reverse-call"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {cooldown > 0 ? `Повторить звонок (${cooldown}с)` : "Попробовать звонок ещё раз"}
            </button>
          </div>
        )}

        {error && !callExpired && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between text-xs">
          <button
            onClick={() => {
              setStep("phone"); setError(null); setCallHint(null);
              setCallPhone(null); setCallPhonePretty(null); setCallExpiresAt(null);
              setCallExpired(false);
            }}
            className="text-muted-foreground hover:text-white"
            disabled={loading}
          >
            ← Изменить номер
          </button>
          <button
            onClick={sendOtp}
            disabled={loading || cooldown > 0}
            className="text-muted-foreground hover:text-white disabled:opacity-40"
          >
            {cooldown > 0 ? `Повторить через ${cooldown}с` : "Новый звонок"}
          </button>
        </div>
      </div>
    );
  }

  // SMS flow (без изменений).
  return (
    <div className="space-y-3">
      <p className="text-sm text-center text-muted-foreground">
        Код отправлен на <span className="text-white font-medium">{phone}</span>
        {countryHint && <span className="block text-[11px] mt-1 opacity-70">{countryHint}</span>}
        {callHint && (
          <span className="block text-[11px] mt-2 px-2 py-1 rounded bg-amber-500/15 border border-amber-500/30 text-amber-200">
            ℹ️ {callHint}
          </span>
        )}
      </p>
      <div className="space-y-2">
        <Label className="text-sm text-muted-foreground">Введите 6-значный код</Label>
        <Input
          type="text"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          name="otp"
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="000000"
          className="bg-background/50 border-white/10 text-center text-2xl tracking-[0.3em] font-bold"
          autoFocus
        />
        <p className="text-[11px] text-muted-foreground text-center">
          На iOS код подставится автоматически. На Android — после прихода SMS.
        </p>
      </div>
      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      <Button
        className="w-full btn-gradient"
        disabled={loading || code.length !== 6}
        onClick={() => doVerify()}
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : submitLabel}
      </Button>
      <div className="flex items-center justify-between text-xs">
        <button
          onClick={() => { setStep("phone"); setCode(""); setError(null); setCallHint(null); }}
          className="text-muted-foreground hover:text-white"
          disabled={loading}
        >
          ← Изменить номер
        </button>
        <button
          onClick={sendOtp}
          disabled={loading || cooldown > 0}
          className="text-muted-foreground hover:text-white disabled:opacity-40"
        >
          {cooldown > 0 ? `Повторить через ${cooldown}с` : "Отправить ещё раз"}
        </button>
      </div>
    </div>
  );
}
