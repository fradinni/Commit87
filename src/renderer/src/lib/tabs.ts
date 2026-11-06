export interface TabLike {
  id: string
}

/**
 * Repository paths are compared the way the usual host filesystem does:
 * case-sensitive on Linux and case-insensitive on Windows and macOS. Trailing separators are ignored so
 * `/repo` and `/repo/` are the same tab.
 */
export function repoPathKey(repoPath: string, platform: string): string {
  const trimmed = repoPath.replace(/[\\/]+$/, '')
  return platform === 'win32' ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed
}

export function findTabIndex<T extends TabLike>(tabs: T[], id: string | null | undefined): number {
  if (!id) return -1
  return tabs.findIndex((tab) => tab.id === id)
}

/** Closing the active tab selects its right neighbour, or the left one at the end. */
export function closeTabRecord<T extends TabLike>(
  tabs: T[],
  activeId: string | null,
  targetId: string
): { tabs: T[]; activeId: string | null } {
  const index = findTabIndex(tabs, targetId)
  if (index < 0) return { tabs, activeId }
  const remaining = tabs.filter((tab) => tab.id !== targetId)
  if (activeId !== targetId) return { tabs: remaining, activeId }
  const next = remaining[Math.min(index, remaining.length - 1)]
  return { tabs: remaining, activeId: next?.id ?? null }
}

/** Cycles with wrap-around. A stale active id falls back to the first tab. */
export function cycleTabId<T extends TabLike>(tabs: T[], activeId: string | null, delta: number): string | null {
  if (!tabs.length) return null
  const index = findTabIndex(tabs, activeId)
  if (index < 0) return tabs[0].id
  const next = (index + delta + tabs.length) % tabs.length
  return tabs[next].id
}

export function moveTabToIndex<T extends TabLike>(tabs: T[], id: string, index: number): T[] {
  const from = findTabIndex(tabs, id)
  if (from < 0) return tabs
  const to = Math.max(0, Math.min(index, tabs.length - 1))
  if (from === to) return tabs
  const next = [...tabs]
  const [tab] = next.splice(from, 1)
  next.splice(to, 0, tab)
  return next
}

/** The parts of a repository needed to recognise its worktrees as one family. */
export interface RepoGroupInfo {
  path: string
  gitDir: string
  commonDir?: string
  name: string
}

/**
 * A repository and every linked worktree share one Git common directory. Tabs
 * are grouped by this key so worktrees never drift away from their repository.
 */
export function repoGroupKey(repo: RepoGroupInfo, platform: string): string {
  return repoPathKey(repo.commonDir || repo.gitDir, platform)
}

export function repoGroupLabel(repo: RepoGroupInfo): string {
  const common = (repo.commonDir || repo.gitDir).replace(/[\\/]+$/, '')
  const base = common.split(/[\\/]/).pop() ?? ''
  const parent = base.toLowerCase() === '.git' ? common.slice(0, -4).replace(/[\\/]+$/, '') : common
  const label = parent.split(/[\\/]/).pop() ?? ''
  return label.replace(/\.git$/i, '') || repo.name
}

export interface TabGroup<T extends TabLike> {
  key: string
  tabs: T[]
  /** Flat index of the group's first tab. */
  start: number
}

/**
 * Groups tabs by repository while keeping groups in order of first appearance
 * and members in their existing order. Non-adjacent members are pulled together.
 */
export function groupTabs<T extends TabLike>(tabs: T[], groupOf: (tab: T) => string): TabGroup<T>[] {
  const order: string[] = []
  const members = new Map<string, T[]>()
  for (const tab of tabs) {
    const key = groupOf(tab)
    let list = members.get(key)
    if (!list) {
      list = []
      members.set(key, list)
      order.push(key)
    }
    list.push(tab)
  }
  let start = 0
  return order.map((key) => {
    const group = { key, tabs: members.get(key) ?? [], start }
    start += group.tabs.length
    return group
  })
}

/** Opens a tab next to the existing tabs of the same repository family. */
export function insertTabInGroup<T extends TabLike>(tabs: T[], tab: T, groupOf: (item: T) => string): T[] {
  const key = groupOf(tab)
  const next = [...tabs]
  let last = -1
  next.forEach((item, index) => {
    if (groupOf(item) === key) last = index
  })
  if (last < 0) next.push(tab)
  else next.splice(last + 1, 0, tab)
  return next
}

/**
 * Reorders a tab without ever splitting it from its repository group: a drag
 * inside the group moves the tab, a drag past another group moves the whole
 * family. Groups therefore stay contiguous in the tab strip.
 */
export function moveTabInGroups<T extends TabLike>(
  tabs: T[],
  id: string,
  index: number,
  groupOf: (tab: T) => string
): T[] {
  const from = findTabIndex(tabs, id)
  if (from < 0) return tabs
  const groups = groupTabs(tabs, groupOf)
  const groupIndex = groups.findIndex((group) => group.tabs.some((tab) => tab.id === id))
  if (groupIndex < 0) return tabs
  const group = groups[groupIndex]
  const to = Math.max(0, Math.min(index, tabs.length - 1))
  if (to >= group.start && to < group.start + group.tabs.length) {
    return moveTabToIndex(tabs, id, to)
  }

  const rest = groups.filter((_, position) => position !== groupIndex)
  const target = tabs[to]
  const targetIndex = target
    ? rest.findIndex((item) => item.tabs.some((tab) => tab.id === target.id))
    : -1
  const insertAt = targetIndex < 0 ? rest.length : from < to ? targetIndex + 1 : targetIndex
  return [...rest.slice(0, insertAt), group, ...rest.slice(insertAt)].flatMap((item) => item.tabs)
}

/**
 * Fields a repository tab owns. The store keeps a flat mirror of these for the
 * active tab so views can keep their plain selectors; writes are copied back
 * into the owning tab record before the mirror moves on.
 */
export const REPO_TAB_KEYS = [
  'currentRepo',
  'repoDefaults',
  'detection',
  'status',
  'commits',
  'branches',
  'tags',
  'worktrees',
  'stashes',
  'submodules',
  'pulls',
  'view',
  'selectedCommit',
  'graphQuery',
  'graphBranch',
  'consoleLines'
] as const

export type RepoTabKey = (typeof REPO_TAB_KEYS)[number]

export function pickRepoTabPatch(patch: Record<string, unknown>): Record<string, unknown> | null {
  const next: Record<string, unknown> = {}
  let has = false
  for (const key of REPO_TAB_KEYS) {
    if (key in patch) {
      next[key] = patch[key]
      has = true
    }
  }
  return has ? next : null
}

/** Returns updated tabs when the patch touches repo-owned fields, otherwise null. */
export function applyRepoTabPatch<T extends TabLike>(
  tabs: T[],
  activeId: string | null,
  patch: Record<string, unknown>
): T[] | null {
  if (!activeId) return null
  const repoPatch = pickRepoTabPatch(patch)
  if (!repoPatch) return null
  let found = false
  const next = tabs.map((tab) => {
    if (tab.id !== activeId) return tab
    found = true
    return { ...tab, ...repoPatch } as T
  })
  return found ? next : null
}
