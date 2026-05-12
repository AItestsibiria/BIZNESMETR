import 'dotenv/config'
import { z } from 'zod'

const csvNumbers = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n)),
  )

const csvStrings = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url().optional(),
  ASSISTANT_NAME: z.string().default('Таня'),

  DATABASE_URL: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL_DEFAULT: z.string().default('claude-sonnet-4-6'),
  CLAUDE_MODEL_HEAVY: z.string().default('claude-opus-4-7'),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_WEBHOOK_PATH: z.string().default('/webhooks/telegram'),

  MAX_BOT_TOKEN: z.string().optional(),
  MAX_WEBHOOK_SECRET: z.string().optional(),
  MAX_WEBHOOK_PATH: z.string().default('/webhooks/max'),

  ALLOWED_TELEGRAM_USER_IDS: csvNumbers,
  ALLOWED_MAX_USER_IDS: csvStrings,

  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  HUB_SHEET_ID: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().default('primary'),
  GMAIL_USER_EMAIL: z.string().email().optional(),
  DEFAULT_TZ: z.string().default('Europe/Moscow'),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_OWNER: z.string().optional(),

  DIGEST_CRON: z.string().optional(),
  DIGEST_CHAT_IDS: csvStrings,

  MUZIAI_API_URL: z.string().url().optional(),
  MUZIAI_API_TOKEN: z.string().optional(),

  BIZNESMETR_HUB_URL: z.string().url().optional(),
  BIZNESMETR_HUB_TOKEN: z.string().optional(),

  EGRN_API_URL: z.string().url().optional(),
  EGRN_API_TOKEN: z.string().optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
  throw new Error(`Invalid environment configuration:\n${issues}`)
}

export const config = parsed.data
export type Config = typeof config
