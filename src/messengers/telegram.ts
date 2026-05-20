import { Telegraf } from 'telegraf'
import type { Message, Update } from 'telegraf/typings/core/types/typegram'
import { Channel } from '@prisma/client'
import { config } from '../config'
import { logger } from '../logger'
import { getTranscriber } from '../integrations/voice'
import type { IncomingHandler, MessengerAdapter, OutboundMessage } from './adapter'

// TODO(muziai): replace text/voice handler internals with the patterns used
// in MuziAI (webhook middleware chain, error wrapping, attachment parsing,
// rate limiting). Current implementation is a working baseline.

const VOICE_TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024 // OpenAI Whisper limit
const VOICE_MAX_DURATION_SEC = 600 // 10 minutes — sanity cap

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

      try {
        const text = await this.resolveText(msg)

        await this.onIncoming({
          channel: Channel.TELEGRAM,
          externalUserId: String(from.id),
          externalChatId: String(ctx.chat.id),
          ...(from.username || from.first_name
            ? { displayName: from.username ?? from.first_name }
            : {}),
          text,
          attachments: [], // TODO(muziai): also surface photos/documents/audio metadata
          receivedAt: new Date(),
        })
      } catch (error) {
        logger.error({ error, updateId: ctx.update.update_id }, 'Telegram handler failed')
        try {
          await this.bot.telegram.sendMessage(
            ctx.chat.id,
            'Не смог обработать сообщение — попробуй ещё раз или напиши текстом.',
          )
        } catch {
          /* swallow — fall through */
        }
      }
    })
  }

  /**
   * Returns the effective text of a message. For text/caption — returned as-is.
   * For voice/audio — downloads the file and runs it through the transcriber.
   */
  private async resolveText(msg: Message): Promise<string> {
    if ('text' in msg && msg.text) return msg.text
    if ('caption' in msg && typeof msg.caption === 'string' && msg.caption) return msg.caption

    const voice = 'voice' in msg ? msg.voice : undefined
    const audio = 'audio' in msg ? msg.audio : undefined
    const media = voice ?? audio
    if (!media) return ''

    if (media.duration && media.duration > VOICE_MAX_DURATION_SEC) {
      logger.warn({ duration: media.duration }, 'Voice too long — skipping transcription')
      return '[голосовое слишком длинное, пришли короче]'
    }
    if (media.file_size && media.file_size > VOICE_TRANSCRIBE_MAX_BYTES) {
      logger.warn({ size: media.file_size }, 'Voice exceeds STT size limit')
      return '[голосовое слишком большое для распознавания]'
    }

    const transcriber = getTranscriber()
    if (!transcriber.isConfigured()) {
      logger.warn({ provider: transcriber.name }, 'Voice received but transcription disabled')
      return '[голосовое: распознавание не настроено — задай OPENAI_API_KEY]'
    }

    const buffer = await this.downloadFile(media.file_id)
    const transcription = await transcriber.transcribe({
      audio: buffer,
      mimeType: media.mime_type ?? 'audio/ogg',
      filename: voice ? 'voice.ogg' : 'audio.bin',
      languageHint: config.STT_LANGUAGE_HINT,
    })
    return transcription.text
  }

  private async downloadFile(fileId: string): Promise<Buffer> {
    if (!config.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is required to download files')
    }
    const file = await this.bot.telegram.getFile(fileId)
    if (!file.file_path) throw new Error('Telegram returned a file with no file_path')
    const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`)
    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
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
