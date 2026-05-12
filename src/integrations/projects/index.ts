import { biznesmetrHubConnector } from './biznesmetr'
import { egrnConnector } from './egrn'
import { muziAiConnector } from './muziai'
import type { ProjectConnector, ProjectKey } from './types'

export const projectConnectors: Record<ProjectKey, ProjectConnector> = {
  muziai: muziAiConnector,
  biznesmetr: biznesmetrHubConnector,
  egrn: egrnConnector,
}

export type { ProjectConnector, ProjectKey } from './types'
