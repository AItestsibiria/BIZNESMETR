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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Phone, PhoneCall, MessageSquare } from "lucide-react";
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
  // Дефолт: для register/login — выбор обоих, для change_* — только SMS.
  const allowed: "sms" | "call" | "both" =
    allowMethods || (purpose === "register" || purpose === "login" ? "both" : "sms");
  const [method, setMethod] = useState<OtpMethod>(allowed === "call" ? "call" : "sms");

  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState(initialPhone);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);    // 60 сек между повторами
  const [countryHint, setCountryHint] = useState<string | null>(null);
  const [callHint, setCallHint] = useState<string | null>(null);   // полная подсказка про звонок
  const [callPhone, setCallPhone] = useState<string | null>(null); // номер с которого звонят

  // Cooldown tick.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

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
    try {
      // Eugene 2026-05-15 Босс «авторизация по звонку».
      // /send-otp (SMS-flow) vs /send-call (flashcall-flow).
      const endpoint = method === "call" ? "/api/auth/sms/send-call" : "/api/auth/sms/send-otp";
      const r = await apiRequest("POST", endpoint, { phone, purpose });
      const j = await r.json();
      if (j?.error) {
        setError(j.error);
        return;
      }
      setCountryHint(j?.data?.countryName ? (method === "call" ? `Звонок в ${j.data.countryName}` : `Отправлено в ${j.data.countryName}`) : null);
      if (method === "call") {
        setCallHint(j?.data?.hint || null);
        setCallPhone(j?.data?.callPhone || null);
      } else {
        setCallHint(null);
        setCallPhone(null);
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
      onVerified({
        phone: j?.data?.phone || phone,
        purpose,
        nextStep: j?.data?.nextStep,
        token: j?.data?.token,
        userId: j?.data?.userId,
        alreadyExists: j?.data?.alreadyExists,
        method,
      });
    } catch (e: any) {
      setError(String(e?.message || "Неверный код"));
    } finally {
      setLoading(false);
    }
  };

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
            РФ и страны СНГ. {method === "call" ? "На номер позвонят — отвечать не надо." : "На номер придёт SMS с 6-значным кодом."}
          </p>
        </div>

        {/* Eugene 2026-05-15 Босс «авторизация по звонку».
            Toggle между SMS / call methods — виден если allowed='both'. */}
        {allowed === "both" && (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMethod("sms")}
              className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border transition-colors text-sm ${
                method === "sms"
                  ? "border-purple-400/60 bg-purple-500/15 text-purple-100"
                  : "border-white/10 bg-white/[0.04] text-muted-foreground hover:text-white hover:bg-white/[0.07]"
              }`}
              disabled={loading}
            >
              <MessageSquare className="w-3.5 h-3.5" /> SMS-код
            </button>
            <button
              type="button"
              onClick={() => setMethod("call")}
              className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border transition-colors text-sm ${
                method === "call"
                  ? "border-emerald-400/60 bg-emerald-500/15 text-emerald-100"
                  : "border-white/10 bg-white/[0.04] text-muted-foreground hover:text-white hover:bg-white/[0.07]"
              }`}
              disabled={loading}
            >
              <PhoneCall className="w-3.5 h-3.5" /> Звонок
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
            : (method === "call" ? "Получить звонок" : phoneSubmitLabel)}
        </Button>
      </div>
    );
  }

  // Step "code" — раздельные UI для SMS (6 цифр) и call (4 цифры из номера).
  const isCall = method === "call";
  const codeLen = isCall ? 4 : 6;

  return (
    <div className="space-y-3">
      <p className="text-sm text-center text-muted-foreground">
        {isCall ? (
          <>
            Звонок на <span className="text-white font-medium">{phone}</span>
            {callPhone && (
              <span className="block text-[12px] mt-1 text-emerald-200">
                Ждите входящий с номера<br />
                <span className="font-mono font-bold text-base text-white">{callPhone}</span>
              </span>
            )}
            {callHint && <span className="block text-[11px] mt-2 opacity-80">{callHint}</span>}
            {!callHint && <span className="block text-[11px] mt-2 opacity-70">Не отвечайте — просто введите последние 4 цифры номера.</span>}
          </>
        ) : (
          <>
            Код отправлен на <span className="text-white font-medium">{phone}</span>
            {countryHint && <span className="block text-[11px] mt-1 opacity-70">{countryHint}</span>}
          </>
        )}
      </p>
      <div className="space-y-2">
        <Label className="text-sm text-muted-foreground">
          {isCall ? "Последние 4 цифры номера, с которого позвонили" : "Введите 6-значный код"}
        </Label>
        <Input
          type="text"
          inputMode="numeric"
          maxLength={codeLen}
          autoComplete={isCall ? "off" : "one-time-code"}
          name={isCall ? "callcheck" : "otp"}
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, codeLen))}
          placeholder={isCall ? "0000" : "000000"}
          className={`bg-background/50 border-white/10 text-center text-2xl tracking-[0.3em] font-bold ${
            isCall ? "border-emerald-500/30" : ""
          }`}
          autoFocus
        />
        <p className="text-[11px] text-muted-foreground text-center">
          {isCall
            ? "Например, если позвонили с +7 495 777 1234 — введите 1234."
            : "На iOS код подставится автоматически. На Android — после прихода SMS."}
        </p>
      </div>
      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      <Button
        className="w-full btn-gradient"
        disabled={loading || code.length !== codeLen}
        onClick={() => doVerify()}
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : submitLabel}
      </Button>
      <div className="flex items-center justify-between text-xs">
        <button
          onClick={() => { setStep("phone"); setCode(""); setError(null); setCallHint(null); setCallPhone(null); }}
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
          {cooldown > 0 ? `Повторить через ${cooldown}с` : (isCall ? "Позвонить ещё раз" : "Отправить ещё раз")}
        </button>
      </div>
    </div>
  );
}
