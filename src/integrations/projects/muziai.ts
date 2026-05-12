import { config } from '../../config'
import {
  callJsonApi,
  type ProjectAnalyticsRequest,
  type ProjectAnalyticsResponse,
  type ProjectConnector,
} from './types'

// TODO(project:muziai): replace path + body shape once the MuziAI team
// confirms its analytics endpoint. The contract assumed here is:
//   POST {MUZIAI_API_URL}/analytics
//   Authorization: Bearer {MUZIAI_API_TOKEN}
//   Body: { topic?: string, period?: string }
//   Response: { summary: string, metrics?: Record<string, unknown> }

export class MuziAiConnector implements ProjectConnector {
  readonly key = 'muziai' as const
  readonly displayName = 'MuziAI'

  isConfigured(): boolean {
    return !!(config.MUZIAI_API_URL && config.MUZIAI_API_TOKEN)
  }

  async getAnalytics(req: ProjectAnalyticsRequest): Promise<ProjectAnalyticsResponse> {
    if (!config.MUZIAI_API_URL || !config.MUZIAI_API_TOKEN) {
      return notConfigured(this.displayName)
    }
    const data = await callJsonApi(`${config.MUZIAI_API_URL}/analytics`, config.MUZIAI_API_TOKEN, req)
    return {
      project: this.displayName,
      configured: true,
      summary: data.summary,
      ...(data.metrics ? { metrics: data.metrics } : {}),
      fetchedAt: new Date().toISOString(),
    }
  }
}

function notConfigured(displayName: string): ProjectAnalyticsResponse {
  return {
    project: displayName,
    configured: false,
    summary: `${displayName} integration is not configured yet.`,
    fetchedAt: new Date().toISOString(),
  }
}

export const muziAiConnector = new MuziAiConnector()
