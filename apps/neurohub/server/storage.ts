import {
  type User, type InsertUser, type PublicUser,
  type Transaction, type Generation,
  users, transactions, generations,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, sql, and } from "drizzle-orm";
import bcrypt from "bcryptjs";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

// Auto-migrate columns
try {
  const userCols = sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const ucn = userCols.map(c => c.name);
  if (!ucn.includes("pending_name")) sqlite.exec("ALTER TABLE users ADD COLUMN pending_name TEXT");
  if (!ucn.includes("name_change_token")) sqlite.exec("ALTER TABLE users ADD COLUMN name_change_token TEXT");

  const genCols = sqlite.prepare("PRAGMA table_info(generations)").all() as { name: string }[];
  const gcn = genCols.map(c => c.name);
  if (!gcn.includes("local_path")) sqlite.exec("ALTER TABLE generations ADD COLUMN local_path TEXT");
  if (!gcn.includes("cover_gen_id")) sqlite.exec("ALTER TABLE generations ADD COLUMN cover_gen_id INTEGER");
  if (!gcn.includes("display_title")) sqlite.exec("ALTER TABLE generations ADD COLUMN display_title TEXT");
  if (!gcn.includes("pending_title")) sqlite.exec("ALTER TABLE generations ADD COLUMN pending_title TEXT");
  if (!gcn.includes("title_change_token")) sqlite.exec("ALTER TABLE generations ADD COLUMN title_change_token TEXT");
  if (!gcn.includes("deleted_at")) sqlite.exec("ALTER TABLE generations ADD COLUMN deleted_at TEXT");
  if (!gcn.includes("error_reason")) sqlite.exec("ALTER TABLE generations ADD COLUMN error_reason TEXT");

  // gen_activity: геолокация IP
  const gaCols = sqlite.prepare("PRAGMA table_info(gen_activity)").all() as { name: string }[];
  const gan = gaCols.map(c => c.name);
  if (!gan.includes("city")) sqlite.exec("ALTER TABLE gen_activity ADD COLUMN city TEXT");
  if (!gan.includes("region")) sqlite.exec("ALTER TABLE gen_activity ADD COLUMN region TEXT");
  if (!gan.includes("country")) sqlite.exec("ALTER TABLE gen_activity ADD COLUMN country TEXT");
  if (!gan.includes("country_code")) sqlite.exec("ALTER TABLE gen_activity ADD COLUMN country_code TEXT");

  // visitors: country_code
  const vCols = sqlite.prepare("PRAGMA table_info(visitors)").all() as { name: string }[];
  const vn = vCols.map(c => c.name);
  if (!vn.includes("country_code")) sqlite.exec("ALTER TABLE visitors ADD COLUMN country_code TEXT");

  // v304 foundation tables (Sprint 1).
  // Spec: docs/strategy/original/07-DEPLOY-ROADMAP-СХЕМА-БД.md §3.
  // Idempotent — safe to run on every boot.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      payload TEXT,
      source_module TEXT,
      user_id INTEGER,
      lead_id INTEGER,
      occurred_at TEXT DEFAULT CURRENT_TIMESTAMP,
      handlers_count INTEGER,
      handlers_failed INTEGER
    );
    CREATE INDEX IF NOT EXISTS events_name_idx ON events(name, occurred_at);
    CREATE INDEX IF NOT EXISTS events_user_idx ON events(user_id);

    CREATE TABLE IF NOT EXISTS plugins_registry (
      name TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      loaded_at TEXT,
      last_error TEXT,
      config TEXT
    );

    CREATE TABLE IF NOT EXISTS feature_flags (
      key TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      rollout_percent INTEGER NOT NULL DEFAULT 100,
      conditions TEXT,
      ab_variants TEXT,
      description TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT UNIQUE,
      email TEXT,
      phone TEXT,
      telegram_chat_id TEXT,
      vk_user_id TEXT,
      intent TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      segment TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
      user_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS leads_email_idx ON leads(email);
    CREATE INDEX IF NOT EXISTS leads_score_idx ON leads(score DESC);

    CREATE TABLE IF NOT EXISTS agent_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      trigger_event TEXT NOT NULL,
      user_id INTEGER,
      lead_id INTEGER,
      action_kind TEXT NOT NULL,
      action_payload TEXT,
      scheduled_for TEXT,
      executed_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS agent_actions_status_idx ON agent_actions(status, scheduled_for);
    CREATE INDEX IF NOT EXISTS agent_actions_agent_idx ON agent_actions(agent_name, created_at);

    CREATE TABLE IF NOT EXISTS tracking_attribution (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      lead_id INTEGER,
      first_utm_source TEXT,
      first_utm_medium TEXT,
      first_utm_campaign TEXT,
      first_utm_content TEXT,
      first_referer TEXT,
      first_landing_page TEXT,
      first_seen_at TEXT,
      last_utm_source TEXT,
      last_utm_medium TEXT,
      last_utm_campaign TEXT,
      last_utm_content TEXT,
      last_seen_at TEXT,
      yandex_yclid TEXT,
      vk_clickid TEXT,
      google_gclid TEXT,
      meta_fbclid TEXT,
      country TEXT,
      city TEXT,
      ip TEXT,
      device TEXT,
      browser TEXT,
      os TEXT
    );
    CREATE INDEX IF NOT EXISTS attribution_user_idx ON tracking_attribution(user_id);
    CREATE INDEX IF NOT EXISTS attribution_lead_idx ON tracking_attribution(lead_id);
  `);
} catch (e) {
  console.error("[MIGRATION] Error:", e);
}

export const db = drizzle(sqlite);

function toPublicUser(user: User): PublicUser {
  const { password, nameChangeToken, ...rest } = user;
  return rest;
}

export interface IStorage {
  // Users
  getUser(id: number): User | undefined;
  getUserByEmail(email: string): User | undefined;
  createUser(data: InsertUser): User;
  getAllUsers(): PublicUser[];
  updateBalance(userId: number, amount: number): void;

  // Generations
  createGeneration(data: {
    userId: number;
    type: string;
    prompt: string;
    style?: string;
    cost?: number;
    taskId?: string;
    status?: string;
    isPublic?: number;
    authorName?: string;
  }): Generation;
  updateGeneration(id: number, data: Partial<{ status: string; resultUrl: string; resultData: string; taskId: string }>): void;
  getGeneration(id: number): Generation | undefined;
  getGenerationByTaskId(taskId: string): Generation | undefined;
  getUserGenerations(userId: number): Generation[];
  getUserDeletedGenerations(userId: number): Generation[];

  // Transactions
  createTransaction(data: { userId: number; type: string; amount: number; description?: string }): Transaction;
  getTransactions(userId: number): Transaction[];
}

export class DatabaseStorage implements IStorage {
  getUser(id: number): User | undefined {
    return db.select().from(users).where(eq(users.id, id)).get();
  }

  getUserByEmail(email: string): User | undefined {
    return db.select().from(users).where(eq(users.email, email)).get();
  }

  createUser(data: InsertUser): User {
    const hashedPassword = bcrypt.hashSync(data.password, 10);
    return db.insert(users).values({ ...data, password: hashedPassword }).returning().get();
  }

  getAllUsers(): PublicUser[] {
    return db.select().from(users).all().map(toPublicUser);
  }

  updateBalance(userId: number, amount: number): void {
    db.update(users)
      .set({ balance: sql`${users.balance} + ${amount}` })
      .where(eq(users.id, userId))
      .run();
  }

  // Generations
  createGeneration(data: {
    userId: number;
    type: string;
    prompt: string;
    style?: string;
    cost?: number;
    taskId?: string;
    status?: string;
    isPublic?: number;
    authorName?: string;
  }): Generation {
    return db.insert(generations).values({
      userId: data.userId,
      type: data.type,
      prompt: data.prompt,
      style: data.style || null,
      cost: data.cost || 9900,
      isPublic: data.isPublic ?? 1,
      authorName: data.authorName || null,
      taskId: data.taskId || null,
      status: data.status || "pending",
    }).returning().get();
  }

  updateGeneration(id: number, data: Partial<{ status: string; resultUrl: string; resultData: string; taskId: string }>): void {
    db.update(generations).set(data).where(eq(generations.id, id)).run();
  }

  getGeneration(id: number): Generation | undefined {
    return db.select().from(generations).where(eq(generations.id, id)).get();
  }

  getGenerationByTaskId(taskId: string): Generation | undefined {
    return db.select().from(generations).where(eq(generations.taskId, taskId)).get();
  }

  getUserGenerations(userId: number): Generation[] {
    return db.select().from(generations).where(
      and(eq(generations.userId, userId), sql`${generations.deletedAt} IS NULL`)
    ).orderBy(desc(generations.id)).all();
  }

  getUserDeletedGenerations(userId: number): Generation[] {
    return db.select().from(generations).where(
      and(eq(generations.userId, userId), sql`${generations.deletedAt} IS NOT NULL`)
    ).orderBy(desc(generations.id)).all();
  }

  // Transactions
  createTransaction(data: { userId: number; type: string; amount: number; description?: string }): Transaction {
    return db.insert(transactions).values(data).returning().get();
  }

  getTransactions(userId: number): Transaction[] {
    return db.select().from(transactions).where(eq(transactions.userId, userId)).orderBy(desc(transactions.id)).all();
  }
}

export const storage = new DatabaseStorage();
