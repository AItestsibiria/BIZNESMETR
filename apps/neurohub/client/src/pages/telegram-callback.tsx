import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";

export default function TelegramCallback() {
  const [, navigate] = useLocation();
  const { refreshUser } = useAuth();
  const [error, setError] = useState("");

  useEffect(() => {
    // Telegram returns data as hash fragment: #tgAuthResult=<base64json>
    // Or via query params after redirect
    const processAuth = async () => {
      try {
        // Try hash fragment first (Telegram widget redirect)
        const hash = window.location.hash;
        let tgData: any = null;

        // Check for tgAuthResult in the URL fragment
        const tgAuthMatch = hash.match(/tgAuthResult=([^&]+)/);
        if (tgAuthMatch) {
          try {
            tgData = JSON.parse(atob(tgAuthMatch[1]));
          } catch {}
        }

        // Also check query params (some Telegram flows use these)
        if (!tgData) {
          const params = new URLSearchParams(window.location.search);
          const id = params.get("id");
          if (id) {
            tgData = {
              id: params.get("id"),
              first_name: params.get("first_name"),
              last_name: params.get("last_name"),
              username: params.get("username"),
              photo_url: params.get("photo_url"),
              auth_date: params.get("auth_date"),
              hash: params.get("hash"),
            };
          }
        }

        // Also try fragment params (hash-based routing)
        if (!tgData) {
          const fragIdx = hash.indexOf("?");
          if (fragIdx !== -1) {
            const fragParams = new URLSearchParams(hash.slice(fragIdx));
            const id = fragParams.get("id");
            if (id) {
              tgData = {
                id: fragParams.get("id"),
                first_name: fragParams.get("first_name"),
                last_name: fragParams.get("last_name"),
                username: fragParams.get("username"),
                photo_url: fragParams.get("photo_url"),
                auth_date: fragParams.get("auth_date"),
                hash: fragParams.get("hash"),
              };
            }
          }
        }

        if (!tgData || !tgData.id) {
          setError("Не удалось получить данные от Telegram. Попробуйте ещё раз.");
          setTimeout(() => navigate("/login"), 3000);
          return;
        }

        const res = await apiRequest("POST", "/api/auth/telegram", tgData);
        const data = await res.json();
        if (data.token) {
          localStorage.setItem("token", data.token);
          await refreshUser();
          navigate("/dashboard");
        } else {
          setError(data.message || "Ошибка авторизации");
          setTimeout(() => navigate("/login"), 3000);
        }
      } catch (e: any) {
        setError("Ошибка: " + (e.message || "попробуйте ещё раз"));
        setTimeout(() => navigate("/login"), 3000);
      }
    };

    processAuth();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 hero-gradient">
      <div className="text-center">
        {error ? (
          <div>
            <p className="text-red-400 text-sm">{error}</p>
            <p className="text-muted-foreground text-xs mt-2">Перенаправление...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
            <p className="text-sm text-muted-foreground">Авторизация через Telegram...</p>
          </div>
        )}
      </div>
    </div>
  );
}
