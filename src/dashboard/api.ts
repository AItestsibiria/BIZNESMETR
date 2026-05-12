import { Router } from 'express'
import { config } from '../config'
import { logger } from '../logger'
import { prisma } from '../db'
import { sheetsClient } from '../integrations/sheets'
import { calendarClient } from '../integrations/gcal'
import { githubClient } from '../integrations/github'
import { projectConnectors } from '../integrations/projects'
import { getMetricsSnapshot } from '../metrics'
import { basicAuth } from './auth'

interface SummaryResponse {
  generatedAt: string
  assistantName: string
  system: {
    uptimeSeconds: number
    ready: boolean
    checks: Record<string, { ok: boolean; error?: string }>
  }
  tasks: {
    open: number
    overdue: number
    sample: { id: string; title: string; due: string | null; priority: string | null }[]
    error?: string
  }
  calendar: {
    today: number
    events: { id: string; title: string; start: string; location: string | null }[]
    error?: string
  }
  github: {
    configured: boolean
    openPrs: number
    sample: { repo: string; number: number; title: string; url: string }[]
    error?: string
  }
  projects: Record<string, { displayName: string; configured: boolean }>
  facts: { total: number; recent: { key: string; value: string; updatedAt: string }[] }
  ai: ReturnType<typeof getMetricsSnapshot>
}

export function dashboardRouter(): Router {
  const router = Router()
  router.use(basicAuth())

  router.get('/summary', async (_req, res) => {
    try {
      const payload = await composeSummary()
      res.json(payload)
    } catch (error) {
      logger.error({ error }, 'Dashboard summary failed')
      res.status(500).json({ error: 'Failed to build summary' })
    }
  })

  return router
}

async function composeSummary(): Promise<SummaryResponse> {
  const now = new Date()
  const checks: Record<string, { ok: boolean; error?: string }> = {}

  try {
    await prisma.$queryRaw`SELECT 1`
    checks['postgres'] = { ok: true }
  } catch (error) {
    checks['postgres'] = { ok: false, error: errorMessage(error) }
  }
  if (config.HUB_SHEET_ID) {
    try {
      await sheetsClient.ensureHeaders()
      checks['sheets'] = { ok: true }
    } catch (error) {
      checks['sheets'] = { ok: false, error: errorMessage(error) }
    }
  }

  const tasks = await loadTasks(now)
  const calendar = await loadCalendar()
  const github = await loadGithub()

  const factTotal = await prisma.fact.count().catch(() => 0)
  const recentFacts = await prisma.fact
    .findMany({ orderBy: { updatedAt: 'desc' }, take: 5 })
    .catch(() => [])

  return {
    generatedAt: now.toISOString(),
    assistantName: config.ASSISTANT_NAME,
    system: {
      uptimeSeconds: Math.floor(process.uptime()),
      ready: Object.values(checks).every((c) => c.ok),
      checks,
    },
    tasks,
    calendar,
    github,
    projects: Object.fromEntries(
      Object.values(projectConnectors).map((c) => [
        c.key,
        { displayName: c.displayName, configured: c.isConfigured() },
      ]),
    ),
    facts: {
      total: factTotal,
      recent: recentFacts.map((f) => ({
        key: f.key,
        value: f.value,
        updatedAt: f.updatedAt.toISOString(),
      })),
    },
    ai: getMetricsSnapshot(),
  }
}

async function loadTasks(now: Date): Promise<SummaryResponse['tasks']> {
  if (!config.HUB_SHEET_ID) {
    return { open: 0, overdue: 0, sample: [], error: 'HUB_SHEET_ID not configured' }
  }
  try {
    const open = await sheetsClient.listTasks({ status: 'open', limit: 50 })
    const overdue = open.filter((t) => t.due && new Date(t.due) < now)
    return {
      open: open.length,
      overdue: overdue.length,
      sample: open.slice(0, 5).map((t) => ({
        id: t.id,
        title: t.title,
        due: t.due,
        priority: t.priority,
      })),
    }
  } catch (error) {
    return { open: 0, overdue: 0, sample: [], error: errorMessage(error) }
  }
}

async function loadCalendar(): Promise<SummaryResponse['calendar']> {
  if (!config.GOOGLE_APPLICATION_CREDENTIALS) {
    return { today: 0, events: [], error: 'Google credentials not configured' }
  }
  try {
    const events = await calendarClient.listUpcoming({ hours: 24, max: 10 })
    return {
      today: events.length,
      events: events.map((e) => ({ id: e.id, title: e.title, start: e.start, location: e.location })),
    }
  } catch (error) {
    return { today: 0, events: [], error: errorMessage(error) }
  }
}

async function loadGithub(): Promise<SummaryResponse['github']> {
  if (!config.GITHUB_TOKEN) {
    return { configured: false, openPrs: 0, sample: [] }
  }
  try {
    const prs = await githubClient.listMyOpenPRs({ limit: 20 })
    return {
      configured: true,
      openPrs: prs.length,
      sample: prs.slice(0, 5).map((p) => ({
        repo: p.repo,
        number: p.number,
        title: p.title,
        url: p.url,
      })),
    }
  } catch (error) {
    return { configured: true, openPrs: 0, sample: [], error: errorMessage(error) }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
