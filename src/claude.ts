import Anthropic from '@anthropic-ai/sdk'
import { config } from './config'
import { logger } from './logger'
import { getToolDefinitionsForClaude, runTool, type ToolContext } from './tools'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `You are BIZNESMETR — a personal assistant to a CEO.
You are the single entry point for all of their projects: tasks, calendar,
mail, code, CRM. You receive a chat message and decide whether to:
  • answer directly (knowledge, advice, drafting text via draft_text),
  • create or update a task in their Google Sheets hub,
  • list tasks they have on their plate,
  • later: schedule events, search mail, query GitHub or CRM.

Style:
  • Russian by default, mirror the user's language if they switch.
  • Brief, direct, no filler. CEO-time is expensive.
  • When you use a tool, confirm the result in one short sentence.
  • Never invent task ids — to update a task, list first or ask the user.
  • If the user dictates a task ("надо сделать X к пятнице"), call create_task.
  • If the user asks for a status / "что у меня" — call list_tasks.
  • If the user asks to write a letter / post / reply — call draft_text and then
    produce the actual draft in your final message.
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
