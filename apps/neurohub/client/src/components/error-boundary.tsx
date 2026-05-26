// ErrorBoundary — ловит React-runtime ошибки, чтобы вместо чёрного экрана
// пользователь видел красный фолбэк с текстом ошибки и кнопкой «На главную».
// ТЗ Eugene 2026-05-07: «Реши тотально проблему» с /dashboard черный.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  pageName?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  info: ErrorInfo | null;
  showDetails: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, info: null, showDetails: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info });
    // Помимо UI — записываем в консоль для F12
    console.error(`[ErrorBoundary] ${this.props.pageName ?? "page"}:`, error, info);
    // И отправляем на сервер для логирования (best-effort)
    try {
      fetch("/api/_client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page: this.props.pageName,
          message: error.message,
          stack: error.stack?.slice(0, 4000),
          componentStack: info.componentStack?.slice(0, 2000),
          url: typeof window !== "undefined" ? window.location.href : "",
          ts: new Date().toISOString(),
        }),
      }).catch(() => {});
    } catch {}
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    const err = this.state.error;
    // Eugene 2026-05-26 Босс «при сбое — страница в стиле MuzaAi (как на главной),
    // ошибки в админ + анализ, а для меня слева внизу круг → по тапу вижу ошибки».
    // Юзер видит спокойную брендовую страницу (без стека). Круг с деталями —
    // только залогиненным (есть auth_token), это «для меня».
    let loggedIn = false;
    try { loggedIn = !!localStorage.getItem("auth_token"); } catch {}
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 gap-5 text-center relative overflow-hidden bg-[#0a0a17]"
        style={{ backgroundImage: "radial-gradient(ellipse at 30% 20%, rgba(124,58,237,0.18) 0%, transparent 55%), radial-gradient(ellipse at 75% 80%, rgba(0,212,255,0.12) 0%, transparent 60%)" }}>
        {/* Лого MuzaAi */}
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-purple-500 via-fuchsia-500 to-blue-500 flex items-center justify-center shadow-lg shadow-purple-500/40">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none"><path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="white" strokeWidth="2" strokeLinecap="round" /></svg>
          </div>
          <span className="text-2xl font-display font-bold gradient-text">MuzaAi</span>
        </div>
        {/* Бейдж как на главной */}
        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-background/70 border border-white/15 text-[11px] font-bold text-white uppercase tracking-wider">
          <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-400 animate-pulse" />
          Платформа Ai на тестировании
        </span>
        <h1 className="text-xl sm:text-2xl font-display font-bold text-white">Секунду — что-то сбойнуло</h1>
        <p className="text-sm text-white/60 max-w-sm">
          Мы на тестировании и уже видим эту ошибку — чиним. Попробуй обновить или вернись на главную 💜
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => { this.setState({ hasError: false, error: null, info: null, showDetails: false }); }}
            className="px-4 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-purple-500 via-fuchsia-500 to-blue-500 shadow-[0_0_20px_rgba(124,58,237,0.4)] active:scale-95 transition-transform"
          >
            Попробовать снова
          </button>
          <button
            onClick={() => { window.location.href = "/"; }}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-white/5 hover:bg-white/10 border border-white/15 text-white/80"
          >
            На главную
          </button>
        </div>

        {/* Круг для админа (слева внизу) — по тапу показывает детали ошибки. */}
        {loggedIn && (
          <button
            onClick={() => this.setState(s => ({ showDetails: !s.showDetails }))}
            aria-label="Показать детали ошибки"
            title="Детали ошибки (для админа)"
            className="fixed bottom-4 left-4 z-[60] w-9 h-9 rounded-full bg-gradient-to-br from-fuchsia-500 to-purple-600 border border-white/30 shadow-[0_0_16px_rgba(217,70,239,0.6)] active:scale-90 transition-transform flex items-center justify-center text-white text-[13px]"
          >
            {this.state.showDetails ? "✕" : "!"}
          </button>
        )}
        {loggedIn && this.state.showDetails && err && (
          <pre className="fixed bottom-16 left-4 right-4 sm:right-auto sm:max-w-xl z-[60] text-[11px] text-fuchsia-100 bg-[#1a0f2e]/95 backdrop-blur-md border border-fuchsia-500/40 rounded-xl p-3 max-h-[50vh] overflow-auto whitespace-pre-wrap shadow-2xl text-left">
            {this.props.pageName ? `Page: ${this.props.pageName}\n` : ""}{err.message}
            {err.stack && `\n\n${err.stack.split("\n").slice(0, 8).join("\n")}`}
          </pre>
        )}
      </div>
    );
  }
}
