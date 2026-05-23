// Eugene 2026-05-23 Босс «подарочные сертификаты + архив действий».
//
// Admin вкладка для admin-v304. Управление сертификатами: list / details /
// issue manual / revoke / edit / audit-log глобальный.
//
// Используй так в admin-v304.tsx:
//   import { GiftCertificatesTab } from "@/pages/admin/gift-certificates-tab";
//   <TabsTrigger value="gift-certs">🎁 Сертификаты</TabsTrigger>
//   <TabsContent value="gift-certs"><GiftCertificatesTab toast={toast} /></TabsContent>

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Copy, ExternalLink, Plus, RefreshCcw, Archive } from "lucide-react";

interface CertRow {
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
  recipientUserId: number | null;
  purchasedByUserId: number | null;
  redeemedByUserId: number | null;
  redeemedAt: number | null;
  expiresAt: number | null;
  paidAt: number | null;
  invoiceId: number | null;
  createdAt: number;
  createdByAdmin: boolean;
  sentAt: number | null;
  sentChannel: string | null;
  attachedTrackId: number | null;
}

interface AuditEntry {
  id: number;
  certificateId?: number;
  action: string;
  actorUserId: number | null;
  actorRole: string | null;
  metadata: any;
  createdAt: number;
}

export function GiftCertificatesTab({ toast }: { toast?: (o: { title: string; description?: string; variant?: any }) => void }) {
  const [innerTab, setInnerTab] = useState<"list" | "issue" | "audit">("list");
  return (
    <Card className="glass-card">
      <CardHeader>
        <CardTitle className="font-display gradient-text">🎁 Подарочные сертификаты</CardTitle>
        <p className="text-sm text-white/60 mt-1">
          Управление сертификатами + архив действий (создание / оплата / отправка / активация / отзыв / edit).
        </p>
      </CardHeader>
      <CardContent>
        <Tabs value={innerTab} onValueChange={(v) => setInnerTab(v as any)}>
          <TabsList className="bg-white/5 border border-purple-400/20 mb-4">
            <TabsTrigger value="list">📜 Список</TabsTrigger>
            <TabsTrigger value="issue">➕ Выдать</TabsTrigger>
            <TabsTrigger value="audit">📋 Аудит</TabsTrigger>
          </TabsList>
          <TabsContent value="list"><ListSection toast={toast} /></TabsContent>
          <TabsContent value="issue"><IssueSection toast={toast} /></TabsContent>
          <TabsContent value="audit"><AuditSection toast={toast} /></TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────────────
function ListSection({ toast }: { toast?: any }) {
  const [items, setItems] = useState<CertRow[]>([]);
  const [summary, setSummary] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [detail, setDetail] = useState<CertRow | null>(null);
  const [detailAudit, setDetailAudit] = useState<AuditEntry[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (status) p.set("status", status);
      if (q) p.set("q", q);
      p.set("limit", "200");
      const r = await fetch(`/api/admin/v304/gift-cert/list?${p}`);
      const data = await r.json();
      if (r.ok && data.ok) {
        setItems(data.items || []);
        setSummary(data.summary || []);
      }
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [status, q]);

  const openDetail = async (cert: CertRow) => {
    setDetail(cert);
    try {
      const r = await fetch(`/api/admin/v304/gift-cert/${cert.id}`);
      const data = await r.json();
      if (r.ok && data.ok) setDetailAudit(data.audit || []);
    } catch {}
  };

  const revoke = async (cert: CertRow) => {
    if (!confirm(`Отозвать сертификат ${cert.code}? Это нельзя отменить.`)) return;
    try {
      const r = await fetch(`/api/admin/v304/gift-cert/${cert.id}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "admin_manual" }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        toast?.({ title: "✅ Отозван", description: cert.code });
        load();
        if (detail?.id === cert.id) setDetail({ ...cert, status: "cancelled" });
      } else {
        toast?.({ title: "Не отозван", description: data.error, variant: "destructive" });
      }
    } catch {}
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        <Input
          placeholder="Поиск (код / email / имя дарителя)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="bg-white/5 border-white/10 max-w-sm"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm"
        >
          <option value="">Все статусы</option>
          <option value="pending">⏳ Ожидает оплаты</option>
          <option value="active">✅ Активный</option>
          <option value="redeemed">🎁 Активирован</option>
          <option value="expired">⏰ Истёк</option>
          <option value="cancelled">🚫 Отозван</option>
        </select>
        <Button onClick={load} variant="outline" size="sm" className="border-purple-400/30">
          <RefreshCcw className="h-4 w-4 mr-1" /> Обновить
        </Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4 text-xs">
        {summary.map((s: any) => (
          <div key={s.status} className="p-3 rounded-lg bg-white/5 border border-white/10">
            <div className="text-white/60 capitalize">{s.status}</div>
            <div className="text-lg font-bold text-white">{s.count}</div>
            {s.total && <div className="text-xs text-purple-300">{Math.round(s.total / 100)} ₽</div>}
          </div>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-purple-400 inline-block" /></div>
      ) : items.length === 0 ? (
        <p className="text-white/60 text-center py-8">Сертификатов нет.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-white/60 border-b border-white/10">
              <tr>
                <th className="text-left py-2 px-2">Код</th>
                <th className="text-left py-2 px-2">Сумма</th>
                <th className="text-left py-2 px-2">Тип</th>
                <th className="text-left py-2 px-2">Статус</th>
                <th className="text-left py-2 px-2">Покупатель</th>
                <th className="text-left py-2 px-2">Получатель</th>
                <th className="text-left py-2 px-2">Создан</th>
                <th className="py-2 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className="border-b border-white/5 hover:bg-white/3">
                  <td className="py-2 px-2 font-mono text-xs">{c.code}</td>
                  <td className="py-2 px-2">{c.amountRubles} ₽</td>
                  <td className="py-2 px-2">{c.creditType}</td>
                  <td className="py-2 px-2">
                    <StatusPill status={c.status} />
                  </td>
                  <td className="py-2 px-2 text-xs text-white/70">
                    {c.createdByAdmin ? "🛡 Admin" : `#${c.purchasedByUserId || "—"}`}
                  </td>
                  <td className="py-2 px-2 text-xs text-white/70">
                    {c.recipientEmail || c.recipientPhone || (c.recipientUserId ? `#${c.recipientUserId}` : "—")}
                  </td>
                  <td className="py-2 px-2 text-xs text-white/50">{new Date(c.createdAt).toLocaleDateString("ru-RU")}</td>
                  <td className="py-2 px-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => openDetail(c)}>
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
             onClick={() => setDetail(null)}>
          <div className="bg-gradient-to-br from-[#1a0f2e] to-[#0a0a17] border border-purple-400/40 rounded-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto"
               onClick={(e) => e.stopPropagation()}>
            <div className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-display gradient-text text-2xl">{detail.code}</h3>
                  <p className="text-sm text-white/60">ID: {detail.id} · {detail.amountRubles} ₽</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setDetail(null)}>✕</Button>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm mb-4">
                <Field label="Статус"><StatusPill status={detail.status} /></Field>
                <Field label="Тип кредита">{detail.creditType}</Field>
                <Field label="Сумма копейки">{detail.amountKopecks}</Field>
                <Field label="Создан админом">{detail.createdByAdmin ? "Да" : "Нет"}</Field>
                <Field label="Покупатель">{detail.purchasedByUserId ?? "—"}</Field>
                <Field label="Получатель user_id">{detail.recipientUserId ?? "—"}</Field>
                <Field label="Получатель email">{detail.recipientEmail ?? "—"}</Field>
                <Field label="Получатель тел.">{detail.recipientPhone ?? "—"}</Field>
                <Field label="Activated by">{detail.redeemedByUserId ?? "—"}</Field>
                <Field label="Activated at">{detail.redeemedAt ? new Date(detail.redeemedAt).toLocaleString("ru-RU") : "—"}</Field>
                <Field label="Expires">{detail.expiresAt ? new Date(detail.expiresAt).toLocaleString("ru-RU") : "—"}</Field>
                <Field label="Шаблон">{detail.postcardTemplate}</Field>
              </dl>
              {detail.postcardMessage && (
                <div className="p-3 bg-white/5 rounded-lg mb-4">
                  <div className="text-xs text-purple-300 mb-1">Сообщение</div>
                  <div className="text-sm text-white/80">{detail.postcardMessage}</div>
                </div>
              )}
              <div className="flex gap-2 mb-4">
                <a href={`/api/gift-cert/${detail.id}/postcard?code=${detail.code}`} target="_blank"
                   rel="noopener noreferrer"
                   className="text-xs px-3 py-1.5 rounded-lg bg-purple-500/20 border border-purple-400/30 text-purple-200 hover:bg-purple-500/30 inline-flex items-center gap-1">
                  <ExternalLink className="h-3 w-3" /> Открытка SVG
                </a>
                {detail.status !== "redeemed" && detail.status !== "cancelled" && (
                  <Button size="sm" variant="destructive" onClick={() => revoke(detail)}>🚫 Отозвать</Button>
                )}
              </div>
              <div>
                <h4 className="font-semibold text-purple-300 mb-2">Архив действий ({detailAudit.length})</h4>
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {detailAudit.map((a) => (
                    <div key={a.id} className="text-xs p-2 rounded bg-white/3 border border-white/10">
                      <span className="text-purple-300 font-semibold">{a.action}</span>
                      <span className="text-white/50 ml-2">{new Date(a.createdAt).toLocaleString("ru-RU")}</span>
                      <span className="text-white/40 ml-2">[{a.actorRole}#{a.actorUserId}]</span>
                      {a.metadata && (
                        <details className="mt-1">
                          <summary className="text-white/40 cursor-pointer">metadata</summary>
                          <pre className="text-[10px] text-white/60 overflow-x-auto">{JSON.stringify(a.metadata, null, 2)}</pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-white/50">{label}</dt>
      <dd className="text-sm text-white/90">{children}</dd>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { color: string; label: string }> = {
    pending: { color: "bg-yellow-500/20 text-yellow-300 border-yellow-500/40", label: "Ожидает" },
    active: { color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40", label: "Активен" },
    redeemed: { color: "bg-purple-500/20 text-purple-300 border-purple-500/40", label: "Активирован" },
    expired: { color: "bg-gray-500/20 text-gray-300 border-gray-500/40", label: "Истёк" },
    cancelled: { color: "bg-red-500/20 text-red-300 border-red-500/40", label: "Отозван" },
  };
  const s = map[status] || { color: "bg-white/10 text-white border-white/20", label: status };
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${s.color}`}>{s.label}</span>;
}

// ─────────────────────────────────────────────────────────────────────
// ISSUE (admin gift — no payment)
// ─────────────────────────────────────────────────────────────────────
function IssueSection({ toast }: { toast?: any }) {
  const [amount, setAmount] = useState(500);
  const [creditType, setCreditType] = useState("balance");
  const [recipientUserId, setRecipientUserId] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [postcardTemplate, setPostcardTemplate] = useState("classic");
  const [postcardMessage, setPostcardMessage] = useState("");
  const [postcardTitle, setPostcardTitle] = useState("");
  const [fromName, setFromName] = useState("Команда MuzaAi");
  const [ttlDays, setTtlDays] = useState(365);
  const [submitting, setSubmitting] = useState(false);
  const [lastCert, setLastCert] = useState<{ code: string; id: number } | null>(null);

  const submit = async () => {
    setSubmitting(true);
    try {
      const r = await fetch("/api/admin/v304/gift-cert/issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountKopecks: amount * 100,
          creditType,
          creditValue: creditType === "balance" ? { balance_kopecks: amount * 100 } : {},
          recipientUserId: recipientUserId ? Number(recipientUserId) : null,
          recipientEmail: recipientEmail.trim() || null,
          postcardTemplate,
          postcardMessage,
          postcardTitle,
          fromName,
          expiresInDays: ttlDays,
        }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        toast?.({ title: "🎁 Сертификат выдан", description: `Код: ${data.code}` });
        setLastCert({ code: data.code, id: data.certificateId });
      } else {
        toast?.({ title: "Не выдан", description: data.error, variant: "destructive" });
      }
    } catch (e: any) {
      toast?.({ title: "Ошибка", description: String(e?.message || e), variant: "destructive" });
    } finally { setSubmitting(false); }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-sm text-white/70">
        Выдача сертификата вручную (без оплаты). Status сразу → active. Используется для подарков от команды,
        компенсаций и пр.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <Label>Сумма (₽)</Label>
          <Input type="number" value={amount} onChange={(e) => setAmount(Math.max(0, parseInt(e.target.value) || 0))}
            className="bg-white/5 border-white/10" />
        </div>
        <div>
          <Label>Тип кредита</Label>
          <select value={creditType} onChange={(e) => setCreditType(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm w-full">
            <option value="balance">💰 Баланс</option>
            <option value="tracks">🎵 Треки</option>
            <option value="covers">🖼 Обложки</option>
            <option value="lyrics">📝 Тексты</option>
          </select>
        </div>
        <div>
          <Label>Получатель user_id (опц.)</Label>
          <Input value={recipientUserId} onChange={(e) => setRecipientUserId(e.target.value.replace(/\D/g, ""))}
            className="bg-white/5 border-white/10" placeholder="например 42" />
        </div>
        <div>
          <Label>Email получателя (опц.)</Label>
          <Input value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)}
            className="bg-white/5 border-white/10" type="email" />
        </div>
        <div>
          <Label>Шаблон открытки</Label>
          <select value={postcardTemplate} onChange={(e) => setPostcardTemplate(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm w-full">
            <option value="classic">🎁 Классика</option>
            <option value="birthday">🎂 ДР</option>
            <option value="love">💝 Любовь</option>
            <option value="wedding">💍 Свадьба</option>
          </select>
        </div>
        <div>
          <Label>Срок действия (дней)</Label>
          <Input type="number" value={ttlDays} onChange={(e) => setTtlDays(Math.max(1, parseInt(e.target.value) || 365))}
            className="bg-white/5 border-white/10" />
        </div>
      </div>
      <div>
        <Label>Заголовок открытки</Label>
        <Input value={postcardTitle} onChange={(e) => setPostcardTitle(e.target.value)}
          className="bg-white/5 border-white/10" placeholder="например «Спасибо, что с нами!»" />
      </div>
      <div>
        <Label>Сообщение в открытку</Label>
        <Textarea value={postcardMessage} onChange={(e) => setPostcardMessage(e.target.value)}
          className="bg-white/5 border-white/10 min-h-[80px]" maxLength={500} />
      </div>
      <div>
        <Label>От имени</Label>
        <Input value={fromName} onChange={(e) => setFromName(e.target.value)} className="bg-white/5 border-white/10" />
      </div>
      <Button onClick={submit} disabled={submitting} className="btn-cosmic">
        {submitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Выдача…</> : <><Plus className="h-4 w-4 mr-2" /> Выдать</>}
      </Button>
      {lastCert && (
        <div className="p-4 bg-emerald-500/15 border border-emerald-400/40 rounded-lg">
          <p className="text-emerald-200 font-semibold mb-2">✅ Сертификат создан</p>
          <p className="font-mono text-lg text-white">{lastCert.code}</p>
          <div className="flex gap-2 mt-2">
            <button onClick={() => navigator.clipboard?.writeText(lastCert.code)}
              className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20">
              <Copy className="h-3 w-3 inline" /> Копировать код
            </button>
            <a href={`/api/gift-cert/${lastCert.id}/postcard?code=${lastCert.code}`} target="_blank"
              rel="noopener noreferrer" className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20">
              <ExternalLink className="h-3 w-3 inline" /> Открытка
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// GLOBAL AUDIT (across all certificates)
// ─────────────────────────────────────────────────────────────────────
function AuditSection({ toast }: { toast?: any }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (action) p.set("action", action);
      p.set("limit", "200");
      const r = await fetch(`/api/admin/v304/gift-cert/audit-log?${p}`);
      const data = await r.json();
      if (r.ok && data.ok) setEntries(data.entries || []);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [action]);

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <select value={action} onChange={(e) => setAction(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm">
          <option value="">Все действия</option>
          <option value="created">created</option>
          <option value="paid">paid</option>
          <option value="redeemed">redeemed</option>
          <option value="sent">sent</option>
          <option value="admin_edit">admin_edit</option>
          <option value="admin_revoke">admin_revoke</option>
          <option value="expired">expired</option>
        </select>
        <Button onClick={load} variant="outline" size="sm" className="border-purple-400/30">
          <RefreshCcw className="h-4 w-4 mr-1" /> Обновить
        </Button>
      </div>
      {loading ? (
        <div className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-purple-400 inline-block" /></div>
      ) : entries.length === 0 ? (
        <p className="text-white/60 text-center py-8"><Archive className="h-8 w-8 inline mb-2" /><br />Записей нет.</p>
      ) : (
        <div className="space-y-1 max-h-[60vh] overflow-y-auto">
          {entries.map((a) => (
            <div key={a.id} className="text-xs p-2 rounded bg-white/3 border border-white/10 flex items-center gap-3 flex-wrap">
              <span className="text-purple-300 font-semibold uppercase">{a.action}</span>
              <span className="text-cyan-300 font-mono">cert#{a.certificateId}</span>
              <span className="text-white/50">{new Date(a.createdAt).toLocaleString("ru-RU")}</span>
              <span className="text-white/40">[{a.actorRole}#{a.actorUserId ?? "?"}]</span>
              {a.metadata && (
                <details className="ml-auto">
                  <summary className="text-white/40 cursor-pointer">meta</summary>
                  <pre className="text-[10px] text-white/60 overflow-x-auto mt-1 max-w-md">{JSON.stringify(a.metadata, null, 2)}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
