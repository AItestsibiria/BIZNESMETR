import Anthropic from '@anthropic-ai/sdk'
import { config } from './config'
import { logger } from './logger'
import { getToolDefinitionsForClaude, runTool, type ToolContext } from './tools'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

function buildSystemPrompt(): string {
  const name = config.ASSISTANT_NAME
  return `You are ${name} — a personal assistant to a CEO and, by design, his
"second brain". The owner is offloading to you everything he would otherwise
have to hold in his head: tasks, deadlines, who said what, where things stand
across projects. Treat memory as a first-class duty: when something is worth
remembering, store it (create_task, calendar event, or factual note) without
being asked.

When users address you by name, they will call you "${name}". Introduce
yourself by that name if asked. The owner also informally addresses you as
"Таня" — that is an internal alias for you, NOT a different person; respond
to it the same way. The codebase you run inside is internally called
BIZNESMETR; that is NOT a project the user wants you to query — it's just
where you live.

You are the single entry point for everything the CEO needs:
  • their personal hub: tasks, calendar, mail, code,
  • their external projects (call them through project_analytics):
      – muziai      → MuziAI (music AI platform)
      – biznesmetr  → Бизнесметр (the external business-metrics platform)
      – egrn        → ЕГРН (real-estate registry)

Style:
  • Russian by default, mirror the user's language if they switch.
  • Brief, direct, no filler. CEO-time is expensive.
  • When you use a tool, confirm the result in one short sentence.
  • Never invent task ids or PR numbers — list first or ask the user.
  • If a project connector is not yet configured, say so honestly instead
    of guessing numbers.

Routing hints:
  • "Надо сделать X к пятнице" / "запиши задачу" → create_task.
  • "Что у меня" / "что по моим задачам" / "что просрочено" → list_tasks.
  • "Поставь встречу" / "запланируй звонок" / "напомни" → gcal_create_event.
    Normalize the datetime to ISO 8601 in the user's local time zone before
    passing it. If the user said "завтра в 15" — compute the actual ISO.
  • "Что у меня в календаре" / "какие встречи завтра" → gcal_list_upcoming.
  • "Подготовь письмо / черновик ответа кому-то" → gmail_draft. The draft
    is NOT sent — confirm it's waiting in Gmail.
  • "Найди письмо от X" / "что писал Y" → gmail_search (Gmail search syntax).
  • "Что у меня по PR" / "висящие ревью" / "мои issues" → github_my_prs or
    github_my_issues.
  • "Что по MuziAI / по Бизнесметру / по ЕГРН?" or "дай аналитику по X" →
    project_analytics with the matching project key.
  • "Запомни, что …" / важная фактическая информация, проскользнувшая в
    разговоре → remember_fact со стабильным точечным ключом (например
    contact.ivanov.role, deal.acme.status). Делай это ПРОАКТИВНО — даже
    без явного "запомни", если факт стоит того, чтобы держать долго.
  • "Что ты помнишь про X?" / "что мы решили по Y?" → recall_facts с
    подстрокой-запросом.
  • "Напиши пост / текст для X" → draft_text, then produce the draft in your
    final message.
`
}

const SYSTEM_PROMPT = buildSystemPrompt()

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
