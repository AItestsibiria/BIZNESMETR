import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
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

  // v304 Sprint 2: Suno на 100% (см. docs/strategy/original/02 §1, §2.1)
  structuralTags: text("structural_tags"),  // JSON: [{ tag: '[Verse]', startSec: 0 }, ...]
  vocalWeights: text("vocal_weights"),      // JSON: { 'rock': 0.7, 'jazz': 0.3 }
  negativePrompt: text("negative_prompt"),  // что НЕ хотим в треке
  sunoModel: text("suno_model"),            // 'v3.5' | 'v4' | 'v4.5'
  durationSeconds: integer("duration_seconds"),
  bpm: integer("bpm"),
  musicKey: text("music_key"),              // 'C major', 'A minor', ...
  templateSlug: text("template_slug"),      // если из шаблона — какого
  // Для extend/cover (Sprint 3-4):
  personaId: text("persona_id"),
  sourceGenId: integer("source_gen_id"),    // если это extend/cover, на чём основано
  // Voice type — единое поле для всех путей генерации (Eugene 2026-05-07).
  // Раньше voice прятался внутри JSON style, что приводило к потере при
  // регенерации/массовой генерации. Теперь — отдельная колонка.
  voiceType: text("voice_type"),            // 'male' | 'female' | 'duet' | 'instrumental' | NULL
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

// ============================================================
// v304: foundation tables (Sprint 1)
// Read docs/strategy/original/07-DEPLOY-ROADMAP-СХЕМА-БД.md §3.
// All v304 tables live here; migrations are auto-applied by
// server/storage.ts on boot (CREATE TABLE IF NOT EXISTS).
// ============================================================

// EventBus persisted events (07 §3.2)
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),                       // uuid v4
  name: text("name").notNull(),                      // 'auth.user.registered', 'gen.completed', ...
  payload: text("payload"),                          // JSON
  sourceModule: text("source_module"),
  userId: integer("user_id"),
  leadId: integer("lead_id"),
  occurredAt: text("occurred_at").default(sql`CURRENT_TIMESTAMP`),
  handlersCount: integer("handlers_count"),
  handlersFailed: integer("handlers_failed"),
});

// Module registry (07 §3.3 / 06 §1.4)
export const pluginsRegistry = sqliteTable("plugins_registry", {
  name: text("name").primaryKey(),
  version: text("version").notNull(),
  status: text("status").notNull().default("active"),  // 'active' | 'disabled' | 'failed'
  loadedAt: text("loaded_at"),
  lastError: text("last_error"),
  config: text("config"),                              // JSON copy of effective config
});

// Feature flags (06 §4.2)
export const featureFlags = sqliteTable("feature_flags", {
  key: text("key").primaryKey(),
  enabled: integer("enabled").notNull().default(0),    // 0/1
  rolloutPercent: integer("rollout_percent").notNull().default(100),
  conditions: text("conditions"),                      // JSON: { user_role, country, ... }
  abVariants: text("ab_variants"),                     // JSON: [{ name, weight, payload }]
  description: text("description"),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

// Anonymous leads (07 §3.4) — visitors before registration
export const leads = sqliteTable("leads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fingerprint: text("fingerprint").unique(),
  email: text("email"),
  phone: text("phone"),
  telegramChatId: text("telegram_chat_id"),
  vkUserId: text("vk_user_id"),
  intent: text("intent"),
  score: integer("score").notNull().default(0),
  segment: text("segment"),
  status: text("status").notNull().default("new"),     // 'new' | 'engaged' | 'converted' | 'dead'
  firstSeen: text("first_seen").default(sql`CURRENT_TIMESTAMP`),
  lastSeen: text("last_seen").default(sql`CURRENT_TIMESTAMP`),
  userId: integer("user_id"),                          // populated once lead becomes a user
});

// Agent actions audit (07 §3.5) — what each agent has done
export const agentActions = sqliteTable("agent_actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentName: text("agent_name").notNull(),
  triggerEvent: text("trigger_event").notNull(),
  userId: integer("user_id"),
  leadId: integer("lead_id"),
  actionKind: text("action_kind").notNull(),
  actionPayload: text("action_payload"),               // JSON
  scheduledFor: text("scheduled_for"),
  executedAt: text("executed_at"),
  status: text("status").notNull().default("pending"), // 'pending' | 'executed' | 'failed' | 'cancelled'
  result: text("result"),
  error: text("error"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

// Marketing attribution (07 §3.11) — first-touch + last-touch
export const trackingAttribution = sqliteTable("tracking_attribution", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id"),
  leadId: integer("lead_id"),
  firstUtmSource: text("first_utm_source"),
  firstUtmMedium: text("first_utm_medium"),
  firstUtmCampaign: text("first_utm_campaign"),
  firstUtmContent: text("first_utm_content"),
  firstReferer: text("first_referer"),
  firstLandingPage: text("first_landing_page"),
  firstSeenAt: text("first_seen_at"),
  lastUtmSource: text("last_utm_source"),
  lastUtmMedium: text("last_utm_medium"),
  lastUtmCampaign: text("last_utm_campaign"),
  lastUtmContent: text("last_utm_content"),
  lastSeenAt: text("last_seen_at"),
  yandexYclid: text("yandex_yclid"),
  vkClickid: text("vk_clickid"),
  googleGclid: text("google_gclid"),
  metaFbclid: text("meta_fbclid"),
  country: text("country"),
  city: text("city"),
  ip: text("ip"),
  device: text("device"),
  browser: text("browser"),
  os: text("os"),
});

// Persona = stable voice / vocal identity (Suno persona ID).
// User создаёт persona из готового трека — все будущие генерации с этой
// persona имеют тот же голос. Spec: docs/strategy/original/02 §1.4, 07 §3.12.
export const personas = sqliteTable("personas", {
  id: text("id").primaryKey(),                 // uuid; либо persona ID от Suno, если выдан
  userId: integer("user_id").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  sourceGenId: integer("source_gen_id").notNull(),  // generation, на основе которой создана
  sunoPersonaId: text("suno_persona_id"),      // ID на стороне Suno (если выдают)
  useCount: integer("use_count").notNull().default(0),
  isPublic: integer("is_public").notNull().default(0),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

// Extend / Cover / Inpaint / Stems — связи между исходным треком и
// производным. Хранит kind и стоимость операции.
// Spec: docs/strategy/original/02 §1.5-§1.7, 07 §3.12.
export const genExtensions = sqliteTable("gen_extensions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceGenId: integer("source_gen_id").notNull(),
  resultGenId: integer("result_gen_id").notNull(),
  kind: text("kind").notNull(),                // 'extend' | 'cover' | 'inpaint' | 'stems'
  cost: integer("cost").notNull().default(0),
  metadata: text("metadata"),                  // JSON — kind-specific (e.g. extend_seconds, cover_style)
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export type Persona = typeof personas.$inferSelect;
export type GenExtension = typeof genExtensions.$inferSelect;

// Chatbot sessions / messages (Sprint 6).
// Spec: docs/strategy/original/04 §1-§4, 07 §3.6.
export const chatbotSessions = sqliteTable("chatbot_sessions", {
  id: text("id").primaryKey(),                  // uuid
  channel: text("channel").notNull(),           // 'web' | 'telegram' | 'vk' | 'email'
  externalId: text("external_id"),              // tg_chat_id / vk_user_id / email
  userId: integer("user_id"),
  leadId: integer("lead_id"),
  state: text("state").notNull().default("active"),  // 'active' | 'escalated' | 'closed'
  intent: text("intent"),                       // распознанное намерение (sales / support / faq / other)
  // Eugene 2026-05-11: профиль юзера, извлечённый LLM из истории.
  // JSON: { name, age, city, occasion, target, mood, interests, notes }.
  // Обновляется async после каждых 3 сообщений. Передаётся в system prompt
  // → бот не переспрашивает и ведёт диалог глубже.
  userProfile: text("user_profile"),
  // Persona lock (Eugene 2026-05-12): сохраняем имя выбранной персоны
  // (Аня/Татьяна/Мария/Ольга) при создании сессии — гарантия что
  // помощник один и тот же до конца, даже если hash-алгоритм изменится.
  personaName: text("persona_name"),
  // Long-term memo (Eugene 2026-05-11): сжатая summary предыдущих сессий
  // (если юзер вернулся через 24h+). LLM сжимает старые сообщения в 1-2
  // фразы — даёт бо́льший контекст без раздувания history.
  longTermMemo: text("long_term_memo"),
  // Счётчик возвращений (Eugene 2026-05-11): сколько раз юзер
  // возобновлял диалог после >24h тишины. Влияет на тон («давно не
  // виделись» / «как договаривались, перейдём к шаблону»).
  visitCount: integer("visit_count").notNull().default(1),
  startedAt: text("started_at").default(sql`CURRENT_TIMESTAMP`),
  lastMessageAt: text("last_message_at").default(sql`CURRENT_TIMESTAMP`),
});

export const chatbotMessages = sqliteTable("chatbot_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(),                 // 'user' | 'bot' | 'system'
  text: text("text").notNull(),
  toolCall: text("tool_call"),                  // JSON если бот дёрнул tool
  toolResult: text("tool_result"),              // JSON ответа tool'а
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export type ChatbotSession = typeof chatbotSessions.$inferSelect;
export type ChatbotMessage = typeof chatbotMessages.$inferSelect;

// Admin audit log — backup-before-edit для всех PUT/PATCH/DELETE через
// /api/admin/v304/*. Хранит JSON-snapshot before/after, позволяет
// откатить любое редактирование.
// Spec: docs/strategy/original/06 §4.3 (audit), правило Eugene 2026-05-07.
export const adminAuditLog = sqliteTable("admin_audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  adminUserId: integer("admin_user_id"),
  adminEmail: text("admin_email"),
  action: text("action").notNull(),                // 'create' | 'update' | 'delete' | 'restore'
  entity: text("entity").notNull(),                // 'template' | 'flag' | 'lead' | ...
  entityKey: text("entity_key").notNull(),         // slug / key / id (как text)
  beforeJson: text("before_json"),                 // null если create
  afterJson: text("after_json"),                   // null если delete (hard)
  restoredFromAuditId: integer("restored_from_audit_id"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export type AdminAuditEntry = typeof adminAuditLog.$inferSelect;

// Incidents — auto-detected critical problems with root-cause classification.
// Eugene 2026-05-07: 'при любой ошибке разбирайся в первопричинах,
// решай сразу. В логах зеленым решенные, стратегически нерешенный
// сразу красным админпанель Критично'.
export const incidents = sqliteTable("incidents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),                         // 'gptunnel_invalid_key' | 'gptunnel_low_balance' | 'gptunnel_no_media_scope' | 'plugin_failed' | 'generation_error' | 'env_desynced' | 'other'
  severity: text("severity").notNull().default("critical"), // 'critical' | 'warning' | 'info'
  title: text("title").notNull(),
  rootCause: text("root_cause"),                        // Человеческое объяснение
  resolution: text("resolution"),                       // Что нужно сделать — для UI
  evidence: text("evidence"),                            // JSON с доказательствами (sample log line, http response, и т.д.)
  status: text("status").notNull().default("open"),     // 'open' | 'resolved' | 'auto-resolved' | 'dismissed'
  firstSeenAt: text("first_seen_at").default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").default(sql`CURRENT_TIMESTAMP`),
  resolvedAt: text("resolved_at"),
  occurrences: integer("occurrences").notNull().default(1),
  // dedupe key: kind+context, дубли увеличивают occurrences вместо нового row
  dedupeKey: text("dedupe_key").unique(),
});

export type Incident = typeof incidents.$inferSelect;

// User-uploaded audio files (Sprint 3.1) — для cover/extend/voice-clone.
// SHA256 от содержимого = идемпотентность: тот же файл = тот же uploadUrl.
// Очистка cron'ом старше 30 дней без use.
export const audioUploads = sqliteTable("audio_uploads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  sha: text("sha").notNull().unique(),
  filenameOriginal: text("filename_original"),
  ext: text("ext"),
  sizeBytes: integer("size_bytes"),
  durationSec: real("duration_sec"),
  mime: text("mime"),
  storagePath: text("storage_path").notNull(),
  publicUrl: text("public_url").notNull(),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  lastUsedAt: text("last_used_at"),
});
export type AudioUpload = typeof audioUploads.$inferSelect;

// Bot learnings (Eugene 2026-05-11): самообучение. Раз в 24h LLM
// анализирует диалоги последних 7 дней — что в успешных работает,
// что в неуспешных нет. Insights подмешиваются в system prompt бота
// → бот сам корректирует поведение.
export const botLearnings = sqliteTable("bot_learnings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scope: text("scope").notNull().default("daily"), // 'daily' | 'weekly' | 'on-demand'
  sampleSize: integer("sample_size").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  whatWorked: text("what_worked"),                  // короткий текст что работало
  whatFailed: text("what_failed"),                  // что не работало
  recommendations: text("recommendations"),         // конкретные рекомендации боту
  applied: integer("applied").notNull().default(1), // 1 = подмешивается в prompt; 0 = отключено админом
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});
export type BotLearning = typeof botLearnings.$inferSelect;

// Song drafts (Eugene 2026-05-11): юзер сохраняет идеи/тексты будущих
// песен в личный кабинет — редактирует позже, нажимает «Сгенерировать»
// → редирект на /music с pre-filled полями. Создаётся:
//   - из бота (бот предлагает «сохранить идею»)
//   - из /music (кнопка «Сохранить как черновик»)
//   - из /dashboard (новая секция «Мои черновики»)
export const songDrafts = sqliteTable("song_drafts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  title: text("title"),
  lyrics: text("lyrics"),           // готовый текст
  prompt: text("prompt"),           // короткое описание (для basic режима)
  style: text("style"),             // pop / rock / lullaby ...
  voice: text("voice"),             // female / male / duet / instrumental
  mood: text("mood"),               // happy / sad / romantic ...
  tempo: text("tempo"),             // slow / moderate / fast / very fast
  bpm: integer("bpm"),
  source: text("source"),           // 'bot' | 'site' | 'dashboard' — откуда сохранено
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});
export type SongDraft = typeof songDrafts.$inferSelect;

// Engagement events (Eugene 2026-05-11): воронка вовлечения для admin
// dashboard. Считаем сколько людей пытаются — register/login/telegram/
// generation/consultant-click. Daily breakdown в /admin → 📊 Воронка.
export const engagementEvents = sqliteTable("engagement_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventType: text("event_type").notNull(), // 'email_register_attempt' | 'email_login_attempt' | 'tg_login_start' | 'tg_login_confirmed' | 'consultant_impression' | 'consultant_open' | 'consultant_action' | 'music_generate_attempt' | 'music_generate_success'
  channel: text("channel"),                // 'site' | 'telegram' | 'max' | 'email' | null
  userId: integer("user_id"),              // если известен
  sessionId: text("session_id"),           // session/cookie id для дедупа
  ip: text("ip"),
  userAgent: text("user_agent"),
  meta: text("meta"),                      // JSON: action name, source page, gen mode, error reason
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});
export type EngagementEvent = typeof engagementEvents.$inferSelect;

// Generation templates (10 пресетов, см. docs/strategy/original/02 §4.2)
export const genTemplates = sqliteTable("gen_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),    // 'wedding', 'birthday', 'corporate', ...
  name: text("name").notNull(),             // «Песня на свадьбу»
  category: text("category"),               // 'celebration' | 'b2b' | 'kids' | 'memory' | ...
  description: text("description"),
  promptTemplate: text("prompt_template"),  // шаблон prompt с плейсхолдерами {name}, {date}
  style: text("style"),                     // дефолтный жанр
  structuralTagsJson: text("structural_tags_json"),  // дефолтная структура [Verse]/[Chorus]/...
  recommendedBpm: integer("recommended_bpm"),
  recommendedKey: text("recommended_key"),
  popularity: integer("popularity").notNull().default(0),
  active: integer("active").notNull().default(1),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export type Event = typeof events.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type AgentAction = typeof agentActions.$inferSelect;
export type FeatureFlag = typeof featureFlags.$inferSelect;
export type PluginRegistration = typeof pluginsRegistry.$inferSelect;
export type TrackingAttribution = typeof trackingAttribution.$inferSelect;

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
