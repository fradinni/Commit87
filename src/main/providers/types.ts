import type {
  ActionRun,
  ActionWorkflow,
  CreatePullRequestInput,
  CreateReleaseInput,
  IntegrationAccount,
  PagedResult,
  ProviderCapabilities,
  ProviderRepo,
  PullRequest,
  Release
} from '@shared/types'

export class ProviderError extends Error {
  readonly status: number
  readonly provider: string
  readonly details?: string

  constructor(message: string, status: number, provider: string, details?: string) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.provider = provider
    this.details = details
  }
}

export interface ProviderClient {
  readonly provider: string
  readonly account: IntegrationAccount
  readonly capabilities: ProviderCapabilities
  getCurrentUser(): Promise<{ login: string; name?: string }>
  listRepos(search?: string): Promise<ProviderRepo[]>
  getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest>
  listPullRequests(owner: string, repo: string, state: 'open' | 'closed' | 'all', page?: string): Promise<PagedResult<PullRequest>>
  createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<PullRequest>
  listReleases(owner: string, repo: string, page?: string): Promise<PagedResult<Release>>
  createRelease(owner: string, repo: string, input: CreateReleaseInput): Promise<Release>
  deleteRelease(owner: string, repo: string, id: string): Promise<void>
  listWorkflows(owner: string, repo: string, page?: string): Promise<PagedResult<ActionWorkflow>>
  listRuns(owner: string, repo: string, workflowId?: string, page?: string): Promise<PagedResult<ActionRun>>
  triggerAction(owner: string, repo: string, workflowId: string | undefined, ref: string, inputs?: Record<string, string>): Promise<void>
}

export type QueryValue = string | number | boolean | readonly string[]

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, QueryValue | undefined>
  body?: unknown
  token: string
  provider: string
  username?: string
  extraHeaders?: Record<string, string>
}

export function pageOf<T>(items: T[], nextPage?: string): PagedResult<T> {
  return { items, hasMore: Boolean(nextPage), ...(nextPage ? { nextPage } : {}) }
}

export function unsupportedPage<T>(): PagedResult<T> {
  return { items: [], hasMore: false, unsupported: true }
}

export function toEpoch(value: string | undefined | null): number {
  if (!value) return 0
  const date = Date.parse(value)
  return Number.isFinite(date) ? date : 0
}

export function requireToken(account: IntegrationAccount, token: string | null): string {
  if (!token) throw new ProviderError(`No token stored for ${account.label}. Add one in Settings → Integrations.`, 401, account.provider)
  return token
}
