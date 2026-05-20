// v304: Муза доложит (Eugene 2026-05-17 Босс «TTS озвучка важной информации
// в admin panel через Yandex SpeechKit»).
//
// Этот модуль НЕ дёргает Yandex напрямую — он только собирает русский текст
// доклада из snapshot'а dashboard-summary. Озвучка делается отдельным endpoint
// '/api/admin/v304/tts' через Yandex SpeechKit TTS.
//
// Тон: коротко, по-деловому, обращение «Босс». Без «здравствуйте, как у вас
// дела» — это доклад, не светская беседа. Числа округлены до целых.
//
// Pre-edit analysis:
//  - Используется только в master-dashboard plugin (один call-site).
//  - Не модифицирует данные — pure function над snapshot'ом.
//  - Никаких внешних запросов, никаких side-effects.

export interface DashboardStatusCardLite {
  key: string;
  label: string;
  emoji?: string;
  status: "green" | "yellow" | "red" | "unknown";
  metric?: string;
}

export interface DashboardMetricsLite {
  plays?: { total?: number; unique?: number };
  downloads?: { count?: number };
  registrations?: { total?: number };
  generations?: {
    music?: { done?: number; error?: number };
    lyrics?: { done?: number };
    cover?: { done?: number };
  };
  payments?: { count?: number; sumKopecks?: number };
  visitors?: { unique?: number };
}

export interface BriefingSource {
  period?: string;             // 'today' | '7d' | '30d' | 'all'
  statusCards?: DashboardStatusCardLite[];
  metrics?: DashboardMetricsLite;
}

const PERIOD_RU: Record<string, string> = {
  today: "за сегодня",
  "7d": "за последние семь дней",
  "30d": "за последние тридцать дней",
  all: "за всё время",
};

function num(n: number | undefined | null): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(", ") + " и " + items[items.length - 1];
}

/**
 * Собирает русский доклад для TTS-озвучки.
 *
 * Eugene 2026-05-20 Босс «расширь доклад, в сухом режиме без деталей,
 * по мере уменьшения». Расширено с 4-7 до всех значимых метрик. Сортируется
 * по убыванию value. Robokassa-блок скрывается пока ROBO_PASSWORD_1 пуст.
 */
export function buildAdminBriefing(src: BriefingSource): string {
  const parts: string[] = [];
  const period = PERIOD_RU[src.period || ""] || "за последние семь дней";

  parts.push("Босс, доклад", `${period}.`);
  parts.push("Сухо, по убыванию.");

  // === Состояние систем (коротко: сколько зелёных / жёлтых / красных) ===
  const cards = Array.isArray(src.statusCards) ? src.statusCards : [];

  // Eugene 2026-05-20: убираем Robokassa пока ключи не подключены —
  // карточка "payments" перегружает доклад если ROBO_PASSWORD_1 пуст.
  const roboConfigured = Boolean((process.env.ROBO_PASSWORD_1 || "").trim());
  const filteredCards = cards.filter((c) => {
    if (roboConfigured) return true;
    const k = String(c.key || "").toLowerCase();
    const l = String(c.label || "").toLowerCase();
    return !(k.includes("payment") || k.includes("robokassa") || l.includes("платеж") || l.includes("robo"));
  });

  const red = filteredCards.filter((c) => c.status === "red");
  const yellow = filteredCards.filter((c) => c.status === "yellow");
  const green = filteredCards.filter((c) => c.status === "green");

  if (red.length === 0 && yellow.length === 0 && filteredCards.length > 0) {
    parts.push(`Все ${filteredCards.length} ${pluralRu(filteredCards.length, "система", "системы", "систем")} зелёные.`);
  } else {
    if (red.length > 0) {
      parts.push(`Красных: ${red.length} — ${joinList(red.map((c) => c.label))}.`);
    }
    if (yellow.length > 0) {
      parts.push(`Жёлтых: ${yellow.length} — ${joinList(yellow.map((c) => c.label))}.`);
    }
    if (green.length > 0) {
      parts.push(`Зелёных: ${green.length}.`);
    }
  }

  // === Метрики по убыванию (sort desc by value) ===
  const m = src.metrics || {};
  type MetricBit = { value: number; phrase: string };
  const bits: MetricBit[] = [];

  const push = (value: number, phrase: string) => {
    if (value > 0) bits.push({ value, phrase });
  };

  push(num(m.visitors?.unique), `${num(m.visitors?.unique)} ${pluralRu(num(m.visitors?.unique), "посетитель", "посетителя", "посетителей")}`);
  push(num(m.plays?.total), `${num(m.plays?.total)} ${pluralRu(num(m.plays?.total), "прослушивание", "прослушивания", "прослушиваний")}`);
  push(num(m.plays?.unique), `${num(m.plays?.unique)} уникальных слушателей`);
  push(num(m.downloads?.count), `${num(m.downloads?.count)} ${pluralRu(num(m.downloads?.count), "скачивание", "скачивания", "скачиваний")}`);
  push(num(m.registrations?.total), `${num(m.registrations?.total)} ${pluralRu(num(m.registrations?.total), "регистрация", "регистрации", "регистраций")}`);

  const musicDone = num(m.generations?.music?.done);
  const lyricsDone = num(m.generations?.lyrics?.done);
  const coverDone = num(m.generations?.cover?.done);
  push(musicDone, `${musicDone} ${pluralRu(musicDone, "трек", "трека", "треков")} сгенерировано`);
  push(lyricsDone, `${lyricsDone} ${pluralRu(lyricsDone, "текст", "текста", "текстов")}`);
  push(coverDone, `${coverDone} ${pluralRu(coverDone, "обложка", "обложки", "обложек")}`);

  const errMusic = num(m.generations?.music?.error);
  push(errMusic, `${errMusic} ${pluralRu(errMusic, "ошибка", "ошибки", "ошибок")} генерации`);

  // === Платежи — только если Robokassa подключена ===
  if (roboConfigured) {
    const payCount = num(m.payments?.count);
    const payKop = num(m.payments?.sumKopecks);
    if (payCount > 0) {
      push(payCount, `${payCount} ${pluralRu(payCount, "оплата", "оплаты", "оплат")}`);
    }
    if (payKop > 0) {
      const rub = Math.round(payKop / 100);
      push(rub, `${rub} ${pluralRu(rub, "рубль", "рубля", "рублей")} выручки`);
    }
  }

  // Sort desc by value, output all (по правилу «пока не доест»).
  bits.sort((a, b) => b.value - a.value);
  if (bits.length > 0) {
    parts.push(bits.map((b) => b.phrase).join(". ") + ".");
  } else {
    parts.push("Метрики нулевые.");
  }

  parts.push("Доклад окончен.");
  return parts.filter(Boolean).join(" ");
}

// === Русские числительные ===
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}
