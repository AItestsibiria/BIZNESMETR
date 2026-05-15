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
import { Loader2, Phone } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

export type OtpPurpose = "register" | "login" | "change_phone" | "change_email";

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
  }) => void;
  submitLabel?: string;       // label кнопки на 2-м шаге (default: «Подтвердить»)
  phoneSubmitLabel?: string;  // label на 1-м шаге (default: «Получить код»)
}

export default function PhoneOtpForm({
  purpose,
  initialPhone = "",
  onVerified,
  submitLabel = "Подтвердить",
  phoneSubmitLabel = "Получить код",
}: Props) {
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState(initialPhone);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);    // 60 сек между повторами
  const [countryHint, setCountryHint] = useState<string | null>(null);

  // Cooldown tick.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Web OTP API — Android Chrome. AbortController чтобы прерывать при unmount.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (step !== "code") return;
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
  }, [step]);

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
      const r = await apiRequest("POST", "/api/auth/sms/send-otp", { phone, purpose });
      const j = await r.json();
      if (j?.error) {
        setError(j.error);
        return;
      }
      setCountryHint(j?.data?.countryName ? `Отправлено в ${j.data.countryName}` : null);
      setStep("code");
      setCooldown(60);
    } catch (e: any) {
      // apiRequest бросает Error с message из server.error.
      setError(String(e?.message || "Не удалось отправить код"));
    } finally {
      setLoading(false);
    }
  };

  const doVerify = async (codeToVerify?: string) => {
    setError(null);
    const c = codeToVerify || code;
    if (!/^\d{6}$/.test(c)) {
      setError("Введите 6-значный код");
      return;
    }
    setLoading(true);
    try {
      const r = await apiRequest("POST", "/api/auth/sms/verify-otp", { phone, code: c, purpose });
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
            РФ и страны СНГ. На номер придёт SMS с 6-значным кодом.
          </p>
        </div>
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
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : phoneSubmitLabel}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-center text-muted-foreground">
        Код отправлен на <span className="text-white font-medium">{phone}</span>
        {countryHint && <span className="block text-[11px] mt-1 opacity-70">{countryHint}</span>}
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
          onChange={e => setCode(e.target.value.replace(/\D/g, ""))}
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
          onClick={() => { setStep("phone"); setCode(""); setError(null); }}
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
