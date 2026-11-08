import type { RefInfo, WorktreeInfo } from '@shared/types'

export interface BranchFolderGroup {
  folder: string
  branches: RefInfo[]
}

export interface RemoteBranchGroup {
  remote: string
  groups: BranchFolderGroup[]
}

/** Everything before the last slash, so `feature/ui/tabs` groups under `feature/ui`. */
export function branchFolder(shortName: string): string {
  const index = shortName.lastIndexOf('/')
  return index > 0 ? shortName.slice(0, index) : ''
}

export function branchLeaf(shortName: string): string {
  const index = shortName.lastIndexOf('/')
  return index >= 0 ? shortName.slice(index + 1) : shortName
}

export function remoteNameOf(shortName: string): string {
  const index = shortName.indexOf('/')
  return index >= 0 ? shortName.slice(0, index) : shortName
}

/** `origin/feature/x` -> `feature/x`, the name a local tracking branch would use. */
export function localNameForRemote(shortName: string): string {
  const index = shortName.indexOf('/')
  return index >= 0 ? shortName.slice(index + 1) : shortName
}

function byName(a: RefInfo, b: RefInfo): number {
  return a.shortName.localeCompare(b.shortName)
}

function folderGroups(branches: RefInfo[], nameOf: (branch: RefInfo) => string): BranchFolderGroup[] {
  const groups = new Map<string, RefInfo[]>()
  for (const branch of branches) {
    const folder = branchFolder(nameOf(branch))
    const list = groups.get(folder)
    if (list) list.push(branch)
    else groups.set(folder, [branch])
  }
  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (!left) return -1
      if (!right) return 1
      return left.localeCompare(right)
    })
    .map(([folder, items]) => ({ folder, branches: items }))
}

/** Local branches grouped by folder, with the current branch first inside its group. */
export function groupLocalBranches(branches: RefInfo[]): BranchFolderGroup[] {
  const locals = branches
    .filter((branch) => branch.type === 'branch')
    .sort((a, b) => Number(Boolean(b.isCurrent)) - Number(Boolean(a.isCurrent)) || byName(a, b))
  return folderGroups(locals, (branch) => branch.shortName)
}

/** Remote branches grouped by remote, then by the folder of the tracking name. */
export function groupRemoteBranches(branches: RefInfo[]): RemoteBranchGroup[] {
  const remotes = new Map<string, RefInfo[]>()
  for (const branch of branches.filter((item) => item.type === 'remote')) {
    const remote = remoteNameOf(branch.shortName)
    const list = remotes.get(remote)
    if (list) list.push(branch)
    else remotes.set(remote, [branch])
  }
  return [...remotes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([remote, items]) => ({
      remote,
      groups: folderGroups(items.sort(byName), (branch) => localNameForRemote(branch.shortName))
    }))
}

export function findWorktreeForBranch(worktrees: WorktreeInfo[], branch: string | null): WorktreeInfo | undefined {
  if (!branch) return undefined
  return worktrees.find((worktree) => worktree.branch === branch)
}

/**
 * The main checkout is the repository itself, not a folder the user created as
 * a worktree. Keeping it out of the worktree section avoids showing the current
 * branch twice; linked worktrees are the rows the panel can switch to.
 */
export function linkedWorktrees(worktrees: WorktreeInfo[]): WorktreeInfo[] {
  return worktrees.filter((worktree) => !worktree.isMain)
}

export function matchesQuery(query: string, ...values: Array<string | null | undefined>): boolean {
  const term = query.trim().toLowerCase()
  if (!term) return true
  return values.some((value) => Boolean(value && value.toLowerCase().includes(term)))
}

/** Safe folder name for a worktree created from a branch. */
export function worktreeDirectoryName(repoName: string, branch: string): string {
  const clean = (value: string, fallback: string): string =>
    value
      .trim()
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  return `${clean(repoName, 'repo')}-${clean(branch, 'worktree')}`.slice(0, 90)
}

export function pathBaseName(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

export function parentPath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index < 0) return ''
  if (index === 0) return '/'
  // Keep the drive/UNC root intact: `C:\app` -> `C:\`, not `C:`.
  if (index === 2 && /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed.slice(0, 3)
  return trimmed.slice(0, index)
}

export function joinPath(parent: string, child: string, platform: string): string {
  const separator = platform === 'win32' || parent.includes('\\') ? '\\' : '/'
  return `${parent.replace(/[\\/]+$/, '')}${separator}${child}`
}

/**
 * Sibling folder by default, or the configured parent when one is set.
 * The repository base name comes from the main worktree so a linked worktree
 * never produces `app-feature-feature-...`.
 */
export function defaultWorktreePath(
  mainWorktreePath: string,
  branch: string,
  configuredParent: string | undefined,
  platform: string
): string {
  const parent = configuredParent?.trim() ? configuredParent.trim() : parentPath(mainWorktreePath)
  const name = worktreeDirectoryName(pathBaseName(mainWorktreePath), branch)
  return joinPath(parent, name, platform)
}

export type RefSectionId = 'local' | 'remote' | 'worktrees' | 'stashes' | 'tags'

/** Bottom stack order, top to bottom. Keep in step with the section order in RefsPanel. */
export const BOTTOM_REF_SECTIONS: RefSectionId[] = ['remote', 'worktrees', 'stashes', 'tags']

/** Mirrored by `.refs-section` in app.css. */
export const REF_SECTION_HEADER_HEIGHT = 33
/** Mirrored by `.refs-section.is-bottom.is-expanded` in app.css. */
export const REF_SECTION_MIN_HEIGHT = 76
/** Mirrored by `.refs-section.is-top.is-expanded` in app.css. */
export const REF_LOCAL_MIN_HEIGHT = 96

/**
 * Vertical space the expanded bottom panes may use: the panel body minus Local
 * (a minimum when it has rows and is expanded, its header otherwise) and the
 * header of every bottom section that is not an expanded pane.
 */
export function refSectionBudget(
  bodyHeight: number,
  localExpanded: boolean,
  headerOnlyBottom: number
): number {
  const local = localExpanded ? REF_LOCAL_MIN_HEIGHT : REF_SECTION_HEADER_HEIGHT
  const available = bodyHeight - local - headerOnlyBottom * REF_SECTION_HEADER_HEIGHT
  return Math.max(REF_SECTION_MIN_HEIGHT, available)
}

export interface RefSectionSizing {
  /** Stored heights; absent entries fall back to `fallback`. */
  heights: Partial<Record<RefSectionId, number>>
  /** Expanded bottom sections, in display order. */
  open: RefSectionId[]
  /** Section whose splitter is being dragged. */
  resized: RefSectionId
  requested: number
  /** Pixels shared by the bottom sections. */
  budget: number
  minimum: number
  fallback: number
}

/**
 * Fits stored heights into the budget after the panel or the open set changes:
 * open panes without a height start at `fallback`, and overflow is shaved
 * proportionally from everyone's spare room without going below `minimum`.
 */
export function fitRefSections(
  heights: Partial<Record<RefSectionId, number>>,
  open: RefSectionId[],
  budget: number,
  minimum: number,
  fallback: number
): Partial<Record<RefSectionId, number>> {
  const next: Partial<Record<RefSectionId, number>> = { ...heights }
  for (const id of open) next[id] = heights[id] ?? fallback
  const total = open.reduce((sum, id) => sum + (next[id] ?? 0), 0)
  const overflow = total - budget
  if (overflow <= 0 || open.length === 0) return next

  const spare = open.reduce((sum, id) => sum + Math.max(0, (next[id] ?? 0) - minimum), 0)
  if (spare <= 0) return next
  const take = Math.min(overflow, spare)
  for (const id of open) {
    const room = Math.max(0, (next[id] ?? 0) - minimum)
    next[id] = (next[id] ?? 0) - Math.min(room, Math.round((room / spare) * take))
  }
  const left = open.reduce((sum, id) => sum + (next[id] ?? 0), 0) - budget
  if (left > 0) {
    const largest = open.reduce((best, id) => ((next[id] ?? 0) > (next[best] ?? 0) ? id : best), open[0])
    next[largest] = Math.max(minimum, (next[largest] ?? 0) - left)
  }
  return next
}

/**
 * Height of every bottom section after moving one splitter. The resized section
 * is clamped so the others can stay at their minimum, then any overflow left by
 * their stored heights is taken from them in proportion to their spare room.
 * That keeps a drag one pixel per pixel instead of fighting flex-shrink.
 */
export function sizeRefSections(input: RefSectionSizing): Partial<Record<RefSectionId, number>> {
  const { heights, open, resized, requested, budget, minimum, fallback } = input
  const next: Partial<Record<RefSectionId, number>> = { ...heights }
  for (const id of open) next[id] = heights[id] ?? fallback
  const others = open.filter((id) => id !== resized)
  const maximum = Math.max(minimum, budget - others.length * minimum)
  next[resized] = Math.min(Math.max(minimum, Math.round(requested)), maximum)

  const total = open.reduce((sum, id) => sum + (next[id] ?? 0), 0)
  const overflow = total - budget
  if (overflow > 0 && others.length > 0) {
    const spare = others.reduce((sum, id) => sum + Math.max(0, (next[id] ?? 0) - minimum), 0)
    if (spare > 0) {
      const take = Math.min(overflow, spare)
      for (const id of others) {
        const room = Math.max(0, (next[id] ?? 0) - minimum)
        const share = Math.min(room, Math.round((room / spare) * take))
        next[id] = (next[id] ?? 0) - share
      }
      const left = open.reduce((sum, id) => sum + (next[id] ?? 0), 0) - budget
      if (left > 0) next[resized] = Math.max(minimum, (next[resized] ?? 0) - left)
    }
  }
  return next
}