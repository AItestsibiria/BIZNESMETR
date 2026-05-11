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

export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>
export type ListTasksInput = z.infer<typeof ListTasksInputSchema>
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>
export type DraftTextInput = z.infer<typeof DraftTextInputSchema>
