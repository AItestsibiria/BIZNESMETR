import { config } from '../../config'
import {
  callJsonApi,
  type ProjectAnalyticsRequest,
  type ProjectAnalyticsResponse,
  type ProjectConnector,
} from './types'

// TODO(project:egrn): the public ЕГРН (Росреестр) API is rate-limited and
// has its own paid wrappers. Swap this stub for whichever provider the user
// integrates with (api.checko.ru / dadata / direct Росреестр / etc.).

export class EgrnConnector implements ProjectConnector {
  readonly key = 'egrn' as const
  readonly displayName = 'ЕГРН'

  isConfigured(): boolean {
    return !!(config.EGRN_API_URL && config.EGRN_API_TOKEN)
  }

  async getAnalytics(req: ProjectAnalyticsRequest): Promise<ProjectAnalyticsResponse> {
    if (!config.EGRN_API_URL || !config.EGRN_API_TOKEN) {
      return {
        project: this.displayName,
        configured: false,
        summary: `${this.displayName} integration is not configured yet.`,
        fetchedAt: new Date().toISOString(),
      }
    }
    const data = await callJsonApi(`${config.EGRN_API_URL}/analytics`, config.EGRN_API_TOKEN, req)
    return {
      project: this.displayName,
      configured: true,
      summary: data.summary,
      ...(data.metrics ? { metrics: data.metrics } : {}),
      fetchedAt: new Date().toISOString(),
    }
  }
}

export const egrnConnector = new EgrnConnector()
