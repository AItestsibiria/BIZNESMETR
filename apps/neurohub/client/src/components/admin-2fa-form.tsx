// Eugene 2026-05-17 Босс — Level 1 защиты: форма ввода 6-значного email-кода
// при login админа. Backend возвращает {requireAdminCode: true,
// sessionDraftId, emailHint, expiresInSec} → этот компонент показывает
// ввод 6 цифр + countdown 10 мин + Resend (после 60 сек).
//
// Использование:
//   <Admin2FAForm
//     sessionDraftId={draftId}
//     emailHint="us***@gmail.com"
//     expiresInSec={600}
//     onVerified={(data) => loginByToken(data.token)}
//   />

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Shield, RefreshCw, Mail } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface VerifyResponse {
  token: string;
  user: {
    id: number;
    email: string;
    name: string;
    role: string;
  };
}

interface Props {
  sessionDraftId: string;
  emailHint?: string;
  expiresInSec?: number;
  warning?: string;
  onVerified: (data: VerifyResponse) => void;
  onCancel?: () => void;
}

const CODE_LEN = 6;
const RESEND_COOLDOWN_SEC = 60;

export default function Admin2FAForm({
  sessionDraftId: initialDraftId,
  emailHint,
  expiresInSec = 600,
  warning,
  onVerified,
  onCancel,
}: Props) {
  const [sessionDraftId, setSessionDraftId] = useState(initialDraftId);
  const [hint, setHint] = useState(emailHint || "");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(warning || null);
  const [secondsLeft, setSecondsLeft] = useState<number>(expiresInSec);
  const [resendCooldown, setResendCooldown] = useState<number>(RESEND_COOLDOWN_SEC);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Countdown TTL (10 мин).
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [secondsLeft]);

  // Cooldown для resend.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  // Autofocus.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleVerify = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (loading) return;
    if (!/^\d{6}$/.test(code)) {
      setError("Введите 6 цифр");
      return;
    }
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      const res = await apiRequest("POST", "/api/auth/admin-verify-code", {
        sessionDraftId,
        code,
      });
      const data = await res.json();
      if (!data?.token) {
        setError(data?.message || "Не удалось войти. Попробуйте ещё раз.");
        if (typeof data?.attemptsLeft === "number") setAttemptsLeft(data.attemptsLeft);
        return;
      }
      onVerified(data);
    } catch (err: any) {
      // apiRequest бросает Error если HTTP != 2xx — пытаемся вытащить body.
      const msg = String(err?.message || "");
      try {
        const matched = msg.match(/\{.*\}/);
        if (matched) {
          const parsed = JSON.parse(matched[0]);
          setError(parsed?.message || msg);
          if (typeof parsed?.attemptsLeft === "number") setAttemptsLeft(parsed.attemptsLeft);
          return;
        }
      } catch {}
      setError(msg || "Ошибка сети — попробуйте ещё раз");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0 || resending) return;
    setResending(true);
    setError(null);
    setInfo(null);
    try {
      const res = await apiRequest("POST", "/api/auth/admin-resend-code", { sessionDraftId });
      const data = await res.json();
      if (data?.sessionDraftId) {
        setSessionDraftId(data.sessionDraftId);
        if (data.emailHint) setHint(data.emailHint);
        setSecondsLeft(data.expiresInSec || 600);
        setResendCooldown(RESEND_COOLDOWN_SEC);
        setCode("");
        setAttemptsLeft(null);
        setInfo(data.emailSent === false
          ? "Код создан, но email не пришёл. Свяжись с Eugene."
          : "Новый код отправлен.");
      } else {
        setError(data?.message || "Не удалось отправить новый код");
      }
    } catch (err: any) {
      setError(String(err?.message || "Ошибка сети"));
    } finally {
      setResending(false);
    }
  };

  const mm = Math.floor(secondsLeft / 60);
  const ss = String(secondsLeft % 60).padStart(2, "0");
  const ttlExpired = secondsLeft <= 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 px-1">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500/30 to-blue-500/30 flex items-center justify-center">
          <Shield className="w-5 h-5 text-purple-300" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-white">Подтверждение admin-входа</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Код отправлен на {hint ? <span className="text-purple-300">{hint}</span> : "ваш email"}
          </p>
        </div>
      </div>

      {info && (
        <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
          {info}
        </div>
      )}

      <form onSubmit={handleVerify} className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="admin-code" className="text-sm text-muted-foreground">
            Код из email (6 цифр)
          </Label>
          <Input
            id="admin-code"
            ref={inputRef}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={CODE_LEN}
            placeholder="000000"
            value={code}
            onChange={(e) => {
              const cleaned = e.target.value.replace(/\D/g, "").slice(0, CODE_LEN);
              setCode(cleaned);
              setError(null);
              if (cleaned.length === CODE_LEN) {
                // Auto-submit при 6-й цифре.
                setTimeout(() => handleVerify(), 50);
              }
            }}
            disabled={loading || ttlExpired}
            className="bg-background/50 border-white/10 input-glow text-center text-2xl tracking-[0.5em] font-mono"
            data-testid="input-admin-code"
          />
          <div className="flex items-center justify-between text-xs">
            <span className={ttlExpired ? "text-red-400" : "text-muted-foreground"}>
              {ttlExpired ? "Срок истёк — запросите новый код" : `Действителен ещё ${mm}:${ss}`}
            </span>
            {attemptsLeft !== null && (
              <span className="text-amber-300">Попыток осталось: {attemptsLeft}</span>
            )}
          </div>
        </div>

        {error && (
          <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-3">
            {error}
          </div>
        )}

        <Button
          type="submit"
          disabled={loading || code.length !== CODE_LEN || ttlExpired}
          className="w-full btn-gradient rounded-xl h-11"
          data-testid="button-admin-verify"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Войти как admin"}
        </Button>
      </form>

      <div className="flex items-center justify-between pt-2 border-t border-white/10">
        <button
          type="button"
          onClick={handleResend}
          disabled={resendCooldown > 0 || resending}
          className="text-xs text-muted-foreground hover:text-white disabled:opacity-50 transition-colors flex items-center gap-1.5"
          data-testid="button-admin-resend"
        >
          {resending ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          {resendCooldown > 0
            ? `Новый код через ${resendCooldown} сек`
            : "Получить код заново"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-muted-foreground hover:text-white transition-colors"
            data-testid="button-admin-cancel"
          >
            Отменить
          </button>
        )}
      </div>

      <div className="pt-3 border-t border-white/[0.05]">
        <p className="text-[10px] text-muted-foreground/70 leading-relaxed flex items-start gap-1.5">
          <Mail className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>
            Если письма нет — проверьте «Спам». При проблемах со связью используйте
            ADMIN_2FA_BYPASS=1 на VPS.
          </span>
        </p>
      </div>
    </div>
  );
}
