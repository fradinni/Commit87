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
import { apiRequest, apiRequestWithHeaders, encodeProjectPath, joinUrl, positiveInt } from './http'
import type { ProviderClient } from './types'
import { pageOf, requireToken, toEpoch } from './types'

interface GitlabProject {
  id: number
  path_with_namespace: string
  path: string
  name: string
  namespace?: { full_path?: string; path?: string }
  default_branch: string | null
  visibility?: string
  web_url: string
  http_url_to_repo: string
  ssh_url_to_repo?: string
  description?: string
  last_activity_at?: string
}

interface GitlabMergeRequest {
  id: number
  iid: number
  title: string
  state: string
  draft?: boolean
  work_in_progress?: boolean
  author?: { username?: string; name?: string }
  source_branch: string
  target_branch: string
  sha?: string
  merged_at?: string | null
  web_url: string
  created_at: string
  updated_at: string
  merge_status?: string
  detailed_merge_status?: string
}

interface GitlabRelease {
  tag_name: string
  name: string
  description?: string
  created_at: string
  released_at?: string
  upcoming_release?: boolean
  author?: { username?: string }
}

interface GitlabPipeline {
  id: number
  iid?: number
  status: string
  ref: string
  sha: string
  source?: string
  created_at: string
  updated_at: string
  web_url: string
}

function apiBase(account: IntegrationAccount): string {
  const base = account.baseUrl.replace(/\/+$/, '')
  return base.endsWith('/api/v4') ? base : `${base}/api/v4`
}

function nextPage(headers: Headers): string | undefined {
  const value = positiveInt(headers.get('x-next-page'))
  return value ? String(value) : undefined
}

export class GitlabClient implements ProviderClient {
  readonly provider = 'gitlab'
  readonly account: IntegrationAccount
  readonly capabilities: ProviderCapabilities = providerCapabilities('gitlab')
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
    const user = await this.request<{ username: string; name?: string }>('/user')
    return { login: user.username, name: user.name }
  }

  async listRepos(search?: string): Promise<ProviderRepo[]> {
    const projects = await this.request<GitlabProject[]>('/projects', {
      query: {
        membership: true,
        per_page: 100,
        order_by: 'last_activity_at',
        simple: true,
        ...(search ? { search } : {})
      }
    })
    return projects.map((project) => ({
      id: String(project.id),
      fullName: project.path_with_namespace,
      name: project.path || project.name,
      owner: project.namespace?.full_path ?? project.path_with_namespace.split('/').slice(0, -1).join('/'),
      defaultBranch: project.default_branch ?? 'main',
      private: project.visibility === 'private' || project.visibility === 'internal',
      webUrl: project.web_url,
      cloneUrl: project.http_url_to_repo,
      sshUrl: project.ssh_url_to_repo,
      description: project.description,
      updatedAt: toEpoch(project.last_activity_at)
    }))
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest> {
    const item = await this.request<GitlabMergeRequest>(
      `/projects/${encodeProjectPath(owner, repo)}/merge_requests/${number}`
    )
    return this.mapMergeRequest(item)
  }

  async listPullRequests(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all',
    page?: string
  ): Promise<PagedResult<PullRequest>> {
    const stateParam = state === 'open' ? 'opened' : state === 'closed' ? 'closed' : 'all'
    const response = await this.getWithHeaders<GitlabMergeRequest[]>(
      `/projects/${encodeProjectPath(owner, repo)}/merge_requests`,
      { state: stateParam, per_page: 50, order_by: 'updated_at', sort: 'desc', page: positiveInt(page) }
    )
    const items = Array.isArray(response.data) ? response.data : []
    return pageOf(
      items.map((item) => this.mapMergeRequest(item)),
      nextPage(response.headers)
    )
  }

  async createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<PullRequest> {
    const title = input.draft && !/^draft:/i.test(input.title) ? `Draft: ${input.title}` : input.title
    const item = await this.request<GitlabMergeRequest>(`/projects/${encodeProjectPath(owner, repo)}/merge_requests`, {
      method: 'POST',
      body: {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title,
        description: input.body ?? ''
      }
    })
    return this.mapMergeRequest(item)
  }

  async listReleases(owner: string, repo: string, page?: string): Promise<PagedResult<Release>> {
    const response = await this.getWithHeaders<GitlabRelease[]>(
      `/projects/${encodeProjectPath(owner, repo)}/releases`,
      { per_page: 50, order_by: 'released_at', sort: 'desc', page: positiveInt(page) }
    )
    const items = Array.isArray(response.data) ? response.data : []
    const host = new URL(this.base).host
    return pageOf(
      items.map((item) => ({
        id: item.tag_name,
        tagName: item.tag_name,
        name: item.name || item.tag_name,
        draft: false,
        // GitLab has no prerelease flag; an upcoming release is a scheduled
        // publication, not a prerelease of an existing one.
        prerelease: false,
        createdAt: toEpoch(item.created_at),
        publishedAt: item.released_at ? toEpoch(item.released_at) : undefined,
        webUrl: `https://${host}/${owner}/${repo}/-/releases/${encodeURIComponent(item.tag_name)}`,
        author: item.author?.username,
        body: item.description
      })),
      nextPage(response.headers)
    )
  }

  async createRelease(owner: string, repo: string, input: CreateReleaseInput): Promise<Release> {
    if (input.draft) {
      throw new Error('GitLab releases have no draft state. Publish the release, or use an upcoming release date in GitLab.')
    }
    if (input.prerelease) {
      throw new Error('GitLab releases have no prerelease flag. Use a pre-release tag name instead.')
    }
    const item = await this.request<GitlabRelease>(`/projects/${encodeProjectPath(owner, repo)}/releases`, {
      method: 'POST',
      body: {
        tag_name: input.tagName,
        name: input.name,
        description: input.body ?? '',
        ref: input.target
      }
    })
    const host = new URL(this.base).host
    return {
      id: item.tag_name,
      tagName: item.tag_name,
      name: item.name || item.tag_name,
      draft: false,
      prerelease: false,
      createdAt: toEpoch(item.created_at),
      publishedAt: item.released_at ? toEpoch(item.released_at) : undefined,
      webUrl: `https://${host}/${owner}/${repo}/-/releases/${encodeURIComponent(item.tag_name)}`,
      body: item.description
    }
  }

  async deleteRelease(owner: string, repo: string, id: string): Promise<void> {
    await this.request(`/projects/${encodeProjectPath(owner, repo)}/releases/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    })
  }

  async listWorkflows(owner: string, repo: string, page?: string): Promise<PagedResult<ActionWorkflow>> {
    void owner
    void repo
    void page
    return pageOf([{ id: 'pipeline', name: 'CI Pipelines', path: '.gitlab-ci.yml' }])
  }

  async listRuns(owner: string, repo: string, workflowId?: string, page?: string): Promise<PagedResult<ActionRun>> {
    void workflowId
    const response = await this.getWithHeaders<GitlabPipeline[]>(
      `/projects/${encodeProjectPath(owner, repo)}/pipelines`,
      { per_page: 40, order_by: 'updated_at', sort: 'desc', page: positiveInt(page) }
    )
    const pipelines = Array.isArray(response.data) ? response.data : []
    return pageOf(
      pipelines.map((pipeline) => ({
        id: String(pipeline.id),
        workflowId: 'pipeline',
        workflowName: 'Pipeline',
        number: pipeline.iid ?? pipeline.id,
        status: pipeline.status,
        conclusion: mapConclusion(pipeline.status),
        branch: pipeline.ref,
        sha: pipeline.sha,
        event: pipeline.source ?? 'push',
        createdAt: toEpoch(pipeline.created_at),
        updatedAt: toEpoch(pipeline.updated_at),
        webUrl: pipeline.web_url
      })),
      nextPage(response.headers)
    )
  }

  async triggerAction(
    owner: string,
    repo: string,
    workflowId: string | undefined,
    ref: string,
    inputs?: Record<string, string>
  ): Promise<void> {
    void workflowId
    await this.request(`/projects/${encodeProjectPath(owner, repo)}/pipeline`, {
      method: 'POST',
      body: { ref, ...(inputs && Object.keys(inputs).length ? { variables: inputs } : {}) }
    })
  }

  private mapMergeRequest(item: GitlabMergeRequest): PullRequest {
    const isDraft = Boolean(item.draft || item.work_in_progress)
    const state: PullRequest['state'] =
      item.state === 'opened' ? (isDraft ? 'draft' : 'open') : item.state === 'merged' ? 'merged' : 'closed'
    return {
      id: String(item.id),
      number: item.iid,
      title: item.title,
      state,
      draft: isDraft,
      author: item.author?.username ?? item.author?.name ?? '',
      sourceBranch: item.source_branch,
      headSha: item.sha ?? '',
      targetBranch: item.target_branch,
      webUrl: item.web_url,
      createdAt: toEpoch(item.created_at),
      updatedAt: toEpoch(item.updated_at),
      mergeable: item.detailed_merge_status ? item.detailed_merge_status === 'mergeable' : null
    }
  }
}

function mapConclusion(status: string): string | null {
  switch (status) {
    case 'success':
      return 'success'
    case 'failed':
      return 'failure'
    case 'canceled':
    case 'cancelled':
      return 'cancelled'
    case 'skipped':
      return 'skipped'
    default:
      return null
  }
}
