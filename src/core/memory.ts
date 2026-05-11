import { Channel } from '@prisma/client'
import { prisma } from '../db'
import type { ClaudeTurn } from '../claude'

const HISTORY_LIMIT = 12

export async function upsertUser(params: {
  channel: Channel
  externalUserId: string
  displayName?: string
  isAllowed: boolean
}) {
  return prisma.user.upsert({
    where: {
      channel_externalUserId: {
        channel: params.channel,
        externalUserId: params.externalUserId,
      },
    },
    update: {
      ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
      isAllowed: params.isAllowed,
    },
    create: {
      channel: params.channel,
      externalUserId: params.externalUserId,
      ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
      isAllowed: params.isAllowed,
    },
  })
}

export async function loadHistory(userId: string): Promise<ClaudeTurn[]> {
  const rows = await prisma.message.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
  })
  return rows
    .reverse()
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }))
}

export async function saveMessage(params: {
  userId: string
  role: 'user' | 'assistant'
  content: string
}) {
  await prisma.message.create({
    data: { userId: params.userId, role: params.role, content: params.content },
  })
}
