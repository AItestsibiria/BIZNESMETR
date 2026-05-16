import {
  type User, type InsertUser, type PublicUser,
  type Transaction, type Generation,
  users, transactions, generations,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, sql, and } from "drizzle-orm";
import bcrypt from "bcryptjs";

const sqlite = new Database(process.env.DATABASE_FILE || "data.db");
sqlite.pragma("journal_mode = WAL");

// Bootstrap core v51 tables on a fresh DB. Idempotent — CREATE IF NOT EXISTS.
// Без этого блока на пустой data.db ALTER TABLE ниже падает («no such table»).
// Schema below — точная копия v51 миграций (drizzle-kit push), нужная просто
// чтобы сервер мог стартовать с нуля и для local-runtime тестов.
try {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0,
      free_used INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'user',
      email_verified INTEGER NOT NULL DEFAULT 0,
      referral_code TEXT,
      referred_by INTEGER,
      referral_bonus_given INTEGER NOT NULL DEFAULT 0,
      telegram_id TEXT,
      blocked INTEGER NOT NULL DEFAULT 0,
      pending_name TEXT,
      name_change_token TEXT,
      bonus_tracks INTEGER NOT NULL DEFAULT 0,
      used_promo TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS promo_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      bonus INTEGER NOT NULL DEFAULT 0,
      bonus_tracks INTEGER NOT NULL DEFAULT 0,
      max_uses INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      active_from TEXT,
      active_to TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      style TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result_url TEXT,
      result_data TEXT,
      task_id TEXT,
      cost INTEGER NOT NULL DEFAULT 9900,
      is_public INTEGER NOT NULL DEFAULT 0,
      author_name TEXT,
      priority_until TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      inv_id INTEGER NOT NULL UNIQUE,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      description TEXT,
      robo_data TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gen_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gen_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      ip TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS visitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT,
      fingerprint TEXT,
      country TEXT,
      city TEXT,
      region TEXT,
      user_agent TEXT,
      referer TEXT,
      device TEXT,
      browser TEXT,
      os TEXT,
      user_id INTEGER,
      page_url TEXT,
      session_id TEXT,
      visits INTEGER NOT NULL DEFAULT 1,
      last_visit TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- v51 sessions: Bearer auth token storage (created on-the-fly by routes.ts;
    -- but we explicitly include it so a fresh data.db boots cleanly).
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL
    );
  `);
} catch (e) {
  console.error("[BOOTSTRAP] Error creating core tables:", e);
}

// Auto-migrate columns
try {
  const userCols = sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const ucn = userCols.map(c => c.name);
  if (!ucn.includes("pending_name")) sqlite.exec("ALTER TABLE users ADD COLUMN pending_name TEXT");
  if (!ucn.includes("name_change_token")) sqlite.exec("ALTER TABLE users ADD COLUMN name_change_token TEXT");
  // Eugene 2026-05-14 Босс: правило «1000 первых из РФ + ближнее зарубежье».
  if (!ucn.includes("country")) sqlite.exec("ALTER TABLE users ADD COLUMN country TEXT");
  if (!ucn.includes("country_code")) sqlite.exec("ALTER TABLE users ADD COLUMN country_code TEXT");
  if (!ucn.includes("welcome_gift_given")) sqlite.exec("ALTER TABLE users ADD COLUMN welcome_gift_given INTEGER NOT NULL DEFAULT 0");
  // Eugene 2026-05-14 Босс «создай профиль если зарегистрируется, исходя
  // из данных в личном кабинете». JSON с memo от Музы — повод, кому,
  // настроение, ДР и т.д.
  if (!ucn.includes("profile")) sqlite.exec("ALTER TABLE users ADD COLUMN profile TEXT");

  // Eugene 2026-05-15 Босс «SMS-провайдер РФ + замена номера в кабинете +
  // подтверждение изменений данных». Phone-OTP инфраструктура.
  if (!ucn.includes("phone")) sqlite.exec("ALTER TABLE users ADD COLUMN phone TEXT");
  if (!ucn.includes("phone_verified")) sqlite.exec("ALTER TABLE users ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0");
  if (!ucn.includes("pending_phone")) sqlite.exec("ALTER TABLE users ADD COLUMN pending_phone TEXT");
  if (!ucn.includes("pending_phone_otp_hash")) sqlite.exec("ALTER TABLE users ADD COLUMN pending_phone_otp_hash TEXT");
  if (!ucn.includes("pending_phone_otp_expires_at")) sqlite.exec("ALTER TABLE users ADD COLUMN pending_phone_otp_expires_at TEXT");
  if (!ucn.includes("pending_email")) sqlite.exec("ALTER TABLE users ADD COLUMN pending_email TEXT");
  if (!ucn.includes("email_change_token")) sqlite.exec("ALTER TABLE users ADD COLUMN email_change_token TEXT");
  // Index по phone (для login by phone).
  try { sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_idx ON users(phone) WHERE phone IS NOT NULL`); } catch {}

  // SMS OTP-коды (отдельная таблица для register/login flow — без юзера ещё).
  // Eugene 2026-05-15 Босс. Hash код, не plain (защита от leak data.db).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sms_otp (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      purpose TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0,
      provider_log_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sms_otp_phone_idx ON sms_otp(phone, used, expires_at);
  `);

  // SMS-провайдер логи — каждый запрос к SMS.ru/SMSC/SMSAero. Без plain-кода.
  // Eugene 2026-05-15 Босс «провайдер РФ — вести logs в admin panel».
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sms_provider_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      phone_masked TEXT NOT NULL,
      purpose TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_msg_id TEXT,
      provider_cost TEXT,
      provider_status_text TEXT,
      error_message TEXT,
      request_meta TEXT,
      response_raw TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS sms_provider_logs_phone_idx ON sms_provider_logs(phone_masked, created_at);
    CREATE INDEX IF NOT EXISTS sms_provider_logs_status_idx ON sms_provider_logs(status, created_at);
  `);

  // Универсальная очередь подтверждений изменений данных автора (имя, email,
  // phone, телеграм-id, любое будущее поле). Eugene 2026-05-15 Босс
  // «возможность менять данные с подтверждением что меняется от автора».
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user_data_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT NOT NULL,
      confirm_channel TEXT NOT NULL,
      confirm_token TEXT,
      confirm_otp_hash TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      ip TEXT,
      user_agent TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      confirmed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS user_data_change_user_idx ON user_data_change_requests(user_id, status);
    CREATE INDEX IF NOT EXISTS user_data_change_status_idx ON user_data_change_requests(status, expires_at);
  `);

  // Eugene 2026-05-14 Босс «папка заместителей в админ-панели».
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS admin_delegates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      note TEXT,
      granted_by_email TEXT,
      granted_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,
      revoked_reason TEXT
    )`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS admin_delegates_email_idx ON admin_delegates(email)`);
  } catch (e) { console.error("[MIGRATION] admin_delegates failed:", e); }

  const genCols = sqlite.prepare("PRAGMA table_info(generations)").all() as { name: string }[];
  const gcn = genCols.map(c => c.name);
  if (!gcn.includes("local_path")) sqlite.exec("ALTER TABLE generations ADD COLUMN local_path TEXT");
  if (!gcn.includes("cover_gen_id")) sqlite.exec("ALTER TABLE generations ADD COLUMN cover_gen_id INTEGER");
  if (!gcn.includes("display_title")) sqlite.exec("ALTER TABLE generations ADD COLUMN display_title TEXT");
  if (!gcn.includes("pending_title")) sqlite.exec("ALTER TABLE generations ADD COLUMN pending_title TEXT");
  if (!gcn.includes("title_change_token")) sqlite.exec("ALTER TABLE generations ADD COLUMN title_change_token TEXT");
  if (!gcn.includes("deleted_at")) sqlite.exec("ALTER TABLE generations ADD COLUMN deleted_at TEXT");
  if (!gcn.includes("error_reason")) sqlite.exec("ALTER TABLE generations ADD COLUMN error_reason TEXT");
  // Eugene 2026-05-14 Босс «при публикации админ выбирает: основной
  // плейлист или плейлист поздравлений». Default 'main'.
  if (!gcn.includes("pool")) sqlite.exec("ALTER TABLE generations ADD COLUMN pool TEXT DEFAULT 'main'");
  // Reject reason от админа когда возвращает на доработку
  if (!gcn.includes("rejection_reason")) sqlite.exec("ALTER TABLE generations ADD COLUMN rejection_reason TEXT");

  // v304 Sprint 2: Suno на 100%. См. docs/strategy/original/02 §2.1.
  // Все колонки nullable — старый код v51 их не пишет, новый — пишет
  // только когда пользователь / template их задал.
  if (!gcn.includes("structural_tags")) sqlite.exec("ALTER TABLE generations ADD COLUMN structural_tags TEXT");
  if (!gcn.includes("vocal_weights")) sqlite.exec("ALTER TABLE generations ADD COLUMN vocal_weights TEXT");
  if (!gcn.includes("negative_prompt")) sqlite.exec("ALTER TABLE generations ADD COLUMN negative_prompt TEXT");
  if (!gcn.includes("suno_model")) sqlite.exec("ALTER TABLE generations ADD COLUMN suno_model TEXT");
  if (!gcn.includes("duration_seconds")) sqlite.exec("ALTER TABLE generations ADD COLUMN duration_seconds INTEGER");
  if (!gcn.includes("bpm")) sqlite.exec("ALTER TABLE generations ADD COLUMN bpm INTEGER");
  if (!gcn.includes("music_key")) sqlite.exec("ALTER TABLE generations ADD COLUMN music_key TEXT");
  if (!gcn.includes("template_slug")) sqlite.exec("ALTER TABLE generations ADD COLUMN template_slug TEXT");
  if (!gcn.includes("persona_id")) sqlite.exec("ALTER TABLE generations ADD COLUMN persona_id TEXT");
  if (!gcn.includes("source_gen_id")) sqlite.exec("ALTER TABLE generations ADD COLUMN source_gen_id INTEGER");
  // Eugene 2026-05-07: единое поле voice_type для всех путей генерации
  // (см. server/lib/normalizeVocalParams.ts).
  if (!gcn.includes("voice_type")) sqlite.exec("ALTER TABLE generations ADD COLUMN voice_type TEXT");

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

    -- v304 Sprint 2: gen_templates (см. 02 §4.2)
    CREATE TABLE IF NOT EXISTS gen_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT,
      description TEXT,
      prompt_template TEXT,
      style TEXT,
      structural_tags_json TEXT,
      recommended_bpm INTEGER,
      recommended_key TEXT,
      popularity INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS gen_templates_active_idx ON gen_templates(active, popularity DESC);

    -- v304 Sprint 3: personas + gen_extensions
    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      source_gen_id INTEGER NOT NULL,
      suno_persona_id TEXT,
      use_count INTEGER NOT NULL DEFAULT 0,
      is_public INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS personas_user_idx ON personas(user_id);

    CREATE TABLE IF NOT EXISTS gen_extensions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_gen_id INTEGER NOT NULL,
      result_gen_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('extend','cover','inpaint','stems')),
      cost INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS gen_extensions_source_idx ON gen_extensions(source_gen_id);
    CREATE INDEX IF NOT EXISTS gen_extensions_result_idx ON gen_extensions(result_gen_id);

    -- Sprint 6: chatbot
    CREATE TABLE IF NOT EXISTS chatbot_sessions (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      external_id TEXT,
      user_id INTEGER,
      lead_id INTEGER,
      state TEXT NOT NULL DEFAULT 'active',
      intent TEXT,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_message_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS chatbot_sessions_external_idx ON chatbot_sessions(channel, external_id);
    CREATE INDEX IF NOT EXISTS chatbot_sessions_user_idx ON chatbot_sessions(user_id);

    CREATE TABLE IF NOT EXISTS chatbot_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      tool_call TEXT,
      tool_result TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS chatbot_messages_session_idx ON chatbot_messages(session_id, created_at);

    -- Song drafts (Eugene 2026-05-11): сохранённые идеи/тексты юзеров.
    CREATE TABLE IF NOT EXISTS song_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT,
      lyrics TEXT,
      prompt TEXT,
      style TEXT,
      voice TEXT,
      mood TEXT,
      tempo TEXT,
      bpm INTEGER,
      source TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS song_drafts_user_idx ON song_drafts(user_id, updated_at DESC);

    -- Engagement events (Eugene 2026-05-11): воронка вовлечения.
    CREATE TABLE IF NOT EXISTS engagement_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      channel TEXT,
      user_id INTEGER,
      session_id TEXT,
      ip TEXT,
      user_agent TEXT,
      meta TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS engagement_events_type_idx ON engagement_events(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS engagement_events_recent_idx ON engagement_events(created_at DESC);

    -- Sprint 7: admin audit log (backup-before-edit).
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER,
      admin_email TEXT,
      action TEXT NOT NULL CHECK(action IN ('create','update','delete','restore')),
      entity TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      restored_from_audit_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS admin_audit_log_entity_idx ON admin_audit_log(entity, entity_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_audit_log_recent_idx ON admin_audit_log(created_at DESC);

    -- Incident tracking — auto-detect + auto-resolve.
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'critical',
      title TEXT NOT NULL,
      root_cause TEXT,
      resolution TEXT,
      evidence TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      occurrences INTEGER NOT NULL DEFAULT 1,
      dedupe_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents(status, severity, last_seen_at DESC);

    -- Eugene 2026-05-15 Босс: реестр неудачных действий юзеров для админ-панели.
    -- Сюда падает всё user-facing: failed login, refund-generation, payment fail,
    -- bot не ответил, кнопка ошибку дала. Группировка по group_key (action + error_code).
    CREATE TABLE IF NOT EXISTS user_action_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,                     -- может быть null (anonymous)
      channel TEXT NOT NULL,               -- 'web' | 'telegram' | 'max' | 'api' | 'webhook'
      action TEXT NOT NULL,                -- 'register' | 'login' | 'generate' | 'pay' | 'chat-reply' | ...
      status_code INTEGER,                 -- HTTP status if applicable
      error_code TEXT,                     -- нормализованный ключ для группировки
      error_message TEXT,                  -- читаемое сообщение
      endpoint TEXT,                       -- '/api/music/generate'
      context TEXT,                        -- JSON с деталями (без секретов)
      group_key TEXT NOT NULL,             -- action::error_code — для GROUP BY
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS user_action_failures_group_idx ON user_action_failures(group_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS user_action_failures_user_idx ON user_action_failures(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS user_action_failures_created_idx ON user_action_failures(created_at DESC);

    -- Sprint 3.1 audio-input: пользовательские аудио-файлы для cover/extend.
    -- SHA256 = идемпотентность.
    CREATE TABLE IF NOT EXISTS audio_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      sha TEXT NOT NULL UNIQUE,
      filename_original TEXT,
      ext TEXT,
      size_bytes INTEGER,
      duration_sec REAL,
      mime TEXT,
      storage_path TEXT NOT NULL,
      public_url TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS audio_uploads_user_idx ON audio_uploads(user_id, created_at DESC);
  `);

  // Sprint 6 max-channel — расширяем chatbot_sessions для FSM
  // (Eugene 2026-05-07 12:00). Идемпотентно через PRAGMA-check.
  try {
    const cols = sqlite.prepare("PRAGMA table_info(chatbot_sessions)").all() as any[];
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has("max_chat_id")) sqlite.exec("ALTER TABLE chatbot_sessions ADD COLUMN max_chat_id TEXT");
    if (!has("fsm_state")) sqlite.exec("ALTER TABLE chatbot_sessions ADD COLUMN fsm_state TEXT");
    if (!has("fsm_data")) sqlite.exec("ALTER TABLE chatbot_sessions ADD COLUMN fsm_data TEXT");
    // Eugene 2026-05-11: user_profile JSON для discovery (name/age/city/occasion).
    if (!has("user_profile")) sqlite.exec("ALTER TABLE chatbot_sessions ADD COLUMN user_profile TEXT");
    // Persona lock — сохраняем имя выбранной персоны при создании сессии.
    if (!has("persona_name")) sqlite.exec("ALTER TABLE chatbot_sessions ADD COLUMN persona_name TEXT");
    if (!has("last_reengaged_at")) sqlite.exec("ALTER TABLE chatbot_sessions ADD COLUMN last_reengaged_at TEXT");
    // Long-term memo + visit counter — прогрессия коммуникации при возврате.
    if (!has("long_term_memo")) sqlite.exec("ALTER TABLE chatbot_sessions ADD COLUMN long_term_memo TEXT");
    if (!has("visit_count")) sqlite.exec("ALTER TABLE chatbot_sessions ADD COLUMN visit_count INTEGER NOT NULL DEFAULT 1");
    // Eugene 2026-05-14 Босс: cross-channel pair-code (Telegram/Max → сайт).
    if (!has("web_pair_code")) {
      sqlite.exec("ALTER TABLE chatbot_sessions ADD COLUMN web_pair_code TEXT");
      sqlite.exec("CREATE INDEX IF NOT EXISTS chatbot_sessions_pair_code_idx ON chatbot_sessions(web_pair_code)");
    }
    if (!has("web_pair_code_offered_at")) sqlite.exec("ALTER TABLE chatbot_sessions ADD COLUMN web_pair_code_offered_at TEXT");
  } catch (e) {
    console.error("[MIGRATION] chatbot_sessions FSM columns failed:", e);
  }

  // Bot learnings (Eugene 2026-05-11): самообучение по диалогам.
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS bot_learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'daily',
      sample_size INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      what_worked TEXT,
      what_failed TEXT,
      recommendations TEXT,
      applied INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS bot_learnings_recent_idx ON bot_learnings(created_at DESC)`);
  } catch (e) {
    console.error("[MIGRATION] chatbot_sessions FSM columns failed:", e);
  }

  // === Agent upgrade (Eugene 2026-05-16 Босс): таблицы AI-агента под 1M юзеров/год ===
  // agent_notes / agent_feedback / agent_handoffs. Idempotent CREATE IF NOT EXISTS.
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_notes (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL DEFAULT 0.5,
        source TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_notes_user_idx ON agent_notes(user_id, kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS agent_notes_expires_idx ON agent_notes(expires_at);

      CREATE TABLE IF NOT EXISTS agent_feedback (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT,
        rating INTEGER,
        label TEXT,
        comment TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_feedback_session_idx ON agent_feedback(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS agent_feedback_label_idx ON agent_feedback(label, created_at DESC);

      CREATE TABLE IF NOT EXISTS agent_handoffs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        assigned_to INTEGER,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_handoffs_session_idx ON agent_handoffs(session_id);
      CREATE INDEX IF NOT EXISTS agent_handoffs_status_idx ON agent_handoffs(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS agent_handoffs_assigned_idx ON agent_handoffs(assigned_to, status);
    `);
  } catch (e) {
    console.error("[MIGRATION] agent_* tables failed:", e);
  }

  // Landing news (Eugene 2026-05-12 Босс): архив + CRUD редактирование.
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS landing_news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      icon_emoji TEXT,
      image_url TEXT,
      badge_color TEXT DEFAULT 'purple',
      border_color TEXT DEFAULT 'purple',
      published_at TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      archived_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS landing_news_active_idx ON landing_news(active, position DESC)`);
  } catch (e) {
    console.error("[MIGRATION] landing_news failed:", e);
  }
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

  // Refund safety (single atomic entry-point — see God-mode audit 2026-05-08)
  claimRefund(genId: number): boolean;
  refundGeneration(args: { genId: number; userId: number; cost: number; type: string; description: string }): boolean;
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

  // God-mode audit 2026-05-08: единый атомарный refund-shutter.
  // Раньше 14 inline-рефандов в routes.ts не маркировали style.refunded,
  // и orphan-scanner возвращал повторно. Теперь любая попытка рефанда
  // проходит через claimRefund — SQLite атомарно ставит флаг ИЛИ отказывает.
  claimRefund(genId: number): boolean {
    const result: any = db.run(sql`UPDATE generations
      SET style = json_set(COALESCE(style, '{}'),
                            '$.refunded', json('true'),
                            '$.refundedAt', datetime('now'))
      WHERE id = ${genId}
        AND (json_extract(style, '$.refunded') IS NULL
             OR json_extract(style, '$.refunded') != json('true'))`);
    return (result?.changes ?? 0) > 0;
  }

  refundGeneration(args: { genId: number; userId: number; cost: number; type: string; description: string }): boolean {
    if (!args.cost || args.cost <= 0) return false;
    if (!this.claimRefund(args.genId)) return false;
    this.updateBalance(args.userId, args.cost);
    this.createTransaction({
      userId: args.userId,
      type: args.type,
      amount: args.cost,
      description: args.description,
    });
    return true;
  }
}

export const storage = new DatabaseStorage();
