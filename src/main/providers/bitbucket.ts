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
import { apiRequest, joinUrl } from './http'
import type { ProviderClient } from './types'
import { pageOf, requireToken, toEpoch, unsupportedPage } from './types'

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

interface BitbucketPullSource {
  branch?: { name?: string }
  commit?: { hash?: string }
  repository?: { full_name?: string }
}

interface BitbucketPull {
  id: number
  title: string
  state: string
  draft?: boolean
  author?: { display_name?: string; nickname?: string; username?: string }
  source?: BitbucketPullSource
  destination?: { branch?: { name?: string } }
  created_on: string
  updated_on: string
  links?: { html?: { href?: string } }
}

interface BitbucketPipeline {
  uuid: string
  build_number?: number
  state?: { name?: string; result?: { name?: string } }
  target?: { ref_name?: string; selector?: { pattern?: string }; commit?: { hash?: string } }
  created_on: string
  completed_on?: string
  links?: { html?: { href?: string } }
  trigger?: { name?: string }
}

interface BitbucketPage<T> {
  values: T[]
  next?: string
}

/**
 * Bitbucket's `state` filter is inclusive: asking for one state omits the
 * others, and omitting the parameter does not reliably return every state, so
 * `closed` and `all` name the states explicitly.
 */
const CLOSED_STATES = ['MERGED', 'DECLINED', 'SUPERSEDED'] as const
const ALL_STATES = ['OPEN', ...CLOSED_STATES] as const

export class BitbucketClient implements ProviderClient {
  readonly provider = 'bitbucket'
  readonly account: IntegrationAccount
  readonly capabilities: ProviderCapabilities = providerCapabilities('bitbucket')
  private readonly token: string
  private readonly base: string

  constructor(account: IntegrationAccount, token: string | null) {
    this.account = account
    this.token = requireToken(account, token)
    this.base = account.baseUrl.replace(/\/+$/, '')
  }

  private request<T>(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'DELETE'
      query?: Record<string, string | number | boolean | readonly string[] | undefined>
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

  /**
   * Continuation links may be absolute. Only a same-origin URL of the expected
   * repository collection is allowed, so a `page` token the renderer supplies
   * or a hostile `next` link can never aim the account token at another host
   * or API surface.
   */
  private continuation(path: string, collection: string): string {
    const isCollection = (name: string): boolean => {
      const normalized = name.replace(/^\/2\.0(?=\/)/, '').replace(/\/+$/, '')
      return normalized === collection.replace(/\/+$/, '')
    }
    if (!/^https?:\/\//i.test(path)) {
      if (!isCollection(path)) throw new Error('Invalid pagination link')
      return path
    }
    let target: URL
    let base: URL
    try {
      target = new URL(path)
      base = new URL(this.base)
    } catch {
      throw new Error('Invalid pagination link')
    }
    if (target.origin !== base.origin) {
      throw new Error('Refusing to follow a pagination link to another host')
    }
    if (!isCollection(target.pathname)) throw new Error('Invalid pagination link')
    return path
  }

  async getCurrentUser(): Promise<{ login: string; name?: string }> {
    const user = await this.request<{ username?: string; display_name?: string; nickname?: string }>('/user')
    return { login: user.username || user.nickname || user.display_name || '', name: user.display_name }
  }

  async listRepos(search?: string): Promise<ProviderRepo[]> {
    const repos: BitbucketRepo[] = []
    let path = '/repositories'
    let query: Record<string, string | number | readonly string[]> | undefined = {
      role: 'member',
      pagelen: 100,
      sort: '-updated_on'
    }
    // Follow `next` so a large workspace does not silently stop at page one.
    for (let page = 0; page < 20; page += 1) {
      const data = await this.request<BitbucketPage<BitbucketRepo>>(path, query ? { query } : {})
      repos.push(...(data.values ?? []))
      if (!data.next) break
      path = this.continuation(data.next, '/repositories')
      query = undefined
    }
    const term = search?.trim().toLowerCase()
    return repos
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

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest> {
    const pull = await this.request<BitbucketPull>(`/repositories/${owner}/${repo}/pullrequests/${number}`)
    return this.mapPull(pull)
  }

  async listPullRequests(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all',
    page?: string
  ): Promise<PagedResult<PullRequest>> {
    const query: Record<string, string | number | readonly string[]> = { pagelen: 50, sort: '-updated_on' }
    if (state === 'open') query.state = ['OPEN']
    else if (state === 'closed') query.state = CLOSED_STATES
    else query.state = ALL_STATES
    const path = page
      ? this.continuation(page, `/repositories/${owner}/${repo}/pullrequests`)
      : `/repositories/${owner}/${repo}/pullrequests`
    const data = await this.request<BitbucketPage<BitbucketPull>>(path, { query })
    return pageOf((data.values ?? []).map((pull) => this.mapPull(pull)), data.next)
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
      sourceRepo: pull.source?.repository?.full_name,
      headSha: pull.source?.commit?.hash ?? '',
      targetBranch: input.targetBranch,
      webUrl: pull.links?.html?.href ?? '',
      createdAt: toEpoch(pull.created_on),
      updatedAt: toEpoch(pull.updated_on),
      mergeable: null
    }
  }

  async listReleases(owner: string, repo: string, page?: string): Promise<PagedResult<Release>> {
    void owner
    void repo
    void page
    return unsupportedPage()
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

  async listWorkflows(owner: string, repo: string, page?: string): Promise<PagedResult<ActionWorkflow>> {
    void owner
    void repo
    void page
    return pageOf([{ id: 'pipeline', name: 'Bitbucket Pipelines', path: 'bitbucket-pipelines.yml' }])
  }

  async listRuns(owner: string, repo: string, workflowId?: string, page?: string): Promise<PagedResult<ActionRun>> {
    void workflowId
    const path = page
      ? this.continuation(page, `/repositories/${owner}/${repo}/pipelines/`)
      : `/repositories/${owner}/${repo}/pipelines/`
    const data = await this.request<BitbucketPage<BitbucketPipeline>>(path, {
      query: { pagelen: 40, sort: '-created_on' }
    })
    const items = (data.values ?? []).map((pipeline) => {
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
        sha: pipeline.target?.commit?.hash ?? '',
        event: pipeline.trigger?.name ?? 'push',
        createdAt: toEpoch(pipeline.created_on),
        updatedAt: pipeline.completed_on ? toEpoch(pipeline.completed_on) : undefined,
        webUrl: pipeline.links?.html?.href ?? ''
      }
    })
    return pageOf(items, data.next)
  }

  async triggerAction(
    owner: string,
    repo: string,
    workflowId: string | undefined,
    ref: string,
    inputs?: Record<string, string>
  ): Promise<void> {
    void workflowId
    if (inputs && Object.keys(inputs).length) {
      throw new Error('Bitbucket Pipelines does not accept workflow inputs. Remove them or define pipeline variables in Bitbucket.')
    }
    await this.request(`/repositories/${owner}/${repo}/pipelines/`, {
      method: 'POST',
      body: { target: { type: 'pipeline', ref_type: 'branch', ref_name: ref } }
    })
  }

  private mapPull(pull: BitbucketPull): PullRequest {
    return {
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
      sourceRepo: pull.source?.repository?.full_name,
      headSha: pull.source?.commit?.hash ?? '',
      targetBranch: pull.destination?.branch?.name ?? '',
      webUrl: pull.links?.html?.href ?? '',
      createdAt: toEpoch(pull.created_on),
      updatedAt: toEpoch(pull.updated_on),
      mergeable: null
    }
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
