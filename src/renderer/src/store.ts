import { create } from 'zustand'
import type { StateCreator, StoreApi } from 'zustand'
import type {
  AppConfig,
  AppInfo,
  Commit,
  DiscardResult,
  GitIdentity,
  GitOperationResult,
  IntegrationAccount,
  ProviderDetection,
  PullRequest,
  RecentRepo,
  RefInfo,
  RepoDefaults,
  RepoInfo,
  RepoStatus,
  StashInfo,
  SubmoduleInfo,
  TagInfo,
  TaskEvent,
  TaskSnapshot,
  UpdateStatus,
  WorktreeInfo
} from '@shared/types'
import type { IpcMethods, IpcRequest } from '@shared/ipc'
import {
  RequestScope,
  applyRepoTabPatch,
  closeTabRecord,
  cycleTabId,
  insertTabInGroup,
  moveTabInGroups,
  repoGroupKey,
  repoPathKey
} from './lib/tabs'
import type { RequestField, RequestToken } from './lib/tabs'
import { statusesEqual } from './lib/files'
import { commit87Bridge } from './lib/bridge'

type IpcRequestMap = { [K in keyof IpcMethods]: IpcMethods[K]['request'] }
type IpcResponseMap = { [K in keyof IpcMethods]: IpcMethods[K]['response'] }

export type ViewId =
  | 'graph'
  | 'files'
  | 'branches'
  | 'worktrees'
  | 'tags'
  | 'stashes'
  | 'submodules'
  | 'remotes'
  | 'pulls'
  | 'releases'
  | 'actions'
  | 'settings'

export type SettingsTab = 'general' | 'identities' | 'integrations' | 'repository' | 'updates' | 'about'

export type SidebarMode = 'navigate' | 'refs'

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'error'
  message: string
}

/** Git output can be arbitrarily large; notices are one short line. */
export function clipOutput(output: string, limit = 700): string {
  const text = output.replace(/\s+$/, '')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

export interface OperationNotice {
  kind: Toast['kind']
  message: string
}

/**
 * Turn a main-process operation result into the only message a view may show.
 * A conflict/pause is never announced as success: it points at the state bar so
 * Continue, Skip or Abort remain the next step. A failure keeps Git's own text.
 */
export function operationNotice(
  result: Pick<GitOperationResult, 'status' | 'output' | 'conflictFiles' | 'inProgress'>,
  successMessage: string,
  label = 'The operation'
): OperationNotice {
  const output = clipOutput(result.output)
  if (result.status === 'ok') return { kind: 'success', message: successMessage }
  if (result.status === 'conflict' || result.inProgress) {
    const count = result.conflictFiles.length
    if (count > 0) {
      return {
        kind: 'info',
        message: `${label} paused: ${count} conflicted file${count === 1 ? ' needs' : 's need'} attention. Continue or abort from the status bar.`
      }
    }
    // A pause without conflicts (an empty cherry-pick, a hook stop) cannot be
    // continued; Skip or Abort is the way out.
    return {
      kind: 'info',
      message: `${label} paused: the repository needs another step. Continue, skip or abort from the status bar.`
    }
  }
  return { kind: 'error', message: output || `${label} failed` }
}

/** Discard is truthful too: a failed tracked restore is reported, not swallowed. */
export function discardNotice(result: DiscardResult): OperationNotice {
  const output = clipOutput(result.output)
  if (result.status === 'ok') return { kind: 'success', message: 'Changes discarded' }
  const failed = result.failed.length
    ? `${result.failed.length} path${result.failed.length === 1 ? '' : 's'}`
    : 'Some paths'
  return {
    kind: 'error',
    message: output || `${failed} could not be discarded`
  }
}

export interface ConsoleLine {
  id: string
  text: string
  stream: 'stdout' | 'stderr'
  at: number
}

/** An unsaved conflict resolution tied to one repository, file and baseline. */
export interface ConflictDraft {
  output: string
  eol: '\n' | '\r\n'
  updatedAt: number
}

/**
 * Draft keys include the baseline SHA-256 so a draft can never be applied to
 * bytes it was not derived from. NUL separators cannot appear in a path.
 */
export function conflictDraftKey(repoPath: string, file: string, sha: string): string {
  return `${draftPrefix(repoPath, file)}${sha || 'no-sha'}`
}

function draftPrefix(repoPath: string, file: string): string {
  return `${repoPath}\u0000${file}\u0000`
}

interface TaskState {
  taskId: string
  title: string
  kind: string
  repoPath: string | null
}

/** Everything a tab needs to look and behave exactly as it did when left. */
export interface RepoTab {
  id: string
  currentRepo: RepoInfo
  repoDefaults: RepoDefaults
  detection: ProviderDetection
  status: RepoStatus | null
  commits: Commit[]
  branches: RefInfo[]
  tags: TagInfo[]
  worktrees: WorktreeInfo[]
  stashes: StashInfo[]
  submodules: SubmoduleInfo[]
  pulls: PullRequest[]
  view: ViewId
  selectedCommit: string | null
  selectedCommits: string[]
  selectionAnchor: string | null
  graphQuery: string
  graphBranch: string
  consoleLines: ConsoleLine[]
  commitMessage: string
  commitAmend: boolean
  commitSignoff: boolean
  conflictDrafts: Record<string, ConflictDraft>
}

/** Fields a repository tab owns; every one of them has a flat mirror for the active tab. */
export type RepoTabDataKey = Exclude<keyof RepoTab, 'id'>

export type RepoTabPatch = Partial<Omit<RepoTab, 'id'>>

interface StoreState {
  ready: boolean
  fatal: string | null
  appInfo: AppInfo | null
  config: AppConfig | null
  recent: RecentRepo[]
  updateStatus: UpdateStatus | null
  settingsTab: SettingsTab
  tabs: RepoTab[]
  activeTabId: string | null
  currentRepo: RepoInfo | null
  repoDefaults: RepoDefaults
  detection: ProviderDetection
  status: RepoStatus | null
  commits: Commit[]
  branches: RefInfo[]
  tags: TagInfo[]
  worktrees: WorktreeInfo[]
  stashes: StashInfo[]
  submodules: SubmoduleInfo[]
  pulls: PullRequest[]
  view: ViewId
  selectedCommit: string | null
  selectedCommits: string[]
  selectionAnchor: string | null
  graphQuery: string
  graphBranch: string
  commitMessage: string
  commitAmend: boolean
  commitSignoff: boolean
  conflictDrafts: Record<string, ConflictDraft>
  repoLoading: boolean
  loading: Record<string, boolean>
  toasts: Toast[]
  task: TaskState | null
  tasks: Record<string, TaskState>
  consoleOpen: boolean
  consoleLines: ConsoleLine[]
  sidebarOpen: boolean
  sidebarMode: SidebarMode
  paletteOpen: boolean
  rebaseOpen: boolean
  rebaseOnto: string | null

  init: () => Promise<void>
  refreshConfig: () => Promise<void>
  setUpdateStatus: (status: UpdateStatus) => void
  setSettingsTab: (tab: SettingsTab) => void
  checkForUpdates: (options?: { navigate?: boolean }) => Promise<void>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  loadRecent: () => Promise<void>
  removeRecent: (path: string) => Promise<void>
  pinRecent: (path: string, pinned: boolean) => Promise<void>
  openRepo: (path: string, standalone?: boolean) => Promise<void>
  closeRepo: () => Promise<void>
  showLaunchpad: () => void
  activateTab: (id: string, cancelPending?: boolean) => void
  closeTab: (id?: string) => void
  closeOtherTabs: (id?: string) => void
  closeAllTabs: () => void
  cycleTab: (delta: number) => void
  moveTab: (id: string, index: number) => void
  updateTab: (repoPath: string, patch: RepoTabPatch) => void
  refreshAll: (repoPath?: string) => Promise<void>
  refreshTab: (repoPath: string, silent?: boolean) => Promise<void>
  refreshRepo: (repoPath?: string) => Promise<void>
  refreshStatus: (repoPath?: string) => Promise<void>
  refreshBranches: (repoPath?: string) => Promise<void>
  refreshTags: (repoPath?: string) => Promise<void>
  refreshWorktrees: (repoPath?: string) => Promise<void>
  refreshStashes: (repoPath?: string) => Promise<void>
  refreshSubmodules: (repoPath?: string) => Promise<void>
  setView: (view: ViewId) => void
  selectCommit: (sha: string | null) => void
  selectCommits: (shas: string[], active: string | null, anchor?: string | null) => void
  setGraphQuery: (query: string) => void
  setGraphBranch: (branch: string) => void
  setCommitDraft: (patch: { message?: string; amend?: boolean; signoff?: boolean }) => void
  clearCommitDraft: () => void
  saveConflictDraft: (key: string, draft: ConflictDraft) => void
  clearConflictDrafts: (repoPath: string, file: string) => void
  notify: (message: string, kind?: Toast['kind']) => void
  notifyError: (error: unknown) => void
  dismissToast: (id: string) => void
  setLoading: (key: string, value: boolean) => void
  handleTaskEvent: (event: TaskEvent) => void
  reconcileTasks: (snapshot: TaskSnapshot) => void
  finishTask: (taskId: string) => void
  updateTabConsole: (event: TaskEvent, reset?: boolean) => void
  toggleConsole: (open?: boolean) => void
  clearConsole: () => void
  pushConsoleLine: (text: string, stream?: 'stdout' | 'stderr') => void
  setSidebarOpen: (open: boolean) => void
  setSidebarMode: (mode: SidebarMode) => void
  toggleRefsPanel: () => void
  setPaletteOpen: (open: boolean) => void
  openRebase: (onto?: string) => void
  closeRebase: () => void
  identities: () => GitIdentity[]
  integrations: () => IntegrationAccount[]
  identityById: (id?: string) => GitIdentity | undefined
  integrationById: (id?: string) => IntegrationAccount | undefined
}

const emptyDefaults: RepoDefaults = { integrationByProvider: {} }

type RepoSlice = Pick<StoreState, 'currentRepo' | RepoTabDataKey>

const emptyRepoSlice: RepoSlice = {
  currentRepo: null,
  repoDefaults: emptyDefaults,
  detection: {},
  status: null,
  commits: [],
  branches: [],
  tags: [],
  worktrees: [],
  stashes: [],
  submodules: [],
  pulls: [],
  view: 'graph',
  selectedCommit: null,
  selectedCommits: [],
  selectionAnchor: null,
  graphQuery: '',
  graphBranch: '',
  consoleLines: [],
  commitMessage: '',
  commitAmend: false,
  commitSignoff: false,
  conflictDrafts: {}
}

let toastSeq = 0
let consoleSeq = 0
let openSeq = 0

function call<K extends keyof IpcRequestMap>(channel: K, payload: IpcRequest<K>): Promise<IpcResponseMap[K]> {
  return commit87Bridge().invoke(channel, payload) as Promise<IpcResponseMap[K]>
}

function loadCommits(repoPath: string, limit: number, branch: string, query: string) {
  return call('git.log', {
    repoPath,
    limit,
    all: !branch,
    branch: branch || undefined,
    search: query || undefined
  })
}

function pathKey(repoPath: string): string {
  return repoPathKey(repoPath, commit87Bridge().platform)
}

/** Tabs are identified by the real path Git resolved, so symlinks cannot fork them. */
function repoKey(repo: Pick<RepoInfo, 'path' | 'canonicalPath'>): string {
  return pathKey(repo.canonicalPath || repo.path)
}

function tabForPath(tabs: RepoTab[], repoPath: string): RepoTab | undefined {
  const key = pathKey(repoPath)
  return tabs.find((tab) => {
    const canonical = tab.currentRepo.canonicalPath || tab.currentRepo.path
    return pathKey(canonical) === key || pathKey(tab.currentRepo.path) === key
  })
}

/** A repository and its linked worktrees share one group key. */
function groupKeyOf(tab: RepoTab): string {
  return repoGroupKey(tab.currentRepo, commit87Bridge().platform)
}

/**
 * Console tails restored from main before any tab for their repository exists.
 * They are replayed when that repository is opened, so a reload never loses
 * output and never shows it in another tab.
 */
const pendingConsoleTails = new Map<string, string[]>()

/** Replay a tail queued before its repository tab existed. */
function replayPendingConsole(repoPath: string): void {
  const key = pathKey(repoPath)
  const lines = pendingConsoleTails.get(key)
  if (!lines?.length) return
  pendingConsoleTails.delete(key)
  const state = useStore.getState()
  for (const text of lines) {
    state.updateTabConsole({
      taskId: `replay-${key}`,
      kind: 'console',
      phase: 'output',
      repoPath,
      text
    })
  }
}

/** Owner key for async requests: the canonical checkout, never a display path. */
function requestKey(tab: RepoTab): string {
  return pathKey(tab.currentRepo.canonicalPath || tab.currentRepo.path)
}

const requests = new RequestScope()
const inFlightRefreshes = new Map<string, Promise<void>>()
const completedTaskIds: string[] = []
const completedTaskSet = new Set<string>()
/** Tasks whose live event stream this renderer has already seen. */
const observedTasks = new Set<string>()
const COMPLETED_TASK_LIMIT = 200
const CONSOLE_LINE_LIMIT = 800
const ANNOUNCED_TASKS_KEY = 'commit87.announced-tasks'

/** Share one in-flight read for the same repository and kind (poll + refresh). */
function coalescedRefresh(key: string, run: () => Promise<void>): Promise<void> {
  const pending = inFlightRefreshes.get(key)
  if (pending) return pending
  const started = run().finally(() => {
    if (inFlightRefreshes.get(key) === started) inFlightRefreshes.delete(key)
  })
  inFlightRefreshes.set(key, started)
  return started
}

/** A tab was opened or closed: void its requests and any shared read waiting on them. */
function restartLifetime(tab: RepoTab): void {
  const key = requestKey(tab)
  requests.restart(key)
  inFlightRefreshes.delete(`status:${key}`)
}

function beginRefresh(tab: RepoTab, fields: readonly RequestField[]): RequestToken {
  return requests.begin(requestKey(tab), fields)
}

/** Assemble the fields this request still owns after its awaits. */
function ownedPatch(
  token: RequestToken,
  entries: ReadonlyArray<readonly [RequestField, RepoTabPatch]>
): RepoTabPatch | null {
  if (!requests.isCurrent(token)) return null
  const patch: RepoTabPatch = {}
  let has = false
  for (const [field, value] of entries) {
    if (!requests.owns(token, field)) continue
    Object.assign(patch, value)
    has = true
  }
  return has ? patch : null
}

function rememberCompleted(taskId: string): void {
  completedTaskSet.add(taskId)
  completedTaskIds.push(taskId)
  if (completedTaskIds.length > COMPLETED_TASK_LIMIT) {
    const oldest = completedTaskIds.shift()
    if (oldest) completedTaskSet.delete(oldest)
  }
}

/**
 * Completions this window has already announced, kept across a renderer reload
 * in `sessionStorage`. That is the reconnection record: a retained task that is
 * absent means the event was delivered while no window was listening, and one
 * that is present was streamed to the previous renderer and must stay silent.
 */
function loadAnnouncedTasks(): void {
  try {
    const storage = (globalThis as { sessionStorage?: { getItem(key: string): string | null } }).sessionStorage
    const raw = storage?.getItem(ANNOUNCED_TASKS_KEY)
    if (!raw) return
    const ids: unknown = JSON.parse(raw)
    if (!Array.isArray(ids)) return
    for (const id of ids) if (typeof id === 'string') completedTaskSet.add(id)
  } catch {
    // sessionStorage is a convenience for reconnection, never a requirement.
  }
}

function persistAnnouncedTasks(): void {
  try {
    const storage = (globalThis as { sessionStorage?: { setItem(key: string, value: string): void } }).sessionStorage
    storage?.setItem(ANNOUNCED_TASKS_KEY, JSON.stringify([...completedTaskSet].slice(-COMPLETED_TASK_LIMIT)))
  } catch {
    // A quota or disabled storage only costs the reconnection record.
  }
}

function markTaskCompleted(taskId: string): boolean {
  if (completedTaskSet.has(taskId)) return false
  rememberCompleted(taskId)
  persistAnnouncedTasks()
  return true
}

function consoleLine(event: TaskEvent): ConsoleLine {
  return {
    id: `c${++consoleSeq}`,
    text: event.text ?? '',
    stream: event.stream ?? 'stdout',
    at: Date.now()
  }
}

/** Append to one tab, active mirror included, never to a different owner. */
function appendToTab(
  tab: RepoTab,
  line: ConsoleLine,
  activeTabId: string | null,
  reset: boolean,
  tabs: RepoTab[],
  activeLines: ConsoleLine[]
): { tabs?: RepoTab[]; consoleLines?: ConsoleLine[] } {
  if (tab.id === activeTabId) {
    return { consoleLines: reset ? [] : [...activeLines.slice(-CONSOLE_LINE_LIMIT), line] }
  }
  return {
    tabs: tabs.map((item) =>
      item.id === tab.id
        ? { ...item, consoleLines: reset ? [] : [...item.consoleLines.slice(-CONSOLE_LINE_LIMIT), line] }
        : item
    )
  }
}

function tabToStore(tab: RepoTab): Partial<StoreState> {
  return {
    currentRepo: tab.currentRepo,
    repoDefaults: tab.repoDefaults,
    detection: tab.detection,
    status: tab.status,
    commits: tab.commits,
    branches: tab.branches,
    tags: tab.tags,
    worktrees: tab.worktrees,
    stashes: tab.stashes,
    submodules: tab.submodules,
    pulls: tab.pulls,
    view: tab.view,
    selectedCommit: tab.selectedCommit,
    selectedCommits: tab.selectedCommits,
    selectionAnchor: tab.selectionAnchor,
    graphQuery: tab.graphQuery,
    graphBranch: tab.graphBranch,
    consoleLines: tab.consoleLines,
    commitMessage: tab.commitMessage,
    commitAmend: tab.commitAmend,
    commitSignoff: tab.commitSignoff,
    conflictDrafts: tab.conflictDrafts
  }
}

/**
 * Any write to a repository-scoped field is mirrored into the active tab record.
 * Views keep using the flat selectors, while switching tabs is a single hydrate.
 */
function withTabSync(set: StoreApi<StoreState>['setState']): StoreApi<StoreState>['setState'] {
  type StorePartial =
    | StoreState
    | Partial<StoreState>
    | ((state: StoreState) => StoreState | Partial<StoreState>)
  const loose = set as unknown as (partial: (state: StoreState) => StoreState, replace?: boolean) => void
  return ((partial: StorePartial, replace?: boolean) => {
    loose((state) => {
      const patch = typeof partial === 'function' ? partial(state) : partial
      if (!patch) return state
      const targetId = 'activeTabId' in patch ? patch.activeTabId ?? null : state.activeTabId
      const patchedTabs = applyRepoTabPatch(state.tabs, targetId, patch as Record<string, unknown>)
      const tabs = 'tabs' in patch && patch.tabs ? patch.tabs : patchedTabs ?? state.tabs
      const next = tabs === state.tabs && !('tabs' in patch) ? patch : { ...patch, tabs }
      return replace ? (next as StoreState) : ({ ...state, ...next } as StoreState)
    })
  }) as StoreApi<StoreState>['setState']
}

const storeCreator: StateCreator<StoreState> = (set, get) => ({
  ready: false,
  fatal: null,
  appInfo: null,
  config: null,
  recent: [],
  updateStatus: null,
  settingsTab: 'general',
  tabs: [],
  activeTabId: null,
  ...emptyRepoSlice,
  repoLoading: false,
  loading: {},
  toasts: [],
  task: null,
  tasks: {},
  consoleOpen: false,
  sidebarOpen: true,
  sidebarMode: 'navigate',
  paletteOpen: false,
  rebaseOpen: false,
  rebaseOnto: null,

  async init() {
    try {
      const [appInfo, config, recent, updateStatus] = await Promise.all([
        call('app.info', undefined),
        call('config.get', undefined),
        call('repo.recent', undefined),
        call('update.status', undefined)
      ])
      set({ appInfo, config, recent, updateStatus, ready: true })
    } catch (error) {
      set({
        ready: true,
        fatal: error instanceof Error ? error.message : String(error)
      })
    }
  },

  async refreshConfig() {
    const [config, recent] = await Promise.all([call('config.get', undefined), call('repo.recent', undefined)])
    set({ config, recent })
  },

  setUpdateStatus(status) {
    set({ updateStatus: status })
  },

  setSettingsTab(tab) {
    set({ settingsTab: tab })
  },

  async checkForUpdates(options) {
    if (options?.navigate) set({ view: 'settings', settingsTab: 'updates' })
    try {
      const status = await call('update.check', undefined)
      set({ updateStatus: status })
      if (status.phase === 'up-to-date') get().notify('Commit87 is up to date', 'success')
      else if (status.phase === 'available' && !status.autoCheck) {
        get().notify(`Commit87 ${status.version ?? 'update'} is available`, 'info')
      } else if (status.phase === 'error') get().notify(status.error ?? 'Update check failed', 'error')
      else if (status.phase === 'unsupported') get().notify(status.reason ?? 'Updates are managed elsewhere', 'info')
    } catch (error) {
      get().notifyError(error)
    }
  },

  async downloadUpdate() {
    try {
      set({ updateStatus: await call('update.download', undefined) })
    } catch (error) {
      get().notifyError(error)
    }
  },

  async installUpdate() {
    try {
      await call('update.install', undefined)
    } catch (error) {
      get().notifyError(error)
    }
  },

  async loadRecent() {
    set({ recent: await call('repo.recent', undefined) })
  },

  async removeRecent(path) {
    set({ recent: await call('repo.removeRecent', { path }) })
  },

  async pinRecent(path, pinned) {
    set({ recent: await call('repo.pinRecent', { path, pinned }) })
  },

  async openRepo(path, standalone = false) {
    const existing = tabForPath(get().tabs, path)
    if (existing) {
      get().activateTab(existing.id)
      replayPendingConsole(existing.currentRepo.path)
      if (standalone) {
        // The OS opened a repository that is already a tab: still let the main
        // process record it (a linked worktree belongs in the recents here).
        await call('repo.open', { path, standalone })
        await get().loadRecent()
      }
      return
    }
    const request = ++openSeq
    set({ repoLoading: true })
    try {
      const repo = await call('repo.open', { path, standalone })
      const id = repoKey(repo)
      const opened = get().tabs.find((tab) => tab.id === id)
      if (opened) {
        if (request === openSeq) get().activateTab(opened.id)
        set({ repoLoading: false })
        return
      }
      const [defaults, detection, status, branches, tags, worktrees, stashes, submodules] = await Promise.all([
        call('repo.getDefaults', { path: repo.path }),
        call('provider.detect', { path: repo.path }),
        // A bare repository has no working tree: never run `git status` there,
        // and never present an invented clean tree either.
        repo.isBare ? Promise.resolve(null) : call('git.status', { path: repo.path }),
        call('git.branches', { path: repo.path }),
        call('git.tags', { path: repo.path }),
        call('git.worktrees', { path: repo.path }),
        repo.isBare ? Promise.resolve([]) : call('git.stashes', { path: repo.path }),
        call('git.submodules', { path: repo.path })
      ])
      const limit = get().config?.maxCommits ?? 500
      const commits = await call('git.log', { repoPath: repo.path, limit, all: true })
      const tab: RepoTab = {
        id,
        currentRepo: repo,
        repoDefaults: defaults,
        detection,
        status,
        commits,
        branches,
        tags,
        worktrees,
        stashes,
        submodules,
        pulls: [],
        view: 'graph',
        selectedCommit: commits[0]?.sha ?? null,
        selectedCommits: commits[0] ? [commits[0].sha] : [],
        selectionAnchor: commits[0]?.sha ?? null,
        graphQuery: '',
        graphBranch: '',
        consoleLines: [],
        commitMessage: '',
        commitAmend: false,
        commitSignoff: false,
        conflictDrafts: {}
      }
      // Two concurrent opens of the same folder must still produce one tab.
      const duplicate = get().tabs.find((item) => item.id === id)
      if (duplicate) {
        if (request === openSeq) get().activateTab(duplicate.id)
        set({ repoLoading: false })
        replayPendingConsole(duplicate.currentRepo.path)
        await get().loadRecent()
        return
      }
      // A tab for this checkout is (re)born: every request captured for an
      // earlier tab at the same path is void from here on.
      restartLifetime(tab)
      if (request === openSeq) {
        set({ tabs: insertTabInGroup(get().tabs, tab, groupKeyOf), activeTabId: tab.id, ...tabToStore(tab), repoLoading: false })
      } else {
        // The launchpad is a deliberate choice too: only the very first tab
        // takes focus when an unsolicited open finishes in the background.
        const needsActive = get().activeTabId === null && get().tabs.length === 0
        set({ tabs: insertTabInGroup(get().tabs, tab, groupKeyOf), repoLoading: false })
        if (needsActive) get().activateTab(tab.id, false)
      }
      replayPendingConsole(repo.path)
      await get().loadRecent()
    } catch (error) {
      set({ repoLoading: false })
      throw error
    }
  },

  async closeRepo() {
    get().closeTab()
  },

  showLaunchpad() {
    // Keep every tab open; only the active repository mirror is cleared, so the
    // launchpad becomes a home screen instead of an unreachable first run.
    if (!get().tabs.length) return
    openSeq += 1
    set({ activeTabId: null, ...emptyRepoSlice, rebaseOpen: false, rebaseOnto: null })
  },

  activateTab(id, cancelPending = true) {
    const state = get()
    // A deliberate tab switch wins over any repository still loading: it must not
    // steal focus when it finishes, even when the clicked tab is already active.
    if (cancelPending) openSeq += 1
    if (state.activeTabId === id) return
    const tab = state.tabs.find((item) => item.id === id)
    if (!tab) return
    set({ activeTabId: id, ...tabToStore(tab), rebaseOpen: false, rebaseOnto: null })
    void get().refreshStatus()
  },

  closeTab(id) {
    const state = get()
    const targetId = id ?? state.activeTabId
    if (!targetId) return
    const closing = state.tabs.find((tab) => tab.id === targetId)
    const result = closeTabRecord(state.tabs, state.activeTabId, targetId)
    if (result.tabs === state.tabs) return
    // Output and results for a closed tab must never reach another one.
    if (closing) restartLifetime(closing)
    if (!result.activeId) {
      // Closing an inactive tab while the launchpad is showing must not discard
      // the remaining tabs.
      if (result.tabs.length === 0) set({ tabs: [], activeTabId: null, ...emptyRepoSlice })
      else set({ tabs: result.tabs })
      return
    }
    const active = result.tabs.find((tab) => tab.id === result.activeId)
    if (!active) return
    set({ tabs: result.tabs, activeTabId: active.id, ...tabToStore(active) })
  },

  closeOtherTabs(id) {
    const state = get()
    const keepId = id ?? state.activeTabId
    const keep = state.tabs.find((tab) => tab.id === keepId)
    if (!keep) return
    for (const tab of state.tabs) {
      if (tab.id !== keep.id) restartLifetime(tab)
    }
    set({ tabs: [keep], activeTabId: keep.id, ...tabToStore(keep) })
  },

  closeAllTabs() {
    for (const tab of get().tabs) restartLifetime(tab)
    set({ tabs: [], activeTabId: null, ...emptyRepoSlice })
  },

  cycleTab(delta) {
    const id = cycleTabId(get().tabs, get().activeTabId, delta)
    if (id) get().activateTab(id)
  },

  moveTab(id, index) {
    const tabs = moveTabInGroups(get().tabs, id, index, groupKeyOf)
    if (tabs !== get().tabs) set({ tabs })
  },

  updateTab(repoPath, patch) {
    const state = get()
    const existing = tabForPath(state.tabs, repoPath)
    if (!existing) return
    const id = existing.id
    const index = state.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    // `git status` answers the 5 s poll with an equal snapshot on most ticks.
    // Keeping the published object means the staging rows, the selected facet
    // and an open diff keep their identity instead of reloading under the user.
    const effective: RepoTabPatch =
      patch.status && existing.status && statusesEqual(existing.status, patch.status)
        ? { ...patch, status: existing.status }
        : patch
    const updated: RepoTab = { ...state.tabs[index], ...effective }
    const tabs = state.tabs.map((tab, itemIndex) => (itemIndex === index ? updated : tab))
    if (state.activeTabId === id) set({ ...tabToStore(updated), tabs })
    else set({ tabs })
  },

  async refreshAll(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    await get().refreshTab(target, false)
  },

  async refreshTab(repoPath, silent = true) {
    const tab = tabForPath(get().tabs, repoPath)
    if (!tab) return
    const target = tab.currentRepo.path
    const token = beginRefresh(tab, ['repo', 'detection', 'branches', 'tags', 'worktrees', 'stashes', 'submodules', 'commits'])
    try {
      const [info, status, detection, branches, tags, worktrees, stashes, submodules] = await Promise.all([
        call('repo.info', { path: target }),
        // A bare repository has no working tree; refreshing its collections must
        // not run a worktree-only command or fabricate a clean status.
        tab.currentRepo.isBare ? Promise.resolve(null) : call('git.status', { path: target }),
        call('provider.detect', { path: target }),
        call('git.branches', { path: target }),
        call('git.tags', { path: target }),
        call('git.worktrees', { path: target }),
        tab.currentRepo.isBare ? Promise.resolve([]) : call('git.stashes', { path: target }),
        call('git.submodules', { path: target })
      ])
      if (!requests.isCurrent(token)) return
      // Read the *current* tab, not the snapshot taken before the awaits: a
      // newer draft filter or a branch created meanwhile must not be clobbered.
      const live = tabForPath(get().tabs, target)
      if (!live) return
      // A deleted or renamed branch must not block the rest of the refresh.
      // Tags and remote refs are valid graph filters too.
      const branchExists =
        branches.some((item) => item.name === live.graphBranch || item.shortName === live.graphBranch) ||
        tags.some((tag) => tag.name === live.graphBranch)
      const droppedBranch = Boolean(live.graphBranch) && !branchExists
      const patch = ownedPatch(token, [
        ['repo', { currentRepo: info, status }],
        ['detection', { detection }],
        ['branches', { branches }],
        ['tags', { tags }],
        ['worktrees', { worktrees }],
        ['stashes', { stashes }],
        ['submodules', { submodules }],
        // Clear only the branch value this refresh actually saw disappear.
        ['branches', droppedBranch ? { graphBranch: '' } : {}]
      ])
      if (patch) get().updateTab(target, patch)
      if (!requests.owns(token, 'commits')) return
      const current = tabForPath(get().tabs, target)
      if (!current) return
      const branchFilter = current.graphBranch
      const query = current.graphQuery.trim()
      const limit = get().config?.maxCommits ?? 500
      try {
        const commits = await loadCommits(target, limit, branchFilter, query)
        if (!requests.owns(token, 'commits')) return
        const still = tabForPath(get().tabs, target)
        // A graph query applied while these commits were loading wins.
        if (!still || still.graphBranch !== branchFilter || still.graphQuery.trim() !== query) return
        get().updateTab(target, { commits })
      } catch (error) {
        if (!branchFilter && !query) throw error
        if (!requests.owns(token, 'commits')) return
        const failed = tabForPath(get().tabs, target)
        if (!failed || failed.graphBranch !== branchFilter || failed.graphQuery.trim() !== query) return
        // The filter no longer matches (usually a rewritten history); keep the
        // refreshed collections and fall back to the full commit list.
        get().updateTab(target, { graphQuery: '', graphBranch: '' })
        const commits = await loadCommits(target, limit, '', '')
        const afterClear = tabForPath(get().tabs, target)
        // A filter applied while the unfiltered retry was loading wins.
        if (requests.owns(token, 'commits') && afterClear && !afterClear.graphBranch && !afterClear.graphQuery.trim()) {
          get().updateTab(target, { commits })
        }
        if (!silent) get().notify('Commit filter no longer matches; showing all commits', 'info')
      }
    } catch (error) {
      if (!silent && requests.isCurrent(token)) get().notifyError(error)
    }
  },

  async refreshRepo(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    const tab = tabForPath(get().tabs, target)
    if (!tab) return
    const token = beginRefresh(tab, ['repo', 'detection'])
    try {
      const [info, status, detection] = await Promise.all([
        call('repo.info', { path: tab.currentRepo.path }),
        tab.currentRepo.isBare ? Promise.resolve(null) : call('git.status', { path: tab.currentRepo.path }),
        call('provider.detect', { path: tab.currentRepo.path })
      ])
      const patch = ownedPatch(token, [
        ['repo', { currentRepo: info, status }],
        ['detection', { detection }]
      ])
      if (patch) get().updateTab(tab.currentRepo.path, patch)
    } catch (error) {
      if (requests.isCurrent(token)) get().notifyError(error)
    }
  },

  async refreshStatus(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    const tab = tabForPath(get().tabs, target)
    if (!tab || tab.currentRepo.isBare) return
    // The 5 s poll and a tab activation often coincide; one shared read keeps
    // them from running duplicate `git status`/`repo.info` pairs.
    return coalescedRefresh(`status:${requestKey(tab)}`, async () => {
      const live = tabForPath(get().tabs, target) ?? tab
      const token = beginRefresh(live, ['repo'])
      try {
        const [status, info] = await Promise.all([
          call('git.status', { path: live.currentRepo.path }),
          call('repo.info', { path: live.currentRepo.path })
        ])
        const patch = ownedPatch(token, [['repo', { status, currentRepo: info }]])
        if (patch) get().updateTab(live.currentRepo.path, patch)
      } catch {
        // status polling must not spam toasts
      }
    })
  },

  async refreshBranches(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    const tab = tabForPath(get().tabs, target)
    if (!tab) return
    const token = beginRefresh(tab, ['branches'])
    try {
      const branches = await call('git.branches', { path: tab.currentRepo.path })
      const patch = ownedPatch(token, [['branches', { branches }]])
      if (patch) get().updateTab(tab.currentRepo.path, patch)
    } catch (error) {
      if (requests.isCurrent(token)) get().notifyError(error)
    }
  },

  async refreshTags(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    const tab = tabForPath(get().tabs, target)
    if (!tab) return
    const token = beginRefresh(tab, ['tags'])
    try {
      const tags = await call('git.tags', { path: tab.currentRepo.path })
      const patch = ownedPatch(token, [['tags', { tags }]])
      if (patch) get().updateTab(tab.currentRepo.path, patch)
    } catch (error) {
      if (requests.isCurrent(token)) get().notifyError(error)
    }
  },

  async refreshWorktrees(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    const tab = tabForPath(get().tabs, target)
    if (!tab) return
    const token = beginRefresh(tab, ['worktrees'])
    try {
      const worktrees = await call('git.worktrees', { path: tab.currentRepo.path })
      const patch = ownedPatch(token, [['worktrees', { worktrees }]])
      if (patch) get().updateTab(tab.currentRepo.path, patch)
    } catch (error) {
      if (requests.isCurrent(token)) get().notifyError(error)
    }
  },

  async refreshStashes(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    const tab = tabForPath(get().tabs, target)
    if (!tab) return
    const token = beginRefresh(tab, ['stashes'])
    try {
      const stashes = await call('git.stashes', { path: tab.currentRepo.path })
      const patch = ownedPatch(token, [['stashes', { stashes }]])
      if (patch) get().updateTab(tab.currentRepo.path, patch)
    } catch (error) {
      if (requests.isCurrent(token)) get().notifyError(error)
    }
  },

  async refreshSubmodules(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    const tab = tabForPath(get().tabs, target)
    if (!tab) return
    const token = beginRefresh(tab, ['submodules'])
    try {
      const submodules = await call('git.submodules', { path: tab.currentRepo.path })
      const patch = ownedPatch(token, [['submodules', { submodules }]])
      if (patch) get().updateTab(tab.currentRepo.path, patch)
    } catch (error) {
      if (requests.isCurrent(token)) get().notifyError(error)
    }
  },

  setView(view) {
    set({ view })
  },
  selectCommit(sha) {
    set({ selectedCommit: sha, selectedCommits: sha ? [sha] : [], selectionAnchor: sha })
  },
  selectCommits(shas, active, anchor) {
    const selectedCommits = [...new Set(shas)]
    const selectedCommit =
      active && selectedCommits.includes(active) ? active : selectedCommits[selectedCommits.length - 1] ?? null
    set({ selectedCommits, selectedCommit, selectionAnchor: anchor !== undefined ? anchor : selectedCommit })
  },
  setGraphQuery(query) {
    set({ graphQuery: query })
  },
  setGraphBranch(branch) {
    set({ graphBranch: branch })
  },
  setCommitDraft(patch) {
    set({
      ...(patch.message !== undefined ? { commitMessage: patch.message } : {}),
      ...(patch.amend !== undefined ? { commitAmend: patch.amend } : {}),
      ...(patch.signoff !== undefined ? { commitSignoff: patch.signoff } : {})
    })
  },
  clearCommitDraft() {
    set({ commitMessage: '', commitAmend: false, commitSignoff: false })
  },
  saveConflictDraft(key, draft) {
    set({ conflictDrafts: { ...get().conflictDrafts, [key]: draft } })
  },
  clearConflictDrafts(repoPath, file) {
    const current = get().conflictDrafts
    const prefix = draftPrefix(repoPath, file)
    const next = Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix)))
    if (Object.keys(next).length !== Object.keys(current).length) set({ conflictDrafts: next })
  },

  notify(message, kind = 'info') {
    const id = `t${++toastSeq}`
    set((state) => ({ toasts: [...state.toasts, { id, kind, message }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 9000 : 4500)
  },
  notifyError(error) {
    get().notify(error instanceof Error ? error.message : String(error), 'error')
  },
  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },
  setLoading(key, value) {
    set((state) => ({ loading: { ...state.loading, [key]: value } }))
  },

  handleTaskEvent(event) {
    observedTasks.add(event.taskId)
    // A snapshot reconciliation and a live event can describe the same finish;
    // only the first one may notify, refresh or open a clone.
    if (event.phase === 'end' || event.phase === 'error') {
      if (!markTaskCompleted(event.taskId)) return
    }
    if (event.phase === 'start') {
      // Reusing an id (only possible in tests or after a main restart) starts a
      // new task, so an old completion record must not swallow its end.
      completedTaskSet.delete(event.taskId)
      const task: TaskState = {
        taskId: event.taskId,
        title: event.text || 'Running…',
        kind: event.kind,
        repoPath: event.repoPath ?? null
      }
      set((state) => ({ task, tasks: { ...state.tasks, [task.taskId]: task } }))
      if (event.kind === 'console') get().updateTabConsole(event, true)
      return
    }
    if (event.kind === 'console' && event.phase === 'output' && event.text) {
      get().updateTabConsole(event)
      return
    }
    if (event.phase === 'error') {
      if (event.kind === 'console' && event.text) get().updateTabConsole({ ...event, stream: 'stderr' })
      get().notify(event.error || 'Command failed', 'error')
      get().finishTask(event.taskId)
      const target = event.repoPath ? tabForPath(get().tabs, event.repoPath) : undefined
      if (event.repoPath && target && target.id !== get().activeTabId) void get().refreshTab(event.repoPath)
      else void get().refreshStatus()
      if (event.kind === 'clone') void get().loadRecent()
      return
    }
    if (event.phase === 'end') {
      get().finishTask(event.taskId)
      if (event.kind === 'clone') {
        void get().loadRecent()
        get().notify('Clone finished', 'success')
      } else if (event.kind !== 'console') {
        get().notify(`${event.kind === 'push' ? 'Push' : event.kind === 'pull' ? 'Pull' : 'Fetch'} finished`, 'success')
        const target = event.repoPath ? tabForPath(get().tabs, event.repoPath) : undefined
        if (event.repoPath && target && target.id !== get().activeTabId) void get().refreshTab(event.repoPath)
        else void get().refreshAll()
      }
    }
  },

  finishTask(taskId) {
    const tasks = { ...get().tasks }
    delete tasks[taskId]
    const running = Object.values(tasks)
    set({ tasks, task: running[running.length - 1] ?? null })
  },

  /**
   * Adopt main's bounded task inventory after a renderer reload. A task that
   * finished while no renderer was listening is replayed once; a task the live
   * subscription (or the previous renderer) already reported stays silent.
   */
  reconcileTasks(snapshot) {
    // The previous renderer's completions, if this is a reload of the same window.
    loadAnnouncedTasks()
    const state = get()
    const tasks = { ...state.tasks }
    let changed = false
    for (const entry of snapshot.running) {
      if (tasks[entry.taskId] || completedTaskSet.has(entry.taskId)) continue
      tasks[entry.taskId] = {
        taskId: entry.taskId,
        title: entry.title || 'Running…',
        kind: entry.kind,
        repoPath: entry.repoPath ?? null
      }
      changed = true
      // Only a task whose live stream was missed needs the retained tail;
      // replaying it after the subscription started would duplicate lines.
      if (!observedTasks.has(entry.taskId) && entry.kind === 'console') {
        const lines = entry.output.split('\n').filter((text) => text.length > 0)
        const owner = entry.repoPath ? tabForPath(get().tabs, entry.repoPath) : undefined
        if (!entry.repoPath || owner) {
          // Marked observed only once the lines actually have a home.
          observedTasks.add(entry.taskId)
          for (const text of lines) {
            get().updateTabConsole({
              taskId: entry.taskId,
              kind: 'console',
              phase: 'output',
              repoPath: entry.repoPath,
              text
            })
          }
        } else if (lines.length) {
          const key = pathKey(entry.repoPath)
          const queued = [...(pendingConsoleTails.get(key) ?? []), ...lines]
          pendingConsoleTails.set(key, queued.slice(-CONSOLE_LINE_LIMIT))
        }
      }
    }
    if (changed) {
      const running = Object.values(tasks)
      set({ tasks, task: running[running.length - 1] ?? null })
    }

    const refreshedRepos = new Set<string>()
    for (const entry of snapshot.recent) {
      // Announced live, or by the renderer that was connected before this one.
      if (!markTaskCompleted(entry.taskId)) continue
      get().finishTask(entry.taskId)
      const target = entry.repoPath ? tabForPath(get().tabs, entry.repoPath) : undefined
      // A background repository that is not open needs no announcement and no
      // refresh burst; only what the user can see is reported.
      if (!entry.repoPath || target) {
        if (entry.phase === 'error') {
          get().notify(entry.error || 'Command failed', 'error')
        } else if (entry.kind === 'clone') {
          get().notify('Clone finished', 'success')
        } else if (entry.kind !== 'console') {
          const label = entry.kind === 'push' ? 'Push' : entry.kind === 'pull' ? 'Pull' : 'Fetch'
          get().notify(`${label} finished while the window was reconnecting`, 'success')
        }
      }
      if (entry.kind === 'clone') void get().loadRecent()
      if (entry.repoPath && target) {
        const key = pathKey(entry.repoPath)
        if (refreshedRepos.has(key)) continue
        refreshedRepos.add(key)
        void get().refreshTab(entry.repoPath)
      }
    }
  },

  /**
   * Console output belongs to the repository that produced it, even when the user
   * has switched tabs while a long command is still streaming. Output for a
   * closed owner is dropped: it must never appear in whichever tab is active.
   */
  updateTabConsole(event: TaskEvent, reset = false) {
    const state = get()
    if (!event.repoPath) {
      // Repository-less commands have no owner, so the active tab is the only
      // sensible home for them.
      set({ consoleLines: reset ? [] : [...state.consoleLines.slice(-CONSOLE_LINE_LIMIT), consoleLine(event)] })
      return
    }
    const owner = tabForPath(state.tabs, event.repoPath)
    if (!owner) return
    const next = appendToTab(owner, consoleLine(event), state.activeTabId, reset, state.tabs, state.consoleLines)
    set(next)
  },

  toggleConsole(open) {
    set((state) => ({ consoleOpen: open ?? !state.consoleOpen }))
  },
  clearConsole() {
    set({ consoleLines: [] })
  },
  pushConsoleLine(text, stream = 'stdout') {
    set((state) => ({
      consoleLines: [...state.consoleLines.slice(-800), { id: `c${++consoleSeq}`, text, stream, at: Date.now() }]
    }))
  },
  setSidebarOpen(open) {
    set({ sidebarOpen: open })
  },
  setSidebarMode(mode) {
    if (mode === 'refs' && !get().currentRepo) {
      set({ sidebarOpen: true })
      return
    }
    set({ sidebarMode: mode, ...(mode === 'refs' ? { sidebarOpen: true } : {}) })
  },
  toggleRefsPanel() {
    if (!get().currentRepo) {
      set({ sidebarOpen: true })
      get().notify('Open a repository to use the refs panel', 'info')
      return
    }
    const next: SidebarMode = get().sidebarMode === 'refs' ? 'navigate' : 'refs'
    set({ sidebarMode: next, sidebarOpen: true })
  },
  setPaletteOpen(open) {
    set({ paletteOpen: open })
  },
  openRebase(onto) {
    set({ rebaseOpen: true, rebaseOnto: onto ?? null })
  },
  closeRebase() {
    set({ rebaseOpen: false, rebaseOnto: null })
  },

  identities() {
    return get().config?.identities ?? []
  },
  integrations() {
    return get().config?.integrations ?? []
  },
  identityById(id) {
    const identities = get().config?.identities ?? []
    return identities.find((identity) => identity.id === id)
  },
  integrationById(id) {
    const integrations = get().config?.integrations ?? []
    return integrations.find((integration) => integration.id === id)
  }
})

export const useStore = create<StoreState>()((rawSet, get, api) => storeCreator(withTabSync(rawSet), get, api))

export function activeIdentity(): GitIdentity | undefined {
  const state = useStore.getState()
  const id = state.repoDefaults.identityId
  return (
    state.identityById(id) ??
    state.config?.identities.find((identity) => identity.isDefault) ??
    state.config?.identities[0]
  )
}

/**
 * The identity the user picked for this repository, or undefined when none was
 * picked. Operations send this, never `activeIdentity()`: the application
 * default is resolved in main *after* the repository-local `user.name`/
 * `user.email`, so sending it here would turn a fallback into an override and
 * make an interrupted operation continue as the wrong person.
 */
export function selectedIdentityId(): string | undefined {
  return useStore.getState().repoDefaults.identityId
}

export type { TaskEvent }
