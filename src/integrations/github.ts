import { Octokit } from '@octokit/rest'
import { config } from '../config'
import { logger } from '../logger'

export interface PrSummary {
  number: number
  title: string
  url: string
  repo: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  updatedAt: string
}

export interface IssueSummary {
  number: number
  title: string
  url: string
  repo: string
  state: 'open' | 'closed'
  labels: string[]
  updatedAt: string
}

export class GitHubClient {
  private octokit: Octokit | null = null

  private client(): Octokit {
    if (this.octokit) return this.octokit
    if (!config.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN is not configured — GitHub tools are disabled')
    }
    this.octokit = new Octokit({ auth: config.GITHUB_TOKEN })
    return this.octokit
  }

  async listMyOpenPRs(opts: { limit?: number } = {}): Promise<PrSummary[]> {
    const octokit = this.client()
    const q = buildSearchQuery('pr', 'open', config.GITHUB_OWNER)
    const res = await octokit.search.issuesAndPullRequests({
      q,
      per_page: opts.limit ?? 20,
      sort: 'updated',
      order: 'desc',
    })
    logger.info({ count: res.data.total_count }, 'GitHub PR search complete')
    return res.data.items.map(mapPr)
  }

  async listMyOpenIssues(opts: { limit?: number } = {}): Promise<IssueSummary[]> {
    const octokit = this.client()
    const q = buildSearchQuery('issue', 'open', config.GITHUB_OWNER)
    const res = await octokit.search.issuesAndPullRequests({
      q,
      per_page: opts.limit ?? 20,
      sort: 'updated',
      order: 'desc',
    })
    return res.data.items.map(mapIssue)
  }
}

function buildSearchQuery(kind: 'pr' | 'issue', state: 'open' | 'closed', owner?: string): string {
  const parts = [`is:${kind}`, `is:${state}`, 'author:@me']
  if (owner) parts.push(`org:${owner}`)
  return parts.join(' ')
}

interface SearchItem {
  number: number
  title: string
  html_url: string
  state: string
  repository_url: string
  draft?: boolean
  pull_request?: { merged_at?: string | null } | undefined
  updated_at: string
  labels?: { name?: string }[]
}

function repoFromUrl(repositoryUrl: string): string {
  // https://api.github.com/repos/owner/name → owner/name
  const m = repositoryUrl.match(/repos\/([^/]+\/[^/]+)$/)
  return m?.[1] ?? repositoryUrl
}

function mapPr(item: SearchItem): PrSummary {
  const merged = !!item.pull_request?.merged_at
  return {
    number: item.number,
    title: item.title,
    url: item.html_url,
    repo: repoFromUrl(item.repository_url),
    state: merged ? 'merged' : (item.state as 'open' | 'closed'),
    draft: !!item.draft,
    updatedAt: item.updated_at,
  }
}

function mapIssue(item: SearchItem): IssueSummary {
  return {
    number: item.number,
    title: item.title,
    url: item.html_url,
    repo: repoFromUrl(item.repository_url),
    state: item.state as 'open' | 'closed',
    labels: (item.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
    updatedAt: item.updated_at,
  }
}

export const githubClient = new GitHubClient()
