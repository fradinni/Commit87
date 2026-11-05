export type ProviderId = 'github' | 'gitlab' | 'bitbucket' | 'gitea'

export interface ProviderMeta {
  id: ProviderId
  name: string
  defaultBaseUrl: string
  tokenHint: string
  tokenUrl: string
  supports: {
    pullRequests: boolean
    releases: boolean
    actions: boolean
    actionsDispatch: boolean
    issues: boolean
  }
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  github: {
    id: 'github',
    name: 'GitHub',
    defaultBaseUrl: 'https://api.github.com',
    tokenHint: 'Personal access token with repo + workflow scopes',
    tokenUrl: 'https://github.com/settings/tokens',
    supports: { pullRequests: true, releases: true, actions: true, actionsDispatch: true, issues: true }
  },
  gitlab: {
    id: 'gitlab',
    name: 'GitLab',
    defaultBaseUrl: 'https://gitlab.com',
    tokenHint: 'Personal access token with api scope',
    tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    supports: { pullRequests: true, releases: true, actions: true, actionsDispatch: true, issues: true }
  },
  bitbucket: {
    id: 'bitbucket',
    name: 'Bitbucket',
    defaultBaseUrl: 'https://api.bitbucket.org/2.0',
    tokenHint: 'Atlassian API token or repository access token',
    tokenUrl: 'https://bitbucket.org/account/settings/app-passwords/',
    supports: { pullRequests: true, releases: false, actions: true, actionsDispatch: true, issues: false }
  },
  gitea: {
    id: 'gitea',
    name: 'Gitea / Forgejo',
    defaultBaseUrl: 'https://gitea.com',
    tokenHint: 'Access token with repository and action scopes',
    tokenUrl: 'https://docs.gitea.com/development/api-usage#generating-and-listing-api-tokens',
    supports: { pullRequests: true, releases: true, actions: true, actionsDispatch: true, issues: true }
  }
}

export interface GitIdentity {
  id: string
  label: string
  name: string
  email: string
  isDefault: boolean
  sshKeyPath?: string
  gpgKeyId?: string
  gpgSign?: boolean
  createdAt: number
}

export interface IntegrationAccount {
  id: string
  provider: ProviderId
  label: string
  username: string
  baseUrl: string
  identityId?: string
  hasToken: boolean
  createdAt: number
}

export interface IntegrationInput {
  id?: string
  provider: ProviderId
  label: string
  username: string
  baseUrl: string
  identityId?: string
  token?: string
}

export interface IdentityInput {
  id?: string
  label: string
  name: string
  email: string
  sshKeyPath?: string
  gpgKeyId?: string
  gpgSign?: boolean
  isDefault?: boolean
}

export interface RepoDefaults {
  identityId?: string
  integrationByProvider: Partial<Record<ProviderId, string>>
  defaultRemote?: string
}

export interface RecentRepo {
  path: string
  name: string
  addedAt: number
  lastOpenedAt: number
  pinned?: boolean
}

export interface AppConfig {
  schemaVersion: 1
  gitBinary: string
  theme: 'dark' | 'light' | 'system'
  identities: GitIdentity[]
  integrations: IntegrationAccount[]
  repoDefaults: Record<string, RepoDefaults>
  recentRepos: RecentRepo[]
  maxCommits: number
  confirmDestructive: boolean
  autoFetchOnOpen: boolean
  defaultProvider?: ProviderId
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  isPackaged: boolean
  git: GitBinaryInfo
  configPath: string
  secretsEncrypted: boolean
}

export interface GitBinaryInfo {
  path: string
  version: string
  available: boolean
  error?: string
}

export interface RemoteInfo {
  name: string
  fetchUrl: string
  pushUrl: string
  provider?: ProviderId
  host?: string
  owner?: string
  repo?: string
}

export interface RepoInfo {
  path: string
  /** Real path with symlinks resolved; stable identity for a tab. */
  canonicalPath: string
  root: string
  gitDir: string
  name: string
  isBare: boolean
  currentBranch: string | null
  headSha: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  remotes: RemoteInfo[]
  provider?: ProviderId
  state: RepoState
  worktree: boolean
}

export type RepoState =
  | 'clean'
  | 'merging'
  | 'rebasing'
  | 'cherry-picking'
  | 'reverting'
  | 'bisecting'
  | 'applying'

export interface Person {
  name: string
  email: string
  date: number
}

export interface Commit {
  sha: string
  shortSha: string
  parents: string[]
  author: Person
  committer: Person
  subject: string
  body: string
  refs: string[]
}

export interface RefInfo {
  name: string
  shortName: string
  type: 'branch' | 'remote' | 'tag'
  sha: string
  upstream?: string
  ahead?: number
  behind?: number
  subject?: string
  date?: number
  author?: string
  isCurrent?: boolean
}

export interface TagInfo {
  name: string
  sha: string
  targetSha: string
  annotated: boolean
  subject: string
  message?: string
  tagger?: Person
  date?: number
}

export interface WorktreeInfo {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  detached: boolean
  locked: boolean
  lockReason?: string
  prunable: boolean
  isMain: boolean
  isCurrent: boolean
}

export interface StashInfo {
  index: number
  sha: string
  message: string
  branch: string
  date: number
}

export type SubmoduleState = 'initialized' | 'uninitialized' | 'modified' | 'conflicted'

export interface SubmoduleInfo {
  path: string
  name: string
  url: string
  branch?: string
  sha: string
  shortSha: string
  describe?: string
  state: SubmoduleState
  initialized: boolean
  modified: boolean
  conflicted: boolean
  dirty: boolean
}

export interface SubmoduleAddInput {
  repoPath: string
  url: string
  path?: string
  branch?: string
  force?: boolean
  accountId?: string
}

export interface SubmoduleUpdateInput {
  repoPath: string
  submodulePath?: string
  init?: boolean
  recursive?: boolean
  remote?: boolean
  force?: boolean
  /** Remove untracked files from the checkout after updating. */
  clean?: boolean
}

export type FileStage = 'staged' | 'unstaged' | 'untracked' | 'conflicted'

export interface StatusFile {
  path: string
  origPath?: string
  index: string
  worktree: string
  stage: FileStage
  label: string
}

export interface RepoStatus {
  branch: string | null
  headSha: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  files: StatusFile[]
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  conflictedCount: number
  clean: boolean
}

export interface DiffFileStat {
  path: string
  oldPath?: string
  additions: number
  deletions: number
  binary: boolean
}

export interface DiffResult {
  patch: string
  files: DiffFileStat[]
}

export interface RepoConfigEntry {
  key: string
  value: string
  scope: 'local' | 'global' | 'system'
}

export interface DirEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
}

export interface FileContent {
  path: string
  content: string
  binary: boolean
  truncated: boolean
  size: number
  from: 'worktree' | 'head'
}

export interface BlameLine {
  sha: string
  author: string
  date: number
  line: number
  content: string
}

// ---------------------------------------------------------------------------
// Providers

export interface ProviderRepo {
  id: string
  fullName: string
  name: string
  owner: string
  defaultBranch: string
  private: boolean
  webUrl: string
  cloneUrl: string
  sshUrl?: string
  description?: string
  updatedAt?: number
}

export interface PullRequest {
  id: string
  number: number
  title: string
  state: 'open' | 'closed' | 'merged' | 'draft'
  draft: boolean
  author: string
  sourceBranch: string
  targetBranch: string
  webUrl: string
  createdAt: number
  updatedAt: number
  additions?: number
  deletions?: number
  mergeable?: boolean | null
}

export interface CreatePullRequestInput {
  title: string
  sourceBranch: string
  targetBranch: string
  body?: string
  draft?: boolean
}

export interface Release {
  id: string
  tagName: string
  name: string
  draft: boolean
  prerelease: boolean
  createdAt: number
  publishedAt?: number
  webUrl: string
  author?: string
  body?: string
}

export interface CreateReleaseInput {
  tagName: string
  name: string
  body?: string
  target?: string
  draft?: boolean
  prerelease?: boolean
}

export interface ActionWorkflow {
  id: string
  name: string
  path?: string
  disabled?: boolean
}

export interface ActionRun {
  id: string
  workflowId?: string
  workflowName: string
  number?: number
  status: string
  conclusion: string | null
  branch: string
  sha: string
  event: string
  createdAt: number
  updatedAt?: number
  webUrl: string
  actor?: string
}

export interface ProviderContext {
  accountId: string
  provider: ProviderId
  owner: string
  repo: string
  host?: string
}

export interface ProviderDetection {
  provider?: ProviderId
  accountId?: string
  host?: string
  owner?: string
  repo?: string
  webUrlBase?: string
}

export interface IntegrationTestResult {
  ok: boolean
  user?: string
  message: string
}

export interface RepoIdentitySuggestion {
  identityId?: string
  name?: string
  email?: string
}

// ---------------------------------------------------------------------------
// Tasks / streaming

export interface TaskStart {
  taskId: string
  kind: 'clone' | 'fetch' | 'pull' | 'push' | 'command' | 'checkout' | 'console'
  title: string
}

export interface TaskEvent {
  taskId: string
  kind: TaskStart['kind']
  phase: 'start' | 'output' | 'end' | 'error'
  text?: string
  stream?: 'stdout' | 'stderr'
  exitCode?: number
  error?: string
  /** Repository the task belongs to, so background tabs can refresh themselves. */
  repoPath?: string
}

export interface CloneInput {
  url: string
  directory: string
  name?: string
  accountId?: string
  identityId?: string
  bare?: boolean
  depth?: number
}

export interface InitInput {
  directory: string
  name?: string
  defaultBranch?: string
  identityId?: string
}

export interface TaskHandle {
  taskId: string
}

export interface PushInput {
  repoPath: string
  remote?: string
  branch?: string
  setUpstream?: boolean
  force?: 'none' | 'with-lease' | 'force'
  identityId?: string
  accountId?: string
}

export interface FetchInput {
  repoPath: string
  remote?: string
  prune?: boolean
  accountId?: string
}

export interface PullInput {
  repoPath: string
  remote?: string
  branch?: string
  rebase?: boolean
  identityId?: string
  accountId?: string
}

export interface CommitInput {
  repoPath: string
  message: string
  amend?: boolean
  signoff?: boolean
  identityId?: string
  allowEmpty?: boolean
}

export interface ResolveConflictInput {
  repoPath: string
  file: string
  content: string
}

export interface LogInput {
  repoPath: string
  limit?: number
  skip?: number
  branch?: string
  all?: boolean
  search?: string
}

export interface DiffInput {
  repoPath: string
  path?: string
  staged?: boolean
  commit?: string
  compare?: string
}

export interface CheckoutInput {
  repoPath: string
  branch: string
  create?: boolean
  startPoint?: string
  track?: boolean
  force?: boolean
}

export interface MergeInput {
  repoPath: string
  branch: string
  noFf?: boolean
  ffOnly?: boolean
  squash?: boolean
  message?: string
  identityId?: string
}

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'

export interface RebaseTodoItem {
  sha: string
  action: RebaseAction
  message?: string
}

export interface RebasePlan {
  onto: string
  upstreamSha: string | null
  upstreamSubject: string | null
  branch: string | null
  detached: boolean
  /** Commits in replay order: oldest first, as git will apply them. */
  commits: Commit[]
}

export interface RebasePlanInput {
  repoPath: string
  onto: string
  items: RebaseTodoItem[]
  identityId?: string
}

export interface RebaseResult {
  output: string
  exitCode: number
  /** True when the repository is left in a rebasing state (conflict, edit or hook stop). */
  inProgress: boolean
}

export interface ResetInput {
  repoPath: string
  commit: string
  mode: 'soft' | 'mixed' | 'hard'
}

export interface WorktreeAddInput {
  repoPath: string
  path: string
  branch: string
  createBranch?: boolean
  startPoint?: string
  detach?: boolean
}

export interface TagCreateInput {
  repoPath: string
  name: string
  message?: string
  commit?: string
  push?: boolean
  remote?: string
  identityId?: string
}

export interface ProviderQuery {
  accountId: string
  owner: string
  repo: string
}

export interface TriggerActionInput {
  accountId: string
  owner: string
  repo: string
  workflowId?: string
  ref: string
  inputs?: Record<string, string>
}

export interface ProviderReleaseQuery {
  accountId: string
  owner: string
  repo: string
}

export interface ProviderConnection {
  accountId: string
  provider: ProviderId
  username: string
  baseUrl: string
  label: string
  hasToken: boolean
}

export interface ConsoleInput {
  repoPath: string
  command: string
  identityId?: string
  accountId?: string
}
