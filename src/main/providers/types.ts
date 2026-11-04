import type {
  ActionRun,
  ActionWorkflow,
  CreatePullRequestInput,
  CreateReleaseInput,
  IntegrationAccount,
  PullRequest,
  ProviderRepo,
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
  getCurrentUser(): Promise<{ login: string; name?: string }>
  listRepos(search?: string): Promise<ProviderRepo[]>
  listPullRequests(owner: string, repo: string, state: 'open' | 'closed' | 'all'): Promise<PullRequest[]>
  createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<PullRequest>
  listReleases(owner: string, repo: string): Promise<Release[]>
  createRelease(owner: string, repo: string, input: CreateReleaseInput): Promise<Release>
  deleteRelease(owner: string, repo: string, id: string): Promise<void>
  listWorkflows(owner: string, repo: string): Promise<ActionWorkflow[]>
  listRuns(owner: string, repo: string, workflowId?: string): Promise<ActionRun[]>
  triggerAction(owner: string, repo: string, workflowId: string | undefined, ref: string, inputs?: Record<string, string>): Promise<void>
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  token: string
  provider: string
  username?: string
  extraHeaders?: Record<string, string>
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
