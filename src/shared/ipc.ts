import type {
  ActionRun,
  ActionWorkflow,
  AppConfig,
  AppInfo,
  BlameLine,
  CheckoutInput,
  CloneInput,
  Commit,
  CommitInput,
  ConsoleInput,
  CreatePullRequestInput,
  CreateReleaseInput,
  DiffInput,
  DiffResult,
  DirEntry,
  FetchInput,
  FileContent,
  GitBinaryInfo,
  InitInput,
  IntegrationAccount,
  IntegrationInput,
  IntegrationTestResult,
  LogInput,
  MergeInput,
  ProviderConnection,
  ProviderDetection,
  ProviderRepo,
  PullRequest,
  PushInput,
  PullInput,
  RecentRepo,
  RefInfo,
  Release,
  RepoConfigEntry,
  RepoDefaults,
  RepoInfo,
  RebasePlan,
  RebasePlanInput,
  RebaseResult,
  RepoStatus,
  ResetInput,
  ResolveConflictInput,
  StashInfo,
  StatusFile,
  TagCreateInput,
  TagInfo,
  TaskEvent,
  TaskHandle,
  TriggerActionInput,
  WorktreeAddInput,
  WorktreeInfo,
  IdentityInput,
  GitIdentity
} from './types'

export interface IpcMethods {
  'app.info': { request: void; response: AppInfo }
  'app.launchTarget': { request: void; response: string | null }
  'app.checkGit': { request: { path?: string } | void; response: GitBinaryInfo }
  'app.openExternal': { request: { url: string }; response: void }
  'app.openPath': { request: { path: string }; response: { ok: boolean; error?: string } }
  'app.showItemInFolder': { request: { path: string }; response: void }
  'app.pickDirectory': { request: { title?: string; defaultPath?: string } | void; response: string | null }
  'app.pickFile': { request: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] } | void; response: string | null }
  'app.openConfigFolder': { request: void; response: void }

  'config.get': { request: void; response: AppConfig }
  'config.update': { request: { patch: Partial<AppConfig> }; response: AppConfig }

  'identity.list': { request: void; response: GitIdentity[] }
  'identity.save': { request: IdentityInput; response: GitIdentity }
  'identity.delete': { request: { id: string }; response: void }
  'identity.setDefault': { request: { id: string }; response: AppConfig }

  'integration.list': { request: void; response: IntegrationAccount[] }
  'integration.save': { request: IntegrationInput; response: IntegrationAccount }
  'integration.delete': { request: { id: string }; response: void }
  'integration.test': { request: { id: string }; response: IntegrationTestResult }

  'repo.recent': { request: void; response: RecentRepo[] }
  'repo.open': { request: { path: string }; response: RepoInfo }
  'repo.info': { request: { path: string }; response: RepoInfo }
  'repo.removeRecent': { request: { path: string }; response: RecentRepo[] }
  'repo.pinRecent': { request: { path: string; pinned: boolean }; response: RecentRepo[] }
  'repo.getDefaults': { request: { path: string }; response: RepoDefaults }
  'repo.setDefaults': { request: { path: string; defaults: RepoDefaults }; response: RepoDefaults }
  'repo.clone': { request: CloneInput; response: TaskHandle }
  'repo.init': { request: InitInput; response: RepoInfo }

  'git.status': { request: { path: string }; response: RepoStatus }
  'git.log': { request: LogInput; response: Commit[] }
  'git.commitDetail': { request: { path: string; sha: string }; response: Commit }
  'git.branches': { request: { path: string }; response: RefInfo[] }
  'git.tags': { request: { path: string }; response: TagInfo[] }
  'git.remotes': { request: { path: string }; response: RepoInfo['remotes'] }
  'git.worktrees': { request: { path: string }; response: WorktreeInfo[] }
  'git.stashes': { request: { path: string }; response: StashInfo[] }
  'git.diff': { request: DiffInput; response: DiffResult }
  'git.resolveConflict': { request: ResolveConflictInput; response: void }
  'git.fileTree': { request: { path: string; dir?: string }; response: DirEntry[] }
  'git.fileContent': { request: { path: string; file: string; from?: 'worktree' | 'head'; commit?: string }; response: FileContent }
  'git.blame': { request: { path: string; file: string; commit?: string }; response: BlameLine[] }
  'git.config': { request: { path: string }; response: RepoConfigEntry[] }
  'git.setConfig': { request: { path: string; key: string; value: string }; response: void }

  'git.stage': { request: { path: string; files: string[] }; response: void }
  'git.unstage': { request: { path: string; files: string[] }; response: void }
  'git.discard': { request: { path: string; files: string[]; includeUntracked: boolean }; response: void }
  'git.commit': { request: CommitInput; response: { sha: string } }
  'git.checkout': { request: CheckoutInput; response: void }
  'git.createBranch': { request: { path: string; name: string; startPoint?: string; checkout?: boolean; track?: boolean }; response: void }
  'git.renameBranch': { request: { path: string; from: string; to: string }; response: void }
  'git.deleteBranch': { request: { path: string; name: string; force?: boolean; remote?: string; identityId?: string; accountId?: string }; response: void }
  'git.setUpstream': { request: { path: string; branch: string; upstream: string }; response: void }
  'git.merge': { request: MergeInput; response: { output: string } }
  'git.rebase': { request: { path: string; onto: string; identityId?: string }; response: { output: string } }
  'git.rebasePlan': { request: { repoPath: string; onto: string }; response: RebasePlan }
  'git.rebaseInteractive': { request: RebasePlanInput; response: RebaseResult }
  'git.cherryPick': { request: { path: string; sha: string; identityId?: string }; response: { output: string } }
  'git.revert': { request: { path: string; sha: string; identityId?: string }; response: { output: string } }
  'git.reset': { request: ResetInput; response: void }
  'git.abortOperation': { request: { path: string }; response: void }
  'git.continueOperation': { request: { path: string; identityId?: string }; response: { output: string } }
  'git.skipOperation': { request: { path: string }; response: void }

  'git.tagCreate': { request: TagCreateInput; response: void }
  'git.tagPush': { request: { path: string; name: string; remote: string; identityId?: string; accountId?: string }; response: void }
  'git.tagDelete': { request: { path: string; name: string; remote?: string }; response: void }
  'git.worktreeAdd': { request: WorktreeAddInput; response: { path: string } }
  'git.worktreeRemove': { request: { path: string; worktreePath: string; force?: boolean }; response: void }
  'git.worktreePrune': { request: { path: string }; response: void }
  'git.worktreeLock': { request: { path: string; worktreePath: string; reason?: string }; response: void }
  'git.worktreeUnlock': { request: { path: string; worktreePath: string }; response: void }
  'git.stashPush': { request: { path: string; message?: string; includeUntracked?: boolean; identityId?: string }; response: void }
  'git.stashApply': { request: { path: string; index: number }; response: void }
  'git.stashPop': { request: { path: string; index: number }; response: void }
  'git.stashDrop': { request: { path: string; index: number }; response: void }
  'git.remoteAdd': { request: { path: string; name: string; url: string }; response: void }
  'git.remoteRemove': { request: { path: string; name: string }; response: void }
  'git.remoteSetUrl': { request: { path: string; name: string; url: string; push?: boolean }; response: void }

  'git.fetch': { request: FetchInput; response: TaskHandle }
  'git.pull': { request: PullInput; response: TaskHandle }
  'git.push': { request: PushInput; response: TaskHandle }
  'git.console': { request: ConsoleInput; response: TaskHandle }

  'provider.detect': { request: { path: string }; response: ProviderDetection }
  'provider.connections': { request: void; response: ProviderConnection[] }
  'provider.repos': { request: { accountId: string; search?: string }; response: ProviderRepo[] }
  'provider.pullRequests': { request: { accountId: string; owner: string; repo: string; state?: 'open' | 'closed' | 'all' }; response: PullRequest[] }
  'provider.createPullRequest': { request: { accountId: string; owner: string; repo: string; input: CreatePullRequestInput }; response: PullRequest }
  'provider.checkoutPullRequest': { request: { path: string; accountId: string; owner: string; repo: string; number: number; branchName?: string; identityId?: string }; response: { branch: string } }
  'provider.releases': { request: { accountId: string; owner: string; repo: string }; response: Release[] }
  'provider.createRelease': { request: { accountId: string; owner: string; repo: string; input: CreateReleaseInput }; response: Release }
  'provider.deleteRelease': { request: { accountId: string; owner: string; repo: string; id: string }; response: void }
  'provider.workflows': { request: { accountId: string; owner: string; repo: string }; response: ActionWorkflow[] }
  'provider.runs': { request: { accountId: string; owner: string; repo: string; workflowId?: string }; response: ActionRun[] }
  'provider.triggerAction': { request: TriggerActionInput; response: void }

  'window.minimize': { request: void; response: void }
  'window.maximizeToggle': { request: void; response: boolean }
  'window.close': { request: void; response: void }
  'window.isMaximized': { request: void; response: boolean }
}

export type IpcChannel = keyof IpcMethods
export type IpcRequest<K extends IpcChannel> = IpcMethods[K]['request']
export type IpcResponse<K extends IpcChannel> = IpcMethods[K]['response']

export interface TaskEventEnvelope {
  event: TaskEvent
}

export interface WindowStateEvent {
  maximized: boolean
}

export const IPC_INVOKE = 'gitgrove:invoke' as const
export const IPC_TASK_EVENT = 'gitgrove:task-event' as const
export const IPC_WINDOW_STATE = 'gitgrove:window-state' as const
export const IPC_MENU = 'gitgrove:menu' as const

export interface IpcEnvelope<K extends IpcChannel = IpcChannel> {
  channel: K
  payload: IpcRequest<K>
}

export interface IpcResult<T = unknown> {
  ok: boolean
  value?: T
  error?: string
  code?: string
}

export type { StatusFile }
