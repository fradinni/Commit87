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
import { apiRequest, encodeProjectPath } from './http'
import type { ProviderClient } from './types'
import { requireToken, toEpoch } from './types'

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

export class GitlabClient implements ProviderClient {
  readonly provider = 'gitlab'
  readonly account: IntegrationAccount
  private readonly token: string
  private readonly base: string

  constructor(account: IntegrationAccount, token: string | null) {
    this.account = account
    this.token = requireToken(account, token)
    this.base = apiBase(account)
  }

  private request<T>(path: string, options: { method?: 'GET' | 'POST' | 'DELETE'; query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {}): Promise<T> {
    return apiRequest<T>(`${this.base}${path}`, {
      ...options,
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

  async listPullRequests(owner: string, repo: string, state: 'open' | 'closed' | 'all'): Promise<PullRequest[]> {
    const stateParam = state === 'open' ? 'opened' : state === 'closed' ? 'closed' : 'all'
    const items = await this.request<GitlabMergeRequest[]>(`/projects/${encodeProjectPath(owner, repo)}/merge_requests`, {
      query: { state: stateParam, per_page: 50, order_by: 'updated_at', sort: 'desc' }
    })
    return items.map((item) => this.mapMergeRequest(item, owner, repo))
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
    return this.mapMergeRequest(item, owner, repo)
  }

  async listReleases(owner: string, repo: string): Promise<Release[]> {
    const items = await this.request<GitlabRelease[]>(`/projects/${encodeProjectPath(owner, repo)}/releases`, {
      query: { per_page: 50, order_by: 'released_at', sort: 'desc' }
    })
    return items.map((item) => {
      const host = new URL(this.base).host
      const webUrl = `https://${host}/${owner}/${repo}/-/releases/${encodeURIComponent(item.tag_name)}`
      return {
        id: item.tag_name,
        tagName: item.tag_name,
        name: item.name || item.tag_name,
        draft: false,
        prerelease: Boolean(item.upcoming_release),
        createdAt: toEpoch(item.created_at),
        publishedAt: item.released_at ? toEpoch(item.released_at) : undefined,
        webUrl,
        author: item.author?.username,
        body: item.description
      }
    })
  }

  async createRelease(owner: string, repo: string, input: CreateReleaseInput): Promise<Release> {
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

  async listWorkflows(owner: string, repo: string): Promise<ActionWorkflow[]> {
    void owner
    void repo
    return [{ id: 'pipeline', name: 'CI Pipelines', path: '.gitlab-ci.yml' }]
  }

  async listRuns(owner: string, repo: string, workflowId?: string): Promise<ActionRun[]> {
    void workflowId
    const pipelines = await this.request<GitlabPipeline[]>(`/projects/${encodeProjectPath(owner, repo)}/pipelines`, {
      query: { per_page: 40, order_by: 'updated_at', sort: 'desc' }
    })
    return pipelines.map((pipeline) => ({
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
    }))
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

  private mapMergeRequest(item: GitlabMergeRequest, owner: string, repo: string): PullRequest {
    const isDraft = Boolean(item.draft || item.work_in_progress)
    const state: PullRequest['state'] =
      item.state === 'opened' ? (isDraft ? 'draft' : 'open') : item.state === 'merged' ? 'merged' : 'closed'
    void owner
    void repo
    return {
      id: String(item.id),
      number: item.iid,
      title: item.title,
      state,
      draft: isDraft,
      author: item.author?.username ?? item.author?.name ?? '',
      sourceBranch: item.source_branch,
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
