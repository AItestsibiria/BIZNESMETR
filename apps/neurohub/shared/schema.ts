import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  balance: integer("balance").notNull().default(0), // in kopecks
  freeUsed: integer("free_used").notNull().default(0), // 0 = free generation available, 1 = used
  role: text("role").notNull().default("user"),
  emailVerified: integer("email_verified").notNull().default(0),
  referralCode: text("referral_code"), // уникальный код автора для реферальной ссылки
  referredBy: integer("referred_by"), // ID автора, кто привёл
  referralBonusGiven: integer("referral_bonus_given").notNull().default(0), // получил ли бонус за 1ю оплату
  telegramId: text("telegram_id"), // Telegram user ID
  blocked: integer("blocked").notNull().default(0), // 1 = blocked
  pendingName: text("pending_name"), // новое имя, ожидающее подтверждения
  nameChangeToken: text("name_change_token"), // токен для подтверждения смены имени
  bonusTracks: integer("bonus_tracks").notNull().default(0), // подарочные треки (отдельно от баланса)
  usedPromo: text("used_promo"), // промокод использованный при регистрации
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const promoCodes = sqliteTable("promo_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(), // код (case-insensitive match)
  bonus: integer("bonus").notNull().default(0), // бонус в копейках
  bonusTracks: integer("bonus_tracks").notNull().default(0), // бонусные треки
  maxUses: integer("max_uses").notNull().default(0), // 0 = unlimited
  usedCount: integer("used_count").notNull().default(0),
  activeFrom: text("active_from"), // начало действия
  activeTo: text("active_to"), // конец действия
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const generations = sqliteTable("generations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  type: text("type").notNull(), // 'lyrics', 'music', 'cover'
  prompt: text("prompt").notNull(),
  style: text("style"),
  status: text("status").notNull().default("pending"), // pending, processing, done, error
  resultUrl: text("result_url"), // URL or text content
  resultData: text("result_data"), // JSON
  taskId: text("task_id"), // GPTunnel task ID
  cost: integer("cost").notNull().default(9900), // 99₽
  isPublic: integer("is_public").notNull().default(0), // 0=приват, 1=опубликовано, 2=ожидает модерации
  authorName: text("author_name"), // имя автора для плейлиста
  localPath: text("local_path"), // локальный путь к файлу на сервере
  coverGenId: integer("cover_gen_id"), // ID привязанной обложки
  displayTitle: text("display_title"), // пользовательское название (если изменено)
  priorityUntil: text("priority_until"), // ISO date — приоритет на главной до этой даты
  pendingTitle: text("pending_title"), // ожидает подтверждения
  titleChangeToken: text("title_change_token"),
  deletedAt: text("deleted_at"), // soft-delete
  errorReason: text("error_reason"), // человекочитаемая причина ошибки для UI
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  type: text("type").notNull(), // 'topup', 'lyrics', 'music', 'cover'
  amount: integer("amount").notNull(), // kopecks, negative for charges
  description: text("description"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const payments = sqliteTable("payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  invId: integer("inv_id").notNull().unique(), // Robokassa invoice ID
  amount: integer("amount").notNull(), // kopecks
  status: text("status").notNull().default("pending"), // pending, paid, failed
  description: text("description"),
  roboData: text("robo_data"), // JSON response from Robokassa
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

// Insert schemas
// Generation activity log (downloads, copies, plays)
export const genActivity = sqliteTable("gen_activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  genId: integer("gen_id").notNull(),
  action: text("action").notNull(), // 'download' | 'copy' | 'play' | 'share'
  ip: text("ip"),
  city: text("city"),       // IP → гео кэш через ip-api.com
  region: text("region"),
  country: text("country"),
  countryCode: text("country_code"), // ISO 3166-1 alpha-2 («RU», «US»)
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

// Visitors tracking
export const visitors = sqliteTable("visitors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ip: text("ip"),
  fingerprint: text("fingerprint"), // browser fingerprint hash
  country: text("country"),
  countryCode: text("country_code"),
  city: text("city"),
  region: text("region"),
  userAgent: text("user_agent"),
  referer: text("referer"),
  device: text("device"), // mobile/desktop/tablet
  browser: text("browser"),
  os: text("os"),
  userId: integer("user_id"), // linked user if logged in
  pageUrl: text("page_url"),
  sessionId: text("session_id"),
  visits: integer("visits").notNull().default(1),
  lastVisit: text("last_visit").default(sql`CURRENT_TIMESTAMP`),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  balance: true,
  role: true,
  emailVerified: true,
  createdAt: true,
});

export const registerSchema = z.object({
  name: z.string().optional().default(""),
  email: z.string().email("Некорректный email"),
  password: z.string().min(6, "Пароль минимум 6 символов"),
  ref: z.string().optional(),
  promo: z.string().optional(), // промокод
});

export const loginSchema = z.object({
  email: z.string().email("Некорректный email"),
  password: z.string().min(1, "Введите пароль"),
});

export const insertGenerationSchema = createInsertSchema(generations).omit({
  id: true,
  status: true,
  resultUrl: true,
  resultData: true,
  taskId: true,
  createdAt: true,
});

export const insertTransactionSchema = createInsertSchema(transactions).omit({
  id: true,
  createdAt: true,
});

// Types
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type PublicUser = Omit<User, "password" | "nameChangeToken">;
export type Generation = typeof generations.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
