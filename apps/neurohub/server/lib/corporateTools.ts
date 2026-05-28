// Eugene 2026-05-26 Босс «B2B-подсистема: всё можно из чата». Музa как
// менеджер высшей квалификации по работе с корпоративными клиентами (юрлица/ИП):
// находит компанию по ИНН/названию (Контур.Фокус), регистрирует кабинет ЮЛ,
// формирует договор + счёт, доводит до генерации трека.
//
// Эти tools — обёртка поверх существующих узлов (Reuse-working-solutions rule):
//   • lookupCompany() — данные ЮЛ (lib/konturFocus.ts), НЕ зовём Контур напрямую
//   • getLegalConfig() — реквизиты ПРОДАВЦА (ЗАО «Инфолайн»)
//   • invoices-таблица + recordAuditEntry — как issue_invoice (НЕ форкаем платёж)
//
// Все строки RU. Ownership по ctx.userId. Никогда не throw — возвращаем строку.
// Подтверждение (confirm) обязательно ПЕРЕД регистрацией ЮЛ и подписанием
// договора (Chat-tool-calling rule — approval gating). Без AI-провайдеров в
// user-facing тексте (No-AI-providers rule).

import { sqliteDb } from "../storage";
import { PUBLIC_URL } from "./publicUrl";
import { recordAuditEntry } from "./adminAuditLog";
import { lookupCompany, konturConfigured, type CompanyData } from "./konturFocus";
import { getLegalConfig } from "./legalConfig";
import type { ToolDef, ToolHandler } from "./muzaTools";

// PUBLIC_URL — корень для прямой ссылки на ЛК ЮЛ. Приложение использует
// hash-роутинг (wouter useHashLocation), поэтому путь — `/#/corporate/<id>`.
function cabinetUrl(id: number): string {
  return `${PUBLIC_URL}/#/corporate/${id}`;
}

function rub(n: number): string {
  return `${Math.round(n).toLocaleString("ru-RU")} ₽`;
}

function summarizeCompany(c: CompanyData): string {
  const lines = [
    `• Название: ${c.name}${c.fullName && c.fullName !== c.name ? ` (${c.fullName})` : ""}`,
    `• Тип: ${c.kind === "ip" ? "ИП" : "юрлицо"}`,
    `• ИНН: ${c.inn}`,
  ];
  if (c.kpp) lines.push(`• КПП: ${c.kpp}`);
  if (c.ogrn) lines.push(`• ОГРН: ${c.ogrn}`);
  if (c.legalAddress) lines.push(`• Адрес: ${c.legalAddress}`);
  if (c.directorName) lines.push(`• Руководитель: ${c.directorName}`);
  return lines.join("\n");
}

// === Договор: RU-шаблон, продавец из getLegalConfig(), покупатель из ЮЛ ===
function buildContractBody(opts: {
  number: string;
  buyer: any; // legal_entities row (snake_case)
  amountRub: number;
  subject: string;
}): string {
  const s = getLegalConfig();
  const { number, buyer, amountRub, subject } = opts;
  const today = new Date().toLocaleDateString("ru-RU");
  const buyerKind = buyer.kind === "ip" ? "ИП" : "Заказчик";
  return [
    `ДОГОВОР № ${number}`,
    `на оказание услуг по созданию музыкального произведения`,
    ``,
    `г. ${s.legalAddress.split(",")[1]?.trim() || "Томск"}                                ${today}`,
    ``,
    `${s.entityFullName} (далее — «Исполнитель»), в лице руководителя ${s.directorName}, действующего ${s.directorBasis}, с одной стороны, и`,
    `${buyer.full_name || buyer.name} (далее — «${buyerKind}»)${buyer.director_name ? `, в лице ${buyer.director_name}, действующего ${buyer.director_basis || "на основании Устава"}` : ""}, с другой стороны, заключили настоящий Договор о нижеследующем.`,
    ``,
    `1. ПРЕДМЕТ ДОГОВОРА`,
    `1.1. Исполнитель обязуется оказать услуги по созданию музыкального произведения на платформе ${s.brand}: ${subject}.`,
    `1.2. Стоимость услуг по настоящему Договору составляет ${rub(amountRub)} (включая налоги в соответствии с законодательством РФ).`,
    ``,
    `2. РЕКВИЗИТЫ ИСПОЛНИТЕЛЯ`,
    `${s.entityFullName}`,
    `ИНН ${s.inn}${s.kpp ? `, КПП ${s.kpp}` : ""}, ОГРН ${s.ogrn}`,
    `Юр. адрес: ${s.legalAddress}`,
    `Банк: ${s.bankName}`,
    `Р/с ${s.settlementAccount}, к/с ${s.corrAccount}, БИК ${s.bik}`,
    `Тел.: ${s.phone}, e-mail: ${s.email}`,
    ``,
    `3. РЕКВИЗИТЫ ЗАКАЗЧИКА`,
    `${buyer.full_name || buyer.name}`,
    `ИНН ${buyer.inn}${buyer.kpp ? `, КПП ${buyer.kpp}` : ""}${buyer.ogrn ? `, ОГРН ${buyer.ogrn}` : ""}`,
    buyer.legal_address ? `Адрес: ${buyer.legal_address}` : "",
    buyer.bank_name ? `Банк: ${buyer.bank_name}` : "",
    buyer.settlement_account ? `Р/с ${buyer.settlement_account}${buyer.bik ? `, БИК ${buyer.bik}` : ""}` : "",
    ``,
    `Подписано и заверено электронной печатью платформы ${s.brand} (${today}).`,
  ].filter(Boolean).join("\n");
}

// === TOOL DEFINITIONS (RU) ===
const CORPORATE_TOOLS: ToolDef[] = [
  {
    name: "lookup_company_by_inn",
    description:
      "Найти компанию (юрлицо/ИП) по ИНН или названию через базу данных — подтянуть реквизиты для регистрации кабинета ЮЛ. Используй когда клиент пишет ИНН/название организации, «оформите на юрлицо», «нужен счёт на компанию», «безналичная оплата». Бесплатно. Вернёт сводку (название, ИНН, КПП, ОГРН, адрес, директор) — покажи клиенту для подтверждения.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "ИНН (10/12 цифр) или название организации" } },
      required: ["query"],
    },
  },
  {
    name: "register_legal_entity",
    description:
      "Зарегистрировать кабинет юрлица/ИП для клиента. ОБЯЗАТЕЛЬНО запроси подтверждение клиента ПЕРЕД регистрацией (confirm=true). Без confirm — вернёт сводку и попросит подтвердить. query — ИНН или название (подтянет данные). После регистрации даёт прямую ссылку на личный кабинет ЮЛ.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "ИНН или название организации" },
        contact_email: { type: "string", description: "Контактный email (опционально)" },
        contact_phone: { type: "string", description: "Контактный телефон (опционально)" },
        confirm: { type: "boolean", description: "Подтверждение клиента на регистрацию — true для выполнения" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_my_legal_entities",
    description:
      "Показать зарегистрированные кабинеты юрлиц клиента (название, ИНН, статус, баланс, ссылка на ЛК). БЕЗ параметров — берёт из контекста. Используй когда клиент спрашивает «мои юрлица», «мои компании», «мой корпоративный кабинет».",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "generate_corporate_contract",
    description:
      "Сформировать договор + счёт для юрлица. ОБЯЗАТЕЛЬНО запроси подтверждение клиента ПЕРЕД формированием (confirm=true). Без confirm — вернёт сводку и попросит подтвердить. Создаёт подписанный договор (с печатью платформы) и связанный счёт на оплату. Возвращает номер договора и ссылку на оплату.",
    input_schema: {
      type: "object",
      properties: {
        legal_entity_id: { type: "number", description: "ID кабинета ЮЛ (из get_my_legal_entities)" },
        amount_rub: { type: "number", description: "Сумма договора в рублях" },
        subject: { type: "string", description: "Предмет договора / описание услуги (опционально)" },
        confirm: { type: "boolean", description: "Подтверждение клиента — true для формирования" },
      },
      required: ["legal_entity_id", "amount_rub"],
    },
  },
];

// === HANDLERS ===
const CORPORATE_HANDLERS: Record<string, ToolHandler> = {
  async lookup_company_by_inn(input) {
    const query = String(input?.query || "").trim();
    if (!query) return "Укажи ИНН или название организации для поиска.";
    try {
      const c = await lookupCompany(query);
      if (!c) {
        const hint = konturConfigured()
          ? "Компания не найдена в базе. Можно ввести реквизиты вручную — пришли ИНН, КПП, ОГРН, юр. адрес и ФИО руководителя."
          : "Автоматический поиск временно недоступен. Можно ввести реквизиты вручную — пришли ИНН, КПП, ОГРН, юр. адрес и ФИО руководителя.";
        return hint;
      }
      return `Нашла компанию:\n${summarizeCompany(c)}\n\nЗарегистрировать на неё корпоративный кабинет? Подтверди — и я всё оформлю.`;
    } catch (e: any) {
      return `Не удалось выполнить поиск: ${e?.message || e}. Можно ввести реквизиты вручную.`;
    }
  },

  async register_legal_entity(input, ctx) {
    if (!ctx?.userId) return "Юзер не залогинен.";
    const query = String(input?.query || "").trim();
    if (!query) return "Укажи ИНН или название организации.";
    const contactEmail = input?.contact_email ? String(input.contact_email).trim().slice(0, 120) : null;
    const contactPhone = input?.contact_phone ? String(input.contact_phone).trim().slice(0, 40) : null;
    const confirm = input?.confirm === true;

    let c: CompanyData | null = null;
    try {
      c = await lookupCompany(query);
    } catch {
      c = null;
    }
    if (!c) {
      return "Компанию не нашла в базе. Пришли реквизиты вручную (ИНН, КПП, ОГРН, юр. адрес, ФИО руководителя) — и я зарегистрирую кабинет.";
    }

    if (!confirm) {
      return [
        "Готова зарегистрировать корпоративный кабинет на эту организацию:",
        summarizeCompany(c),
        contactEmail ? `• Контактный email: ${contactEmail}` : "",
        contactPhone ? `• Контактный телефон: ${contactPhone}` : "",
        "",
        "Подтверди регистрацию — и я создам кабинет и дам ссылку для прямого входа.",
      ].filter(Boolean).join("\n");
    }

    try {
      const dataJson = JSON.stringify({ source_query: query, raw: c.source === "kontur_focus" ? c.raw ?? null : null });
      const result: any = sqliteDb.prepare(`
        INSERT INTO legal_entities
          (user_id, kind, inn, kpp, ogrn, name, full_name, legal_address,
           director_name, director_basis, phone, email, status, source, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'на основании Устава', ?, ?, 'active', ?, ?)
      `).run(
        ctx.userId,
        c.kind,
        c.inn,
        c.kpp || null,
        c.ogrn || null,
        c.name,
        c.fullName || c.name,
        c.legalAddress || null,
        c.directorName || null,
        contactPhone || c.phone || null,
        contactEmail || c.email || null,
        c.source,
        dataJson,
      );
      const entityId = Number(result?.lastInsertRowid ?? 0);
      try {
        recordAuditEntry({
          adminUserId: ctx.userId,
          adminEmail: "muza-self-service",
          action: "create",
          entity: "legal_entity",
          entityKey: String(entityId),
          before: null,
          after: { inn: c.inn, name: c.name, source: c.source },
        });
      } catch {}
      return `✓ Кабинет юрлица «${c.name}» (ИНН ${c.inn}) зарегистрирован. Прямой вход в личный кабинет: ${cabinetUrl(entityId)}. Дальше могу сформировать договор и счёт — скажи сумму.`;
    } catch (e: any) {
      return `Ошибка регистрации кабинета: ${e?.message || e}`;
    }
  },

  async get_my_legal_entities(_input, ctx) {
    if (!ctx?.userId) return "Юзер не залогинен.";
    try {
      const rows = sqliteDb.prepare(`
        SELECT id, name, inn, status, balance
        FROM legal_entities WHERE user_id = ? ORDER BY id DESC LIMIT 20
      `).all(ctx.userId) as any[];
      if (rows.length === 0) return "У тебя пока нет корпоративных кабинетов. Хочешь — найду компанию по ИНН и зарегистрирую.";
      const lines = rows.map((r) =>
        `• «${r.name}» (ИНН ${r.inn}) — ${r.status}, баланс ${rub((r.balance || 0) / 100)}. ЛК: ${cabinetUrl(r.id)}`);
      return `Твои юрлица (${rows.length}):\n${lines.join("\n")}`;
    } catch (e: any) {
      return `Ошибка get_my_legal_entities: ${e?.message || e}`;
    }
  },

  async generate_corporate_contract(input, ctx) {
    if (!ctx?.userId) return "Юзер не залогинен.";
    const entityId = Number(input?.legal_entity_id);
    const amountRub = Number(input?.amount_rub);
    const subject = String(input?.subject || "создание музыкального произведения по заказу").trim().slice(0, 300);
    const confirm = input?.confirm === true;
    if (!Number.isFinite(entityId)) return "Укажи legal_entity_id (ID кабинета ЮЛ).";
    if (!Number.isFinite(amountRub) || amountRub < 1 || amountRub > 5_000_000) return "Укажи корректную сумму договора в рублях (1–5 000 000).";

    let buyer: any;
    try {
      buyer = sqliteDb.prepare(`SELECT * FROM legal_entities WHERE id = ?`).get(entityId);
    } catch (e: any) {
      return `Ошибка чтения кабинета ЮЛ: ${e?.message || e}`;
    }
    if (!buyer) return `Кабинет ЮЛ #${entityId} не найден.`;
    if (buyer.user_id !== ctx.userId) return "Это не твой кабинет ЮЛ — доступ только к своим.";

    if (!confirm) {
      return [
        `Готова сформировать и подписать договор для «${buyer.name}» (ИНН ${buyer.inn}):`,
        `• Предмет: ${subject}`,
        `• Сумма: ${rub(amountRub)}`,
        `• Продавец: ${getLegalConfig().entityName}`,
        "",
        "После подтверждения создам подписанный договор с печатью платформы и выставлю счёт на оплату. Подтверди.",
      ].join("\n");
    }

    try {
      // 1) Договор → корпоративный реестр номеров MUZA-YYYY-<id>.
      const year = new Date().getFullYear();
      const ins: any = sqliteDb.prepare(`
        INSERT INTO corporate_contracts
          (legal_entity_id, user_id, number, status, body_text, amount_rub, stamped_by, meta)
        VALUES (?, ?, ?, 'signed', ?, ?, 'muza-org', ?)
      `).run(entityId, ctx.userId, "PENDING", "", Math.round(amountRub), JSON.stringify({ subject }));
      const contractId = Number(ins?.lastInsertRowid ?? 0);
      const number = `MUZA-${year}-${contractId}`;
      const bodyText = buildContractBody({ number, buyer, amountRub, subject });
      const nowIso = new Date().toISOString();
      sqliteDb.prepare(`UPDATE corporate_contracts SET number = ?, body_text = ?, signed_at = ? WHERE id = ?`)
        .run(number, bodyText, nowIso, contractId);

      // 2) Связанный счёт (reuse invoices — НЕ форкаем платёж).
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const invMeta = JSON.stringify({
        chat_session_id: ctx.sessionId ?? null,
        legal_entity_id: entityId,
        contract_id: contractId,
        b2b: true,
      });
      const invDesc = `Договор ${number} — ${subject}`.slice(0, 200);
      const invIns: any = sqliteDb.prepare(`
        INSERT INTO invoices
          (user_id, issued_by, amount_rub, description, tariff_key, status, expires_at, meta)
        VALUES (?, 'muza', ?, ?, 'corporate_contract', 'issued', ?, ?)
      `).run(ctx.userId, Math.round(amountRub), invDesc, expiresAt, invMeta);
      const invoiceId = Number(invIns?.lastInsertRowid ?? 0);

      // 3) Привязка счёта к договору.
      sqliteDb.prepare(`UPDATE corporate_contracts SET invoice_id = ? WHERE id = ?`).run(invoiceId, contractId);

      try {
        recordAuditEntry({
          adminUserId: ctx.userId,
          adminEmail: "muza-self-service",
          action: "create",
          entity: "corporate_contract",
          entityKey: String(contractId),
          before: null,
          after: { number, amountRub: Math.round(amountRub), legalEntityId: entityId, invoiceId },
        });
      } catch {}

      const payUrl = `${PUBLIC_URL}/api/invoice/${invoiceId}/pay`;
      return `✓ Договор ${number} сформирован и подписан (печать платформы), сумма ${rub(amountRub)}. Выставила счёт #${invoiceId}. Оплата: ${payUrl}. Договор и счёт — в кабинете ЮЛ: ${cabinetUrl(entityId)}.`;
    } catch (e: any) {
      return `Ошибка формирования договора: ${e?.message || e}`;
    }
  },
};

// Eugene 2026-05-26: расширяем MUZA_TOOLS / HANDLERS из muzaTools.ts тем же
// механизмом что chat-gen tools (push + Object.assign). Вызывается из
// muzaTools.ts рядом с CHAT_GENERATION_TOOLS.
export function initCorporateTools(
  tools: ToolDef[],
  handlers: Record<string, ToolHandler>,
): void {
  for (const td of CORPORATE_TOOLS) tools.push(td);
  Object.assign(handlers, CORPORATE_HANDLERS);
}

// lookup_company может ходить во внешний API (Контур.Фокус, до 8 сек) —
// timeout повышается в muzaTools LONG_TOOL_TIMEOUTS.
export const CORPORATE_LONG_TIMEOUTS: Record<string, number> = {
  lookup_company_by_inn: 15_000,
  register_legal_entity: 15_000,
};

export { CORPORATE_TOOLS, CORPORATE_HANDLERS };
