import { Channel } from '@prisma/client'
import { logger } from '../logger'
import type { IncomingHandler, MessengerAdapter, OutboundMessage } from './adapter'

// TODO(muziai/max): implement MAX bot adapter.
// MAX Bot API docs: https://dev.max.ru/docs-api
// Same interface as TelegramAdapter — webhook + send().
//
// Sprint 2 task. Placeholder so that the rest of the codebase can already
// import this and the router can already be wired for two channels.

export class MaxAdapter implements MessengerAdapter {
  readonly channel = Channel.MAX

  constructor(_onIncoming: IncomingHandler) {
    // _onIncoming will be wired up once the MAX webhook handler is implemented.
    logger.warn('MaxAdapter is a stub — incoming handling not yet implemented')
  }

  async send(message: OutboundMessage): Promise<void> {
    logger.warn({ chatId: message.externalChatId }, 'MaxAdapter.send not implemented yet')
  }
}
