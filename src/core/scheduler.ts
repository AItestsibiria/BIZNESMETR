import cron from 'node-cron'
import { Channel } from '@prisma/client'
import { config } from '../config'
import { logger } from '../logger'
import { composeDigest, formatDigestForChat } from './digest'
import type { MessengerAdapter } from '../messengers/adapter'

export interface ScheduledTask {
  stop: () => void
}

/**
 * Start the morning digest job if DIGEST_CRON is configured.
 * For Sprint 1 we send the digest only via Telegram (the only working
 * adapter). DIGEST_CHAT_IDS is a comma-separated list of chat ids.
 */
export function startDigestScheduler(
  getAdapter: (channel: Channel) => MessengerAdapter | undefined,
): ScheduledTask | null {
  if (!config.DIGEST_CRON) {
    logger.info('DIGEST_CRON not set — digest scheduler disabled')
    return null
  }
  if (!cron.validate(config.DIGEST_CRON)) {
    logger.error({ cron: config.DIGEST_CRON }, 'Invalid DIGEST_CRON expression — scheduler disabled')
    return null
  }

  const task = cron.schedule(
    config.DIGEST_CRON,
    () => {
      void runDigest(getAdapter)
    },
    { timezone: config.DEFAULT_TZ },
  )

  logger.info({ cron: config.DIGEST_CRON, tz: config.DEFAULT_TZ }, 'Digest scheduler started')
  return { stop: () => task.stop() }
}

async function runDigest(
  getAdapter: (channel: Channel) => MessengerAdapter | undefined,
): Promise<void> {
  try {
    const payload = await composeDigest()
    const text = formatDigestForChat(payload)

    const recipients = config.DIGEST_CHAT_IDS
    if (recipients.length === 0) {
      logger.info({ payload }, 'Digest composed (no recipients configured — log only)')
      return
    }

    // TODO(muziai): once MAX adapter is implemented, route per-recipient by
    // channel. For Sprint 1 we assume all DIGEST_CHAT_IDS are Telegram.
    const telegram = getAdapter(Channel.TELEGRAM)
    if (!telegram) {
      logger.warn('Telegram adapter not available — digest not delivered')
      return
    }
    for (const chatId of recipients) {
      try {
        await telegram.send({ externalChatId: chatId, text })
      } catch (error) {
        logger.error({ error, chatId }, 'Failed to deliver digest')
      }
    }
    logger.info({ recipients: recipients.length }, 'Digest delivered')
  } catch (error) {
    logger.error({ error }, 'Digest run failed')
  }
}
