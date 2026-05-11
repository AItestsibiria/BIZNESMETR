import pino from 'pino'
import { config } from './config'

const isDev = config.NODE_ENV === 'development'

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'biznesmetr' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-telegram-bot-api-secret-token"]',
      '*.token',
      '*.apiKey',
      '*.password',
      '*.secret',
    ],
    censor: '[REDACTED]',
  },
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
    },
  }),
})
