/**
 * Process-lifetime counters surfaced on the dashboard.
 * Reset on every deploy/restart — that's fine for a "live" panel.
 */

interface Counters {
  startedAt: Date
  turns: number
  toolUses: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  lastTurnAt: Date | null
  lastToolName: string | null
}

const counters: Counters = {
  startedAt: new Date(),
  turns: 0,
  toolUses: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  lastTurnAt: null,
  lastToolName: null,
}

export function recordTurn(usage: {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  toolUses: number
  lastToolName?: string | null
}): void {
  counters.turns += 1
  counters.toolUses += usage.toolUses
  counters.inputTokens += usage.input
  counters.outputTokens += usage.output
  counters.cacheReadTokens += usage.cacheRead
  counters.cacheCreateTokens += usage.cacheCreate
  counters.lastTurnAt = new Date()
  if (usage.lastToolName) counters.lastToolName = usage.lastToolName
}

export interface MetricsSnapshot {
  startedAt: string
  uptimeSeconds: number
  turns: number
  toolUses: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  cacheHitRatio: number | null
  lastTurnAt: string | null
  lastToolName: string | null
}

export function getMetricsSnapshot(): MetricsSnapshot {
  const cacheTotal = counters.cacheReadTokens + counters.cacheCreateTokens + counters.inputTokens
  const hitRatio = cacheTotal === 0 ? null : counters.cacheReadTokens / cacheTotal
  return {
    startedAt: counters.startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - counters.startedAt.getTime()) / 1000),
    turns: counters.turns,
    toolUses: counters.toolUses,
    inputTokens: counters.inputTokens,
    outputTokens: counters.outputTokens,
    cacheReadTokens: counters.cacheReadTokens,
    cacheCreateTokens: counters.cacheCreateTokens,
    cacheHitRatio: hitRatio,
    lastTurnAt: counters.lastTurnAt ? counters.lastTurnAt.toISOString() : null,
    lastToolName: counters.lastToolName,
  }
}
