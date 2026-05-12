import { runTool, getToolDefinitionsForClaude } from '../index'
import { sheetsClient } from '../../integrations/sheets'

jest.mock('../../integrations/sheets', () => ({
  sheetsClient: {
    appendTask: jest.fn().mockResolvedValue(undefined),
    listTasks: jest.fn().mockResolvedValue([]),
    updateTask: jest.fn().mockResolvedValue(null),
    ensureHeaders: jest.fn().mockResolvedValue(undefined),
  },
}))

jest.mock('../../integrations/gcal', () => ({
  calendarClient: {
    createEvent: jest.fn().mockResolvedValue({
      id: 'evt-1',
      title: 'Встреча',
      start: '2026-05-12T15:00:00.000Z',
      end: '2026-05-12T16:00:00.000Z',
      location: null,
      htmlLink: null,
    }),
    listUpcoming: jest.fn().mockResolvedValue([]),
  },
}))

jest.mock('../../integrations/gmail', () => ({
  gmailClient: {
    createDraft: jest.fn().mockResolvedValue({ id: 'draft-1' }),
    search: jest.fn().mockResolvedValue([]),
  },
}))

jest.mock('../../integrations/github', () => ({
  githubClient: {
    listMyOpenPRs: jest.fn().mockResolvedValue([]),
    listMyOpenIssues: jest.fn().mockResolvedValue([]),
  },
}))

jest.mock('../../db', () => {
  const mem = new Map<string, { key: string; value: string; updatedAt: Date }>()
  return {
    prisma: {
      fact: {
        upsert: jest.fn(({ where, update, create }: { where: { userId_key: { userId: string; key: string } }; update: { value: string }; create: { userId: string; key: string; value: string } }) => {
          const cacheKey = `${where.userId_key.userId}::${where.userId_key.key}`
          const existing = mem.get(cacheKey)
          const updatedAt = new Date('2026-05-11T00:00:00.000Z')
          if (existing) {
            existing.value = update.value
            existing.updatedAt = updatedAt
            return Promise.resolve({ ...existing })
          }
          const created = { key: create.key, value: create.value, updatedAt }
          mem.set(cacheKey, created)
          return Promise.resolve({ ...created })
        }),
        findMany: jest.fn(({ where, take }: { where: { userId: string; key?: { contains: string; mode: string } }; take: number }) => {
          const entries = [...mem.entries()]
            .filter(([k]) => k.startsWith(`${where.userId}::`))
            .map(([, v]) => v)
            .filter((f) =>
              where.key?.contains ? f.key.toLowerCase().includes(where.key.contains.toLowerCase()) : true,
            )
            .slice(0, take)
          return Promise.resolve(entries)
        }),
      },
    },
  }
})

jest.mock('../../integrations/projects', () => ({
  projectConnectors: {
    muziai: {
      key: 'muziai',
      displayName: 'MuziAI',
      isConfigured: () => false,
      getAnalytics: jest.fn().mockResolvedValue({
        project: 'MuziAI',
        configured: false,
        summary: 'MuziAI integration is not configured yet.',
        fetchedAt: '2026-05-11T00:00:00.000Z',
      }),
    },
    biznesmetr: {
      key: 'biznesmetr',
      displayName: 'Бизнесметр',
      isConfigured: () => true,
      getAnalytics: jest.fn().mockResolvedValue({
        project: 'Бизнесметр',
        configured: true,
        summary: 'Ok.',
        fetchedAt: '2026-05-11T00:00:00.000Z',
      }),
    },
    egrn: {
      key: 'egrn',
      displayName: 'ЕГРН',
      isConfigured: () => false,
      getAnalytics: jest.fn().mockResolvedValue({
        project: 'ЕГРН',
        configured: false,
        summary: 'ЕГРН integration is not configured yet.',
        fetchedAt: '2026-05-11T00:00:00.000Z',
      }),
    },
  },
}))

const ctx = { externalChatId: 'chat-1', userId: 'user-1' }

describe('tools dispatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rejects unknown tool name', async () => {
    const res = await runTool('does_not_exist', {}, ctx)
    expect(res).toEqual({ ok: false, error: expect.stringContaining('Unknown tool') })
  })

  it('rejects invalid input for create_task', async () => {
    const res = await runTool('create_task', { title: '' }, ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Invalid input/)
  })

  it('creates a task with minimal valid input', async () => {
    const res = await runTool('create_task', { title: 'Позвонить юристу' }, ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.result).toMatchObject({ title: 'Позвонить юристу', status: 'open' })
    }
    expect(sheetsClient.appendTask).toHaveBeenCalledTimes(1)
  })

  it('exposes JSON-schema-shaped tool definitions to Claude', () => {
    const defs = getToolDefinitionsForClaude()
    const names = defs.map((d) => d.name).sort()
    expect(names).toEqual([
      'create_task',
      'draft_text',
      'gcal_create_event',
      'gcal_list_upcoming',
      'github_my_issues',
      'github_my_prs',
      'gmail_draft',
      'gmail_search',
      'list_tasks',
      'project_analytics',
      'recall_facts',
      'remember_fact',
      'update_task',
    ])
    for (const def of defs) {
      expect(def.input_schema.type).toBe('object')
      expect(typeof def.input_schema.properties).toBe('object')
    }
  })

  it('gcal_create_event normalises ISO inputs and returns an event', async () => {
    const res = await runTool(
      'gcal_create_event',
      { title: 'Встреча', start: '2026-05-12T15:00:00.000Z' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.result).toMatchObject({ id: 'evt-1', title: 'Встреча' })
    }
  })

  it('gcal_create_event rejects invalid date string', async () => {
    const res = await runTool('gcal_create_event', { title: 'X', start: '' }, ctx)
    expect(res.ok).toBe(false)
  })

  it('list_tasks forwards filters and limit', async () => {
    await runTool('list_tasks', { status: 'open', project: 'BIZ', limit: 5 }, ctx)
    expect(sheetsClient.listTasks).toHaveBeenCalledWith({
      status: 'open',
      project: 'BIZ',
      limit: 5,
    })
  })

  it('update_task returns ok:false when row is missing', async () => {
    const res = await runTool('update_task', { id: 'nope', status: 'done' }, ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.result).toMatchObject({ ok: false })
    }
  })

  it('gmail_draft validates email and creates a draft', async () => {
    const bad = await runTool('gmail_draft', { to: 'not-an-email', subject: 'X', body: 'Y' }, ctx)
    expect(bad.ok).toBe(false)

    const good = await runTool(
      'gmail_draft',
      { to: 'ceo@example.com', subject: 'Привет', body: 'Тело письма.' },
      ctx,
    )
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.result).toMatchObject({ draftId: 'draft-1' })
  })

  it('github_my_prs returns a count and list', async () => {
    const res = await runTool('github_my_prs', { limit: 5 }, ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.result).toMatchObject({ count: 0, prs: [] })
  })

  it('project_analytics validates project enum', async () => {
    const bad = await runTool('project_analytics', { project: 'unknown' }, ctx)
    expect(bad.ok).toBe(false)
  })

  it('project_analytics reports when a connector is not configured', async () => {
    const res = await runTool('project_analytics', { project: 'muziai' }, ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.result).toMatchObject({ project: 'MuziAI', configured: false })
    }
  })

  it('project_analytics returns data when configured', async () => {
    const res = await runTool(
      'project_analytics',
      { project: 'biznesmetr', topic: 'Q2 revenue' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.result).toMatchObject({ project: 'Бизнесметр', configured: true, summary: 'Ok.' })
    }
  })

  it('remember_fact validates the key pattern', async () => {
    const bad = await runTool('remember_fact', { key: 'has spaces', value: 'x' }, ctx)
    expect(bad.ok).toBe(false)
  })

  it('remember_fact stores, recall_facts retrieves with substring filter', async () => {
    await runTool('remember_fact', { key: 'contact.ivanov.role', value: 'CFO' }, ctx)
    await runTool('remember_fact', { key: 'deal.acme.status', value: 'negotiating' }, ctx)

    const all = await runTool('recall_facts', { limit: 10 }, ctx)
    expect(all.ok).toBe(true)
    if (all.ok) {
      expect(all.result).toMatchObject({ count: 2 })
    }

    const filtered = await runTool('recall_facts', { query: 'ivanov', limit: 10 }, ctx)
    expect(filtered.ok).toBe(true)
    if (filtered.ok) {
      expect(filtered.result).toMatchObject({
        count: 1,
        facts: [{ key: 'contact.ivanov.role', value: 'CFO' }],
      })
    }
  })
})
