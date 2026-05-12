export type ProjectKey = 'muziai' | 'biznesmetr' | 'egrn'

export interface ProjectAnalyticsRequest {
  topic?: string | undefined
  period?: string | undefined
}

export interface ProjectAnalyticsResponse {
  project: string
  configured: boolean
  summary: string
  metrics?: Record<string, unknown>
  fetchedAt: string
}

export interface ProjectConnector {
  readonly key: ProjectKey
  readonly displayName: string
  isConfigured(): boolean
  getAnalytics(req: ProjectAnalyticsRequest): Promise<ProjectAnalyticsResponse>
}

export async function callJsonApi(
  url: string,
  token: string,
  body: unknown,
  timeoutMs = 15_000,
): Promise<{ summary: string; metrics?: Record<string, unknown> }> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = (await res.json()) as { summary?: string; metrics?: Record<string, unknown> }
    return {
      summary: data.summary ?? '(no summary returned)',
      ...(data.metrics ? { metrics: data.metrics } : {}),
    }
  } finally {
    clearTimeout(t)
  }
}
