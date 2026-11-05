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
