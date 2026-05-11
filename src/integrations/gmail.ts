import { google, gmail_v1 } from 'googleapis'
import { config } from '../config'
import { logger } from '../logger'

export interface GmailDraftInput {
  to: string
  subject: string
  body: string
  cc?: string | undefined
  bcc?: string | undefined
}

export interface GmailSearchResult {
  id: string
  threadId: string
  snippet: string
  subject: string | null
  from: string | null
  date: string | null
}

export class GmailClient {
  private gmail: gmail_v1.Gmail | null = null

  private async client(): Promise<gmail_v1.Gmail> {
    if (this.gmail) return this.gmail
    if (!config.GMAIL_USER_EMAIL) {
      throw new Error('GMAIL_USER_EMAIL is not configured — Gmail tools are disabled')
    }
    // Domain-wide delegation: the service account impersonates the user.
    // Requires Workspace admin to grant the SA the Gmail scopes.
    const auth = new google.auth.GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/gmail.readonly',
      ],
      clientOptions: { subject: config.GMAIL_USER_EMAIL },
    })
    this.gmail = google.gmail({ version: 'v1', auth })
    return this.gmail
  }

  async createDraft(input: GmailDraftInput): Promise<{ id: string }> {
    const gmail = await this.client()
    const raw = buildRawMessage(input)
    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw } },
    })
    const id = res.data.id ?? ''
    logger.info({ draftId: id, to: input.to }, 'Gmail draft created')
    return { id }
  }

  async search(query: string, max = 10): Promise<GmailSearchResult[]> {
    const gmail = await this.client()
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: max,
    })
    const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id)
    if (ids.length === 0) return []

    const messages = await Promise.all(
      ids.map((id) =>
        gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date'],
        }),
      ),
    )

    return messages.map((m) => {
      const headers = m.data.payload?.headers ?? []
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null
      return {
        id: m.data.id ?? '',
        threadId: m.data.threadId ?? '',
        snippet: m.data.snippet ?? '',
        subject: getHeader('Subject'),
        from: getHeader('From'),
        date: getHeader('Date'),
      }
    })
  }
}

function buildRawMessage(input: GmailDraftInput): string {
  const lines = [
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    ...(input.bcc ? [`Bcc: ${input.bcc}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    input.body,
  ]
  const message = lines.join('\r\n')
  return Buffer.from(message, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function encodeHeader(value: string): string {
  // If the subject contains non-ASCII, encode as RFC 2047 base64.
  if (/^[\x20-\x7E]*$/.test(value)) return value
  const encoded = Buffer.from(value, 'utf-8').toString('base64')
  return `=?UTF-8?B?${encoded}?=`
}

export const gmailClient = new GmailClient()
