import { google, calendar_v3 } from 'googleapis'
import { config } from '../config'
import { logger } from '../logger'

export interface CalendarEventInput {
  title: string
  description?: string | undefined
  start: string
  end?: string | undefined
  location?: string | undefined
  attendees?: string[] | undefined
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  location: string | null
  htmlLink: string | null
}

export class CalendarClient {
  private calendar: calendar_v3.Calendar | null = null

  private async client(): Promise<calendar_v3.Calendar> {
    if (this.calendar) return this.calendar
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/calendar'],
    })
    this.calendar = google.calendar({ version: 'v3', auth })
    return this.calendar
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    const calendar = await this.client()
    const start = parseWhen(input.start)
    const end = input.end ? parseWhen(input.end) : addMinutes(start, 60)

    const res = await calendar.events.insert({
      calendarId: config.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        start: { dateTime: start.toISOString(), timeZone: config.DEFAULT_TZ },
        end: { dateTime: end.toISOString(), timeZone: config.DEFAULT_TZ },
        ...(input.attendees && input.attendees.length > 0
          ? { attendees: input.attendees.map((email) => ({ email })) }
          : {}),
      },
    })
    const event = mapEvent(res.data)
    logger.info({ eventId: event.id }, 'Calendar event created')
    return event
  }

  async listUpcoming(params: { hours?: number; max?: number } = {}): Promise<CalendarEvent[]> {
    const calendar = await this.client()
    const now = new Date()
    const horizon = new Date(now.getTime() + (params.hours ?? 24) * 60 * 60 * 1000)
    const res = await calendar.events.list({
      calendarId: config.GOOGLE_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: horizon.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: params.max ?? 20,
    })
    return (res.data.items ?? []).map(mapEvent)
  }
}

function parseWhen(value: string): Date {
  // Accept ISO-ish strings; fall back to Date constructor.
  // Natural-language parsing ("завтра в 15") is left to Claude — it will
  // pass already-normalized ISO strings via the tool input.
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date/time: ${value}`)
  }
  return date
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000)
}

function mapEvent(raw: calendar_v3.Schema$Event): CalendarEvent {
  return {
    id: raw.id ?? '',
    title: raw.summary ?? '(no title)',
    start: raw.start?.dateTime ?? raw.start?.date ?? '',
    end: raw.end?.dateTime ?? raw.end?.date ?? '',
    location: raw.location ?? null,
    htmlLink: raw.htmlLink ?? null,
  }
}

export const calendarClient = new CalendarClient()
