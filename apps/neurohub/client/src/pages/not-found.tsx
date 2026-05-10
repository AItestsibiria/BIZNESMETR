import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Home } from "lucide-react";

export default function NotFoundPage() {
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
