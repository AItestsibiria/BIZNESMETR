import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { logger } from '../logger'
import { prisma } from '../db'
import { sheetsClient, type TaskRow } from '../integrations/sheets'
import { calendarClient } from '../integrations/gcal'
import { gmailClient } from '../integrations/gmail'
import { githubClient } from '../integrations/github'
import { projectConnectors } from '../integrations/projects'
import {
  CreateTaskInputSchema,
  DraftTextInputSchema,
  GcalCreateEventInputSchema,
  GcalListUpcomingInputSchema,
  GithubMyIssuesInputSchema,
  GithubMyPrsInputSchema,
  GmailDraftInputSchema,
  GmailSearchInputSchema,
  ListTasksInputSchema,
  ProjectAnalyticsInputSchema,
  RecallFactsInputSchema,
  RememberFactInputSchema,
  UpdateTaskInputSchema,
} from './schemas'

export interface ToolContext {
  externalChatId: string
  userId: string
}

interface ToolDefinition<Schema extends z.ZodTypeAny> {
  name: string
  description: string
  schema: Schema
  handler: (input: z.infer<Schema>, ctx: ToolContext) => Promise<unknown>
}

function defineTool<Schema extends z.ZodTypeAny>(def: ToolDefinition<Schema>): ToolDefinition<Schema> {
  return def
}

const createTask = defineTool({
  name: 'create_task',
  description:
    'Create a new task in the user\'s Google Sheets hub. Use when the user describes work to do or something to remember.',
  schema: CreateTaskInputSchema,
  handler: async (input, ctx) => {
    const now = new Date().toISOString()
    const row: TaskRow = {
      id: randomUUID(),
      createdAt: now,
      project: input.project ?? null,
      title: input.title,
      description: input.description ?? null,
      due: input.due ?? null,
      priority: input.priority ?? null,
      status: 'open',
      assignee: input.assignee ?? null,
      sourceChat: ctx.externalChatId,
      lastUpdate: now,
    }
    await sheetsClient.appendTask(row)
    return { id: row.id, title: row.title, status: row.status }
  },
})

const listTasks = defineTool({
  name: 'list_tasks',
  description:
    'List tasks from the hub. Filter by status or project. Use when the user asks what is on their plate.',
  schema: ListTasksInputSchema,
  handler: async (input) => {
    const filter: Parameters<typeof sheetsClient.listTasks>[0] = { limit: input.limit }
    if (input.status) filter.status = input.status
    if (input.project) filter.project = input.project
    const tasks = await sheetsClient.listTasks(filter)
    return { count: tasks.length, tasks }
  },
})

const updateTask = defineTool({
  name: 'update_task',
  description:
    'Update an existing task (status, due date, priority, etc.). Requires the task id from a prior list_tasks call.',
  schema: UpdateTaskInputSchema,
  handler: async (input) => {
    const { id, ...rest } = input
    const patch: Parameters<typeof sheetsClient.updateTask>[1] = {}
    if (rest.status !== undefined) patch.status = rest.status
    if (rest.title !== undefined) patch.title = rest.title
    if (rest.description !== undefined) patch.description = rest.description
    if (rest.due !== undefined) patch.due = rest.due
    if (rest.priority !== undefined) patch.priority = rest.priority
    if (rest.assignee !== undefined) patch.assignee = rest.assignee
    const updated = await sheetsClient.updateTask(id, patch)
    if (!updated) return { ok: false, error: `Task ${id} not found` }
    return { ok: true, task: updated }
  },
})

const draftText = defineTool({
  name: 'draft_text',
  description:
    'Draft a piece of text (email, message, post, announcement) based on a brief. Return the draft directly to the user without saving anywhere.',
  schema: DraftTextInputSchema,
  handler: async (input) => {
    // This tool is a marker — the actual drafting happens in the next Claude
    // turn after this tool result. We just echo the brief so the model has
    // structured context.
    return { ack: true, brief: input }
  },
})

const gcalCreateEvent = defineTool({
  name: 'gcal_create_event',
  description:
    'Create an event in the user\'s Google Calendar. Use when scheduling a meeting, call, deadline, or reminder. Pass ISO datetime strings.',
  schema: GcalCreateEventInputSchema,
  handler: async (input) => {
    const event = await calendarClient.createEvent({
      title: input.title,
      start: input.start,
      ...(input.end !== undefined ? { end: input.end } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.attendees !== undefined ? { attendees: input.attendees } : {}),
    })
    return event
  },
})

const gcalListUpcoming = defineTool({
  name: 'gcal_list_upcoming',
  description:
    'List upcoming calendar events in the next N hours. Use for "what is on my schedule today / this week".',
  schema: GcalListUpcomingInputSchema,
  handler: async (input) => {
    const events = await calendarClient.listUpcoming({ hours: input.hours, max: input.max })
    return { count: events.length, events }
  },
})

const gmailDraft = defineTool({
  name: 'gmail_draft',
  description:
    'Create a Gmail draft. Use when the user asks to "draft an email", "set up a reply to X", etc. Does NOT send — the user reviews and sends manually.',
  schema: GmailDraftInputSchema,
  handler: async (input) => {
    const { id } = await gmailClient.createDraft({
      to: input.to,
      subject: input.subject,
      body: input.body,
      ...(input.cc !== undefined ? { cc: input.cc } : {}),
      ...(input.bcc !== undefined ? { bcc: input.bcc } : {}),
    })
    return { draftId: id }
  },
})

const gmailSearch = defineTool({
  name: 'gmail_search',
  description:
    'Search the user\'s Gmail using Gmail search syntax. Use for "find letter from X", "what did Y write last week", etc.',
  schema: GmailSearchInputSchema,
  handler: async (input) => {
    const results = await gmailClient.search(input.query, input.max)
    return { count: results.length, results }
  },
})

const githubMyPrs = defineTool({
  name: 'github_my_prs',
  description:
    'List open pull requests authored by the user. Use for "what PRs do I have open", "stuck reviews", etc.',
  schema: GithubMyPrsInputSchema,
  handler: async (input) => {
    const prs = await githubClient.listMyOpenPRs({ limit: input.limit })
    return { count: prs.length, prs }
  },
})

const githubMyIssues = defineTool({
  name: 'github_my_issues',
  description: 'List open GitHub issues authored by the user. Use for "what issues am I tracking".',
  schema: GithubMyIssuesInputSchema,
  handler: async (input) => {
    const issues = await githubClient.listMyOpenIssues({ limit: input.limit })
    return { count: issues.length, issues }
  },
})

const rememberFact = defineTool({
  name: 'remember_fact',
  description:
    'Store or update a long-lived factual note about the user, their contacts, deals, KPIs, etc. Use proactively whenever the user shares something worth remembering (a person\'s role, a number, a deadline, a promise). Keys are stable identifiers; calling this with an existing key overwrites the value.',
  schema: RememberFactInputSchema,
  handler: async (input, ctx) => {
    const fact = await prisma.fact.upsert({
      where: { userId_key: { userId: ctx.userId, key: input.key } },
      update: { value: input.value },
      create: { userId: ctx.userId, key: input.key, value: input.value },
    })
    return { key: fact.key, savedAt: fact.updatedAt.toISOString() }
  },
})

const recallFacts = defineTool({
  name: 'recall_facts',
  description:
    'Recall facts previously remembered for the user. With no query, returns the most recently updated facts. With a query, filters keys by substring (case-insensitive).',
  schema: RecallFactsInputSchema,
  handler: async (input, ctx) => {
    const facts = await prisma.fact.findMany({
      where: {
        userId: ctx.userId,
        ...(input.query ? { key: { contains: input.query, mode: 'insensitive' } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: input.limit,
    })
    return {
      count: facts.length,
      facts: facts.map((f) => ({
        key: f.key,
        value: f.value,
        updatedAt: f.updatedAt.toISOString(),
      })),
    }
  },
})

const projectAnalytics = defineTool({
  name: 'project_analytics',
  description:
    'Pull analytics or a status snapshot from one of the user\'s external projects: MuziAI, Бизнесметр (the business-metrics platform), or ЕГРН. Use when the user asks "что по [проекту]" or "дай аналитику по [проекту]".',
  schema: ProjectAnalyticsInputSchema,
  handler: async (input) => {
    const connector = projectConnectors[input.project]
    const result = await connector.getAnalytics({
      ...(input.topic !== undefined ? { topic: input.topic } : {}),
      ...(input.period !== undefined ? { period: input.period } : {}),
    })
    return result
  },
})

const tools = [
  createTask,
  listTasks,
  updateTask,
  draftText,
  gcalCreateEvent,
  gcalListUpcoming,
  gmailDraft,
  gmailSearch,
  githubMyPrs,
  githubMyIssues,
  projectAnalytics,
  rememberFact,
  recallFacts,
] as const

export function getToolDefinitionsForClaude(): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.schema),
  }))
}

export async function runTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` }

  const parsed = tool.schema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: `Invalid input: ${parsed.error.message}` }
  }
  try {
    // The schema and handler pair is validated by `defineTool`; the union
    // collapses when iterating the heterogeneous registry, so we narrow here.
    const handler = tool.handler as (input: unknown, ctx: ToolContext) => Promise<unknown>
    const result = await handler(parsed.data, ctx)
    return { ok: true, result }
  } catch (error) {
    logger.error({ tool: name, error }, 'Tool execution failed')
    const message = error instanceof Error ? error.message : 'Internal tool error'
    return { ok: false, error: message }
  }
}

function zodToJsonSchema(schema: z.ZodTypeAny): Anthropic.Messages.Tool['input_schema'] {
  // Minimal Zod → JSON Schema bridge sufficient for our tool surface.
  // For richer cases, swap to the `zod-to-json-schema` package.
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodFieldToJsonSchema(value)
      if (!value.isOptional() && !(value instanceof z.ZodDefault)) {
        required.push(key)
      }
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    }
  }
  return { type: 'object', properties: {} }
}

function zodFieldToJsonSchema(field: z.ZodTypeAny): Record<string, unknown> {
  let current = field
  let description: string | undefined
  if (current.description) description = current.description

  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
    current = current instanceof z.ZodOptional ? current.unwrap() : current.removeDefault()
  }

  let base: Record<string, unknown>
  if (current instanceof z.ZodString) base = { type: 'string' }
  else if (current instanceof z.ZodNumber) base = { type: 'number' }
  else if (current instanceof z.ZodBoolean) base = { type: 'boolean' }
  else if (current instanceof z.ZodEnum) base = { type: 'string', enum: current.options }
  else if (current instanceof z.ZodArray) base = { type: 'array', items: zodFieldToJsonSchema(current.element) }
  else base = { type: 'string' }

  if (description) base['description'] = description
  return base
}
