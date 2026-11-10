import type {
  ActionRun,
  ActionWorkflow,
  CreatePullRequestInput,
  CreateReleaseInput,
  IntegrationAccount,
  ProviderConnection,
  ProviderDetection,
  ProviderRepo,
  PullRequest,
  Release
} from '@shared/types'
import { buildAuthArgs, runGit, tryRunGit } from '../git/runner'
import { resolveRepo } from '../git/repo'
import { accountMatchesDestination, destinationFromUrl, parseRemoteUrl, providerFromHost, webUrlFor } from './remote'
import { createProviderClient } from './index'
import type { ProviderClient } from './types'
import { AppStore } from '../store'

export class ProviderService {
  constructor(private readonly store: AppStore) {}

  connections(): ProviderConnection[] {
    return this.store.listIntegrations().map((account) => ({
      accountId: account.id,
      provider: account.provider,
      username: account.username,
      baseUrl: account.baseUrl,
      label: account.label,
      hasToken: account.hasToken
    }))
  }

  async client(accountId: string): Promise<{ client: ProviderClient; account: IntegrationAccount; token: string }> {
    const account = this.store.integrationById(accountId)
    if (!account) throw new Error('Integration account not found')
    const token = await this.store.getToken(account.id)
    if (!token) throw new Error(`No token stored for ${account.label}. Add it in Settings → Integrations.`)
    return { client: createProviderClient(account, token), account, token }
  }

  async test(accountId: string): Promise<{ ok: boolean; user?: string; message: string }> {
    try {
      const { client } = await this.client(accountId)
      const user = await client.getCurrentUser()
      return { ok: true, user: user.login, message: `Connected as ${user.login}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async detect(repoPath: string): Promise<ProviderDetection> {
    const repo = await resolveRepo(repoPath)
    for (const remote of repo.remotes) {
      const parsed = parseRemoteUrl(remote.fetchUrl)
      const destination = destinationFromUrl(remote.fetchUrl)
      if (!parsed || !destination) continue
      // The provider name is a suggestion for the UI; only the destination
      // match may release an account id.
      const provider = remote.provider ?? providerFromHost(parsed.host, this.store.listIntegrations())
      const account = this.store.authorizeAccount(repo.path, provider, destination)
      if (provider || account) {
        return {
          provider,
          accountId: account?.id,
          host: parsed.host,
          owner: parsed.owner,
          repo: parsed.repo,
          webUrlBase: webUrlFor(provider, parsed.host, parsed.owner, parsed.repo)
        }
      }
    }
    return {}
  }

  async listRepos(accountId: string, search?: string): Promise<ProviderRepo[]> {
    const { client } = await this.client(accountId)
    return client.listRepos(search)
  }

  async listPullRequests(accountId: string, owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<PullRequest[]> {
    const { client } = await this.client(accountId)
    return client.listPullRequests(owner, repo, state)
  }

  async createPullRequest(accountId: string, owner: string, repo: string, input: CreatePullRequestInput): Promise<PullRequest> {
    if (!input.title.trim()) throw new Error('Pull request title is required')
    if (!input.sourceBranch || !input.targetBranch) throw new Error('Source and target branches are required')
    const { client } = await this.client(accountId)
    return client.createPullRequest(owner, repo, input)
  }

  async listReleases(accountId: string, owner: string, repo: string): Promise<Release[]> {
    const { client } = await this.client(accountId)
    return client.listReleases(owner, repo)
  }

  async createRelease(accountId: string, owner: string, repo: string, input: CreateReleaseInput): Promise<Release> {
    if (!/^[^\s]+$/.test(input.tagName)) throw new Error('A tag name is required')
    const { client } = await this.client(accountId)
    return client.createRelease(owner, repo, input)
  }

  async deleteRelease(accountId: string, owner: string, repo: string, id: string): Promise<void> {
    const { client } = await this.client(accountId)
    await client.deleteRelease(owner, repo, id)
  }

  async listWorkflows(accountId: string, owner: string, repo: string): Promise<ActionWorkflow[]> {
    const { client } = await this.client(accountId)
    return client.listWorkflows(owner, repo)
  }

  async listRuns(accountId: string, owner: string, repo: string, workflowId?: string): Promise<ActionRun[]> {
    const { client } = await this.client(accountId)
    return client.listRuns(owner, repo, workflowId)
  }

  async triggerAction(
    accountId: string,
    owner: string,
    repo: string,
    workflowId: string | undefined,
    ref: string,
    inputs?: Record<string, string>
  ): Promise<void> {
    if (!ref.trim()) throw new Error('A branch or ref is required')
    const { client } = await this.client(accountId)
    await client.triggerAction(owner, repo, workflowId, ref, inputs)
  }

  async checkoutPullRequest(
    repoPath: string,
    accountId: string,
    owner: string,
    repoName: string,
    number: number,
    branchName?: string,
    identityId?: string
  ): Promise<{ branch: string }> {
    const repo = await resolveRepo(repoPath)
    const { account, token, client } = await this.client(accountId)
    if (!Number.isInteger(number) || number < 1) throw new Error('Invalid pull request number')

    // Pick a remote whose destination the account is actually authorized for.
    // The old fallback to `repo.remotes[0]` could fetch with credentials that
    // belong to a different server.
    const candidates = repo.remotes.map((remote) => {
      const destination = destinationFromUrl(remote.fetchUrl) ?? destinationFromUrl(remote.pushUrl)
      const parsed = parseRemoteUrl(remote.fetchUrl)
      return {
        remote,
        destination,
        matchesRepo: Boolean(
          parsed && parsed.owner.toLowerCase() === owner.toLowerCase() && parsed.repo.toLowerCase() === repoName.toLowerCase()
        ),
        authorized: Boolean(destination && accountMatchesDestination(account, destination))
      }
    })
    const exact = candidates.find((item) => item.matchesRepo)
    let chosen: (typeof candidates)[number]
    if (exact) {
      if (!exact.authorized) {
        throw new Error(
          `The "${account.label}" account is not authorized for ${exact.destination?.host ?? 'that remote'}. Choose a matching account before checking out.`
        )
      }
      chosen = exact
    } else {
      const authorized = candidates.filter((item) => item.authorized)
      if (!authorized.length) {
        throw new Error(`No remote points at ${account.authority?.host ?? account.label}; add one before checking out.`)
      }
      if (authorized.length > 1) {
        throw new Error(
          `Several remotes point at ${account.authority?.host ?? account.label}. Remove one before checking out.`
        )
      }
      chosen = authorized[0]
    }
    const remote = chosen.remote

    const provider = account.provider
    let refspec: string
    let startRef: string
    if (provider === 'github') {
      refspec = `+refs/pull/${number}/head:refs/remotes/${remote.name}/pr/${number}`
      startRef = `refs/remotes/${remote.name}/pr/${number}`
    } else if (provider === 'gitlab') {
      refspec = `+refs/merge-requests/${number}/head:refs/remotes/${remote.name}/mr/${number}`
      startRef = `refs/remotes/${remote.name}/mr/${number}`
    } else {
      const pulls = await client.listPullRequests(owner, repoName, 'all')
      const pull = pulls.find((item) => item.number === number)
      if (!pull?.sourceBranch) throw new Error(`Could not find pull request #${number}`)
      refspec = `+refs/heads/${pull.sourceBranch}:refs/remotes/${remote.name}/${pull.sourceBranch}`
      startRef = `refs/remotes/${remote.name}/${pull.sourceBranch}`
    }
    void identityId

    const auth = chosen.destination?.origin
      ? buildAuthArgs(account, token, chosen.destination.origin)
      : { args: [], env: {} }
    await runGit([...auth.args, 'fetch', remote.name, refspec], {
      cwd: repo.path,
      env: auth.env,
      timeoutMs: 180_000
    })

    const branch = branchName?.trim() || `pr-${number}`
    const exists = await tryRunGit(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repo.path })
    if (exists && exists.exitCode === 0) {
      throw new Error(`Branch "${branch}" already exists. Choose another name or delete it first.`)
    }
    await runGit(['switch', '-c', branch, startRef], { cwd: repo.path })
    return { branch }
  }
}
