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
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, info: null };

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
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground p-6 gap-4">
        <div className="w-16 h-16 rounded-full bg-rose-500/20 flex items-center justify-center text-3xl">⚠️</div>
        <h1 className="text-2xl font-semibold text-rose-300">Страница упала с ошибкой</h1>
        {this.props.pageName && (
          <p className="text-sm text-muted-foreground">Page: {this.props.pageName}</p>
        )}
        {err && (
          <pre className="text-xs text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg p-4 max-w-2xl overflow-auto whitespace-pre-wrap">
            {err.message}
            {err.stack && `\n\n${err.stack.split("\n").slice(0, 6).join("\n")}`}
          </pre>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => { this.setState({ hasError: false, error: null, info: null }); }}
            className="px-4 py-2 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40"
          >
            Попробовать снова
          </button>
          <button
            onClick={() => { window.location.href = "/"; }}
            className="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10"
          >
            На главную
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground/60 max-w-md text-center">
          Ошибка отправлена на сервер. Если повторяется — F12 → Console → копируй красный stack-trace.
        </p>
      </div>
    );
  }
}
