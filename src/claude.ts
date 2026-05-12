import Anthropic from '@anthropic-ai/sdk'
import { config } from './config'
import { logger } from './logger'
import { recordTurn } from './metrics'
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
    подстрокой-запросом (ищет и по ключу, и по содержанию факта).
  • "Забудь про X" / "удали этот факт" → recall_facts (чтобы найти точный
    ключ) → forget_fact. Никогда не вызывай forget_fact с придуманным
    ключом — только то, что вернул recall.
  • "Напиши пост / текст для X" → draft_text, then produce the draft in your
    final message.
`
}

const SYSTEM_PROMPT = buildSystemPrompt()

const MAX_TOOL_ROUNDS = 6

/**
 * System prompt as a cached content block. Same across all requests for the
 * lifetime of the process, so it's a perfect candidate for prompt caching.
 * Anthropic refunds ~90% of input-token cost on cache hits within the 5-min TTL.
 */
const CACHED_SYSTEM: Anthropic.Messages.TextBlockParam[] = [
  { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
]

/**
 * Tool definitions with cache_control set on the LAST tool. Anthropic caches
 * everything up to and including that marker, so this caches the entire tools
 * array as a single block.
 */
function buildCachedTools(): Anthropic.Messages.Tool[] {
  const tools = getToolDefinitionsForClaude()
  if (tools.length === 0) return tools
  const last = tools[tools.length - 1]!
  return [...tools.slice(0, -1), { ...last, cache_control: { type: 'ephemeral' } }]
}

const CACHED_TOOLS = buildCachedTools()

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
  const toolUses: { name: string; ok: boolean }[] = []

  const messages: Anthropic.Messages.MessageParam[] = [
    ...params.history.map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
    { role: 'user', content: params.userMessage },
  ]

  let cacheReadTotal = 0
  let cacheCreateTotal = 0
  let inputTotal = 0
  let outputTotal = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: config.CLAUDE_MODEL_DEFAULT,
      max_tokens: 2048,
      system: CACHED_SYSTEM,
      tools: CACHED_TOOLS,
      messages,
    })

    cacheReadTotal += response.usage.cache_read_input_tokens ?? 0
    cacheCreateTotal += response.usage.cache_creation_input_tokens ?? 0
    inputTotal += response.usage.input_tokens
    outputTotal += response.usage.output_tokens

    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason !== 'tool_use') {
      const text = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      logger.info(
        {
          rounds: round + 1,
          input: inputTotal,
          output: outputTotal,
          cacheRead: cacheReadTotal,
          cacheCreate: cacheCreateTotal,
        },
        'Claude turn complete',
      )
      recordTurn({
        input: inputTotal,
        output: outputTotal,
        cacheRead: cacheReadTotal,
        cacheCreate: cacheCreateTotal,
        toolUses: toolUses.length,
        lastToolName: toolUses[toolUses.length - 1]?.name ?? null,
      })
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
