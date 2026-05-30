// Eugene 2026-05-30 Босс «сначала проверка потом доступ в кабинет».
//
// AdminGate — обёртка для admin shell. БЛОКИРУЕТ рендер children'ов до
// успешной проверки двух гейтов: (1) admin-auth (role admin|super_admin) +
// (2) IP в ADMIN_TRUSTED_IPS. Если IP не доверен — экран email-fallback
// (вводит 6-значный код, полученный на email). НИКАКОГО мелькания
// содержимого кабинета — пока state !== "granted", children не рендерятся.
//
// Источник правды гейтов — GET /api/admin/v304/whoami-ip (один запрос на
// оба гейта, без побочных эффектов; маски, без raw values секретов).
// Email-fallback flow — POST /api/auth/admin-ip-confirm {email, code}
// (existing endpoint в server/routes.ts:1925).
//
// Связано с правилами CLAUDE.md:
//   - Admin-panel-IP-hard-gate + email-fallback rule
//   - Director-obeys-authorized-admin rule (два гейта на каждом admin-endpoint)
//   - Brand-style consistency rule (gradient/glass-card/font-display)
//   - Russian-communication rule (все тексты по-русски)
//   - Secrets-admin-only rule (никаких raw значений в UI)
//   - Reuse-working-solutions rule (whoami-ip + admin-ip-confirm уже работают)
//   - No-duplicates rule (одна точка авторизации перед admin shell)

import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { CyberSpinner } from "@/components/cyber-spinner";

type WhoamiData = {
  detectedIp: string | null;
  allCandidates?: string[];
  gateEnabled: boolean;
  trustedListSize: number;
  isCurrentlyTrusted: boolean;
  access: string;
};

type GateState =
  | { kind: "checking" }
  | { kind: "granted"; whoami: WhoamiData }
  | { kind: "denied-not-admin"; reason: string }
  | { kind: "denied-ip"; whoami: WhoamiData }
  | { kind: "need-login" };

export function AdminGate({ children }: { children: ReactNode }) {
  const { user, isLoading: authLoading } = useAuth();
  const [state, setState] = useState<GateState>({ kind: "checking" });

  async function runGateCheck() {
    setState({ kind: "checking" });
    // Если AuthProvider ещё грузит сессию — ждём.
    if (authLoading) return;
    if (!user) {
      setState({ kind: "need-login" });
      return;
    }
    try {
      const r = await fetch("/api/admin/v304/whoami-ip", {
        credentials: "include",
      });
      if (r.status === 403) {
        setState({
          kind: "denied-not-admin",
          reason: "Эта учётка не админ или сессия истекла.",
        });
        return;
      }
      if (!r.ok) {
        setState({
          kind: "denied-not-admin",
          reason: `Сервер ответил HTTP ${r.status}.`,
        });
        return;
      }
      const j = await r.json();
      const w: WhoamiData | null = j?.data || null;
      if (!w) {
        setState({
          kind: "denied-not-admin",
          reason: j?.error || "Не удалось получить статус гейтов.",
        });
        return;
      }
      // Гейт 1 пройден (whoami-ip ответил 200 = админ-роль ОК).
      // Гейт 2 — IP. Если гейт ВЫКЛЮЧЕН (ADMIN_TRUSTED_IPS пуст) — пропускаем.
      // Если IP в списке — пропускаем. Иначе — denied + email-fallback.
      if (!w.gateEnabled || w.isCurrentlyTrusted) {
        setState({ kind: "granted", whoami: w });
        return;
      }
      setState({ kind: "denied-ip", whoami: w });
    } catch (e: any) {
      setState({
        kind: "denied-not-admin",
        reason: `Ошибка сети: ${e?.message || String(e)}`,
      });
    }
  }

  // Запускаем проверку, когда AuthProvider закончил восстанавливать сессию.
  useEffect(() => {
    if (authLoading) return;
    runGateCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  if (state.kind === "granted") {
    return <>{children}</>;
  }

  // ВСЕ остальные ветки рендерят только gate-экран — НИКАКОГО admin
  // контента до granted. Это и есть жёсткий порядок «сначала проверка».
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-[#0a0a17] via-[#1a0f2e] to-[#0a0a17]">
      <div className="w-full max-w-md glass-card rounded-2xl p-6 sm:p-8 border border-purple-500/30 shadow-[0_0_32px_rgba(124,58,237,0.25)]">
        <div className="flex items-center gap-3 mb-4">
          <span className="text-3xl">🔐</span>
          <h1 className="text-xl sm:text-2xl font-display font-bold gradient-text">
            Проверка доступа в админку
          </h1>
        </div>

        {state.kind === "checking" && (
          <div className="flex flex-col items-center gap-4 py-6">
            <CyberSpinner sizePx={56} label="Проверяю авторизацию и IP" />
            <div className="text-sm font-sans text-white/70 text-center">
              Проверяю авторизацию и IP…
            </div>
            <div className="text-xs font-sans text-white/40 text-center">
              Кабинет откроется только после успешной проверки двух гейтов.
            </div>
          </div>
        )}

        {state.kind === "need-login" && (
          <div className="space-y-4">
            <div className="text-sm font-sans text-white/80">
              Чтобы открыть админку, нужно войти под админом.
            </div>
            <a
              href="#/login"
              className="block w-full text-center px-4 py-2.5 rounded-xl font-medium text-white bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 shadow-[0_0_24px_rgba(124,58,237,0.4)] hover:shadow-[0_0_32px_rgba(124,58,237,0.55)] transition-shadow"
            >
              Войти в систему
            </a>
          </div>
        )}

        {state.kind === "denied-not-admin" && (
          <div className="space-y-4">
            <div className="text-sm font-sans text-red-300">
              🔴 Гейт 1 (админ-авторизация) не пройден.
            </div>
            <div className="text-xs font-sans text-white/60">{state.reason}</div>
            <div className="flex gap-2">
              <button
                onClick={runGateCheck}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-medium text-white/80 bg-white/5 border border-purple-400/20 hover:bg-white/10"
              >
                ↻ Проверить ещё раз
              </button>
              <a
                href="#/login"
                className="flex-1 text-center px-3 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500"
              >
                → Войти
              </a>
            </div>
          </div>
        )}

        {state.kind === "denied-ip" && (
          <DeniedIpView
            whoami={state.whoami}
            userEmail={user?.email || ""}
            onConfirmed={runGateCheck}
          />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Email-fallback вид: показывает причину, кнопку «Получить код по email»
// (использует existing /api/auth/login flow → 202 + email code), потом
// поле ввода 6-значного кода (POST /api/auth/admin-ip-confirm).
// ─────────────────────────────────────────────────────────────────────────

function DeniedIpView({
  whoami,
  userEmail,
  onConfirmed,
}: {
  whoami: WhoamiData;
  userEmail: string;
  onConfirmed: () => void;
}) {
  const [step, setStep] = useState<"info" | "ask-creds" | "code" | "verifying">(
    "info",
  );
  const [email, setEmail] = useState(userEmail || "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sentMask, setSentMask] = useState<string | null>(null);

  async function requestCode() {
    setErr(null);
    if (!email || !password) {
      setErr("Введи email и пароль — нужно для повторной отправки кода.");
      return;
    }
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 202 && j?.requireIpConfirm) {
        setSentMask(j.email || null);
        setStep("code");
        return;
      }
      if (r.status === 200 && j?.token) {
        // Совсем неожиданно — гейт 2 уже пройден на сервере (IP стал
        // доверенным между нашим whoami и этим логином, или ADMIN_TRUSTED_IPS
        // только что очистили). Откроем кабинет — проверка прокатит.
        onConfirmed();
        return;
      }
      setErr(j?.message || `Сервер ответил HTTP ${r.status}.`);
    } catch (e: any) {
      setErr(`Ошибка сети: ${e?.message || String(e)}`);
    }
  }

  async function confirmCode() {
    setErr(null);
    if (!email || !code) {
      setErr("Нужен email и 6-значный код из письма.");
      return;
    }
    setStep("verifying");
    try {
      const r = await fetch("/api/auth/admin-ip-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.token) {
        // Сохраняем токен в cookie auth_token (тот же ключ что в lib/auth.tsx).
        // Делаем reload — AuthProvider подхватит новый токен, AdminGate снова
        // вызовет whoami-ip → granted (IP теперь доверен сессией).
        try {
          const d = new Date();
          d.setTime(d.getTime() + 90 * 86400000);
          document.cookie = `auth_token=${j.token};expires=${d.toUTCString()};path=/;SameSite=Lax`;
        } catch { /* swallow */ }
        // Полный reload вместо in-place set — гарантия что нигде не
        // остался stale state и admin-страница начнёт с чистого gate-чека.
        window.location.reload();
        return;
      }
      setErr(j?.message || `Сервер ответил HTTP ${r.status}. Код не подошёл.`);
      setStep("code");
    } catch (e: any) {
      setErr(`Ошибка сети: ${e?.message || String(e)}`);
      setStep("code");
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-sm font-sans text-red-300">
        🔴 Гейт 2 (IP) не пройден.
      </div>
      <div className="rounded-lg bg-white/5 border border-white/10 p-3 space-y-1 text-xs font-sans text-white/70">
        <div>
          Твой IP:{" "}
          <span className="font-mono text-white/90">
            {whoami.detectedIp || "не определён"}
          </span>
        </div>
        <div>
          В белом списке: {whoami.trustedListSize} шт. — этого IP среди них нет.
        </div>
        <div className="text-white/50 pt-1">{whoami.access}</div>
      </div>

      {step === "info" && (
        <>
          <div className="text-sm font-sans text-white/80">
            Получи 6-значный код подтверждения на свой email админа. Действует
            3 минуты.
          </div>
          <button
            onClick={() => setStep("ask-creds")}
            className="w-full px-4 py-2.5 rounded-xl font-medium text-white bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 shadow-[0_0_24px_rgba(124,58,237,0.4)] hover:shadow-[0_0_32px_rgba(124,58,237,0.55)] transition-shadow"
          >
            📧 Получить код по email
          </button>
        </>
      )}

      {step === "ask-creds" && (
        <>
          <div className="text-xs font-sans text-white/60">
            Введи свой email и пароль админа — сервер отправит код подтверждения.
          </div>
          <input
            type="email"
            placeholder="email админа"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            className="w-full px-3 py-2 rounded-lg bg-black/40 border border-purple-400/20 text-white text-sm input-glow"
          />
          <input
            type="password"
            placeholder="пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="w-full px-3 py-2 rounded-lg bg-black/40 border border-purple-400/20 text-white text-sm input-glow"
            onKeyDown={(e) => {
              if (e.key === "Enter") requestCode();
            }}
          />
          {err && (
            <div className="text-xs font-sans text-red-300">{err}</div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => {
                setStep("info");
                setErr(null);
              }}
              className="flex-1 px-3 py-2 rounded-lg text-sm font-medium text-white/70 bg-white/5 border border-white/10 hover:bg-white/10"
            >
              ← Назад
            </button>
            <button
              onClick={requestCode}
              className="flex-1 px-3 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500"
            >
              Отправить код
            </button>
          </div>
        </>
      )}

      {(step === "code" || step === "verifying") && (
        <>
          <div className="text-xs font-sans text-white/70">
            Код отправлен на {sentMask || email}. Действует 3 минуты. Письмо
            содержит и код, и одноразовую ссылку — кликни ссылку либо введи
            6 цифр сюда.
          </div>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            placeholder="6-значный код"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) =>
              setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
            }
            disabled={step === "verifying"}
            className="w-full px-3 py-3 rounded-lg bg-black/40 border border-purple-400/20 text-white text-2xl font-mono tracking-[0.4em] text-center input-glow disabled:opacity-50"
            onKeyDown={(e) => {
              if (e.key === "Enter" && step !== "verifying") confirmCode();
            }}
          />
          {err && (
            <div className="text-xs font-sans text-red-300">{err}</div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => {
                setStep("ask-creds");
                setCode("");
                setErr(null);
              }}
              disabled={step === "verifying"}
              className="flex-1 px-3 py-2 rounded-lg text-sm font-medium text-white/70 bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-50"
            >
              ← Получить новый код
            </button>
            <button
              onClick={confirmCode}
              disabled={step === "verifying" || code.length !== 6}
              className="flex-1 px-3 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 disabled:opacity-50"
            >
              {step === "verifying" ? "Проверяю…" : "Подтвердить"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
