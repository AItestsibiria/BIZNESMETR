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

const ctx = { externalChatId: 'chat-1' }

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
      'list_tasks',
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
})
