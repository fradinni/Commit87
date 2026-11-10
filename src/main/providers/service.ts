import type {
  ActionRun,
  ActionWorkflow,
  CreatePullRequestInput,
  CreateReleaseInput,
  IntegrationAccount,
  PagedResult,
  ProviderConnection,
  ProviderDetection,
  ProviderRepo,
  PullRequest,
  Release
} from '@shared/types'
import { PROVIDERS, providerCapabilities } from '@shared/types'
import { buildAuthArgs, runGit, tryRunGit } from '../git/runner'
import { resolveRepo } from '../git/repo'
import {
  accountMatchesDestination,
  cloneBaseForAccount,
  destinationFromUrl,
  parseRemoteUrl,
  providerFromHost,
  webUrlFor
} from './remote'
import { createProviderClient } from './index'
import type { ProviderClient } from './types'
import { planPullFetch, verifyFetchedHead } from './checkout'
import type { PullFetchPlan } from './checkout'
import { assertReleaseIntent } from './release'
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
      hasToken: account.hasToken,
      capabilities: providerCapabilities(account.provider)
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
        const effective = provider ?? account?.provider
        return {
          provider: effective,
          accountId: account?.id,
          host: parsed.host,
          owner: parsed.owner,
          repo: parsed.repo,
          webUrlBase: webUrlFor(effective, parsed.host, parsed.owner, parsed.repo),
          capabilities: effective ? providerCapabilities(effective) : undefined
        }
      }
    }
    return {}
  }

  async listRepos(accountId: string, search?: string): Promise<ProviderRepo[]> {
    const { client } = await this.client(accountId)
    return client.listRepos(search)
  }

  async listPullRequests(
    accountId: string,
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open',
    page?: string
  ): Promise<PagedResult<PullRequest>> {
    const { client } = await this.client(accountId)
    return client.listPullRequests(owner, repo, state, page)
  }

  async createPullRequest(accountId: string, owner: string, repo: string, input: CreatePullRequestInput): Promise<PullRequest> {
    if (!input.title.trim()) throw new Error('Pull request title is required')
    if (!input.sourceBranch || !input.targetBranch) throw new Error('Source and target branches are required')
    const { client } = await this.client(accountId)
    return client.createPullRequest(owner, repo, input)
  }

  async listReleases(accountId: string, owner: string, repo: string, page?: string): Promise<PagedResult<Release>> {
    const { client } = await this.client(accountId)
    return client.listReleases(owner, repo, page)
  }

  async createRelease(accountId: string, owner: string, repo: string, input: CreateReleaseInput): Promise<Release> {
    if (!/^[^\s]+$/.test(input.tagName)) throw new Error('A tag name is required')
    const { client, account } = await this.client(accountId)
    assertReleaseIntent(account.provider, client.capabilities.releases, input)
    return client.createRelease(owner, repo, input)
  }

  async deleteRelease(accountId: string, owner: string, repo: string, id: string): Promise<void> {
    const { client, account } = await this.client(accountId)
    if (!client.capabilities.releases.delete) {
      throw new Error(`${PROVIDERS[account.provider].name} does not support deleting releases`)
    }
    await client.deleteRelease(owner, repo, id)
  }

  async listWorkflows(accountId: string, owner: string, repo: string, page?: string): Promise<PagedResult<ActionWorkflow>> {
    const { client } = await this.client(accountId)
    return client.listWorkflows(owner, repo, page)
  }

  async listRuns(
    accountId: string,
    owner: string,
    repo: string,
    workflowId?: string,
    page?: string
  ): Promise<PagedResult<ActionRun>> {
    const { client } = await this.client(accountId)
    return client.listRuns(owner, repo, workflowId, page)
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
    const { client, account } = await this.client(accountId)
    const capabilities = client.capabilities.actions
    const name = PROVIDERS[account.provider].name
    if (!capabilities.dispatch) throw new Error(`${name} does not support dispatching workflows from Commit87.`)
    if (inputs && Object.keys(inputs).length && !capabilities.inputs) {
      throw new Error(`${name} workflows do not accept inputs. Remove them before dispatching.`)
    }
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
        parsed,
        matchesRepo: Boolean(
          parsed && parsed.owner.toLowerCase() === owner.toLowerCase() && parsed.repo.toLowerCase() === repoName.toLowerCase()
        ),
        authorized: Boolean(destination && accountMatchesDestination(account, destination))
      }
    })
    // Prefer a remote that both names this repository and is authorized for the
    // account: remote enumeration is alphabetical, so the first owner/repo
    // match is not necessarily the one this account can talk to.
    const matchingRepo = candidates.filter((item) => item.matchesRepo)
    const exact = matchingRepo.find((item) => item.authorized)
    let chosen: (typeof candidates)[number]
    if (exact) {
      chosen = exact
    } else if (matchingRepo.length) {
      throw new Error(
        `The "${account.label}" account is not authorized for ${matchingRepo[0].destination?.host ?? 'that remote'}. Choose a matching account before checking out.`
      )
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

    const branch = branchName?.trim() || `pr-${number}`
    const exists = await tryRunGit(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repo.path })
    if (exists && exists.exitCode === 0) {
      throw new Error(`Branch "${branch}" already exists. Choose another name or delete it first.`)
    }

    // Ask the forge for this pull request directly; never search a list page.
    const pull = await client.getPullRequest(owner, repoName, number)
    const host = chosen.parsed?.host ?? chosen.destination?.host
    if (!host) throw new Error(`Could not determine the host of remote "${remote.name}".`)
    // Build contributor URLs from the account's configured server, which keeps
    // an explicit port and a self-hosted sub-path that an ssh remote omits.
    const plan = planPullFetch(
      account.provider,
      number,
      pull,
      remote.name,
      cloneBaseForAccount(account) ?? chosen.destination?.origin ?? host
    )

    const attempts: Array<{ url: string; refspec: string; origin?: string }> = []
    const describeAttempt = (source: PullFetchPlan['source'], refspec: string) => {
      if (source.kind === 'remote') {
        // An ssh remote authenticates with keys; only an http(s) destination
        // receives the scoped token helper.
        return { url: remote.name, refspec, origin: chosen.destination?.origin }
      }
      const destination = destinationFromUrl(source.url)
      if (!destination || !accountMatchesDestination(account, destination)) {
        throw new Error(
          `The "${account.label}" account is not authorized for the pull request's source repository ${pull.sourceRepo ?? ''}.`
        )
      }
      return { url: source.url, refspec, origin: destination.origin }
    }
    attempts.push(describeAttempt(plan.source, plan.refspec))
    if (plan.fallback) attempts.push(describeAttempt(plan.fallback.source, plan.fallback.refspec))

    let lastError: unknown = null
    let verified = false
    for (const attempt of attempts) {
      const auth = attempt.origin ? buildAuthArgs(account, token, attempt.origin) : { args: [], env: {} }
      try {
        await runGit([...auth.args, 'fetch', attempt.url, attempt.refspec], {
          cwd: repo.path,
          env: auth.env,
          timeoutMs: 180_000
        })
      } catch (error) {
        lastError = error
        // A missing pull request ref is the documented Gitea fallback case;
        // any other failure (auth, network) is still worth trying the
        // contributor repository, whose authorization was checked above.
        continue
      }
      // Verify per attempt: a published but stale pull ref must not block the
      // contributor fetch that carries the authoritative head.
      const resolved = await runGit(['rev-parse', '--verify', plan.verifyRef], {
        cwd: repo.path,
        allowFailure: true
      })
      try {
        await verifyFetchedHead(plan, {
          resolve: async () => (resolved.exitCode === 0 ? resolved.stdout : null),
          deleteRef: async (ref) => {
            await runGit(['update-ref', '-d', ref], { cwd: repo.path, allowFailure: true })
          }
        })
        verified = true
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!verified) {
      const message = lastError instanceof Error ? lastError.message : String(lastError)
      throw new Error(`Could not fetch the head of pull request #${number}: ${message}`)
    }

    try {
      await runGit(['switch', '-c', branch, plan.verifyRef], { cwd: repo.path })
    } finally {
      if (plan.cleanupOnSuccess) {
        await runGit(['update-ref', '-d', plan.tempRef], { cwd: repo.path, allowFailure: true })
      }
    }
    void identityId
    return { branch }
  }
}
