// Eugene 2026-05-24 Босс «Оркестратор переименуем Музa Директор. Он контролирует
// всех агентов, собирает всю информацию, итоговую докладывает через аудио. По
// умолчанию все данные в админ-панели — сегодня».
//
// Музa Директор — итоговый доклад через аудио. Собирает state со всех agents,
// формирует structured text-summary для voice TTS, возвращает audio (через
// existing Yandex SpeechKit wrapper).
//
// Pre-edit analysis:
//  - Reuse-working-solutions rule: используем existing
//    * `orchestrator.summary()` + `list()` + `getLastHealth()`
//    * `getStats()` из genLifecycleAgent
//    * `getMarketingStats()` + `getDengaAgentStats()`  (lazy import — избегаем циклов)
//    * `synthesizeYandexTts()` для аудио
//    * `getPeriodRange()` из periodBoundaries (Period-20-MSK rule)
//  - Никаких новых таблиц / state. Lightweight aggregator.
//  - Secrets-admin-only rule: НЕ включаем ENV-values в summary. Только status.
//  - Musa-female-voice rule: текст от женского лица.
//
// Output:
//   { textSummary: string,            // 300-500 слов для TTS
//     audioBase64?: string,           // base64 mp3 если Yandex TTS ok
//     audioContentType?: string,      // "audio/mpeg" если есть audio
//     ttsError?: string,              // если TTS fail
//     generatedAt: string,            // ISO timestamp
//     period: { id, label, fromIso, toIso },
//     sections: {...}                 // structured данные для UI transcript
//   }

import { orchestrator, DIRECTOR_NAME } from "./agentOrchestrator";
import { synthesizeYandexTts, type YandexVoice } from "./yandexTts";
import { getPeriodRange, type PeriodId } from "./periodBoundaries";

export interface DirectorReportSections {
  agents: {
    total: number;
    active: number;
    error: number;
    notConfigured: number;
    paused: number;
    errorList: Array<{ id: string; name: string; reason?: string }>;
  };
  channels: Record<string, number>;
  genLifecycle?: {
    totalTracked: number;
    recovered: number;
    escalated: number;
    manualRetries: number;
    lastError: string | null;
  };
  denga?: {
    cacheSize: number;
    totalOverrides: number;
  };
  marketing?: {
    totalCampaigns: number;
    sent: number;
    converted: number;
    revenue: number;
    nextScheduledAt: number | null;
  };
  incidents?: {
    openCount: number;
    criticalCount: number;
  };
}

export interface DirectorReportResult {
  textSummary: string;
  audioBase64?: string;
  audioContentType?: string;
  ttsError?: string;
  generatedAt: string;
  period: {
    id: PeriodId;
    label: string;
    fromIso: string;
    toIso: string;
  };
  sections: DirectorReportSections;
}

/**
 * Собирает state со всех agents + lifecycle + marketing + denga.
 * Lazy-imports чтобы не создавать циклы при boot.
 */
async function buildSections(): Promise<DirectorReportSections> {
  const summary = orchestrator.summary();
  const list = orchestrator.list();

  // Найти agents в state=error + last error detail
  const errorList: Array<{ id: string; name: string; reason?: string }> = [];
  for (const a of list) {
    if (a.status !== "error") continue;
    const lastErr = (a.metadata as Record<string, unknown> | undefined)?.lastError;
    errorList.push({
      id: a.id,
      name: a.name,
      reason: typeof lastErr === "string" ? lastErr.slice(0, 120) : undefined,
    });
  }

  const sections: DirectorReportSections = {
    agents: {
      total: summary.total,
      active: summary.byStatus.active || 0,
      error: summary.byStatus.error || 0,
      notConfigured: summary.byStatus.not_configured || 0,
      paused: summary.byStatus.paused || 0,
      errorList,
    },
    channels: summary.byChannel,
  };

  // Gen-lifecycle stats
  try {
    const mod = await import("./genLifecycleAgent");
    const stats = mod.getStats();
    sections.genLifecycle = {
      totalTracked: stats.totalTracked,
      recovered: stats.recovered,
      escalated: stats.escalated,
      manualRetries: stats.manualRetries,
      lastError: stats.lastError,
    };
  } catch {
    // skip — agent not available
  }

  // Denga stats
  try {
    const mod = await import("./dengaAgent");
    if (typeof mod.getDengaAgentStats === "function") {
      const stats = mod.getDengaAgentStats();
      sections.denga = {
        cacheSize: stats.cacheSize ?? 0,
        totalOverrides: stats.totalOverrides ?? 0,
      };
    }
  } catch {
    // skip
  }

  // Marketing stats
  try {
    const mod = await import("./marketingAgent");
    if (typeof mod.getMarketingStats === "function") {
      const stats = mod.getMarketingStats();
      sections.marketing = {
        totalCampaigns: stats.campaigns.total,
        sent: stats.performance?.totals?.sent ?? 0,
        converted: stats.performance?.totals?.converted ?? 0,
        revenue: stats.performance?.totals?.revenue ?? 0,
        nextScheduledAt: stats.calendar.nextScheduledAt ?? null,
      };
    }
  } catch {
    // skip
  }

  return sections;
}

/**
 * Формирует итоговый текст доклада (300-500 слов) для TTS.
 * Структурно: вступление → agents → lifecycle → marketing → денга → итог.
 * Musa-female-voice rule: все формы женского рода.
 */
function buildSummaryText(
  sections: DirectorReportSections,
  periodLabel: string,
): string {
  const parts: string[] = [];

  parts.push(`Привет, Босс! Это ${DIRECTOR_NAME} с докладом за ${periodLabel}.`);

  // Agents overview
  const a = sections.agents;
  parts.push(
    `У нас всего ${a.total} агентов. Активных — ${a.active}, ` +
      (a.error > 0 ? `с ошибками — ${a.error}, ` : "") +
      `не настроенных — ${a.notConfigured}.`,
  );

  if (a.errorList.length > 0) {
    const names = a.errorList.slice(0, 3).map(e => e.name).join(", ");
    parts.push(`Внимание: упали агенты ${names}. Проверь их в админке.`);
  } else {
    parts.push("Ошибок среди агентов нет — всё ровно.");
  }

  // Channels summary
  const chKeys = Object.keys(sections.channels);
  if (chKeys.length > 0) {
    const chText = chKeys
      .filter(k => sections.channels[k] > 0)
      .slice(0, 5)
      .map(k => `${k} — ${sections.channels[k]}`)
      .join(", ");
    parts.push(`По каналам: ${chText}.`);
  }

  // Gen-lifecycle
  if (sections.genLifecycle) {
    const gl = sections.genLifecycle;
    parts.push(
      `Лайф-цикл генераций: я отследила ${gl.totalTracked} событий, ` +
        `восстановила ${gl.recovered}, эскалировала ${gl.escalated}.`,
    );
    if (gl.lastError) {
      parts.push(`Последняя ошибка цикла: ${String(gl.lastError).slice(0, 100)}.`);
    }
  }

  // Marketing
  if (sections.marketing) {
    const m = sections.marketing;
    parts.push(
      `Маркетинг: ${m.totalCampaigns} кампаний, отправлено ${m.sent}, ` +
        `конверсий ${m.converted}.`,
    );
    if (m.revenue > 0) {
      parts.push(`Принесли выручки на ${Math.round(m.revenue / 100)} рублей.`);
    }
    if (m.nextScheduledAt) {
      parts.push(`Следующая запланированная кампания скоро стартует.`);
    }
  }

  // Denga
  if (sections.denga) {
    const d = sections.denga;
    parts.push(
      `Деньга: кэш — ${d.cacheSize} записей, ручных корректировок — ${d.totalOverrides}.`,
    );
  }

  // Closing
  if (a.error === 0) {
    parts.push("Итог: всё под контролем, Босс. Если что — я рядом.");
  } else {
    parts.push(`Итог: есть ${a.error} критичных моментов, посмотри их в первую очередь.`);
  }

  return parts.join(" ");
}

/**
 * Главный entry-point: собрать summary + (опционально) синтезировать аудио.
 *
 * @param opts.period — period для отчёта (default "today")
 * @param opts.voice — Yandex TTS voice (default "alena" — женский тёплый)
 * @param opts.skipTts — пропустить TTS (для preview только текста)
 */
export async function buildDirectorSummary(opts: {
  period?: PeriodId | string;
  voice?: YandexVoice;
  skipTts?: boolean;
} = {}): Promise<DirectorReportResult> {
  const range = getPeriodRange(opts.period || "today");
  const sections = await buildSections();
  const textSummary = buildSummaryText(sections, range.label);

  const result: DirectorReportResult = {
    textSummary,
    generatedAt: new Date().toISOString(),
    period: {
      id: range.id,
      label: range.label,
      fromIso: range.fromIso,
      toIso: range.toIso,
    },
    sections,
  };

  if (opts.skipTts) return result;

  // Try Yandex TTS — если key отсутствует / fail, возвращаем только text.
  // Frontend fallback на browser SpeechSynthesis API.
  try {
    const tts = await synthesizeYandexTts({
      text: textSummary,
      voice: opts.voice || "alena",
      format: "mp3",
      emotion: "good",
      speed: 1.05,
    });
    if (tts.ok && tts.audio) {
      result.audioBase64 = tts.audio.toString("base64");
      result.audioContentType = tts.contentType || "audio/mpeg";
    } else {
      result.ttsError = tts.error || "TTS failed";
    }
  } catch (e: unknown) {
    result.ttsError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }

  return result;
}
