import path from 'node:path'
import express from 'express'
import { Channel } from '@prisma/client'
import { config } from './config'
import { logger } from './logger'
import { prisma } from './db'
import { TelegramAdapter } from './messengers/telegram'
import { MaxAdapter } from './messengers/max'
import { buildIncomingHandler } from './core/router'
import { startDigestScheduler } from './core/scheduler'
import { sheetsClient } from './integrations/sheets'
import { dashboardRouter } from './dashboard/api'
import { basicAuth } from './dashboard/auth'
import type { MessengerAdapter } from './messengers/adapter'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

async function main(): Promise<void> {
  const app = express()
  app.use(express.json({ limit: '1mb' }))

  // Adapters are created with a placeholder handler first, then we wire
  // the real handler that needs to know about the adapters (to reply back).
  const adapters: Partial<Record<Channel, MessengerAdapter>> = {}
  const getAdapter = (channel: Channel): MessengerAdapter => {
    const adapter = adapters[channel]
    if (!adapter) throw new Error(`No adapter registered for channel ${channel}`)
    return adapter
  }
  const handle = buildIncomingHandler(getAdapter)

  if (config.TELEGRAM_BOT_TOKEN) {
    const telegram = new TelegramAdapter(handle)
    adapters[Channel.TELEGRAM] = telegram
    app.use(telegram.webhookCallback())
    logger.info({ path: config.TELEGRAM_WEBHOOK_PATH }, 'Telegram webhook mounted')
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN missing — Telegram disabled')
  }

  if (config.MAX_BOT_TOKEN) {
    adapters[Channel.MAX] = new MaxAdapter(handle)
    // TODO(muziai/max): mount MAX webhook route here.
    logger.info('MAX adapter registered (webhook route not yet implemented)')
  }

  // Dashboard (UI + API). Mount BEFORE /health so we don't accidentally
  // serve the JSON 200 status as the dashboard page.
  app.use('/api/dashboard', dashboardRouter())
  const publicDir = path.resolve(__dirname, '..', 'public')
  app.use('/dashboard', basicAuth(), express.static(publicDir))
  app.get('/', basicAuth(), (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'))
  })

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() })
  })

  app.get('/ready', async (_req, res) => {
    const checks: Record<string, { ok: boolean; error?: string }> = {}
    try {
      await prisma.$queryRaw`SELECT 1`
      checks['postgres'] = { ok: true }
    } catch (error) {
      checks['postgres'] = { ok: false, error: errorMessage(error) }
    }
    if (config.HUB_SHEET_ID) {
      try {
        await sheetsClient.ensureHeaders()
        checks['sheets'] = { ok: true }
      } catch (error) {
        checks['sheets'] = { ok: false, error: errorMessage(error) }
      }
    }
    const allOk = Object.values(checks).every((c) => c.ok)
    res.status(allOk ? 200 : 503).json({ ready: allOk, checks })
  })

  if (config.HUB_SHEET_ID) {
    try {
      await sheetsClient.ensureHeaders()
    } catch (error) {
      logger.warn({ error }, 'Failed to ensure Sheets headers — continuing')
    }
  }

  const digest = startDigestScheduler((channel) => adapters[channel])

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'BIZNESMETR is up')
  })

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down')
    digest?.stop()
    server.close()
    await prisma.$disconnect()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  logger.fatal({ error }, 'Startup failed')
  process.exit(1)
})
