// Funnel definitions (Eugene 2026-05-17 Босс «воронки конверсии — где
// юзеры проседают»).
//
// Каждая воронка — упорядоченный список шагов. Каждый шаг — конкретный
// SQL-фильтр над одной из таблиц-источников (user_journey_events,
// sms_provider_logs, users, generations, gen_activity, payments,
// engagement_events). Конверсия = count[i] / count[i-1].
//
// Привязка к session_key:
//   user_journey_events.session_key — для всех front-end шагов
//   users.id — для регистраций / phone_verified
//   generations.user_id, payments.user_id — для последующих action'ов
//   ip (gen_activity) — для слушаний без авторизации
//
// Мы НЕ требуем чтобы все шаги использовали одинаковый join-key — каждый шаг
// возвращает свой count независимо. Это упрощение: считаем «сколько прошли
// этот этап» без cohort-tracking (а-ля Mixpanel). Для cross-step retention
// в будущем добавим cohort_key, сейчас простой funnel.
//
// SQL-фильтры — read-only, всегда параметризованы через ${since} placeholder.
// `since` подставляется ISO-датой в endpoint'е, фильтр должен содержать
// `created_at >= '${since}'` или эквивалент.

export interface FunnelStepDef {
  /** Стабильный id шага, не меняется (используется как ключ кэша/UI/snapshot). */
  id: string;
  /** Человекочитаемое название (RU). */
  label: string;
  /** Таблица-источник. */
  source:
    | "user_journey_events"
    | "sms_provider_logs"
    | "users"
    | "generations"
    | "gen_activity"
    | "payments"
    | "engagement_events";
  /**
   * SQL WHERE-фильтр (без префикса `WHERE`). Подставляется в SELECT count(*).
   * Должен включать дату-фильтр относительно `created_at` (или эквивалентного
   * timestamp поля таблицы). Endpoint добавляет ` AND created_at >= ?` если
   * фильтр сам не содержит даты, но рекомендуется писать явно.
   */
  filter: string;
  /**
   * Поле для подсчёта уникальных сущностей (DISTINCT). Если не задано —
   * считаем COUNT(*).
   */
  distinct?: string;
}

export interface FunnelDef {
  id: string;
  name: string;
  description: string;
  steps: FunnelStepDef[];
}

// Все имена ключей snake_case в lower (для устойчивости URL).
export const FUNNELS: Record<string, FunnelDef> = {
  phone_registration: {
    id: "phone_registration",
    name: "Регистрация по телефону",
    description:
      "От захода на /register-phone или /login-phone до попадания в /dashboard. " +
      "Включает дозвон через flashcall + ввод кода + создание сессии.",
    steps: [
      {
        id: "landed",
        label: "Зашёл на /register-phone или /login-phone",
        source: "user_journey_events",
        filter:
          "event_type='page_view' AND page IN ('/register-phone','/login-phone')",
        distinct: "session_key",
      },
      {
        id: "phone_entered",
        label: "Ввёл номер телефона",
        source: "user_journey_events",
        // Любой click на странице регистрации/логина — упрощение.
        // Реальное «отправил номер» = click по primary CTA с label «Получить код»
        // или «Позвонить». Метки могут отличаться, поэтому берём все clicks.
        filter:
          "event_type='click' AND page IN ('/register-phone','/login-phone')",
        distinct: "session_key",
      },
      {
        id: "call_received",
        label: "Дозвонился / получил SMS (provider OK)",
        source: "sms_provider_logs",
        filter:
          "status='ok' AND (purpose LIKE 'call_%' OR purpose IN ('register','login'))",
      },
      {
        id: "verified",
        label: "Подтвердил код (phone_verified=1)",
        source: "users",
        // Берём только тех, у кого phone_verified=1 И регистрация попадает
        // в выбранный период. created_at — момент создания юзера.
        filter: "phone_verified=1 AND phone IS NOT NULL",
      },
      {
        id: "dashboard",
        label: "Дошёл до /dashboard",
        source: "user_journey_events",
        filter: "event_type='page_view' AND page='/dashboard'",
        distinct: "session_key",
      },
    ],
  },

  email_registration: {
    id: "email_registration",
    name: "Регистрация по email",
    description:
      "От захода на /login или /register до подтверждения email и попадания " +
      "в /dashboard. Альтернативный путь регистрации (без телефона).",
    steps: [
      {
        id: "landed",
        label: "Зашёл на /login или /register",
        source: "user_journey_events",
        filter:
          "event_type='page_view' AND page IN ('/login','/register')",
        distinct: "session_key",
      },
      {
        id: "email_form_focus",
        label: "Сфокусировался на форме",
        source: "user_journey_events",
        filter:
          "event_type='form_focus' AND page IN ('/login','/register')",
        distinct: "session_key",
      },
      {
        id: "email_submitted",
        label: "Нажал «Войти / Зарегистрироваться»",
        source: "user_journey_events",
        filter:
          "event_type='click' AND page IN ('/login','/register')",
        distinct: "session_key",
      },
      {
        id: "verified",
        label: "Создан аккаунт (есть email или без верификации)",
        source: "users",
        filter:
          "(phone_verified=0 OR phone_verified IS NULL) AND email IS NOT NULL AND email != ''",
      },
      {
        id: "dashboard",
        label: "Дошёл до /dashboard",
        source: "user_journey_events",
        filter: "event_type='page_view' AND page='/dashboard'",
        distinct: "session_key",
      },
    ],
  },

  track_creation: {
    id: "track_creation",
    name: "Создание трека",
    description:
      "От захода на /music до прослушивания собственного готового трека. " +
      "Ключевая воронка платной активации: оплата начинается после первой " +
      "успешной генерации.",
    steps: [
      {
        id: "landed_music",
        label: "Зашёл на /music",
        source: "user_journey_events",
        filter: "event_type='page_view' AND page='/music'",
        distinct: "session_key",
      },
      {
        id: "filled_form",
        label: "Сфокусировался на форме генерации",
        source: "user_journey_events",
        filter: "event_type='form_focus' AND page='/music'",
        distinct: "session_key",
      },
      {
        id: "submitted",
        label: "Нажал «Создать» (click на /music)",
        source: "user_journey_events",
        filter: "event_type='click' AND page='/music'",
        distinct: "session_key",
      },
      {
        id: "completed",
        label: "Трек завершён (status='done')",
        source: "generations",
        filter:
          "type='music' AND status='done' AND deleted_at IS NULL",
      },
      {
        id: "listened",
        label: "Слушал ≥5 сек (gen_activity.action='play')",
        source: "gen_activity",
        filter: "action='play'",
      },
    ],
  },

  payment: {
    id: "payment",
    name: "Оплата",
    description:
      "От клика по «Пополнить» до успешной оплаты Robokassa. Включает " +
      "переход на робокассу (payment created) и финальный paid-callback.",
    steps: [
      {
        id: "click_pay",
        label: "Кликнул кнопку оплаты",
        source: "user_journey_events",
        // Эвристика: click на странице с словом 'pay'/'оплат' в data-track
        // или на странице /balance / /pricing. user-journey пишет meta.dataTrack
        // / meta.text.
        filter:
          "event_type='click' AND (page IN ('/balance','/pricing','/music','/dashboard') AND (" +
          "json_extract(meta, '$.dataTrack') LIKE '%pay%' OR " +
          "json_extract(meta, '$.text') LIKE '%Пополни%' OR " +
          "json_extract(meta, '$.text') LIKE '%Оплат%'))",
        distinct: "session_key",
      },
      {
        id: "redirect_robokassa",
        label: "Платёж создан (redirect в Robokassa)",
        source: "payments",
        // Все записи в payments — это уже «создан платёж» (pending).
        filter: "1=1",
      },
      {
        id: "success",
        label: "Успешная оплата (status='paid')",
        source: "payments",
        filter: "status='paid'",
      },
    ],
  },
};

export type FunnelId = keyof typeof FUNNELS;

export function listFunnelIds(): string[] {
  return Object.keys(FUNNELS);
}

export function getFunnelDef(id: string): FunnelDef | null {
  return FUNNELS[id] ?? null;
}
