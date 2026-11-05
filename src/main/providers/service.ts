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
import { runGit, tryRunGit } from '../git/runner'
import { resolveRepo } from '../git/repo'
import { parseRemoteUrl, providerFromHost, webUrlFor } from './remote'
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
      if (!parsed) continue
      const provider = remote.provider ?? providerFromHost(parsed.host, this.store.listIntegrations())
      const account = this.store.resolveAccount(repo.path, provider, parsed.host)
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

    let remote = repo.remotes.find((item) => {
      const parsed = parseRemoteUrl(item.fetchUrl)
      return parsed && parsed.owner.toLowerCase() === owner.toLowerCase() && parsed.repo.toLowerCase() === repoName.toLowerCase()
    })
    if (!remote) remote = repo.remotes[0]
    if (!remote) throw new Error('This repository has no remotes')

    let provider = account.provider
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
      provider = account.provider
    }
    void provider
    void identityId

    const auth = buildRemoteAuth(account, token)
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

function buildRemoteAuth(account: IntegrationAccount, token: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const username = account.username?.trim() || (account.provider === 'github' ? 'x-access-token' : account.provider === 'gitlab' ? 'oauth2' : 'commit87')
  const helper =
    '!f() { if test "$1" = get; then ' +
    'printf "username=%s\\npassword=%s\\n" "$COMMIT87_USERNAME" "$COMMIT87_TOKEN"; ' +
    'fi; }; f'
  return {
    args: ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`],
    env: { COMMIT87_USERNAME: username, COMMIT87_TOKEN: token }
  }
}
