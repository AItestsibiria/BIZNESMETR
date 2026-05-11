import { sheetsClient } from '../integrations/sheets'
import { calendarClient } from '../integrations/gcal'
import { githubClient } from '../integrations/github'
import { config } from '../config'
import { logger } from '../logger'

export interface DigestPayload {
  generatedAt: string
  tasks: { open: number; overdue: number; sample: string[] }
  calendar: { today: number; sample: string[] }
  github: { openPrs: number; sample: string[] }
}

const SAMPLE_SIZE = 5

export async function composeDigest(): Promise<DigestPayload> {
  const now = new Date()
  const [tasksOpen, eventsToday, prs] = await Promise.all([
    safeCall('tasks', () => sheetsClient.listTasks({ status: 'open', limit: 50 })),
    safeCall('calendar', () => calendarClient.listUpcoming({ hours: 24, max: 20 })),
    safeCall('github', () =>
      config.GITHUB_TOKEN ? githubClient.listMyOpenPRs({ limit: 20 }) : Promise.resolve([]),
    ),
  ])

  const overdue = tasksOpen.filter((t) => t.due && new Date(t.due) < now)

  return {
    generatedAt: now.toISOString(),
    tasks: {
      open: tasksOpen.length,
      overdue: overdue.length,
      sample: tasksOpen.slice(0, SAMPLE_SIZE).map((t) => `${t.title}${t.due ? ` (до ${t.due})` : ''}`),
    },
    calendar: {
      today: eventsToday.length,
      sample: eventsToday
        .slice(0, SAMPLE_SIZE)
        .map((e) => `${formatLocalTime(e.start)} — ${e.title}`),
    },
    github: {
      openPrs: prs.length,
      sample: prs.slice(0, SAMPLE_SIZE).map((p) => `${p.repo}#${p.number} ${p.title}`),
    },
  }
}

export function formatDigestForChat(payload: DigestPayload): string {
  const lines = [
    `Доброе утро. Сводка на ${formatLocalDate(payload.generatedAt)}.`,
    '',
    `📋 Задачи: ${payload.tasks.open} открытых${payload.tasks.overdue > 0 ? `, ${payload.tasks.overdue} просрочено` : ''}`,
    ...payload.tasks.sample.map((s) => `  • ${s}`),
    '',
    `📅 Встречи (24ч): ${payload.calendar.today}`,
    ...payload.calendar.sample.map((s) => `  • ${s}`),
  ]
  if (payload.github.openPrs > 0) {
    lines.push('', `🔧 GitHub PRs: ${payload.github.openPrs}`)
    lines.push(...payload.github.sample.map((s) => `  • ${s}`))
  }
  return lines.join('\n')
}

async function safeCall<T>(label: string, fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn()
  } catch (error) {
    logger.warn({ error, label }, 'Digest source failed — skipping')
    return []
  }
}

function formatLocalTime(iso: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: config.DEFAULT_TZ,
    })
  } catch {
    return iso
  }
}

function formatLocalDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      weekday: 'long',
      timeZone: config.DEFAULT_TZ,
    })
  } catch {
    return iso
  }
}
