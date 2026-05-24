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
  // Eugene 2026-05-20: Max messenger user_id linking (deep-link flow)
  if (!ucn.includes("max_user_id")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN max_user_id TEXT");
    try { sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_max_user_id_idx ON users(max_user_id) WHERE max_user_id IS NOT NULL"); } catch {}
  }
  // Linking nonces для Max-deep-link одноразовые
  sqlite.exec(`CREATE TABLE IF NOT EXISTS max_link_nonces (
    nonce TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_max_user_id TEXT
  )`);
  sqlite.exec("CREATE INDEX IF NOT EXISTS max_link_nonces_user_idx ON max_link_nonces(user_id, created_at DESC)");
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

  // Eugene 2026-05-20 Босс «Сообщения аудио в чате для админа (премиум)».
  // chatbot_messages расширяется опциональным audio_url + audio_duration_sec.
  // Если message содержит audio_url — фронт рендерит как <audio>. Frontend
  // gate: показывает только если is_admin OR premium_subscriptions.status='active'.
  try {
    const chatMsgCols = sqlite.prepare("PRAGMA table_info(chatbot_messages)").all() as { name: string }[];
    const cmcn = chatMsgCols.map(c => c.name);
    if (!cmcn.includes("audio_url")) sqlite.exec("ALTER TABLE chatbot_messages ADD COLUMN audio_url TEXT");
    if (!cmcn.includes("audio_duration_sec")) sqlite.exec("ALTER TABLE chatbot_messages ADD COLUMN audio_duration_sec REAL");
    if (!cmcn.includes("audio_premium_only")) sqlite.exec("ALTER TABLE chatbot_messages ADD COLUMN audio_premium_only INTEGER NOT NULL DEFAULT 0");
    // Eugene 2026-05-20 Босс «мини-плеер в чате» — при find_public_track с
    // hint=playNow:<id> backend пишет attached_track_id в bot-message; frontend
    // рендерит inline track-card с persistent audio singleton (Persistent-audio-only rule).
    if (!cmcn.includes("attached_track_id")) sqlite.exec("ALTER TABLE chatbot_messages ADD COLUMN attached_track_id INTEGER");

    // Eugene 2026-05-23 Yars-admin-confirmation rule auto-pull pipeline.
    // При INSERT chatbot_messages с author role IN ('admin','super_admin')
    // И text matching /(ярс|yars|оператор)/i → пометить is_yars_command=1,
    // auto-categorize через classifyOperatorCommand, проставить risk-level.
    // Claude pull'ит queue через GET /api/admin/v304/yars-queue, обрабатывает,
    // помечает решением через POST /api/admin/v304/yars-queue/:id/mark-decision.
    if (!cmcn.includes("is_yars_command")) sqlite.exec("ALTER TABLE chatbot_messages ADD COLUMN is_yars_command INTEGER NOT NULL DEFAULT 0");
    if (!cmcn.includes("yars_category")) sqlite.exec("ALTER TABLE chatbot_messages ADD COLUMN yars_category TEXT");
    if (!cmcn.includes("yars_risk_level")) sqlite.exec("ALTER TABLE chatbot_messages ADD COLUMN yars_risk_level TEXT");
    if (!cmcn.includes("claude_review_decision")) sqlite.exec("ALTER TABLE chatbot_messages ADD COLUMN claude_review_decision TEXT");
    if (!cmcn.includes("claude_review_at")) sqlite.exec("ALTER TABLE chatbot_messages ADD COLUMN claude_review_at INTEGER");
    if (!cmcn.includes("claude_review_commit_sha")) sqlite.exec("ALTER TABLE chatbot_messages ADD COLUMN claude_review_commit_sha TEXT");
    if (!cmcn.includes("claude_review_notes")) sqlite.exec("ALTER TABLE chatbot_messages ADD COLUMN claude_review_notes TEXT");
    // Композитный индекс для быстрого pull-queue: WHERE is_yars_command=1 AND claude_review_decision IS NULL
    try { sqlite.exec("CREATE INDEX IF NOT EXISTS idx_chatbot_yars ON chatbot_messages(is_yars_command, claude_review_decision)"); } catch {}
  } catch (e) {
    console.warn("[BOOTSTRAP] chatbot_messages audio alter failed:", (e as Error).message);
  }

  // Eugene 2026-05-20: payments.invoice_id — связь с Музa-выписанным счётом.
  // Если NOT NULL → /api/payment/result делает fulfillment по invoice.tariff_key
  // (активация premium-подписки / track-кредит), вместо обычного topup balance.
  try {
    const payCols = sqlite.prepare("PRAGMA table_info(payments)").all() as { name: string }[];
    const pcn = payCols.map(c => c.name);
    if (!pcn.includes("invoice_id")) sqlite.exec("ALTER TABLE payments ADD COLUMN invoice_id INTEGER");
  } catch (e) {
    console.warn("[BOOTSTRAP] payments.invoice_id alter failed:", (e as Error).message);
  }

  // Eugene 2026-05-20: user_action_failures.resolved_at + resolved_note + resolved_by_user_id.
  // Босс может «отметить решено» group_key — все записи группы становятся resolved.
  try {
    const uafCols = sqlite.prepare("PRAGMA table_info(user_action_failures)").all() as { name: string }[];
    const ucn = uafCols.map(c => c.name);
    if (!ucn.includes("resolved_at")) sqlite.exec("ALTER TABLE user_action_failures ADD COLUMN resolved_at INTEGER");
    if (!ucn.includes("resolved_note")) sqlite.exec("ALTER TABLE user_action_failures ADD COLUMN resolved_note TEXT");
    if (!ucn.includes("resolved_by_user_id")) sqlite.exec("ALTER TABLE user_action_failures ADD COLUMN resolved_by_user_id INTEGER");
    sqlite.exec("CREATE INDEX IF NOT EXISTS user_action_failures_resolved_idx ON user_action_failures(resolved_at)");
  } catch (e) {
    console.warn("[BOOTSTRAP] user_action_failures resolved alter failed:", (e as Error).message);
  }

  // SMS OTP-коды (отдельная таблица для register/login flow — без юзера ещё).
  // Eugene 2026-05-15 Босс. Hash код, не plain (защита от leak data.db).
  sqlite.exec(`
    -- Eugene 2026-05-21 Босс: «после 1 000 000 prosлушиваний — мировой звезде.
    -- Предложите имя + голосование + топ рейтинг».
    CREATE TABLE IF NOT EXISTS star_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_normalized TEXT NOT NULL UNIQUE,
      name_display TEXT NOT NULL,
      profile_url TEXT,  -- Eugene 2026-05-21 Босс: переход на аккаунт звезды
      votes INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_voted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS star_sugg_votes_idx ON star_suggestions(votes DESC);
    CREATE TABLE IF NOT EXISTS star_votes_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      name_normalized TEXT NOT NULL,
      voted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS star_votes_ip_idx ON star_votes_log(ip, voted_at);

    -- Eugene 2026-05-21 Босс: «кнопка отключить анимации на 1 день,
    -- если 3 дня подряд — сохранить до явного включения. По IP».
    CREATE TABLE IF NOT EXISTS anim_preferences (
      ip TEXT PRIMARY KEY,
      disabled_until TEXT,           -- ISO, NULL = enabled
      consecutive_disables INTEGER NOT NULL DEFAULT 0,
      permanent_off INTEGER NOT NULL DEFAULT 0,  -- 1 = до явного включения юзером
      last_toggle_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS anim_prefs_until_idx ON anim_preferences(disabled_until);

    -- Eugene 2026-05-21 Босс: «дай статистику за месяц какой параметр юзеры
    -- выбирают в Песни — такой и по умолчанию при загрузке. Остальные по
    -- уменьшению частоты выбора». Tracking explicit user choices в sort toggle.
    CREATE TABLE IF NOT EXISTS playlist_sort_choices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      ip TEXT,
      category TEXT NOT NULL,   -- 'song' | 'greeting' | 'instrumental' | 'all'
      sort_mode TEXT NOT NULL,  -- 'date' | 'rating' | 'random' | 'top_month'
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS plsc_cat_at_idx ON playlist_sort_choices(category, created_at);

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

  // Eugene 2026-05-20 Босс «архив сохранять тарифов с датами + админ меняет
  // стоимость с текущей даты». История изменений цен — каждое изменение =
  // новая запись. Текущая цена = последняя WHERE effective_from <= now.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tariff_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type TEXT NOT NULL,
      price_kopecks INTEGER NOT NULL,
      effective_from TEXT NOT NULL,
      set_by_user_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS tariff_history_type_idx ON tariff_history(service_type, effective_from DESC);
  `);

  // Seed initial tariffs если table пустая (для согласованности с PRICES в routes.ts).
  const tariffCount = sqlite.prepare("SELECT COUNT(*) as cnt FROM tariff_history").get() as { cnt: number };
  if (tariffCount.cnt === 0) {
    const seedAt = "2025-01-01 00:00:00";
    sqlite.prepare("INSERT INTO tariff_history (service_type, price_kopecks, effective_from, notes, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run("music", 39900, seedAt, "Seed: trace 399 ₽ default");
    sqlite.prepare("INSERT INTO tariff_history (service_type, price_kopecks, effective_from, notes, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run("lyrics", 9900, seedAt, "Seed: lyrics 99 ₽ default");
    sqlite.prepare("INSERT INTO tariff_history (service_type, price_kopecks, effective_from, notes, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run("cover", 9900, seedAt, "Seed: cover 99 ₽ default");
    sqlite.prepare("INSERT INTO tariff_history (service_type, price_kopecks, effective_from, notes, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run("audio_cover", 39900, seedAt, "Seed: audio-cover 399 ₽ default");
  }

  // Migration: добавить profile_url колонку если не существует (для existing БД).
  try {
    const hasUrlCol = sqlite.prepare("PRAGMA table_info(star_suggestions)").all().some((c: any) => c.name === "profile_url");
    if (!hasUrlCol) {
      sqlite.exec("ALTER TABLE star_suggestions ADD COLUMN profile_url TEXT");
    }
  } catch {}

  // Eugene 2026-05-21 Босс: «Leonardo DiCaprio» (правильное написание, не Leo Di Caprio).
  // Seed star — главная номинация для маячка после 1 000 000 prosлушиваний.
  const starCount = sqlite.prepare("SELECT COUNT(*) as cnt FROM star_suggestions").get() as { cnt: number };
  if (starCount.cnt === 0) {
    sqlite.prepare("INSERT INTO star_suggestions (name_normalized, name_display, profile_url, votes) VALUES (?, ?, ?, ?)")
      .run("leonardo dicaprio", "Leonardo DiCaprio", "https://www.instagram.com/leonardodicaprio", 1);
  } else {
    // Existing БД — обновить старый seed «Leo Di Caprio» → «Leonardo DiCaprio»
    sqlite.prepare("UPDATE star_suggestions SET name_normalized = ?, name_display = ?, profile_url = ? WHERE name_normalized = ?")
      .run("leonardo dicaprio", "Leonardo DiCaprio", "https://www.instagram.com/leonardodicaprio", "leo di caprio");
    // Гарантия profile_url для уже «leonardo dicaprio» row если URL пуст
    sqlite.prepare("UPDATE star_suggestions SET profile_url = ? WHERE name_normalized = ? AND (profile_url IS NULL OR profile_url = '')")
      .run("https://www.instagram.com/leonardodicaprio", "leonardo dicaprio");
  }

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

    -- Eugene 2026-05-17 Босс «максимальная защита admin panel — email 2FA».
    -- Очередь pending admin-actions требующих подтверждения по email.
    -- См. docs/strategy/ADMIN-SECURITY-AUDIT-170526.md.
    CREATE TABLE IF NOT EXISTS admin_pending_actions (
      id TEXT PRIMARY KEY,
      admin_user_id INTEGER NOT NULL,
      admin_email TEXT NOT NULL,
      action TEXT NOT NULL,
      args_json TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      ip TEXT,
      user_agent TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      confirmed_at TEXT,
      used_at TEXT,
      result_text TEXT
    );
    CREATE INDEX IF NOT EXISTS admin_pending_actions_admin_idx ON admin_pending_actions(admin_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_pending_actions_status_idx ON admin_pending_actions(status, expires_at);
  `);

  // Admin 2FA login codes (Eugene 2026-05-17 Босс) — Level 1 защиты.
  // После успешной первичной аутентификации админа (email+password ИЛИ
  // phone callcheck) НЕ выдаём session token напрямую. Создаём 6-значный
  // код, шлём админу на email, возвращаем sessionDraftId. Юзер вводит код
  // → /api/auth/admin-verify-code → token.
  //
  // Поля:
  //   - code_hash      sha256 от plain-кода (никогда не храним plain).
  //   - session_draft_id  UUID — внешний идентификатор для фронта.
  //   - channel        как именно прошла первичная аутентификация.
  //   - attempts       до 3, потом блок (статус expired).
  //   - expires_at     ISO, 10 минут от created_at.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS admin_login_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      session_draft_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS admin_login_codes_user_status_idx ON admin_login_codes(user_id, status);
    CREATE INDEX IF NOT EXISTS admin_login_codes_expires_idx ON admin_login_codes(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS admin_login_codes_draft_idx ON admin_login_codes(session_draft_id);
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
  // Eugene 2026-05-16: scheduled_delete_at для errored треков (см. CLAUDE.md
  // правило scheduled-delete-on-error). Cron в admin-overview каждый час
  // переводит просроченные в soft-delete.
  if (!gcn.includes("scheduled_delete_at")) sqlite.exec("ALTER TABLE generations ADD COLUMN scheduled_delete_at TEXT");
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
  // Eugene 2026-05-17 Босс «публикация — другое событие, не дата генерации».
  // published_at выставляется при переходе is_public с 0 на >=1. NULL для
  // черновиков. Backfill ниже: для существующих public-треков ставим
  // published_at = created_at (известна только дата генерации; better than null).
  if (!gcn.includes("published_at")) {
    sqlite.exec("ALTER TABLE generations ADD COLUMN published_at TEXT");
    sqlite.exec("UPDATE generations SET published_at = created_at WHERE published_at IS NULL AND is_public >= 1");
  }

  // gen_activity: геолокация IP
  const gaCols = sqlite.prepare("PRAGMA table_info(gen_activity)").all() as { name: string }[];
  const gan = gaCols.map(c => c.name);
  if (!gan.includes("city")) sqlite.exec("ALTER TABLE gen_activity ADD COLUMN city TEXT");
  if (!gan.includes("region")) sqlite.exec("ALTER TABLE gen_activity ADD COLUMN region TEXT");
  if (!gan.includes("country")) sqlite.exec("ALTER TABLE gen_activity ADD COLUMN country TEXT");
  if (!gan.includes("country_code")) sqlite.exec("ALTER TABLE gen_activity ADD COLUMN country_code TEXT");
  // Eugene 2026-05-17 Босс: per-domain трекинг (muzaai.ru / muziai.ru /
  // podaripesnu.ru / other). Старые записи — NULL → bucket "other".
  if (!gan.includes("host")) sqlite.exec("ALTER TABLE gen_activity ADD COLUMN host TEXT");
  sqlite.exec("CREATE INDEX IF NOT EXISTS gen_activity_host_date ON gen_activity(host, created_at DESC)");

  // visitors: country_code + host
  const vCols = sqlite.prepare("PRAGMA table_info(visitors)").all() as { name: string }[];
  const vn = vCols.map(c => c.name);
  if (!vn.includes("country_code")) sqlite.exec("ALTER TABLE visitors ADD COLUMN country_code TEXT");
  // Eugene 2026-05-17 Босс: per-domain трекинг.
  if (!vn.includes("host")) sqlite.exec("ALTER TABLE visitors ADD COLUMN host TEXT");
  sqlite.exec("CREATE INDEX IF NOT EXISTS visitors_host_date ON visitors(host, last_visit DESC)");
  // Eugene 2026-05-24 Босс «Czechia 1 уник + 1887 visits = bot fraud».
  // is_bot flag — read-side aggregates исключают bot rows, запись остаётся
  // для аудита/блокировок. См. lib/botDetect.ts.
  if (!vn.includes("is_bot")) sqlite.exec("ALTER TABLE visitors ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0");
  if (!vn.includes("bot_reason")) sqlite.exec("ALTER TABLE visitors ADD COLUMN bot_reason TEXT");
  sqlite.exec("CREATE INDEX IF NOT EXISTS visitors_is_bot ON visitors(is_bot, last_visit DESC)");

  // admin_audit_log: enriched columns для Eugene 2026-05-17 «email 2FA tracking».
  // via_email_confirm=1 — действие было подтверждено через email-OTP code.
  // ip / user_agent — кто конкретно и откуда выполнил admin-action.
  // pending_action_id — FK на admin_pending_actions.id (UUID), даёт связь
  // audit-entry ↔ pending-action.
  try {
    const auditCols = sqlite.prepare("PRAGMA table_info(admin_audit_log)").all() as { name: string }[];
    const acn = auditCols.map(c => c.name);
    if (!acn.includes("via_email_confirm")) sqlite.exec("ALTER TABLE admin_audit_log ADD COLUMN via_email_confirm INTEGER NOT NULL DEFAULT 0");
    if (!acn.includes("ip")) sqlite.exec("ALTER TABLE admin_audit_log ADD COLUMN ip TEXT");
    if (!acn.includes("user_agent")) sqlite.exec("ALTER TABLE admin_audit_log ADD COLUMN user_agent TEXT");
    if (!acn.includes("pending_action_id")) sqlite.exec("ALTER TABLE admin_audit_log ADD COLUMN pending_action_id TEXT");
  } catch (e) {
    console.warn("[BOOTSTRAP] admin_audit_log ALTER warn:", (e as Error).message);
  }

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

    -- Eugene 2026-05-20 Босс «Сообщения аудио в чате для админа (будет
    -- premium подписка) выдадим авторам кто подпишется». Премиум-фича —
    -- голосовые сообщения админа в Музa-чате. Изначально для админа +
    -- premium-подписчиков. Audio URL ссылается на authors/voice-msg/<sha>.mp3
    -- (загружается через /api/audio-uploads с pii-flag = voice_msg).
    -- Доступ к воспроизведению gate'ом через premium_subscriptions.status='active'.
    CREATE TABLE IF NOT EXISTS premium_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tier TEXT NOT NULL DEFAULT 'voice_messages',  -- 'voice_messages' | 'pro' | ...
      status TEXT NOT NULL DEFAULT 'pending',       -- 'pending' | 'active' | 'expired' | 'cancelled'
      started_at TEXT,
      expires_at TEXT,
      invoice_id INTEGER,                           -- → invoices.id (Robokassa init id)
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS premium_subscriptions_user_idx ON premium_subscriptions(user_id, status);
    CREATE INDEX IF NOT EXISTS premium_subscriptions_status_idx ON premium_subscriptions(status, expires_at);

    -- Eugene 2026-05-20 Босс «счёт можно тоже в нём выписывать». Реестр
    -- выписанных счетов от Музы. Это НЕ платёж — это invoice (proforma)
    -- с готовой Robokassa init-ссылкой. Юзер кликает → переходит на
    -- Robokassa → платит → robokassa-callback переводит status в 'paid'.
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      issued_by TEXT NOT NULL DEFAULT 'muza',       -- 'muza' | 'admin' | 'system'
      amount_rub INTEGER NOT NULL,
      description TEXT NOT NULL,
      tariff_key TEXT,                              -- 'track_399' | 'premium_voice_msg' | ...
      status TEXT NOT NULL DEFAULT 'issued',        -- 'issued' | 'paid' | 'cancelled' | 'expired'
      robokassa_payment_url TEXT,                   -- готовая ссылка для оплаты
      robokassa_inv_id TEXT,                        -- уникальный ID операции Robokassa
      paid_at TEXT,
      expires_at TEXT,
      meta TEXT,                                    -- JSON {chat_session_id, applied_to:...}
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS invoices_user_idx ON invoices(user_id, status);
    CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices(status, created_at DESC);

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

    -- Eugene 2026-05-24 Босс: gen-lifecycle agent log.
    -- Каждое событие лайф-цикла generation пишется сюда. Источник для admin UI
    -- «🚨 Ошибки генерации» (gen-errors-tab.tsx). См. lib/genLifecycleAgent.ts.
    CREATE TABLE IF NOT EXISTS gen_lifecycle_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gen_id INTEGER NOT NULL,
      user_id INTEGER,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gen_lifecycle_gen ON gen_lifecycle_log(gen_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gen_lifecycle_event_time ON gen_lifecycle_log(event_type, created_at DESC);

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
    -- Eugene 2026-05-20: resolved_at + resolved_note для mark-as-handled.
    -- Раньше таблица была append-only — Босс не мог отметить «разобрался».

    -- Eugene 2026-05-17 Босс «Ярс — это я, расширь логирование + Telegram alert».
    -- Каждое упоминание «Ярс»/«yars» (word-boundary) в любом канале (telegram,
    -- max, web) фиксируется в этой таблице для admin-просмотра.
    CREATE TABLE IF NOT EXISTS yars_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id INTEGER,
      channel TEXT NOT NULL,             -- 'web' | 'telegram' | 'max'
      text TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS yars_mentions_recent_idx ON yars_mentions(created_at DESC);
    CREATE INDEX IF NOT EXISTS yars_mentions_session_idx ON yars_mentions(session_id, created_at DESC);

    -- Eugene 2026-05-20 Босс «Веди базу сообщений админа в боте Муза».
    -- Запись каждого admin-сообщения в Музa-канал. Gate: role admin|super_admin
    -- + ip ∈ ADMIN_TRUSTED_IPS → авто-применение через yarsExecutor.
    CREATE TABLE IF NOT EXISTS admin_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id INTEGER,
      channel TEXT NOT NULL,                 -- 'web' | 'inject' | 'telegram' | 'max'
      text TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      role TEXT,                             -- 'admin' | 'super_admin' | 'user' | null
      authorized INTEGER NOT NULL DEFAULT 0, -- 1 если оба критерия выполнены
      authorization_mismatch TEXT,           -- точный reason если authorized=0
      applied INTEGER NOT NULL DEFAULT 0,    -- 1 если executor выполнил safe-команду
      applied_action TEXT,                   -- JSON {category, applied, artifactId} | {ok:false, error}
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS admin_chat_messages_recent_idx ON admin_chat_messages(created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_chat_messages_user_idx ON admin_chat_messages(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_chat_messages_authorized_idx ON admin_chat_messages(authorized, created_at DESC);

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

    -- Eugene 2026-05-17 Босс «карта пути юзера + smart Муза-триггер».
    -- Карта всех действий юзера от захода до выхода: page_view, click,
    -- scroll_percent, idle_30s, form_focus, form_abandon, leave.
    -- sessionKey — uuid в localStorage, живёт между визитами.
    -- userId nullable (гости тоже трекаются для анализа конверсии).
    -- /admin/* страницы НЕ пишем (privacy + шум).
    CREATE TABLE IF NOT EXISTS user_journey_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      user_id INTEGER,
      event_type TEXT NOT NULL,
      page TEXT NOT NULL,
      meta TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_journey_session_idx ON user_journey_events(session_key, created_at);
    CREATE INDEX IF NOT EXISTS user_journey_user_idx ON user_journey_events(user_id, created_at);
    CREATE INDEX IF NOT EXISTS user_journey_page_idx ON user_journey_events(page, created_at);
    -- Eugene 2026-05-17 Босс: per-domain трекинг — индекс используется
    -- master-dashboard / brain-export для byDomain breakdown.
    CREATE INDEX IF NOT EXISTS user_journey_host_idx ON user_journey_events(host, created_at);

    -- Eugene 2026-05-17 Босс «воронки конверсии». Ежедневный snapshot
    -- /api/admin/v304/funnels — позволяет строить тренд за N дней без
    -- пересчёта тяжёлых SQL'ов. Заполняется cron'ом admin-overview в 03:00 MSK.
    -- date — YYYY-MM-DD в MSK; funnel_id — ключ из FUNNELS;
    -- steps_json — массив {id,label,count,conversionFromPrev}.
    CREATE TABLE IF NOT EXISTS funnel_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      funnel_id TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      total_conversion REAL,
      top_dropoff_step TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS funnel_snapshots_uniq ON funnel_snapshots(date, funnel_id);
    CREATE INDEX IF NOT EXISTS funnel_snapshots_funnel_idx ON funnel_snapshots(funnel_id, date);

    -- Eugene 2026-05-17 Босс «Cookies надо собирать и привязывать к профилю
    -- автора только у админа доступ». Union таблица: один row на visitor
    -- (анонимный) или один row на authed-user. Линкуется к users.id когда
    -- visitor становится authed. cookieData — JSON {utm_*, referrer, devices[]}.
    -- Доступ — только админ через requireAdmin guard в plugins/user-profiles.
    CREATE TABLE IF NOT EXISTS user_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,                    -- nullable (anonymous visitors)
      visitor_id TEXT NOT NULL,           -- mzv cookie fingerprint
      cookie_data TEXT,                   -- JSON
      ip TEXT,
      ip_country TEXT,
      ip_city TEXT,
      ip_region TEXT,
      ip_asn TEXT,
      user_agent TEXT,
      device TEXT,
      browser TEXT,
      os TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      visit_count INTEGER NOT NULL DEFAULT 1,
      is_existing_author INTEGER DEFAULT 0,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_visitor_idx ON user_profiles(visitor_id);
    CREATE INDEX IF NOT EXISTS user_profiles_user_idx ON user_profiles(user_id);
    CREATE INDEX IF NOT EXISTS user_profiles_last_seen_idx ON user_profiles(last_seen DESC);
    CREATE INDEX IF NOT EXISTS user_profiles_country_seen_idx ON user_profiles(ip_country, last_seen);
  `);

  // Eugene 2026-05-17 Босс: per-domain трекинг — host колонка для
  // user_journey_events на существующих БД (новые создаются с host из
  // CREATE TABLE выше — но для уже накатанных нужен ALTER).
  try {
    const ujCols = sqlite.prepare("PRAGMA table_info(user_journey_events)").all() as { name: string }[];
    const ujn = ujCols.map(c => c.name);
    if (!ujn.includes("host")) {
      sqlite.exec("ALTER TABLE user_journey_events ADD COLUMN host TEXT");
      sqlite.exec("CREATE INDEX IF NOT EXISTS user_journey_host_idx ON user_journey_events(host, created_at)");
    }
  } catch (e) {
    console.warn("[BOOTSTRAP] user_journey_events host ALTER warn:", (e as Error).message);
  }

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
    // Eugene 2026-05-17 Босс: per-domain трекинг (muzaai.ru / muziai.ru /
    // podaripesnu.ru / other). Заполняется через extractHost(req) при
    // создании web-сессии. Для telegram/max-bot сессий — NULL.
    if (!has("host")) sqlite.exec("ALTER TABLE chatbot_sessions ADD COLUMN host TEXT");
    // Eugene 2026-05-17 Босс «архив + текущие диалоги»: индекс под
    // ORDER BY last_message_at DESC + фильтры по channel/last_message_at
    // (admin GET /api/admin/v304/conversations). Composite (channel,
    // last_message_at DESC) покрывает оба самых частых запроса:
    // «все каналы по свежести» и «один канал по свежести».
    sqlite.exec("CREATE INDEX IF NOT EXISTS chatbot_sessions_last_message_idx ON chatbot_sessions(last_message_at DESC)");
    sqlite.exec("CREATE INDEX IF NOT EXISTS chatbot_sessions_channel_last_idx ON chatbot_sessions(channel, last_message_at DESC)");
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

  // Eugene 2026-05-17 Босс «техподдержка»: расширение agent_handoffs под
  // support-ticket flow. Per No-duplicates rule переиспользуем existing table
  // вместо создания parallel support_tickets. SQLite ADD COLUMN — idempotent
  // через try/catch (нет IF NOT EXISTS для ALTER).
  const handoffAlters = [
    `ALTER TABLE agent_handoffs ADD COLUMN user_id INTEGER`,
    `ALTER TABLE agent_handoffs ADD COLUMN channel TEXT`,
    `ALTER TABLE agent_handoffs ADD COLUMN subject TEXT`,
    `ALTER TABLE agent_handoffs ADD COLUMN priority TEXT DEFAULT 'normal'`,
    `ALTER TABLE agent_handoffs ADD COLUMN updated_at INTEGER`,
    `ALTER TABLE agent_handoffs ADD COLUMN resolved_at INTEGER`,
    `ALTER TABLE agent_handoffs ADD COLUMN meta TEXT`,
  ];
  for (const stmt of handoffAlters) {
    try { sqlite.exec(stmt); } catch { /* column exists — fine */ }
  }
  try {
    sqlite.exec(`CREATE INDEX IF NOT EXISTS agent_handoffs_user_idx ON agent_handoffs(user_id, status, created_at DESC)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS agent_handoffs_priority_idx ON agent_handoffs(priority, status)`);
  } catch (e) {
    console.error("[MIGRATION] agent_handoffs support indexes failed:", e);
  }

  // Landing news (Eugene 2026-05-12 Босс): архив + CRUD редактирование.
  // Eugene 2026-05-17 Босс: расширение под CMS — category, body_html, icon_url,
  // cta_url, cta_label, sort_order, is_visible, view_count. Все ALTER'ы
  // идемпотентные через try/catch (SQLite не поддерживает IF NOT EXISTS
  // для ADD COLUMN). published_at допускает NULL для черновиков.
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS landing_news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'main',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      body_html TEXT,
      icon_emoji TEXT,
      image_url TEXT,
      icon_url TEXT,
      cta_url TEXT,
      cta_label TEXT,
      badge_color TEXT DEFAULT 'purple',
      border_color TEXT DEFAULT 'purple',
      published_at TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      is_visible INTEGER NOT NULL DEFAULT 1,
      view_count INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    // ALTER'ы для существующих БД (созданных 2026-05-12).
    const alters = [
      `ALTER TABLE landing_news ADD COLUMN category TEXT NOT NULL DEFAULT 'main'`,
      `ALTER TABLE landing_news ADD COLUMN body_html TEXT`,
      `ALTER TABLE landing_news ADD COLUMN icon_url TEXT`,
      `ALTER TABLE landing_news ADD COLUMN cta_url TEXT`,
      `ALTER TABLE landing_news ADD COLUMN cta_label TEXT`,
      `ALTER TABLE landing_news ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE landing_news ADD COLUMN is_visible INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE landing_news ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0`,
    ];
    for (const stmt of alters) {
      try { sqlite.exec(stmt); } catch { /* колонка уже существует */ }
    }
    sqlite.exec(`CREATE INDEX IF NOT EXISTS landing_news_active_idx ON landing_news(active, position DESC)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS landing_news_cat_sort_idx ON landing_news(category, sort_order DESC, id DESC)`);
  } catch (e) {
    console.error("[MIGRATION] landing_news failed:", e);
  }

  // Eugene 2026-05-18 Босс «ручная блокировка по IP / userId / country по
  // жалобе». Таблица для anti-abuse / spam защиты — админ блокирует по
  // конкретному значению (ip/user/country/ua_substring) с опциональным TTL.
  // Записи в БД остаются после soft-unblock (active=0) для аудита.
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS blocked_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('ip', 'user', 'country', 'ua_substring')),
      value TEXT NOT NULL,
      reason TEXT,
      blocked_by INTEGER,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      active INTEGER NOT NULL DEFAULT 1
    )`);
    // Уникальный индекс на (type, value) только для активных записей —
    // history blocks остаются, но активный одновременно может быть один.
    sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS blocked_entities_active_uniq
      ON blocked_entities(type, value) WHERE active = 1`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS blocked_entities_active_idx
      ON blocked_entities(active, expires_at)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS blocked_entities_type_idx
      ON blocked_entities(type, created_at DESC)`);
  } catch (e) {
    console.error("[MIGRATION] blocked_entities failed:", e);
  }

  // Eugene 2026-05-18 Босс «Муза сохраняет готовые тексты в личном кабинете —
  // спрашивает название и сохраняет. Заменяет действия клиента, он подтверждает.
  // Не авторизован → предлагает регистрацию → сохраняет. Отказался → email.
  // Без email → код для последующего восстановления».
  //
  // 3 таблицы:
  //   - user_lyric_drafts        — сохранённые тексты юзеров (auth)
  //   - pending_anonymous_lyrics — анонимные с recovery code или email (30 days TTL)
  //   - muza_user_actions        — аудит подтверждённых действий Музы
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS user_lyric_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT DEFAULT 'musa_chat',
      chat_session_id TEXT,
      created_at INTEGER NOT NULL,
      used_in_generation_id INTEGER
    )`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_lyric_drafts_user
      ON user_lyric_drafts(user_id, created_at DESC)`);
  } catch (e) {
    console.error("[MIGRATION] user_lyric_drafts failed:", e);
  }

  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS pending_anonymous_lyrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recovery_code TEXT UNIQUE,
      email TEXT,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      chat_session_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      claimed_by_user_id INTEGER,
      claimed_at INTEGER,
      email_sent INTEGER DEFAULT 0
    )`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_pending_lyrics_recovery
      ON pending_anonymous_lyrics(recovery_code)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_pending_lyrics_email
      ON pending_anonymous_lyrics(email)`);
  } catch (e) {
    console.error("[MIGRATION] pending_anonymous_lyrics failed:", e);
  }

  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS muza_user_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      anonymous_session TEXT,
      action_type TEXT NOT NULL,
      params_json TEXT,
      confirmed INTEGER DEFAULT 0,
      confirmed_at INTEGER,
      chat_session_id TEXT,
      created_at INTEGER NOT NULL
    )`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_muza_actions_user
      ON muza_user_actions(user_id, created_at DESC)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_muza_actions_type
      ON muza_user_actions(action_type, created_at DESC)`);
  } catch (e) {
    console.error("[MIGRATION] muza_user_actions failed:", e);
  }

  // Eugene 2026-05-20 Босс «Музa держит контекст общения с юзером» —
  // User-memory-context rule. Одна строка на userId. Background-сжатие
  // после каждых 10 сообщений. См. lib/userMemory.ts.
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS user_memory (
        user_id INTEGER PRIMARY KEY,
        summary TEXT DEFAULT '',
        facts_json TEXT DEFAULT '{}',
        preferences_json TEXT DEFAULT '{}',
        last_updated_at INTEGER,
        message_count_summarized INTEGER DEFAULT 0,
        version INTEGER DEFAULT 0,
        last_cabinet_snapshot_json TEXT DEFAULT '{}'
      );
    `);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS user_memory_updated_idx
      ON user_memory(last_updated_at DESC)`);
  } catch (e) {
    console.error("[MIGRATION] user_memory failed:", e);
  }

  // Eugene 2026-05-23 Босс «Информация о Музе» — публичные разделы продукта
  // + admin CMS + file uploads. См. plugin muza-info/module.ts.
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS muza_info_sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        emoji TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        body_markdown TEXT NOT NULL DEFAULT '',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        is_published INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS muza_info_sections_pub_idx
      ON muza_info_sections(is_published, position ASC, id ASC)`);

    // Seed initial sections если таблица пустая (one-time on first boot).
    const count = sqlite.prepare(`SELECT COUNT(*) AS c FROM muza_info_sections`).get() as { c: number };
    if (count.c === 0) {
      const now = Date.now();
      const seed = [
        {
          slug: "about", emoji: "🎵", position: 10,
          title: "Что такое MuzaAi",
          body: "**MuzaAi** — платформа для создания музыки с искусственным интеллектом.\n\nЛюбая идея превращается в готовую песню за минуту. Поздравление маме на 70 лет, гимн вашей команде, романтический трек для свадьбы — MuzaAi подхватит сюжет, имена, события и сделает из них настоящую песню.\n\nАвтор — ты. Музa — помощница, которая ведёт тебя от идеи до готового трека.",
        },
        {
          slug: "how-it-works", emoji: "⚙️", position: 20,
          title: "Как работает",
          body: "Три режима генерации:\n\n- **Аудио** — наговори голосом 30-60 секунд → распознаём текст → AI пишет песню\n- **Текст · Простой** — тема + жанр → AI сочиняет полный текст и музыку\n- **Текст · Расширенный** — свой текст + выбор стиля, голоса, настроения\n\nГенерация занимает 30-90 секунд. Получаешь mp3 + обложку.",
        },
        {
          slug: "pricing", emoji: "💰", position: 30,
          title: "Сколько стоит",
          body: "- **Песня** — 399 ₽\n- **Текст песни** — 99 ₽\n- **Обложка** — 99 ₽\n\nПервым 1000 авторам — **1 трек бесплатно** (подарочный, страны РФ + СНГ).\n\nОплата через Робокассу: карты Visa/MC/МИР, СБП.",
        },
        {
          slug: "bonus-program", emoji: "🎁", position: 40,
          title: "Подарочные треки",
          body: "Первые **1000 авторов** получают **один бесплатный трек** при регистрации.\n\nДоступно для РФ и стран СНГ. Активируется автоматически в личном кабинете. Списывается до денежного баланса — деньги тратятся только когда подарок использован.",
        },
        {
          slug: "referral", emoji: "🤝", position: 50,
          title: "Реферальная программа",
          body: "Приведи друга — оба получаете бонусные треки.\n\nТвоя реферальная ссылка — в личном кабинете. Друг регистрируется по ней → ты и он получаете бонус.\n\nЧем больше друзей — тем больше треков. Без лимита.",
        },
        {
          slug: "voices", emoji: "🎤", position: 60,
          title: "Голоса",
          body: "Четыре варианта вокала:\n\n- **Женский** — мягкий, эмоциональный\n- **Мужской** — глубокий, харизматичный\n- **Дуэт** — мужской + женский в диалоге\n- **Инструментальная** — без вокала, только музыка\n\nЯзыки: русский (основной), английский, любой европейский. Стиль выбирай через жанр (поп, рок, рэп, шансон, классика и сотни других).",
        },
        {
          slug: "payment", emoji: "💳", position: 70,
          title: "Оплата и возврат",
          body: "Принимаем карты RU и СНГ (Visa, MasterCard, МИР), СБП — через Робокассу.\n\nПосле оплаты трек генерируется 30-90 секунд. Деньги списываются с баланса в кабинете.\n\nЕсли генерация не удалась по нашей вине — деньги возвращаются на баланс автоматически (refund pipeline).\n\nДля возврата средств на карту — обратись в поддержку.",
        },
        {
          slug: "muza-assistant", emoji: "🤖", position: 80,
          title: "Музa — твой помощник",
          body: "**Музa** — 25-летняя девушка-консультант. Помогает тебе пройти от идеи до готового трека.\n\nОна помнит твой контекст между сессиями: какие треки ты делал, какие жанры любишь, для кого писал. При следующем заходе встречает тебя как менеджер, который помнит клиента.\n\nДоступна 24/7 в чате на сайте и в мессенджерах.",
        },
        {
          slug: "channels", emoji: "📱", position: 90,
          title: "Каналы общения",
          body: "Музa отвечает везде:\n\n- **Web** — [muzaai.ru](https://muzaai.ru)\n- **Telegram** — [@Muziaipodari_bot](https://t.me/Muziaipodari_bot)\n- **Max-мессенджер** — поиск «MuzaAi»\n- **ВКонтакте** — сообщество MuzaAi\n\nОдин аккаунт — один разговор. Начал в Telegram, продолжил на сайте — Музa помнит контекст.",
        },
        {
          slug: "support", emoji: "📞", position: 100,
          title: "Поддержка",
          body: "Мы на связи:\n\n- Email: [hello@muziai.ru](mailto:hello@muziai.ru)\n- Чат с Музой — кнопка в правом нижнем углу 24/7\n- Telegram-бот — [@Muziaipodari_bot](https://t.me/Muziaipodari_bot)\n\nОтвечаем в течение часа в рабочее время (10:00-22:00 МСК), в остальное — в течение суток.",
        },
      ];
      const stmt = sqlite.prepare(`
        INSERT INTO muza_info_sections (slug, title, emoji, position, body_markdown, attachments_json, is_published, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '[]', 1, ?, ?)
      `);
      for (const s of seed) {
        try { stmt.run(s.slug, s.title, s.emoji, s.position, s.body, now, now); }
        catch { /* idempotent — slug может уже существовать */ }
      }
      console.log(`[MIGRATION] muza_info_sections: seeded ${seed.length} initial sections`);
    }
  } catch (e) {
    console.error("[MIGRATION] muza_info_sections failed:", e);
  }

  // Eugene 2026-05-23 Босс «интерактивный дизайн писем от Музы».
  // email_send_log — лог каждой отправки email (template, recipient, status,
  // provider, errors). Источник для admin UI «✉️ Письма Музы» — preview,
  // статистика, last 100 sends с фильтром по template / status.
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS email_send_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        template TEXT NOT NULL,
        to_email TEXT NOT NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        error TEXT,
        provider TEXT,
        message_id TEXT,
        sent_at INTEGER NOT NULL
      );
    `);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_email_send_log_sent_at ON email_send_log(sent_at DESC)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_email_send_log_template ON email_send_log(template, sent_at DESC)`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_email_send_log_user ON email_send_log(user_id, sent_at DESC)`);
  } catch (e) {
    console.error("[MIGRATION] email_send_log failed:", e);
  }
} catch (e) {
  console.error("[MIGRATION] Error:", e);
}

export const db = drizzle(sqlite);

// Raw sqlite handle для динамических read-only запросов (funnels, brain-export
// и подобных мест где SQL собирается из конфигурации в runtime). Использовать
// только с read-only SQL — модификации идут через drizzle/storage API.
export const sqliteDb = sqlite;

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
    // Eugene 2026-05-17 Босс «публикация ≠ генерация». При создании трека
    // сразу public (isPublic>=1) — publishedAt = now (это первая публикация,
    // одновременно с генерацией). Для черновиков (isPublic=0) — NULL,
    // выставится при будущем publish.
    const isPub = data.isPublic ?? 1;
    const publishedAt = isPub >= 1 ? new Date().toISOString() : null;
    return db.insert(generations).values({
      userId: data.userId,
      type: data.type,
      prompt: data.prompt,
      style: data.style || null,
      cost: data.cost || 9900,
      isPublic: isPub,
      authorName: data.authorName || null,
      taskId: data.taskId || null,
      status: data.status || "pending",
      publishedAt,
    } as any).returning().get();
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
