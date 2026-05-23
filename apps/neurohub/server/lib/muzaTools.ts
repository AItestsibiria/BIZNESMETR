// Eugene 2026-05-14 Босс: Advanced AI agent для Музы — Tool Use (function
// calling) через Anthropic API. Муза сама решает когда вызвать tool,
// анализирует ответ, продолжает диалог.
//
// Каждый tool: name + description + input_schema (JSON-schema) + handler.

import { db, storage, sqliteDb } from "../storage";
import { users, generations, transactions, songDrafts, agentHandoffs, payments, incidents } from "@shared/schema";
import { eq, and, desc, sql, isNotNull, or, like } from "drizzle-orm";
import { PUBLIC_URL } from "./publicUrl";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { kbPath, loadKB } from "./consultantPersona";
import { recordAuditEntry } from "./adminAuditLog";
import {
  initiateAction,
  getConfirmedAction,
  markActionUsed,
  type ProtectedAction,
} from "./adminTwoFactor";

export type ToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
};

export type ToolContext = {
  userId: number | null;
  // Eugene 2026-05-16: для request_human_handoff с reason='owner_inquiry'
  // нужны sessionId/channel — чтобы Telegram-alert вёл админа в нужный диалог.
  sessionId?: string | null;
  channel?: string | null;
  // Eugene 2026-05-17 Босс «голос Музе в admin panel».
  // Передаём роль исполнителя tool'а — admin-only tools пропускаются только
  // при role === 'admin' (см. requireAdminCtx ниже). Для обычных каналов
  // (web/telegram/max) role остаётся undefined → admin-tools будут отказаны.
  role?: string | null;
};

export type ToolHandler = (input: any, context: ToolContext) => Promise<string>;

const fmt = (n: number) => n.toLocaleString("ru-RU");

// Eugene 2026-05-18 Босс «Муза сохраняет тексты — UI часть». Когда
// save_user_lyrics вернул needsAuth=true (анонимный юзер), запоминаем
// title/text по sessionId — чтобы следующий шаг (propose_registration или
// inline-карточка email-save на фронте) мог их использовать без передачи
// через LLM-маркер.
// TTL 30 мин, max 200 записей (защита от memory-leak).
type PendingLyrics = { title: string; text: string; createdAt: number };
const PENDING_LYRICS_TTL_MS = 30 * 60 * 1000;
const PENDING_LYRICS_MAX = 200;
const pendingLyricsBySession = new Map<string, PendingLyrics>();

function gcPendingLyrics() {
  const now = Date.now();
  const stale: string[] = [];
  pendingLyricsBySession.forEach((pl, sid) => {
    if (now - pl.createdAt > PENDING_LYRICS_TTL_MS) stale.push(sid);
  });
  stale.forEach((sid) => pendingLyricsBySession.delete(sid));
  // Hard cap
  if (pendingLyricsBySession.size > PENDING_LYRICS_MAX) {
    const sorted = Array.from(pendingLyricsBySession.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toDrop = sorted.slice(0, pendingLyricsBySession.size - PENDING_LYRICS_MAX);
    toDrop.forEach(([sid]) => pendingLyricsBySession.delete(sid));
  }
}

export function getPendingLyricsForSession(sessionId: string | null | undefined): PendingLyrics | null {
  if (!sessionId) return null;
  gcPendingLyrics();
  const pl = pendingLyricsBySession.get(sessionId);
  if (!pl) return null;
  if (Date.now() - pl.createdAt > PENDING_LYRICS_TTL_MS) {
    pendingLyricsBySession.delete(sessionId);
    return null;
  }
  return pl;
}

function setPendingLyricsForSession(sessionId: string | null | undefined, title: string, text: string) {
  if (!sessionId) return;
  pendingLyricsBySession.set(sessionId, { title, text, createdAt: Date.now() });
  gcPendingLyrics();
}

// === TOOL DEFINITIONS (passed to Claude) ===

export const MUZA_TOOLS: ToolDef[] = [
  {
    name: "get_user_tracks",
    description: "ПРИОРИТЕТ! Используй ЭТО когда юзер просит свои треки: «покажи мои треки», «мои песни», «что я создавал», «моя история», «список треков», «show my tracks». БЕЗ предварительных вопросов «какой повод» — сразу tool. БЕЗ параметров — берёт userId из контекста сессии. Если userId не известен (юзер не залогинен) — вернёт «не залогинен».",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_user_balance",
    description: "ПРИОРИТЕТ! Используй когда юзер спрашивает «сколько у меня денег», «мой баланс», «есть ли бесплатный трек», «сколько подарочных треков», «сколько у меня треков осталось». БЕЗ параметров — сразу tool.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_pricing",
    description: "Получить актуальные цены: music (трек), cover (обложка), lyrics (текст). Используй когда юзер спрашивает «сколько стоит».",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "find_similar_tracks",
    description: "Найти похожие опубликованные треки по теме/жанру/настроению. Используй когда юзер просит примеры. query — короткий поиск (3-5 слов).",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Тема/жанр для поиска" } },
      required: ["query"],
    },
  },
  {
    name: "check_generation_status",
    description: "Проверить статус конкретной генерации юзера. Используй если юзер спрашивает «где мой трек» / «когда будет готов». genId — идентификатор генерации.",
    input_schema: {
      type: "object",
      properties: { genId: { type: "number", description: "ID генерации" } },
      required: ["genId"],
    },
  },
  {
    name: "escalate_to_human",
    description: "Эскалировать вопрос на человека (техподдержка / коммерческий / пресс). Используй ТОЛЬКО если ты не можешь ответить ИЛИ это явно НЕ твоя зона (платежи, баги, юр.вопросы).",
    input_schema: {
      type: "object",
      properties: {
        team: { type: "string", enum: ["support", "commercial", "press"] },
        reason: { type: "string", description: "Краткое описание для админа" },
      },
      required: ["team", "reason"],
    },
  },
  {
    name: "force_close_stuck_generation",
    description: "Если у юзера генерация ЕГО трека висит в processing > 30 мин — force-close её и вернуть баланс. Используй ТОЛЬКО когда юзер жалуется «трек висит / зависла / не работает». Только для треков юзера, проверяется userId. genId — ID конкретной генерации.",
    input_schema: {
      type: "object",
      properties: { genId: { type: "number", description: "ID зависшей генерации" } },
      required: ["genId"],
    },
  },
  {
    name: "get_user_stuck_generations",
    description: "Получить ВСЕ зависшие (processing > 15 мин) генерации текущего юзера. Используй когда юзер не указал конкретный genId, а просто «у меня всё зависло». Без параметров.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "check_recent_payments",
    description: "ПРИОРИТЕТ! Используй когда юзер просит историю платежей: «мои покупки», «история платежей», «что я оплачивал», «мои оплаты», «жалуется на оплату» / «списание» / «двойной заряд». Возвращает последние 5 транзакций (top-ups + списания). БЕЗ предварительных вопросов — сразу tool.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "save_song_draft",
    description: "СОХРАНИТЬ черновик песни в кабинет автора (если auth). КЛЮЧЕВОЙ tool — главная миссия Музы: довести до генерации, ЕСЛИ НЕ ПОЛУЧИЛОСЬ — хотя бы сохранить черновик чтобы юзер вернулся. Используй когда: 1) собрал текст/идею в диалоге → сохрани перед предложением /music. 2) юзер собирается уходить — спроси можно ли сохранить. Требуется auth.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Название черновика, 1-80 chars (повод + кому)" },
        prompt: { type: "string", description: "Краткая идея/тема (для basic mode)" },
        lyrics: { type: "string", description: "Готовый текст песни если есть (опц.)" },
        style: { type: "string", description: "Стиль/жанр (опц.): Поп / Рок / Баллада / Lo-Fi / etc." },
        voice: { type: "string", description: "Голос: female / male / duet / instrumental (опц.)" },
        mood: { type: "string", description: "Настроение: warm / energetic / sad / romantic (опц.)" },
      },
      required: ["title", "prompt"],
    },
  },

  // === Agent upgrade (Eugene 2026-05-16): 7 недостающих tools ===
  {
    name: "get_user_profile",
    description: "ПРИОРИТЕТ! Используй когда юзер просит свой профиль / данные: «мой профиль», «мои данные», «кто я», «show my profile», «что у меня в кабинете». Возвращает: displayName, email (МАСКИРОВАННЫЙ), tariff, credits, memberSince. БЕЗ предварительных вопросов — сразу tool.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_user_tariff",
    description: "Тариф юзера: name, credits, freeTracksLeft. Используй когда юзер спрашивает «какой у меня тариф / сколько подарочных треков / лимиты».",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_project_knowledge",
    description: "Поиск по базе знаний проекта (KNOWLEDGE-BASE-BOT.md): цены, режимы, шаблоны, голоса, реферальная программа. Простой substring/keyword match — БЕЗ embeddings. Используй для фактических вопросов «как работает X / есть ли Y».",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Поисковый запрос (2-6 слов)" } },
      required: ["query"],
    },
  },
  {
    name: "get_track_brief_draft",
    description: "Получить последний черновик (brief) юзера из таблицы song_drafts. Используй чтобы напомнить юзеру «вы начинали — продолжим?» или собрать недостающие поля для генерации.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "suggest_next_prompt_step",
    description: "Детерминированный helper (БЕЗ LLM): по briefId возвращает {missingFields, nextQuestion}. Проверяет какие поля ещё не заполнены (title/mood/genre/voice/lyrics_theme/structure) и подсказывает что спросить дальше.",
    input_schema: {
      type: "object",
      properties: { briefId: { type: "number", description: "ID черновика (song_drafts.id)" } },
      required: ["briefId"],
    },
  },
  {
    name: "start_track_generation_from_brief",
    description: "Запустить генерацию трека из черновика. Если confirmed=false → возвращает {requiresConfirmation, summary}. Если confirmed=true → создаёт generation через storage.createGeneration. ВСЕГДА сначала вызывай с confirmed=false, покажи summary юзеру, только после явного «да» — confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        briefId: { type: "number", description: "ID черновика (song_drafts.id)" },
        confirmed: { type: "boolean", description: "true только после явного подтверждения юзера" },
      },
      required: ["briefId", "confirmed"],
    },
  },
  {
    name: "request_human_handoff",
    description: "Эскалация на живого оператора (создаёт запись в agent_handoffs со статусом open). Используй когда: юзер просит человека / низкая уверенность в ответе / конфликт данных / опасное действие (delete) / юзер задаёт вопросы про основателя MuzaAi (reason='owner_inquiry') — в последнем случае Босс получит мгновенный Telegram-alert и сможет подключиться к диалогу. reason ОБЯЗАТЕЛЕН.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["user_request", "low_confidence", "data_conflict", "destructive_action", "owner_inquiry"] },
        comment: { type: "string", description: "Краткое описание ситуации для оператора (опц.)" },
      },
      required: ["reason"],
    },
  },

  // === ADMIN-ONLY tools (Eugene 2026-05-17 Босс «голос Музе в admin panel»).
  // Проверка role === 'admin' в handler — non-admin вызов вернёт error.
  // Канал admin-voice (server/plugins/voice-admin) прокидывает role в ToolContext.
  {
    name: "get_metrics",
    description: "[ADMIN-ONLY] Dashboard-метрики проекта за период. period: today | 7d | 30d. Возвращает короткую сводку: регистрации, генерации (done/error), платежи (₽), прослушивания, посетители.",
    input_schema: {
      type: "object",
      properties: { period: { type: "string", enum: ["today", "7d", "30d"], description: "Период выборки (default 7d)" } },
      required: [],
    },
  },
  {
    name: "get_failed_users",
    description: "[ADMIN-ONLY] Юзеры с failed actions за N дней (login/register/generate/payment fail). Группировка по action+error_code. Возвращает top-20 групп с count и uniqUsers.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number", description: "Количество дней (default 7)" } },
      required: [],
    },
  },
  {
    name: "reload_kb",
    description: "[ADMIN-ONLY · 2FA] Перезагрузить knowledge base (KNOWLEDGE-BASE-BOT.md) без рестарта pm2. Используй если KB обновили — бот сразу подхватит новый текст. Требует email-2FA: первый вызов вернёт requiresEmailConfirm + actionId, второй вызов с confirmedActionId после ввода кода — выполнит.",
    input_schema: {
      type: "object",
      properties: {
        confirmedActionId: { type: "string", description: "actionId pending-записи после успешного email-confirm. Опционально (без него запустится 2FA initiate)." },
      },
      required: [],
    },
  },
  {
    name: "send_telegram_alert",
    description: "[ADMIN-ONLY · 2FA] Отправить custom message админу в Telegram через бота. text — что отправить (≤ 1000 chars). Требует email-2FA.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Текст сообщения (≤1000 chars)" },
        confirmedActionId: { type: "string", description: "actionId после email-confirm. Опционально." },
      },
      required: ["text"],
    },
  },
  {
    name: "change_registration_status",
    description: "[ADMIN-ONLY · 2FA] Открыть или закрыть регистрацию (управляет process.env.REGISTRATION_DISABLED в runtime). status='open' → регистрация открыта, status='closed' → закрыта. Эффект только в текущем процессе — для постоянного эффекта нужен .env + pm2 restart. Требует email-2FA.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "closed"] },
        confirmedActionId: { type: "string", description: "actionId после email-confirm. Опционально." },
      },
      required: ["status"],
    },
  },
  {
    name: "query_users",
    description: "[ADMIN-ONLY · 2FA] Поиск юзеров по phone / email / name (substring). Возвращает top-10 матчей. Email маскируется, phone маскируется. Требует email-2FA (PII access).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring 2+ chars" },
        confirmedActionId: { type: "string", description: "actionId после email-confirm. Опционально." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_recent_payments",
    description: "[ADMIN-ONLY] Последние N платежей (status + amount + время + invId). По умолчанию 10. По умолчанию все статусы — paid/pending/failed.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Количество (1-50, default 10)" },
        status: { type: "string", enum: ["paid", "pending", "failed", "any"], description: "Фильтр по статусу (default any)" },
      },
      required: [],
    },
  },
  {
    name: "pause_bot",
    description: "[ADMIN-ONLY · 2FA] Временно приостановить обработку webhooks Telegram-бота (флаг в runtime). resume=false → bot не отвечает. resume=true → возобновить. Требует email-2FA.",
    input_schema: {
      type: "object",
      properties: {
        resume: { type: "boolean", description: "false=pause, true=resume" },
        confirmedActionId: { type: "string", description: "actionId после email-confirm. Опционально." },
      },
      required: ["resume"],
    },
  },
  {
    name: "kick_session",
    description: "[ADMIN-ONLY · 2FA] Invalidate (удалить) все session-токены конкретного юзера — выкинет его из всех устройств. userId обязателен. Требует email-2FA (force-logout).",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "number", description: "ID юзера" },
        confirmedActionId: { type: "string", description: "actionId после email-confirm. Опционально." },
      },
      required: ["userId"],
    },
  },
  {
    name: "get_recent_incidents",
    description: "[ADMIN-ONLY] Последние N инцидентов из incidents (open + auto-resolved). По умолчанию 10. Группа: severity, title, kind, occurrences.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Количество (1-50, default 10)" } },
      required: [],
    },
  },
  {
    name: "focus_brain_node",
    description: "[ADMIN-ONLY · UI] Сфокусировать камеру в 3D «Втором мозге» на указанном узле. Передаётся имя узла или его id (например 'plugin:telegram-bot', 'provider:gptunnel', 'core:db', 'Telegram', 'GPTunnel'). Поиск substring-match по label/id. Возвращает подтверждение — фронт перехватывает result через actions[] и эмитит CustomEvent 'brain-focus-node' который слушает SecondBrain3D компонент.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Имя узла или его id (например 'GPTunnel', 'telegram', 'core:db')" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_bot_channels_status",
    description: "[ADMIN-ONLY] Состояние всех каналов общения (web / telegram / max) + LLM engine (primary anthropic + fallback timeweb-gateway). Возвращает короткий текст: какой канал зелёный / жёлтый / красный с проблемами. Используй когда админ спрашивает «как каналы», «всё ли работает», «что упало» или хочет голосовое summary. Под капотом — bot-channels-health плагин.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "escalate_to_admin",
    description: "Эскалация открытого support-ticket'а на админа: ставит priority='high' и шлёт Telegram-alert админу. Используй когда: юзер просит срочно / проблема критична / ты не можешь решить вопрос в чате. ticketId обязателен (получается из создания ticket'а).",
    input_schema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "ID ticket'а (uuid из support-create)" },
        reason: { type: "string", description: "Краткая причина (≤200 chars)" },
      },
      required: ["ticketId", "reason"],
    },
  },
  {
    name: "resolve_ticket",
    description: "Закрытие support-ticket'а как resolved: ставит status='resolved' и пишет admin-резюме в чат. Используй когда: юзер сказал «спасибо/решено» / вопрос явно закрыт. ticketId обязателен.",
    input_schema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "ID ticket'а" },
        summary: { type: "string", description: "Резюме решения (≤500 chars) — пойдёт в админ-логи" },
      },
      required: ["ticketId", "summary"],
    },
  },

  // === USER-FACING player tools (Eugene 2026-05-17 Босс «голосовое управление
  // плейлистом и треками»). Доступны и admin'у и обычному юзеру.
  {
    name: "play_track",
    description: "Запустить воспроизведение трека. Если указан trackId или query — переключаем на этот трек. Если ничего не указано — продолжить (resume) текущий. Используй когда юзер говорит «играй», «включи», «плей», «воспроизведи», «продолжай», «давай слушать».",
    input_schema: {
      type: "object",
      properties: {
        trackId: { type: "number", description: "ID трека (если знаешь)" },
        query: { type: "string", description: "Поисковый запрос — название трека / автора / стиля (если юзер говорит «включи Луну»)" },
      },
      required: [],
    },
  },
  {
    name: "pause_player",
    description: "Пауза. Юзер говорит «пауза», «стоп», «остановись», «погоди».",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "next_track",
    description: "Следующий трек. «следующий», «дальше», «next», «вперёд», «другой».",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "prev_track",
    description: "Предыдущий трек. «предыдущий», «назад», «prev», «верни», «обратно».",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "set_volume",
    description: "Изменить громкость 0-100. «громче», «тише», «громкость 50», «потише», «погромче». Если «громче» — current+20, «тише» — current-20, точное значение — указанное.",
    input_schema: {
      type: "object",
      properties: {
        level: { type: "number", description: "0-100 — точное значение громкости" },
        delta: { type: "number", description: "Относительное изменение (+20 / -20)" },
      },
      required: [],
    },
  },
  {
    name: "set_repeat",
    description: "Режим повтора. «закольцуй», «повтори», «не повторяй», «играй по кругу», «один раз».",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["off", "one", "all"], description: "off=без повтора, one=повтор текущего трека, all=плейлист по кругу" },
      },
      required: ["mode"],
    },
  },
  {
    name: "find_tracks",
    description: "Найти треки по запросу — title / автор / lyrics / стиль. Используй для «найди про лето», «покажи джаз», «треки от Васи». Возвращает топ-5 с их id — Муза может затем play_track с найденным id.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Поисковый запрос (3-5 слов)" },
        limit: { type: "number", description: "1-20, default 5" },
      },
      required: ["query"],
    },
  },

  // Eugene 2026-05-20 Босс «мини-плеер в чате — Муза находит трек и сразу
  // прикрепляет к ответу». Поиск по публичным трекам (is_public=1 или 2) с
  // ranked scoring (title 100/70/40, lyrics 35/20, prompt 15). При exactCount=1
  // возвращает hint=playNow:<id> — backend парсит из tool-result и прикрепляет
  // attachedTrack к ответу /api/muza/chat. Frontend рендерит inline-карточку
  // с persistent <audio>.
  //
  // Eugene 2026-05-23 Босс «найди и запусти по попаданию букв» — substring
  // поиск по display_title (case-insensitive). Параметры:
  //   - q/query — обязательно, 2-100 символов
  //   - category — опц. фильтр (song / greeting / instrumental / all)
  //   - limit — опц., 1-10, default 5
  //   - mine_only — опц., true только для авторизованных (свои треки)
  //
  // Использовать когда юзер просит послушать / найти конкретный трек:
  //   «найди слон», «найди песню про маму», «поставь маме», «включи Луну»,
  //   «у тебя есть трек про дождь», «найди в моих маме».
  // Доступен всем (анон + клиент + админ). mine_only=true требует auth.
  {
    name: "find_public_track",
    description: "НАХОДИТ + ВКЛЮЧАЕТ трек прямо в чате по подстроке названия. Используй когда юзер: «найди X», «поставь X», «включи X», «у тебя есть трек про Y», «найди в моих маме», «давай тот где про дождь». Поиск substring case-insensitive по названию / тексту / автору. Возвращает 0-5 матчей. Если ровно 1 → трек АВТОМАТИЧЕСКИ прикрепляется к ответу и играет (просто скажи «Включаю: <название>»). Если несколько — перечисли 1/2/3, спроси какой. Если 0 — попроси переформулировать. Для авторизованных: mine_only=true ищет только в треках юзера.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Поисковая подстрока (название трека, часть текста, тема, имя автора). 2-100 символов." },
        category: { type: "string", enum: ["all", "song", "greeting", "instrumental"], description: "Опц. фильтр по категории трека. default=all" },
        limit: { type: "number", description: "Опц. лимит результатов. 1-10, default 5" },
        mine_only: { type: "boolean", description: "Опц. искать только в треках текущего юзера (нужна auth). default=false" },
      },
      required: ["query"],
    },
  },
  {
    name: "filter_playlist",
    description: "Переключить плейлист на main (одобренные) / new (новые авторы) / my (только мои). «покажи новых», «топ авторов», «мои треки в плеере».",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["main", "new", "my"], description: "main=основной плейлист (одобренные), new=новые авторы, my=мои треки" },
      },
      required: ["type"],
    },
  },
  // === Voice picker (Eugene 2026-05-17 Босс «8 голосов Yandex, можно менять
  // кликом и по команде»). Tool возвращает marker [VOICE_CHANGED:<voice>:<emotion>]
  // → frontend парсит, сохраняет в localStorage, использует в следующих
  // /voice-command-text / /voice-command request'ах через voice + emotion в body.
  // Доступен и admin, и user (UX-фича для всех).
  {
    name: "change_voice",
    description: "Сменить голос Музы для TTS. Доступны 8 голосов Yandex SpeechKit: alena (Алёна, женский тёплый, default), jane (Джейн, женский нейтральный), oksana (Оксана, женский эмоциональный), omazh (Омаж, женский медленный), zahar (Захар, мужской глубокий), ermil (Эрмиль, мужской позитивный), filipp (Филипп, мужской спокойный), madirus (Мадирус, мужской премиум, low pitch). Эмоция: neutral / good / evil (только для alena/jane/oksana/omazh). Используй когда юзер говорит «смени голос», «другим голосом», «мужским», «голос Захара», «эмоциональнее», «грубее».",
    input_schema: {
      type: "object",
      properties: {
        voice: { type: "string", enum: ["alena", "jane", "oksana", "omazh", "zahar", "ermil", "filipp", "madirus"], description: "Голос Yandex SpeechKit" },
        emotion: { type: "string", enum: ["neutral", "good", "evil"], description: "Опц., default neutral. Только для женских голосов (alena/jane/oksana/omazh)." },
      },
      required: ["voice"],
    },
  },

  // === Panel opener (Eugene 2026-05-23 Босс «99% генерации через чат —
  // вызов панелей / окна генерации»). Возвращает marker [PANEL_ACTION:<panel>]
  // → frontend (floating-consultant) парсит и навигирует через wouter setLocation.
  // Доступен всем — открыть форму не destructive. Реальная генерация дальше
  // через create_music_job / generate_lyrics с confirm_spend.
  {
    name: "open_panel",
    description: "Открыть UI-панель проекта. Используй когда юзер говорит «открой кабинет», «давай создадим трек», «покажи форму обложки», «хочу записать аудио». Опц. prefill — предзаполнение полей (для form'ов). После открытия — НЕ запускай генерацию сам, дождись подтверждения юзера.",
    input_schema: {
      type: "object",
      properties: {
        panel: {
          type: "string",
          enum: [
            "music",         // /music — форма генерации трека
            "music_audio",   // /music — режим аудио-запись
            "music_text",    // /music — режим текст
            "lyrics",        // /lyrics — форма генерации текста
            "cover",         // /covers — форма обложки
            "dashboard",     // /dashboard — личный кабинет
            "tracks",        // /tracks — мои треки
            "billing",       // /billing — оплата / пополнение баланса
            "landing",       // /  — на главную (плейлист)
          ],
          description: "Какую панель открыть",
        },
        prefill: {
          type: "object",
          description: "Опц. поля для предзаполнения формы (title, prompt, style, voice, lyrics, mood)",
          properties: {
            title: { type: "string" },
            prompt: { type: "string" },
            style: { type: "string" },
            voice: { type: "string" },
            lyrics: { type: "string" },
            mood: { type: "string" },
          },
        },
      },
      required: ["panel"],
    },
  },

  // === Save-lyrics tools (Eugene 2026-05-18 Босс) ===
  // Муза сохраняет готовые тексты в личном кабинете — спрашивает название и
  // сохраняет. Заменяет действия клиента, но он подтверждает.
  {
    name: "save_user_lyrics",
    description: "Сохранить готовый текст песни в кабинет автора. ВСЕГДА сначала получи у юзера название и явное «да». Если userId известен — сохраняет в user_lyric_drafts. Если userId=null (анонимный) — возвращает needsAuth=true → Муза должна предложить login / register / email-save / code-only через propose_registration.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Название текста, 1-120 chars (получено от юзера)" },
        text: { type: "string", description: "Текст песни, 1-8000 chars" },
      },
      required: ["title", "text"],
    },
  },
  {
    name: "save_lyrics_with_email",
    description: "Сохранить текст для анонимного юзера с email-восстановлением. Создаёт запись в pending_anonymous_lyrics (TTL 30 дней), генерирует 6-значный recovery code, шлёт email со ссылкой на регистрацию. Используй когда юзер не залогинен И дал email.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Название текста" },
        text: { type: "string", description: "Текст песни" },
        email: { type: "string", description: "Email юзера (валидный формат)" },
      },
      required: ["title", "text", "email"],
    },
  },
  {
    name: "save_lyrics_with_code_only",
    description: "Сохранить текст для анонимного юзера БЕЗ email — только с 6-значным recovery code. Используй когда юзер не залогинен и не хочет давать email. Возвращает код — Муза должна попросить юзера запомнить его (или скопировать).",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Название текста" },
        text: { type: "string", description: "Текст песни" },
      },
      required: ["title", "text"],
    },
  },
  {
    name: "list_user_lyrics",
    description: "Получить список сохранённых текстов юзера (user_lyric_drafts). Используй когда юзер спрашивает «мои тексты», «что я сохранял», «покажи черновики текстов». Требует auth — иначе вернёт «не залогинен».",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "propose_registration",
    description: "Предложить юзеру регистрацию ИЛИ оставить email для сохранения текста. Используй когда save_user_lyrics вернул needsAuth=true. reason='save_lyrics' — Муза хочет сохранить готовый текст. Возвращает marker [PROPOSE_REGISTER:reason=X] — фронт рендерит inline-карточку «Войди / Зарегистрируйся / Дай email».",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["save_lyrics", "save_draft", "view_my_tracks", "history"], description: "Причина предложения регистрации" },
      },
      required: ["reason"],
    },
  },

  // Eugene 2026-05-18 Босс «Муза знает всё, но клиентам — только продажи/ЛК/
  // генерация». classify_question — utility tool, помогает Музе быстро понять
  // относится ли вопрос юзера к разрешённой зоне. Доступен ВСЕМ ролям —
  // это classifier, не доступ к данным.
  {
    name: "classify_question",
    description: "Классифицировать вопрос юзера по зоне открытости. Используй когда сомневаешься «можно отвечать или это про код/internals?». Возвращает category + allowed + redirectTo. Если allowed=false — НЕ выдумывай ответ, передай на support email.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Текст вопроса юзера" },
      },
      required: ["question"],
    },
  },

  // Eugene 2026-05-18 Босс «администратору выдаёт всю информацию» — aggregate
  // stats юзеров (по ролям / странам / каналам регистрации). НЕ дублирует
  // query_users (тот по substring) и get_metrics (тот dashboard-сводка).
  // Тут — group-by с count uniques. ADMIN-ONLY.
  {
    name: "query_users_stats",
    description: "[ADMIN-ONLY] Агрегированная статистика по юзерам — total, по ролям (user/admin/super_admin), по регистрации (phone/email/telegram), по стране (top-10), по статусу (blocked/active). groupBy: 'role'|'channel'|'country'|'status'|'all' (default 'all'). Возвращает короткие counts. Используй когда админ спрашивает «сколько юзеров», «откуда регистрируются», «сколько админов».",
    input_schema: {
      type: "object",
      properties: {
        groupBy: { type: "string", enum: ["role", "channel", "country", "status", "all"], description: "Группировка (default all)" },
      },
      required: [],
    },
  },

  // Eugene 2026-05-18 Босс «operator-команды (Ярс) через Музу-чат».
  // Когда Ярс (по hash-auth) пишет Музе команду — она передаёт её в очередь
  // operator_command_queue через POST /api/admin/v304/operator-commands/incoming.
  // Backend сам проверяет hash через isAuthorizedOperator() — Муза просто
  // прокидывает senderIdentifier (это userId+email+phone хеш либо иной
  // signed identifier из ctx — формируется в caller'е). Результат: queued,
  // safe, category. Никогда не выполняет напрямую — только в очередь.
  {
    name: "submit_operator_command",
    description: "Передать команду Ярса (оператора) в очередь operator_command_queue для модерации админом. Используй ТОЛЬКО когда понимаешь что юзер — авторизованный оператор (Ярс) и просит сделать админ-действие (создать новость, изменить контент, и т.д.). НЕ для обычных юзеров — для них используй log_suggestion. senderIdentifier — строка идентификации оператора (передаётся backend'у который проверит hash). text — команда оператора как есть.",
    input_schema: {
      type: "object",
      properties: {
        senderIdentifier: { type: "string", description: "Идентификатор оператора (Ярс) — backend проверит hash через isAuthorizedOperator" },
        text: { type: "string", description: "Текст команды от оператора (как он её сформулировал)" },
      },
      required: ["senderIdentifier", "text"],
    },
  },

  // Eugene 2026-05-18 Босс «фидбек и идеи юзеров». Когда юзер выражает
  // предложение / идею для улучшения сервиса — Муза логирует через
  // POST /api/feedback/suggestion. Помогает накапливать клиентский фидбек
  // без обязательной регистрации (anonymous_session или userId).
  {
    name: "log_suggestion",
    description: "Залогируй предложение/идею юзера для улучшения сервиса (фичи, баги, цены, UI, persona, прочее). Используй когда юзер выразил мысль типа «было бы круто если...», «не хватает...», «можно ли добавить...», «непонятно как...», жалобу на UI/цену/работу бота. text — суть предложения (1-3 предложения). category — необязательно, если ясно. sentiment — необязательно, твоя оценка тона (-1..+1).",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Суть предложения юзера (1-3 предложения)" },
        category: { type: "string", enum: ["feature", "bug", "pricing", "ui", "persona", "other"], description: "Категория (необязательно)" },
        sentiment: { type: "number", description: "Тон от -1 (негатив) до +1 (позитив)" },
      },
      required: ["text"],
    },
  },

  // Eugene 2026-05-18 Босс «NPS — оценка Музы/сервиса от юзера».
  // Когда юзер выставил оценку (числом 1-10 или эмоционально «топ»/«норм»/
  // «средне»/«плохо») — Муза вызывает tool. Маппинг эмоций → score:
  // топ/огонь/класс = 9-10, нормально = 7-8, средне = 5-6, не очень = 1-4.
  // Score 0 — «отказался оценивать но завершил диалог», тоже валидно.
  {
    name: "log_nps",
    description: "Залогируй оценку юзером Музы/сервиса. Используй когда юзер оценил (числом 0-10 или эмоциями типа «топ», «класс», «норм», «средне», «плохо», «не очень»). Маппинг: топ/огонь/класс = 9-10, нормально/норм = 7-8, средне/так себе = 5-6, не очень/плохо = 1-4. score — обязательно (0-10). comment — необязательно, если юзер пояснил.",
    input_schema: {
      type: "object",
      properties: {
        score: { type: "number", description: "Оценка от 0 до 10" },
        comment: { type: "string", description: "Комментарий юзера (необязательно)" },
      },
      required: ["score"],
    },
  },

  // === Eugene 2026-05-20: Admin-tools для batch-resolve queue'ов
  // (рекомендация от admin-support-audit subagent'а). LLM может закрывать
  // тикеты/эскалации/идеи голосом — без копания в UI.
  {
    name: "dismiss_escalation",
    description: "[ADMIN-ONLY] Закрыть эскалацию из escalation_queue со status='dismissed' (отклонена — не считается жалобой). Используй когда юзер случайно нажал «жалоба», или когда сам разрешил вопрос с юзером. Нужны id (escalation id) и reason (короткое объяснение).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "number", description: "ID эскалации в escalation_queue" },
        reason: { type: "string", description: "Причина dismiss'а (1-200 символов)" },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "resolve_escalation",
    description: "[ADMIN-ONLY] Закрыть эскалацию из escalation_queue со status='resolved' (решена — проблема устранена). Используй когда проблема юзера действительно была и ты её решил. Нужны id и resolution (что сделал).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "number", description: "ID эскалации" },
        resolution: { type: "string", description: "Что было сделано (1-500)" },
      },
      required: ["id", "resolution"],
    },
  },
  {
    name: "mark_suggestion_reviewed",
    description: "[ADMIN-ONLY] Отметить предложение из client_suggestions как reviewed. Используй когда обдумал идею и решил что с ней делать. id — ID предложения, note — короткая заметка (что планируешь делать).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "number", description: "ID предложения в client_suggestions" },
        note: { type: "string", description: "Заметка о решении (1-500)" },
      },
      required: ["id", "note"],
    },
  },

  // === Eugene 2026-05-20: Кабинет/Плейлист — Муза управляет всем кроме
  // удалений и оплат. Auth required (userId). Каждый tool пишет audit-snapshot.
  {
    name: "rename_my_track",
    description: "Переименовать трек юзера. ТОЛЬКО auth юзер + ТОЛЬКО свои треки (по userId). genId — ID трека, newTitle — новое название (1-120 символов).",
    input_schema: {
      type: "object",
      properties: {
        genId: { type: "number", description: "ID трека" },
        newTitle: { type: "string", description: "Новое название (1-120 символов)" },
      },
      required: ["genId", "newTitle"],
    },
  },
  {
    name: "set_my_track_category",
    description: "Изменить категорию трека юзера: 'song' (песня) / 'greeting' (поздравление) / 'instrumental'. ТОЛЬКО свои треки.",
    input_schema: {
      type: "object",
      properties: {
        genId: { type: "number" },
        category: { type: "string", enum: ["song", "greeting", "instrumental"] },
      },
      required: ["genId", "category"],
    },
  },
  {
    name: "set_my_track_visibility",
    description: "Изменить видимость трека в плейлисте: 'private' (только в кабинете), 'new_authors' (на главную в раздел Новые авторы), 'main' (основной плейлист — модерация, через челофильтр). По умолчанию автор может ставить только private/new_authors; main только админ через челофильтр. ТОЛЬКО свои треки.",
    input_schema: {
      type: "object",
      properties: {
        genId: { type: "number" },
        visibility: { type: "string", enum: ["private", "new_authors"] },
      },
      required: ["genId", "visibility"],
    },
  },
  {
    name: "update_my_profile",
    description: "Обновить профиль автора. Имя/страна/promo-настройки. Phone/email/telegram-id меняются через отдельный confirm-flow (SMS-OTP / email link) — НЕ через этот tool.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Имя автора (1-80)" },
        country: { type: "string", description: "Страна (свободный ввод, нормализуется)" },
      },
      required: [],
    },
  },
  {
    name: "issue_invoice",
    description: "Выписать счёт (proforma) на оплату. Музa делает это для покупки треков, премиум-подписки. Возвращает Robokassa-payment-url. Юзер кликает → переходит на Robokassa → платит. ИСПОЛЬЗУЙ ТОЛЬКО когда юзер явно говорит «выпиши счёт» / «хочу оплатить X». tariff — 'track_399' / 'premium_voice_msg' / 'topup_<N>'. amountRub берётся из tariff'а если не указан.",
    input_schema: {
      type: "object",
      properties: {
        tariff: { type: "string", description: "Ключ тарифа: track_399 | premium_voice_msg | topup_500 | topup_1000 | custom" },
        amountRub: { type: "number", description: "Сумма ₽ (только если tariff=custom)" },
        description: { type: "string", description: "Описание счёта (1-200)" },
      },
      required: ["tariff", "description"],
    },
  },
  {
    name: "get_my_subscriptions",
    description: "Показать активные подписки автора (premium voice messages и т.д.). БЕЗ параметров — userId из контекста.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

// === Email 2FA wrapper helper (Eugene 2026-05-17 Босс) ===
//
// Используется в каждом protected admin tool:
//   const guard = await require2FA(ctx, "kick_session", input);
//   if (typeof guard === "string") return guard;
//   // ... выполнить action ...
//   markActionUsed(guard.id, "result text");
//
// Логика:
//   - Если input.confirmedActionId есть → пытаемся resolve через
//     getConfirmedAction(). Если valid → возвращаем pending запись.
//     Caller выполнит action и вызовет markActionUsed().
//   - Если confirmedActionId нет → создаём pending запись через
//     initiateAction(), шлём email, возвращаем строку с инструкцией.
//
// Returns:
//   - string — означает «требуется email confirm» (текст для Музы → юзеру)
//   - AdminPendingAction — означает «можно выполнять, code подтверждён»

import type { AdminPendingAction } from "@shared/schema";

async function require2FA(
  ctx: ToolContext,
  action: ProtectedAction,
  input: any,
): Promise<string | AdminPendingAction> {
  // (1) admin role обязателен — даже до 2FA
  if (!isAdminCtx(ctx)) return "Доступ запрещён: tool admin-only.";

  // (2) confirmedActionId передан → resolveить
  const confirmedActionId = String(input?.confirmedActionId || "").trim();
  if (confirmedActionId) {
    const userId = Number(ctx.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return "Не могу подтвердить — userId не определён в контексте.";
    }
    const pending = getConfirmedAction(confirmedActionId, userId);
    if (!pending) {
      return "Код подтверждён, но pending-запись не найдена / просрочена / уже использована. Запроси новый код.";
    }
    if (pending.action !== action) {
      return `Код подтверждён, но для другого действия (${pending.action} вместо ${action}). Запроси новый код.`;
    }
    return pending;
  }

  // (3) Нет confirmedActionId → initiate flow
  try {
    const userId = Number(ctx.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return "Не могу инициировать подтверждение — userId не определён.";
    }
    // Получаем email из БД
    const u = db.select().from(users).where(eq(users.id, userId)).get() as any;
    if (!u || !u.email) {
      return "Не могу инициировать подтверждение — email админа не найден.";
    }
    // Удаляем confirmedActionId из args для чистоты записи
    const argsClean = { ...(input || {}) };
    delete (argsClean as any).confirmedActionId;

    const result = await initiateAction({
      adminUserId: userId,
      adminEmail: String(u.email).toLowerCase(),
      action,
      args: argsClean,
    });
    // JSON-marker — admin-voice / UI парсит этот формат и показывает modal
    return JSON.stringify({
      requiresEmailConfirm: true,
      actionId: result.actionId,
      action,
      expiresAt: result.expiresAt,
      message: `Код подтверждения отправлен на email админа. Действует 10 мин. После ввода — повтори эту команду с confirmedActionId=${result.actionId}.`,
      testCode: result.plainCodeIfDisabled,
    });
  } catch (e: any) {
    return `Не удалось инициировать email-подтверждение: ${e?.message || e}`;
  }
}

// === HANDLERS (executed when Claude calls tool) ===

const HANDLERS: Record<string, ToolHandler> = {
  async get_user_tracks(_input, { userId }) {
    if (!userId) return "Юзер не залогинен. Предложи зарегистрироваться.";
    try {
      const u = db.select().from(users).where(eq(users.id, userId)).get();
      if (!u) return "Юзер не найден.";
      const gens = db.select().from(generations)
        .where(and(eq(generations.userId, userId), eq(generations.type, "music"), eq(generations.status, "done")))
        .orderBy(desc(generations.id))
        .limit(20)
        .all();
      if (gens.length === 0) return `Имя: ${u.name}. Треков пока нет.`;
      const scored = gens.map((g: any) => {
        let plays = 0;
        try { plays = JSON.parse(g.style || "{}").plays || 0; } catch {}
        return { id: g.id, title: g.displayTitle || (g.prompt || "").slice(0, 50), plays, isPublic: g.isPublic };
      }).sort((a, b) => b.plays - a.plays);
      const top5 = scored.slice(0, 5);
      const total = scored.reduce((s, t) => s + t.plays, 0);
      const lines = top5.map((t, i) => `${["🥇","🥈","🥉","4.","5."][i]} «${t.title}» — ${t.plays} прослушиваний${t.isPublic === 1 ? " (в эфире)" : ""}`);
      return `Имя: ${u.name}. Треков: ${gens.length}, всего прослушиваний: ${total}.\nТоп:\n${lines.join("\n")}`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async get_user_balance(_input, { userId }) {
    if (!userId) return "Юзер не залогинен.";
    try {
      const u = db.select().from(users).where(eq(users.id, userId)).get();
      if (!u) return "Юзер не найден.";
      const rub = Math.floor((u.balance || 0) / 100);
      const bonus = (u as any).bonusTracks || 0;
      return `Баланс: ${rub} ₽${bonus > 0 ? ` + ${bonus} подарочн. треков (бесплатно)` : ""}.`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async get_pricing() {
    return "Текущие цены: песня (music) — 399 ₽, обложка (cover) — 99 ₽, текст (lyrics) — 49 ₽. Подарочный трек: первые 1000 авторов из РФ/СНГ — бесплатно.";
  },

  async find_similar_tracks({ query }) {
    try {
      const q = String(query || "").trim().toLowerCase();
      if (!q) return "Пустой запрос.";
      const rows = (db as any).$client.prepare(`
        SELECT id, display_title, author_name, style FROM generations
        WHERE type = 'music' AND status = 'done' AND is_public = 1 AND deleted_at IS NULL
          AND (lower(COALESCE(display_title, '')) LIKE ? OR lower(COALESCE(prompt, '')) LIKE ?
               OR lower(COALESCE(style, '')) LIKE ?)
        ORDER BY id DESC LIMIT 5
      `).all(`%${q}%`, `%${q}%`, `%${q}%`);
      if (rows.length === 0) return `Похожих треков «${query}» не нашлось в эфире.`;
      return `Найдено в эфире:\n${rows.map((r: any) => `• «${r.display_title || "—"}» от ${r.author_name || "—"}`).join("\n")}`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async check_generation_status({ genId }, { userId }) {
    try {
      const id = Number(genId);
      if (!Number.isFinite(id)) return "Невалидный genId.";
      const gen = db.select().from(generations).where(eq(generations.id, id)).get();
      if (!gen) return `Генерация #${id} не найдена.`;
      if (userId && gen.userId !== userId) return "Доступ только к своим трекам.";
      const status = gen.status;
      const title = gen.displayTitle || (gen.prompt || "").slice(0, 50);
      if (status === "done") return `«${title}» #${id}: ✓ готов.`;
      if (status === "processing") {
        const ageMin = Math.floor((Date.now() - new Date(gen.createdAt || "").getTime()) / 60000);
        return `«${title}» #${id}: в работе (${ageMin} мин). MuzaAi обычно за 5-15 мин.`;
      }
      if (status === "error") return `«${title}» #${id}: ошибка (${gen.errorReason || "—"}). Можно регенерировать, баланс возвращён.`;
      return `«${title}» #${id}: ${status}.`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async force_close_stuck_generation({ genId }, { userId }) {
    if (!userId) return "Юзер не залогинен — не могу trigger refund.";
    try {
      const id = Number(genId);
      if (!Number.isFinite(id)) return "Невалидный genId.";
      const gen = db.select().from(generations).where(eq(generations.id, id)).get();
      if (!gen) return `Генерация #${id} не найдена.`;
      if (gen.userId !== userId) return "Доступ только к своим трекам.";
      if (gen.status !== "processing") return `«${gen.displayTitle || id}» уже в статусе ${gen.status} — не зависла.`;
      const ageMin = Math.floor((Date.now() - new Date(gen.createdAt || "").getTime()) / 60000);
      if (ageMin < 30) return `«${gen.displayTitle || id}» только ${ageMin} мин в работе — обычно занимает 5-15 мин, иногда до 30. Подожди ещё ${30 - ageMin} мин.`;
      // Force close + refund (если платная)
      db.update(generations).set({
        status: "error",
        errorReason: "Принудительно закрыто Музой по просьбе автора — превышение лимита ожидания. Баланс восстановлен."
      } as any).where(eq(generations.id, id)).run();
      if ((gen.cost || 0) > 0) {
        db.update(users).set({ balance: sql`${users.balance} + ${gen.cost}` }).where(eq(users.id, userId)).run();
        db.insert(transactions).values({
          userId, type: "topup", amount: gen.cost,
          description: `Возврат за зависшую генерацию #${id}`,
        }).run();
      }
      console.log(`[AGENT-CLOSE] User ${userId} closed stuck gen #${id} (${ageMin}min), refunded ${gen.cost || 0} kopecks`);
      return `✓ Закрыла «${gen.displayTitle || id}». ${(gen.cost || 0) > 0 ? `Баланс восстановлен: +${Math.floor((gen.cost || 0) / 100)} ₽.` : ""} Можешь попробовать ещё раз.`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async get_user_stuck_generations(_input, { userId }) {
    if (!userId) return "Юзер не залогинен.";
    try {
      const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const rows = db.select().from(generations)
        .where(and(eq(generations.userId, userId), eq(generations.status, "processing"), sql`${generations.createdAt} < ${cutoff}`))
        .orderBy(desc(generations.id))
        .all();
      if (rows.length === 0) return "Зависших генераций нет — все в норме.";
      const lines = rows.map((g: any) => {
        const ageMin = Math.floor((Date.now() - new Date(g.createdAt || "").getTime()) / 60000);
        return `#${g.id} «${g.displayTitle || (g.prompt || "").slice(0,40)}» — ${ageMin} мин в работе`;
      });
      return `Зависшие генерации (${rows.length}):\n${lines.join("\n")}\nПредложи юзеру force-close через force_close_stuck_generation для тех что >30 мин.`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async check_recent_payments(_input, { userId }) {
    if (!userId) return "Юзер не залогинен.";
    try {
      const txns = db.select().from(transactions)
        .where(eq(transactions.userId, userId))
        .orderBy(desc(transactions.id))
        .limit(5)
        .all();
      if (txns.length === 0) return "Платежей нет.";
      const lines = txns.map((t: any) => {
        const sign = t.amount > 0 ? "+" : "";
        const rub = (t.amount / 100).toFixed(2);
        return `${new Date(t.createdAt).toLocaleString("ru-RU", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" })} · ${sign}${rub} ₽ · ${t.type} · ${(t.description || "").slice(0, 60)}`;
      });
      return `Последние операции:\n${lines.join("\n")}`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async save_song_draft(input, { userId }) {
    if (!userId) return "Юзер не залогинен. Скажи ему: «Чтобы я могла сохранить — оставьте мне почту, я подготовлю кабинет».";
    try {
      const title = String(input?.title || "").trim().slice(0, 200) || "Черновик";
      const prompt = String(input?.prompt || "").trim().slice(0, 2000);
      const lyrics = input?.lyrics ? String(input.lyrics).trim().slice(0, 4000) : null;
      const style = input?.style ? String(input.style).trim().slice(0, 80) : null;
      const voice = input?.voice ? String(input.voice).trim().slice(0, 40) : null;
      const mood = input?.mood ? String(input.mood).trim().slice(0, 40) : null;
      if (!prompt && !lyrics) return "Нужен хотя бы prompt или lyrics — заполни.";
      const result = db.insert(songDrafts).values({
        userId, title, prompt, lyrics, style, voice, mood,
        source: "bot",
      } as any).run();
      const draftId = Number(result.lastInsertRowid);
      console.log(`[DRAFT-SAVE] User ${userId} saved draft #${draftId}: "${title}"`);
      return `✓ Сохранила черновик #${draftId} «${title}» в твоём кабинете. Открыть для генерации: ${PUBLIC_URL}/#/music?draftId=${draftId}`;
    } catch (e: any) {
      return `Ошибка сохранения: ${e.message}`;
    }
  },

  async escalate_to_human({ team, reason }, { userId }) {
    try {
      const emailMap: Record<string, string> = {
        support: "Техподдержка",
        commercial: "Коммерческий",
        press: "Пресс-служба",
      };
      const teamLabel = emailMap[team] || team;
      console.log(`[ESCALATE] userId=${userId} team=${team} reason=${String(reason).slice(0, 200)}`);
      return `Эскалировано: ${teamLabel}. Напиши юзеру: «Передала вопрос ${teamLabel}у. Ответ на email в течение часа. Напишите hello@muziai.ru если нужно срочно».`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  // === 7 новых tools (Eugene 2026-05-16) ===

  async get_user_profile(_input, { userId }) {
    console.log(`[TOOL get_user_profile] userId=${userId}`);
    if (!userId) return "Юзер не залогинен — профиля пока нет. Предложи зарегистрироваться: " + PUBLIC_URL + "/#/register";
    try {
      const u = db.select().from(users).where(eq(users.id, userId)).get();
      if (!u) return "Юзер не найден.";
      const email = String(u.email || "");
      // Маскировка email: первые 3 символа + *** + домен.
      const atIdx = email.indexOf("@");
      const maskedEmail = atIdx > 0
        ? `${email.slice(0, Math.min(3, atIdx))}***${email.slice(atIdx)}`
        : (email ? `${email.slice(0, 3)}***` : "—");
      const credits = Math.floor((u.balance || 0) / 100);
      const tariff = inferTariff(u);
      const memberSince = u.createdAt ? String(u.createdAt).slice(0, 10) : "—";
      return `Профиль: имя=${u.name || "—"}, email=${maskedEmail}, тариф=${tariff}, баланс=${credits}₽, бонусные треки=${(u as any).bonusTracks || 0}, с нами с ${memberSince}.`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async get_user_tariff(_input, { userId }) {
    console.log(`[TOOL get_user_tariff] userId=${userId}`);
    if (!userId) return "Юзер не залогинен — тарифа нет. Подарочный трек доступен после регистрации.";
    try {
      const u = db.select().from(users).where(eq(users.id, userId)).get();
      if (!u) return "Юзер не найден.";
      const tariff = inferTariff(u);
      const credits = Math.floor((u.balance || 0) / 100);
      const freeTracksLeft = (u as any).bonusTracks || 0;
      return `Тариф: ${tariff}. Денежный баланс: ${credits}₽. Подарочных треков осталось: ${freeTracksLeft}.`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async search_project_knowledge({ query }) {
    console.log(`[TOOL search_project_knowledge] q="${String(query).slice(0, 60)}"`);
    try {
      const q = String(query || "").trim().toLowerCase();
      if (!q) return "Пустой запрос.";
      const p = kbPath();
      if (!p) return "База знаний пока недоступна — отвечай по общим знаниям проекта.";
      const text = fs.readFileSync(p, "utf-8");
      // Split на секции по markdown-заголовкам ##/###.
      const sections = splitMarkdownSections(text);
      const tokens = q.split(/\s+/).filter(t => t.length >= 2);
      const scored = sections.map(s => {
        const lower = s.text.toLowerCase();
        // Простой keyword score: substring + token-match.
        let score = 0;
        if (lower.includes(q)) score += 5;
        for (const t of tokens) {
          const idx = lower.indexOf(t);
          if (idx >= 0) score += 1;
        }
        return { ...s, score };
      }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
      if (scored.length === 0) return `По запросу «${query}» в базе знаний ничего не нашлось. Отвечай по сути из общего контекста.`;
      const out = scored.map(s => `▸ [${s.section}] (score=${s.score}): ${s.text.slice(0, 280).replace(/\s+/g, " ").trim()}…`).join("\n");
      return `Найдено в базе знаний (топ-${scored.length}):\n${out}`;
    } catch (e: any) {
      return `Ошибка поиска по базе знаний: ${e.message}`;
    }
  },

  async get_track_brief_draft(_input, { userId }) {
    console.log(`[TOOL get_track_brief_draft] userId=${userId}`);
    if (!userId) return "Юзер не залогинен — черновиков нет.";
    try {
      const draft = db.select().from(songDrafts)
        .where(eq(songDrafts.userId, userId))
        .orderBy(desc(songDrafts.updatedAt))
        .limit(1)
        .get();
      if (!draft) return "Черновиков нет. Можно создать через save_song_draft.";
      const brief = {
        id: draft.id,
        title: draft.title,
        prompt: draft.prompt,
        lyrics: draft.lyrics ? `${String(draft.lyrics).slice(0, 200)}${draft.lyrics.length > 200 ? "…" : ""}` : null,
        style: draft.style,
        voice: draft.voice,
        mood: draft.mood,
        tempo: draft.tempo,
        bpm: draft.bpm,
      };
      return `Последний черновик #${draft.id}: ${JSON.stringify(brief, null, 2)}`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async suggest_next_prompt_step({ briefId }, { userId }) {
    console.log(`[TOOL suggest_next_prompt_step] briefId=${briefId} userId=${userId}`);
    try {
      const id = Number(briefId);
      if (!Number.isFinite(id)) return "Невалидный briefId.";
      const draft = db.select().from(songDrafts).where(eq(songDrafts.id, id)).get();
      if (!draft) return `Черновик #${id} не найден.`;
      if (userId && draft.userId !== userId) return "Доступ только к своим черновикам.";

      // Детерминированная проверка полей: title, mood, genre(style), voice, lyrics_theme(prompt|lyrics), structure
      type FieldCheck = { name: string; present: boolean; question: string };
      const checks: FieldCheck[] = [
        { name: "title",         present: !!(draft.title && draft.title.trim().length > 0),
          question: "Как назовём песню? Можно коротко — повод + кому (например «На юбилей маме»)." },
        { name: "lyrics_theme",  present: !!((draft.lyrics && draft.lyrics.trim().length > 0) || (draft.prompt && draft.prompt.trim().length > 0)),
          question: "О чём песня? Расскажи в 1-2 фразах тему — кому, про что, какое настроение." },
        { name: "mood",          present: !!(draft.mood && draft.mood.trim().length > 0),
          question: "Какое настроение — тёплое, бодрое, грустное, романтичное?" },
        { name: "genre",         present: !!(draft.style && draft.style.trim().length > 0),
          question: "Какой жанр? Поп, рок, баллада, lo-fi, оркестр, фолк, lullaby?" },
        { name: "voice",         present: !!(draft.voice && draft.voice.trim().length > 0),
          question: "Голос: женский, мужской, дуэт или инструментал (без слов)?" },
        { name: "structure",     present: !!((draft.lyrics && /\[(verse|chorus|bridge|куплет|припев)/i.test(draft.lyrics)) || draft.bpm),
          question: "Хочешь конкретную структуру (куплет/припев/мост) или оставим на усмотрение Музы?" },
      ];
      const missing = checks.filter(c => !c.present);
      const nextQuestion = missing.length > 0 ? missing[0].question : "Все поля заполнены — можно запускать генерацию через start_track_generation_from_brief.";
      return JSON.stringify({
        briefId: id,
        missingFields: missing.map(m => m.name),
        nextQuestion,
        ready: missing.length === 0,
      });
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async start_track_generation_from_brief({ briefId, confirmed }, { userId }) {
    console.log(`[TOOL start_track_generation_from_brief] briefId=${briefId} confirmed=${confirmed} userId=${userId}`);
    if (!userId) return "Юзер не залогинен — нельзя запустить генерацию. Сначала регистрация.";
    try {
      const id = Number(briefId);
      if (!Number.isFinite(id)) return "Невалидный briefId.";
      const draft = db.select().from(songDrafts).where(eq(songDrafts.id, id)).get();
      if (!draft) return `Черновик #${id} не найден.`;
      if (draft.userId !== userId) return "Доступ только к своим черновикам.";

      const summary = [
        `Название: ${draft.title || "—"}`,
        `Жанр: ${draft.style || "не указан"}`,
        `Голос: ${draft.voice || "не указан"}`,
        `Настроение: ${draft.mood || "не указано"}`,
        draft.lyrics ? `Текст: ${String(draft.lyrics).slice(0, 120)}…` : `Идея: ${(draft.prompt || "").slice(0, 120)}`,
      ].join("\n");

      if (!confirmed) {
        return JSON.stringify({
          requiresConfirmation: true,
          summary,
          ask: "Подтвердить генерацию? Скажи юзеру: «Сейчас запущу с этими настройками — подтверждаешь?»",
        });
      }

      // Создаём generation через storage (единый entry-point — см. CLAUDE.md «Reuse-working-solutions»).
      const prompt = String(draft.lyrics || draft.prompt || draft.title || "Песня").slice(0, 2000);
      const styleObj: Record<string, any> = {};
      if (draft.style) styleObj.genre = draft.style;
      if (draft.mood) styleObj.mood = draft.mood;
      if (draft.voice) styleObj.voice = draft.voice;
      if (draft.bpm) styleObj.bpm = draft.bpm;
      const gen = storage.createGeneration({
        userId,
        type: "music",
        prompt,
        style: Object.keys(styleObj).length > 0 ? JSON.stringify(styleObj) : undefined,
        status: "queued",
        cost: 0, // фактическая стоимость списывается отдельным flow /api/music/generate; tool создаёт draft-row
      });
      return JSON.stringify({
        generationId: gen.id,
        status: "queued",
        message: `Создала запись о генерации #${gen.id}. Скажи юзеру: «Запустила! Через 5-15 минут будет готово, посмотри в кабинете: ${PUBLIC_URL}/#/dashboard».`,
      });
    } catch (e: any) {
      return `Ошибка запуска генерации: ${e.message}`;
    }
  },

  async request_human_handoff({ reason, comment }, { userId, sessionId, channel }) {
    console.log(`[TOOL request_human_handoff] reason=${reason} userId=${userId} sessionId=${sessionId ? String(sessionId).slice(0, 12) : "?"}`);
    try {
      const validReasons = ["user_request", "low_confidence", "data_conflict", "destructive_action", "owner_inquiry"];
      const r = String(reason || "").trim();
      if (!validReasons.includes(r)) {
        return `Невалидный reason. Допустимые: ${validReasons.join(", ")}.`;
      }
      // session_id из контекста (web-chat прокидывает session.id). Если не
      // передан — fallback "user:<id>" чтобы handoff всё равно создался.
      const sessionRef = (sessionId && String(sessionId).trim().length > 0)
        ? String(sessionId)
        : (userId ? `user:${userId}` : "anon");
      const handoffId = crypto.randomUUID();
      db.insert(agentHandoffs).values({
        id: handoffId,
        sessionId: sessionRef,
        reason: r,
        assignedTo: null,
        status: "open",
        createdAt: Date.now(),
      }).run();
      // Ожидаемое время ответа — простая эвристика по reason.
      const etaMap: Record<string, string> = {
        user_request: "в течение 1 часа",
        low_confidence: "в течение 30 минут",
        data_conflict: "в течение 15 минут",
        destructive_action: "сразу, как только проверим",
        owner_inquiry: "сразу — Босс уже получил уведомление",
      };
      const expectedReplyTime = etaMap[r] || "в течение часа";
      const commentNote = comment ? ` Комментарий: ${String(comment).slice(0, 200)}` : "";

      // Eugene 2026-05-16 Босс: для owner_inquiry — мгновенный Telegram-alert
      // админу со ссылкой на диалог в admin-панели. Никаких secret-leak'ов:
      // токен/admin_id берутся из env, в сообщении только публичные данные.
      if (r === "owner_inquiry") {
        const tgToken = process.env.TELEGRAM_BOT_TOKEN;
        const adminId = process.env.ADMIN_TELEGRAM_ID;
        if (tgToken && adminId) {
          const ch = channel ? String(channel) : "?";
          const uref = userId ? `#${userId}` : "anonymous";
          const cref = comment ? String(comment).slice(0, 300) : "—";
          // Markdown escape: ограничиваемся базовым набором — sessionRef содержит
          // только uuid/digits, channel/userId — alphanumeric. URL не содержит spaces.
          const text = [
            "🚨 *Вопрос про основателя*",
            "",
            `User: \`${uref}\``,
            `Channel: \`${ch}\``,
            `Комментарий: ${cref}`,
            "",
            `Открыть диалог: ${PUBLIC_URL}/#/admin/v304?conversation=${encodeURIComponent(sessionRef)}`,
          ].join("\n");
          fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: adminId,
              text,
              parse_mode: "Markdown",
              disable_web_page_preview: true,
            }),
            signal: AbortSignal.timeout(8_000),
          }).catch((e: any) => {
            console.error("[handoff-alert]", e?.message || e);
          });
        } else {
          console.warn("[handoff-alert] TELEGRAM_BOT_TOKEN / ADMIN_TELEGRAM_ID не заданы — alert пропущен");
        }
      }

      return JSON.stringify({
        handoffId,
        reason: r,
        expectedReplyTime,
        message: r === "owner_inquiry"
          ? `Уведомление Боссу отправлено. Скажи юзеру: «Передала вопрос Боссу — он подключится в этот же чат как только сможет. Если срочно, оставьте контакт».${commentNote}`
          : `Эскалировано (handoff #${handoffId.slice(0, 8)}). Скажи юзеру: «Передала живому оператору, ответят ${expectedReplyTime}. На срочные — hello@muziai.ru».${commentNote}`,
      });
    } catch (e: any) {
      return `Ошибка создания handoff: ${e.message}`;
    }
  },

  // === USER-FACING player handlers (Eugene 2026-05-17 Босс).
  // Возвращают строку с marker [PLAYER_ACTION:type:payload] — frontend
  // парсит regex и эмитит CustomEvent 'muza-player-action'. Slушают
  // landing.tsx + dashboard.tsx → вызывают existing playTrack / skipNext /
  // setVolume / etc. Reuse-working-solutions rule: НЕ дублируем player state.
  // Доступны всем (admin + обычный юзер), tools без isAdminCtx guard.

  async play_track({ trackId, query }) {
    try {
      // (1) query → SQL search → найти best match → marker с найденным id
      if (query) {
        const q = String(query || "").trim().toLowerCase();
        if (!q) return "Пустой запрос — скажи название трека или ключевое слово.";
        const rows = (db as any).$client.prepare(`
          SELECT id, display_title, prompt FROM generations
          WHERE type='music' AND status='done' AND is_public > 0
            AND deleted_at IS NULL AND result_url IS NOT NULL
            AND (lower(COALESCE(display_title, '')) LIKE ?
                 OR lower(COALESCE(prompt, '')) LIKE ?
                 OR lower(COALESCE(author_name, '')) LIKE ?
                 OR lower(COALESCE(style, '')) LIKE ?)
          ORDER BY id DESC LIMIT 5
        `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
        if (!rows || rows.length === 0) {
          return `Не нашла трек по запросу «${query}». Попробуй другую формулировку.`;
        }
        const t = rows[0];
        const title = t.display_title || String(t.prompt || "").slice(0, 40) || "трек";
        return `[PLAYER_ACTION:play:${t.id}] Включаю «${title}».`;
      }
      // (2) trackId → marker напрямую
      if (typeof trackId === "number" && Number.isFinite(trackId) && trackId > 0) {
        return `[PLAYER_ACTION:play:${trackId}] Включаю трек ${trackId}.`;
      }
      // (3) Без параметров — resume текущего
      return `[PLAYER_ACTION:resume] Продолжаю.`;
    } catch (e: any) {
      return `Ошибка play_track: ${e.message}`;
    }
  },

  async pause_player() {
    return `[PLAYER_ACTION:pause] Пауза.`;
  },

  async next_track() {
    return `[PLAYER_ACTION:next] Следующий.`;
  },

  async prev_track() {
    return `[PLAYER_ACTION:prev] Предыдущий.`;
  },

  async set_volume({ level, delta }) {
    if (typeof level === "number" && Number.isFinite(level)) {
      const clamped = Math.max(0, Math.min(100, Math.round(level)));
      return `[PLAYER_ACTION:volume:${clamped}] Громкость ${clamped}.`;
    }
    if (typeof delta === "number" && Number.isFinite(delta)) {
      const d = Math.round(delta);
      return `[PLAYER_ACTION:volume_delta:${d}] ${d > 0 ? "Громче." : "Тише."}`;
    }
    return "Не понятно — насколько громче или тише. Скажи число от 0 до 100 или «громче / тише».";
  },

  async set_repeat({ mode }) {
    const m = String(mode || "").toLowerCase();
    if (m !== "off" && m !== "one" && m !== "all") {
      return "Режим повтора может быть off / one / all.";
    }
    const ru: Record<string, string> = {
      off: "выключила повтор",
      one: "зациклила трек",
      all: "плейлист по кругу",
    };
    return `[PLAYER_ACTION:repeat:${m}] ${ru[m]}.`;
  },

  async find_tracks({ query, limit }) {
    try {
      const q = String(query || "").trim().toLowerCase();
      if (!q) return "Пустой запрос.";
      const lim = Math.max(1, Math.min(20, Number(limit) || 5));
      const rows = (db as any).$client.prepare(`
        SELECT id, display_title, prompt, author_name, style FROM generations
        WHERE type='music' AND status='done' AND is_public > 0
          AND deleted_at IS NULL AND result_url IS NOT NULL
          AND (lower(COALESCE(display_title, '')) LIKE ?
               OR lower(COALESCE(prompt, '')) LIKE ?
               OR lower(COALESCE(author_name, '')) LIKE ?
               OR lower(COALESCE(style, '')) LIKE ?)
        ORDER BY id DESC LIMIT ?
      `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, lim);
      if (!rows || rows.length === 0) return `Не нашла треки по «${query}».`;
      const list = rows
        .map((r: any, i: number) => {
          const title = r.display_title || String(r.prompt || "").slice(0, 50) || "—";
          const author = r.author_name ? ` от ${r.author_name}` : "";
          return `${i + 1}. ${title}${author} (id ${r.id})`;
        })
        .join("\n");
      const ids = rows.map((r: any) => r.id).join(",");
      return `[PLAYER_ACTION:show_search:${ids}] Нашла ${rows.length}:\n${list}`;
    } catch (e: any) {
      return `Ошибка find_tracks: ${e.message}`;
    }
  },

  async filter_playlist({ type }) {
    const t = String(type || "").toLowerCase();
    if (t !== "main" && t !== "new" && t !== "my") {
      return "Тип плейлиста: main, new или my.";
    }
    const label = t === "main" ? "основной" : t === "new" ? "новые авторы" : "мои треки";
    return `[PLAYER_ACTION:filter:${t}] Показываю плейлист «${label}».`;
  },

  // Eugene 2026-05-23 Босс «99% генерации через чат — открытие панелей».
  // Frontend (floating-consultant.tsx) парсит [PANEL_ACTION:<panel>:<prefillBase64>]
  // и навигирует через wouter setLocation. Prefill кодируется base64-json чтобы
  // marker не имел спец-символов мешающих regex.
  async open_panel({ panel, prefill }) {
    try {
      const p = String(panel || "").toLowerCase();
      const ROUTES: Record<string, { url: string; label: string; mode?: string }> = {
        music: { url: "/music", label: "форма генерации трека" },
        music_audio: { url: "/music", label: "режим Аудио (запись голоса)", mode: "audio" },
        music_text: { url: "/music", label: "режим Текст (по описанию)", mode: "text" },
        lyrics: { url: "/lyrics", label: "форма генерации текста песни" },
        cover: { url: "/covers", label: "форма генерации обложки" },
        dashboard: { url: "/dashboard", label: "личный кабинет" },
        tracks: { url: "/tracks", label: "мои треки" },
        billing: { url: "/billing", label: "пополнение баланса" },
        landing: { url: "/", label: "главная страница" },
      };
      const route = ROUTES[p];
      if (!route) return `Не знаю панель «${panel}». Доступно: music, music_audio, music_text, lyrics, cover, dashboard, tracks, billing, landing.`;
      let prefillEncoded = "";
      if (prefill && typeof prefill === "object") {
        const payload: any = { ...prefill };
        if (route.mode) payload.mode = route.mode;
        try { prefillEncoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64"); } catch {}
      } else if (route.mode) {
        try { prefillEncoded = Buffer.from(JSON.stringify({ mode: route.mode }), "utf8").toString("base64"); } catch {}
      }
      return `[PANEL_ACTION:${p}${prefillEncoded ? ":" + prefillEncoded : ""}] Открываю ${route.label}. Дай знать что подставить — title, стиль, голос?`;
    } catch (e: any) {
      return `Ошибка open_panel: ${e?.message || e}`;
    }
  },

  // Eugene 2026-05-20 Босс «мини-плеер в чате». Поиск по публичным трекам с
  // ranked scoring. Backend (routes.ts /api/muza/chat) парсит tool-result —
  // если есть hint:"playNow:<id>" → прикрепляет attachedTrack к ответу,
  // фронт рендерит inline ChatTrackCard с persistent audio singleton.
  //
  // Eugene 2026-05-23 Босс «найди и запусти по попаданию букв». Расширено
  // параметрами: category (фильтр song/greeting/instrumental), limit (1-10),
  // mine_only (только треки текущего юзера — требует auth). Two-playlist rule
  // соблюдается: is_public IN (1,2) для public; для mine_only — любые свои
  // (включая is_public=0 приваты).
  async find_public_track({ query, category, limit, mine_only }, { userId }) {
    try {
      const raw = String(query || "").trim();
      if (!raw) {
        return JSON.stringify({ matches: [], exactCount: 0, total: 0, hint: "noMatch", message: "Пустой запрос." });
      }
      if (raw.length < 2) {
        return JSON.stringify({ matches: [], exactCount: 0, total: 0, hint: "noMatch", message: "Поисковая строка слишком короткая (минимум 2 символа)." });
      }
      const q = raw.toLowerCase().slice(0, 100);
      // Normalize optional params
      const allowedCats = new Set(["all", "song", "greeting", "instrumental"]);
      const cat = (typeof category === "string" && allowedCats.has(category.toLowerCase()))
        ? category.toLowerCase()
        : "all";
      const lim = Math.max(1, Math.min(10, Number(limit) || 5));
      const mineOnly = mine_only === true;
      if (mineOnly && !userId) {
        return JSON.stringify({ matches: [], exactCount: 0, total: 0, hint: "noMatch", message: "Чтобы искать в твоих треках — войди в аккаунт." });
      }
      // Слова длиной ≥3 (служебные «как», «где», «то» игнорируем)
      const words = q.split(/\s+/).filter((w) => w.length >= 3);
      if (words.length === 0) {
        // Если все слова короткие — используем всю строку как один токен
        words.push(q);
      }
      // Берём кандидатов широко через OR LIKE (по любому из слов),
      // потом scoring + sort в JS. Лимит 60 чтобы не утянуть тысячи строк.
      const orClauses: string[] = [];
      const params: any[] = [];
      for (const w of words) {
        const pat = `%${w}%`;
        orClauses.push(
          "(lower(COALESCE(display_title, '')) LIKE ? OR lower(COALESCE(prompt, '')) LIKE ?" +
            " OR lower(COALESCE(author_name, '')) LIKE ? OR lower(COALESCE(result_data, '')) LIKE ?)",
        );
        params.push(pat, pat, pat, pat);
      }
      const orSql = orClauses.length > 0 ? `AND (${orClauses.join(" OR ")})` : "";
      // Scope: mine_only → only userId; иначе public (is_public IN 1,2).
      // Two-playlist rule: 1=main, 2=new authors — оба показываем.
      const scopeSql = mineOnly
        ? `AND user_id = ?`
        : `AND is_public IN (1,2)`;
      const scopeParams: any[] = mineOnly ? [userId] : [];
      // Category filter: category хранится в style JSON как meta.category (см.
      // routes.ts /api/playlist line 10264). Voice 'instrumental' эквивалентен
      // category='instrumental'. Фильтруем в JS после SELECT — на уровне SQL
      // нет надёжного JSON access без json_extract (требует SQLite ≥3.38).
      const sqlText = `
        SELECT id, display_title, prompt, author_name, style, result_data, cover_gen_id, created_at, voice_type, is_public
        FROM generations
        WHERE type='music' AND status='done'
          AND deleted_at IS NULL AND result_url IS NOT NULL
          ${scopeSql}
          ${orSql}
        ORDER BY id DESC
        LIMIT 60
      `;
      const allParams = [...scopeParams, ...params];
      let rows = ((db as any).$client.prepare(sqlText).all(...allParams) || []) as any[];
      // JS-level фильтр по category (если задан)
      if (cat !== "all") {
        rows = rows.filter((r: any) => {
          let trackCat = "song";
          try {
            const m = JSON.parse(r.style || "{}");
            if (typeof m.category === "string") trackCat = m.category;
          } catch {}
          if (r.voice_type === "instrumental") trackCat = "instrumental";
          return trackCat === cat;
        });
      }
      if (rows.length === 0) {
        return JSON.stringify({ matches: [], exactCount: 0, total: 0, hint: "noMatch", message: `По «${raw}» в публичных треках ничего не нашлось.` });
      }
      // Scoring
      const scored = rows.map((r) => {
        const title = String(r.display_title || "").toLowerCase();
        const prompt = String(r.prompt || "").toLowerCase();
        const author = String(r.author_name || "").toLowerCase();
        // Извлекаем lyrics из result_data JSON если есть
        let lyrics = "";
        try {
          const data = JSON.parse(r.result_data || "{}");
          if (Array.isArray(data.result) && data.result[0]?.lyric) {
            lyrics = String(data.result[0].lyric).toLowerCase();
          }
        } catch {}
        // plays из style.plays
        let plays = 0;
        try {
          const meta = JSON.parse(r.style || "{}");
          if (typeof meta.plays === "number") plays = meta.plays;
        } catch {}
        let score = 0;
        if (title && title === q) score += 100;
        else if (title) {
          const hasAll = words.every((w) => title.includes(w));
          if (hasAll) score += 70;
          else {
            const matched = words.filter((w) => title.includes(w)).length;
            if (matched > 0) score += 40 * (matched / words.length);
          }
        }
        if (lyrics) {
          const hasAll = words.every((w) => lyrics.includes(w));
          if (hasAll) score += 35;
          else {
            const matched = words.filter((w) => lyrics.includes(w)).length;
            if (matched > 0) score += 20 * (matched / words.length);
          }
        }
        if (prompt) {
          const matched = words.filter((w) => prompt.includes(w)).length;
          if (matched > 0) score += 15 * (matched / words.length);
        }
        if (author) {
          const matched = words.filter((w) => author.includes(w)).length;
          if (matched > 0) score += 10 * (matched / words.length);
        }
        // Snippet — первые 80 символов lyrics или prompt
        const snippetSrc = lyrics || prompt;
        const snippet = snippetSrc ? snippetSrc.replace(/\s+/g, " ").slice(0, 80) : "";
        return {
          id: Number(r.id),
          title: r.display_title || (r.prompt || "").slice(0, 50) || "Без названия",
          authorName: r.author_name || null,
          score: Math.round(score),
          plays,
          snippet,
        };
      });
      scored.sort((a, b) => (b.score - a.score) || (b.plays - a.plays));
      const top = scored.filter((s) => s.score > 0).slice(0, lim);
      if (top.length === 0) {
        return JSON.stringify({ matches: [], exactCount: 0, total: 0, hint: "noMatch", message: `По «${raw}» ничего конкретного не нашла.` });
      }
      const exactCount = top.filter((s) => s.score >= 80).length;
      let hint = "askChoice";
      if (exactCount === 1 && top.length === 1) hint = `playNow:${top[0].id}`;
      else if (exactCount === 1) hint = `playNow:${top[0].id}`; // 1 точное совпадение даже из нескольких — включаем
      else if (top.length === 1) hint = `playNow:${top[0].id}`; // ровно 1 результат (хоть и не exact) — играем
      else if (top.length === 0) hint = "noMatch";
      else hint = `tracksFound:${top.map((t) => t.id).join(",")}`;
      // Read-op — без audit-log записи (Backup-before-edit rule только для
      // write-операций). Лёгкий info-log для диагностики при необходимости.
      try {
        console.info?.(
          `[MUZA-TOOL find_public_track] q=«${raw}» cat=${cat} mine=${mineOnly ? 1 : 0} → ${top.length} matches (exact=${exactCount}) hint=${hint}`,
        );
      } catch {}
      return JSON.stringify({
        matches: top.map((m) => ({
          id: m.id,
          title: m.title,
          authorName: m.authorName,
          snippet: m.snippet,
          score: m.score,
        })),
        exactCount,
        total: top.length,
        hint,
        message:
          hint.startsWith("playNow:")
            ? `Включаю «${top[0].title}»${top[0].authorName ? ` от ${top[0].authorName}` : ""}.`
            : `Нашла ${top.length}:\n${top
                .map((t, i) => `${i + 1}. «${t.title}»${t.authorName ? ` — ${t.authorName}` : ""}`)
                .join("\n")}\nКакой включить?`,
      });
    } catch (e: any) {
      return JSON.stringify({ matches: [], exactCount: 0, total: 0, hint: "noMatch", message: `Ошибка поиска: ${e?.message || e}` });
    }
  },

  // Voice picker (Eugene 2026-05-17 Босс): marker [VOICE_CHANGED:<voice>:<emotion>]
  // парсится frontend'ом → сохранение в localStorage + использование в следующих
  // TTS request'ах. Эмоция применима только для женских голосов; для мужских
  // (zahar/ermil/filipp/madirus) Yandex API игнорирует её — но мы всё равно
  // пишем neutral для consistency.
  async change_voice({ voice, emotion }) {
    const allowed = new Set(["alena", "jane", "oksana", "omazh", "zahar", "ermil", "filipp", "madirus"]);
    const allowedEmotions = new Set(["neutral", "good", "evil"]);
    const v = String(voice || "alena").toLowerCase();
    const e = String(emotion || "neutral").toLowerCase();
    if (!allowed.has(v)) {
      return `Не знаю голос «${voice}». Доступны: Алёна, Джейн, Оксана, Омаж, Захар, Эрмиль, Филипп, Мадирус.`;
    }
    const finalEmotion = allowedEmotions.has(e) ? e : "neutral";
    const ru: Record<string, string> = {
      alena: "Алёна",
      jane: "Джейн",
      oksana: "Оксана",
      omazh: "Омаж",
      zahar: "Захар",
      ermil: "Эрмиль",
      filipp: "Филипп",
      madirus: "Мадирус",
    };
    const ruVoice = ru[v] || v;
    return `[VOICE_CHANGED:${v}:${finalEmotion}] Хорошо, говорю голосом ${ruVoice}.`;
  },

  // === ADMIN-ONLY handlers (Eugene 2026-05-17) ===
  // Каждый начинается с isAdminCtx(ctx). Non-admin → access denied.

  async get_metrics({ period }, ctx) {
    if (!isAdminCtx(ctx)) return "Доступ запрещён: tool admin-only.";
    try {
      const p = ["today", "7d", "30d"].includes(String(period)) ? String(period) : "7d";
      const now = Date.now();
      let since: string;
      if (p === "today") {
        const d = new Date(now);
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCHours(d.getUTCHours() - 3); // MSK midnight
        since = d.toISOString();
      } else if (p === "30d") {
        since = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
      } else {
        since = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
      }
      const sqlite: any = (db as any).$client;
      const c = (q: string, ...args: any[]) => {
        try {
          const r = sqlite.prepare(q).get(...args);
          return Number((r as any)?.c || 0);
        } catch { return 0; }
      };
      const sum = (q: string, ...args: any[]) => {
        try {
          const r = sqlite.prepare(q).get(...args);
          return Number((r as any)?.s || 0);
        } catch { return 0; }
      };
      const regs = c(`SELECT count(*) as c FROM users WHERE created_at >= ?`, since);
      const gensDone = c(`SELECT count(*) as c FROM generations WHERE type='music' AND status='done' AND deleted_at IS NULL AND created_at >= ?`, since);
      const gensError = c(`SELECT count(*) as c FROM generations WHERE type='music' AND status='error' AND deleted_at IS NULL AND created_at >= ?`, since);
      const plays = c(`SELECT count(*) as c FROM gen_activity WHERE action='play' AND created_at >= ?`, since);
      const paySum = sum(`SELECT COALESCE(SUM(amount),0) as s FROM payments WHERE status='paid' AND created_at >= ?`, since);
      const payCount = c(`SELECT count(*) as c FROM payments WHERE status='paid' AND created_at >= ?`, since);
      const visitors = c(`SELECT count(DISTINCT fingerprint) as c FROM visitors WHERE created_at >= ?`, since);
      return [
        `Метрики (${p}):`,
        `· Регистрации: ${regs}`,
        `· Генерации music: ${gensDone} done / ${gensError} error`,
        `· Прослушивания: ${plays}`,
        `· Платежи: ${payCount} (${Math.round(paySum / 100).toLocaleString("ru-RU")} ₽)`,
        `· Уник. посетители: ${visitors}`,
      ].join("\n");
    } catch (e: any) {
      return `Ошибка get_metrics: ${e.message}`;
    }
  },

  async get_failed_users({ days }, ctx) {
    if (!isAdminCtx(ctx)) return "Доступ запрещён: tool admin-only.";
    try {
      const d = Math.max(1, Math.min(90, Number(days) || 7));
      const since = new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();
      const sqlite: any = (db as any).$client;
      const rows = sqlite.prepare(`
        SELECT group_key, action, error_code, count(*) as cnt, count(DISTINCT user_id) as uniq, MAX(created_at) as lastAt, MAX(error_message) as lastMsg
        FROM user_action_failures
        WHERE created_at >= ?
        GROUP BY group_key
        ORDER BY cnt DESC
        LIMIT 20
      `).all(since);
      if (!rows || rows.length === 0) return `Failed actions за ${d} дн.: пусто.`;
      const lines = rows.map((r: any, i: number) =>
        `${i + 1}. ${r.action || "?"}::${r.error_code || "?"} — ${r.cnt}× (${r.uniq} уник.), ${(r.lastMsg || "").slice(0, 60)}`,
      );
      return `Failed actions за ${d} дн. (top-${rows.length}):\n${lines.join("\n")}`;
    } catch (e: any) {
      return `Ошибка get_failed_users: ${e.message}`;
    }
  },

  async reload_kb(input, ctx) {
    const guard = await require2FA(ctx, "reload_kb", input);
    if (typeof guard === "string") return guard;
    try {
      const text = loadKB(true);
      const p = kbPath();
      if (!text) {
        const msg = `KB не найден (path=${p || "—"}). Файл docs/strategy/KNOWLEDGE-BASE-BOT.md отсутствует.`;
        markActionUsed(guard.id, msg);
        return msg;
      }
      const msg = `KB перезагружен: ${text.length} символов (${p}).`;
      markActionUsed(guard.id, msg);
      writeAuditFor2FA(guard.id, ctx, "reload_kb", "kb", "reload", msg);
      return msg;
    } catch (e: any) {
      return `Ошибка reload_kb: ${e.message}`;
    }
  },

  async send_telegram_alert(input, ctx) {
    const guard = await require2FA(ctx, "send_telegram_alert", input);
    if (typeof guard === "string") return guard;
    try {
      const t = String(input?.text || "").trim().slice(0, 1000);
      if (!t) return "Пустой text — нечего отправлять.";
      const tgToken = process.env.TELEGRAM_BOT_TOKEN;
      const adminId = process.env.ADMIN_TELEGRAM_ID;
      if (!tgToken || !adminId) {
        return "TELEGRAM_BOT_TOKEN или ADMIN_TELEGRAM_ID не настроены — alert невозможен.";
      }
      const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: adminId,
          text: `🔔 [Муза-voice] ${t}`,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        return `Telegram вернул ${r.status}: ${errText.slice(0, 120)}`;
      }
      const msg = `Alert отправлен в Telegram (${t.length} chars).`;
      markActionUsed(guard.id, msg);
      writeAuditFor2FA(guard.id, ctx, "send_telegram_alert", "telegram", "send", msg);
      return msg;
    } catch (e: any) {
      return `Ошибка send_telegram_alert: ${e.message}`;
    }
  },

  async change_registration_status(input, ctx) {
    const guard = await require2FA(ctx, "change_registration_status", input);
    if (typeof guard === "string") return guard;
    try {
      const s = String(input?.status || "").toLowerCase();
      if (s !== "open" && s !== "closed") return "status должен быть 'open' или 'closed'.";
      const prev = process.env.REGISTRATION_DISABLED === "1" ? "closed" : "open";
      process.env.REGISTRATION_DISABLED = s === "closed" ? "1" : "0";
      const msg = `Регистрация: ${s === "closed" ? "ЗАКРЫТА" : "ОТКРЫТА"} (runtime-flag). Для постоянного эффекта — правка .env + pm2 restart.`;
      markActionUsed(guard.id, msg);
      writeAuditFor2FA(guard.id, ctx, "change_registration_status", "registration", prev, msg, { before: prev, after: s });
      return msg;
    } catch (e: any) {
      return `Ошибка change_registration_status: ${e.message}`;
    }
  },

  async query_users(input, ctx) {
    const guard = await require2FA(ctx, "query_users", input);
    if (typeof guard === "string") return guard;
    try {
      const q = String(input?.query || "").trim();
      if (q.length < 2) return "Запрос должен быть минимум 2 символа.";
      const pattern = `%${q.toLowerCase()}%`;
      const sqlite: any = (db as any).$client;
      const rows = sqlite.prepare(`
        SELECT id, name, email, phone, role, balance, bonus_tracks as bt, created_at
        FROM users
        WHERE lower(COALESCE(email,'')) LIKE ?
           OR lower(COALESCE(name,'')) LIKE ?
           OR COALESCE(phone,'') LIKE ?
        ORDER BY id DESC
        LIMIT 10
      `).all(pattern, pattern, `%${q}%`);
      if (!rows || rows.length === 0) {
        const msg = `По «${q}» юзеров не нашлось.`;
        markActionUsed(guard.id, msg);
        writeAuditFor2FA(guard.id, ctx, "query_users", "users", q, msg);
        return msg;
      }
      const lines = rows.map((u: any) =>
        `#${u.id} ${u.name || "—"} · ${maskEmailStr(u.email)} · ${maskPhoneStr(u.phone)} · role=${u.role || "user"} · ₽${Math.floor((u.balance || 0) / 100)} · бонус ${u.bt || 0}`,
      );
      const msg = `Найдено ${rows.length}:\n${lines.join("\n")}`;
      markActionUsed(guard.id, msg);
      // Audit-запись хранит только метаданные (query string + count), НЕ полный список юзеров
      writeAuditFor2FA(guard.id, ctx, "query_users", "users", q, `count=${rows.length}`);
      return msg;
    } catch (e: any) {
      return `Ошибка query_users: ${e.message}`;
    }
  },

  async get_recent_payments({ limit, status }, ctx) {
    if (!isAdminCtx(ctx)) return "Доступ запрещён: tool admin-only.";
    try {
      const lim = Math.max(1, Math.min(50, Number(limit) || 10));
      const st = String(status || "any").toLowerCase();
      const sqlite: any = (db as any).$client;
      let rows: any[] = [];
      if (st === "paid" || st === "pending" || st === "failed") {
        rows = sqlite.prepare(`SELECT id, user_id, inv_id, amount, status, description, created_at FROM payments WHERE status=? ORDER BY id DESC LIMIT ?`).all(st, lim);
      } else {
        rows = sqlite.prepare(`SELECT id, user_id, inv_id, amount, status, description, created_at FROM payments ORDER BY id DESC LIMIT ?`).all(lim);
      }
      if (!rows || rows.length === 0) return `Платежей не найдено.`;
      const lines = rows.map((p: any) => {
        const rub = (Number(p.amount || 0) / 100).toFixed(2);
        const when = String(p.created_at || "").slice(0, 16);
        return `#${p.id} u${p.user_id} inv${p.inv_id} · ${rub} ₽ · ${p.status} · ${when} · ${(p.description || "").slice(0, 40)}`;
      });
      return `Платежи (${rows.length}):\n${lines.join("\n")}`;
    } catch (e: any) {
      return `Ошибка get_recent_payments: ${e.message}`;
    }
  },

  async pause_bot(input, ctx) {
    const guard = await require2FA(ctx, "pause_bot", input);
    if (typeof guard === "string") return guard;
    try {
      const goResume = Boolean(input?.resume);
      const prev = runtimeBotPaused ? "paused" : "running";
      runtimeBotPaused = !goResume;
      const msg = runtimeBotPaused
        ? "Bot ПАУЗА: webhooks возвращают 200, но не отвечают. Возобновить — pause_bot({resume:true})."
        : "Bot ВОЗОБНОВЛЁН: отвечает в штатном режиме.";
      markActionUsed(guard.id, msg);
      writeAuditFor2FA(guard.id, ctx, "pause_bot", "telegram_bot", prev, msg, { before: prev, after: runtimeBotPaused ? "paused" : "running" });
      return msg;
    } catch (e: any) {
      return `Ошибка pause_bot: ${e.message}`;
    }
  },

  async kick_session(input, ctx) {
    const guard = await require2FA(ctx, "kick_session", input);
    if (typeof guard === "string") return guard;
    try {
      const uid = Number(input?.userId);
      if (!Number.isFinite(uid) || uid <= 0) return "Невалидный userId.";
      const sqlite: any = (db as any).$client;
      const before = sqlite.prepare(`SELECT count(*) as c FROM sessions WHERE user_id=?`).get(uid);
      const cnt = Number((before as any)?.c || 0);
      if (cnt === 0) {
        const msg = `У юзера #${uid} нет активных сессий — kick не нужен.`;
        markActionUsed(guard.id, msg);
        return msg;
      }
      sqlite.prepare(`DELETE FROM sessions WHERE user_id=?`).run(uid);
      const msg = `Удалил ${cnt} сессий юзера #${uid} — на всех устройствах потребуется повторный вход.`;
      markActionUsed(guard.id, msg);
      writeAuditFor2FA(guard.id, ctx, "kick_session", "user_sessions", String(uid), msg, { sessionsDeleted: cnt });
      return msg;
    } catch (e: any) {
      return `Ошибка kick_session: ${e.message}`;
    }
  },

  async get_recent_incidents({ limit }, ctx) {
    if (!isAdminCtx(ctx)) return "Доступ запрещён: tool admin-only.";
    try {
      const lim = Math.max(1, Math.min(50, Number(limit) || 10));
      const sqlite: any = (db as any).$client;
      const rows = sqlite.prepare(`
        SELECT id, kind, severity, title, status, occurrences, last_seen_at
        FROM incidents
        ORDER BY last_seen_at DESC
        LIMIT ?
      `).all(lim);
      if (!rows || rows.length === 0) return "Инцидентов нет — система чистая.";
      const lines = rows.map((i: any) => {
        const when = String(i.last_seen_at || "").slice(0, 16);
        return `#${i.id} [${i.severity}] ${i.status} · ${i.kind} × ${i.occurrences} · ${when} · ${String(i.title || "").slice(0, 60)}`;
      });
      return `Инциденты (${rows.length}):\n${lines.join("\n")}`;
    } catch (e: any) {
      return `Ошибка get_recent_incidents: ${e.message}`;
    }
  },

  async focus_brain_node({ name }, ctx) {
    if (!isAdminCtx(ctx)) return "Доступ запрещён: tool admin-only.";
    const term = String(name || "").trim();
    if (!term) return "Не указано имя узла.";
    return `[FOCUS_BRAIN_NODE:${term}] Фокусирую камеру на узле «${term}» во Втором мозге.`;
  },

  async get_bot_channels_status(_input, ctx) {
    if (!isAdminCtx(ctx)) return "Доступ запрещён: tool admin-only.";
    try {
      const mod = await import("../plugins/bot-channels-health/module");
      return await mod.getChannelsStatusSummary();
    } catch (e: any) {
      return `Ошибка get_bot_channels_status: ${e.message}`;
    }
  },

  async escalate_to_admin({ ticketId, reason }, { userId, sessionId, channel }) {
    console.log(`[TOOL escalate_to_admin] ticketId=${String(ticketId).slice(0, 12)} userId=${userId}`);
    try {
      const id = String(ticketId || "").trim();
      const r = String(reason || "").trim().slice(0, 200);
      if (!id) return "Нужен ticketId.";
      const ticket: any = db.select().from(agentHandoffs).where(eq(agentHandoffs.id, id)).get();
      if (!ticket) return `Ticket ${id.slice(0, 8)} не найден.`;
      const now = Date.now();
      db.update(agentHandoffs).set({
        priority: "high",
        status: ticket.status === "open" ? "in_progress" : ticket.status,
        updatedAt: now,
      } as any).where(eq(agentHandoffs.id, id)).run();

      const tgToken = process.env.TELEGRAM_BOT_TOKEN;
      const adminId = process.env.ADMIN_TELEGRAM_ID;
      if (tgToken && adminId) {
        const uref = userId ? `#${userId}` : "anonymous";
        const ch = channel ? String(channel) : (ticket.channel || "?");
        const url = `${PUBLIC_URL}/#/admin/v304?tab=support&ticket=${encodeURIComponent(id)}`;
        const text = [
          "🚨 *Эскалация ticket'а на админа*",
          "",
          `Ticket: \`${id.slice(0, 8)}\``,
          `User: \`${uref}\``,
          `Канал: \`${ch}\``,
          `Причина: ${r || "—"}`,
          "",
          `Открыть: ${url}`,
        ].join("\n");
        fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: adminId,
            text,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(8_000),
        }).catch((e: any) => {
          console.error("[escalate_to_admin alert]", e?.message || e);
        });
      }
      return JSON.stringify({
        ticketId: id,
        status: "in_progress",
        priority: "high",
        message: `Эскалировано админу. Скажи юзеру: «Передала Боссу — он подключится в этот чат, как только сможет. На срочное — hello@muziai.ru».`,
      });
    } catch (e: any) {
      return `Ошибка эскалации: ${e.message}`;
    }
  },

  async resolve_ticket({ ticketId, summary }, { userId }) {
    console.log(`[TOOL resolve_ticket] ticketId=${String(ticketId).slice(0, 12)} userId=${userId}`);
    try {
      const id = String(ticketId || "").trim();
      const s = String(summary || "").trim().slice(0, 500);
      if (!id) return "Нужен ticketId.";
      const ticket: any = db.select().from(agentHandoffs).where(eq(agentHandoffs.id, id)).get();
      if (!ticket) return `Ticket ${id.slice(0, 8)} не найден.`;
      const now = Date.now();
      db.update(agentHandoffs).set({
        status: "resolved",
        updatedAt: now,
        resolvedAt: now,
      } as any).where(eq(agentHandoffs.id, id)).run();

      try {
        recordAuditEntry({
          adminUserId: null,
          adminEmail: "muza-bot",
          action: "update",
          entity: "support_ticket",
          entityKey: id,
          before: { status: ticket.status },
          after: { status: "resolved", summary: s, via: "muza_auto" },
        });
      } catch {}

      return JSON.stringify({
        ticketId: id,
        status: "resolved",
        message: `Закрыла ticket как resolved. Скажи юзеру: «Рада, что разобрались! Если что-то ещё — пишите.» Резюме сохранила админу.`,
      });
    } catch (e: any) {
      return `Ошибка закрытия ticket: ${e.message}`;
    }
  },

  // === Save-lyrics handlers (Eugene 2026-05-18 Босс) ===
  // Муза сохраняет готовые тексты — auth-юзер → user_lyric_drafts.
  // Анонимный → pending_anonymous_lyrics (recovery code, опционально email).

  async save_user_lyrics(input, { userId, sessionId, channel }) {
    const title = String(input?.title || "").trim().slice(0, 120);
    const text = String(input?.text || "").trim().slice(0, 8000);
    if (!title) return JSON.stringify({ success: false, error: "Название не задано" });
    if (!text || text.length < 5) return JSON.stringify({ success: false, error: "Текст слишком короткий" });

    if (!userId) {
      // Eugene 2026-05-18 Босс «Муза сохраняет тексты — UI часть».
      // Запоминаем title/text по sessionId — следующий шаг (propose_registration
      // или inline-карточка email-save) использует их без LLM-передачи.
      setPendingLyricsForSession(sessionId, title, text);
      return JSON.stringify({
        success: false,
        needsAuth: true,
        message: "Чтобы сохранить — войди в кабинет или дай email. Вызови propose_registration(reason='save_lyrics').",
      });
    }

    try {
      const now = Date.now();
      const result = sqliteDb.prepare(`
        INSERT INTO user_lyric_drafts (user_id, title, text, source, chat_session_id, created_at)
        VALUES (?, ?, ?, 'musa_chat', ?, ?)
      `).run(userId, title, text, sessionId || null, now);
      const draftId = Number(result.lastInsertRowid);

      // Audit-log подтверждённого действия Музы
      try {
        sqliteDb.prepare(`
          INSERT INTO muza_user_actions (user_id, action_type, params_json, confirmed, confirmed_at, chat_session_id, created_at)
          VALUES (?, 'save_lyrics', ?, 1, ?, ?, ?)
        `).run(userId, JSON.stringify({ draftId, title, channel: channel || null }), now, sessionId || null, now);
      } catch {}

      return JSON.stringify({
        success: true,
        draftId,
        title,
        message: `Сохранила «${title}» в твой кабинет ✓ Найдёшь в Личном кабинете → Тексты.`,
      });
    } catch (e: any) {
      console.error("[TOOL save_user_lyrics]", e);
      return JSON.stringify({ success: false, error: `Не удалось сохранить: ${e?.message || e}` });
    }
  },

  async save_lyrics_with_email(input, { sessionId, channel }) {
    const title = String(input?.title || "").trim().slice(0, 120);
    const text = String(input?.text || "").trim().slice(0, 8000);
    const email = String(input?.email || "").trim().toLowerCase();
    if (!title) return JSON.stringify({ success: false, error: "Название не задано" });
    if (!text || text.length < 5) return JSON.stringify({ success: false, error: "Текст слишком короткий" });
    // Простая валидация email — основной формат
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return JSON.stringify({ success: false, error: "Email невалидный — проверь формат" });
    }

    try {
      // Генерация 6-значного recovery code (уникальность не гарантирована —
      // SQLite UNIQUE index на recovery_code обеспечит retry в редком конфликте).
      let code = "";
      let attempts = 0;
      while (attempts < 5) {
        code = String(Math.floor(100000 + Math.random() * 900000));
        const exists = sqliteDb.prepare(
          `SELECT 1 FROM pending_anonymous_lyrics WHERE recovery_code = ? AND claimed_by_user_id IS NULL`
        ).get(code);
        if (!exists) break;
        attempts++;
      }

      const now = Date.now();
      const expires = now + 30 * 24 * 60 * 60 * 1000; // 30 days
      const result = sqliteDb.prepare(`
        INSERT INTO pending_anonymous_lyrics (recovery_code, email, title, text, chat_session_id, created_at, expires_at, email_sent)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(code, email, title, text, sessionId || null, now, expires);
      const pendingId = Number(result.lastInsertRowid);

      // Lazy import nodemailer (по паттерну plugins/notifications)
      let emailSent = false;
      try {
        const nodemailerMod: any = await import("nodemailer");
        const nodemailer = nodemailerMod.default || nodemailerMod;
        const gmailUser = process.env.GMAIL_USER || "tissan2021@gmail.com";
        const gmailPass = process.env.GMAIL_APP_PASSWORD || "";
        if (gmailPass) {
          const transport = nodemailer.createTransport({
            service: "gmail",
            auth: { user: gmailUser, pass: gmailPass },
            // Eugene 2026-05-18 audit: timeout 8s — иначе зависает на медленном SMTP.
            connectionTimeout: 8000,
            socketTimeout: 8000,
            greetingTimeout: 5000,
          });
          const registerLink = `${PUBLIC_URL}/#/register?recovery=${code}`;
          await Promise.race([
            transport.sendMail({
            from: `"MuzaAi" <${gmailUser}>`,
            replyTo: gmailUser,
            to: email,
            subject: `Твой текст «${title}» — MuzaAi`,
            text: `Привет!\n\nМуза сохранила твой текст «${title}». Чтобы забрать его в личный кабинет — заверши регистрацию по ссылке:\n\n${registerLink}\n\nИли введи код восстановления вручную в Настройках после регистрации:\n\n${code}\n\nТекст:\n\n${text}\n\nКод действует 30 дней.\n\n— MuzaAi`,
            html: `
              <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#09090b;border-radius:16px;border:1px solid #1a1a2e;color:#e2e2e2;">
                <div style="text-align:center;margin-bottom:24px;">
                  <span style="font-size:24px;font-weight:700;background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">MuzaAi</span>
                </div>
                <h2 style="color:#fff;margin:0 0 16px;">Твой текст «${title.replace(/</g, "&lt;")}»</h2>
                <p style="font-size:15px;line-height:1.6;">Муза сохранила твой текст. Чтобы забрать его в личный кабинет — заверши регистрацию:</p>
                <div style="text-align:center;margin:24px 0;">
                  <a href="${registerLink}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:#fff;text-decoration:none;border-radius:12px;font-weight:600;">Завершить регистрацию</a>
                </div>
                <p style="font-size:13px;color:#888;text-align:center;margin:16px 0;">Или введи код в Настройках после регистрации:</p>
                <div style="text-align:center;margin:8px 0 24px;">
                  <span style="display:inline-block;font-size:28px;font-weight:700;letter-spacing:8px;color:#fff;background:#1a1a2e;padding:12px 24px;border-radius:8px;">${code}</span>
                </div>
                <hr style="border:none;border-top:1px solid #1a1a2e;margin:24px 0;">
                <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;color:#bbb;line-height:1.6;">${text.slice(0, 4000).replace(/</g, "&lt;")}</pre>
                <p style="color:#555;font-size:12px;text-align:center;margin-top:24px;">Код действует 30 дней.</p>
              </div>
            `,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("SMTP timeout 10s")), 10_000)),
          ]);
          emailSent = true;
          try {
            sqliteDb.prepare(`UPDATE pending_anonymous_lyrics SET email_sent = 1 WHERE id = ?`).run(pendingId);
          } catch {}
        }
      } catch (e: any) {
        console.error("[TOOL save_lyrics_with_email] email send failed:", e?.message || e);
      }

      // Audit-log
      try {
        sqliteDb.prepare(`
          INSERT INTO muza_user_actions (user_id, action_type, params_json, confirmed, confirmed_at, chat_session_id, created_at)
          VALUES (NULL, 'save_lyrics_with_email', ?, 1, ?, ?, ?)
        `).run(JSON.stringify({ pendingId, title, emailMasked: maskEmailStr(email), channel: channel || null, emailSent }), Date.now(), sessionId || null, Date.now());
      } catch {}

      const msg = emailSent
        ? `Отправила на ${email} 📩 Код для восстановления: ${code} (действует 30 дней). Открой письмо — там ссылка чтобы забрать текст после регистрации.`
        : `Сохранила текст. Запомни код восстановления: ${code} (действует 30 дней). Email отправлю позже — пока проверь Спам или регистрируйся вручную и введи код в Настройках.`;

      return JSON.stringify({ success: true, code, emailSent, message: msg });
    } catch (e: any) {
      console.error("[TOOL save_lyrics_with_email]", e);
      return JSON.stringify({ success: false, error: `Не удалось сохранить: ${e?.message || e}` });
    }
  },

  async save_lyrics_with_code_only(input, { sessionId, channel }) {
    const title = String(input?.title || "").trim().slice(0, 120);
    const text = String(input?.text || "").trim().slice(0, 8000);
    if (!title) return JSON.stringify({ success: false, error: "Название не задано" });
    if (!text || text.length < 5) return JSON.stringify({ success: false, error: "Текст слишком короткий" });

    try {
      let code = "";
      let attempts = 0;
      while (attempts < 5) {
        code = String(Math.floor(100000 + Math.random() * 900000));
        const exists = sqliteDb.prepare(
          `SELECT 1 FROM pending_anonymous_lyrics WHERE recovery_code = ? AND claimed_by_user_id IS NULL`
        ).get(code);
        if (!exists) break;
        attempts++;
      }

      const now = Date.now();
      const expires = now + 30 * 24 * 60 * 60 * 1000;
      const result = sqliteDb.prepare(`
        INSERT INTO pending_anonymous_lyrics (recovery_code, email, title, text, chat_session_id, created_at, expires_at, email_sent)
        VALUES (?, NULL, ?, ?, ?, ?, ?, 0)
      `).run(code, title, text, sessionId || null, now, expires);
      const pendingId = Number(result.lastInsertRowid);

      try {
        sqliteDb.prepare(`
          INSERT INTO muza_user_actions (user_id, action_type, params_json, confirmed, confirmed_at, chat_session_id, created_at)
          VALUES (NULL, 'save_lyrics_code_only', ?, 1, ?, ?, ?)
        `).run(JSON.stringify({ pendingId, title, channel: channel || null }), now, sessionId || null, now);
      } catch {}

      return JSON.stringify({
        success: true,
        code,
        message: `Запомни код: ${code}. Действует 30 дней. Введи его в Настройках после регистрации — текст вернётся в кабинет.`,
      });
    } catch (e: any) {
      console.error("[TOOL save_lyrics_with_code_only]", e);
      return JSON.stringify({ success: false, error: `Не удалось сохранить: ${e?.message || e}` });
    }
  },

  async list_user_lyrics(_input, { userId }) {
    if (!userId) return "Юзер не залогинен — список текстов недоступен.";
    try {
      const rows = sqliteDb.prepare(`
        SELECT id, title, text, source, created_at, used_in_generation_id
        FROM user_lyric_drafts
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 20
      `).all(userId) as any[];
      if (rows.length === 0) return "Сохранённых текстов пока нет.";
      const lines = rows.slice(0, 5).map((r, i) => {
        const used = r.used_in_generation_id ? " (использован в треке)" : "";
        return `${i + 1}. «${r.title}»${used}`;
      });
      return `Сохранённых текстов: ${rows.length}. Последние:\n${lines.join("\n")}`;
    } catch (e: any) {
      return `Ошибка: ${e.message}`;
    }
  },

  async propose_registration(input, { userId, sessionId, channel }) {
    const reason = String(input?.reason || "save_lyrics").trim();
    const validReasons = ["save_lyrics", "save_draft", "view_my_tracks", "history"];
    const finalReason = validReasons.includes(reason) ? reason : "save_lyrics";

    // Audit-log предложения регистрации (не подтверждение — confirmed=0)
    try {
      sqliteDb.prepare(`
        INSERT INTO muza_user_actions (user_id, action_type, params_json, confirmed, chat_session_id, created_at)
        VALUES (?, 'propose_registration', ?, 0, ?, ?)
      `).run(userId || null, JSON.stringify({ reason: finalReason, channel: channel || null }), sessionId || null, Date.now());
    } catch {}

    // Возвращаем маркер — extractor в routes.ts его распарсит и отдаст
    // proposedRegistration payload фронту.
    return JSON.stringify({
      success: true,
      marker: `[PROPOSE_REGISTER:reason=${finalReason}]`,
      reason: finalReason,
      message: `Вставь в конец реплики маркер [PROPOSE_REGISTER:reason=${finalReason}] — фронт сам отрисует карточку «Войти / Зарегистрироваться / Дать email».`,
    });
  },

  // Eugene 2026-05-18 Босс «Муза знает всё, но клиентам — только продажи/ЛК/
  // генерация». classify_question — utility: возвращает category + allowed +
  // redirectTo. Используется чтобы Муза могла быстро решить «отвечаю или
  // отправляю на hello@muzaai.ru». Tool безопасен — данные не выгружает,
  // просто словесная классификация по keywords.
  async classify_question({ question }, ctx) {
    const q = String(question || "").toLowerCase().trim();
    if (!q) return JSON.stringify({ category: "other", allowed: false, redirectTo: "support_email" });

    // Admin role — все темы разрешены (override).
    if (isAdminCtx(ctx)) {
      return JSON.stringify({
        category: "admin",
        allowed: true,
        redirectTo: null,
        note: "Юзер — Босс. Все темы разрешены.",
      });
    }

    // Keyword-based classifier. Каждая категория — список характерных слов.
    const RULES: Array<{ category: string; allowed: boolean; redirectTo: string | null; kw: RegExp }> = [
      { category: "sales", allowed: true, redirectTo: null,
        kw: /(цен|стоит|тариф|пакет|акци|промокод|оплат|чек|54-фз|купить|подарочн|подписк|скидк|возврат|реферал)/i },
      { category: "cabinet", allowed: true, redirectTo: null,
        kw: /(кабинет|регистрац|восстанов|войти|логин|пароль|телефон|email|почта|профиль|подтвержд|настройк)/i },
      { category: "generation", allowed: true, redirectTo: null,
        kw: /(трек|песн|сгенер|создать|обложк|стил|жанр|голос|вокал|extend|cover|кавер|bpm|тональн|инструмент|расшир|простой|аудио|текст песни|лирик|караоке|длительност|воспроизвед|плеер|плейлист)/i },
      { category: "support", allowed: true, redirectTo: null,
        kw: /(не работает|ошибк|зависл|висит|пропал|сломал|не могу|потерял|помог|вопрос|связ)/i },
      // Запрещённые зоны:
      { category: "technical", allowed: false, redirectTo: "support_email",
        kw: /(код|архитектур|api|база данн|бд|sql|сервер|деплой|плагин|webhook|gptunnel|suno|anthropic|claude|yandex|robokassa|node|typescript|react|stack|provider|backend|frontend)/i },
      { category: "business", allowed: false, redirectTo: "support_email",
        kw: /(выручк|оборот|маржа|наценк|зарплат|сотрудник|нанимат|инвестор|инвестиц|основател|собственник|бизнес-план|стратеги|roadmap|спринт|инфолайн|компани)/i },
      { category: "other_users", allowed: false, redirectTo: "support_email",
        kw: /(другие юзер|чужие|кто ещё|сколько юзер|сколько клиент|чужой трек|чужие данные|чьи)/i },
      { category: "secrets", allowed: false, redirectTo: "support_email",
        kw: /(токен|ключ.*api|секрет|password|приватн.*ключ|пароль от|env|smtp_pass)/i },
    ];

    for (const r of RULES) {
      if (r.kw.test(q)) {
        return JSON.stringify({
          category: r.category,
          allowed: r.allowed,
          redirectTo: r.redirectTo,
          note: r.allowed
            ? "Можно отвечать — это разрешённая зона."
            : "НЕ выдумывай ответ. Перенаправь на hello@muzaai.ru и мягко переключи на разрешённую тему.",
        });
      }
    }
    // Не попало ни в одно правило — нейтрально разрешаем (просто общение / приветствия / эмоции).
    return JSON.stringify({
      category: "other",
      allowed: true,
      redirectTo: null,
      note: "Нейтральная тема (общение / эмоции). Отвечай тёплым тоном, без выдумывания технических деталей.",
    });
  },

  // Eugene 2026-05-18 Босс «администратору выдаёт всю информацию» — aggregate
  // stats юзеров. ADMIN-ONLY. Не PII — только counts.
  async query_users_stats({ groupBy }, ctx) {
    if (!isAdminCtx(ctx)) return "Доступ запрещён: tool admin-only.";
    const gb = String(groupBy || "all").toLowerCase();
    try {
      const lines: string[] = [];
      if (gb === "all" || gb === "role") {
        const rows = (db as any).$client.prepare(`
          SELECT role, COUNT(*) AS cnt FROM users
          WHERE deleted_at IS NULL OR deleted_at = ''
          GROUP BY role ORDER BY cnt DESC
        `).all();
        lines.push("По ролям:");
        for (const r of rows) lines.push(`  ${r.role || "user"}: ${fmt(r.cnt)}`);
      }
      if (gb === "all" || gb === "channel") {
        const phoneCount = (db as any).$client.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE phone IS NOT NULL AND phone != ''`).get();
        const emailCount = (db as any).$client.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE email IS NOT NULL AND email != '' AND (phone IS NULL OR phone = '')`).get();
        const tgCount = (db as any).$client.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE telegram_id IS NOT NULL AND telegram_id != ''`).get();
        lines.push("По каналу регистрации:");
        lines.push(`  phone: ${fmt(phoneCount?.cnt || 0)}`);
        lines.push(`  только email: ${fmt(emailCount?.cnt || 0)}`);
        lines.push(`  с telegram_id: ${fmt(tgCount?.cnt || 0)}`);
      }
      if (gb === "all" || gb === "country") {
        const rows = (db as any).$client.prepare(`
          SELECT COALESCE(NULLIF(country, ''), '—') AS country, COUNT(*) AS cnt
          FROM users
          WHERE (deleted_at IS NULL OR deleted_at = '')
          GROUP BY country ORDER BY cnt DESC LIMIT 10
        `).all();
        lines.push("По странам (top-10):");
        for (const r of rows) lines.push(`  ${r.country}: ${fmt(r.cnt)}`);
      }
      if (gb === "all" || gb === "status") {
        const blocked = (db as any).$client.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE blocked = 1`).get();
        const active = (db as any).$client.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE (blocked IS NULL OR blocked = 0) AND (deleted_at IS NULL OR deleted_at = '')`).get();
        const verified = (db as any).$client.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE phone_verified = 1`).get();
        lines.push("По статусу:");
        lines.push(`  active: ${fmt(active?.cnt || 0)}`);
        lines.push(`  blocked: ${fmt(blocked?.cnt || 0)}`);
        lines.push(`  phone verified: ${fmt(verified?.cnt || 0)}`);
      }
      const total = (db as any).$client.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE deleted_at IS NULL OR deleted_at = ''`).get();
      lines.unshift(`Всего юзеров: ${fmt(total?.cnt || 0)}`);
      return lines.join("\n");
    } catch (e: any) {
      return `Ошибка query_users_stats: ${e?.message || e}`;
    }
  },

  // Eugene 2026-05-18 Босс «Operator-команды (Ярс)». Прямой вызов backend
  // плагина operator-commands — проверка hash auth + classifier + insert
  // в operator_command_queue. Возвращает {queued, safe, category}.
  // Sync, никогда не throw'ит — feedback в очередь не должен ломать чат.
  async submit_operator_command(input, ctx) {
    try {
      const senderIdentifier = String(input?.senderIdentifier || "").trim().slice(0, 200);
      const text = String(input?.text || "").trim().slice(0, 2000);
      if (!senderIdentifier || !text) return "Нужны senderIdentifier и text.";

      // Lazy-require — operatorAuth + raw insert (то же что делает endpoint
      // /api/admin/v304/operator-commands/incoming, но без HTTP-hop'a — мы
      // на server-side и в той же sqlite-БД).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { isAuthorizedOperator, hashSenderIdentifier, classifyOperatorCommand } = require("./operatorAuth") as typeof import("./operatorAuth");

      if (!isAuthorizedOperator(senderIdentifier)) {
        return "Команда отклонена: оператор не авторизован (hash mismatch).";
      }

      const cls = classifyOperatorCommand(text);
      const now = Date.now();
      const TTL_HOURS = 24;
      const expiresAt = now + TTL_HOURS * 3600 * 1000;
      const senderHash = hashSenderIdentifier(senderIdentifier);
      const chatSessionId = ctx?.sessionId ? String(ctx.sessionId).slice(0, 200) : null;

      const result: any = db.run(sql`
        INSERT INTO operator_command_queue
          (sender_identifier_hash, command_text, category, safe, status,
           source_chat_session, created_at, expires_at)
        VALUES
          (${senderHash}, ${text}, ${cls.category}, ${cls.safe ? 1 : 0},
           'pending', ${chatSessionId}, ${now}, ${expiresAt})
      `);

      const id = Number(result?.lastInsertRowid ?? 0);
      return `Команда #${id} в очереди. Категория: ${cls.category}. Safe: ${cls.safe ? "да" : "нет — требует confirm админа"}. Босс проверит в Admin → 🎙 Команды Ярса.`;
    } catch (e: any) {
      console.error("[TOOL submit_operator_command]", e);
      return `Ошибка submit_operator_command: ${e?.message || e}`;
    }
  },

  // Eugene 2026-05-18 Босс «фидбек юзеров — log_suggestion». Direct insert
  // в client_suggestions (то же что POST /api/feedback/suggestion). Sync,
  // не throw'ит. naiveSentiment / clusterKeyFor вычисляем inline (или
  // принимаем из input.sentiment).
  async log_suggestion(input, ctx) {
    try {
      const text = String(input?.text || "").trim().slice(0, 2000);
      if (!text) return "Нужен text — суть предложения.";
      const category = String(input?.category || "").trim();
      const validCategories = ["feature", "bug", "pricing", "ui", "persona", "other"];
      const cat = validCategories.includes(category) ? category : null;
      const sentiment = typeof input?.sentiment === "number" ? Math.max(-1, Math.min(1, input.sentiment)) : null;

      // Простой cluster key — первые 6 слов нормализованных.
      const cluster = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).slice(0, 6).join(" ").slice(0, 80) || "misc";

      const userId = ctx?.userId ?? null;
      const sessionId = ctx?.sessionId ? String(ctx.sessionId).slice(0, 200) : null;
      const now = Date.now();

      const result: any = db.run(sql`
        INSERT INTO client_suggestions
          (user_id, anonymous_session, category, text, sentiment_score, source,
           chat_session_id, cluster_key, created_at)
        VALUES
          (${userId}, ${userId ? null : sessionId},
           ${cat}, ${text}, ${sentiment}, ${"musa_tool"},
           ${sessionId}, ${cluster}, ${now})
      `);

      const id = Number(result?.lastInsertRowid ?? 0);
      return `Предложение #${id} залогировано${cat ? ` (категория: ${cat})` : ""}. Спасибо за фидбек!`;
    } catch (e: any) {
      console.error("[TOOL log_suggestion]", e);
      return `Ошибка log_suggestion: ${e?.message || e}`;
    }
  },

  // Eugene 2026-05-18 Босс «NPS». Direct insert в nps_log (то же что
  // POST /api/feedback/nps). Score 0..10 обязателен; comment опционален.
  // Sync, не throw'ит.
  async log_nps(input, ctx) {
    try {
      const scoreRaw = Number(input?.score);
      if (!Number.isFinite(scoreRaw)) return "Нужен score (0-10).";
      const score = Math.max(0, Math.min(10, Math.round(scoreRaw)));
      const comment = input?.comment ? String(input.comment).trim().slice(0, 2000) : null;

      const userId = ctx?.userId ?? null;
      const sessionId = ctx?.sessionId ? String(ctx.sessionId).slice(0, 200) : null;
      const now = Date.now();

      const result: any = db.run(sql`
        INSERT INTO nps_log
          (user_id, anonymous_session, score, comment, chat_session_id, created_at, source)
        VALUES
          (${userId}, ${userId ? null : sessionId},
           ${score}, ${comment}, ${sessionId}, ${now}, ${"musa_closing"})
      `);

      const id = Number(result?.lastInsertRowid ?? 0);
      const tone = score >= 9 ? "промоутер" : score >= 7 ? "пассив" : "детрактор";
      return `NPS #${id}: ${score}/10 (${tone}). Спасибо за оценку!`;
    } catch (e: any) {
      console.error("[TOOL log_nps]", e);
      return `Ошибка log_nps: ${e?.message || e}`;
    }
  },

  // === Eugene 2026-05-20: admin-tools для batch-resolve (см. tools выше) ===

  async dismiss_escalation(input, ctx) {
    if (!isAdminCtx(ctx)) return "[ADMIN-ONLY] Нет прав.";
    const id = Number(input?.id);
    const reason = String(input?.reason || "").trim().slice(0, 200);
    if (!Number.isFinite(id) || !reason) return "Нужны id (число) и reason (строка).";
    try {
      const now = Date.now();
      const result: any = db.run(sql`
        UPDATE escalation_queue
        SET status = 'dismissed', dismiss_reason = ${reason},
            resolved_at = ${now}, assigned_to_user_id = ${ctx?.userId ?? null}
        WHERE id = ${id} AND status = 'open'
      `);
      if (!result || result.changes === 0) return `Эскалация #${id} не найдена или уже закрыта.`;
      try {
        recordAuditEntry({
          adminUserId: ctx?.userId ?? null,
          adminEmail: "muza-admin-tool",
          action: "update",
          entity: "escalation_queue:dismiss",
          entityKey: String(id),
          before: { status: "open" },
          after: { status: "dismissed", reason },
        });
      } catch {}
      return `✓ Эскалация #${id} dismissed. Reason: «${reason}».`;
    } catch (e: any) {
      return `Ошибка dismiss_escalation: ${e?.message || e}`;
    }
  },

  async resolve_escalation(input, ctx) {
    if (!isAdminCtx(ctx)) return "[ADMIN-ONLY] Нет прав.";
    const id = Number(input?.id);
    const resolution = String(input?.resolution || "").trim().slice(0, 500);
    if (!Number.isFinite(id) || !resolution) return "Нужны id и resolution.";
    try {
      const now = Date.now();
      const result: any = db.run(sql`
        UPDATE escalation_queue
        SET status = 'resolved', resolution = ${resolution},
            resolved_at = ${now}, assigned_to_user_id = ${ctx?.userId ?? null}
        WHERE id = ${id} AND status = 'open'
      `);
      if (!result || result.changes === 0) return `Эскалация #${id} не найдена или уже закрыта.`;
      try {
        recordAuditEntry({
          adminUserId: ctx?.userId ?? null,
          adminEmail: "muza-admin-tool",
          action: "update",
          entity: "escalation_queue:resolve",
          entityKey: String(id),
          before: { status: "open" },
          after: { status: "resolved", resolution },
        });
      } catch {}
      return `✓ Эскалация #${id} resolved: «${resolution}».`;
    } catch (e: any) {
      return `Ошибка resolve_escalation: ${e?.message || e}`;
    }
  },

  async mark_suggestion_reviewed(input, ctx) {
    if (!isAdminCtx(ctx)) return "[ADMIN-ONLY] Нет прав.";
    const id = Number(input?.id);
    const note = String(input?.note || "").trim().slice(0, 500);
    if (!Number.isFinite(id) || !note) return "Нужны id и note.";
    try {
      const now = Date.now();
      const result: any = db.run(sql`
        UPDATE client_suggestions
        SET reviewed = 1, review_note = ${note}, reviewed_at = ${now},
            reviewed_by_user_id = ${ctx?.userId ?? null}
        WHERE id = ${id} AND (reviewed IS NULL OR reviewed = 0)
      `);
      if (!result || result.changes === 0) return `Предложение #${id} не найдено или уже просмотрено.`;
      try {
        recordAuditEntry({
          adminUserId: ctx?.userId ?? null,
          adminEmail: "muza-admin-tool",
          action: "update",
          entity: "client_suggestions:reviewed",
          entityKey: String(id),
          before: { reviewed: 0 },
          after: { reviewed: 1, note },
        });
      } catch {}
      return `✓ Предложение #${id} отмечено как просмотренное. Заметка: «${note}».`;
    } catch (e: any) {
      return `Ошибка mark_suggestion_reviewed: ${e?.message || e}`;
    }
  },

  // === Eugene 2026-05-20: cabinet/playlist management (auth required) ===

  async rename_my_track(input, ctx) {
    if (!ctx?.userId) return "Юзер не залогинен. Предложи войти в кабинет.";
    const genId = Number(input?.genId);
    const newTitle = String(input?.newTitle || "").trim().slice(0, 120);
    if (!Number.isFinite(genId) || !newTitle) return "Нужны genId (число) и newTitle (1-120).";
    try {
      const gen = db.select().from(generations).where(eq(generations.id, genId)).get() as any;
      if (!gen) return `Трек #${genId} не найден.`;
      if (gen.userId !== ctx.userId) return "Этот трек не твой — нельзя переименовывать чужие.";
      const oldTitle = gen.displayTitle;
      db.update(generations).set({ displayTitle: newTitle }).where(eq(generations.id, genId)).run();
      try {
        recordAuditEntry({
          adminUserId: ctx.userId,
          adminEmail: "muza-self-service",
          action: "update",
          entity: "generation:title",
          entityKey: String(genId),
          before: { displayTitle: oldTitle },
          after: { displayTitle: newTitle },
        });
      } catch {}
      return `✓ Трек #${genId} переименован: «${oldTitle}» → «${newTitle}».`;
    } catch (e: any) {
      return `Ошибка rename_my_track: ${e?.message || e}`;
    }
  },

  async set_my_track_category(input, ctx) {
    if (!ctx?.userId) return "Юзер не залогинен.";
    const genId = Number(input?.genId);
    const category = String(input?.category || "");
    if (!["song", "greeting", "instrumental"].includes(category)) return "category должен быть song / greeting / instrumental.";
    if (!Number.isFinite(genId)) return "Нужен genId.";
    try {
      const gen = db.select().from(generations).where(eq(generations.id, genId)).get() as any;
      if (!gen) return `Трек #${genId} не найден.`;
      if (gen.userId !== ctx.userId) return "Не твой трек.";
      if (gen.type !== "music") return "Категорию можно менять только у треков (type=music).";
      // Категория в style.category (JSON), не отдельная колонка. См.
      // /api/generations/:id/category в routes.ts (тот же паттерн).
      let meta: any = {};
      try { meta = JSON.parse(gen.style || "{}"); } catch {}
      const oldCat = meta.category || "song";
      meta.category = category;
      const newVoiceType = category === "instrumental"
        ? "instrumental"
        : (gen.voiceType === "instrumental" ? null : gen.voiceType);
      db.update(generations)
        .set({ style: JSON.stringify(meta), voiceType: newVoiceType })
        .where(eq(generations.id, genId))
        .run();
      try {
        recordAuditEntry({
          adminUserId: ctx.userId,
          adminEmail: "muza-self-service",
          action: "update",
          entity: "generation:category",
          entityKey: String(genId),
          before: { category: oldCat },
          after: { category },
        });
      } catch {}
      return `✓ Категория трека #${genId}: ${oldCat} → ${category}.`;
    } catch (e: any) {
      return `Ошибка set_my_track_category: ${e?.message || e}`;
    }
  },

  async set_my_track_visibility(input, ctx) {
    if (!ctx?.userId) return "Юзер не залогинен.";
    const genId = Number(input?.genId);
    const visibility = String(input?.visibility || "");
    // По Two-playlist rule: main только через челофильтр/админа.
    // Автор может сам поставить только private (0) или new_authors (2).
    if (!["private", "new_authors"].includes(visibility)) {
      return "visibility должен быть private (только в кабинете) или new_authors (в Новые авторы). Перевод в основной плейлист — только через челофильтр (>50 play/24ч) или админ.";
    }
    if (!Number.isFinite(genId)) return "Нужен genId.";
    const isPublicNew = visibility === "private" ? 0 : 2;
    try {
      const gen = db.select().from(generations).where(eq(generations.id, genId)).get() as any;
      if (!gen) return `Трек #${genId} не найден.`;
      if (gen.userId !== ctx.userId) return "Не твой трек.";
      const oldVis = gen.isPublic;
      db.update(generations).set({ isPublic: isPublicNew }).where(eq(generations.id, genId)).run();
      try {
        recordAuditEntry({
          adminUserId: ctx.userId,
          adminEmail: "muza-self-service",
          action: "update",
          entity: "generation:visibility",
          entityKey: String(genId),
          before: { isPublic: oldVis },
          after: { isPublic: isPublicNew },
        });
      } catch {}
      return `✓ Трек #${genId}: ${oldVis === 0 ? "private" : oldVis === 1 ? "main" : "new_authors"} → ${visibility}.`;
    } catch (e: any) {
      return `Ошибка set_my_track_visibility: ${e?.message || e}`;
    }
  },

  async update_my_profile(input, ctx) {
    if (!ctx?.userId) return "Юзер не залогинен.";
    const name = input?.name ? String(input.name).trim().slice(0, 80) : null;
    const country = input?.country ? String(input.country).trim().slice(0, 80) : null;
    if (!name && !country) return "Не указано ни одно поле для обновления.";
    try {
      const u = db.select().from(users).where(eq(users.id, ctx.userId)).get() as any;
      if (!u) return "Юзер не найден.";
      const updates: Record<string, any> = {};
      if (name) updates.name = name;
      if (country) updates.country = country;
      const setSql = Object.keys(updates).map(k => `${k.replace(/[A-Z]/g, m => "_" + m.toLowerCase())} = ?`).join(", ");
      const values = Object.values(updates);
      sqliteDb.prepare(`UPDATE users SET ${setSql} WHERE id = ?`).run(...values, ctx.userId);
      try {
        recordAuditEntry({
          adminUserId: ctx.userId,
          adminEmail: "muza-self-service",
          action: "update",
          entity: "user:profile",
          entityKey: String(ctx.userId),
          before: { name: u.name, country: u.country },
          after: updates,
        });
      } catch {}
      return `✓ Профиль обновлён: ${Object.entries(updates).map(([k,v]) => `${k}=«${v}»`).join(", ")}.`;
    } catch (e: any) {
      return `Ошибка update_my_profile: ${e?.message || e}`;
    }
  },

  async issue_invoice(input, ctx) {
    if (!ctx?.userId) return "Юзер не залогинен — счёт выписать некому.";
    const tariff = String(input?.tariff || "").trim();
    const description = String(input?.description || "").trim().slice(0, 200);
    const customAmountRub = Number(input?.amountRub);
    if (!tariff || !description) return "Нужны tariff и description.";
    // Tariff lookup
    const TARIFFS: Record<string, { amountRub: number; tariffKey: string }> = {
      track_399: { amountRub: 399, tariffKey: "track_399" },
      premium_voice_msg: { amountRub: 199, tariffKey: "premium_voice_msg" },
      topup_500: { amountRub: 500, tariffKey: "topup_500" },
      topup_1000: { amountRub: 1000, tariffKey: "topup_1000" },
      topup_2000: { amountRub: 2000, tariffKey: "topup_2000" },
    };
    let amountRub: number;
    let tariffKey: string;
    if (tariff === "custom") {
      if (!Number.isFinite(customAmountRub) || customAmountRub < 1 || customAmountRub > 50000) return "Для custom-тарифа нужен amountRub (1-50000).";
      amountRub = Math.round(customAmountRub);
      tariffKey = "custom";
    } else {
      const t = TARIFFS[tariff];
      if (!t) return `Неизвестный tariff. Доступные: ${Object.keys(TARIFFS).join(", ")} | custom.`;
      amountRub = t.amountRub;
      tariffKey = t.tariffKey;
    }
    try {
      // Insert invoice (proforma). Robokassa-URL генерируется в отдельном
      // endpoint /api/invoice/:id/pay-link чтобы можно было ротировать
      // signature без переписи всех старых счетов.
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const meta = JSON.stringify({ chat_session_id: ctx.sessionId ?? null });
      const result: any = sqliteDb.prepare(`
        INSERT INTO invoices
          (user_id, issued_by, amount_rub, description, tariff_key, status, expires_at, meta)
        VALUES (?, 'muza', ?, ?, ?, 'issued', ?, ?)
      `).run(ctx.userId, amountRub, description, tariffKey, expiresAt, meta);
      const invoiceId = Number(result?.lastInsertRowid ?? 0);
      const payUrl = `${PUBLIC_URL}/api/invoice/${invoiceId}/pay`;
      try {
        recordAuditEntry({
          adminUserId: ctx.userId,
          adminEmail: "muza-self-service",
          action: "create",
          entity: "invoice",
          entityKey: String(invoiceId),
          before: null,
          after: { tariff: tariffKey, amountRub, description },
        });
      } catch {}
      return `✓ Счёт #${invoiceId} выписан: ${amountRub}₽ — «${description}». Оплата: ${payUrl}. Действует 24ч.`;
    } catch (e: any) {
      return `Ошибка issue_invoice: ${e?.message || e}`;
    }
  },

  async get_my_subscriptions(_input, ctx) {
    if (!ctx?.userId) return "Юзер не залогинен.";
    try {
      const rows = sqliteDb.prepare(`
        SELECT id, tier, status, started_at, expires_at, invoice_id
        FROM premium_subscriptions
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 10
      `).all(ctx.userId) as any[];
      if (rows.length === 0) return "У тебя пока нет подписок. Если хочешь — могу выписать счёт на premium_voice_msg (199 ₽/мес).";
      const active = rows.filter(r => r.status === "active");
      const lines = rows.slice(0, 5).map(r => `#${r.id} ${r.tier} — ${r.status}${r.expires_at ? ` (до ${String(r.expires_at).slice(0, 10)})` : ""}`);
      return `Подписки: ${active.length} активных из ${rows.length}.\n${lines.join("\n")}`;
    } catch (e: any) {
      return `Ошибка get_my_subscriptions: ${e?.message || e}`;
    }
  },
};

// === Admin tools runtime state (Eugene 2026-05-17) ===
// Простой in-memory state для пары runtime-флагов которые Муза может крутить
// через admin-voice. Эффект только в текущем процессе — это by design (для
// постоянного — Босс правит .env и pm2 restart).

let runtimeBotPaused = false;

export function isBotPausedRuntime(): boolean {
  return runtimeBotPaused;
}

function isAdminCtx(ctx: ToolContext): boolean {
  const role = String(ctx?.role || "").toLowerCase();
  return role === "admin" || role === "super_admin";
}

/**
 * Записывает audit-entry для admin-action подтверждённого через email 2FA.
 * Содержит метаданные (action / entity / before / after / pending_action_id),
 * via_email_confirm=1. PII (полные emails / phones / списки юзеров)
 * НЕ кладём — только что меняли и счётчик/preview результата.
 *
 * Использует общий recordAuditEntry helper из lib/adminAuditLog.ts.
 * Sole-fire — никогда не throw'ит, audit-failure не должен ломать tool.
 *
 * Note: ip/user_agent для admin-voice channel недоступны напрямую в
 * ToolContext (Muza tools не получают req). Они хранятся в pending запись
 * (admin_pending_actions.ip / .user_agent) на момент initiate — это
 * операционно достаточно для security forensics.
 */
function writeAuditFor2FA(
  pendingActionId: string,
  ctx: ToolContext,
  _action: string,
  entity: string,
  entityKey: string,
  resultText: string,
  delta?: { before?: unknown; after?: unknown; [k: string]: unknown },
): void {
  // Lazy require to avoid circular import at module-load time.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { recordAuditEntry } = require("./adminAuditLog") as typeof import("./adminAuditLog");
  const userId = Number(ctx?.userId) || null;
  const before = delta?.before !== undefined ? { value: delta.before } : undefined;
  const after = delta !== undefined
    ? { ...delta, result: String(resultText || "").slice(0, 300) }
    : { result: String(resultText || "").slice(0, 300) };
  recordAuditEntry({
    adminUserId: userId,
    action: "update",
    entity,
    entityKey: String(entityKey || "").slice(0, 200),
    before,
    after,
    viaEmailConfirm: true,
    pendingActionId,
  });
}

function maskEmailStr(email: string | null | undefined): string {
  const s = String(email || "");
  const at = s.indexOf("@");
  if (at <= 0) return s ? `${s.slice(0, 3)}***` : "—";
  return `${s.slice(0, Math.min(3, at))}***${s.slice(at)}`;
}

function maskPhoneStr(phone: string | null | undefined): string {
  const s = String(phone || "").replace(/\s+/g, "");
  if (!s) return "—";
  if (s.length < 6) return `${s.slice(0, 2)}***`;
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

// === Helpers (Eugene 2026-05-16) ===

function inferTariff(u: any): string {
  const role = String(u?.role || "user");
  if (role === "admin" || role === "super_admin") return "Админ";
  const bonus = (u?.bonusTracks || 0) > 0;
  const balance = (u?.balance || 0) > 0;
  if (bonus && balance) return "Активный (подарочный + баланс)";
  if (bonus) return "Подарочный трек";
  if (balance) return "Платный (с балансом)";
  return "Стандартный (бесплатный)";
}

function splitMarkdownSections(text: string): { section: string; text: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { section: string; text: string }[] = [];
  let curSection = "Введение";
  let buf: string[] = [];
  const flush = () => {
    if (buf.length > 0) {
      const body = buf.join("\n").trim();
      if (body.length > 20) out.push({ section: curSection, text: body });
    }
    buf = [];
  };
  for (const ln of lines) {
    const m = ln.match(/^#{1,4}\s+(.+?)\s*$/);
    if (m) {
      flush();
      curSection = m[1].slice(0, 100);
    } else {
      buf.push(ln);
    }
  }
  flush();
  return out;
}

// Eugene 2026-05-21 Босс Chat-tool-calling MVP: некоторые tools делают
// внешний HTTP-вызов к GPTunnel (Suno /media/create ≈ 5-25 сек, lyrics
// /chat/completions ≈ 5-15 сек) — для них timeout повышен до 35 сек.
// Дефолт остаётся 8 сек для in-process tools (DB queries / геолокация).
const LONG_TOOL_TIMEOUTS: Record<string, number> = {
  generate_lyrics: 35_000,
  rewrite_lyrics: 35_000,
  create_music_job: 35_000,
};

export async function executeTool(name: string, input: any, context: ToolContext): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) return `Tool "${name}" not found.`;
  const timeoutMs = LONG_TOOL_TIMEOUTS[name] ?? 8_000;
  try {
    return await Promise.race<string>([
      handler(input || {}, context),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(`tool timeout ${timeoutMs / 1000}s: ${name}`)), timeoutMs),
      ),
    ]);
  } catch (e: any) {
    console.error(`[TOOL ${name}]`, e?.message || e);
    return `Tool "${name}" вернул ошибку. Продолжай без него и ответь юзеру тем что знаешь.`;
  }
}

// Eugene 2026-05-17 Босс «не показывать админские tools обычному юзеру».
// Tools у которых description начинается с "[ADMIN-ONLY" — отдаются только
// каналам где role='admin'/'super_admin' (voice-admin). Обычные каналы
// (web/telegram/max) получают чистый набор user-tools — это снижает шум
// в Claude tool-selection и убирает риск что LLM попытается вызвать
// админский tool (хотя в нём всё равно стоит isAdminCtx-guard).
const ADMIN_TOOL_MARKER = /^\s*\[ADMIN-ONLY/i;

export function filterToolsForRole(role: string | null | undefined): ToolDef[] {
  const r = String(role || "").toLowerCase();
  const isAdmin = r === "admin" || r === "super_admin";
  if (isAdmin) return MUZA_TOOLS;
  return MUZA_TOOLS.filter((t) => !ADMIN_TOOL_MARKER.test(t.description));
}

// Eugene 2026-05-21 Босс «чат-бот с tool calling — диалоговое управление
// генерацией». Подключаем CHAT_GENERATION_TOOLS (generate_lyrics / rewrite_lyrics
// / create_music_job / get_generation_status / list_recent_assets /
// get_asset_details / publish_asset / cancel_generation_job) после описания
// HANDLERS / MUZA_TOOLS — мутируем (массив/объект extensible, const lock
// касается только rebinding). Это позволяет LLM через /api/muza/chat
// вызывать генерацию музыки и текста прямо из диалога с approval flow.
// Подробнее: lib/chatGenerationTools.ts + Chat-tool-calling rule в CLAUDE.md.
import { CHAT_GENERATION_TOOLS, CHAT_GENERATION_HANDLERS } from "./chatGenerationTools";
for (const td of CHAT_GENERATION_TOOLS) MUZA_TOOLS.push(td);
Object.assign(HANDLERS, CHAT_GENERATION_HANDLERS);
