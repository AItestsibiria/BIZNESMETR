// Eugene 2026-05-23 Босс «подарочный сертификат в ЛК».
//
// Самостоятельная страница /gift-cert с 3 вкладками:
//   - 🎁 Купить         — выбор номинала + credit_type + open-card + recipient + attach-track
//   - 📜 Мои сертификаты — list (покупатель + получатель)
//   - ✨ Активировать    — ввод кода активации
//
// Использует Brand-style consistency rule (palette purple/fuchsia/cyan +
// glass-card + font-display titles).
//
// Никакие existing файлы (dashboard.tsx, landing.tsx) не правит — только новый
// route в App.tsx + ссылка из дашборда (add'нем позже точечно).

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Gift, Check, AlertCircle, Copy, ExternalLink, Mail, Phone, Send, Loader2 } from "lucide-react";

type PostcardTemplate = "classic" | "birthday" | "love" | "wedding";

const TEMPLATE_OPTIONS: Array<{ value: PostcardTemplate; label: string; emoji: string; preview: string }> = [
  { value: "classic", label: "Классика", emoji: "🎁", preview: "Универсальный — purple/cyan gradient" },
  { value: "birthday", label: "День рождения", emoji: "🎂", preview: "Тёплый amber + magenta" },
  { value: "love", label: "С любовью", emoji: "💝", preview: "Rose / fuchsia / purple" },
  { value: "wedding", label: "Свадьба", emoji: "💍", preview: "Cyan / blue / violet" },
];

const STANDARD_AMOUNTS = [300, 500, 1000, 2000];

const CREDIT_TYPE_OPTIONS = [
  { value: "balance", label: "💰 Деньги на баланс", hint: "Получатель тратит на что угодно" },
  { value: "tracks", label: "🎵 Треки", hint: "Кол-во готовых треков (стандарт 399 ₽/трек)" },
  { value: "covers", label: "🖼 Обложки", hint: "Готовые обложки (99 ₽ каждая)" },
  { value: "lyrics", label: "📝 Тексты", hint: "Тексты песен (99 ₽ каждый)" },
];

interface CertItem {
  id: number;
  code: string;
  amountRubles: number;
  amountKopecks: number;
  creditType: string;
  creditValue: any;
  status: string;
  postcardTemplate: string;
  postcardMessage: string | null;
  postcardTitle: string | null;
  fromName: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  redeemedAt: number | null;
  expiresAt: number | null;
  paidAt: number | null;
  invoiceId: number | null;
  createdAt: number;
  relation: "purchased" | "received";
  sentAt: number | null;
  sentChannel: string | null;
  attachedTrackId: number | null;
}

export default function GiftCertificatesPage() {
  const { user, isLoading } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<"buy" | "my" | "redeem">("buy");

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0a17] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen hero-gradient flex items-center justify-center p-6">
        <Card className="glass-card max-w-md w-full">
          <CardHeader>
            <CardTitle className="font-display gradient-text text-2xl">Войдите в аккаунт</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-white/70 mb-4">Подарочные сертификаты доступны авторизованным пользователям.</p>
            <Link href="/login-phone">
              <Button className="btn-cosmic w-full">Войти</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a17] via-[#1a0f2e] to-[#0a0a17] text-white">
      <header className="border-b border-purple-500/20 backdrop-blur-xl bg-black/30 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Gift className="h-8 w-8 text-purple-400" />
            <h1 className="font-display font-bold text-2xl gradient-text">Подарочные сертификаты</h1>
          </div>
          <Link href="/dashboard">
            <Button variant="outline" className="border-purple-400/30 hover:border-purple-400/60">
              ← В кабинет
            </Button>
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
          <TabsList className="grid grid-cols-3 mb-8 bg-white/5 border border-purple-400/20">
            <TabsTrigger value="buy" data-testid="tab-buy">🎁 Купить</TabsTrigger>
            <TabsTrigger value="my" data-testid="tab-my">📜 Мои сертификаты</TabsTrigger>
            <TabsTrigger value="redeem" data-testid="tab-redeem">✨ Активировать</TabsTrigger>
          </TabsList>

          <TabsContent value="buy"><BuyTab onCreated={() => setTab("my")} toast={toast} /></TabsContent>
          <TabsContent value="my"><MyCertsTab toast={toast} /></TabsContent>
          <TabsContent value="redeem"><RedeemTab toast={toast} onRedeemed={() => setTab("my")} /></TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// BUY TAB
// ─────────────────────────────────────────────────────────────────────
function BuyTab({ onCreated, toast }: { onCreated: () => void; toast: ReturnType<typeof useToast>["toast"] }) {
  const [amount, setAmount] = useState(500);
  const [customAmount, setCustomAmount] = useState("");
  const [creditType, setCreditType] = useState<string>("balance");
  const [template, setTemplate] = useState<PostcardTemplate>("classic");
  const [postcardMessage, setPostcardMessage] = useState("");
  const [postcardTitle, setPostcardTitle] = useState("");
  const [fromName, setFromName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [attachedTrackId, setAttachedTrackId] = useState("");
  const [tracksCount, setTracksCount] = useState(1);
  const [coversCount, setCoversCount] = useState(1);
  const [lyricsCount, setLyricsCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);

  const finalAmount = customAmount ? Math.max(100, Math.min(50000, parseInt(customAmount) || 0)) : amount;

  const submit = async () => {
    if (finalAmount < 100 || finalAmount > 50000) {
      toast({ title: "Сумма от 100 до 50 000 ₽", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const creditValue: Record<string, number> = {};
      if (creditType === "balance") creditValue.balance_kopecks = finalAmount * 100;
      if (creditType === "tracks") creditValue.tracks_count = tracksCount;
      if (creditType === "covers") creditValue.covers_count = coversCount;
      if (creditType === "lyrics") creditValue.lyrics_count = lyricsCount;

      const r = await fetch("/api/gift-cert/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountKopecks: finalAmount * 100,
          creditType,
          creditValue,
          postcardTemplate: template,
          postcardMessage: postcardMessage.trim(),
          postcardTitle: postcardTitle.trim(),
          fromName: fromName.trim(),
          recipientEmail: recipientEmail.trim() || null,
          recipientPhone: recipientPhone.trim() || null,
          attachedTrackId: attachedTrackId ? Number(attachedTrackId) : null,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        toast({ title: "Не удалось создать", description: data.error || "Ошибка", variant: "destructive" });
        return;
      }
      toast({
        title: "🎁 Сертификат создан",
        description: `Код: ${data.code}. Сейчас перейдём к оплате.`,
      });

      // Init Robokassa redirect через existing endpoint
      const payRes = await fetch("/api/payment/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId: data.invoiceId }),
      });
      const payData = await payRes.json();
      if (payRes.ok && payData.paymentUrl) {
        window.location.href = payData.paymentUrl;
      } else {
        toast({
          title: "Сертификат сохранён",
          description: `Перейдите во вкладку «Мои сертификаты» чтобы оплатить позже. Код: ${data.code}`,
        });
        onCreated();
      }
    } catch (e: any) {
      toast({ title: "Ошибка", description: String(e?.message || e), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="glass-card">
      <CardHeader>
        <CardTitle className="font-display gradient-text">Создать подарочный сертификат</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 1. Номинал */}
        <div>
          <Label className="text-purple-300 font-semibold mb-3 block">1. Сумма</Label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            {STANDARD_AMOUNTS.map((a) => (
              <button
                key={a}
                onClick={() => { setAmount(a); setCustomAmount(""); }}
                className={`px-4 py-3 rounded-lg border transition-all ${
                  !customAmount && amount === a
                    ? "border-purple-400 bg-purple-500/20 text-white"
                    : "border-white/10 bg-white/5 text-white/70 hover:border-purple-400/50"
                }`}
                data-testid={`btn-amount-${a}`}
              >
                {a} ₽
              </button>
            ))}
          </div>
          <Input
            type="number"
            placeholder="Или своя сумма (100-50000 ₽)"
            value={customAmount}
            onChange={(e) => setCustomAmount(e.target.value)}
            className="bg-white/5 border-white/10"
            data-testid="input-custom-amount"
          />
          <p className="text-xs text-white/50 mt-1">Итог: {finalAmount} ₽</p>
        </div>

        {/* 2. Тип кредита */}
        <div>
          <Label className="text-purple-300 font-semibold mb-3 block">2. Что получит автор</Label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {CREDIT_TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setCreditType(opt.value)}
                className={`text-left p-3 rounded-lg border transition-all ${
                  creditType === opt.value
                    ? "border-fuchsia-400 bg-fuchsia-500/15"
                    : "border-white/10 bg-white/5 hover:border-fuchsia-400/40"
                }`}
                data-testid={`btn-credit-${opt.value}`}
              >
                <div className="font-semibold text-white">{opt.label}</div>
                <div className="text-xs text-white/60">{opt.hint}</div>
              </button>
            ))}
          </div>
          {creditType === "tracks" && (
            <div className="mt-3">
              <Label>Кол-во треков</Label>
              <Input type="number" min={1} max={20} value={tracksCount}
                onChange={(e) => setTracksCount(Math.max(1, parseInt(e.target.value) || 1))} className="bg-white/5 border-white/10" />
            </div>
          )}
          {creditType === "covers" && (
            <div className="mt-3">
              <Label>Кол-во обложек</Label>
              <Input type="number" min={1} max={50} value={coversCount}
                onChange={(e) => setCoversCount(Math.max(1, parseInt(e.target.value) || 1))} className="bg-white/5 border-white/10" />
            </div>
          )}
          {creditType === "lyrics" && (
            <div className="mt-3">
              <Label>Кол-во текстов</Label>
              <Input type="number" min={1} max={50} value={lyricsCount}
                onChange={(e) => setLyricsCount(Math.max(1, parseInt(e.target.value) || 1))} className="bg-white/5 border-white/10" />
            </div>
          )}
        </div>

        {/* 3. Открытка */}
        <div>
          <Label className="text-purple-300 font-semibold mb-3 block">3. Шаблон открытки</Label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {TEMPLATE_OPTIONS.map((t) => (
              <button
                key={t.value}
                onClick={() => setTemplate(t.value)}
                className={`p-3 rounded-lg border text-center transition-all ${
                  template === t.value
                    ? "border-cyan-400 bg-cyan-500/15"
                    : "border-white/10 bg-white/5 hover:border-cyan-400/40"
                }`}
                data-testid={`btn-template-${t.value}`}
              >
                <div className="text-3xl mb-1">{t.emoji}</div>
                <div className="text-sm font-semibold text-white">{t.label}</div>
                <div className="text-xs text-white/50 mt-1">{t.preview}</div>
              </button>
            ))}
          </div>
        </div>

        {/* 4. Сообщение */}
        <div className="space-y-3">
          <div>
            <Label className="text-purple-300 font-semibold">Заголовок открытки (опц.)</Label>
            <Input
              maxLength={100}
              placeholder="например «С Днём рождения, мама!»"
              value={postcardTitle}
              onChange={(e) => setPostcardTitle(e.target.value)}
              className="bg-white/5 border-white/10"
              data-testid="input-postcard-title"
            />
          </div>
          <div>
            <Label className="text-purple-300 font-semibold">Сообщение от вас (опц., до 500 символов)</Label>
            <Textarea
              maxLength={500}
              placeholder="Поздравляю с праздником! Хочу подарить тебе песню — выбери стиль, голос, и MuzaAi сгенерирует трек."
              value={postcardMessage}
              onChange={(e) => setPostcardMessage(e.target.value)}
              className="bg-white/5 border-white/10 min-h-[100px]"
              data-testid="input-postcard-message"
            />
            <p className="text-xs text-white/50 mt-1">{postcardMessage.length}/500</p>
          </div>
          <div>
            <Label className="text-purple-300 font-semibold">Ваше имя (для подписи)</Label>
            <Input maxLength={80} placeholder="например «Мама»" value={fromName}
              onChange={(e) => setFromName(e.target.value)} className="bg-white/5 border-white/10"
              data-testid="input-from-name"/>
          </div>
        </div>

        {/* 5. Кому отправить */}
        <div>
          <Label className="text-purple-300 font-semibold mb-3 block">5. Кому отправить (опц.)</Label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input placeholder="Email получателя" type="email" value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)} className="bg-white/5 border-white/10"
              data-testid="input-recipient-email"/>
            <Input placeholder="+7..." value={recipientPhone}
              onChange={(e) => setRecipientPhone(e.target.value)} className="bg-white/5 border-white/10"
              data-testid="input-recipient-phone"/>
          </div>
          <p className="text-xs text-white/50 mt-2">Если не указано — после оплаты сами отправите код через «Мои сертификаты».</p>
        </div>

        {/* 6. Прикрепить трек */}
        <div>
          <Label className="text-purple-300 font-semibold mb-2 block">6. Прикрепить трек (опц.)</Label>
          <Input
            placeholder="ID вашего трека (опц.) — будет показан в открытке"
            value={attachedTrackId}
            onChange={(e) => setAttachedTrackId(e.target.value.replace(/[^0-9]/g, ""))}
            className="bg-white/5 border-white/10"
            data-testid="input-attached-track"
          />
          <p className="text-xs text-white/50 mt-1">Получатель увидит ссылку на ваш трек в открытке.</p>
        </div>

        {/* Submit */}
        <Button
          onClick={submit}
          disabled={submitting}
          className="btn-cosmic w-full text-lg py-6"
          data-testid="btn-create-cert"
        >
          {submitting ? <><Loader2 className="h-5 w-5 animate-spin mr-2" /> Создание…</> : `🎁 Оформить и оплатить — ${finalAmount} ₽`}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// MY CERTIFICATES TAB
// ─────────────────────────────────────────────────────────────────────
function MyCertsTab({ toast }: { toast: ReturnType<typeof useToast>["toast"] }) {
  const [items, setItems] = useState<CertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "purchased" | "received">("all");

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/gift-cert/my?role=${filter}`);
      const data = await r.json();
      if (r.ok && data.ok) setItems(data.items || []);
    } catch {} finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filter]);

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast({ title: "📋 Код скопирован", description: code });
    } catch {
      toast({ title: "Не удалось скопировать", variant: "destructive" });
    }
  };

  const sendCert = async (cert: CertItem) => {
    if (!cert.recipientEmail && !cert.recipientPhone) {
      toast({ title: "Укажите email или телефон получателя (Edit → Send)", variant: "destructive" });
      return;
    }
    try {
      const r = await fetch(`/api/gift-cert/${cert.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "auto" }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        toast({ title: "✅ Отправлено", description: data.message });
        load();
      } else {
        toast({ title: "Не отправлено", description: data.error, variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Ошибка", description: String(e?.message || e), variant: "destructive" });
    }
  };

  return (
    <Card className="glass-card">
      <CardHeader>
        <CardTitle className="font-display gradient-text">Мои сертификаты</CardTitle>
        <div className="flex gap-2 mt-3">
          {(["all", "purchased", "received"] as const).map((f) => (
            <Button
              key={f}
              variant={filter === f ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(f)}
              className={filter === f ? "bg-purple-500" : "border-purple-400/30"}
              data-testid={`btn-filter-${f}`}
            >
              {f === "all" ? "Все" : f === "purchased" ? "Купленные" : "Полученные"}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-purple-400 inline-block" /></div>
        ) : items.length === 0 ? (
          <p className="text-white/60 text-center py-8">Сертификатов пока нет.</p>
        ) : (
          <div className="space-y-3">
            {items.map((c) => <CertRow key={c.id} cert={c} onCopyCode={copyCode} onSend={sendCert} />)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CertRow({ cert, onCopyCode, onSend }: { cert: CertItem; onCopyCode: (c: string) => void; onSend: (c: CertItem) => void }) {
  const statusBadge = useMemo(() => {
    const map: Record<string, { color: string; label: string }> = {
      pending: { color: "bg-yellow-500/20 text-yellow-300 border-yellow-500/40", label: "Ожидает оплаты" },
      active: { color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40", label: "Активен" },
      redeemed: { color: "bg-purple-500/20 text-purple-300 border-purple-500/40", label: "Активирован" },
      expired: { color: "bg-gray-500/20 text-gray-300 border-gray-500/40", label: "Истёк" },
      cancelled: { color: "bg-red-500/20 text-red-300 border-red-500/40", label: "Отозван" },
    };
    return map[cert.status] || { color: "bg-white/10 text-white border-white/20", label: cert.status };
  }, [cert.status]);

  const expiresText = cert.expiresAt
    ? new Date(cert.expiresAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" })
    : "—";

  const valueLabel = useMemo(() => {
    const parts: string[] = [];
    if (cert.creditValue?.balance_kopecks > 0) parts.push(`${Math.round(cert.creditValue.balance_kopecks / 100)} ₽`);
    if (cert.creditValue?.tracks_count > 0) parts.push(`${cert.creditValue.tracks_count} трек(а/ов)`);
    if (cert.creditValue?.covers_count > 0) parts.push(`${cert.creditValue.covers_count} обложек`);
    if (cert.creditValue?.lyrics_count > 0) parts.push(`${cert.creditValue.lyrics_count} текстов`);
    if (parts.length === 0) parts.push(`${cert.amountRubles} ₽`);
    return parts.join(" + ");
  }, [cert]);

  return (
    <div className="border border-purple-400/20 rounded-xl p-4 bg-white/5 hover:bg-white/8 transition-colors"
         data-testid={`cert-row-${cert.id}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-lg font-bold text-white tracking-wider">{cert.code}</span>
            <button onClick={() => onCopyCode(cert.code)} className="text-purple-400 hover:text-purple-300"
                    aria-label="copy" data-testid={`btn-copy-${cert.id}`}>
              <Copy className="h-4 w-4" />
            </button>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${statusBadge.color}`}>
              {statusBadge.label}
            </span>
            <span className="text-xs text-white/60">
              {cert.relation === "purchased" ? "👤 Куплен мной" : "🎁 Получен"}
            </span>
          </div>
          <div className="mt-2 text-sm text-white/80">
            <span className="font-semibold gradient-text">{valueLabel}</span>
          </div>
          {cert.postcardTitle && <p className="text-sm text-white/70 mt-1 italic">«{cert.postcardTitle}»</p>}
          <div className="text-xs text-white/50 mt-2 flex flex-wrap gap-3">
            <span>До {expiresText}</span>
            {cert.recipientEmail && <span><Mail className="h-3 w-3 inline mr-1" />{cert.recipientEmail}</span>}
            {cert.recipientPhone && <span><Phone className="h-3 w-3 inline mr-1" />{cert.recipientPhone}</span>}
            {cert.sentAt && <span className="text-emerald-300">✓ Отправлен ({cert.sentChannel})</span>}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <a
            href={`/api/gift-cert/${cert.id}/postcard?code=${cert.code}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-3 py-1.5 rounded-lg bg-purple-500/20 border border-purple-400/30 text-purple-200 hover:bg-purple-500/30 inline-flex items-center gap-1"
            data-testid={`btn-view-postcard-${cert.id}`}
          >
            <ExternalLink className="h-3 w-3" /> Открытка
          </a>
          {cert.relation === "purchased" && cert.status === "active" && !cert.sentAt && (
            <Button size="sm" onClick={() => onSend(cert)} className="text-xs bg-emerald-500/30 hover:bg-emerald-500/50"
                    data-testid={`btn-send-${cert.id}`}>
              <Send className="h-3 w-3 mr-1" /> Отправить
            </Button>
          )}
          {cert.status === "pending" && cert.invoiceId && (
            <Button
              size="sm"
              onClick={async () => {
                const r = await fetch("/api/payment/create", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ invoiceId: cert.invoiceId }),
                });
                const d = await r.json();
                if (d.paymentUrl) window.location.href = d.paymentUrl;
              }}
              className="text-xs bg-amber-500/30 hover:bg-amber-500/50"
              data-testid={`btn-pay-${cert.id}`}
            >
              Оплатить — {cert.amountRubles} ₽
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// REDEEM TAB
// ─────────────────────────────────────────────────────────────────────
function RedeemTab({ toast, onRedeemed }: { toast: ReturnType<typeof useToast>["toast"]; onRedeemed: () => void }) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const submit = async () => {
    if (!code.trim()) {
      toast({ title: "Введите код", variant: "destructive" });
      return;
    }
    setSubmitting(true); setResult(null);
    try {
      const r = await fetch("/api/gift-cert/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        setResult({ ok: true, message: data.creditedSummary || "Активировано." });
        toast({ title: "🎁 Сертификат активирован!", description: data.creditedSummary });
        setTimeout(onRedeemed, 1500);
      } else {
        setResult({ ok: false, message: data.error || "Не удалось активировать." });
        toast({ title: "Не активировано", description: data.error, variant: "destructive" });
      }
    } catch (e: any) {
      setResult({ ok: false, message: String(e?.message || e) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="glass-card max-w-2xl mx-auto">
      <CardHeader>
        <CardTitle className="font-display gradient-text">Активировать сертификат</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label className="text-purple-300 font-semibold">Код активации (XXXX-XXXX-XXXX)</Label>
          <Input
            placeholder="ABCD-EFGH-JKMN"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className="bg-white/5 border-white/10 font-mono text-lg tracking-wider text-center mt-2"
            maxLength={14}
            data-testid="input-redeem-code"
          />
          <p className="text-xs text-white/50 mt-2">
            Введите код из открытки или с QR — деньги/треки зачислятся на ваш аккаунт мгновенно.
          </p>
        </div>
        <Button
          onClick={submit}
          disabled={submitting}
          className="btn-cosmic w-full"
          data-testid="btn-redeem"
        >
          {submitting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Активация…</> : "✨ Активировать"}
        </Button>
        {result && (
          <div className={`p-4 rounded-lg border flex items-start gap-3 ${
            result.ok
              ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-200"
              : "bg-red-500/15 border-red-400/40 text-red-200"
          }`}>
            {result.ok ? <Check className="h-5 w-5 flex-shrink-0 mt-0.5" /> : <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />}
            <p>{result.message}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
