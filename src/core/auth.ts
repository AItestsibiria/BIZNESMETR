import { Channel } from '@prisma/client'
import { config } from '../config'

export function isAllowed(channel: Channel, externalUserId: string): boolean {
  if (channel === Channel.TELEGRAM) {
    const allowed = config.ALLOWED_TELEGRAM_USER_IDS
    if (allowed.length === 0) return false
    const id = Number(externalUserId)
    return Number.isFinite(id) && allowed.includes(id)
  }
  if (channel === Channel.MAX) {
    const allowed = config.ALLOWED_MAX_USER_IDS
    if (allowed.length === 0) return false
    return allowed.includes(externalUserId)
  }
  return false
}
