import { google, sheets_v4 } from 'googleapis'
import { config } from '../config'
import { logger } from '../logger'

export interface TaskRow {
  id: string
  createdAt: string
  project: string | null
  title: string
  description: string | null
  due: string | null
  priority: 'low' | 'normal' | 'high' | null
  status: 'open' | 'in_progress' | 'done' | 'cancelled'
  assignee: string | null
  sourceChat: string | null
  lastUpdate: string
}

const TASKS_SHEET = 'Tasks'
const TASKS_HEADER = [
  'id',
  'created_at',
  'project',
  'title',
  'description',
  'due',
  'priority',
  'status',
  'assignee',
  'source_chat',
  'last_update',
] as const

export class SheetsClient {
  private sheets: sheets_v4.Sheets | null = null

  private async client(): Promise<sheets_v4.Sheets> {
    if (this.sheets) return this.sheets
    const auth = new google.auth.GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
      ],
    })
    this.sheets = google.sheets({ version: 'v4', auth })
    return this.sheets
  }

  private get spreadsheetId(): string {
    if (!config.HUB_SHEET_ID) {
      throw new Error('HUB_SHEET_ID is not configured')
    }
    return config.HUB_SHEET_ID
  }

  async appendTask(row: TaskRow): Promise<void> {
    const sheets = await this.client()
    await sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${TASKS_SHEET}!A:K`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [taskToRow(row)] },
    })
    logger.info({ taskId: row.id }, 'Task appended to Sheets')
  }

  async listTasks(filter?: {
    status?: TaskRow['status']
    project?: string
    limit?: number
  }): Promise<TaskRow[]> {
    const sheets = await this.client()
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${TASKS_SHEET}!A2:K`,
    })
    const values = res.data.values ?? []
    let tasks = values.map(rowToTask).filter((t): t is TaskRow => t !== null)
    if (filter?.status) tasks = tasks.filter((t) => t.status === filter.status)
    if (filter?.project) tasks = tasks.filter((t) => t.project === filter.project)
    if (filter?.limit) tasks = tasks.slice(0, filter.limit)
    return tasks
  }

  async updateTask(id: string, patch: Partial<Omit<TaskRow, 'id' | 'createdAt'>>): Promise<TaskRow | null> {
    const sheets = await this.client()
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${TASKS_SHEET}!A2:K`,
    })
    const values = res.data.values ?? []
    const rowIndex = values.findIndex((row) => row[0] === id)
    if (rowIndex === -1) return null

    const current = rowToTask(values[rowIndex]!)
    if (!current) return null

    const updated: TaskRow = {
      ...current,
      ...patch,
      lastUpdate: new Date().toISOString(),
    }
    const sheetRow = rowIndex + 2
    await sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${TASKS_SHEET}!A${sheetRow}:K${sheetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [taskToRow(updated)] },
    })
    return updated
  }

  async ensureHeaders(): Promise<void> {
    const sheets = await this.client()
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${TASKS_SHEET}!A1:K1`,
    })
    const headers = res.data.values?.[0] ?? []
    if (headers.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${TASKS_SHEET}!A1:K1`,
        valueInputOption: 'RAW',
        requestBody: { values: [[...TASKS_HEADER]] },
      })
      logger.info('Initialized Tasks sheet headers')
    }
  }
}

function taskToRow(t: TaskRow): string[] {
  return [
    t.id,
    t.createdAt,
    t.project ?? '',
    t.title,
    t.description ?? '',
    t.due ?? '',
    t.priority ?? '',
    t.status,
    t.assignee ?? '',
    t.sourceChat ?? '',
    t.lastUpdate,
  ]
}

function rowToTask(row: string[]): TaskRow | null {
  if (!row[0] || !row[3]) return null
  return {
    id: row[0],
    createdAt: row[1] ?? '',
    project: row[2] || null,
    title: row[3],
    description: row[4] || null,
    due: row[5] || null,
    priority: (row[6] as TaskRow['priority']) || null,
    status: (row[7] as TaskRow['status']) || 'open',
    assignee: row[8] || null,
    sourceChat: row[9] || null,
    lastUpdate: row[10] ?? '',
  }
}

export const sheetsClient = new SheetsClient()
