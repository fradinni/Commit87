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
import { providerCapabilities } from '@shared/types'
import { apiRequest, apiRequestWithHeaders, ensureSuffix, joinUrl, nextPageFromLink, positiveInt } from './http'
import type { ProviderClient } from './types'
import { pageOf, requireToken, toEpoch } from './types'

interface GithubRepo {
  id: number
  full_name: string
  name: string
  owner: { login: string }
  default_branch: string
  private: boolean
  html_url: string
  clone_url: string
  ssh_url?: string
  description?: string
  updated_at?: string
}

interface GithubPullHead {
  ref: string
  sha?: string
  repo?: { full_name?: string } | null
}

interface GithubPull {
  id: number
  number: number
  title: string
  state: string
  draft?: boolean
  user?: { login: string }
  head: GithubPullHead
  base: { ref: string }
  html_url: string
  created_at: string
  updated_at: string
  merged_at?: string | null
  additions?: number
  deletions?: number
  mergeable?: boolean | null
}

interface GithubRelease {
  id: number
  tag_name: string
  name: string | null
  draft: boolean
  prerelease: boolean
  created_at: string
  published_at?: string | null
  html_url: string
  author?: { login: string }
  body?: string
}

interface GithubWorkflow {
  id: number
  name: string
  path: string
  state?: string
}

interface GithubRun {
  id: number
  name: string | null
  workflow_id: number
  run_number: number
  status: string
  conclusion: string | null
  head_branch: string
  head_sha: string
  event: string
  created_at: string
  updated_at: string
  html_url: string
  actor?: { login: string }
}

function apiBase(account: IntegrationAccount): string {
  const base = account.baseUrl.replace(/\/+$/, '')
  if (base.includes('api.github.com')) return base
  if (base.endsWith('/api/v3')) return base
  return ensureSuffix(base, '/api/v3')
}

function pageQuery(page: string | undefined): number | undefined {
  return positiveInt(page)
}

export class GithubClient implements ProviderClient {
  readonly provider = 'github'
  readonly account: IntegrationAccount
  readonly capabilities: ProviderCapabilities = providerCapabilities('github')
  private readonly token: string
  private readonly base: string

  constructor(account: IntegrationAccount, token: string | null) {
    this.account = account
    this.token = requireToken(account, token)
    this.base = apiBase(account)
  }

  private request<T>(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
      query?: Record<string, string | number | boolean | undefined>
      body?: unknown
    } = {}
  ): Promise<T> {
    return apiRequest<T>(joinUrl(this.base, path), {
      ...options,
      token: this.token,
      provider: this.provider,
      username: this.account.username
    })
  }

  async getCurrentUser(): Promise<{ login: string; name?: string }> {
    const user = await this.request<{ login: string; name?: string }>('/user')
    return { login: user.login, name: user.name }
  }

  async listRepos(search?: string): Promise<ProviderRepo[]> {
    const repos = await this.request<GithubRepo[]>('/user/repos', {
      query: { per_page: 100, sort: 'updated', affiliation: 'owner,collaborator,organization_member' }
    })
    const term = search?.trim().toLowerCase()
    return repos
      .filter((repo) => !term || repo.full_name.toLowerCase().includes(term))
      .map((repo) => ({
        id: String(repo.id),
        fullName: repo.full_name,
        name: repo.name,
        owner: repo.owner.login,
        defaultBranch: repo.default_branch,
        private: repo.private,
        webUrl: repo.html_url,
        cloneUrl: repo.clone_url,
        sshUrl: repo.ssh_url,
        description: repo.description,
        updatedAt: toEpoch(repo.updated_at)
      }))
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest> {
    const pull = await this.request<GithubPull>(`/repos/${owner}/${repo}/pulls/${number}`)
    return this.mapPull(pull)
  }

  async listPullRequests(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all',
    page?: string
  ): Promise<PagedResult<PullRequest>> {
    const response = await apiRequestWithHeaders<GithubPull[]>(joinUrl(this.base, `/repos/${owner}/${repo}/pulls`), {
      query: { state, per_page: 50, sort: 'updated', direction: 'desc', page: pageQuery(page) },
      token: this.token,
      provider: this.provider,
      username: this.account.username
    })
    const pulls = Array.isArray(response.data) ? response.data : []
    return pageOf(
      pulls.map((pull) => this.mapPull(pull)),
      nextPageFromLink(response.headers.get('link'))
    )
  }

  async createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<PullRequest> {
    const pull = await this.request<GithubPull>(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: {
        title: input.title,
        head: input.sourceBranch,
        base: input.targetBranch,
        body: input.body ?? '',
        draft: Boolean(input.draft)
      }
    })
    return this.mapPull(pull)
  }

  async listReleases(owner: string, repo: string, page?: string): Promise<PagedResult<Release>> {
    const response = await apiRequestWithHeaders<GithubRelease[]>(joinUrl(this.base, `/repos/${owner}/${repo}/releases`), {
      query: { per_page: 50, page: pageQuery(page) },
      token: this.token,
      provider: this.provider,
      username: this.account.username
    })
    const releases = Array.isArray(response.data) ? response.data : []
    return pageOf(
      releases.map((release) => ({
        id: String(release.id),
        tagName: release.tag_name,
        name: release.name || release.tag_name,
        draft: release.draft,
        prerelease: release.prerelease,
        createdAt: toEpoch(release.created_at),
        publishedAt: release.published_at ? toEpoch(release.published_at) : undefined,
        webUrl: release.html_url,
        author: release.author?.login,
        body: release.body
      })),
      nextPageFromLink(response.headers.get('link'))
    )
  }

  async createRelease(owner: string, repo: string, input: CreateReleaseInput): Promise<Release> {
    const release = await this.request<GithubRelease>(`/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      body: {
        tag_name: input.tagName,
        name: input.name,
        body: input.body ?? '',
        target_commitish: input.target,
        draft: Boolean(input.draft),
        prerelease: Boolean(input.prerelease)
      }
    })
    return {
      id: String(release.id),
      tagName: release.tag_name,
      name: release.name || release.tag_name,
      draft: release.draft,
      prerelease: release.prerelease,
      createdAt: toEpoch(release.created_at),
      publishedAt: release.published_at ? toEpoch(release.published_at) : undefined,
      webUrl: release.html_url,
      body: release.body
    }
  }

  async deleteRelease(owner: string, repo: string, id: string): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/releases/${id}`, { method: 'DELETE' })
  }

  async listWorkflows(owner: string, repo: string, page?: string): Promise<PagedResult<ActionWorkflow>> {
    const data = await this.request<{ total_count?: number; workflows?: GithubWorkflow[] }>(
      `/repos/${owner}/${repo}/actions/workflows`,
      { query: { per_page: 100, page: pageQuery(page) } }
    )
    const workflows = data.workflows ?? []
    const current = pageQuery(page) ?? 1
    const total = data.total_count
    const hasMore = typeof total === 'number' ? current * 100 < total : workflows.length === 100
    return pageOf(
      workflows.map((workflow) => ({
        id: String(workflow.id),
        name: workflow.name,
        path: workflow.path,
        disabled: workflow.state === 'disabled_manually' || workflow.state === 'disabled_inactivity'
      })),
      hasMore ? String(current + 1) : undefined
    )
  }

  async listRuns(owner: string, repo: string, workflowId?: string, page?: string): Promise<PagedResult<ActionRun>> {
    let path = `/repos/${owner}/${repo}/actions/runs`
    if (workflowId) {
      if (/^\d+$/.test(workflowId)) {
        path = `/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs`
      } else {
        path = `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/runs`
      }
    }
    const data = await this.request<{ total_count?: number; workflow_runs?: GithubRun[] }>(path, {
      query: { per_page: 40, page: pageQuery(page) }
    })
    const runs = data.workflow_runs ?? []
    const current = pageQuery(page) ?? 1
    const total = data.total_count
    const hasMore = typeof total === 'number' ? current * 40 < total : runs.length === 40
    return pageOf(
      runs.map((run) => ({
        id: String(run.id),
        workflowId: String(run.workflow_id),
        workflowName: run.name || 'Workflow',
        number: run.run_number,
        status: run.status,
        conclusion: run.conclusion,
        branch: run.head_branch,
        sha: run.head_sha,
        event: run.event,
        createdAt: toEpoch(run.created_at),
        updatedAt: toEpoch(run.updated_at),
        webUrl: run.html_url,
        actor: run.actor?.login
      })),
      hasMore ? String(current + 1) : undefined
    )
  }

  async triggerAction(
    owner: string,
    repo: string,
    workflowId: string | undefined,
    ref: string,
    inputs?: Record<string, string>
  ): Promise<void> {
    if (!workflowId) throw new Error('Select a workflow to run')
    await this.request(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, {
      method: 'POST',
      body: { ref, ...(inputs && Object.keys(inputs).length ? { inputs } : {}) }
    })
  }

  private mapPull(pull: GithubPull): PullRequest {
    return {
      id: String(pull.id),
      number: pull.number,
      title: pull.title,
      state: pull.state === 'open' ? (pull.draft ? 'draft' : 'open') : pull.merged_at ? 'merged' : 'closed',
      draft: Boolean(pull.draft),
      author: pull.user?.login ?? '',
      sourceBranch: pull.head?.ref ?? '',
      sourceRepo: pull.head?.repo?.full_name,
      headSha: pull.head?.sha ?? '',
      targetBranch: pull.base?.ref ?? '',
      webUrl: pull.html_url,
      createdAt: toEpoch(pull.created_at),
      updatedAt: toEpoch(pull.updated_at),
      additions: pull.additions,
      deletions: pull.deletions,
      mergeable: pull.mergeable ?? null
    }
  }
}
