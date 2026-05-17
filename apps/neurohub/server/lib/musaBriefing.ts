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
 * Собирает короткий русский доклад для TTS-озвучки.
 * Текст: 4-7 предложений, ~30-60 секунд при чтении голосом alena.
 */
export function buildAdminBriefing(src: BriefingSource): string {
  const parts: string[] = [];
  const period = PERIOD_RU[src.period || ""] || "за последние семь дней";

  parts.push("Здравствуй, Босс. Это Муза с докладом.");

  // === Состояние систем ===
  const cards = Array.isArray(src.statusCards) ? src.statusCards : [];
  const red = cards.filter((c) => c.status === "red");
  const yellow = cards.filter((c) => c.status === "yellow");

  if (red.length === 0 && yellow.length === 0 && cards.length > 0) {
    parts.push("Все системы работают нормально.");
  } else {
    if (red.length > 0) {
      const names = joinList(red.map((c) => c.label));
      parts.push(`Внимание: проблемы в группах ${names}.`);
    }
    if (yellow.length > 0) {
      const names = joinList(yellow.map((c) => c.label));
      parts.push(`Предупреждения по группам ${names}.`);
    }
  }

  // === Метрики ===
  const m = src.metrics || {};
  const metricBits: string[] = [];
  const regs = num(m.registrations?.total);
  if (regs > 0) metricBits.push(`${regs} ${pluralRu(regs, "регистрация", "регистрации", "регистраций")}`);
  const plays = num(m.plays?.total);
  if (plays > 0) metricBits.push(`${plays} ${pluralRu(plays, "прослушивание", "прослушивания", "прослушиваний")}`);
  const gens =
    num(m.generations?.music?.done) +
    num(m.generations?.lyrics?.done) +
    num(m.generations?.cover?.done);
  if (gens > 0) metricBits.push(`${gens} ${pluralRu(gens, "генерация", "генерации", "генераций")}`);
  const visits = num(m.visitors?.unique);
  if (visits > 0) metricBits.push(`${visits} ${pluralRu(visits, "посетитель", "посетителя", "посетителей")}`);

  if (metricBits.length > 0) {
    parts.push(`${capitalize(period)}: ${joinList(metricBits)}.`);
  }

  // === Платежи ===
  const payCount = num(m.payments?.count);
  const payKop = num(m.payments?.sumKopecks);
  if (payCount > 0 || payKop > 0) {
    const rub = Math.round(payKop / 100);
    parts.push(
      `Оплат ${payCount} на сумму ${rub} ${pluralRu(rub, "рубль", "рубля", "рублей")}.`,
    );
  }

  // === Ошибки генераций ===
  const errMusic = num(m.generations?.music?.error);
  if (errMusic > 0) {
    parts.push(`Ошибок генерации музыки: ${errMusic}. Проверь refund pipeline.`);
  }

  parts.push("Доклад окончен.");
  return parts.join(" ");
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
