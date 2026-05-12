import { config } from '../../config'
import {
  callJsonApi,
  type ProjectAnalyticsRequest,
  type ProjectAnalyticsResponse,
  type ProjectConnector,
} from './types'

// TODO(project:biznesmetr-hub): replace contract with the real Бизнесметр
// analytics endpoint once we have the spec. This connector targets the
// EXTERNAL Бизнесметр platform, NOT this assistant codebase (which shares
// the project codename but lives separately).

export class BiznesmetrHubConnector implements ProjectConnector {
  readonly key = 'biznesmetr' as const
  readonly displayName = 'Бизнесметр'

  isConfigured(): boolean {
    return !!(config.BIZNESMETR_HUB_URL && config.BIZNESMETR_HUB_TOKEN)
  }

  async getAnalytics(req: ProjectAnalyticsRequest): Promise<ProjectAnalyticsResponse> {
    if (!config.BIZNESMETR_HUB_URL || !config.BIZNESMETR_HUB_TOKEN) {
      return {
        project: this.displayName,
        configured: false,
        summary: `${this.displayName} integration is not configured yet.`,
        fetchedAt: new Date().toISOString(),
      }
    }
    const data = await callJsonApi(
      `${config.BIZNESMETR_HUB_URL}/analytics`,
      config.BIZNESMETR_HUB_TOKEN,
      req,
    )
    return {
      project: this.displayName,
      configured: true,
      summary: data.summary,
      ...(data.metrics ? { metrics: data.metrics } : {}),
      fetchedAt: new Date().toISOString(),
    }
  }
}

export const biznesmetrHubConnector = new BiznesmetrHubConnector()
