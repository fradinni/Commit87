import { create } from 'zustand'
import type {
  ActionRun,
  ActionWorkflow,
  AppConfig,
  AppInfo,
  Commit,
  GitIdentity,
  IntegrationAccount,
  ProviderDetection,
  PullRequest,
  RecentRepo,
  RefInfo,
  Release,
  RepoDefaults,
  RepoInfo,
  RepoStatus,
  StashInfo,
  TagInfo,
  TaskEvent,
  WorktreeInfo
} from '@shared/types'
import type { IpcRequest } from '@shared/ipc'

export type ViewId =
  | 'graph'
  | 'files'
  | 'branches'
  | 'worktrees'
  | 'tags'
  | 'stashes'
  | 'remotes'
  | 'pulls'
  | 'releases'
  | 'actions'
  | 'settings'

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
}

interface StoreState {
  ready: boolean
  fatal: string | null
  appInfo: AppInfo | null
  config: AppConfig | null
  recent: RecentRepo[]
  currentRepo: RepoInfo | null
  repoDefaults: RepoDefaults
  detection: ProviderDetection
  status: RepoStatus | null
  commits: Commit[]
  branches: RefInfo[]
  tags: TagInfo[]
  worktrees: WorktreeInfo[]
  stashes: StashInfo[]
  pulls: PullRequest[]
  workflows: ActionWorkflow[]
  runs: ActionRun[]
  releases: Release[]
  view: ViewId
  selectedCommit: string | null
  selectedFile: string | null
  repoLoading: boolean
  loading: Record<string, boolean>
  toasts: Toast[]
  task: TaskState | null
  consoleOpen: boolean
  consoleLines: ConsoleLine[]
  sidebarOpen: boolean
  paletteOpen: boolean

  init: () => Promise<void>
  refreshConfig: () => Promise<void>
  loadRecent: () => Promise<void>
  removeRecent: (path: string) => Promise<void>
  pinRecent: (path: string, pinned: boolean) => Promise<void>
  openRepo: (path: string) => Promise<void>
  closeRepo: () => Promise<void>
  refreshAll: () => Promise<void>
  refreshRepo: () => Promise<void>
  refreshStatus: () => Promise<void>
  refreshBranches: () => Promise<void>
  refreshTags: () => Promise<void>
  refreshWorktrees: () => Promise<void>
  refreshStashes: () => Promise<void>
  setView: (view: ViewId) => void
  selectCommit: (sha: string | null) => void
  selectFile: (path: string | null) => void
  notify: (message: string, kind?: Toast['kind']) => void
  notifyError: (error: unknown) => void
  dismissToast: (id: string) => void
  setLoading: (key: string, value: boolean) => void
  handleTaskEvent: (event: TaskEvent) => void
  toggleConsole: (open?: boolean) => void
  clearConsole: () => void
  pushConsoleLine: (text: string, stream?: 'stdout' | 'stderr') => void
  setSidebarOpen: (open: boolean) => void
  setPaletteOpen: (open: boolean) => void
  identities: () => GitIdentity[]
  integrations: () => IntegrationAccount[]
  identityById: (id?: string) => GitIdentity | undefined
  integrationById: (id?: string) => IntegrationAccount | undefined
}

const emptyDefaults: RepoDefaults = { integrationByProvider: {} }

let toastSeq = 0
let consoleSeq = 0

function call<K extends keyof IpcRequestMap>(channel: K, payload: IpcRequest<K>): Promise<IpcResponseMap[K]> {
  return window.gitgrove.invoke(channel, payload) as Promise<IpcResponseMap[K]>
}

// Local aliases keep the store readable without importing the entire IPC map.
import type { IpcMethods } from '@shared/ipc'
type IpcRequestMap = { [K in keyof IpcMethods]: IpcMethods[K]['request'] }
type IpcResponseMap = { [K in keyof IpcMethods]: IpcMethods[K]['response'] }

export const useStore = create<StoreState>((set, get) => ({
  ready: false,
  fatal: null,
  appInfo: null,
  config: null,
  recent: [],
  currentRepo: null,
  repoDefaults: emptyDefaults,
  detection: {},
  status: null,
  commits: [],
  branches: [],
  tags: [],
  worktrees: [],
  stashes: [],
  pulls: [],
  workflows: [],
  runs: [],
  releases: [],
  view: 'graph',
  selectedCommit: null,
  selectedFile: null,
  repoLoading: false,
  loading: {},
  toasts: [],
  task: null,
  consoleOpen: false,
  consoleLines: [],
  sidebarOpen: true,
  paletteOpen: false,

  async init() {
    try {
      const [appInfo, config, recent] = await Promise.all([
        call('app.info', undefined),
        call('config.get', undefined),
        call('repo.recent', undefined)
      ])
      set({ appInfo, config, recent, ready: true })
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
    set({ repoLoading: true })
    try {
      const repo = await call('repo.open', { path })
      const [defaults, detection, status, branches, tags, worktrees, stashes] = await Promise.all([
        call('repo.getDefaults', { path: repo.path }),
        call('provider.detect', { path: repo.path }),
        call('git.status', { path: repo.path }),
        call('git.branches', { path: repo.path }),
        call('git.tags', { path: repo.path }),
        call('git.worktrees', { path: repo.path }),
        call('git.stashes', { path: repo.path })
      ])
      const limit = get().config?.maxCommits ?? 500
      const commits = await call('git.log', { repoPath: repo.path, limit, all: true })
      set({
        currentRepo: repo,
        repoDefaults: defaults,
        detection,
        status,
        branches,
        tags,
        worktrees,
        stashes,
        commits,
        selectedCommit: commits[0]?.sha ?? null,
        selectedFile: null,
        view: 'graph',
        repoLoading: false
      })
      await get().loadRecent()
    } catch (error) {
      set({ repoLoading: false })
      throw error
    }
  },

  async closeRepo() {
    set({
      currentRepo: null,
      status: null,
      commits: [],
      branches: [],
      tags: [],
      worktrees: [],
      stashes: [],
      pulls: [],
      workflows: [],
      runs: [],
      releases: [],
      selectedCommit: null,
      selectedFile: null,
      detection: {},
      view: 'graph'
    })
  },

  async refreshAll() {
    const repo = get().currentRepo
    if (!repo) return
    await get().refreshRepo()
    await Promise.all([
      get().refreshBranches(),
      get().refreshTags(),
      get().refreshWorktrees(),
      get().refreshStashes()
    ])
    const limit = get().config?.maxCommits ?? 500
    const commits = await call('git.log', { repoPath: repo.path, limit, all: true })
    set({ commits })
  },

  async refreshRepo() {
    const repo = get().currentRepo
    if (!repo) return
    try {
      const [info, status, detection] = await Promise.all([
        call('repo.info', { path: repo.path }),
        call('git.status', { path: repo.path }),
        call('provider.detect', { path: repo.path })
      ])
      set({ currentRepo: info, status, detection })
    } catch (error) {
      get().notifyError(error)
    }
  },

  async refreshStatus() {
    const repo = get().currentRepo
    if (!repo) return
    try {
      const [status, info] = await Promise.all([
        call('git.status', { path: repo.path }),
        call('repo.info', { path: repo.path })
      ])
      set({ status, currentRepo: info })
    } catch {
      // status polling must not spam toasts
    }
  },

  async refreshBranches() {
    const repo = get().currentRepo
    if (!repo) return
    try {
      set({ branches: await call('git.branches', { path: repo.path }) })
    } catch (error) {
      get().notifyError(error)
    }
  },

  async refreshTags() {
    const repo = get().currentRepo
    if (!repo) return
    try {
      set({ tags: await call('git.tags', { path: repo.path }) })
    } catch (error) {
      get().notifyError(error)
    }
  },

  async refreshWorktrees() {
    const repo = get().currentRepo
    if (!repo) return
    try {
      set({ worktrees: await call('git.worktrees', { path: repo.path }) })
    } catch (error) {
      get().notifyError(error)
    }
  },

  async refreshStashes() {
    const repo = get().currentRepo
    if (!repo) return
    try {
      set({ stashes: await call('git.stashes', { path: repo.path }) })
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
  selectFile(path) {
    set({ selectedFile: path })
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
      set({ task: { taskId: event.taskId, title: event.text || 'Running…', kind: event.kind } })
      if (event.kind === 'console') set({ consoleLines: [] })
      return
    }
    if (event.kind === 'console' && event.phase === 'output' && event.text) {
      set((state) => ({
        consoleLines: [
          ...state.consoleLines.slice(-800),
          { id: `c${++consoleSeq}`, text: event.text ?? '', stream: event.stream ?? 'stdout', at: Date.now() }
        ]
      }))
      return
    }
    if (event.phase === 'error') {
      if (event.kind === 'console' && event.text) {
        set((state) => ({
          consoleLines: [
            ...state.consoleLines.slice(-800),
            { id: `c${++consoleSeq}`, text: event.text ?? '', stream: 'stderr', at: Date.now() }
          ]
        }))
      }
      get().notify(event.error || 'Command failed', 'error')
      set({ task: null })
      void get().refreshStatus()
      if (event.kind === 'clone') void get().loadRecent()
      return
    }
    if (event.phase === 'end') {
      set({ task: null })
      if (event.kind === 'clone') {
        void get().loadRecent()
        get().notify('Clone finished', 'success')
      } else if (event.kind !== 'console') {
        get().notify(`${event.kind === 'push' ? 'Push' : event.kind === 'pull' ? 'Pull' : 'Fetch'} finished`, 'success')
        void get().refreshAll()
      }
    }
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
  setPaletteOpen(open) {
    set({ paletteOpen: open })
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
}))

export function activeIdentity(): GitIdentity | undefined {
  const state = useStore.getState()
  const id = state.repoDefaults.identityId
  return state.identityById(id) ?? state.config?.identities.find((identity) => identity.isDefault) ?? state.config?.identities[0]
}

export type { TaskEvent }
