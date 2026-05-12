import { logger } from '../logger'
import { runClaude } from '../claude'
import type { InboundMessage, MessengerAdapter } from '../messengers/adapter'
import { isAllowed } from './auth'
import { loadHistory, saveMessage, upsertUser } from './memory'

export function buildIncomingHandler(getAdapter: (channel: InboundMessage['channel']) => MessengerAdapter) {
  return async function handle(message: InboundMessage): Promise<void> {
    const allowed = isAllowed(message.channel, message.externalUserId)
    const user = await upsertUser({
      channel: message.channel,
      externalUserId: message.externalUserId,
      ...(message.displayName !== undefined ? { displayName: message.displayName } : {}),
      isAllowed: allowed,
    })

    const adapter = getAdapter(message.channel)

    if (!allowed) {
      logger.warn(
        { channel: message.channel, externalUserId: message.externalUserId },
        'Rejected message from non-whitelisted user',
      )
      await adapter.send({
        externalChatId: message.externalChatId,
        text: 'Доступ к этому ассистенту ограничен.',
      })
      return
    }

    if (!message.text.trim()) {
      await adapter.send({
        externalChatId: message.externalChatId,
        text: 'Получил пустое сообщение — напиши текстом, что нужно.',
      })
      return
    }

    const history = await loadHistory(user.id)
    await saveMessage({ userId: user.id, role: 'user', content: message.text })

    try {
      const result = await runClaude({
        history,
        userMessage: message.text,
        ctx: { externalChatId: message.externalChatId, userId: user.id },
      })
      const reply = result.reply || 'Готово.'
      await saveMessage({ userId: user.id, role: 'assistant', content: reply })
      await adapter.send({ externalChatId: message.externalChatId, text: reply })
      logger.info(
        { userId: user.id, tools: result.toolUses },
        'Handled message',
      )
    } catch (error) {
      logger.error({ error, userId: user.id }, 'Failed to handle message')
      await adapter.send({
        externalChatId: message.externalChatId,
        text: 'Что-то пошло не так на моей стороне. Уже смотрю.',
      })
    }
  }
}
