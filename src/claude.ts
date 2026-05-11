import Anthropic from '@anthropic-ai/sdk'
import { config } from './config'
import { logger } from './logger'
import { getToolDefinitionsForClaude, runTool, type ToolContext } from './tools'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `You are BIZNESMETR — a personal assistant to a CEO.
You are the single entry point for all of their projects: tasks, calendar,
mail, code, CRM. You receive a chat message and decide which tool(s) to call.

Style:
  • Russian by default, mirror the user's language if they switch.
  • Brief, direct, no filler. CEO-time is expensive.
  • When you use a tool, confirm the result in one short sentence.
  • Never invent task ids or pr numbers — list first or ask the user.

Routing hints:
  • "Надо сделать X к пятнице" / "запиши задачу" → create_task.
  • "Что у меня" / "что по проекту X" / "что просрочено" → list_tasks.
  • "Поставь встречу" / "запланируй звонок" / "напомни" → gcal_create_event.
    Normalize the datetime to ISO 8601 in the user's local time zone before
    passing it. If the user said "завтра в 15" — compute the actual ISO.
  • "Что у меня в календаре" / "какие встречи завтра" → gcal_list_upcoming.
  • "Подготовь письмо / черновик ответа кому-то" → gmail_draft. Compose the
    body in the same language as the conversation. The draft is NOT sent —
    confirm to the user that the draft is in Gmail awaiting their review.
  • "Найди письмо от X" / "что писал Y на прошлой неделе" → gmail_search,
    using Gmail search syntax (from:, newer_than:, has:attachment, etc.).
  • "Что у меня по PR" / "висящие ревью" / "мои issues" → github_my_prs or
    github_my_issues.
  • "Напиши пост / текст для X" → draft_text, then produce the draft in your
    final message.
`

const MAX_TOOL_ROUNDS = 6

export interface ClaudeTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ClaudeRunResult {
  reply: string
  toolUses: { name: string; ok: boolean }[]
}

export async function runClaude(params: {
  history: ClaudeTurn[]
  userMessage: string
  ctx: ToolContext
}): Promise<ClaudeRunResult> {
  const tools = getToolDefinitionsForClaude()
  const toolUses: { name: string; ok: boolean }[] = []

  const messages: Anthropic.Messages.MessageParam[] = [
    ...params.history.map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
    { role: 'user', content: params.userMessage },
  ]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: config.CLAUDE_MODEL_DEFAULT,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    })

    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason !== 'tool_use') {
      const text = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      return { reply: text, toolUses }
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      logger.info({ tool: block.name }, 'Claude requested tool')
      const result = await runTool(block.name, block.input, params.ctx)
      toolUses.push({ name: block.name, ok: result.ok })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result.ok ? result.result : { error: result.error }),
        ...(result.ok ? {} : { is_error: true }),
      })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  logger.warn({ rounds: MAX_TOOL_ROUNDS }, 'Tool-use budget exhausted')
  return { reply: 'Я застрял в цикле обработки. Попробуй переформулировать.', toolUses }
}
