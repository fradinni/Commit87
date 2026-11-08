import { app, dialog, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { APP_VERSION } from '../version'
import type { BrowserWindow, OpenDialogOptions } from 'electron'
import type { AppConfig, CloneInput, GitIdentity, IntegrationAccount, ProviderId, RepoDefaults, RepoInfo } from '@shared/types'
import { PROVIDERS } from '@shared/types'
import type { IpcChannel } from '@shared/ipc'
import { AppStore } from '../store'
import { rememberRecentRepo } from '../recent'
import { TaskManager, validateConsoleCommand } from '../tasks'
import { buildAuthArgs, buildIdentityEnv, detectGit, runGit } from '../git/runner'
import * as repoOps from '../git/repo'
import * as rebaseOps from '../git/rebase'
import { parseRebaseTodoItems } from '../git/rebase-plan'
import { normalizeBaseUrl, accountMatchesHost, detectProviderFromUrl, providerFromHost } from '../providers/remote'
import { ProviderService } from '../providers/service'
import type { UpdateService } from '../updates'

type GetWindow = () => BrowserWindow | null
type GetLaunchTarget = () => string | null

export class Router {
  private readonly store: AppStore
  private readonly tasks: TaskManager
  private readonly providers: ProviderService
  private readonly updates: UpdateService
  private readonly getWindow: GetWindow
  private readonly getLaunchTarget: GetLaunchTarget

  constructor(
    store: AppStore,
    tasks: TaskManager,
    providers: ProviderService,
    updates: UpdateService,
    getWindow: GetWindow,
    getLaunchTarget: GetLaunchTarget
  ) {
    this.store = store
    this.tasks = tasks
    this.providers = providers
    this.updates = updates
    this.getWindow = getWindow
    this.getLaunchTarget = getLaunchTarget
  }

  async handle(channel: IpcChannel, payload: unknown): Promise<unknown> {
    const data = (payload ?? {}) as Record<string, unknown>
    switch (channel) {
      // ---------------------------------------------------------------------
      // App
      case 'app.info': {
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
      }
      case 'app.launchTarget':
        return this.getLaunchTarget()
      case 'app.checkGit': {
        const gitPath = asOptionalString(data.path, 'Git path')
        const info = await detectGit(gitPath || undefined)
        if (gitPath && info.available) await this.store.setGitBinary(gitPath)
        return info
      }
      case 'app.openExternal': {
        const url = requireString(data.url, 'URL')
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          throw new Error('Invalid URL')
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('Only http and https links can be opened')
        }
        await shell.openExternal(parsed.toString())
        return undefined
      }
      case 'app.openPath': {
        const target = requireString(data.path, 'Path')
        const error = await shell.openPath(target)
        return { ok: !error, error: error || undefined }
      }
      case 'app.showItemInFolder': {
        const target = requireString(data.path, 'Path')
        shell.showItemInFolder(target)
        return undefined
      }
      case 'app.pickDirectory': {
        const window = this.getWindow()
        const options: OpenDialogOptions = {
          title: asOptionalString(data.title, 'Title') || 'Choose a folder',
          defaultPath: asOptionalString(data.defaultPath, 'Default path'),
          properties: ['openDirectory', 'createDirectory']
        }
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : result.filePaths[0] ?? null
      }
      case 'app.pickFile': {
        const window = this.getWindow()
        const options: OpenDialogOptions = {
          title: asOptionalString(data.title, 'Title') || 'Choose a file',
          defaultPath: asOptionalString(data.defaultPath, 'Default path'),
          properties: ['openFile'],
          filters: Array.isArray(data.filters) ? (data.filters as { name: string; extensions: string[] }[]) : undefined
        }
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : result.filePaths[0] ?? null
      }
      case 'app.openConfigFolder': {
        await shell.openPath(path.dirname(this.store.getConfigPath()))
        return undefined
      }

      // ---------------------------------------------------------------------
      // Config & accounts
      case 'config.get':
        return this.store.getConfig()
      case 'config.update': {
        const patch = (data.patch ?? {}) as Partial<AppConfig>
        const allowed: Partial<AppConfig> = {}
        if (typeof patch.gitBinary === 'string') allowed.gitBinary = patch.gitBinary.trim()
        if (patch.theme === 'dark' || patch.theme === 'light' || patch.theme === 'system') allowed.theme = patch.theme
        if (typeof patch.maxCommits === 'number' && patch.maxCommits >= 50 && patch.maxCommits <= 5000) {
          allowed.maxCommits = Math.round(patch.maxCommits)
        }
        if (typeof patch.confirmDestructive === 'boolean') allowed.confirmDestructive = patch.confirmDestructive
        if (typeof patch.autoFetchOnOpen === 'boolean') allowed.autoFetchOnOpen = patch.autoFetchOnOpen
        if (patch.updateChannel === 'stable' || patch.updateChannel === 'beta') allowed.updateChannel = patch.updateChannel
        if (typeof patch.autoUpdateCheck === 'boolean') allowed.autoUpdateCheck = patch.autoUpdateCheck
        if (patch.defaultProvider && PROVIDERS[patch.defaultProvider]) allowed.defaultProvider = patch.defaultProvider
        if (typeof patch.worktreeParent === 'string') {
          const parent = patch.worktreeParent.trim()
          if (parent && !path.isAbsolute(parent)) throw new Error('Default worktree parent must be an absolute path')
          allowed.worktreeParent = parent || undefined
        }
        const updated = await this.store.updateConfig(allowed)
        if (allowed.gitBinary !== undefined) {
          await this.store.setGitBinary(allowed.gitBinary)
        }
        if (allowed.updateChannel !== undefined || allowed.autoUpdateCheck !== undefined) {
          this.updates.refreshPreferences()
        }
        return updated
      }

      case 'identity.list':
        return this.store.listIdentities()
      case 'identity.save':
        return this.store.saveIdentity({
          id: asOptionalString(data.id, 'Identity id'),
          label: asOptionalString(data.label, 'Label') ?? requireString(data.name, 'Name'),
          name: requireString(data.name, 'Name'),
          email: requireString(data.email, 'Email'),
          sshKeyPath: asOptionalString(data.sshKeyPath, 'SSH key'),
          gpgKeyId: asOptionalString(data.gpgKeyId, 'GPG key'),
          gpgSign: Boolean(data.gpgSign),
          isDefault: Boolean(data.isDefault)
        })
      case 'identity.delete': {
        await this.store.deleteIdentity(requireString(data.id, 'Identity id'))
        return undefined
      }
      case 'identity.setDefault':
        return this.store.setDefaultIdentity(requireString(data.id, 'Identity id'))

      case 'integration.list':
        return this.store.listIntegrations()
      case 'integration.save': {
        const provider = requireString(data.provider, 'Provider') as ProviderId
        if (!PROVIDERS[provider]) throw new Error('Unknown provider')
        const baseUrl = requireString(data.baseUrl, 'Base URL')
        try {
          new URL(normalizeBaseUrl(provider, baseUrl))
        } catch {
          throw new Error('Base URL is not a valid URL')
        }
        return this.store.saveIntegration({
          id: asOptionalString(data.id, 'Integration id'),
          provider,
          label: asOptionalString(data.label, 'Label') ?? PROVIDERS[provider].name,
          username: asOptionalString(data.username, 'Username') ?? '',
          baseUrl,
          identityId: asOptionalString(data.identityId, 'Identity id'),
          token: asOptionalString(data.token, 'Token')
        })
      }
      case 'integration.delete': {
        await this.store.deleteIntegration(requireString(data.id, 'Integration id'))
        return undefined
      }
      case 'integration.test':
        return this.providers.test(requireString(data.id, 'Integration id'))

      // ---------------------------------------------------------------------
      // Repositories
      case 'repo.recent':
        return this.store.getConfig().recentRepos
      case 'repo.open': {
        const info = await repoOps.resolveRepo(requireString(data.path, 'Repository path'))
        const standalone = typeof data.standalone === 'boolean' ? data.standalone : false
        await rememberRecentRepo(this.store, info, { standalone })
        return info
      }
      case 'repo.info':
        return repoOps.resolveRepo(requireString(data.path, 'Repository path'))
      case 'repo.removeRecent':
        return this.store.removeRecentRepo(requireString(data.path, 'Repository path'))
      case 'repo.pinRecent':
        return this.store.pinRecentRepo(requireString(data.path, 'Repository path'), Boolean(data.pinned))
      case 'repo.getDefaults':
        return this.store.getRepoDefaults(requireString(data.path, 'Repository path'))
      case 'repo.setDefaults': {
        const repoPath = requireString(data.path, 'Repository path')
        const defaults = (data.defaults ?? {}) as RepoDefaults
        return this.store.setRepoDefaults(repoPath, {
          identityId: defaults.identityId || undefined,
          defaultRemote: defaults.defaultRemote || undefined,
          integrationByProvider: defaults.integrationByProvider ?? {}
        })
      }
      case 'repo.clone':
        return this.cloneRepository(data as unknown as CloneInput)
      case 'repo.init': {
        const directory = path.resolve(requireString(data.directory, 'Directory'))
        const name = asOptionalString(data.name, 'Name') || path.basename(directory)
        const target = asOptionalString(data.name, 'Name') ? path.join(directory, name) : directory
        await fs.mkdir(target, { recursive: true })
        const branch = asOptionalString(data.defaultBranch, 'Default branch') || 'main'
        if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-')) throw new Error('Invalid default branch name')
        const existing = await fs.readdir(target)
        if (existing.length && !(await isGitRepo(target))) {
          throw new Error('Folder is not empty and is not a Git repository')
        }
        if (!(await isGitRepo(target))) {
          await runGit(['init', '-b', branch], { cwd: target })
        }
        const identity = this.store.resolveIdentity(asOptionalString(data.identityId, 'Identity id'))
        if (identity) {
          await runGit(['config', '--local', 'user.name', identity.name], { cwd: target })
          await runGit(['config', '--local', 'user.email', identity.email], { cwd: target })
        }
        const info = await repoOps.resolveRepo(target)
        await rememberRecentRepo(this.store, info)
        return info
      }

      // ---------------------------------------------------------------------
      // Git reads
      case 'git.status':
        return repoOps.getStatus(requireString(data.path, 'Repository path'))
      case 'git.log':
        return repoOps.getLog({
          repoPath: requireString(data.repoPath, 'Repository path'),
          limit: asOptionalNumber(data.limit, 'Limit'),
          skip: asOptionalNumber(data.skip, 'Skip'),
          branch: asOptionalString(data.branch, 'Branch'),
          all: typeof data.all === 'boolean' ? data.all : undefined,
          search: asOptionalString(data.search, 'Search')
        })
      case 'git.commitDetail':
        return repoOps.getCommit(requireString(data.path, 'Repository path'), requireString(data.sha, 'Commit'))
      case 'git.branches':
        return repoOps.getBranches(requireString(data.path, 'Repository path'))
      case 'git.tags':
        return repoOps.getTags(requireString(data.path, 'Repository path'))
      case 'git.remotes': {
        const repo = await repoOps.resolveRepo(requireString(data.path, 'Repository path'))
        return repo.remotes
      }
      case 'git.worktrees':
        return repoOps.getWorktrees(requireString(data.path, 'Repository path'))
      case 'git.worktreeStatuses':
        return repoOps.getWorktreeStatuses(requireString(data.path, 'Repository path'))
      case 'git.stashes':
        return repoOps.getStashes(requireString(data.path, 'Repository path'))
      case 'git.submodules':
        return repoOps.getSubmodules(requireString(data.path, 'Repository path'))
      case 'git.diff':
        return repoOps.getDiff({
          repoPath: requireString(data.repoPath, 'Repository path'),
          path: asOptionalString(data.path, 'File'),
          staged: Boolean(data.staged),
          commit: asOptionalString(data.commit, 'Commit'),
          compare: asOptionalString(data.compare, 'Compare')
        })
      case 'git.resolveConflict': {
        const content = data.content
        if (typeof content !== 'string') throw new Error('Resolved content must be text')
        if (content.length > 10 * 1024 * 1024) throw new Error('Resolved content is too large')
        await repoOps.resolveConflict(
          requireString(data.repoPath, 'Repository path'),
          requireString(data.file, 'File'),
          content
        )
        return undefined
      }
      case 'git.fileTree':
        return repoOps.listTree(
          requireString(data.path, 'Repository path'),
          asOptionalString(data.dir, 'Directory') ?? ''
        )
      case 'git.fileContent':
        return repoOps.readFileContent(
          requireString(data.path, 'Repository path'),
          requireString(data.file, 'File'),
          data.from === 'head' ? 'head' : 'worktree',
          asOptionalString(data.commit, 'Commit')
        )
      case 'git.blame':
        return repoOps.getBlame(
          requireString(data.path, 'Repository path'),
          requireString(data.file, 'File'),
          asOptionalString(data.commit, 'Commit')
        )
      case 'git.config':
        return repoOps.getRepoConfig(requireString(data.path, 'Repository path'))
      case 'git.setConfig':
        await repoOps.setRepoConfig(
          requireString(data.path, 'Repository path'),
          requireString(data.key, 'Key'),
          requireString(data.value, 'Value')
        )
        return undefined

      // ---------------------------------------------------------------------
      // Git writes
      case 'git.stage':
        await repoOps.stageFiles(requireString(data.path, 'Repository path'), requireStringArray(data.files, 'Files'))
        return undefined
      case 'git.unstage':
        await repoOps.unstageFiles(requireString(data.path, 'Repository path'), requireStringArray(data.files, 'Files'))
        return undefined
      case 'git.discard':
        await repoOps.discardFiles(
          requireString(data.path, 'Repository path'),
          requireStringArray(data.files, 'Files'),
          Boolean(data.includeUntracked)
        )
        return undefined
      case 'git.commit': {
        const ctx = await this.repoAuth(requireString(data.repoPath, 'Repository path'), asOptionalString(data.identityId, 'Identity id'))
        return repoOps.commitChanges(
          {
            repoPath: requireString(data.repoPath, 'Repository path'),
            message: requireString(data.message, 'Commit message'),
            amend: Boolean(data.amend),
            signoff: Boolean(data.signoff),
            identityId: asOptionalString(data.identityId, 'Identity id'),
            allowEmpty: Boolean(data.allowEmpty)
          },
          { identity: ctx.identity }
        )
      }
      case 'git.checkout':
        await repoOps.checkoutBranch({
          repoPath: requireString(data.repoPath, 'Repository path'),
          branch: requireString(data.branch, 'Branch'),
          create: Boolean(data.create),
          startPoint: asOptionalString(data.startPoint, 'Start point'),
          track: Boolean(data.track),
          force: Boolean(data.force)
        })
        return undefined
      case 'git.createBranch':
        await repoOps.createBranch(
          requireString(data.path, 'Repository path'),
          requireString(data.name, 'Branch name'),
          asOptionalString(data.startPoint, 'Start point'),
          Boolean(data.checkout),
          Boolean(data.track)
        )
        return undefined
      case 'git.renameBranch':
        await repoOps.renameBranch(
          requireString(data.path, 'Repository path'),
          requireString(data.from, 'Current branch'),
          requireString(data.to, 'New branch name')
        )
        return undefined
      case 'git.deleteBranch': {
        const repoPath = requireString(data.path, 'Repository path')
        const name = requireString(data.name, 'Branch name')
        const remote = asOptionalString(data.remote, 'Remote')
        if (remote) {
          const ctx = await this.repoAuth(repoPath, asOptionalString(data.identityId, 'Identity id'), asOptionalString(data.accountId, 'Account id'), remote)
          await repoOps.deleteRemoteBranch(repoPath, name, remote, {
            identity: ctx.identity,
            account: ctx.account,
            token: ctx.token
          })
        } else {
          await repoOps.deleteBranch(repoPath, name, Boolean(data.force))
        }
        return undefined
      }
      case 'git.setUpstream':
        await repoOps.setUpstream(
          requireString(data.path, 'Repository path'),
          requireString(data.branch, 'Branch'),
          requireString(data.upstream, 'Upstream')
        )
        return undefined
      case 'git.merge': {
        const ctx = await this.repoAuth(requireString(data.repoPath, 'Repository path'), asOptionalString(data.identityId, 'Identity id'))
        return repoOps.mergeBranch(
          {
            repoPath: requireString(data.repoPath, 'Repository path'),
            branch: requireString(data.branch, 'Branch'),
            noFf: Boolean(data.noFf),
            ffOnly: Boolean(data.ffOnly),
            squash: Boolean(data.squash),
            message: asOptionalString(data.message, 'Message'),
            identityId: asOptionalString(data.identityId, 'Identity id')
          },
          { identity: ctx.identity }
        )
      }
      case 'git.rebase': {
        const ctx = await this.repoAuth(requireString(data.path, 'Repository path'), asOptionalString(data.identityId, 'Identity id'))
        return repoOps.rebaseBranch(
          requireString(data.path, 'Repository path'),
          requireString(data.onto, 'Branch'),
          { identity: ctx.identity }
        )
      }
      case 'git.rebasePlan':
        return rebaseOps.getRebasePlan(
          requireString(data.repoPath, 'Repository path'),
          requireString(data.onto, 'Rebase base')
        )
      case 'git.rebaseInteractive': {
        const repoPath = requireString(data.repoPath, 'Repository path')
        const ctx = await this.repoAuth(repoPath, asOptionalString(data.identityId, 'Identity id'))
        return rebaseOps.rebaseInteractive(
          {
            repoPath,
            onto: requireString(data.onto, 'Rebase base'),
            items: parseRebaseTodoItems(data.items),
            identityId: asOptionalString(data.identityId, 'Identity id')
          },
          { identity: ctx.identity }
        )
      }
      case 'git.cherryPick': {
        const ctx = await this.repoAuth(requireString(data.path, 'Repository path'), asOptionalString(data.identityId, 'Identity id'))
        return repoOps.cherryPick(
          requireString(data.path, 'Repository path'),
          requireString(data.sha, 'Commit'),
          { identity: ctx.identity }
        )
      }
      case 'git.revert': {
        const ctx = await this.repoAuth(requireString(data.path, 'Repository path'), asOptionalString(data.identityId, 'Identity id'))
        return repoOps.revertCommit(
          requireString(data.path, 'Repository path'),
          requireString(data.sha, 'Commit'),
          { identity: ctx.identity }
        )
      }
      case 'git.reset':
        await repoOps.resetTo(
          requireString(data.repoPath, 'Repository path'),
          requireString(data.commit, 'Commit'),
          data.mode === 'soft' || data.mode === 'mixed' || data.mode === 'hard' ? data.mode : 'mixed'
        )
        return undefined
      case 'git.abortOperation': {
        const repoPath = requireString(data.path, 'Repository path')
        await repoOps.abortOperation(repoPath)
        await rebaseOps.cleanupRebaseSession(repoPath)
        return undefined
      }
      case 'git.continueOperation': {
        const repoPath = requireString(data.path, 'Repository path')
        const ctx = await this.repoAuth(repoPath, asOptionalString(data.identityId, 'Identity id'))
        const editorEnv = await rebaseOps.rebaseEditorEnv(repoPath)
        const result = await repoOps.continueOperation(repoPath, { identity: ctx.identity }, editorEnv)
        await rebaseOps.cleanupRebaseSessionIfIdle(repoPath)
        return result
      }
      case 'git.skipOperation': {
        const repoPath = requireString(data.path, 'Repository path')
        const editorEnv = await rebaseOps.rebaseEditorEnv(repoPath)
        await repoOps.skipOperation(repoPath, editorEnv)
        await rebaseOps.cleanupRebaseSessionIfIdle(repoPath)
        return undefined
      }

      case 'git.tagCreate': {
        const repoPath = requireString(data.repoPath, 'Repository path')
        const remote = asOptionalString(data.remote, 'Remote')
        const ctx = await this.repoAuth(repoPath, asOptionalString(data.identityId, 'Identity id'), undefined, remote)
        await repoOps.createTag(
          {
            repoPath,
            name: requireString(data.name, 'Tag name'),
            message: asOptionalString(data.message, 'Message'),
            commit: asOptionalString(data.commit, 'Commit'),
            push: Boolean(data.push),
            remote,
            identityId: asOptionalString(data.identityId, 'Identity id')
          },
          { identity: ctx.identity, account: ctx.account, token: ctx.token }
        )
        return undefined
      }
      case 'git.tagPush': {
        const repoPath = requireString(data.path, 'Repository path')
        const remote = requireString(data.remote, 'Remote')
        const ctx = await this.repoAuth(repoPath, asOptionalString(data.identityId, 'Identity id'), asOptionalString(data.accountId, 'Account id'), remote)
        const { args, env } = await this.remoteContext(ctx, remote)
        await runGit([...args, 'push', remote, requireString(data.name, 'Tag name')], { cwd: ctx.repo.path, env })
        return undefined
      }
      case 'git.tagDelete': {
        const repoPath = requireString(data.path, 'Repository path')
        const remote = asOptionalString(data.remote, 'Remote')
        const ctx = remote ? await this.repoAuth(repoPath, undefined, undefined, remote) : null
        await repoOps.deleteTag(repoPath, requireString(data.name, 'Tag name'), remote, ctx ? { identity: ctx.identity, account: ctx.account, token: ctx.token } : undefined)
        return undefined
      }
      case 'git.worktreeAdd': {
        const result = await repoOps.addWorktree({
          repoPath: requireString(data.repoPath, 'Repository path'),
          path: requireString(data.path, 'Worktree path'),
          branch: requireString(data.branch, 'Branch'),
          createBranch: Boolean(data.createBranch),
          startPoint: asOptionalString(data.startPoint, 'Start point'),
          detach: Boolean(data.detach)
        })
        return result
      }
      case 'git.worktreeRemove':
        await repoOps.removeWorktree(
          requireString(data.path, 'Repository path'),
          requireString(data.worktreePath, 'Worktree path'),
          Boolean(data.force)
        )
        return undefined
      case 'git.worktreePrune':
        await repoOps.pruneWorktrees(requireString(data.path, 'Repository path'))
        return undefined
      case 'git.worktreeLock':
        await repoOps.lockWorktree(
          requireString(data.path, 'Repository path'),
          requireString(data.worktreePath, 'Worktree path'),
          asOptionalString(data.reason, 'Reason')
        )
        return undefined
      case 'git.worktreeUnlock':
        await repoOps.unlockWorktree(
          requireString(data.path, 'Repository path'),
          requireString(data.worktreePath, 'Worktree path')
        )
        return undefined
      case 'git.stashPush': {
        const ctx = await this.repoAuth(requireString(data.path, 'Repository path'), asOptionalString(data.identityId, 'Identity id'))
        await repoOps.stashPush(
          requireString(data.path, 'Repository path'),
          asOptionalString(data.message, 'Message'),
          Boolean(data.includeUntracked),
          { identity: ctx.identity }
        )
        return undefined
      }
      case 'git.stashApply':
        await repoOps.stashApply(
          requireString(data.path, 'Repository path'),
          requireNumber(data.index, 'Stash index'),
          false
        )
        return undefined
      case 'git.stashPop':
        await repoOps.stashApply(
          requireString(data.path, 'Repository path'),
          requireNumber(data.index, 'Stash index'),
          true
        )
        return undefined
      case 'git.stashDrop':
        await repoOps.stashDrop(
          requireString(data.path, 'Repository path'),
          requireNumber(data.index, 'Stash index')
        )
        return undefined
      case 'git.submoduleAdd': {
        const repoPath = requireString(data.repoPath, 'Repository path')
        const url = requireString(data.url, 'Submodule URL')
        // Credentials follow the *submodule* URL, never the parent remote.
        const auth = await this.submoduleAuth(repoPath, url, asOptionalString(data.accountId, 'Account id'))
        const token = auth.account ? await this.store.getToken(auth.account.id) : null
        const identity = this.store.resolveIdentity(this.store.getRepoDefaults(repoPath).identityId)
        await repoOps.addSubmodule(
          {
            repoPath,
            url,
            path: asOptionalString(data.path, 'Submodule path'),
            branch: asOptionalString(data.branch, 'Branch'),
            force: Boolean(data.force),
            accountId: asOptionalString(data.accountId, 'Account id')
          },
          { identity, account: auth.account, token, authOrigin: auth.origin }
        )
        return undefined
      }
      case 'git.submoduleUpdate': {
        const repoPath = requireString(data.repoPath, 'Repository path')
        const identity = this.store.resolveIdentity(this.store.getRepoDefaults(repoPath).identityId)
        return repoOps.updateSubmodules(
          {
            repoPath,
            submodulePath: asOptionalString(data.submodulePath, 'Submodule path'),
            init: Boolean(data.init),
            recursive: Boolean(data.recursive),
            remote: Boolean(data.remote),
            force: Boolean(data.force),
            clean: Boolean(data.clean)
          },
          identity
        )
      }
      case 'git.submoduleSync':
        await repoOps.syncSubmodules(
          requireString(data.repoPath, 'Repository path'),
          asOptionalString(data.submodulePath, 'Submodule path'),
          Boolean(data.recursive)
        )
        return undefined
      case 'git.submoduleRemove':
        await repoOps.removeSubmodule(
          requireString(data.repoPath, 'Repository path'),
          requireString(data.submodulePath, 'Submodule path'),
          Boolean(data.force)
        )
        return undefined
      case 'git.remoteAdd':
        await repoOps.addRemote(
          requireString(data.path, 'Repository path'),
          requireString(data.name, 'Remote name'),
          requireString(data.url, 'Remote URL')
        )
        return undefined
      case 'git.remoteRemove':
        await repoOps.removeRemote(requireString(data.path, 'Repository path'), requireString(data.name, 'Remote name'))
        return undefined
      case 'git.remoteSetUrl':
        await repoOps.setRemoteUrl(
          requireString(data.path, 'Repository path'),
          requireString(data.name, 'Remote name'),
          requireString(data.url, 'Remote URL'),
          Boolean(data.push)
        )
        return undefined

      // ---------------------------------------------------------------------
      // Tasks
      case 'git.fetch':
        return this.fetchRepository(data)
      case 'git.pull':
        return this.pullRepository(data)
      case 'git.push':
        return this.pushRepository(data)
      case 'git.console':
        return this.runConsole(data)

      // ---------------------------------------------------------------------
      // Providers
      case 'provider.detect':
        return this.providers.detect(requireString(data.path, 'Repository path'))
      case 'provider.connections':
        return this.providers.connections()
      case 'provider.repos':
        return this.providers.listRepos(requireString(data.accountId, 'Integration id'), asOptionalString(data.search, 'Search'))
      case 'provider.pullRequests':
        return this.providers.listPullRequests(
          requireString(data.accountId, 'Integration id'),
          requireString(data.owner, 'Owner'),
          requireString(data.repo, 'Repository'),
          data.state === 'closed' || data.state === 'all' ? data.state : 'open'
        )
      case 'provider.createPullRequest': {
        const input = (data.input ?? {}) as Record<string, unknown>
        return this.providers.createPullRequest(
          requireString(data.accountId, 'Integration id'),
          requireString(data.owner, 'Owner'),
          requireString(data.repo, 'Repository'),
          {
            title: requireString(input.title, 'Title'),
            sourceBranch: requireString(input.sourceBranch, 'Source branch'),
            targetBranch: requireString(input.targetBranch, 'Target branch'),
            body: asOptionalString(input.body, 'Body'),
            draft: Boolean(input.draft)
          }
        )
      }
      case 'provider.checkoutPullRequest':
        return this.providers.checkoutPullRequest(
          requireString(data.path, 'Repository path'),
          requireString(data.accountId, 'Integration id'),
          requireString(data.owner, 'Owner'),
          requireString(data.repo, 'Repository'),
          requireNumber(data.number, 'Pull request number'),
          asOptionalString(data.branchName, 'Branch name'),
          asOptionalString(data.identityId, 'Identity id')
        )
      case 'provider.releases':
        return this.providers.listReleases(
          requireString(data.accountId, 'Integration id'),
          requireString(data.owner, 'Owner'),
          requireString(data.repo, 'Repository')
        )
      case 'provider.createRelease': {
        const input = (data.input ?? {}) as Record<string, unknown>
        return this.providers.createRelease(
          requireString(data.accountId, 'Integration id'),
          requireString(data.owner, 'Owner'),
          requireString(data.repo, 'Repository'),
          {
            tagName: requireString(input.tagName, 'Tag name'),
            name: requireString(input.name, 'Release name'),
            body: asOptionalString(input.body, 'Body'),
            target: asOptionalString(input.target, 'Target'),
            draft: Boolean(input.draft),
            prerelease: Boolean(input.prerelease)
          }
        )
      }
      case 'provider.deleteRelease':
        await this.providers.deleteRelease(
          requireString(data.accountId, 'Integration id'),
          requireString(data.owner, 'Owner'),
          requireString(data.repo, 'Repository'),
          requireString(data.id, 'Release id')
        )
        return undefined
      case 'provider.workflows':
        return this.providers.listWorkflows(
          requireString(data.accountId, 'Integration id'),
          requireString(data.owner, 'Owner'),
          requireString(data.repo, 'Repository')
        )
      case 'provider.runs':
        return this.providers.listRuns(
          requireString(data.accountId, 'Integration id'),
          requireString(data.owner, 'Owner'),
          requireString(data.repo, 'Repository'),
          asOptionalString(data.workflowId, 'Workflow id')
        )
      case 'provider.triggerAction':
        await this.providers.triggerAction(
          requireString(data.accountId, 'Integration id'),
          requireString(data.owner, 'Owner'),
          requireString(data.repo, 'Repository'),
          asOptionalString(data.workflowId, 'Workflow id'),
          requireString(data.ref, 'Ref'),
          (data.inputs && typeof data.inputs === 'object' ? data.inputs : undefined) as Record<string, string> | undefined
        )
        return undefined

      // ---------------------------------------------------------------------
      // Window
      case 'window.minimize': {
        this.getWindow()?.minimize()
        return undefined
      }
      case 'window.maximizeToggle': {
        const window = this.getWindow()
        if (!window) return false
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
        return window.isMaximized()
      }
      case 'window.close': {
        this.getWindow()?.close()
        return undefined
      }
      case 'window.isMaximized':
        return this.getWindow()?.isMaximized() ?? false

      // ---------------------------------------------------------------------
      // Updates
      case 'update.status':
        return this.updates.getStatus()
      case 'update.check':
        return this.updates.check()
      case 'update.download':
        return this.updates.download()
      case 'update.install': {
        this.updates.install()
        return undefined
      }

      default: {
        const exhaustive: never = channel
        throw new Error(`Unsupported channel: ${String(exhaustive)}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Task helpers

  private async cloneRepository(input: CloneInput) {
    const url = requireString(input.url, 'Repository URL').trim()
    const parent = path.resolve(requireString(input.directory, 'Directory'))
    if (!/^(https?:\/\/|ssh:\/\/|git@|git:\/\/)/.test(url) && !path.isAbsolute(url)) {
      throw new Error('Enter a valid Git URL (https://, ssh:// or git@host:owner/repo)')
    }
    const detected = detectProviderFromUrl(url)
    const provider = detected?.provider ?? (detected?.host ? providerFromHost(detected.host, this.store.listIntegrations()) : undefined)
    let account = input.accountId ? this.store.integrationById(input.accountId) : undefined
    if (!account && detected?.host) account = this.store.resolveAccount(parent, provider, detected.host)
    const token = account ? await this.store.getToken(account.id) : null
    const auth = buildAuthArgs(account ?? null, token)

    const repoName = (input.name?.trim() || detected?.repo || path.basename(url).replace(/\.git$/, '')).replace(/[\\/:*?"<>|]/g, '-')
    if (!repoName) throw new Error('Could not determine a folder name; provide one explicitly')
    const target = path.join(parent, repoName)
    await fs.mkdir(parent, { recursive: true })
    try {
      const entries = await fs.readdir(target)
      if (entries.length) throw new Error(`Target folder is not empty: ${target}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const args = [...auth.args, 'clone', '--progress']
    if (input.bare) args.push('--bare')
    if (input.depth && input.depth > 0) args.push('--depth', String(Math.round(input.depth)))
    args.push(url, target)

    return this.tasks.start({
      kind: 'clone',
      title: `Cloning ${repoName}`,
      args,
      cwd: parent,
      repoPath: target,
      env: auth.env,
      secrets: [token],
      onExit: async (code) => {
        if (code !== 0) return
        try {
          const info = await repoOps.resolveRepo(target)
          await rememberRecentRepo(this.store, info)
          if (input.identityId) {
            await this.store.setRepoDefaults(info.path, {
              identityId: input.identityId,
              integrationByProvider: account ? { [account.provider]: account.id } : {}
            })
          } else if (account) {
            await this.store.setRepoDefaults(info.path, {
              integrationByProvider: { [account.provider]: account.id }
            })
          }
        } catch {
          // Clone succeeded; repo discovery is best-effort here.
        }
      }
    })
  }

  private async fetchRepository(raw: unknown) {
    const data = raw as Record<string, unknown>
    const repoPath = requireString(data.repoPath, 'Repository path')
    const remoteName = asOptionalString(data.remote, 'Remote')
    const ctx = await this.repoAuth(repoPath, undefined, asOptionalString(data.accountId, 'Account id'), remoteName)
    const { args, env } = await this.remoteContext(ctx, remoteName)
    const remote = remoteName || this.defaultRemote(ctx.repo)
    const fetchArgs = [...args, 'fetch', '--progress']
    if (data.prune) fetchArgs.push('--prune')
    if (remote) fetchArgs.push(remote)
    else fetchArgs.push('--all')
    return this.tasks.start({
      kind: 'fetch',
      title: remote ? `Fetching ${remote}` : 'Fetching all remotes',
      args: fetchArgs,
      cwd: ctx.repo.path,
      repoPath: ctx.repo.path,
      env,
      secrets: [ctx.token]
    })
  }

  private async pullRepository(raw: unknown) {
    const data = raw as Record<string, unknown>
    const repoPath = requireString(data.repoPath, 'Repository path')
    const remoteName = asOptionalString(data.remote, 'Remote')
    const ctx = await this.repoAuth(repoPath, asOptionalString(data.identityId, 'Identity id'), asOptionalString(data.accountId, 'Account id'), remoteName)
    const { args, env } = await this.remoteContext(ctx, remoteName)
    const pullArgs = [...args, 'pull', '--progress']
    if (data.rebase) pullArgs.push('--rebase')
    const remote = remoteName || this.defaultRemote(ctx.repo)
    if (remote) pullArgs.push(remote)
    const branch = asOptionalString(data.branch, 'Branch')
    if (branch) pullArgs.push(branch)
    return this.tasks.start({
      kind: 'pull',
      title: remote ? `Pulling from ${remote}` : 'Pulling',
      args: pullArgs,
      cwd: ctx.repo.path,
      repoPath: ctx.repo.path,
      env,
      secrets: [ctx.token]
    })
  }

  private async pushRepository(raw: unknown) {
    const data = raw as Record<string, unknown>
    const repoPath = requireString(data.repoPath, 'Repository path')
    const remoteName = asOptionalString(data.remote, 'Remote')
    const ctx = await this.repoAuth(repoPath, asOptionalString(data.identityId, 'Identity id'), asOptionalString(data.accountId, 'Account id'), remoteName)
    const { args, env } = await this.remoteContext(ctx, remoteName)
    const remote = remoteName || this.defaultRemote(ctx.repo)
    if (!remote) throw new Error('This repository has no remote configured')
    const branch = asOptionalString(data.branch, 'Branch') || ctx.repo.currentBranch
    if (!branch) throw new Error('Cannot push from a detached HEAD; check out a branch first')
    const pushArgs = [...args, 'push', '--progress']
    if (data.setUpstream) pushArgs.push('--set-upstream')
    if (data.force === 'with-lease') pushArgs.push('--force-with-lease')
    else if (data.force === 'force') pushArgs.push('--force')
    pushArgs.push(remote, branch)
    return this.tasks.start({
      kind: 'push',
      title: `Pushing ${branch} to ${remote}`,
      args: pushArgs,
      cwd: ctx.repo.path,
      repoPath: ctx.repo.path,
      env,
      secrets: [ctx.token]
    })
  }

  private async runConsole(raw: unknown) {
    const data = raw as Record<string, unknown>
    const repoPath = requireString(data.repoPath, 'Repository path')
    const command = requireString(data.command, 'Command')
    const rest = validateConsoleCommand(command)
    const ctx = await this.repoAuth(repoPath, asOptionalString(data.identityId, 'Identity id'), asOptionalString(data.accountId, 'Account id'))
    const ident = buildIdentityEnv(ctx.identity)
    const auth = buildAuthArgs(ctx.account ?? null, ctx.token)
    return this.tasks.start({
      kind: 'console',
      title: `git ${rest.join(' ')}`,
      args: [...ident.args, ...auth.args, ...rest],
      cwd: ctx.repo.path,
      repoPath: ctx.repo.path,
      env: { ...ident.env, ...auth.env },
      secrets: [ctx.token]
    })
  }

  // -------------------------------------------------------------------------
  // Auth helpers

  private async submoduleAuth(
    repoPath: string,
    url: string,
    explicitId?: string
  ): Promise<{ account?: IntegrationAccount; origin?: string }> {
    const target = await this.submoduleTarget(repoPath, url)
    if (explicitId) {
      const explicit = this.store.integrationById(explicitId)
      if (!explicit) throw new Error('Unknown integration account')
      if (!target?.host) throw new Error('An integration account needs a submodule URL with a host')
      if (!accountMatchesHost(explicit, target.host)) {
        throw new Error(`Integration account does not match the submodule host ${target.host}`)
      }
      return { account: explicit, origin: target.origin }
    }
    if (!target?.host) return {}
    const host = target.host

    const preferred = target.provider
      ? this.store.getRepoDefaults(repoPath).integrationByProvider[target.provider]
      : undefined
    const candidates = this.store
      .listIntegrations()
      .filter(
        (account) =>
          (!target.provider || account.provider === target.provider) && accountMatchesHost(account, host)
      )
    return {
      account: candidates.find((account) => account.id === preferred) ?? candidates[0],
      origin: target.origin
    }
  }

  /** Resolve the host a submodule URL will contact, including relative URLs. */
  private async submoduleTarget(
    repoPath: string,
    url: string
  ): Promise<{ host: string; provider?: ProviderId; origin?: string } | null> {
    const direct = detectProviderFromUrl(url)
    if (direct?.host) return { host: direct.host, provider: direct.provider, origin: this.originOf(url) }
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

    const detected = detectProviderFromUrl(remote.fetchUrl) ?? detectProviderFromUrl(remote.pushUrl)
    if (!detected?.host) return null
    return { host: detected.host, provider: detected.provider, origin: this.originOf(remote.fetchUrl) }
  }

  private originOf(url: string): string | undefined {
    const raw = url.trim()
    if (!/^https?:\/\//i.test(raw)) return undefined
    try {
      const parsed = new URL(raw)
      return `${parsed.protocol}//${parsed.host.toLowerCase()}`
    } catch {
      return undefined
    }
  }

  private async repoAuth(repoPath: string, identityId?: string, accountId?: string, remoteName?: string) {
    const repo = await repoOps.resolveRepo(repoPath)
    const identity = this.store.resolveIdentity(identityId)
    let account = accountId ? this.store.integrationById(accountId) : undefined
    if (!account) {
      const preferred = remoteName || this.defaultRemote(repo)
      const remote = (preferred ? repo.remotes.find((item) => item.name === preferred) : undefined) ?? repo.remotes[0]
      if (remote) {
        const parsed = detectProviderFromUrl(remote.fetchUrl)
        const provider = remote.provider ?? parsed?.provider ?? providerFromHost(parsed?.host, this.store.listIntegrations())
        account = this.store.resolveAccount(repo.path, provider, parsed?.host)
      }
    }
    const token = account ? await this.store.getToken(account.id) : null
    return { repo, identity, account, token }
  }

  private defaultRemote(repo: RepoInfo): string | undefined {
    return this.store.getRepoDefaults(repo.path).defaultRemote || repo.remotes[0]?.name
  }

  private async remoteContext(
    ctx: { repo: RepoInfo; identity?: GitIdentity | null; account?: IntegrationAccount | null; token: string | null },
    remoteName?: string
  ): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
    void remoteName
    const ident = buildIdentityEnv(ctx.identity)
    const auth = buildAuthArgs(ctx.account ?? null, ctx.token)
    return { args: [...ident.args, ...auth.args], env: { ...ident.env, ...auth.env } }
  }
}

// ---------------------------------------------------------------------------
// Validation helpers

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value
}

function asOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  return value
}

function asOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a number`)
  return value
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a number`)
  return value
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} is required`)
  return value.map((item) => {
    if (typeof item !== 'string' || !item) throw new Error(`${label} must be a list of paths`)
    return item
  })
}

async function isGitRepo(target: string): Promise<boolean> {
  try {
    const result = await runGit(['rev-parse', '--git-dir'], { cwd: target, allowFailure: true })
    return result.exitCode === 0
  } catch {
    return false
  }
}
