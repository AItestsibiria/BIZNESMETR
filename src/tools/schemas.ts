import { z } from 'zod'

export const PrioritySchema = z.enum(['low', 'normal', 'high'])
export const StatusSchema = z.enum(['open', 'in_progress', 'done', 'cancelled'])

export const CreateTaskInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  project: z.string().max(100).optional(),
  due: z.string().optional().describe('ISO date or natural language; will be normalized'),
  priority: PrioritySchema.optional(),
  assignee: z.string().max(100).optional(),
})

export const ListTasksInputSchema = z.object({
  status: StatusSchema.optional(),
  project: z.string().max(100).optional(),
  limit: z.number().int().positive().max(50).default(20),
})

export const UpdateTaskInputSchema = z.object({
  id: z.string().min(1),
  status: StatusSchema.optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  due: z.string().optional(),
  priority: PrioritySchema.optional(),
  assignee: z.string().max(100).optional(),
})

export const DraftTextInputSchema = z.object({
  purpose: z.string().min(1).describe('What the text is for: email, post, reply, etc.'),
  audience: z.string().optional().describe('Who is the reader'),
  tone: z.string().optional().describe('e.g. formal, friendly, terse'),
  brief: z.string().min(1).describe('Key points the text must convey'),
  language: z.string().default('ru'),
})

export const GcalCreateEventInputSchema = z.object({
  title: z.string().min(1).max(200),
  start: z
    .string()
    .min(1)
    .describe('ISO 8601 start datetime in DEFAULT_TZ, e.g. 2026-05-12T15:00:00'),
  end: z.string().min(1).optional().describe('ISO 8601 end datetime; defaults to start + 60min'),
  description: z.string().max(2000).optional(),
  location: z.string().max(200).optional(),
  attendees: z.array(z.string().email()).max(20).optional(),
})

export const GcalListUpcomingInputSchema = z.object({
  hours: z.number().int().positive().max(720).default(24).describe('Look-ahead window in hours'),
  max: z.number().int().positive().max(50).default(20),
})

export const GmailDraftInputSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
  cc: z.string().optional(),
  bcc: z.string().optional(),
})

export const GmailSearchInputSchema = z.object({
  query: z.string().min(1).describe('Gmail search syntax, e.g. "from:foo@bar.com newer_than:7d"'),
  max: z.number().int().positive().max(50).default(10),
})

export const GithubMyPrsInputSchema = z.object({
  limit: z.number().int().positive().max(50).default(20),
})

export const GithubMyIssuesInputSchema = z.object({
  limit: z.number().int().positive().max(50).default(20),
})

export const ProjectAnalyticsInputSchema = z.object({
  project: z
    .enum(['muziai', 'biznesmetr', 'egrn'])
    .describe(
      'Which external project to query. muziai = MuziAI; biznesmetr = the Бизнесметр business-metrics platform; egrn = ЕГРН (real estate registry).',
    ),
  topic: z
    .string()
    .max(500)
    .optional()
    .describe('What specifically the user wants to know (free-form, forwarded to the project).'),
  period: z
    .string()
    .max(100)
    .optional()
    .describe('Optional time period, e.g. "last 7 days", "Q2 2026".'),
})

export const RememberFactInputSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_.:-]+$/i, 'Use a-z 0-9 _ . : -')
    .describe(
      'Stable identifier for this fact. Examples: contact.ivanov.role, deal.acme.status, kpi.q2.target.',
    ),
  value: z.string().min(1).max(4000).describe('The fact itself, in any language.'),
})

export const RecallFactsInputSchema = z.object({
  query: z
    .string()
    .max(120)
    .optional()
    .describe('Substring filter over the key. Empty = return everything (capped by limit).'),
  limit: z.number().int().positive().max(50).default(20),
})

export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>
export type ListTasksInput = z.infer<typeof ListTasksInputSchema>
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>
export type DraftTextInput = z.infer<typeof DraftTextInputSchema>
export type GcalCreateEventInput = z.infer<typeof GcalCreateEventInputSchema>
export type GcalListUpcomingInput = z.infer<typeof GcalListUpcomingInputSchema>
export type GmailDraftInput = z.infer<typeof GmailDraftInputSchema>
export type GmailSearchInput = z.infer<typeof GmailSearchInputSchema>
export type GithubMyPrsInput = z.infer<typeof GithubMyPrsInputSchema>
export type GithubMyIssuesInput = z.infer<typeof GithubMyIssuesInputSchema>
export type ProjectAnalyticsInput = z.infer<typeof ProjectAnalyticsInputSchema>
export type RememberFactInput = z.infer<typeof RememberFactInputSchema>
export type RecallFactsInput = z.infer<typeof RecallFactsInputSchema>
