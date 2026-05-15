import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { apiRequest } from "./queryClient";
import type { PublicUser } from "@shared/schema";

interface AuthContextType {
  user: PublicUser | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string, ref?: string, remember?: boolean, promo?: string) => Promise<any>;
  verifyRegister: (email: string, code: string, remember?: boolean) => Promise<any>;
  // Eugene 2026-05-15: для SMS-OTP / Telegram-login и других channel'ов
  // которые сами создают session token. Принимает token, дёргает /api/me
  // чтобы получить user info, сохраняет в state и cookie.
  loginByToken: (token: string, remember?: boolean) => Promise<PublicUser | null>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

// Cookie helpers (not localStorage — works in iframes)
function setCookie(name: string, value: string, days = 30) {
  const d = new Date(); d.setTime(d.getTime() + days * 86400000);
  document.cookie = `${name}=${value};expires=${d.toUTCString()};path=/;SameSite=Lax`;
}
function getCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? m[1] : null;
}
function deleteCookie(name: string) {
  document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
}

// Initialize token from cookie BEFORE any component renders
let globalToken: string | null = getCookie("auth_token");

export function getAuthToken(): string | null {
  return globalToken;
}

// Patch fetch to include auth header
const originalFetch = window.fetch;
window.fetch = async function(input, init) {
  if (globalToken && typeof input === 'string' && (input.includes('/api/') || input.includes('port/5000/api/'))) {
    const headers = new Headers(init?.headers);
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${globalToken}`);
    }
    return originalFetch.call(this, input, { ...init, headers });
  }
  return originalFetch.call(this, input, init);
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const setAuthState = useCallback((t: string | null, u: PublicUser | null, remember = true) => {
    globalToken = t;
    setToken(t);
    setUser(u);
    if (t) { setCookie("auth_token", t, remember ? 90 : undefined); } else { deleteCookie("auth_token"); }
  }, []);

  const refreshUser = useCallback(async () => {
    if (!globalToken) return;
    try {
      const res = await apiRequest("GET", "/api/auth/me");
      const data = await res.json();
      setUser(data);
    } catch {
      setAuthState(null, null);
    }
  }, [setAuthState]);

  // Restore session from cookie on page load
  useEffect(() => {
    const savedToken = getCookie("auth_token");
    if (savedToken) {
      globalToken = savedToken;
      setToken(savedToken);
      // Verify token is still valid
      apiRequest("GET", "/api/auth/me")
        .then(res => res.json())
        .then(data => {
          if (data && data.id) {
            setUser(data);
          } else {
            deleteCookie("auth_token");
            globalToken = null;
            setToken(null);
          }
        })
        .catch(() => {
          deleteCookie("auth_token");
          globalToken = null;
          setToken(null);
        })
        .finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, []);

  // Listen for auth:reset event dispatched by forgot-password page after successful reset
  useEffect(() => {
    const handler = (e: Event) => {
      const { token, user } = (e as CustomEvent).detail;
      if (token && user) {
        setAuthState(token, user);
      }
    };
    window.addEventListener("auth:reset", handler);
    return () => window.removeEventListener("auth:reset", handler);
  }, [setAuthState]);

  const login = useCallback(async (email: string, password: string, remember = true) => {
    const res = await apiRequest("POST", "/api/auth/login", { email, password });
    const data = await res.json();
    setAuthState(data.token, data.user, remember);
  }, [setAuthState]);

  const register = useCallback(async (name: string, email: string, password: string, ref?: string, remember = true, promo?: string) => {
    const res = await apiRequest("POST", "/api/auth/register", { name, email, password, ref, promo });
    const data = await res.json();
    if (data.needVerification) return data; // need email code
    setAuthState(data.token, data.user, remember);
    return data;
  }, [setAuthState]);

  const verifyRegister = useCallback(async (email: string, code: string, remember = true) => {
    const res = await apiRequest("POST", "/api/auth/verify-register", { email, code });
    const data = await res.json();
    setAuthState(data.token, data.user, remember);
    return data;
  }, [setAuthState]);

  // Eugene 2026-05-15: универсальный «у меня уже есть token, залогинь».
  // Используется SMS-OTP, Telegram-login, change_phone flow.
  const loginByToken = useCallback(async (newToken: string, remember = true) => {
    setAuthState(newToken, null, remember);
    try {
      const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${newToken}` } });
      if (res.ok) {
        const j = await res.json();
        const u = j?.data || j;
        setAuthState(newToken, u as PublicUser, remember);
        return u as PublicUser;
      }
    } catch {}
    return null;
  }, [setAuthState]);

  const logout = useCallback(async () => {
    try {
      await apiRequest("POST", "/api/auth/logout");
    } catch {}
    setAuthState(null, null);
  }, [setAuthState]);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, register, verifyRegister, loginByToken, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
