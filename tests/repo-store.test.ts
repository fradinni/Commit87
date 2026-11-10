import { beforeEach, describe, expect, it } from 'vitest'
import type { AppConfig, RepoInfo, RepoStatus } from '../src/shared/types'
import type { Commit87Bridge } from '../src/shared/bridge'

interface Call {
  channel: string
  payload: unknown
}

const calls: Call[] = []
let failOn: { channel: string; path?: string } | null = null
let delay: { channel: string; path: string; ms: number } | null = null
const commonDirs: Record<string, string> = {}
const barePaths = new Set<string>()
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function payloadPath(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as { path?: string; repoPath?: string }
  return record.path ?? record.repoPath
}

function repoInfo(repoPath: string): RepoInfo {
  return {
    path: repoPath,
    canonicalPath: repoPath,
    root: repoPath,
    gitDir: `${repoPath}/.git`,
    commonDir: commonDirs[repoPath] ?? `${repoPath}/.git`,
    name: repoPath.split('/').pop() ?? repoPath,
    isBare: barePaths.has(repoPath),
    currentBranch: 'main',
    headSha: 'abc123',
    detached: false,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    remotes: [],
    state: 'clean',
    worktree: false
  }
}

function statusFor(repoPath: string): RepoStatus {
  return {
    branch: `main-${repoPath.split('/').pop()}`,
    headSha: 'abc123',
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    clean: true
  }
}

const config: AppConfig = {
  schemaVersion: 1,
  gitBinary: '',
  theme: 'dark',
  identities: [],
  integrations: [],
  repoDefaults: {},
  recentRepos: [],
  maxCommits: 500,
  confirmDestructive: true,
  autoFetchOnOpen: false,
  updateChannel: 'stable',
  autoUpdateCheck: true
}

const handlers: Record<string, (payload: unknown) => unknown> = {
  'app.info': () => ({
    name: 'Commit87',
    version: '0.1.0',
    electron: '45',
    chrome: '140',
    node: '24',
    platform: 'linux',
    arch: 'x64',
    isPackaged: false,
    git: { path: '/usr/bin/git', version: 'git version 2.43', available: true },
    configPath: '/tmp/config.json',
    secretsEncrypted: false
  }),
  'config.get': () => config,
  'repo.recent': () => [],
  'repo.open': (payload) => repoInfo((payload as { path: string }).path),
  'repo.info': (payload) => repoInfo((payload as { path: string }).path),
  'repo.getDefaults': () => ({ integrationByProvider: {} }),
  'provider.detect': () => ({}),
  'git.status': (payload) => statusFor((payload as { path: string }).path),
  'git.branches': () => [{ name: 'refs/heads/main', shortName: 'main', type: 'branch', sha: 'abc123' }],
  'git.tags': () => [],
  'git.worktrees': () => [],
  'git.stashes': () => [],
  'git.submodules': () => [],
  'git.log': (payload) => {
    if ((payload as { search?: string }).search === 'boom') throw new Error('unknown revision')
    return []
  }
}

const bridge = {
  platform: 'linux',
  versions: { electron: '45', chrome: '140', node: '24' },
  invoke: async (channel: string, payload: unknown) => {
    calls.push({ channel, payload })
    const target = payloadPath(payload)
    if (delay && delay.channel === channel && delay.path === target) await sleep(delay.ms)
    if (failOn && failOn.channel === channel && (!failOn.path || failOn.path === target)) {
      throw new Error(`${channel} failed`)
    }
    const handler = handlers[channel]
    if (!handler) throw new Error(`unexpected channel ${channel}`)
    return handler(payload)
  },
  onTaskEvent: () => () => undefined,
  onWindowState: () => () => undefined,
  onMenu: () => () => undefined
} as unknown as Commit87Bridge

// The store resolves the preload bridge from the global scope at call time.
const globalScope = globalThis as { commit87?: Commit87Bridge }
globalScope.commit87 = bridge

const { useStore, conflictDraftKey, operationNotice, discardNotice, selectedIdentityId } = await import(
  '../src/renderer/src/store'
)

const A = '/tmp/commit87-tabs/alpha'
const B = '/tmp/commit87-tabs/beta'
const WT = '/tmp/commit87-tabs/alpha-feature'
const BARE = '/tmp/commit87-tabs/bare.git'

function reset(): void {
  calls.length = 0
  failOn = null
  delay = null
  for (const key of Object.keys(commonDirs)) delete commonDirs[key]
  barePaths.clear()
  useStore.getState().closeAllTabs()
  useStore.setState({ config, toasts: [], task: null, tasks: {}, consoleOpen: false, sidebarMode: 'navigate', sidebarOpen: true })
}

beforeEach(reset)

describe('repository tabs', () => {
  it('opens a repository as a tab and mirrors its data', async () => {
    await useStore.getState().openRepo(A)
    const state = useStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe(A)
    expect(state.currentRepo?.path).toBe(A)
    expect(state.status?.branch).toBe('main-alpha')
  })

  it('opens a bare repository without running git status or inventing a tree', async () => {
    barePaths.add(BARE)
    await useStore.getState().openRepo(BARE)
    const state = useStore.getState()
    expect(state.currentRepo?.isBare).toBe(true)
    expect(state.status).toBeNull()
    expect(calls.some((entry) => entry.channel === 'git.status')).toBe(false)

    calls.length = 0
    await useStore.getState().refreshAll(BARE)
    expect(calls.some((entry) => entry.channel === 'git.status')).toBe(false)
    expect(useStore.getState().status).toBeNull()

    calls.length = 0
    await useStore.getState().refreshStatus(BARE)
    expect(calls.some((entry) => entry.channel === 'git.status')).toBe(false)
  })

  it('reuses the existing tab for the same path without reloading it', async () => {
    await useStore.getState().openRepo(A)
    calls.length = 0
    await useStore.getState().openRepo(`${A}/`)
    expect(useStore.getState().tabs).toHaveLength(1)
    expect(calls.map((entry) => entry.channel)).not.toContain('git.log')
  })

  it('tells the main process when the OS opened the repository directly', async () => {
    await useStore.getState().openRepo(A, true)

    const opened = calls.find((entry) => entry.channel === 'repo.open')
    expect(opened?.payload).toEqual({ path: A, standalone: true })
  })

  it('opens repositories from inside the app without the standalone flag', async () => {
    await useStore.getState().openRepo(A)

    const opened = calls.find((entry) => entry.channel === 'repo.open')
    expect(opened?.payload).toEqual({ path: A, standalone: false })
  })

  it('still records an OS open when the repository already has a tab', async () => {
    await useStore.getState().openRepo(A)
    calls.length = 0

    await useStore.getState().openRepo(A, true)

    const opened = calls.find((entry) => entry.channel === 'repo.open')
    expect(opened?.payload).toEqual({ path: A, standalone: true })
    expect(calls.map((entry) => entry.channel)).toContain('repo.recent')
    expect(useStore.getState().tabs).toHaveLength(1)
  })

  it('keeps independent state per tab and restores it on switch', async () => {
    await useStore.getState().openRepo(A)
    useStore.getState().setView('files')
    useStore.getState().setGraphQuery('release')
    useStore.getState().setGraphBranch('main')

    await useStore.getState().openRepo(B)
    expect(useStore.getState().tabs).toHaveLength(2)
    expect(useStore.getState().activeTabId).toBe(B)
    expect(useStore.getState().view).toBe('graph')
    expect(useStore.getState().graphQuery).toBe('')
    expect(useStore.getState().currentRepo?.path).toBe(B)

    useStore.getState().activateTab(A)
    expect(useStore.getState().view).toBe('files')
    expect(useStore.getState().graphQuery).toBe('release')
    expect(useStore.getState().graphBranch).toBe('main')
    expect(useStore.getState().currentRepo?.path).toBe(A)
  })

  it('keeps the commit selection per tab and restores it on switch', async () => {
    await useStore.getState().openRepo(A)
    useStore.getState().selectCommits(['aaa', 'bbb'], 'bbb', 'aaa')
    expect(useStore.getState().selectedCommits).toEqual(['aaa', 'bbb'])
    expect(useStore.getState().selectedCommit).toBe('bbb')
    expect(useStore.getState().selectionAnchor).toBe('aaa')

    await useStore.getState().openRepo(B)
    expect(useStore.getState().selectedCommits).toEqual([])
    expect(useStore.getState().selectedCommit).toBeNull()
    expect(useStore.getState().selectionAnchor).toBeNull()

    useStore.getState().activateTab(A)
    expect(useStore.getState().selectedCommits).toEqual(['aaa', 'bbb'])
    expect(useStore.getState().selectedCommit).toBe('bbb')
    expect(useStore.getState().selectionAnchor).toBe('aaa')
    expect(useStore.getState().tabs.find((tab) => tab.id === A)?.selectedCommits).toEqual(['aaa', 'bbb'])
    expect(useStore.getState().tabs.find((tab) => tab.id === A)?.selectionAnchor).toBe('aaa')
  })

  it('writes repository updates into the addressed tab only', async () => {
    await useStore.getState().openRepo(A)
    await useStore.getState().openRepo(B)
    useStore.getState().updateTab(A, { view: 'tags' })
    expect(useStore.getState().view).toBe('graph')
    expect(useStore.getState().tabs.find((tab) => tab.id === A)?.view).toBe('tags')
  })

  it('closes the active tab and activates its neighbour', async () => {
    await useStore.getState().openRepo(A)
    await useStore.getState().openRepo(B)
    useStore.getState().closeTab(B)
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual([A])
    expect(useStore.getState().activeTabId).toBe(A)
    expect(useStore.getState().currentRepo?.path).toBe(A)
  })

  it('returns to the launchpad after closing the last tab', async () => {
    await useStore.getState().openRepo(A)
    useStore.getState().closeTab()
    const state = useStore.getState()
    expect(state.tabs).toHaveLength(0)
    expect(state.activeTabId).toBeNull()
    expect(state.currentRepo).toBeNull()
    expect(state.status).toBeNull()
  })

  it('closes the other tabs and keeps the requested one', async () => {
    await useStore.getState().openRepo(A)
    await useStore.getState().openRepo(B)
    useStore.getState().closeOtherTabs(A)
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual([A])
    expect(useStore.getState().activeTabId).toBe(A)
  })

  it('cycles tabs and supports reordering', async () => {
    await useStore.getState().openRepo(A)
    await useStore.getState().openRepo(B)
    useStore.getState().cycleTab(1)
    expect(useStore.getState().activeTabId).toBe(A)
    useStore.getState().moveTab(A, 1)
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual([B, A])
  })

  it('keeps a repository and its worktrees adjacent in the tab strip', async () => {
    commonDirs[WT] = `${A}/.git`
    await useStore.getState().openRepo(A)
    await useStore.getState().openRepo(B)
    await useStore.getState().openRepo(WT)
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual([A, WT, B])
  })

  it('reorders whole repository groups together', async () => {
    commonDirs[WT] = `${A}/.git`
    await useStore.getState().openRepo(A)
    await useStore.getState().openRepo(WT)
    await useStore.getState().openRepo(B)
    useStore.getState().moveTab(B, 0)
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual([B, A, WT])
  })

  it('shows the launchpad without closing open tabs', async () => {
    await useStore.getState().openRepo(A)
    await useStore.getState().openRepo(B)
    useStore.getState().showLaunchpad()
    let state = useStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([A, B])
    expect(state.activeTabId).toBeNull()
    expect(state.currentRepo).toBeNull()
    expect(state.status).toBeNull()

    useStore.getState().activateTab(B)
    state = useStore.getState()
    expect(state.currentRepo?.path).toBe(B)
    expect(state.status?.branch).toBe('main-beta')
  })

  it('closes an inactive tab from the launchpad without discarding the rest', async () => {
    await useStore.getState().openRepo(A)
    await useStore.getState().openRepo(B)
    useStore.getState().showLaunchpad()
    useStore.getState().closeTab(A)
    const state = useStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([B])
    expect(state.activeTabId).toBeNull()
    expect(state.currentRepo).toBeNull()
  })

  it('does not let a slow open override the launchpad', async () => {
    await useStore.getState().openRepo(A)
    delay = { channel: 'git.log', path: B, ms: 40 }
    const opening = useStore.getState().openRepo(B)
    await sleep(5)
    useStore.getState().showLaunchpad()
    await opening
    const state = useStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([A, B])
    expect(state.activeTabId).toBeNull()
    expect(state.currentRepo).toBeNull()
  })

  it('surfaces a failed open without leaving a tab behind', async () => {
    failOn = { channel: 'git.log' }
    await expect(useStore.getState().openRepo(A)).rejects.toThrow('git.log failed')
    expect(useStore.getState().tabs).toHaveLength(0)
    expect(useStore.getState().repoLoading).toBe(false)
  })

  it('collapses concurrent opens of the same path into one tab', async () => {
    await Promise.all([useStore.getState().openRepo(A), useStore.getState().openRepo(A)])
    expect(useStore.getState().tabs).toHaveLength(1)
    expect(useStore.getState().activeTabId).toBe(A)
  })

  it('keeps a loaded repository active when a later open fails', async () => {
    delay = { channel: 'git.log', path: A, ms: 40 }
    failOn = { channel: 'git.log', path: B }
    const first = useStore.getState().openRepo(A)
    await sleep(5)
    const second = useStore.getState().openRepo(B).catch(() => undefined)
    await Promise.all([first, second])
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual([A])
    expect(useStore.getState().activeTabId).toBe(A)
    expect(useStore.getState().currentRepo?.path).toBe(A)
  })

  it('does not let a manual tab switch be overridden by a slow open', async () => {
    await useStore.getState().openRepo(A)
    delay = { channel: 'git.log', path: B, ms: 40 }
    const opening = useStore.getState().openRepo(B)
    await sleep(5)
    useStore.getState().activateTab(A)
    await opening
    expect(useStore.getState().tabs).toHaveLength(2)
    expect(useStore.getState().activeTabId).toBe(A)
  })

  it('passes the tab commit-graph filter to git.log', async () => {
    await useStore.getState().openRepo(A)
    useStore.getState().setGraphQuery('step')
    useStore.getState().setGraphBranch('main')
    calls.length = 0
    await useStore.getState().refreshTab(A)
    const log = calls.filter((entry) => entry.channel === 'git.log').at(-1)
    expect(log?.payload).toMatchObject({ repoPath: A, branch: 'main', all: false, search: 'step' })
  })

  it('still refreshes collections when a saved filter no longer matches', async () => {
    await useStore.getState().openRepo(A)
    useStore.getState().setGraphQuery('boom')
    await useStore.getState().refreshAll(A)
    const tab = useStore.getState().tabs[0]
    expect(tab.graphQuery).toBe('')
    expect(tab.status?.branch).toBe('main-alpha')
    expect(useStore.getState().status?.branch).toBe('main-alpha')
  })

  it('clears a branch filter that disappeared from the branch list', async () => {
    await useStore.getState().openRepo(A)
    useStore.getState().setGraphBranch('deleted-branch')
    await useStore.getState().refreshTab(A)
    expect(useStore.getState().tabs[0].graphBranch).toBe('')
  })

  it('refreshes the repository it was asked for after a tab switch', async () => {
    await useStore.getState().openRepo(A)
    await useStore.getState().openRepo(B)
    delay = { channel: 'git.log', path: A, ms: 40 }
    const refresh = useStore.getState().refreshAll(A)
    useStore.getState().activateTab(B)
    await refresh
    expect(useStore.getState().currentRepo?.path).toBe(B)
    expect(useStore.getState().status?.branch).toBe('main-beta')
    expect(useStore.getState().tabs.find((tab) => tab.id === A)?.status?.branch).toBe('main-alpha')
  })
})

describe('tab-aware task events', () => {
  it('routes console output to the tab that produced it', async () => {
    await useStore.getState().openRepo(A)
    await useStore.getState().openRepo(B)
    useStore.getState().handleTaskEvent({
      taskId: 't1',
      kind: 'console',
      phase: 'start',
      repoPath: A,
      text: 'git status'
    })
    useStore.getState().handleTaskEvent({
      taskId: 't1',
      kind: 'console',
      phase: 'output',
      repoPath: A,
      text: 'clean'
    })

    expect(useStore.getState().consoleLines).toHaveLength(0)
    const alpha = useStore.getState().tabs.find((tab) => tab.id === A)
    const beta = useStore.getState().tabs.find((tab) => tab.id === B)
    expect(alpha?.consoleLines.map((line) => line.text)).toEqual(['clean'])
    expect(beta?.consoleLines).toHaveLength(0)
  })

  it('refreshes a background tab when its task finishes', async () => {
    await useStore.getState().openRepo(A)
    await useStore.getState().openRepo(B)
    calls.length = 0
    useStore.getState().handleTaskEvent({ taskId: 't2', kind: 'fetch', phase: 'end', repoPath: A })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const paths = calls
      .filter((entry) => entry.channel === 'git.status')
      .map((entry) => (entry.payload as { path: string }).path)
    expect(paths).toEqual([A])
  })

  it('refreshes the active tab when its task finishes', async () => {
    await useStore.getState().openRepo(A)
    calls.length = 0
    useStore.getState().handleTaskEvent({ taskId: 't3', kind: 'push', phase: 'end', repoPath: A })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const channels = calls.map((entry) => entry.channel)
    expect(channels).toContain('git.status')
    expect(channels).toContain('git.log')
  })

  it('keeps a second task visible until its own end event', async () => {
    await useStore.getState().openRepo(A)
    await useStore.getState().openRepo(B)
    useStore.getState().handleTaskEvent({ taskId: 't1', kind: 'fetch', phase: 'start', repoPath: A, text: 'Fetching' })
    useStore.getState().handleTaskEvent({ taskId: 't2', kind: 'push', phase: 'start', repoPath: B, text: 'Pushing' })
    expect(useStore.getState().task?.taskId).toBe('t2')

    useStore.getState().handleTaskEvent({ taskId: 't1', kind: 'fetch', phase: 'end', repoPath: A })
    expect(useStore.getState().task?.taskId).toBe('t2')

    useStore.getState().handleTaskEvent({ taskId: 't2', kind: 'push', phase: 'end', repoPath: B })
    expect(useStore.getState().task).toBeNull()
  })

  it('styles console errors as stderr on the originating tab', async () => {
    await useStore.getState().openRepo(A)
    useStore.getState().handleTaskEvent({ taskId: 't4', kind: 'console', phase: 'start', repoPath: A })
    useStore.getState().handleTaskEvent({
      taskId: 't4',
      kind: 'console',
      phase: 'error',
      repoPath: A,
      text: 'fatal: not a git repository'
    })
    const line = useStore.getState().tabs[0].consoleLines.at(-1)
    expect(line?.stream).toBe('stderr')
  })
})

describe('repository drafts', () => {
  it('keeps a commit draft per repository across tab switches', async () => {
    await useStore.getState().openRepo(A)
    useStore.getState().setCommitDraft({ message: 'feat: alpha', amend: true, signoff: true })
    expect(useStore.getState().commitMessage).toBe('feat: alpha')

    await useStore.getState().openRepo(B)
    expect(useStore.getState().commitMessage).toBe('')
    expect(useStore.getState().commitAmend).toBe(false)
    expect(useStore.getState().commitSignoff).toBe(false)

    useStore.getState().activateTab(A)
    expect(useStore.getState().commitMessage).toBe('feat: alpha')
    expect(useStore.getState().commitAmend).toBe(true)
    expect(useStore.getState().commitSignoff).toBe(true)
    expect(useStore.getState().tabs.find((tab) => tab.id === A)?.commitMessage).toBe('feat: alpha')
  })

  it('clears the commit draft of the active repository only', async () => {
    await useStore.getState().openRepo(A)
    useStore.getState().setCommitDraft({ message: 'alpha message' })
    await useStore.getState().openRepo(B)
    useStore.getState().setCommitDraft({ message: 'beta message' })

    useStore.getState().clearCommitDraft()
    expect(useStore.getState().commitMessage).toBe('')
    expect(useStore.getState().tabs.find((tab) => tab.id === B)?.commitMessage).toBe('')

    useStore.getState().activateTab(A)
    expect(useStore.getState().commitMessage).toBe('alpha message')
  })

  it('keys conflict drafts by repository, file and baseline', async () => {
    await useStore.getState().openRepo(A)
    const sha = 'a'.repeat(64)
    const alphaKey = conflictDraftKey(A, 'src/app.ts', sha)
    const otherShaKey = conflictDraftKey(A, 'src/app.ts', 'b'.repeat(64))
    useStore.getState().saveConflictDraft(alphaKey, { output: 'ours\n', eol: '\n', updatedAt: 1 })
    useStore.getState().saveConflictDraft(otherShaKey, { output: 'stale\n', eol: '\r\n', updatedAt: 2 })
    expect(useStore.getState().conflictDrafts[alphaKey]?.output).toBe('ours\n')

    await useStore.getState().openRepo(B)
    expect(useStore.getState().conflictDrafts[alphaKey]).toBeUndefined()
    const betaKey = conflictDraftKey(B, 'src/app.ts', sha)
    useStore.getState().saveConflictDraft(betaKey, { output: 'beta\n', eol: '\n', updatedAt: 3 })
    expect(useStore.getState().conflictDrafts[betaKey]?.output).toBe('beta\n')
    expect(useStore.getState().tabs.find((tab) => tab.id === A)?.conflictDrafts[betaKey]).toBeUndefined()

    useStore.getState().activateTab(A)
    expect(useStore.getState().conflictDrafts[alphaKey]?.output).toBe('ours\n')
    expect(useStore.getState().conflictDrafts[otherShaKey]?.eol).toBe('\r\n')
    expect(useStore.getState().conflictDrafts[betaKey]).toBeUndefined()
  })

  it('clears every baseline draft for a saved file and leaves other files alone', async () => {
    await useStore.getState().openRepo(A)
    const fileKey = conflictDraftKey(A, 'src/app.ts', 'a'.repeat(64))
    const oldFileKey = conflictDraftKey(A, 'src/app.ts', 'c'.repeat(64))
    const otherFileKey = conflictDraftKey(A, 'src/other.ts', 'd'.repeat(64))
    useStore.getState().saveConflictDraft(fileKey, { output: 'one\n', eol: '\n', updatedAt: 1 })
    useStore.getState().saveConflictDraft(oldFileKey, { output: 'two\n', eol: '\n', updatedAt: 2 })
    useStore.getState().saveConflictDraft(otherFileKey, { output: 'three\n', eol: '\n', updatedAt: 3 })

    useStore.getState().clearConflictDrafts(A, 'src/app.ts')
    const drafts = useStore.getState().conflictDrafts
    expect(drafts[fileKey]).toBeUndefined()
    expect(drafts[oldFileKey]).toBeUndefined()
    expect(drafts[otherFileKey]?.output).toBe('three\n')
  })

  it('writes an addressed tab draft without mirroring it into the active tab', async () => {
    await useStore.getState().openRepo(A)
    await useStore.getState().openRepo(B)
    useStore.getState().updateTab(A, { commitMessage: 'alpha only' })
    expect(useStore.getState().commitMessage).toBe('')
    expect(useStore.getState().tabs.find((tab) => tab.id === A)?.commitMessage).toBe('alpha only')
    expect(useStore.getState().tabs.find((tab) => tab.id === B)?.commitMessage).toBe('')
  })
})

describe('operation notices', () => {
  it('never announces a conflict or failure as success', () => {
    const ok = operationNotice(
      { status: 'ok', output: '', conflictFiles: [], inProgress: false },
      'Merged feature',
      'Merge of feature'
    )
    expect(ok).toEqual({ kind: 'success', message: 'Merged feature' })

    const conflict = operationNotice(
      { status: 'conflict', output: 'CONFLICT', conflictFiles: ['src/app.ts'], inProgress: true },
      'Merged feature',
      'Merge of feature'
    )
    expect(conflict.kind).toBe('info')
    expect(conflict.message).toContain('1 conflicted file')
    expect(conflict.message).toContain('Continue')

    const failed = operationNotice(
      { status: 'failed', output: 'fatal: not possible to fast-forward', conflictFiles: [], inProgress: false },
      'Merged feature',
      'Merge of feature'
    )
    expect(failed.kind).toBe('error')
    expect(failed.message).toBe('fatal: not possible to fast-forward')

    const emptyFailure = operationNotice(
      { status: 'failed', output: '  ', conflictFiles: [], inProgress: false },
      'Merged feature',
      'Merge of feature'
    )
    expect(emptyFailure.kind).toBe('error')
    expect(emptyFailure.message).toBe('Merge of feature failed')
  })

  it('reports a failed discard with Git output instead of success', () => {
    expect(
      discardNotice({ status: 'ok', restored: ['a.txt'], cleaned: [], failed: [], output: '' })
    ).toEqual({ kind: 'success', message: 'Changes discarded' })
    const failed = discardNotice({
      status: 'failed',
      restored: [],
      cleaned: [],
      failed: ['a.txt'],
      output: 'error: could not resolve HEAD'
    })
    expect(failed.kind).toBe('error')
    expect(failed.message).toBe('error: could not resolve HEAD')
  })
})

describe('identity selection', () => {
  it('sends only a repository identity choice, never the application default', async () => {
    const identities: AppConfig['identities'] = [
      {
        id: 'app-default',
        label: 'Application',
        name: 'App Default',
        email: 'app@example.com',
        isDefault: true,
        createdAt: 0
      }
    ]
    useStore.setState({ config: { ...config, identities } })
    await useStore.getState().openRepo(A)
    // The tab has no repository default: main must be free to prefer the
    // repository-local user.name/user.email before the application default.
    expect(selectedIdentityId()).toBeUndefined()

    useStore.setState({
      config: {
        ...config,
        identities,
        repoDefaults: { [A]: { identityId: 'app-default', integrationByProvider: {} } }
      }
    })
    useStore.getState().updateTab(A, {
      repoDefaults: { identityId: 'app-default', integrationByProvider: {} }
    })
    expect(selectedIdentityId()).toBe('app-default')
  })
})

describe('sidebar refs mode', () => {
  it('opens the refs mode and keeps the sidebar visible', async () => {
    await useStore.getState().openRepo(A)
    useStore.setState({ sidebarOpen: false })
    useStore.getState().setSidebarMode('refs')
    expect(useStore.getState().sidebarMode).toBe('refs')
    expect(useStore.getState().sidebarOpen).toBe(true)
  })

  it('toggles between navigate and refs', async () => {
    await useStore.getState().openRepo(A)
    expect(useStore.getState().sidebarMode).toBe('navigate')
    useStore.getState().toggleRefsPanel()
    expect(useStore.getState().sidebarMode).toBe('refs')
    useStore.getState().toggleRefsPanel()
    expect(useStore.getState().sidebarMode).toBe('navigate')
  })

  it('falls back to navigate when no repository is open', () => {
    useStore.getState().toggleRefsPanel()
    expect(useStore.getState().sidebarMode).toBe('navigate')
    expect(useStore.getState().sidebarOpen).toBe(true)
    expect(useStore.getState().toasts.at(-1)?.message).toContain('Open a repository')
  })

  it('keeps the refs mode across tab switches', async () => {
    await useStore.getState().openRepo(A)
    useStore.getState().setSidebarMode('refs')
    await useStore.getState().openRepo(B)
    expect(useStore.getState().activeTabId).toBe(B)
    expect(useStore.getState().sidebarMode).toBe('refs')
  })
})
