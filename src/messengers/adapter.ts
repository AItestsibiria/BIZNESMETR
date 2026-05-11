import type { Channel } from '@prisma/client'

export interface InboundAttachment {
  kind: 'photo' | 'voice' | 'document' | 'audio'
  fileId: string
  mimeType?: string
}

export interface InboundMessage {
  channel: Channel
  externalUserId: string
  externalChatId: string
  displayName?: string
  text: string
  attachments: InboundAttachment[]
  receivedAt: Date
}

export interface OutboundMessage {
  externalChatId: string
  text: string
}

export interface MessengerAdapter {
  readonly channel: Channel
  send(message: OutboundMessage): Promise<void>
}

export type IncomingHandler = (message: InboundMessage) => Promise<void>
