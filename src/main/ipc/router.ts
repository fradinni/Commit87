import { app, dialog, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { APP_VERSION } from '../version'
import type { BrowserWindow, OpenDialogOptions } from 'electron'
import type {
  AppConfig,
  CloneInput,
  ConsoleInput,
  FetchInput,
  InitInput,
  IntegrationAccount,
  ProviderId,
  PullInput,
  PushInput,
  RepoDefaults,
  RepoInfo
} from '@shared/types'
import { PROVIDERS } from '@shared/types'
import type { IpcChannel, IpcRequest, IpcResponse } from '@shared/ipc'
import { AppStore } from '../store'
import { rememberRecentRepo } from '../recent'
import { TaskManager, validateConsoleCommand } from '../tasks'
import { buildAuthArgs, buildIdentityEnv, detectGit, runGit, validateGitExecutable } from '../git/runner'
import type { IdentityEnvInput } from '../git/runner'
import { resolveRepoIdentity } from '../git/identity'
import * as repoOps from '../git/repo'
import * as rebaseOps from '../git/rebase'
import { parseRebaseTodoItems } from '../git/rebase-plan'
import {
  accountMatchesDestination,
  detectProviderFromUrl,
  destinationFromUrl,
  normalizeBaseUrl,
  providerFromHost,
  type GitDestination
} from '../providers/remote'
import { ProviderService } from '../providers/service'
import type { UpdateService } from '../updates'
import { GrantStore } from './grants'
import {
  bool,
  configKey,
  enumOf,
  num,
  optBool,
  optFolderName,
  optHexDigest,
  optNum,
  optRelPath,
  optRemoteName,
  optStr,
  record,
  recordOf,
  refName,
  relPath,
  remoteName,
  remoteUrl,
  repoPath,
  revision,
  revisionRange,
  slugPart,
  str,
  strArray,
  submoduleUrl,
  text,
  optWord
} from './validate'

type GetWindow = () => BrowserWindow | null
type GetLaunchTarget = () => string | null

const PROVIDER_IDS = ['github', 'gitlab', 'bitbucket', 'gitea'] as const

/** One handler per channel; the return type is pinned to its declared response. */
type HandlerTable = {
  [K in IpcChannel]: (payload: IpcRequest<K>) => Promise<IpcResponse<K>>
}

/** One strict decoder per channel; input is always untrusted. */
type DecoderTable = {
  [K in IpcChannel]: (value: unknown) => IpcRequest<K>
}

export class Router {
  private readonly store: AppStore
  private readonly tasks: TaskManager
  private readonly providers: ProviderService
  private readonly updates: UpdateService
  private readonly grants: GrantStore
  private readonly getWindow: GetWindow
  private readonly getLaunchTarget: GetLaunchTarget
  private readonly handlers: HandlerTable

  constructor(
    store: AppStore,
    tasks: TaskManager,
    providers: ProviderService,
    updates: UpdateService,
    grants: GrantStore,
    getWindow: GetWindow,
    getLaunchTarget: GetLaunchTarget
  ) {
    this.store = store
    this.tasks = tasks
    this.providers = providers
    this.updates = updates
    this.grants = grants
    this.getWindow = getWindow
    this.getLaunchTarget = getLaunchTarget
    this.handlers = this.createHandlers()
  }

  handle<K extends IpcChannel>(channel: K, payload: unknown): Promise<IpcResponse<K>>
  async handle(channel: IpcChannel, payload: unknown): Promise<unknown> {
    return this.dispatch(channel, payload)
  }

  private dispatch<K extends IpcChannel>(channel: K, payload: unknown): Promise<IpcResponse<K>> {
    if (!Object.prototype.hasOwnProperty.call(DECODERS, channel)) {
      return Promise.reject(new Error(`Unsupported channel: ${String(channel)}`))
    }
    const decode = DECODERS[channel]
    return this.handlers[channel](decode(payload))
  }

  // -------------------------------------------------------------------------
  // Handler table

  private createHandlers(): HandlerTable {
    return {
      'app.info': async () => {
        const git = await detectGit()
        return {
          name: 'Commit87',
          version: APP_VERSION,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
          isPackaged: app.isPackaged,
          git,
          configPath: this.store.getConfigPath(),
          secretsEncrypted: this.store.secretsEncrypted
        }
      },
      'app.launchTarget': async () => this.getLaunchTarget(),
      'app.checkGit': async (payload) => {
        if (!payload.path) return detectGit()
        const granted = await this.grants.grantedExecutablePath(payload.path)
        if (!granted) {
          throw new Error('That Git executable was not chosen in this app. Use "Choose…" to select it first.')
        }
        const check = await validateGitExecutable(granted)
        if (!check.ok) return { path: granted, version: '', available: false, error: check.error }
        const info = await detectGit(granted)
        if (info.available) await this.store.setGitBinary(granted)
        return info
      },
      'app.pickGitBinary': async () => {
        const window = this.getWindow()
        const options: OpenDialogOptions = {
          title: 'Choose the Git executable',
          properties: ['openFile']
        }
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
        const chosen = result.canceled ? null : result.filePaths[0] ?? null
        if (!chosen) return null
        const check = await validateGitExecutable(chosen)
        if (!check.ok || !check.path) {
          return { path: chosen, version: '', available: false, error: check.error ?? 'The selected file is not a Git executable' }
        }
        const canonical = await this.grants.grantExecutable(check.path)
        const info = await detectGit(canonical)
        if (!info.available) return info
        await this.store.setGitBinary(canonical)
        return info
      },
      'app.useSystemGit': async () => {
        await this.store.setGitBinary('')
        return detectGit()
      },
      'app.openExternal': async (payload) => {
        let parsed: URL
        try {
          parsed = new URL(payload.url)
        } catch {
          throw new Error('Invalid URL')
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('Only http and https links can be opened')
        }
        await shell.openExternal(parsed.toString())
        return undefined
      },
      'app.openPath': async (payload) => {
        await this.authorizeOpenPath(payload.path)
        const error = await shell.openPath(payload.path)
        return { ok: !error, error: error || undefined }
      },
      'app.showItemInFolder': async (payload) => {
        await this.authorizeOpenPath(payload.path)
        shell.showItemInFolder(payload.path)
        return undefined
      },
      'app.pickDirectory': async (payload) => {
        const window = this.getWindow()
        const options: OpenDialogOptions = {
          title: payload.title || 'Choose a folder',
          defaultPath: payload.defaultPath,
          properties: ['openDirectory', 'createDirectory']
        }
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
        const chosen = result.canceled ? null : result.filePaths[0] ?? null
        if (chosen) await this.grants.grantPath(chosen)
        return chosen
      },
      'app.pickFile': async (payload) => {
        const window = this.getWindow()
        const options: OpenDialogOptions = {
          title: payload.title || 'Choose a file',
          defaultPath: payload.defaultPath,
          properties: ['openFile'],
          filters: payload.filters
        }
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
        const chosen = result.canceled ? null : result.filePaths[0] ?? null
        if (chosen) await this.grants.grantPath(chosen)
        return chosen
      },
      'app.openConfigFolder': async () => {
        await shell.openPath(path.dirname(this.store.getConfigPath()))
        return undefined
      },

      'config.get': async () => this.store.getConfig(),
      'config.update': async (payload) => {
        const updated = await this.store.updateConfig(payload.patch)
        if (payload.patch.updateChannel !== undefined || payload.patch.autoUpdateCheck !== undefined) {
          this.updates.refreshPreferences()
        }
        return updated
      },

      'identity.list': async () => this.store.listIdentities(),
      'identity.save': async (payload) => this.store.saveIdentity(payload),
      'identity.delete': async (payload) => {
        await this.store.deleteIdentity(payload.id)
        return undefined
      },
      'identity.setDefault': async (payload) => this.store.setDefaultIdentity(payload.id),

      'integration.list': async () => this.store.listIntegrations(),
      'integration.save': async (payload) => {
        new URL(normalizeBaseUrl(payload.provider, payload.baseUrl))
        return this.store.saveIntegration(payload)
      },
      'integration.delete': async (payload) => {
        await this.store.deleteIntegration(payload.id)
        return undefined
      },
      'integration.test': async (payload) => this.providers.test(payload.id),

      // ---------------------------------------------------------------------
      // Repositories
      'repo.recent': async () => this.store.getConfig().recentRepos,
      'repo.open': async (payload) => this.openRepository(payload.path, payload.standalone === true),
      'repo.info': async (payload) => this.authorizedRepo(payload.path),
      'repo.removeRecent': async (payload) => {
        await this.grants.revokePath(payload.path)
        return this.store.removeRecentRepo(payload.path)
      },
      'repo.pinRecent': async (payload) => this.store.pinRecentRepo(payload.path, payload.pinned),
      'repo.getDefaults': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        return this.store.getRepoDefaults(repo.path)
      },
      'repo.setDefaults': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        for (const [key, accountId] of Object.entries(payload.defaults.integrationByProvider)) {
          if (!accountId) continue
          const provider = key as ProviderId
          const account = this.store.integrationById(accountId)
          if (!account) throw new Error('Integration account not found')
          if (account.provider !== provider) {
            throw new Error(`"${account.label}" is not a ${PROVIDERS[provider].name} account`)
          }
        }
        return this.store.setRepoDefaults(repo.path, payload.defaults)
      },
      'repo.clone': async (payload) => this.cloneRepository(payload),
      'repo.init': async (payload) => this.initRepository(payload),

      // ---------------------------------------------------------------------
      // Git reads
      'git.status': async (payload) => repoOps.getStatus((await this.authorizedRepo(payload.path)).path),
      'git.log': async (payload) => {
        const repo = await this.authorizedRepo(payload.repoPath)
        return repoOps.getLog({ ...payload, repoPath: repo.path })
      },
      'git.commitDetail': async (payload) =>
        repoOps.getCommit((await this.authorizedRepo(payload.path)).path, payload.sha),
      'git.branches': async (payload) => repoOps.getBranches((await this.authorizedRepo(payload.path)).path),
      'git.tags': async (payload) => repoOps.getTags((await this.authorizedRepo(payload.path)).path),
      'git.remotes': async (payload) => (await this.authorizedRepo(payload.path)).remotes,
      'git.worktrees': async (payload) => repoOps.getWorktrees((await this.authorizedRepo(payload.path)).path),
      'git.worktreeStatuses': async (payload) =>
        repoOps.getWorktreeStatuses((await this.authorizedRepo(payload.path)).path),
      'git.stashes': async (payload) => repoOps.getStashes((await this.authorizedRepo(payload.path)).path),
      'git.submodules': async (payload) => repoOps.getSubmodules((await this.authorizedRepo(payload.path)).path),
      'git.diff': async (payload) => {
        const repo = await this.authorizedRepo(payload.repoPath)
        return repoOps.getDiff({ ...payload, repoPath: repo.path })
      },
      'git.resolveConflict': async (payload) => {
        const repo = await this.authorizedRepo(payload.repoPath)
        if (payload.content.length > 10 * 1024 * 1024) throw new Error('Resolved content is too large')
        await repoOps.resolveConflict(repo.path, payload.file, payload.content, payload.expectedSha256)
        return undefined
      },
      'git.fileTree': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        return repoOps.listTree(repo.path, payload.dir ?? '')
      },
      'git.fileContent': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        return repoOps.readFileContent(repo.path, payload.file, payload.from ?? 'worktree', payload.commit)
      },
      'git.blame': async (payload) =>
        repoOps.getBlame((await this.authorizedRepo(payload.path)).path, payload.file, payload.commit),
      'git.config': async (payload) => repoOps.getRepoConfig((await this.authorizedRepo(payload.path)).path),
      'git.setConfig': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.setRepoConfig(repo.path, payload.key, payload.value)
        return undefined
      },

      // ---------------------------------------------------------------------
      // Git writes
      'git.stage': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.stageFiles(repo.path, payload.files)
        return undefined
      },
      'git.unstage': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.unstageFiles(repo.path, payload.files)
        return undefined
      },
      'git.discard': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        return repoOps.discardFiles(repo.path, payload.files, payload.includeUntracked)
      },
      'git.commit': async (payload) => {
        const repo = await this.authorizedRepo(payload.repoPath)
        return repoOps.commitChanges(
          { ...payload, repoPath: repo.path },
          { identity: await this.identityFor(repo.path, payload.identityId) }
        )
      },
      'git.checkout': async (payload) => {
        const repo = await this.authorizedRepo(payload.repoPath)
        await repoOps.checkoutBranch({ ...payload, repoPath: repo.path })
        return undefined
      },
      'git.createBranch': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.createBranch(
          repo.path,
          payload.name,
          payload.startPoint,
          payload.checkout ?? false,
          payload.track ?? false
        )
        return undefined
      },
      'git.renameBranch': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.renameBranch(repo.path, payload.from, payload.to)
        return undefined
      },
      'git.deleteBranch': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        if (payload.remote) {
          const ctx = await this.remoteAuth(repo.path, {
            direction: 'push',
            remoteName: payload.remote,
            identityId: payload.identityId,
            accountId: payload.accountId
          })
          await repoOps.deleteRemoteBranch(repo.path, payload.name, payload.remote, {
            identity: ctx.identity,
            account: ctx.account,
            token: ctx.token,
            authOrigin: ctx.destination?.origin
          })
        } else {
          await repoOps.deleteBranch(repo.path, payload.name, payload.force ?? false)
        }
        return undefined
      },
      'git.setUpstream': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.setUpstream(repo.path, payload.branch, payload.upstream)
        return undefined
      },
      'git.merge': async (payload) => {
        const repo = await this.authorizedRepo(payload.repoPath)
        return repoOps.mergeBranch(
          { ...payload, repoPath: repo.path },
          { identity: await this.identityFor(repo.path, payload.identityId) }
        )
      },
      'git.rebase': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        return repoOps.rebaseBranch(repo.path, payload.onto, {
          identity: await this.identityFor(repo.path, payload.identityId)
        })
      },
      'git.rebasePlan': async (payload) =>
        rebaseOps.getRebasePlan((await this.authorizedRepo(payload.repoPath)).path, payload.onto),
      'git.rebaseInteractive': async (payload) => {
        const repo = await this.authorizedRepo(payload.repoPath)
        return rebaseOps.rebaseInteractive(
          { ...payload, repoPath: repo.path },
          { identity: await this.identityFor(repo.path, payload.identityId) }
        )
      },
      'git.cherryPick': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        return repoOps.cherryPick(repo.path, payload.shas, {
          identity: await this.identityFor(repo.path, payload.identityId)
        })
      },
      'git.revert': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        return repoOps.revertCommit(repo.path, payload.shas, {
          identity: await this.identityFor(repo.path, payload.identityId)
        })
      },
      'git.reset': async (payload) => {
        const repo = await this.authorizedRepo(payload.repoPath)
        await repoOps.resetTo(repo.path, payload.commit, payload.mode)
        return undefined
      },
      'git.abortOperation': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.abortOperation(repo.path)
        await rebaseOps.cleanupRebaseSession(repo.path)
        return undefined
      },
      'git.continueOperation': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        const resume = await rebaseOps.rebaseEditorContext(repo.path)
        const result = await repoOps.continueOperation(
          repo.path,
          { identity: await this.identityFor(repo.path, payload.identityId) },
          { env: resume.env, args: resume.args }
        )
        await rebaseOps.cleanupRebaseSessionIfIdle(repo.path)
        return result
      },
      'git.skipOperation': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        const resume = await rebaseOps.rebaseEditorContext(repo.path)
        const result = await repoOps.skipOperation(
          repo.path,
          { identity: await this.identityFor(repo.path, payload.identityId) },
          { env: resume.env, args: resume.args }
        )
        await rebaseOps.cleanupRebaseSessionIfIdle(repo.path)
        return result
      },

      'git.tagCreate': async (payload) => {
        const repo = await this.authorizedRepo(payload.repoPath)
        const authRemote = payload.remote || (payload.push ? 'origin' : undefined)
        const ctx = authRemote
          ? await this.remoteAuth(repo.path, {
              direction: 'push',
              remoteName: authRemote,
              identityId: payload.identityId
            })
          : null
        await repoOps.createTag(
          { ...payload, repoPath: repo.path },
          {
            identity: ctx ? ctx.identity : await this.identityFor(repo.path, payload.identityId),
            account: ctx?.account,
            token: ctx?.token ?? null,
            authOrigin: ctx?.destination?.origin
          }
        )
        return undefined
      },
      'git.tagPush': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        const ctx = await this.remoteAuth(repo.path, {
          direction: 'push',
          remoteName: payload.remote,
          identityId: payload.identityId,
          accountId: payload.accountId
        })
        await runGit([...ctx.args, 'push', payload.remote, payload.name], { cwd: repo.path, env: ctx.env })
        return undefined
      },
      'git.tagDelete': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        if (payload.remote) {
          const ctx = await this.remoteAuth(repo.path, { direction: 'push', remoteName: payload.remote })
          await repoOps.deleteTag(repo.path, payload.name, payload.remote, {
            identity: ctx.identity,
            account: ctx.account,
            token: ctx.token,
            authOrigin: ctx.destination?.origin
          })
        } else {
          await repoOps.deleteTag(repo.path, payload.name)
        }
        return undefined
      },
      'git.worktreeAdd': async (payload) => this.addWorktree(payload),
      'git.worktreeRemove': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await this.assertKnownWorktree(repo, payload.worktreePath)
        await repoOps.removeWorktree(repo.path, payload.worktreePath, payload.force ?? false)
        return undefined
      },
      'git.worktreePrune': async (payload) => {
        await repoOps.pruneWorktrees((await this.authorizedRepo(payload.path)).path)
        return undefined
      },
      'git.worktreeLock': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await this.assertKnownWorktree(repo, payload.worktreePath)
        await repoOps.lockWorktree(repo.path, payload.worktreePath, payload.reason)
        return undefined
      },
      'git.worktreeUnlock': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await this.assertKnownWorktree(repo, payload.worktreePath)
        await repoOps.unlockWorktree(repo.path, payload.worktreePath)
        return undefined
      },
      'git.stashPush': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.stashPush(repo.path, payload.message, payload.includeUntracked ?? false, {
          identity: await this.identityFor(repo.path, payload.identityId)
        })
        return undefined
      },
      'git.stashApply': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.stashApply(repo.path, payload.index, false)
        return undefined
      },
      'git.stashPop': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.stashApply(repo.path, payload.index, true)
        return undefined
      },
      'git.stashDrop': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.stashDrop(repo.path, payload.index)
        return undefined
      },
      'git.submoduleAdd': async (payload) => {
        const repo = await this.authorizedRepo(payload.repoPath)
        // Credentials follow the *submodule* URL, never the parent remote.
        const auth = await this.submoduleAuth(repo.path, payload.url, payload.accountId)
        const token = auth.account && auth.origin ? await this.store.getToken(auth.account.id) : null
        const identity = await this.identityFor(repo.path)
        await repoOps.addSubmodule({ ...payload, repoPath: repo.path }, {
          identity,
          account: auth.account,
          token,
          authOrigin: auth.origin
        })
        return undefined
      },
      'git.submoduleUpdate': async (payload) => {
        const repo = await this.authorizedRepo(payload.repoPath)
        const identity = await this.identityFor(repo.path)
        return repoOps.updateSubmodules({ ...payload, repoPath: repo.path }, identity)
      },
      'git.submoduleSync': async (payload) => {
        const repo = await this.authorizedRepo(payload.repoPath)
        await repoOps.syncSubmodules(repo.path, payload.submodulePath, payload.recursive ?? false)
        return undefined
      },
      'git.submoduleRemove': async (payload) => {
        const repo = await this.authorizedRepo(payload.repoPath)
        return repoOps.removeSubmodule(repo.path, payload.submodulePath, payload.force ?? false)
      },
      'git.remoteAdd': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.addRemote(repo.path, payload.name, payload.url)
        await this.reconcileRepoDefaults(repo.path)
        return undefined
      },
      'git.remoteRemove': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.removeRemote(repo.path, payload.name)
        await this.reconcileRepoDefaults(repo.path)
        return undefined
      },
      'git.remoteSetUrl': async (payload) => {
        const repo = await this.authorizedRepo(payload.path)
        await repoOps.setRemoteUrl(repo.path, payload.name, payload.url, payload.push ?? false)
        await this.reconcileRepoDefaults(repo.path)
        return undefined
      },

      // ---------------------------------------------------------------------
      // Tasks
      'tasks.snapshot': async () => this.tasks.snapshot(),
      'git.fetch': async (payload) => this.fetchRepository(payload),
      'git.pull': async (payload) => this.pullRepository(payload),
      'git.push': async (payload) => this.pushRepository(payload),
      'git.console': async (payload) => this.runConsole(payload),

      // ---------------------------------------------------------------------
      // Providers
      'provider.detect': async (payload) => this.providers.detect((await this.authorizedRepo(payload.path)).path),
      'provider.connections': async () => this.providers.connections(),
      'provider.repos': async (payload) => this.providers.listRepos(payload.accountId, payload.search),
      'provider.pullRequests': async (payload) =>
        this.providers.listPullRequests(payload.accountId, payload.owner, payload.repo, payload.state, payload.page),
      'provider.createPullRequest': async (payload) =>
        this.providers.createPullRequest(payload.accountId, payload.owner, payload.repo, payload.input),
      'provider.checkoutPullRequest': async (payload) =>
        this.providers.checkoutPullRequest(
          (await this.authorizedRepo(payload.path)).path,
          payload.accountId,
          payload.owner,
          payload.repo,
          payload.number,
          payload.branchName,
          payload.identityId
        ),
      'provider.releases': async (payload) =>
        this.providers.listReleases(payload.accountId, payload.owner, payload.repo, payload.page),
      'provider.createRelease': async (payload) =>
        this.providers.createRelease(payload.accountId, payload.owner, payload.repo, payload.input),
      'provider.deleteRelease': async (payload) => {
        await this.providers.deleteRelease(payload.accountId, payload.owner, payload.repo, payload.id)
        return undefined
      },
      'provider.workflows': async (payload) =>
        this.providers.listWorkflows(payload.accountId, payload.owner, payload.repo, payload.page),
      'provider.runs': async (payload) =>
        this.providers.listRuns(payload.accountId, payload.owner, payload.repo, payload.workflowId, payload.page),
      'provider.triggerAction': async (payload) => {
        await this.providers.triggerAction(
          payload.accountId,
          payload.owner,
          payload.repo,
          payload.workflowId,
          payload.ref,
          payload.inputs
        )
        return undefined
      },

      // ---------------------------------------------------------------------
      // Window
      'window.minimize': async () => {
        this.getWindow()?.minimize()
        return undefined
      },
      'window.maximizeToggle': async () => {
        const window = this.getWindow()
        if (!window) return false
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
        return window.isMaximized()
      },
      'window.close': async () => {
        this.getWindow()?.close()
        return undefined
      },
      'window.isMaximized': async () => this.getWindow()?.isMaximized() ?? false,

      // ---------------------------------------------------------------------
      // Updates
      'update.status': async () => this.updates.getStatus(),
      'update.check': async () => this.updates.check(),
      'update.download': async () => this.updates.download(),
      'update.install': async () => {
        await this.updates.install()
        return undefined
      }
    }
  }

  // -------------------------------------------------------------------------
  // Authorization

  /**
   * Re-check a repository at use time. The cheap grant lookup (no spawn) runs
   * first, then the canonical path/common Git directory is checked again after
   * `resolveRepo`, so a picker-then-swap cannot widen access between the two.
   */
  private async authorizedRepo(inputPath: string): Promise<RepoInfo> {
    if (!(await this.grants.allowsRepoPath(inputPath))) {
      throw new Error('This repository was not opened through the app. Choose its folder with the folder picker first.')
    }
    const repo = await repoOps.resolveRepo(inputPath)
    if (!(await this.grants.isGrantedRepo(repo))) {
      throw new Error('The repository changed after it was authorized. Open it again.')
    }
    return repo
  }

  private async openRepository(input: string, standalone: boolean): Promise<RepoInfo> {
    const declared = path.resolve(input)
    const isRecent = this.store.getConfig().recentRepos.some((item) => path.resolve(item.path) === declared)
    // A repository nested in a granted root (a submodule, for example) is
    // reachable from the root the user already opened.
    const nested = await this.grants.allowsWrite(declared)
    if (!isRecent && !nested && !(await this.grants.allowsRepoPath(declared))) {
      throw new Error('This repository was not opened through the app. Choose its folder with the folder picker first.')
    }
    const repo = await repoOps.resolveRepo(declared)
    if (!(await this.grants.isGrantedRepo(repo))) {
      const insideGrant = await this.grants.allowsWrite(repo.canonicalPath)
      if (!isRecent && !insideGrant) {
        throw new Error('The repository changed after it was authorized. Open it again.')
      }
    }
    // Record the canonical checkout as well as the shared Git directory, so a
    // linked worktree authorized through its common dir can open its files too.
    await this.grants.grantRepo(repo)
    await rememberRecentRepo(this.store, repo, { standalone })
    return repo
  }

  private async authorizeOpenPath(target: string): Promise<void> {
    const configDir = path.dirname(this.store.getConfigPath())
    if (!(await this.grants.allowsOpenPath(target, configDir))) {
      throw new Error('This path is outside the repositories and folders you opened in the app.')
    }
  }

  /** The worktree target must follow a main-owned rule, never a renderer claim. */
  private async worktreeTargetAllowed(repo: RepoInfo, target: string): Promise<string | null> {
    if (!path.isAbsolute(target)) return null
    const canonical = await this.grants.canonicalForWrite(target)
    // A worktree parent chosen in Settings comes from the folder picker, so it
    // is already a grant and this containment check covers it. A typed path is
    // not authority; the default sibling rule below is the only exception.
    if (await this.grants.allowsWrite(target)) return canonical
    // The documented default is a direct sibling of the main worktree.
    const sibling = await this.grants.canonicalForWrite(path.dirname(repo.root))
    const targetParent = await this.grants.canonicalForWrite(path.dirname(target))
    if (path.resolve(targetParent) === path.resolve(sibling)) return canonical
    return null
  }

  private async addWorktree(input: IpcRequest<'git.worktreeAdd'>): Promise<{ path: string }> {
    const repo = await this.authorizedRepo(input.repoPath)
    const target = await this.worktreeTargetAllowed(repo, input.path)
    if (!target) {
      throw new Error('Choose the worktree folder with the folder picker or set a default worktree parent in Settings.')
    }
    await repoOps.addWorktree({ ...input, repoPath: repo.path, path: target })
    const created = await repoOps.resolveRepo(target)
    await this.grants.grantRepo(created)
    return { path: created.path }
  }

  private async assertKnownWorktree(repo: RepoInfo, worktreePath: string): Promise<void> {
    const worktrees = await repoOps.getWorktrees(repo.path)
    const target = path.resolve(worktreePath)
    if (!worktrees.some((item) => path.resolve(item.path) === target)) {
      throw new Error('That folder is not a worktree of this repository')
    }
  }

  // -------------------------------------------------------------------------
  // Task helpers

  private async cloneRepository(input: CloneInput) {
    const url = input.url
    const parent = path.resolve(input.directory)
    if (!(await this.grants.allowsWrite(parent))) {
      throw new Error('Choose the destination folder with the folder picker first.')
    }
    const destination = destinationFromUrl(url)
    const detected = detectProviderFromUrl(url)
    const provider =
      detected?.provider ?? (detected?.host ? providerFromHost(detected.host, this.store.listIntegrations()) : undefined)
    // Authorization happens before the helper is built: an explicit account
    // must match the clone destination, and an automatic one only matches.
    const account = this.store.authorizeAccount(parent, provider, destination, input.accountId)
    const origin = destination?.origin
    const token = account && origin ? await this.store.getToken(account.id) : null
    const auth = account && origin ? buildAuthArgs(account, token, origin) : { args: [], env: {} }
    const authorized = account && origin ? account : undefined

    const repoName = (input.name?.trim() || detected?.repo || path.basename(url).replace(/\.git$/, '')).replace(
      /[\\/:*?"<>|]/g,
      '-'
    )
    if (!repoName || repoName === '.' || repoName === '..') {
      throw new Error('Could not determine a folder name; provide one explicitly')
    }
    await fs.mkdir(parent, { recursive: true })
    const canonicalParent = await fs.realpath(parent)
    const target = path.join(canonicalParent, repoName)
    try {
      const entries = await fs.readdir(target)
      if (entries.length) throw new Error(`Target folder is not empty: ${target}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // The destination is derived here and granted now, so the repository can be
    // opened when the clone finishes even though it did not exist at request time.
    await this.grants.grantPath(target)

    const args = [...auth.args, 'clone', '--progress']
    if (input.bare) args.push('--bare')
    if (input.depth && input.depth > 0) args.push('--depth', String(Math.round(input.depth)))
    args.push(url, target)

    return this.tasks.start({
      kind: 'clone',
      title: `Cloning ${repoName}`,
      args,
      cwd: canonicalParent,
      repoPath: target,
      env: auth.env,
      secrets: [token],
      onExit: async (code) => {
        if (code !== 0) return
        repoOps.invalidateRepoDiscovery(target)
        try {
          const info = await repoOps.resolveRepo(target)
          await this.grants.grantRepo(info)
          await rememberRecentRepo(this.store, info)
          if (input.identityId) {
            await this.store.setRepoDefaults(info.path, {
              identityId: input.identityId,
              integrationByProvider: authorized ? { [authorized.provider]: authorized.id } : {}
            })
          } else if (authorized) {
            await this.store.setRepoDefaults(info.path, {
              integrationByProvider: { [authorized.provider]: authorized.id }
            })
          }
        } catch {
          // Clone succeeded; repo discovery is best-effort here.
        }
      }
    })
  }

  private async initRepository(input: InitInput): Promise<RepoInfo> {
    const directory = path.resolve(input.directory)
    const target = input.name ? path.join(directory, input.name) : directory
    if (!(await this.grants.allowsWrite(target))) {
      throw new Error('Choose the parent folder with the folder picker first.')
    }
    await fs.mkdir(target, { recursive: true })
    await this.grants.grantPath(target)
    const branch = input.defaultBranch ?? 'main'
    const existing = await fs.readdir(target)
    if (existing.length && !(await isGitRepo(target))) {
      throw new Error('Folder is not empty and is not a Git repository')
    }
    if (!(await isGitRepo(target))) {
      await runGit(['init', '-b', refName(branch, 'Default branch')], { cwd: target })
    }
    // A folder can have been resolved before it became a repository (or been
    // re-initialized); stale stable facts must not survive this call.
    repoOps.invalidateRepoDiscovery(target)
    const identity = this.store.resolveIdentity(input.identityId)
    if (identity) {
      await runGit(['config', '--local', 'user.name', identity.name], { cwd: target })
      await runGit(['config', '--local', 'user.email', identity.email], { cwd: target })
    }
    const info = await repoOps.resolveRepo(target)
    await this.grants.grantRepo(info)
    await rememberRecentRepo(this.store, info)
    return info
  }

  private async fetchRepository(input: FetchInput) {
    const repo = await this.authorizedRepo(input.repoPath)
    const ctx = await this.remoteAuth(repo.path, {
      direction: 'fetch',
      remoteName: input.remote,
      accountId: input.accountId
    })
    const remote = ctx.remote
    const fetchArgs = [...ctx.args, 'fetch', '--progress']
    if (input.prune) fetchArgs.push('--prune')
    if (remote) fetchArgs.push(remote)
    else fetchArgs.push('--all')
    return this.tasks.start({
      kind: 'fetch',
      title: remote ? `Fetching ${remote}` : 'Fetching all remotes',
      args: fetchArgs,
      cwd: repo.path,
      repoPath: repo.path,
      env: ctx.env,
      secrets: [ctx.token]
    })
  }

  private async pullRepository(input: PullInput) {
    const repo = await this.authorizedRepo(input.repoPath)
    const ctx = await this.remoteAuth(repo.path, {
      direction: 'fetch',
      remoteName: input.remote,
      identityId: input.identityId,
      accountId: input.accountId
    })
    const pullArgs = [...ctx.args, 'pull', '--progress']
    if (input.rebase) pullArgs.push('--rebase')
    const remote = ctx.remote
    if (remote) pullArgs.push(remote)
    if (input.branch) pullArgs.push(input.branch)
    return this.tasks.start({
      kind: 'pull',
      title: remote ? `Pulling from ${remote}` : 'Pulling',
      args: pullArgs,
      cwd: repo.path,
      repoPath: repo.path,
      env: ctx.env,
      secrets: [ctx.token]
    })
  }

  private async pushRepository(input: PushInput) {
    const repo = await this.authorizedRepo(input.repoPath)
    const ctx = await this.remoteAuth(repo.path, {
      direction: 'push',
      remoteName: input.remote,
      identityId: input.identityId,
      accountId: input.accountId
    })
    const remote = ctx.remote
    if (!remote) throw new Error('This repository has no remote configured')
    if (repo.detached && !input.branch) {
      throw new Error('Cannot push from a detached HEAD; check out a branch first')
    }
    const branch = input.branch || repo.currentBranch
    if (!branch) throw new Error('Cannot push from a detached HEAD; check out a branch first')
    const pushArgs = [...ctx.args, 'push', '--progress']
    if (input.setUpstream) pushArgs.push('--set-upstream')
    if (input.force === 'with-lease') pushArgs.push('--force-with-lease')
    else if (input.force === 'force') pushArgs.push('--force')
    pushArgs.push(remote, branch)
    return this.tasks.start({
      kind: 'push',
      title: `Pushing ${branch} to ${remote}`,
      args: pushArgs,
      cwd: repo.path,
      repoPath: repo.path,
      env: ctx.env,
      secrets: [ctx.token]
    })
  }

  private async runConsole(input: ConsoleInput) {
    const repo = await this.authorizedRepo(input.repoPath)
    const rest = validateConsoleCommand(input.command)
    // A console command can fetch or push, so both destinations are checked
    // separately and each helper is scoped to its own origin.
    // Separate variable prefixes keep each scoped helper to its own secret.
    const fetchCtx = await this.remoteAuth(repo.path, {
      direction: 'fetch',
      identityId: input.identityId,
      accountId: input.accountId,
      envPrefix: 'COMMIT87_FETCH'
    })
    const pushCtx = await this.remoteAuth(repo.path, {
      direction: 'push',
      identityId: input.identityId,
      accountId: input.accountId,
      envPrefix: 'COMMIT87_PUSH'
    })
    const secrets = [fetchCtx.token, pushCtx.token].filter((token): token is string => Boolean(token))
    return this.tasks.start({
      kind: 'console',
      title: `git ${rest.join(' ')}`,
      args: [...fetchCtx.identityArgs, ...fetchCtx.authArgs, ...pushCtx.authArgs, ...rest],
      cwd: repo.path,
      repoPath: repo.path,
      env: { ...fetchCtx.identityEnv, ...fetchCtx.authEnv, ...pushCtx.authEnv },
      secrets
    })
  }

  // -------------------------------------------------------------------------
  // Auth helpers

  /**
   * The single identity policy for every operation that can create or sign a
   * commit, or contact a remote. Resolution lives here in main:
   * explicit request > repository default > repository-local user.* > app
   * default. The renderer never has to look up repository defaults itself.
   */
  private async identityFor(repoPath: string, explicitId?: string): Promise<IdentityEnvInput | null> {
    const selection = await resolveRepoIdentity(repoPath, {
      explicitId,
      repoDefaultId: this.store.getRepoDefaults(repoPath).identityId,
      applicationIdentity: this.store.defaultIdentity(),
      identityById: (id) => this.store.identityById(id)
    })
    return selection.identity
  }

  private async submoduleAuth(
    repoPath: string,
    url: string,
    explicitId?: string
  ): Promise<{ account?: IntegrationAccount; origin?: string }> {
    const target = await this.submoduleTarget(repoPath, url)
    if (explicitId) {
      if (!target) throw new Error('An integration account needs a submodule URL with a host')
      const explicit = this.store.authorizeAccount(repoPath, target.provider, target.destination, explicitId)
      return { account: explicit, origin: target.destination.origin }
    }
    if (!target) return {}
    const account = this.store.authorizeAccount(repoPath, target.provider, target.destination)
    return { account, origin: target.destination.origin }
  }

  /** Resolve the destination a submodule URL will contact, including relative URLs. */
  private async submoduleTarget(
    repoPath: string,
    url: string
  ): Promise<{ destination: GitDestination; provider?: ProviderId } | null> {
    const direct = destinationFromUrl(url)
    if (direct) return { destination: direct, provider: direct.provider }
    if (!/^\.{1,2}\//.test(url.trim())) return null

    const repo = await repoOps.resolveRepo(repoPath)
    // Git resolves a relative submodule URL against the current branch's
    // remote (falling back to origin), never against an arbitrary remote.
    let remoteName: string | undefined
    if (repo.currentBranch) {
      const configured = await runGit(['config', '--get', `branch.${repo.currentBranch}.remote`], {
        cwd: repo.root,
        allowFailure: true
      })
      remoteName = configured.stdout.trim() || undefined
      if (remoteName === '.') remoteName = undefined
    }
    const defaults = this.store.getRepoDefaults(repo.path)
    const remote =
      repo.remotes.find((item) => item.name === remoteName) ??
      repo.remotes.find((item) => item.name === 'origin') ??
      (defaults.defaultRemote ? repo.remotes.find((item) => item.name === defaults.defaultRemote) : undefined)
    if (!remote) return null

    const destination = destinationFromUrl(remote.fetchUrl) ?? destinationFromUrl(remote.pushUrl)
    if (!destination) return null
    return { destination, provider: destination.provider ?? remote.provider }
  }

  private async remoteAuth(
    repoPath: string,
    options: {
      direction: 'fetch' | 'push'
      remoteName?: string
      identityId?: string
      accountId?: string
      envPrefix?: string
    }
  ): Promise<RemoteAuth> {
    const repo = await repoOps.resolveRepo(repoPath)
    const identity = await this.identityFor(repo.path, options.identityId)
    const remote = this.selectRemote(repo, options.remoteName)
    const url = options.direction === 'push' ? remote?.pushUrl || remote?.fetchUrl : remote?.fetchUrl
    const destination = url ? destinationFromUrl(url) : null
    const provider = remote?.provider ?? destination?.provider
    // The renderer's detected account is a preference, not a grant: automatic
    // fetch/push/console flows must not fail when it belongs to another remote.
    const account = this.store.authorizeAccount(repo.path, provider, destination, options.accountId, 'prefer')
    // ssh/git remotes use keys; a forge token is only installed for an exact
    // https origin that the account was authorized for.
    const origin = destination?.origin
    const token = account && origin ? await this.store.getToken(account.id) : null
    const auth = account && origin ? buildAuthArgs(account, token, origin, options.envPrefix) : { args: [], env: {} }
    const ident = buildIdentityEnv(identity)
    return {
      repo,
      identity,
      account: account && origin ? account : undefined,
      token,
      destination,
      remote: remote?.name,
      identityArgs: ident.args,
      identityEnv: ident.env,
      authArgs: auth.args,
      authEnv: auth.env,
      args: [...ident.args, ...auth.args],
      env: { ...ident.env, ...auth.env }
    }
  }

  private selectRemote(repo: RepoInfo, remoteName?: string) {
    if (remoteName) {
      const named = repo.remotes.find((item) => item.name === remoteName)
      if (!named) throw new Error(`Unknown remote "${remoteName}"`)
      return named
    }
    const preferred = this.defaultRemote(repo)
    return preferred ? repo.remotes.find((item) => item.name === preferred) : undefined
  }

  private defaultRemote(repo: RepoInfo): string | undefined {
    return this.store.getRepoDefaults(repo.path).defaultRemote || repo.remotes[0]?.name
  }

  /**
   * Drop pinned provider→account mappings whose account no longer matches any
   * remote destination. Called after a remote URL changes so a stale pin
   * cannot keep releasing a token for the previous host.
   */
  private async reconcileRepoDefaults(repoPath: string): Promise<void> {
    const repo = await repoOps.resolveRepo(repoPath)
    const defaults = this.store.getRepoDefaults(repo.path)
    const integrationByProvider = { ...defaults.integrationByProvider }
    let changed = false
    for (const [key, accountId] of Object.entries(integrationByProvider)) {
      if (!accountId) continue
      const provider = key as ProviderId
      const account = this.store.integrationById(accountId)
      const matched =
        account &&
        repo.remotes.some((remote) => {
          const destination = destinationFromUrl(remote.fetchUrl) ?? destinationFromUrl(remote.pushUrl)
          return destination ? accountMatchesDestination(account, destination) : false
        })
      if (!matched) {
        delete integrationByProvider[provider]
        changed = true
      }
    }
    if (changed) {
      await this.store.setRepoDefaults(repo.path, { ...defaults, integrationByProvider })
    }
  }
}

/** One authorized remote operation: identity, destination and scoped helper. */
interface RemoteAuth {
  repo: RepoInfo
  identity: IdentityEnvInput | null
  account?: IntegrationAccount
  token: string | null
  destination: GitDestination | null
  remote?: string
  identityArgs: string[]
  identityEnv: NodeJS.ProcessEnv
  authArgs: string[]
  authEnv: NodeJS.ProcessEnv
  args: string[]
  env: NodeJS.ProcessEnv
}

// ---------------------------------------------------------------------------
// Payload decoding
//
// Each decoder turns `unknown` into the channel's declared request type. Extra
// fields are ignored; a field that is present but wrong rejects. Handlers never
// see an unchecked value and never need a cast.

const noPayload = (): void => undefined

function objectPayload(value: unknown): Record<string, unknown> {
  return value === undefined || value === null ? {} : record(value, 'Request')
}

function pathRequest(value: unknown, label = 'Repository path'): { path: string } {
  const source = objectPayload(value)
  return { path: repoPath(source.path, label) }
}

function idRequest(value: unknown, label = 'Id'): { id: string } {
  const source = objectPayload(value)
  return { id: str(source.id, label, { max: 240 }) }
}

function optRevision(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return revision(value, label)
}

function optRef(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return refName(value, label)
}

function optText(value: unknown, label: string, max = 100_000): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return str(value, label, { max })
}

function decodeConfigPatch(value: unknown): Partial<AppConfig> {
  const source = value === undefined || value === null ? {} : record(value, 'Configuration patch')
  if (source.gitBinary !== undefined) {
    throw new Error('Choose the Git executable with the "Choose…" button; a config patch cannot set it.')
  }
  const patch: Partial<AppConfig> = {}
  if (source.theme !== undefined) patch.theme = enumOf(source.theme, ['dark', 'light', 'system'] as const, 'Theme')
  if (source.maxCommits !== undefined) {
    patch.maxCommits = num(source.maxCommits, 'Commits loaded', { min: 50, max: 5000 })
  }
  if (source.confirmDestructive !== undefined) {
    patch.confirmDestructive = bool(source.confirmDestructive, 'Confirm destructive actions')
  }
  if (source.autoFetchOnOpen !== undefined) {
    patch.autoFetchOnOpen = bool(source.autoFetchOnOpen, 'Fetch on open')
  }
  if (source.updateChannel !== undefined) {
    patch.updateChannel = enumOf(source.updateChannel, ['stable', 'beta'] as const, 'Update channel')
  }
  if (source.autoUpdateCheck !== undefined) {
    patch.autoUpdateCheck = bool(source.autoUpdateCheck, 'Automatic update check')
  }
  if (source.defaultProvider !== undefined) {
    patch.defaultProvider =
      source.defaultProvider === ''
        ? undefined
        : enumOf(source.defaultProvider, PROVIDER_IDS, 'Default provider')
  }
  if (source.worktreeParent !== undefined) {
    const parent = optStr(source.worktreeParent, 'Default worktree parent', { max: 4096 })
    if (parent && !path.isAbsolute(parent)) throw new Error('Default worktree parent must be an absolute path')
    patch.worktreeParent = parent
  }
  return patch
}

function decodeRepoDefaults(value: unknown): RepoDefaults {
  const source = value === undefined || value === null ? {} : record(value, 'Repository defaults')
  const integrationSource =
    source.integrationByProvider === undefined ? {} : record(source.integrationByProvider, 'Provider accounts')
  const integrationByProvider: Partial<Record<ProviderId, string>> = {}
  for (const [providerKey, accountValue] of Object.entries(integrationSource)) {
    const provider = enumOf(providerKey, PROVIDER_IDS, 'Provider')
    const accountId = optStr(accountValue, 'Integration account', { max: 240 })
    if (accountId) integrationByProvider[provider] = accountId
  }
  return {
    identityId: optStr(source.identityId, 'Identity id', { max: 240 }),
    defaultRemote: optStr(source.defaultRemote, 'Default remote', { max: 240 }),
    integrationByProvider
  }
}

function decodeCloneInput(value: unknown): CloneInput {
  const source = objectPayload(value)
  return {
    url: remoteUrl(source.url),
    directory: repoPath(source.directory, 'Destination folder'),
    name: optFolderName(source.name, 'Folder name'),
    accountId: optStr(source.accountId, 'Integration id', { max: 240 }),
    identityId: optStr(source.identityId, 'Identity id', { max: 240 }),
    bare: bool(source.bare ?? false, 'Bare clone'),
    depth: optNum(source.depth, 'Depth', { min: 1, max: 100_000 })
  }
}

function decodeInitInput(value: unknown): InitInput {
  const source = objectPayload(value)
  return {
    directory: repoPath(source.directory, 'Parent folder'),
    name: optFolderName(source.name, 'Folder name'),
    defaultBranch: optRef(source.defaultBranch, 'Default branch'),
    identityId: optStr(source.identityId, 'Identity id', { max: 240 })
  }
}

function decodeFilters(value: unknown): { name: string; extensions: string[] }[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('Filters must be a list')
  if (value.length > 20) throw new Error('Too many file filters')
  return value.map((item) => {
    const source = record(item, 'File filter')
    return {
      name: str(source.name, 'Filter name', { max: 100 }),
      extensions: strArray(source.extensions, 'Filter extensions', { min: 1, max: 50, maxLength: 32 })
    }
  })
}

function decodePullRequestInput(value: unknown) {
  const source = record(value, 'Pull request')
  return {
    title: str(source.title, 'Title', { max: 10_000 }),
    sourceBranch: refName(source.sourceBranch, 'Source branch'),
    targetBranch: refName(source.targetBranch, 'Target branch'),
    body: optText(source.body, 'Body'),
    draft: bool(source.draft ?? false, 'Draft')
  }
}

function decodeReleaseInput(value: unknown) {
  const source = record(value, 'Release')
  return {
    tagName: refName(source.tagName, 'Tag name'),
    name: str(source.name, 'Release name', { max: 10_000 }),
    body: optText(source.body, 'Body'),
    target: optRevision(source.target, 'Target'),
    draft: bool(source.draft ?? false, 'Draft'),
    prerelease: bool(source.prerelease ?? false, 'Prerelease')
  }
}

const DECODERS: DecoderTable = {
  'app.info': noPayload,
  'app.launchTarget': noPayload,
  'app.checkGit': (value): { path?: string } => {
    const source = objectPayload(value)
    return { path: optStr(source.path, 'Git path', { max: 4096 }) }
  },
  'app.pickGitBinary': noPayload,
  'app.useSystemGit': noPayload,
  'app.openExternal': (value): { url: string } => {
    const source = objectPayload(value)
    return { url: str(source.url, 'URL', { max: 4096 }) }
  },
  'app.openPath': (value): { path: string } => pathRequest(value, 'Path'),
  'app.showItemInFolder': (value): { path: string } => pathRequest(value, 'Path'),
  'app.pickDirectory': (value): { title?: string; defaultPath?: string } => {
    const source = objectPayload(value)
    return {
      title: optStr(source.title, 'Title', { max: 200 }),
      defaultPath: optStr(source.defaultPath, 'Default path', { max: 4096 })
    }
  },
  'app.pickFile': (value): { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] } => {
    const source = objectPayload(value)
    return {
      title: optStr(source.title, 'Title', { max: 200 }),
      defaultPath: optStr(source.defaultPath, 'Default path', { max: 4096 }),
      filters: decodeFilters(source.filters)
    }
  },
  'app.openConfigFolder': noPayload,

  'config.get': noPayload,
  'config.update': (value): { patch: Partial<AppConfig> } => {
    const source = objectPayload(value)
    return { patch: decodeConfigPatch(source.patch) }
  },

  'identity.list': noPayload,
  'identity.save': (value) => {
    const source = objectPayload(value)
    return {
      id: optStr(source.id, 'Identity id', { max: 240 }),
      label: optStr(source.label, 'Label', { max: 240 }) ?? '',
      name: str(source.name, 'Name', { max: 240 }),
      email: str(source.email, 'Email', { max: 240 }),
      sshKeyPath: optStr(source.sshKeyPath, 'SSH key', { max: 4096 }),
      gpgKeyId: optStr(source.gpgKeyId, 'GPG key', { max: 240 }),
      gpgSign: bool(source.gpgSign ?? false, 'GPG signing'),
      isDefault: optBool(source.isDefault, 'Default identity')
    }
  },
  'identity.delete': (value) => idRequest(value, 'Identity id'),
  'identity.setDefault': (value) => idRequest(value, 'Identity id'),

  'integration.list': noPayload,
  'integration.save': (value) => {
    const source = objectPayload(value)
    return {
      id: optStr(source.id, 'Integration id', { max: 240 }),
      provider: enumOf(source.provider, PROVIDER_IDS, 'Provider'),
      label: optStr(source.label, 'Label', { max: 240 }) ?? '',
      username: optStr(source.username, 'Username', { max: 240 }) ?? '',
      baseUrl: str(source.baseUrl, 'Base URL', { max: 4096 }),
      cloneHost: optStr(source.cloneHost, 'Clone host', { max: 255 }),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 }),
      token: optStr(source.token, 'Token', { max: 4096 })
    }
  },
  'integration.delete': (value) => idRequest(value, 'Integration id'),
  'integration.test': (value) => idRequest(value, 'Integration id'),

  'repo.recent': noPayload,
  'repo.open': (value): { path: string; standalone?: boolean } => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      standalone: optBool(source.standalone, 'Standalone') ?? false
    }
  },
  'repo.info': (value) => pathRequest(value),
  'repo.removeRecent': (value) => pathRequest(value),
  'repo.pinRecent': (value): { path: string; pinned: boolean } => {
    const source = objectPayload(value)
    return { path: repoPath(source.path), pinned: bool(source.pinned, 'Pinned') }
  },
  'repo.getDefaults': (value) => pathRequest(value),
  'repo.setDefaults': (value): { path: string; defaults: RepoDefaults } => {
    const source = objectPayload(value)
    return { path: repoPath(source.path), defaults: decodeRepoDefaults(source.defaults) }
  },
  'repo.clone': (value) => decodeCloneInput(value),
  'repo.init': (value) => decodeInitInput(value),

  'git.status': (value) => pathRequest(value),
  'git.log': (value): IpcRequest<'git.log'> => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      limit: optNum(source.limit, 'Limit', { min: 1, max: 5000 }),
      skip: optNum(source.skip, 'Skip', { min: 0, max: 1_000_000_000 }),
      branch: optRevision(source.branch, 'Branch'),
      all: optBool(source.all, 'All refs'),
      search: optText(source.search, 'Search', 1000)
    }
  },
  'git.commitDetail': (value): { path: string; sha: string } => {
    const source = objectPayload(value)
    return { path: repoPath(source.path), sha: revision(source.sha, 'Commit') }
  },
  'git.branches': (value) => pathRequest(value),
  'git.tags': (value) => pathRequest(value),
  'git.remotes': (value) => pathRequest(value),
  'git.worktrees': (value) => pathRequest(value),
  'git.worktreeStatuses': (value) => pathRequest(value),
  'git.stashes': (value) => pathRequest(value),
  'git.submodules': (value) => pathRequest(value),
  'git.diff': (value): IpcRequest<'git.diff'> => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      path: optRelPath(source.path, 'File'),
      staged: bool(source.staged ?? false, 'Staged'),
      commit: optRevision(source.commit, 'Commit'),
      compare: source.compare === undefined || source.compare === '' ? undefined : revisionRange(source.compare, 'Compare')
    }
  },
  'git.resolveConflict': (value): IpcRequest<'git.resolveConflict'> => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      file: relPath(source.file, 'File'),
      content: text(source.content, 'Resolved content', { max: 10 * 1024 * 1024 }),
      expectedSha256: optHexDigest(source.expectedSha256, 'Expected content hash')
    }
  },
  'git.fileTree': (value): { path: string; dir: string } => {
    const source = objectPayload(value)
    const dir = source.dir === undefined || source.dir === null || source.dir === '' ? '' : relPath(source.dir, 'Directory')
    return { path: repoPath(source.path), dir }
  },
  'git.fileContent': (value): IpcRequest<'git.fileContent'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      file: relPath(source.file, 'File'),
      from: source.from === undefined ? 'worktree' : enumOf(source.from, ['worktree', 'head'] as const, 'Content source'),
      commit: optRevision(source.commit, 'Commit')
    }
  },
  'git.blame': (value): { path: string; file: string; commit?: string } => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      file: relPath(source.file, 'File'),
      commit: optRevision(source.commit, 'Commit')
    }
  },
  'git.config': (value) => pathRequest(value),
  'git.setConfig': (value): { path: string; key: string; value: string } => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      key: configKey(source.key),
      value: text(source.value, 'Configuration value', { max: 4096 })
    }
  },

  'git.stage': (value): { path: string; files: string[] } => {
    const source = objectPayload(value)
    return { path: repoPath(source.path), files: strArray(source.files, 'Files', { maxLength: 4096 }) }
  },
  'git.unstage': (value): { path: string; files: string[] } => {
    const source = objectPayload(value)
    return { path: repoPath(source.path), files: strArray(source.files, 'Files', { maxLength: 4096 }) }
  },
  'git.discard': (value): { path: string; files: string[]; includeUntracked: boolean } => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      files: strArray(source.files, 'Files', { maxLength: 4096 }),
      includeUntracked: bool(source.includeUntracked ?? false, 'Include untracked files')
    }
  },
  'git.commit': (value): IpcRequest<'git.commit'> => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      message: str(source.message, 'Commit message', { max: 100_000 }),
      amend: bool(source.amend ?? false, 'Amend'),
      signoff: bool(source.signoff ?? false, 'Sign off'),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 }),
      allowEmpty: bool(source.allowEmpty ?? false, 'Allow empty commit')
    }
  },
  'git.checkout': (value): IpcRequest<'git.checkout'> => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      branch: revision(source.branch, 'Checkout target'),
      create: bool(source.create ?? false, 'Create branch'),
      startPoint: optRevision(source.startPoint, 'Start point'),
      track: bool(source.track ?? false, 'Track'),
      force: bool(source.force ?? false, 'Force checkout'),
      detach: bool(source.detach ?? false, 'Detach HEAD')
    }
  },
  'git.createBranch': (value): IpcRequest<'git.createBranch'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      name: refName(source.name, 'Branch name'),
      startPoint: optRevision(source.startPoint, 'Start point'),
      checkout: bool(source.checkout ?? false, 'Check out'),
      track: bool(source.track ?? false, 'Track')
    }
  },
  'git.renameBranch': (value): IpcRequest<'git.renameBranch'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      from: refName(source.from, 'Current branch'),
      to: refName(source.to, 'New branch name')
    }
  },
  'git.deleteBranch': (value): IpcRequest<'git.deleteBranch'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      name: refName(source.name, 'Branch name'),
      force: bool(source.force ?? false, 'Force delete'),
      remote: optRemoteName(source.remote),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 }),
      accountId: optStr(source.accountId, 'Integration id', { max: 240 })
    }
  },
  'git.setUpstream': (value): IpcRequest<'git.setUpstream'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      branch: refName(source.branch, 'Branch'),
      upstream: refName(source.upstream, 'Upstream')
    }
  },
  'git.merge': (value): IpcRequest<'git.merge'> => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      branch: revision(source.branch, 'Merge target'),
      noFf: bool(source.noFf ?? false, 'No fast-forward'),
      ffOnly: bool(source.ffOnly ?? false, 'Fast-forward only'),
      squash: bool(source.squash ?? false, 'Squash'),
      message: optText(source.message, 'Message'),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 })
    }
  },
  'git.rebase': (value): IpcRequest<'git.rebase'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      onto: revision(source.onto, 'Rebase base'),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 })
    }
  },
  'git.rebasePlan': (value): IpcRequest<'git.rebasePlan'> => {
    const source = objectPayload(value)
    return { repoPath: repoPath(source.repoPath), onto: revision(source.onto, 'Rebase base') }
  },
  'git.rebaseInteractive': (value): IpcRequest<'git.rebaseInteractive'> => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      onto: revision(source.onto, 'Rebase base'),
      items: parseRebaseTodoItems(source.items),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 })
    }
  },
  'git.cherryPick': (value): IpcRequest<'git.cherryPick'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      shas: repoOps.validateCommitShas(source.shas),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 })
    }
  },
  'git.revert': (value): IpcRequest<'git.revert'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      shas: repoOps.validateCommitShas(source.shas),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 })
    }
  },
  'git.reset': (value): IpcRequest<'git.reset'> => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      commit: revision(source.commit, 'Commit'),
      mode: enumOf(source.mode, ['soft', 'mixed', 'hard'] as const, 'Reset mode')
    }
  },
  'git.abortOperation': (value) => pathRequest(value),
  'git.continueOperation': (value): { path: string; identityId?: string } => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 })
    }
  },
  'git.skipOperation': (value): { path: string; identityId?: string } => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 })
    }
  },

  'git.tagCreate': (value): IpcRequest<'git.tagCreate'> => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      name: refName(source.name, 'Tag name'),
      message: optText(source.message, 'Message'),
      commit: optRevision(source.commit, 'Commit'),
      push: bool(source.push ?? false, 'Push tag'),
      remote: optRemoteName(source.remote),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 })
    }
  },
  'git.tagPush': (value): IpcRequest<'git.tagPush'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      name: refName(source.name, 'Tag name'),
      remote: remoteName(source.remote),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 }),
      accountId: optStr(source.accountId, 'Integration id', { max: 240 })
    }
  },
  'git.tagDelete': (value): IpcRequest<'git.tagDelete'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      name: refName(source.name, 'Tag name'),
      remote: optRemoteName(source.remote)
    }
  },
  'git.worktreeAdd': (value): IpcRequest<'git.worktreeAdd'> => {
    const source = objectPayload(value)
    const detach = bool(source.detach ?? false, 'Detach HEAD')
    return {
      repoPath: repoPath(source.repoPath),
      path: repoPath(source.path, 'Worktree path'),
      // Detached worktrees may name any revision; a branch checkout must be a
      // real branch name.
      branch: detach ? revision(source.branch, 'Worktree target') : refName(source.branch, 'Branch'),
      createBranch: bool(source.createBranch ?? false, 'Create branch'),
      startPoint: optRevision(source.startPoint, 'Start point'),
      detach
    }
  },
  'git.worktreeRemove': (value): IpcRequest<'git.worktreeRemove'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      worktreePath: repoPath(source.worktreePath, 'Worktree path'),
      force: bool(source.force ?? false, 'Force removal')
    }
  },
  'git.worktreePrune': (value) => pathRequest(value),
  'git.worktreeLock': (value): IpcRequest<'git.worktreeLock'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      worktreePath: repoPath(source.worktreePath, 'Worktree path'),
      reason: optText(source.reason, 'Reason', 1000)
    }
  },
  'git.worktreeUnlock': (value): IpcRequest<'git.worktreeUnlock'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      worktreePath: repoPath(source.worktreePath, 'Worktree path')
    }
  },
  'git.stashPush': (value): IpcRequest<'git.stashPush'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      message: optText(source.message, 'Message'),
      includeUntracked: bool(source.includeUntracked ?? false, 'Include untracked files'),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 })
    }
  },
  'git.stashApply': (value): { path: string; index: number } => {
    const source = objectPayload(value)
    return { path: repoPath(source.path), index: num(source.index, 'Stash index', { min: 0, max: 100_000 }) }
  },
  'git.stashPop': (value): { path: string; index: number } => {
    const source = objectPayload(value)
    return { path: repoPath(source.path), index: num(source.index, 'Stash index', { min: 0, max: 100_000 }) }
  },
  'git.stashDrop': (value): { path: string; index: number } => {
    const source = objectPayload(value)
    return { path: repoPath(source.path), index: num(source.index, 'Stash index', { min: 0, max: 100_000 }) }
  },
  'git.submoduleAdd': (value): IpcRequest<'git.submoduleAdd'> => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      url: submoduleUrl(source.url),
      path: optRelPath(source.path, 'Submodule path'),
      branch: optRef(source.branch, 'Submodule branch'),
      force: bool(source.force ?? false, 'Force add'),
      accountId: optStr(source.accountId, 'Integration id', { max: 240 })
    }
  },
  'git.submoduleUpdate': (value): IpcRequest<'git.submoduleUpdate'> => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      submodulePath: optRelPath(source.submodulePath, 'Submodule path'),
      init: bool(source.init ?? false, 'Initialise'),
      recursive: bool(source.recursive ?? false, 'Recursive'),
      remote: bool(source.remote ?? false, 'Remote'),
      force: bool(source.force ?? false, 'Force update'),
      clean: bool(source.clean ?? false, 'Clean')
    }
  },
  'git.submoduleSync': (value): IpcRequest<'git.submoduleSync'> => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      submodulePath: optRelPath(source.submodulePath, 'Submodule path'),
      recursive: bool(source.recursive ?? false, 'Recursive')
    }
  },
  'git.submoduleRemove': (value): IpcRequest<'git.submoduleRemove'> => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      submodulePath: relPath(source.submodulePath, 'Submodule path'),
      force: bool(source.force ?? false, 'Force removal')
    }
  },
  'git.remoteAdd': (value): IpcRequest<'git.remoteAdd'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      name: remoteName(source.name),
      url: remoteUrl(source.url)
    }
  },
  'git.remoteRemove': (value): { path: string; name: string } => {
    const source = objectPayload(value)
    return { path: repoPath(source.path), name: remoteName(source.name) }
  },
  'git.remoteSetUrl': (value): IpcRequest<'git.remoteSetUrl'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      name: remoteName(source.name),
      url: remoteUrl(source.url),
      push: bool(source.push ?? false, 'Push URL')
    }
  },

  'tasks.snapshot': noPayload,
  'git.fetch': (value): FetchInput => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      remote: optRemoteName(source.remote),
      prune: bool(source.prune ?? false, 'Prune'),
      accountId: optStr(source.accountId, 'Integration id', { max: 240 })
    }
  },
  'git.pull': (value): PullInput => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      remote: optRemoteName(source.remote),
      branch: optRevision(source.branch, 'Branch'),
      rebase: bool(source.rebase ?? false, 'Rebase'),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 }),
      accountId: optStr(source.accountId, 'Integration id', { max: 240 })
    }
  },
  'git.push': (value): PushInput => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      remote: optRemoteName(source.remote),
      branch: optRevision(source.branch, 'Branch'),
      setUpstream: bool(source.setUpstream ?? false, 'Set upstream'),
      force:
        source.force === undefined
          ? 'none'
          : enumOf(source.force, ['none', 'with-lease', 'force'] as const, 'Force mode'),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 }),
      accountId: optStr(source.accountId, 'Integration id', { max: 240 })
    }
  },
  'git.console': (value): ConsoleInput => {
    const source = objectPayload(value)
    return {
      repoPath: repoPath(source.repoPath),
      command: str(source.command, 'Command', { max: 4096 }),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 }),
      accountId: optStr(source.accountId, 'Integration id', { max: 240 })
    }
  },

  'provider.detect': (value) => pathRequest(value),
  'provider.connections': noPayload,
  'provider.repos': (value): { accountId: string; search?: string } => {
    const source = objectPayload(value)
    return {
      accountId: str(source.accountId, 'Integration id', { max: 240 }),
      search: optText(source.search, 'Search', 1000)
    }
  },
  'provider.pullRequests': (value): IpcRequest<'provider.pullRequests'> => {
    const source = objectPayload(value)
    return {
      accountId: str(source.accountId, 'Integration id', { max: 240 }),
      owner: slugPart(source.owner, 'Owner'),
      repo: slugPart(source.repo, 'Repository'),
      state:
        source.state === undefined
          ? 'open'
          : enumOf(source.state, ['open', 'closed', 'all'] as const, 'Pull request state'),
      page: optText(source.page, 'Page', 4096)
    }
  },
  'provider.createPullRequest': (value): IpcRequest<'provider.createPullRequest'> => {
    const source = objectPayload(value)
    return {
      accountId: str(source.accountId, 'Integration id', { max: 240 }),
      owner: slugPart(source.owner, 'Owner'),
      repo: slugPart(source.repo, 'Repository'),
      input: decodePullRequestInput(source.input)
    }
  },
  'provider.checkoutPullRequest': (value): IpcRequest<'provider.checkoutPullRequest'> => {
    const source = objectPayload(value)
    return {
      path: repoPath(source.path),
      accountId: str(source.accountId, 'Integration id', { max: 240 }),
      owner: slugPart(source.owner, 'Owner'),
      repo: slugPart(source.repo, 'Repository'),
      number: num(source.number, 'Pull request number', { min: 1, max: 1_000_000_000 }),
      branchName: optRef(source.branchName, 'Branch name'),
      identityId: optStr(source.identityId, 'Identity id', { max: 240 })
    }
  },
  'provider.releases': (value): IpcRequest<'provider.releases'> => {
    const source = objectPayload(value)
    return {
      accountId: str(source.accountId, 'Integration id', { max: 240 }),
      owner: slugPart(source.owner, 'Owner'),
      repo: slugPart(source.repo, 'Repository'),
      page: optText(source.page, 'Page', 4096)
    }
  },
  'provider.createRelease': (value): IpcRequest<'provider.createRelease'> => {
    const source = objectPayload(value)
    return {
      accountId: str(source.accountId, 'Integration id', { max: 240 }),
      owner: slugPart(source.owner, 'Owner'),
      repo: slugPart(source.repo, 'Repository'),
      input: decodeReleaseInput(source.input)
    }
  },
  'provider.deleteRelease': (value): IpcRequest<'provider.deleteRelease'> => {
    const source = objectPayload(value)
    return {
      accountId: str(source.accountId, 'Integration id', { max: 240 }),
      owner: slugPart(source.owner, 'Owner'),
      repo: slugPart(source.repo, 'Repository'),
      id: slugPart(source.id, 'Release id')
    }
  },
  'provider.workflows': (value): IpcRequest<'provider.workflows'> => {
    const source = objectPayload(value)
    return {
      accountId: str(source.accountId, 'Integration id', { max: 240 }),
      owner: slugPart(source.owner, 'Owner'),
      repo: slugPart(source.repo, 'Repository'),
      page: optText(source.page, 'Page', 4096)
    }
  },
  'provider.runs': (value): IpcRequest<'provider.runs'> => {
    const source = objectPayload(value)
    return {
      accountId: str(source.accountId, 'Integration id', { max: 240 }),
      owner: slugPart(source.owner, 'Owner'),
      repo: slugPart(source.repo, 'Repository'),
      workflowId: optWord(source.workflowId, 'Workflow id'),
      page: optText(source.page, 'Page', 4096)
    }
  },
  'provider.triggerAction': (value): IpcRequest<'provider.triggerAction'> => {
    const source = objectPayload(value)
    return {
      accountId: str(source.accountId, 'Integration id', { max: 240 }),
      owner: slugPart(source.owner, 'Owner'),
      repo: slugPart(source.repo, 'Repository'),
      workflowId: optWord(source.workflowId, 'Workflow id'),
      ref: revision(source.ref, 'Ref'),
      inputs: recordOf(source.inputs, 'Action inputs')
    }
  },

  'window.minimize': noPayload,
  'window.maximizeToggle': noPayload,
  'window.close': noPayload,
  'window.isMaximized': noPayload,

  'update.status': noPayload,
  'update.check': noPayload,
  'update.download': noPayload,
  'update.install': noPayload
}

async function isGitRepo(target: string): Promise<boolean> {
  try {
    const result = await runGit(['rev-parse', '--git-dir'], { cwd: target, allowFailure: true })
    return result.exitCode === 0
  } catch {
    return false
  }
}
