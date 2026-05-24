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
import { isMobilePhone } from "@/lib/deviceDetect";
import { PhoneCallInstructions } from "@/components/phone-call-instructions";

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
    // Eugene 2026-05-17 Босс — Level 1 защиты: если backend вернул
    // requireAdminCode, parent должен переключиться на 2FA-форму вместо
    // того чтобы вызывать loginByToken.
    requireAdminCode?: boolean;
    sessionDraftId?: string;
    emailHint?: string;
    expiresInSec?: number;
    warning?: string;
  }) => void;
  submitLabel?: string;       // label кнопки на 2-м шаге (default: «Подтвердить»)
  phoneSubmitLabel?: string;  // label на 1-м шаге (default: «Получить код»)
  // Eugene 2026-05-15 Босс «авторизация по звонку».
  // 'sms' (default) / 'call' / 'both' — даёт юзеру выбрать на 1-м шаге.
  // 'change_phone' и 'change_email' доступны только для 'sms' (callcheck
  // backend поддерживает только register/login).
  allowMethods?: "sms" | "call" | "both";
  // Eugene 2026-05-17 Босс «если автор то приветствуй по имени». Колбэк
  // фронт вызывает после успешного phone-check (POST /phone-check). Если
  // exists=true — родитель (register-phone) меняет UI на login-mode
  // «Привет, <имя>!» + кнопка «Получить звонок для входа». Колбэк должен
  // вернуться синхронно. Если опущен — никакой pre-check не делается.
  onPhoneChecked?: (info: {
    phone: string;
    exists: boolean;
    name?: string;
    maskedPhone?: string;
  }) => void;
}

export default function PhoneOtpForm({
  purpose,
  initialPhone = "",
  onVerified,
  submitLabel = "Подтвердить",
  phoneSubmitLabel = "Получить код",
  allowMethods,
  onPhoneChecked,
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

  // Eugene 2026-05-17 Босс «Нам никто не звонит» — возврат к classical
  // flashcall: sms.ru ЗВОНИТ юзеру на его номер. Юзер видит входящий с
  // нашего служебного номера, принимает или отклоняет — sms.ru фиксирует
  // событие и backend polling'ует /check-call до verified=true (status 401).
  // Polling каждые 3 сек, TTL 300 сек (callcheck window sms.ru).
  // Stop conditions: verified | expires | unmount | server error 410.
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
        const r = await apiRequest("POST", "/api/auth/sms/check-call", { phone, purpose });
        const j = await r.json();
        if (cancelled) return;
        if (j?.error) {
          // 410 expired → переходим в expired-state (не показываем error,
          // показываем fallback на email). 404 → тоже expired (запрос истёк).
          setCallExpired(true);
          return;
        }
        // Eugene 2026-05-17 Босс — Level 1 защиты: если admin → требуется 2FA.
        if (j?.data?.verified === true && j?.data?.requireAdminCode && j?.data?.sessionDraftId) {
          if (verifiedFiredRef.current) return;
          verifiedFiredRef.current = true;
          setVerified(true);
          onVerified({
            phone: j.data.phone || phone,
            purpose,
            requireAdminCode: true,
            sessionDraftId: j.data.sessionDraftId,
            emailHint: j.data.emailHint,
            expiresInSec: j.data.expiresInSec,
            warning: j.data.warning,
            method: "call",
          });
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

    // Eugene 2026-05-17 Босс «если автор то приветствуй по имени» —
    // pre-check для register/login flow. Узнаём существует ли уже автор
    // с этим номером, чтобы родитель мог переключить UI в greeting-mode.
    // Колбэк опционален, ошибки phone-check не блокируют дальнейший flow.
    if (onPhoneChecked && (purpose === "register" || purpose === "login")) {
      try {
        const r = await apiRequest("POST", "/api/auth/sms/phone-check", { phone });
        const j = await r.json();
        if (j?.data) {
          onPhoneChecked({
            phone,
            exists: !!j.data.exists,
            name: j.data.name,
            maskedPhone: j.data.maskedPhone,
          });
        }
      } catch (e) {
        // Тихо игнорируем — phone-check не должен блокировать auth.
        // eslint-disable-next-line no-console
        console.warn("[phone-otp-form] phone-check failed (non-blocking):", e);
      }
    }

    // Eugene 2026-05-15 Босс «всё чтобы работало». Если выбран звонок но
    // sms.ru его отклонил (callcheck не активирован / нет баланса /
    // временно недоступен) — автоматически fallback на SMS, чтобы юзер
    // всегда получил код. fallbackInfo пишем в state для UX.
    // Eugene 2026-05-17 Босс «Нам никто не звонит»: classical flashcall —
    // sms.ru ЗВОНИТ юзеру (/send-call). Юзер видит входящий и принимает.
    const tryEndpoint = async (m: OtpMethod) => {
      const ep = m === "call" ? "/api/auth/sms/send-call" : "/api/auth/sms/send-otp";
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
      // Eugene 2026-05-24 Босс «если номер авторизован — авторизуй». Если
      // backend auto-switched register→login (existing user) — показываем
      // info вместо country hint, чтобы юзер понял что входит а не
      // регистрируется заново.
      if (res.data?.switchedToLogin) {
        setCountryHint("✓ Этот номер уже у нас — впустим без регистрации");
      } else {
        setCountryHint(res.data?.countryName ? (used === "call" ? `Звонок в ${res.data.countryName}` : `Отправлено в ${res.data.countryName}`) : null);
      }
      if (used === "call") {
        setCallHint(res.data?.hint || null);
        // Eugene 2026-05-17 Босс «Нам никто не звонит» — classical flashcall:
        // backend /send-call возвращает callPhone (служебный номер sms.ru
        // С КОТОРОГО будет звонок юзеру) + callPhonePretty. dialNumber/Pretty
        // оставлены как backward-compat если фронт получит старый payload.
        setCallPhone(res.data?.callPhone || res.data?.dialNumber || null);
        setCallPhonePretty(
          res.data?.callPhonePretty ||
            res.data?.dialNumberPretty ||
            res.data?.callPhone ||
            res.data?.dialNumber ||
            null,
        );
        // Classical callcheck TTL 300 сек (sms.ru окно). После — fallback UI.
        setCallExpiresAt(Date.now() + (Number(res.data?.expiresInSec || 300) * 1000));
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
            РФ и страны СНГ. {method === "call" ? "Покажем номер 8800 — позвоните на него с этого телефона. Звонок бесплатный, можно сразу сбросить, мы узнаем ваш номер и впустим в кабинет." : "На номер придёт SMS с 6-значным кодом."}
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
            : (method === "call" ? "📞 ПОКАЗАТЬ НОМЕР 8800" : phoneSubmitLabel)}
        </Button>
      </div>
    );
  }

  // Step "code" — раздельные UI для SMS (6-значный код) и call (юзер сам
  // звонит на наш номер, мы ждём webhook/polling — никакого ввода кода).
  const isCall = method === "call";

  // CALL flow: REVERSE flashcall (sms.ru API) — юзер звонит со своего телефона
  // на наш служебный 8800. Sms.ru видит входящий с этого номера → подтверждает.
  // Eugene 2026-05-17 Босс «Это мы должны вести свой номер со своего телефона
  // и набрать номер который указан 8800 — тогда провалимся в личный кабинет»:
  // - 8800 номер крупно с tap-to-dial (tel: link)
  // - «Позвоните бесплатно» инструкция
  // - polling /check-call пока sms.ru не подтвердит incoming с того же номера
  if (isCall) {
    const expiresInSec = callExpiresAt ? Math.max(0, Math.floor((callExpiresAt - Date.now()) / 1000)) : 0;
    const mm = String(Math.floor(expiresInSec / 60)).padStart(2, "0");
    const ss = String(expiresInSec % 60).padStart(2, "0");
    const callHref = callPhone ? `tel:${callPhone.replace(/[^+0-9]/g, "")}` : undefined;

    // Eugene 2026-05-18 Босс «На планшете 8800 показывает но позвонить
    // нельзя — нужен другой UX». isMobilePhone() → стандартный tel:link
    // flow. !isMobilePhone() → QR-код + copy-кнопка + «возьмите смартфон».
    const onMobilePhone = isMobilePhone();
    if (!onMobilePhone && callPhone) {
      return (
        <PhoneCallInstructions
          dialNumber={callPhone}
          dialNumberPretty={callPhonePretty || undefined}
          userPhone={phone}
          expiresInSec={expiresInSec}
          expired={callExpired}
          onRetry={() => { setCallExpired(false); sendOtp(); }}
          onChangePhone={() => {
            setStep("phone"); setError(null); setCallHint(null);
            setCallPhone(null); setCallPhonePretty(null); setCallExpiresAt(null);
            setCallExpired(false);
          }}
          errorText={error}
          cooldown={cooldown}
          loading={loading}
        />
      );
    }
    return (
      <div className="space-y-4">
        <p className="text-sm text-center text-muted-foreground">
          С номера <span className="text-white font-medium">{phone}</span>
          {countryHint && <span className="block text-[11px] mt-1 opacity-70">{countryHint}</span>}
        </p>

        {/* «ЗВОНОК БЕСПЛАТНЫЙ» — мощный акцент перед 8800. */}
        <div className="text-center">
          <p className="text-2xl sm:text-3xl font-display font-bold bg-gradient-to-r from-amber-400 via-amber-300 to-cyan-400 bg-clip-text text-transparent neon-text tracking-wide" data-testid="banner-call-free">
            ЗВОНОК БЕСПЛАТНЫЙ
          </p>
          <p className="text-[11px] text-amber-200/70 mt-1">Мы платим за вас — с вашего счёта ничего не спишется</p>
        </div>

        {/* 8800 номер крупно + tel:link (тап на iPhone сразу открывает Phone.app
            с уже набранным номером — остаётся только нажать вызов). */}
        <div className="bg-gradient-to-br from-purple-500/15 via-violet-500/10 to-blue-500/15 border border-purple-400/40 rounded-xl p-4 text-center shadow-[0_0_24px_rgba(168,85,247,0.15)]">
          <p className="text-sm text-white font-medium mb-2">
            📞 Позвоните с вашего телефона на номер:
          </p>
          {callHref ? (
            <a
              href={callHref}
              className="inline-block px-5 py-3 mb-2 rounded-xl bg-gradient-to-r from-purple-500/40 via-violet-500/35 to-blue-500/35 border-2 border-purple-300/70 text-3xl font-extrabold text-white tracking-wide phone-pulse no-underline hover:from-purple-500/60 hover:to-blue-500/55 active:scale-[0.98] transition-all"
              data-testid="call-phone-display"
            >
              {callPhonePretty || callPhone || "—"}
            </a>
          ) : (
            <div
              className="inline-block px-5 py-3 mb-2 rounded-xl bg-gradient-to-r from-purple-500/30 via-violet-500/25 to-blue-500/25 border-2 border-purple-300/60 text-3xl font-extrabold text-white tracking-wide phone-pulse"
              data-testid="call-phone-display"
            >
              {callPhonePretty || callPhone || "—"}
            </div>
          )}
          <p className="text-[11px] text-purple-200/80 mt-3">
            👉 Нажмите на номер — телефон сам наберёт. Можете сбросить сразу после соединения — мы узнаем ваш номер и сразу впустим в кабинет. Кодов вводить не нужно.
          </p>
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

        {/* Eugene 2026-05-17 Босс «если звонок не прошёл — fallback на
            email-auth большой кнопкой». Большой prominent блок с двумя
            действиями: повторить звонок ИЛИ войти через email. */}
        {callExpired && (
          <div className="bg-gradient-to-br from-amber-500/10 via-orange-500/10 to-rose-500/10 border-2 border-amber-400/40 rounded-xl p-4 space-y-3">
            <div className="text-center">
              <p className="text-base text-white font-semibold">
                Звонок не прошёл?
              </p>
              <p className="text-xs text-amber-100/80 mt-1">
                Попробуйте ещё раз или войдите через email — это надёжнее, если звонок не доходит.
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
