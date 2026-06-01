import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useEffect } from "react";

export function PaymentSuccess() {
  const [, navigate] = useLocation();
  const { refreshUser } = useAuth();

  useEffect(() => {
    // Refresh balance after successful payment
    refreshUser();
  }, [refreshUser]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 pt-16">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-6">
          <CheckCircle2 className="w-8 h-8 text-green-400" />
        </div>
        <h1 className="text-xl font-bold text-white mb-2">Оплата прошла успешно</h1>
        <p className="text-muted-foreground mb-6">
          Баланс пополнен. Средства уже на вашем счёте.
        </p>
        <div className="flex gap-3 justify-center">
          <Button className="btn-gradient rounded-xl" onClick={() => navigate("/dashboard")} data-testid="button-to-dashboard">
            В личный кабинет
          </Button>
          <Button variant="outline" className="rounded-xl" onClick={() => navigate("/music")} data-testid="button-to-music">
            Создать музыку
          </Button>
        </div>
      </div>
    </div>
  );
}

export function PaymentFail() {
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen flex items-center justify-center px-4 pt-16">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-6">
          <XCircle className="w-8 h-8 text-red-400" />
        </div>
        <h1 className="text-xl font-bold text-white mb-2">Оплата не прошла</h1>
        <p className="text-muted-foreground mb-6">
          Платёж был отменён или произошла ошибка. Попробуйте ещё раз.
        </p>
        <div className="flex gap-3 justify-center">
          <Button className="btn-gradient rounded-xl" onClick={() => navigate("/dashboard")} data-testid="button-retry">
            Попробовать снова
          </Button>
          <Button variant="outline" className="rounded-xl" onClick={() => navigate("/")} data-testid="button-to-home">
            На главную
          </Button>
        </div>
      </div>
    </div>
  );
}
