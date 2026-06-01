// Eugene 2026-05-26 Босс «B2B-подсистема». Личный кабинет юрлица (ЛК ЮЛ).
// Фронт читает GET /api/corporate/cabinet/:id (auth + ownership на сервере;
// window.fetch патчится в lib/auth.tsx — Authorization добавляется сам).
// Все строки RU. Бренд-стиль (index.css): .glass-card / .gradient-text /
// font-display, палитра purple #7C3AED / cyan #00D4FF. Responsive, без
// горизонтального overflow на 375/768/1280 (Layout-fit / Device-fit rules).
import { useEffect, useState } from "react";
import { useRoute, Link } from "wouter";
import { getAuthToken } from "@/lib/auth";
import {
  Building2, FileText, Receipt, Wallet, Music, ArrowLeft,
  Loader2, AlertCircle, ExternalLink,
} from "lucide-react";

// Серверный ответ (snake_case в entity — отдаём строку как есть из БД).
interface LegalEntity {
  id: number;
  user_id: number;
  kind?: string;
  inn?: string | null;
  kpp?: string | null;
  ogrn?: string | null;
  name?: string | null;
  full_name?: string | null;
  legal_address?: string | null;
  actual_address?: string | null;
  director_name?: string | null;
  phone?: string | null;
  email?: string | null;
  bank_name?: string | null;
  bik?: string | null;
  settlement_account?: string | null;
  corr_account?: string | null;
  status?: string | null;
  balance?: number | null; // в копейках
}

interface CorporateContract {
  id: number;
  number?: string | null;
  status?: string | null;
  amount_rub?: number | null;
  invoice_id?: number | null;
  signed_at?: string | null;
  created_at?: string | null;
}

interface CorporateInvoice {
  id: number;
  amountRub?: number | null;
  description?: string | null;
  status?: string | null;
  expiresAt?: string | null;
  paidAt?: string | null;
  createdAt?: string | null;
}

interface CabinetResponse {
  entity: LegalEntity;
  contracts: CorporateContract[];
  invoices: CorporateInvoice[];
  balance: number; // копейки
}

// Копейки → «1 234 ₽».
function kopToRub(kop: number | null | undefined): string {
  const v = Math.round((Number(kop) || 0) / 100);
  return `${v.toLocaleString("ru-RU")} ₽`;
}
// Рубли → «1 234 ₽».
function rub(n: number | null | undefined): string {
  return `${Math.round(Number(n) || 0).toLocaleString("ru-RU")} ₽`;
}

const contractStatusLabel: Record<string, string> = {
  signed: "Подписан",
  draft: "Черновик",
  pending: "В обработке",
  cancelled: "Отменён",
};
const invoiceStatusLabel: Record<string, string> = {
  issued: "Ожидает оплаты",
  paid: "Оплачен",
  expired: "Просрочен",
  cancelled: "Отменён",
};
const invoiceStatusColor: Record<string, string> = {
  issued: "text-amber-400 border-amber-400/40 bg-amber-400/10",
  paid: "text-emerald-400 border-emerald-400/40 bg-emerald-400/10",
  expired: "text-red-400 border-red-400/40 bg-red-400/10",
  cancelled: "text-muted-foreground border-white/15 bg-white/5",
};

// Строка реквизита (label слева, value справа; перенос длинных значений).
function ReqRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-0.5 sm:gap-3 py-1.5 border-b border-white/5 last:border-0">
      <span className="text-xs sm:text-sm text-muted-foreground sm:w-44 sm:flex-shrink-0">{label}</span>
      <span className="text-sm text-white font-medium break-words min-w-0">{value}</span>
    </div>
  );
}

export default function CorporatePage() {
  const [, params] = useRoute("/corporate/:id");
  const id = params?.id;

  const [data, setData] = useState<CabinetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authNeeded, setAuthNeeded] = useState(false);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      setError("Некорректный адрес кабинета.");
      return;
    }
    // Нет токена → сразу просим войти (не дёргаем сервер ради 401).
    if (!getAuthToken()) {
      setAuthNeeded(true);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setAuthNeeded(false);

    (async () => {
      try {
        // Authorization добавит патченный window.fetch (lib/auth.tsx).
        const r = await fetch(`/api/corporate/cabinet/${id}`, {
          headers: { Authorization: `Bearer ${getAuthToken()}` },
        });
        if (cancelled) return;
        if (r.status === 401) { setAuthNeeded(true); return; }
        if (r.status === 403) { setError("Нет доступа к этому кабинету. Он принадлежит другой учётной записи."); return; }
        if (r.status === 404) { setError("Кабинет не найден."); return; }
        if (!r.ok) {
          let msg = "Не удалось загрузить кабинет.";
          try { const j = await r.json(); if (j?.message) msg = j.message; } catch {}
          setError(msg);
          return;
        }
        const j = (await r.json()) as CabinetResponse;
        if (!j?.entity) { setError("Кабинет не найден."); return; }
        setData(j);
      } catch {
        if (!cancelled) setError("Ошибка сети. Проверьте соединение и попробуйте снова.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [id]);

  // === Состояния: загрузка / нужен вход / ошибка ===
  if (loading) {
    return (
      <div className="min-h-[60dvh] flex flex-col items-center justify-center gap-3 px-4 text-center">
        <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
        <p className="text-muted-foreground text-sm">Загружаем кабинет юрлица…</p>
      </div>
    );
  }

  if (authNeeded) {
    return (
      <div className="min-h-[60dvh] flex items-center justify-center px-4">
        <div className="glass-card rounded-2xl p-6 sm:p-8 max-w-md w-full text-center border border-purple-500/25">
          <AlertCircle className="w-10 h-10 text-amber-400 mx-auto mb-3" />
          <h1 className="font-display text-xl font-bold text-white mb-2">Требуется вход</h1>
          <p className="text-sm text-muted-foreground mb-5">
            Кабинет юрлица доступен только владельцу учётной записи. Войдите, чтобы продолжить.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 justify-center">
            <Link href="/login" className="btn-cosmic px-5 py-2.5 rounded-xl text-sm font-semibold text-white text-center">
              Войти
            </Link>
            <Link href="/login-phone" className="px-5 py-2.5 rounded-xl text-sm font-medium text-white bg-white/5 border border-purple-400/20 hover:bg-white/10 transition text-center">
              Вход по телефону
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-[60dvh] flex items-center justify-center px-4">
        <div className="glass-card rounded-2xl p-6 sm:p-8 max-w-md w-full text-center border border-red-500/25">
          <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <h1 className="font-display text-xl font-bold text-white mb-2">Не получилось открыть кабинет</h1>
          <p className="text-sm text-muted-foreground mb-5">{error || "Кабинет не найден."}</p>
          <Link href="/dashboard" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium text-white bg-white/5 border border-purple-400/20 hover:bg-white/10 transition">
            <ArrowLeft className="w-4 h-4" /> В личный кабинет
          </Link>
        </div>
      </div>
    );
  }

  // === Данные ===
  const e = data.entity;
  const shortName = e.name || e.full_name || `ЮЛ #${e.id}`;
  const kindLabel = e.kind === "ip" ? "ИП" : "Юридическое лицо";
  const contracts = data.contracts || [];
  const invoices = data.invoices || [];

  return (
    <div
      className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-[max(env(safe-area-inset-bottom),24px)]"
    >
      {/* Шапка */}
      <div className="mb-6">
        <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-white transition mb-3">
          <ArrowLeft className="w-3.5 h-3.5" /> Назад в кабинет
        </Link>
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-2xl flex-shrink-0 flex items-center justify-center bg-gradient-to-br from-purple-500/30 to-cyan-500/20 border border-purple-400/30">
            <Building2 className="w-6 h-6 text-purple-300" />
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-2xl sm:text-3xl font-bold gradient-text break-words">
              🏢 Кабинет юрлица
            </h1>
            <p className="text-sm text-white font-medium mt-1 break-words">{shortName}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{kindLabel}{e.status ? ` · ${e.status === "active" ? "активен" : e.status}` : ""}</p>
          </div>
        </div>
      </div>

      {/* Баланс + CTA */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="glass-card rounded-2xl p-5 border border-cyan-500/25 flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl flex-shrink-0 flex items-center justify-center bg-cyan-500/15 border border-cyan-400/30">
            <Wallet className="w-5 h-5 text-cyan-300" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Баланс кабинета</p>
            <p className="font-display text-2xl font-bold text-white tabular-nums">{kopToRub(data.balance)}</p>
          </div>
        </div>
        <Link
          href="/music"
          className="glass-card rounded-2xl p-5 border border-purple-500/30 flex items-center gap-4 hover:border-purple-400/60 transition group"
        >
          <div className="w-11 h-11 rounded-xl flex-shrink-0 flex items-center justify-center bg-gradient-to-br from-purple-500/30 to-fuchsia-500/20 border border-purple-400/30 group-hover:scale-105 transition">
            <Music className="w-5 h-5 text-purple-300" />
          </div>
          <div className="min-w-0">
            <p className="font-display text-base font-bold text-white">Создать трек</p>
            <p className="text-xs text-muted-foreground">Перейти к генерации музыки</p>
          </div>
        </Link>
      </div>

      {/* Реквизиты */}
      <section className="glass-card rounded-2xl p-5 sm:p-6 border border-purple-500/20 mb-6">
        <h2 className="font-display text-lg font-bold text-white mb-3 flex items-center gap-2">
          <FileText className="w-5 h-5 text-purple-300" /> Реквизиты
        </h2>
        <div className="divide-y divide-white/5">
          <ReqRow label="Полное наименование" value={e.full_name || e.name} />
          <ReqRow label="ИНН" value={e.inn} />
          <ReqRow label="КПП" value={e.kpp} />
          <ReqRow label="ОГРН" value={e.ogrn} />
          <ReqRow label="Юридический адрес" value={e.legal_address} />
          <ReqRow label="Фактический адрес" value={e.actual_address} />
          <ReqRow label="Руководитель" value={e.director_name} />
          <ReqRow label="Телефон" value={e.phone} />
          <ReqRow label="Email" value={e.email} />
          <ReqRow label="Банк" value={e.bank_name} />
          <ReqRow label="Расчётный счёт" value={e.settlement_account} />
          <ReqRow label="Корр. счёт" value={e.corr_account} />
          <ReqRow label="БИК" value={e.bik} />
        </div>
      </section>

      {/* Договоры */}
      <section className="glass-card rounded-2xl p-5 sm:p-6 border border-purple-500/20 mb-6">
        <h2 className="font-display text-lg font-bold text-white mb-3 flex items-center gap-2">
          <FileText className="w-5 h-5 text-cyan-300" /> Договоры
          {contracts.length > 0 && <span className="text-xs text-muted-foreground font-sans font-normal">({contracts.length})</span>}
        </h2>
        {contracts.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">Договоров пока нет. Музa поможет сформировать договор в чате.</p>
        ) : (
          <ul className="space-y-2">
            {contracts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/[0.03] border border-white/5 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm text-white font-medium break-words">{c.number || `Договор #${c.id}`}</p>
                  <p className="text-xs text-muted-foreground">{contractStatusLabel[c.status || ""] || c.status || "—"}</p>
                </div>
                <span className="text-sm font-bold text-white tabular-nums flex-shrink-0">{rub(c.amount_rub)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Счета */}
      <section className="glass-card rounded-2xl p-5 sm:p-6 border border-purple-500/20">
        <h2 className="font-display text-lg font-bold text-white mb-3 flex items-center gap-2">
          <Receipt className="w-5 h-5 text-amber-300" /> Счета
          {invoices.length > 0 && <span className="text-xs text-muted-foreground font-sans font-normal">({invoices.length})</span>}
        </h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">Счетов пока нет.</p>
        ) : (
          <ul className="space-y-2">
            {invoices.map((inv) => {
              const st = inv.status || "";
              return (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white/[0.03] border border-white/5 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white font-medium break-words">{inv.description || `Счёт #${inv.id}`}</p>
                    <span className={`inline-block mt-1 text-[11px] px-2 py-0.5 rounded-full border ${invoiceStatusColor[st] || "text-muted-foreground border-white/15 bg-white/5"}`}>
                      {invoiceStatusLabel[st] || st || "—"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-sm font-bold text-white tabular-nums">{rub(inv.amountRub)}</span>
                    {st === "issued" && (
                      <a
                        href={`/api/invoice/${inv.id}/pay`}
                        className="inline-flex items-center gap-1.5 btn-cosmic px-3.5 py-2 rounded-xl text-xs font-semibold text-white"
                      >
                        Оплатить <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
