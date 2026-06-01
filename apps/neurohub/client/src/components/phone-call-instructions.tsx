// Eugene 2026-05-18 Босс «На планшете показывает 8800 но юзер не может
// позвонить — нужен другой UX». Компонент для tablet/desktop:
//
//  - Большой 8800 номер моноширинным шрифтом с подсветкой + кнопка «📋 Скопировать»
//  - QR-код с tel:// URL — юзер сканирует со смартфона, тот тут же набирает
//  - Подпись «Возьмите смартфон с номером [userPhone], наберите 8800»
//  - Альтернатива «Войти через email»
//
// Стиль премиальный/чистый (по правилу Brand-style consistency):
// glass-card backdrop, font-display titles, gradient borders, neon glow
// на кнопках. CSS utilities из index.css (glass-card, gradient-text,
// neon-text, holographic, btn-cosmic).

import { useEffect, useRef, useState } from "react";
import QRCodeStyling from "qr-code-styling";
import { Copy, Check, Phone, Smartphone, Mail, ScanLine, ShieldCheck } from "lucide-react";
import { Link } from "wouter";

interface PhoneCallInstructionsProps {
  /** 8800 номер на который юзер должен позвонить (callPhone — raw, без форматирования). */
  dialNumber: string;
  /** Pretty-форматированный 8800 номер для display. */
  dialNumberPretty?: string;
  /** Номер пользователя (нормализованный E.164) — показываем «возьмите смартфон с этим номером». */
  userPhone: string;
  /** Сколько секунд осталось до истечения окна звонка. */
  expiresInSec: number;
  /** Окно истекло — показать fallback на email. */
  expired: boolean;
  /** Onclick для повтора звонка. */
  onRetry: () => void;
  /** Onclick для смены номера. */
  onChangePhone: () => void;
  /** Если есть ошибка от backend — отобразить. */
  errorText?: string | null;
  /** Cooldown для retry-кнопки. */
  cooldown?: number;
  /** Loading state. */
  loading?: boolean;
}

function createCallQR(telUrl: string, size = 220): QRCodeStyling {
  return new QRCodeStyling({
    width: size,
    height: size,
    margin: Math.round(size * 0.06),
    type: "svg",
    data: telUrl,
    dotsOptions: {
      color: "#1a1a2e",
      type: "rounded",
      gradient: {
        type: "linear",
        rotation: 45,
        colorStops: [
          { offset: 0, color: "#7c3aed" },
          { offset: 1, color: "#3b82f6" },
        ],
      },
    },
    cornersSquareOptions: {
      type: "extra-rounded",
      color: "#7c3aed",
    },
    cornersDotOptions: {
      type: "dot",
      color: "#4c1d95",
    },
    backgroundOptions: {
      color: "#ffffff",
    },
    qrOptions: {
      errorCorrectionLevel: "H",
    },
  });
}

export function PhoneCallInstructions({
  dialNumber,
  dialNumberPretty,
  userPhone,
  expiresInSec,
  expired,
  onRetry,
  onChangePhone,
  errorText,
  cooldown,
  loading,
}: PhoneCallInstructionsProps) {
  const qrRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  // tel:// URL — нормализуем (убираем всё кроме + и цифр)
  const telUrl = `tel:${(dialNumber || "").replace(/[^+0-9]/g, "")}`;
  const displayNumber = dialNumberPretty || dialNumber || "—";

  // Render QR code on mount/dialNumber change
  useEffect(() => {
    if (!qrRef.current || !dialNumber) return;
    qrRef.current.innerHTML = "";
    try {
      const qr = createCallQR(telUrl, 220);
      qr.append(qrRef.current);
    } catch (e) {
      // QR render fail — оставляем placeholder
      // eslint-disable-next-line no-console
      console.warn("[phone-call-instructions] QR render failed:", e);
    }
  }, [dialNumber, telUrl]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(dialNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback: open prompt
      try {
        window.prompt("Скопируйте номер вручную:", dialNumber);
      } catch {}
    }
  };

  const mm = String(Math.floor(expiresInSec / 60)).padStart(2, "0");
  const ss = String(expiresInSec % 60).padStart(2, "0");

  return (
    <div className="space-y-4">
      {/* Заголовок с номером юзера — «Возьмите смартфон с этим номером» */}
      <div className="text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-purple-500/10 border border-purple-400/30 text-purple-200 text-xs font-medium mb-2">
          <Smartphone className="w-3.5 h-3.5" />
          Возьмите смартфон с номером
        </div>
        <p className="text-base text-white font-display font-bold tracking-wide" data-testid="user-phone-display">
          {userPhone}
        </p>
      </div>

      {/* «ЗВОНОК БЕСПЛАТНЫЙ» — премиальный header */}
      <div className="text-center">
        <p className="text-xl sm:text-2xl font-display font-bold bg-gradient-to-r from-amber-400 via-amber-300 to-cyan-400 bg-clip-text text-transparent neon-text tracking-wide" data-testid="banner-call-free-tablet">
          ЗВОНОК БЕСПЛАТНЫЙ
        </p>
        <p className="text-[11px] text-amber-200/70 mt-1">
          <ShieldCheck className="w-3 h-3 inline -mt-0.5 mr-0.5" />
          Мы платим за вас — с вашего счёта ничего не спишется
        </p>
      </div>

      {/* Premium 8800 panel: gradient border + dark backdrop + mono font */}
      <div className="relative rounded-2xl border-2 border-purple-400/40 bg-gradient-to-br from-[#0a0a17] via-[#1a0f2e] to-[#0f1830] p-5 shadow-[0_0_32px_rgba(124,58,237,0.25)]">
        {/* Subtle scan-line for hi-tech vibe */}
        <div className="absolute inset-0 rounded-2xl scan-line pointer-events-none overflow-hidden" aria-hidden="true" />
        <div className="relative">
          <p className="text-[11px] uppercase tracking-widest text-purple-200/60 text-center mb-2">
            Номер для звонка
          </p>
          <div className="flex items-center justify-center gap-2">
            <Phone className="w-5 h-5 text-cyan-300 shrink-0" />
            <span
              className="text-2xl sm:text-3xl font-mono font-bold text-white tabular-nums tracking-wide select-all phone-pulse"
              data-testid="dial-number-display-tablet"
            >
              {displayNumber}
            </span>
          </div>
          <div className="flex items-center justify-center gap-2 mt-3">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 border border-purple-400/30 text-purple-200 text-xs font-medium hover:bg-white/10 hover:border-purple-400/50 transition-colors active:scale-95"
              data-testid="btn-copy-dial-number"
              aria-label="Скопировать номер"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Скопировано" : "Скопировать"}
            </button>
          </div>
        </div>
      </div>

      {/* Divider with «или» */}
      <div className="flex items-center gap-3 my-2">
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-purple-400/30 to-transparent" />
        <span className="text-[10px] uppercase tracking-widest text-purple-300/60">или сканируйте</span>
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-purple-400/30 to-transparent" />
      </div>

      {/* QR + scan-from-phone instructions */}
      <div className="rounded-2xl border border-cyan-400/30 bg-gradient-to-br from-[#0a0a17] via-[#0f1830] to-[#0a0a17] p-5 text-center">
        <div className="inline-flex items-center gap-1.5 text-xs text-cyan-200/80 mb-3">
          <ScanLine className="w-3.5 h-3.5" />
          Наведите камеру смартфона на QR
        </div>
        <div className="inline-flex flex-col items-center">
          <div className="relative p-3 rounded-xl bg-white shadow-[0_0_24px_rgba(0,212,255,0.25)] border border-cyan-400/20">
            <div className="absolute -inset-1 rounded-xl bg-gradient-to-br from-purple-500/15 via-transparent to-cyan-500/15 blur-md pointer-events-none" aria-hidden="true" />
            <div ref={qrRef} className="relative flex items-center justify-center" data-testid="qr-tel-link" />
          </div>
          <p className="text-[11px] text-muted-foreground mt-3 max-w-[260px] mx-auto leading-relaxed">
            Откроется приложение «Телефон» с уже набранным номером. Нажмите вызов, можно сразу сбросить — мы узнаем ваш номер.
          </p>
        </div>
      </div>

      {/* Timer / status */}
      {!expired && (
        <div className="text-center">
          <p className="text-[11px] text-muted-foreground">
            Ждём ваш звонок… <span className="font-mono tabular-nums text-white/80">{mm}:{ss}</span>
          </p>
        </div>
      )}

      {/* Expired — fallback на email */}
      {expired && (
        <div className="bg-gradient-to-br from-amber-500/10 via-orange-500/10 to-rose-500/10 border-2 border-amber-400/40 rounded-xl p-4 space-y-3">
          <div className="text-center">
            <p className="text-base text-white font-semibold">Звонок не прошёл?</p>
            <p className="text-xs text-amber-100/80 mt-1">
              Попробуйте ещё раз или войдите через email — это надёжнее с планшета.
            </p>
          </div>
          <Link href="/login">
            <a
              className="block w-full text-center px-4 py-4 rounded-xl bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 text-white text-base font-bold shadow-lg shadow-purple-500/30 hover:scale-[1.02] active:scale-[0.98] transition-transform"
              data-testid="link-email-auth-fallback-tablet"
            >
              <Mail className="w-5 h-5 inline mr-2 -mt-0.5" />
              Войти через email
            </a>
          </Link>
          <button
            type="button"
            onClick={onRetry}
            disabled={loading || (cooldown && cooldown > 0) || false}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-white/15 bg-white/[0.04] text-white/80 hover:bg-white/[0.08] hover:text-white transition-colors text-sm disabled:opacity-50"
            data-testid="btn-retry-call-tablet"
          >
            {cooldown && cooldown > 0 ? `Повторить звонок (${cooldown}с)` : "Попробовать звонок ещё раз"}
          </button>
        </div>
      )}

      {/* Error */}
      {errorText && !expired && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {errorText}
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between text-xs pt-2 border-t border-white/[0.04]">
        <button
          type="button"
          onClick={onChangePhone}
          disabled={loading}
          className="text-muted-foreground hover:text-white transition-colors"
        >
          ← Изменить номер
        </button>
        <Link href="/login">
          <a className="text-purple-300 hover:text-purple-200 transition-colors inline-flex items-center gap-1">
            <Mail className="w-3 h-3" />
            Войти через email
          </a>
        </Link>
      </div>
    </div>
  );
}
