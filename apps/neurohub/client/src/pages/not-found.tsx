import { useEffect } from "react";
import { Link } from "wouter";
import { useLocation } from "wouter/use-hash-location";
import { Button } from "@/components/ui/button";
import { Home } from "lucide-react";

// Eugene 2026-05-10 «реши кардинально»: NotFoundPage теперь catch-all
// для известных роутов с трейлингом — любой /music?tab=audio,
// /dashboard?something, /admin/что-то и т.п. перехватываем и
// переадресуем на canonical путь без query. Это закрывает legacy
// share-ссылки старого формата + кэш браузера + расхождения wouter
// useHashLocation с query в hash.
const KNOWN_ROUTES = [
  "/music",
  "/dashboard",
  "/admin/v304",
  "/admin",
  "/lyrics",
  "/templates",
  "/covers",
  "/track",
  "/play",
  "/share",
  "/login",
  "/register",
  "/forgot-password",
  "/payment/success",
  "/payment/fail",
  "/telegram-callback",
];

export default function NotFoundPage() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    try {
      const fullHash = window.location.hash || "";
      const hashPath = fullHash.startsWith("#") ? fullHash.slice(1) : fullHash;
      const qIdx = hashPath.indexOf("?");
      const path = qIdx >= 0 ? hashPath.slice(0, qIdx) : hashPath;
      const query = qIdx >= 0 ? hashPath.slice(qIdx + 1) : "";

      // Совпадение с известным роутом (длинные раньше — /admin/v304 до /admin)
      const sortedRoutes = [...KNOWN_ROUTES].sort((a, b) => b.length - a.length);
      const matched = sortedRoutes.find(
        r => path === r || path.startsWith(r + "/") || path.startsWith(r + "?"),
      );
      if (!matched) return;

      // /music?tab=* → выставляем localStorage и идём на /music чисто
      if (matched === "/music" && query) {
        const params = new URLSearchParams(query);
        const tab = params.get("tab");
        if (tab === "audio" || tab === "basic" || tab === "advanced") {
          localStorage.setItem("music_mode", tab);
          if (tab === "audio") localStorage.setItem("music_audio_mode", "advanced");
          localStorage.setItem("music_mode_v2", "1");
          sessionStorage.setItem("_pendingMusicScroll", "1");
        }
      }

      setLocation(matched);
    } catch {}
  }, [setLocation]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 hero-gradient">
      <div className="text-center">
        <h1 className="text-6xl font-bold gradient-text mb-4" data-testid="text-404">404</h1>
        <p className="text-muted-foreground mb-6">Страница не найдена</p>
        <Link href="/">
          <Button className="btn-gradient rounded-full px-6" data-testid="link-back-home">
            <Home className="w-4 h-4 mr-2" />
            На главную
          </Button>
        </Link>
      </div>
    </div>
  );
}
