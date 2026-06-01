// Eugene 2026-05-17 Босс: модалка email-2FA подтверждения для admin actions.
//
// Триггерится когда server возвращает { requiresEmailConfirm: true, actionId, ... }.
// Юзер:
//   1. Видит сообщение «Код отправлен на admin@..., введи 6 цифр»
//   2. Вводит код в input (auto-focus, paste-friendly)
//   3. Timer 10 минут (отображается обратный отсчёт)
//   4. Клик «Подтвердить» → POST /protected-action/confirm
//   5. При success → callback с actionId → caller повторно вызывает action
//      с confirmedActionId
//
// Brand-style consistency rule (Eugene 2026-05-17):
// - font-display для title (gradient-text)
// - font-mono для кода
// - glass-card + brand gradient borders
// - btn-cosmic style для CTA

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface PendingConfirmInfo {
  actionId: string;
  action: string;             // e.g. "kick_session"
  actionLabel?: string;       // RU label
  expiresAt: string;          // ISO
  message: string;
  // Test mode (ADMIN_2FA_DISABLE=1) — plain code приходит в response,
  // показываем юзеру для копи-пасты (только на clone).
  testCode?: string;
}

interface Props {
  open: boolean;
  pending: PendingConfirmInfo | null;
  authToken?: string;          // Bearer token админа
  onConfirmed: (actionId: string) => void;  // callback после успешного confirm
  onCancel: () => void;
}

const ACTION_LABELS_RU: Record<string, string> = {
  change_registration_status: "Изменить статус регистрации",
  kick_session: "Удалить все сессии юзера (force logout)",
  query_users: "Поиск юзеров по PII",
  send_telegram_alert: "Отправить Telegram-сообщение админу",
  reload_kb: "Перезагрузить knowledge base бота",
  pause_bot: "Пауза/возобновление Telegram-бота",
  restart_pm2: "Перезапуск pm2-процесса",
  delete_user: "Удалить юзера (hard-delete)",
  refund_payment: "Возврат платежа",
};

export function AdminConfirmAction({ open, pending, authToken, onConfirmed, onCancel }: Props) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [remainingMs, setRemainingMs] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Timer countdown
  useEffect(() => {
    if (!open || !pending?.expiresAt) return;
    const expiresMs = Date.parse(pending.expiresAt);
    const tick = () => {
      const left = Math.max(0, expiresMs - Date.now());
      setRemainingMs(left);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [open, pending?.expiresAt]);

  // Auto-focus input on open + reset
  useEffect(() => {
    if (open) {
      setCode("");
      setError(null);
      setSubmitting(false);
      // Slight delay чтобы Dialog успел смонтировать input
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const submitCode = useCallback(
    async (codeToSubmit: string) => {
      if (!pending) return;
      if (codeToSubmit.length !== 6) {
        setError("Введи 6 цифр");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
        const r = await fetch("/api/admin/v304/protected-action/confirm", {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({ actionId: pending.actionId, code: codeToSubmit }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j?.error) {
          const msg = j?.error || `HTTP ${r.status}`;
          const remaining = j?.remainingAttempts;
          setError(
            remaining !== undefined
              ? `${msg}. Осталось попыток: ${remaining}`
              : msg,
          );
          setSubmitting(false);
          return;
        }
        // Success
        onConfirmed(pending.actionId);
      } catch (e: any) {
        setError(e?.message || String(e));
        setSubmitting(false);
      }
    },
    [pending, authToken, onConfirmed],
  );

  const handleCodeChange = (raw: string) => {
    // Принимаем только цифры, обрезаем до 6
    const cleaned = raw.replace(/\D/g, "").slice(0, 6);
    setCode(cleaned);
    setError(null);
    // Auto-submit когда 6 цифр (если не отправляем уже)
    if (cleaned.length === 6 && !submitting) {
      submitCode(cleaned);
    }
  };

  const fmtTime = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  };

  const expired = remainingMs <= 0 && open;
  const actionLabel =
    pending?.actionLabel || (pending && ACTION_LABELS_RU[pending.action]) || pending?.action || "";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent
        className="max-w-md bg-gradient-to-br from-[#1a0f2e] via-[#0a0a17] to-[#0f1830] border border-purple-500/30 backdrop-blur-xl"
        data-testid="admin-confirm-action-modal"
      >
        <DialogHeader>
          <DialogTitle className="font-display font-bold text-2xl bg-gradient-to-r from-purple-400 via-fuchsia-400 to-blue-400 bg-clip-text text-transparent">
            🔐 Подтверждение admin-действия
          </DialogTitle>
          <DialogDescription className="font-sans text-sm text-white/70 mt-2">
            {actionLabel ? (
              <span>
                Действие: <strong className="text-white">{actionLabel}</strong>
              </span>
            ) : (
              "Введи 6-значный код из email"
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="font-sans text-sm text-white/80 leading-relaxed">
            {pending?.message ||
              "Код подтверждения отправлен на email админа. Действует 10 минут."}
          </p>

          {pending?.testCode && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-[11px] font-sans text-amber-300 uppercase tracking-wider mb-1">
                Test mode (ADMIN_2FA_DISABLE=1)
              </p>
              <p className="font-mono text-lg text-amber-200">{pending.testCode}</p>
              <p className="text-[10px] text-amber-300/70 mt-1">
                В prod это поле не возвращается. Только для clone-тестов.
              </p>
            </div>
          )}

          <div>
            <label className="text-xs text-white/60 font-sans uppercase tracking-wider mb-2 block">
              Код подтверждения
            </label>
            <input
              ref={inputRef}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => handleCodeChange(e.target.value)}
              onPaste={(e) => {
                // Allow paste — handleCodeChange отфильтрует
                const text = e.clipboardData.getData("text");
                if (text) {
                  e.preventDefault();
                  handleCodeChange(text);
                }
              }}
              disabled={submitting || expired}
              placeholder="000000"
              className="w-full px-4 py-3 text-center text-3xl font-mono font-bold tracking-[0.5em] bg-black/40 border border-purple-500/30 rounded-xl text-white placeholder:text-white/20 focus:outline-none focus:border-purple-400 focus:shadow-[0_0_24px_rgba(124,58,237,0.4)] transition-all input-glow"
              data-testid="admin-confirm-code-input"
            />
          </div>

          <div className="flex items-center justify-between text-xs font-sans">
            <span className={remainingMs < 60_000 ? "text-red-400" : "text-white/50"}>
              ⏱ Истекает через: <span className="font-mono">{fmtTime(remainingMs)}</span>
            </span>
            {expired && (
              <span className="text-red-400">Код истёк — запроси новый</span>
            )}
          </div>

          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3">
              <p className="font-sans text-sm text-red-300">{error}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            onClick={onCancel}
            disabled={submitting}
            className="text-white/70 hover:text-white"
            data-testid="admin-confirm-cancel"
          >
            Отмена
          </Button>
          <Button
            onClick={() => submitCode(code)}
            disabled={submitting || expired || code.length !== 6}
            className="bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 hover:from-purple-600 hover:via-fuchsia-600 hover:to-blue-600 text-white font-medium shadow-[0_0_24px_rgba(124,58,237,0.4)]"
            data-testid="admin-confirm-submit"
          >
            {submitting ? "Проверяю..." : "Подтвердить"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Helper: парсит результат tool-call от Музы и detectит requiresEmailConfirm.
// Server-side require2FA() возвращает JSON.stringify({requiresEmailConfirm:true,...})
// как tool-result string. Caller проверяет — если parse удался и есть флаг,
// показывает AdminConfirmAction modal.
export function detectPendingConfirm(toolResultText: string): PendingConfirmInfo | null {
  if (!toolResultText || typeof toolResultText !== "string") return null;
  const trimmed = toolResultText.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const j = JSON.parse(trimmed);
    if (j?.requiresEmailConfirm && j?.actionId) {
      return {
        actionId: String(j.actionId),
        action: String(j.action || ""),
        actionLabel: j.actionLabel,
        expiresAt: String(j.expiresAt || ""),
        message: String(j.message || "Введи код из email"),
        testCode: j.testCode ? String(j.testCode) : undefined,
      };
    }
  } catch {}
  return null;
}
