// Eugene 2026-05-17 Босс: enriched audit-log helper.
//
// Централизованная запись в admin_audit_log из любых admin endpoint'ов.
// Записывает:
//   - admin_user_id / admin_email (кто сделал)
//   - action ('create' | 'update' | 'delete' | 'restore')
//   - entity / entity_key (что меняли)
//   - before_json / after_json (snapshot)
//   - via_email_confirm (был ли email-OTP пройден)
//   - ip / user_agent (откуда сделал)
//   - pending_action_id (FK на admin_pending_actions если via 2FA)
//
// Не throw'ит — audit-failure не должен ломать сам endpoint.
//
// Spec: docs/strategy/ADMIN-SECURITY-AUDIT-170526.md.

import type { Request } from "express";
import { db } from "../storage";

export type AuditAction = "create" | "update" | "delete" | "restore";

export interface AuditEntryInput {
  req?: Pick<Request, "headers" | "ip"> & { adminUser?: { email?: string }; userId?: number };
  adminUserId?: number | null;
  adminEmail?: string | null;
  action: AuditAction;
  entity: string;
  entityKey: string;
  before?: unknown;
  after?: unknown;
  viaEmailConfirm?: boolean;
  pendingActionId?: string | null;
}

export function recordAuditEntry(input: AuditEntryInput): number | null {
  try {
    const adminUserId =
      input.adminUserId ??
      (input.req as any)?.userId ??
      null;
    const adminEmail =
      input.adminEmail ??
      ((input.req as any)?.adminUser?.email as string | undefined) ??
      null;
    const ip = input.req
      ? (input.req.ip || (input.req.headers?.["x-forwarded-for"] as string) || "").toString()
      : null;
    const ua = input.req ? String(input.req.headers?.["user-agent"] || "").slice(0, 500) : null;

    const beforeJson = input.before !== undefined ? JSON.stringify(input.before) : null;
    const afterJson = input.after !== undefined ? JSON.stringify(input.after) : null;

    const sqlite: any = (db as any).$client;
    const stmt = sqlite.prepare(
      `INSERT INTO admin_audit_log
         (admin_user_id, admin_email, action, entity, entity_key,
          before_json, after_json, via_email_confirm, ip, user_agent, pending_action_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const r = stmt.run(
      adminUserId,
      adminEmail ? String(adminEmail).toLowerCase() : null,
      input.action,
      String(input.entity).slice(0, 100),
      String(input.entityKey).slice(0, 200),
      beforeJson,
      afterJson,
      input.viaEmailConfirm ? 1 : 0,
      ip,
      ua,
      input.pendingActionId ?? null,
    );
    return Number(r?.lastInsertRowid || 0) || null;
  } catch (e: any) {
    console.warn("[recordAuditEntry] warn:", e?.message || e);
    return null;
  }
}

export interface AuditQueryFilters {
  limit?: number;
  entity?: string;
  adminUserId?: number;
  viaEmailConfirmOnly?: boolean;
  since?: string;  // ISO timestamp
}

export function queryAuditLog(filters: AuditQueryFilters = {}): any[] {
  try {
    const lim = Math.max(1, Math.min(500, Number(filters.limit) || 100));
    const where: string[] = [];
    const args: any[] = [];
    if (filters.entity) {
      where.push("entity = ?");
      args.push(filters.entity);
    }
    if (filters.adminUserId) {
      where.push("admin_user_id = ?");
      args.push(filters.adminUserId);
    }
    if (filters.viaEmailConfirmOnly) {
      where.push("via_email_confirm = 1");
    }
    if (filters.since) {
      where.push("created_at >= ?");
      args.push(filters.since);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sqlite: any = (db as any).$client;
    args.push(lim);
    return sqlite
      .prepare(
        `SELECT id, admin_user_id, admin_email, action, entity, entity_key,
                before_json, after_json, via_email_confirm, ip, user_agent,
                pending_action_id, created_at
         FROM admin_audit_log
         ${whereSql}
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(...args);
  } catch {
    return [];
  }
}
