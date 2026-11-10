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
import { apiRequest, apiRequestWithHeaders, joinUrl, positiveInt } from './http'
import { ProviderError } from './types'
import type { ProviderClient } from './types'
import { pageOf, requireToken, toEpoch, unsupportedPage } from './types'

interface GiteaRepo {
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

interface GiteaPullHead {
  ref?: string
  sha?: string
  repo?: { full_name?: string } | null
}

interface GiteaPull {
  id: number
  number: number
  title: string
  state: string
  draft?: boolean
  merged?: boolean
  merged_at?: string | null
  user?: { login: string }
  head?: GiteaPullHead
  base?: { ref?: string }
  html_url: string
  created_at: string
  updated_at: string
  mergeable?: boolean | null
}

interface GiteaRelease {
  id: number
  tag_name: string
  name: string
  draft: boolean
  prerelease: boolean
  created_at: string
  published_at?: string
  html_url: string
  author?: { login?: string }
  body?: string
}

interface GiteaTask {
  id: number
  name?: string
  head_branch?: string
  head_sha?: string
  run_number?: number
  event?: string
  status?: string
  conclusion?: string
  created_at?: string
  updated_at?: string
  run_started_at?: string
  html_url?: string
  web_url?: string
  display_title?: string
  workflow_id?: string
}

/** Gitea 1.24 answers with this envelope; older/Forgejo servers may send a bare array. */
interface GiteaTaskEnvelope {
  workflow_runs?: GiteaTask[]
  total_count?: number
}

interface GiteaContent {
  name: string
  path: string
  type: string
}

function apiBase(account: IntegrationAccount): string {
  const base = account.baseUrl.replace(/\/+$/, '')
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`
}

function totalCount(headers: Headers): number | undefined {
  const parsed = Number(headers.get('x-total-count'))
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function nextPage(headers: Headers, page: string | undefined, limit: number, received: number): string | undefined {
  const current = positiveInt(page) ?? 1
  const total = totalCount(headers)
  const hasMore = total !== undefined ? current * limit < total : received === limit
  return hasMore ? String(current + 1) : undefined
}

export class GiteaClient implements ProviderClient {
  readonly provider = 'gitea'
  readonly account: IntegrationAccount
  readonly capabilities: ProviderCapabilities = providerCapabilities('gitea')
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
      method?: 'GET' | 'POST' | 'DELETE'
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

  private getWithHeaders<T>(path: string, query?: Record<string, string | number | boolean | undefined>) {
    return apiRequestWithHeaders<T>(joinUrl(this.base, path), {
      query,
      token: this.token,
      provider: this.provider,
      username: this.account.username
    })
  }

  async getCurrentUser(): Promise<{ login: string; name?: string }> {
    const user = await this.request<{ login: string; full_name?: string }>('/user')
    return { login: user.login, name: user.full_name }
  }

  async listRepos(search?: string): Promise<ProviderRepo[]> {
    const repos = await this.request<GiteaRepo[]>('/user/repos', {
      query: { limit: 50, page: 1, ...(search ? { q: search } : {}) }
    })
    return repos.map((repo) => ({
      id: String(repo.id),
      fullName: repo.full_name,
      name: repo.name,
      owner: repo.owner.login,
      defaultBranch: repo.default_branch || 'main',
      private: repo.private,
      webUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      sshUrl: repo.ssh_url,
      description: repo.description,
      updatedAt: toEpoch(repo.updated_at)
    }))
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest> {
    const pull = await this.request<GiteaPull>(`/repos/${owner}/${repo}/pulls/${number}`)
    return this.mapPull(pull)
  }

  async listPullRequests(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all',
    page?: string
  ): Promise<PagedResult<PullRequest>> {
    const limit = 50
    const response = await this.getWithHeaders<GiteaPull[]>(`/repos/${owner}/${repo}/pulls`, {
      state,
      limit,
      page: positiveInt(page) ?? 1
    })
    const pulls = Array.isArray(response.data) ? response.data : []
    return pageOf(
      pulls.map((pull) => this.mapPull(pull)),
      nextPage(response.headers, page, limit, pulls.length)
    )
  }

  async createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<PullRequest> {
    const pull = await this.request<GiteaPull>(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: {
        title: input.title,
        head: input.sourceBranch,
        base: input.targetBranch,
        body: input.body ?? '',
        ...(input.draft ? { draft: true } : {})
      }
    })
    return {
      id: String(pull.id),
      number: pull.number,
      title: pull.title,
      state: pull.draft ? 'draft' : 'open',
      draft: Boolean(pull.draft),
      author: pull.user?.login ?? '',
      sourceBranch: input.sourceBranch,
      sourceRepo: pull.head?.repo?.full_name,
      headSha: pull.head?.sha ?? '',
      targetBranch: input.targetBranch,
      webUrl: pull.html_url,
      createdAt: toEpoch(pull.created_at),
      updatedAt: toEpoch(pull.updated_at),
      mergeable: pull.mergeable ?? null
    }
  }

  async listReleases(owner: string, repo: string, page?: string): Promise<PagedResult<Release>> {
    const limit = 50
    const response = await this.getWithHeaders<GiteaRelease[]>(`/repos/${owner}/${repo}/releases`, {
      limit,
      page: positiveInt(page) ?? 1
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
      nextPage(response.headers, page, limit, releases.length)
    )
  }

  async createRelease(owner: string, repo: string, input: CreateReleaseInput): Promise<Release> {
    const release = await this.request<GiteaRelease>(`/repos/${owner}/${repo}/releases`, {
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
    void page
    for (const dir of ['.gitea/workflows', '.github/workflows']) {
      try {
        const contents = await this.request<GiteaContent[]>(`/repos/${owner}/${repo}/contents/${dir}`)
        if (Array.isArray(contents)) {
          return pageOf(
            contents
              .filter((entry) => entry.type === 'file' && /\.ya?ml$/i.test(entry.name))
              .map((entry) => ({
                id: entry.name,
                name: entry.name.replace(/\.ya?ml$/i, ''),
                path: entry.path
              }))
          )
        }
      } catch (error) {
        if (error instanceof ProviderError && error.status !== 404) throw error
      }
    }
    return pageOf([])
  }

  async listRuns(owner: string, repo: string, workflowId?: string, page?: string): Promise<PagedResult<ActionRun>> {
    const limit = 40
    let response: { data: GiteaTask[] | GiteaTaskEnvelope; headers: Headers }
    try {
      response = await this.getWithHeaders<GiteaTask[] | GiteaTaskEnvelope>(`/repos/${owner}/${repo}/actions/tasks`, {
        limit,
        page: positiveInt(page) ?? 1
      })
    } catch (error) {
      // A repository without Actions is not an empty run list: the caller can
      // show "Actions unavailable" instead of "no runs".
      if (error instanceof ProviderError && error.status === 404) return unsupportedPage()
      throw error
    }
    const tasks = decodeTasks(response.data)
    if (!tasks) return unsupportedPage()
    const filtered = workflowId ? tasks.filter((task) => !task.workflow_id || task.workflow_id === workflowId) : tasks
    return pageOf(
      filtered.map((task) => ({
        id: String(task.id),
        workflowId: task.workflow_id,
        workflowName: task.name || task.display_title || 'Task',
        number: task.run_number,
        status: task.status ?? 'unknown',
        conclusion: task.conclusion ?? null,
        branch: task.head_branch ?? '',
        sha: task.head_sha ?? '',
        event: task.event ?? '',
        createdAt: toEpoch(task.created_at ?? task.run_started_at),
        updatedAt: toEpoch(task.updated_at),
        webUrl: task.html_url ?? task.web_url ?? '',
        actor: undefined
      })),
      nextPage(response.headers, page, limit, tasks.length)
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

  private mapPull(pull: GiteaPull): PullRequest {
    return {
      id: String(pull.id),
      number: pull.number,
      title: pull.title,
      state: pullState(pull),
      draft: Boolean(pull.draft),
      author: pull.user?.login ?? '',
      sourceBranch: pull.head?.ref ?? '',
      sourceRepo: pull.head?.repo?.full_name,
      headSha: pull.head?.sha ?? '',
      targetBranch: pull.base?.ref ?? '',
      webUrl: pull.html_url,
      createdAt: toEpoch(pull.created_at),
      updatedAt: toEpoch(pull.updated_at),
      mergeable: pull.mergeable ?? null
    }
  }
}

function pullState(pull: GiteaPull): PullRequest['state'] {
  if (pull.state === 'open') return pull.draft ? 'draft' : 'open'
  return pull.merged || pull.merged_at ? 'merged' : 'closed'
}

function decodeTasks(data: GiteaTask[] | GiteaTaskEnvelope | null | undefined): GiteaTask[] | null {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object' && Array.isArray(data.workflow_runs)) return data.workflow_runs
  return null
}
