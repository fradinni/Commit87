import { create } from 'zustand'
import type { StateCreator, StoreApi } from 'zustand'
import type {
  AppConfig,
  AppInfo,
  Commit,
  GitIdentity,
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
  UpdateStatus,
  WorktreeInfo
} from '@shared/types'
import type { IpcMethods, IpcRequest } from '@shared/ipc'
import { applyRepoTabPatch, closeTabRecord, cycleTabId, insertTabInGroup, moveTabInGroups, repoGroupKey, repoPathKey } from './lib/tabs'
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

export interface ConsoleLine {
  id: string
  text: string
  stream: 'stdout' | 'stderr'
  at: number
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
  graphQuery: string
  graphBranch: string
  consoleLines: ConsoleLine[]
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
  graphQuery: string
  graphBranch: string
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
  openRepo: (path: string) => Promise<void>
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
  setGraphQuery: (query: string) => void
  setGraphBranch: (branch: string) => void
  notify: (message: string, kind?: Toast['kind']) => void
  notifyError: (error: unknown) => void
  dismissToast: (id: string) => void
  setLoading: (key: string, value: boolean) => void
  handleTaskEvent: (event: TaskEvent) => void
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
  graphQuery: '',
  graphBranch: '',
  consoleLines: []
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
    graphQuery: tab.graphQuery,
    graphBranch: tab.graphBranch,
    consoleLines: tab.consoleLines
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

  async openRepo(path) {
    const existing = tabForPath(get().tabs, path)
    if (existing) {
      get().activateTab(existing.id)
      return
    }
    const request = ++openSeq
    set({ repoLoading: true })
    try {
      const repo = await call('repo.open', { path })
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
        call('git.status', { path: repo.path }),
        call('git.branches', { path: repo.path }),
        call('git.tags', { path: repo.path }),
        call('git.worktrees', { path: repo.path }),
        call('git.stashes', { path: repo.path }),
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
        graphQuery: '',
        graphBranch: '',
        consoleLines: []
      }
      // Two concurrent opens of the same folder must still produce one tab.
      const duplicate = get().tabs.find((item) => item.id === id)
      if (duplicate) {
        if (request === openSeq) get().activateTab(duplicate.id)
        set({ repoLoading: false })
        await get().loadRecent()
        return
      }
      if (request === openSeq) {
        set({ tabs: insertTabInGroup(get().tabs, tab, groupKeyOf), activeTabId: tab.id, ...tabToStore(tab), repoLoading: false })
      } else {
        // The launchpad is a deliberate choice too: only the very first tab
        // takes focus when an unsolicited open finishes in the background.
        const needsActive = get().activeTabId === null && get().tabs.length === 0
        set({ tabs: insertTabInGroup(get().tabs, tab, groupKeyOf), repoLoading: false })
        if (needsActive) get().activateTab(tab.id, false)
      }
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
    const result = closeTabRecord(state.tabs, state.activeTabId, targetId)
    if (result.tabs === state.tabs) return
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
    set({ tabs: [keep], activeTabId: keep.id, ...tabToStore(keep) })
  },

  closeAllTabs() {
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
    const updated: RepoTab = { ...state.tabs[index], ...patch }
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
    try {
      const [info, status, detection, branches, tags, worktrees, stashes, submodules] = await Promise.all([
        call('repo.info', { path: repoPath }),
        call('git.status', { path: repoPath }),
        call('provider.detect', { path: repoPath }),
        call('git.branches', { path: repoPath }),
        call('git.tags', { path: repoPath }),
        call('git.worktrees', { path: repoPath }),
        call('git.stashes', { path: repoPath }),
        call('git.submodules', { path: repoPath })
      ])
      // A deleted or renamed branch must not block the rest of the refresh.
      // Tags and remote refs are valid graph filters too.
      const branchExists =
        branches.some((item) => item.name === tab.graphBranch || item.shortName === tab.graphBranch) ||
        tags.some((tag) => tag.name === tab.graphBranch)
      const branchFilter = branchExists ? tab.graphBranch : ''
      const query = tab.graphQuery.trim()
      get().updateTab(repoPath, {
        currentRepo: info,
        status,
        detection,
        branches,
        tags,
        worktrees,
        stashes,
        submodules,
        ...(branchFilter === tab.graphBranch ? {} : { graphBranch: '' })
      })
      const limit = get().config?.maxCommits ?? 500
      try {
        const commits = await loadCommits(repoPath, limit, branchFilter, query)
        get().updateTab(repoPath, { commits })
      } catch (error) {
        if (!branchFilter && !query) throw error
        // The filter no longer matches (usually a rewritten history); keep the
        // refreshed collections and fall back to the full commit list.
        get().updateTab(repoPath, { graphQuery: '', graphBranch: '' })
        const commits = await loadCommits(repoPath, limit, '', '')
        get().updateTab(repoPath, { commits })
        if (!silent) get().notify('Commit filter no longer matches; showing all commits', 'info')
      }
    } catch (error) {
      if (!silent) get().notifyError(error)
    }
  },

  async refreshRepo(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    try {
      const [info, status, detection] = await Promise.all([
        call('repo.info', { path: target }),
        call('git.status', { path: target }),
        call('provider.detect', { path: target })
      ])
      get().updateTab(target, { currentRepo: info, status, detection })
    } catch (error) {
      get().notifyError(error)
    }
  },

  async refreshStatus(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    try {
      const [status, info] = await Promise.all([
        call('git.status', { path: target }),
        call('repo.info', { path: target })
      ])
      get().updateTab(target, { status, currentRepo: info })
    } catch {
      // status polling must not spam toasts
    }
  },

  async refreshBranches(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    try {
      const branches = await call('git.branches', { path: target })
      get().updateTab(target, { branches })
    } catch (error) {
      get().notifyError(error)
    }
  },

  async refreshTags(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    try {
      const tags = await call('git.tags', { path: target })
      get().updateTab(target, { tags })
    } catch (error) {
      get().notifyError(error)
    }
  },

  async refreshWorktrees(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    try {
      const worktrees = await call('git.worktrees', { path: target })
      get().updateTab(target, { worktrees })
    } catch (error) {
      get().notifyError(error)
    }
  },

  async refreshStashes(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    try {
      const stashes = await call('git.stashes', { path: target })
      get().updateTab(target, { stashes })
    } catch (error) {
      get().notifyError(error)
    }
  },

  async refreshSubmodules(repoPath) {
    const target = repoPath ?? get().currentRepo?.path
    if (!target) return
    try {
      const submodules = await call('git.submodules', { path: target })
      get().updateTab(target, { submodules })
    } catch (error) {
      get().notifyError(error)
    }
  },

  setView(view) {
    set({ view })
  },
  selectCommit(sha) {
    set({ selectedCommit: sha })
  },
  setGraphQuery(query) {
    set({ graphQuery: query })
  },
  setGraphBranch(branch) {
    set({ graphBranch: branch })
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
    if (event.phase === 'start') {
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
   * Console output belongs to the repository that produced it, even when the user
   * has switched tabs while a long command is still streaming.
   */
  updateTabConsole(event: TaskEvent, reset = false) {
    const state = get()
    const id = event.repoPath ? tabForPath(state.tabs, event.repoPath)?.id ?? null : state.activeTabId
    const line: ConsoleLine = {
      id: `c${++consoleSeq}`,
      text: event.text ?? '',
      stream: event.stream ?? 'stdout',
      at: Date.now()
    }
    if (!id || id === state.activeTabId) {
      set({ consoleLines: reset ? [] : [...state.consoleLines.slice(-800), line] })
      return
    }
    set({
      tabs: state.tabs.map((tab) =>
        tab.id === id
          ? { ...tab, consoleLines: reset ? [] : [...tab.consoleLines.slice(-800), line] }
          : tab
      )
    })
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

export type { TaskEvent }
