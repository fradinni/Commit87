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
import { apiRequest } from './http'
import type { ProviderClient } from './types'
import { requireToken, toEpoch } from './types'

interface BitbucketRepo {
  uuid: string
  full_name: string
  name: string
  slug: string
  workspace?: { slug?: string }
  owner?: { username?: string; nickname?: string }
  mainbranch?: { name?: string } | null
  is_private: boolean
  description?: string
  updated_on?: string
  links: {
    html?: { href?: string }
    clone?: Array<{ name: string; href: string }>
  }
}

interface BitbucketPull {
  id: number
  title: string
  state: string
  draft?: boolean
  author?: { display_name?: string; nickname?: string; username?: string }
  source?: { branch?: { name?: string } }
  destination?: { branch?: { name?: string } }
  created_on: string
  updated_on: string
  links?: { html?: { href?: string } }
}

interface BitbucketPipeline {
  uuid: string
  build_number?: number
  state?: { name?: string; result?: { name?: string } }
  target?: { ref_name?: string; selector?: { pattern?: string } }
  created_on: string
  completed_on?: string
  links?: { html?: { href?: string } }
  trigger?: { name?: string }
}

interface BitbucketPage<T> {
  values: T[]
  next?: string
}

export class BitbucketClient implements ProviderClient {
  readonly provider = 'bitbucket'
  readonly account: IntegrationAccount
  private readonly token: string
  private readonly base: string

  constructor(account: IntegrationAccount, token: string | null) {
    this.account = account
    this.token = requireToken(account, token)
    this.base = account.baseUrl.replace(/\/+$/, '')
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
    const user = await this.request<{ username?: string; display_name?: string; nickname?: string }>('/user')
    return { login: user.username || user.nickname || user.display_name || '', name: user.display_name }
  }

  async listRepos(search?: string): Promise<ProviderRepo[]> {
    const data = await this.request<BitbucketPage<BitbucketRepo>>('/repositories', {
      query: { role: 'member', pagelen: 100, sort: '-updated_on' }
    })
    const term = search?.trim().toLowerCase()
    return data.values
      .filter((repo) => !term || repo.full_name.toLowerCase().includes(term))
      .map((repo) => {
        const https = repo.links.clone?.find((clone) => clone.name === 'https')
        const ssh = repo.links.clone?.find((clone) => clone.name === 'ssh')
        return {
          id: repo.uuid,
          fullName: repo.full_name,
          name: repo.name || repo.slug,
          owner: repo.workspace?.slug ?? repo.full_name.split('/')[0],
          defaultBranch: repo.mainbranch?.name ?? 'main',
          private: repo.is_private,
          webUrl: repo.links.html?.href ?? '',
          cloneUrl: https?.href ?? '',
          sshUrl: ssh?.href,
          description: repo.description,
          updatedAt: toEpoch(repo.updated_on)
        }
      })
  }

  async listPullRequests(owner: string, repo: string, state: 'open' | 'closed' | 'all'): Promise<PullRequest[]> {
    const query: Record<string, string | number> = { pagelen: 50, sort: '-updated_on' }
    if (state === 'open') query.state = 'OPEN'
    const data = await this.request<BitbucketPage<BitbucketPull>>(`/repositories/${owner}/${repo}/pullrequests`, { query })
    const items = data.values.filter((pull) => state !== 'closed' || pull.state !== 'OPEN')
    return items.map((pull) => ({
      id: String(pull.id),
      number: pull.id,
      title: pull.title,
      state:
        pull.state === 'OPEN'
          ? pull.draft
            ? 'draft'
            : 'open'
          : pull.state === 'MERGED'
            ? 'merged'
            : 'closed',
      draft: Boolean(pull.draft),
      author: pull.author?.display_name ?? pull.author?.nickname ?? pull.author?.username ?? '',
      sourceBranch: pull.source?.branch?.name ?? '',
      targetBranch: pull.destination?.branch?.name ?? '',
      webUrl: pull.links?.html?.href ?? '',
      createdAt: toEpoch(pull.created_on),
      updatedAt: toEpoch(pull.updated_on),
      mergeable: null
    }))
  }

  async createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<PullRequest> {
    const pull = await this.request<BitbucketPull>(`/repositories/${owner}/${repo}/pullrequests`, {
      method: 'POST',
      body: {
        title: input.title,
        description: input.body ?? '',
        draft: Boolean(input.draft),
        source: { branch: { name: input.sourceBranch } },
        destination: { branch: { name: input.targetBranch } }
      }
    })
    return {
      id: String(pull.id),
      number: pull.id,
      title: pull.title,
      state: pull.draft ? 'draft' : 'open',
      draft: Boolean(pull.draft),
      author: pull.author?.display_name ?? '',
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      webUrl: pull.links?.html?.href ?? '',
      createdAt: toEpoch(pull.created_on),
      updatedAt: toEpoch(pull.updated_on),
      mergeable: null
    }
  }

  async listReleases(owner: string, repo: string): Promise<Release[]> {
    void owner
    void repo
    return []
  }

  async createRelease(owner: string, repo: string, input: CreateReleaseInput): Promise<Release> {
    void owner
    void repo
    void input
    throw new Error('Bitbucket Cloud has no releases API. Create a tag and attach a download in the Bitbucket web UI.')
  }

  async deleteRelease(owner: string, repo: string, id: string): Promise<void> {
    void owner
    void repo
    void id
    throw new Error('Bitbucket Cloud does not support releases')
  }

  async listWorkflows(owner: string, repo: string): Promise<ActionWorkflow[]> {
    void owner
    void repo
    return [{ id: 'pipeline', name: 'Bitbucket Pipelines', path: 'bitbucket-pipelines.yml' }]
  }

  async listRuns(owner: string, repo: string, workflowId?: string): Promise<ActionRun[]> {
    void workflowId
    const data = await this.request<BitbucketPage<BitbucketPipeline>>(`/repositories/${owner}/${repo}/pipelines/`, {
      query: { pagelen: 40, sort: '-created_on' }
    })
    return data.values.map((pipeline) => {
      const state = pipeline.state?.name ?? 'PENDING'
      const result = pipeline.state?.result?.name
      return {
        id: pipeline.uuid,
        workflowId: 'pipeline',
        workflowName: 'Pipeline',
        number: pipeline.build_number,
        status: mapStatus(state),
        conclusion: result ? mapResult(result) : null,
        branch: pipeline.target?.ref_name ?? '',
        sha: '',
        event: pipeline.trigger?.name ?? 'push',
        createdAt: toEpoch(pipeline.created_on),
        updatedAt: pipeline.completed_on ? toEpoch(pipeline.completed_on) : undefined,
        webUrl: pipeline.links?.html?.href ?? ''
      }
    })
  }

  async triggerAction(
    owner: string,
    repo: string,
    workflowId: string | undefined,
    ref: string,
    inputs?: Record<string, string>
  ): Promise<void> {
    void workflowId
    void inputs
    await this.request(`/repositories/${owner}/${repo}/pipelines/`, {
      method: 'POST',
      body: { target: { type: 'pipeline', ref_type: 'branch', ref_name: ref } }
    })
  }
}

function mapStatus(state: string): string {
  switch (state) {
    case 'SUCCESSFUL':
    case 'FAILED':
    case 'STOPPED':
      return 'completed'
    case 'RUNNING':
    case 'IN_PROGRESS':
      return 'in_progress'
    case 'PENDING':
    case 'QUEUED':
      return 'queued'
    default:
      return state.toLowerCase()
  }
}

function mapResult(result: string): string {
  switch (result) {
    case 'SUCCESSFUL':
      return 'success'
    case 'FAILED':
      return 'failure'
    case 'STOPPED':
      return 'cancelled'
    case 'ERROR':
      return 'failure'
    default:
      return result.toLowerCase()
  }
}
