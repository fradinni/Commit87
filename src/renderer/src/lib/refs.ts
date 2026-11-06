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