import { Telegraf } from 'telegraf'
import type { Update } from 'telegraf/typings/core/types/typegram'
import { Channel } from '@prisma/client'
import { config } from '../config'
import { logger } from '../logger'
import type { IncomingHandler, MessengerAdapter, OutboundMessage } from './adapter'

// TODO(muziai): replace this stub with the patterns used in MuziAI
// (webhook registration, middleware chain, error handling, attachment parsing).

export class TelegramAdapter implements MessengerAdapter {
  readonly channel = Channel.TELEGRAM
  private readonly bot: Telegraf

  constructor(private readonly onIncoming: IncomingHandler) {
    if (!config.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is required to start TelegramAdapter')
    }
    this.bot = new Telegraf(config.TELEGRAM_BOT_TOKEN)
    this.registerHandlers()
  }

  private registerHandlers(): void {
    this.bot.on('message', async (ctx) => {
      const msg = ctx.message
      const from = ctx.from
      if (!from) return

      const text =
        'text' in msg
          ? msg.text
          : 'caption' in msg && typeof msg.caption === 'string'
            ? msg.caption
            : ''

      try {
        await this.onIncoming({
          channel: Channel.TELEGRAM,
          externalUserId: String(from.id),
          externalChatId: String(ctx.chat.id),
          ...(from.username || from.first_name
            ? { displayName: from.username ?? from.first_name }
            : {}),
          text,
          attachments: [], // TODO(muziai): map photo/voice/document/audio
          receivedAt: new Date(),
        })
      } catch (error) {
        logger.error({ error, updateId: ctx.update.update_id }, 'Telegram handler failed')
      }
    })
  }

  /** Express middleware that processes a single webhook update. */
  webhookCallback() {
    return this.bot.webhookCallback(config.TELEGRAM_WEBHOOK_PATH, {
      ...(config.TELEGRAM_WEBHOOK_SECRET ? { secretToken: config.TELEGRAM_WEBHOOK_SECRET } : {}),
    })
  }

  async handleUpdate(update: Update): Promise<void> {
    await this.bot.handleUpdate(update)
  }

  async send(message: OutboundMessage): Promise<void> {
    await this.bot.telegram.sendMessage(message.externalChatId, message.text)
  }
}
