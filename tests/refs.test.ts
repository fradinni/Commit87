import { describe, expect, it } from 'vitest'
import type { RefInfo, WorktreeInfo } from '../src/shared/types'
import {
  BOTTOM_REF_SECTIONS,
  branchFolder,
  branchLeaf,
  defaultWorktreePath,
  findWorktreeForBranch,
  fitRefSections,
  groupLocalBranches,
  groupRemoteBranches,
  linkedWorktrees,
  localNameForRemote,
  matchesQuery,
  parentPath,
  pathBaseName,
  refSectionBudget,
  remoteNameOf,
  sizeRefSections,
  worktreeDirectoryName
} from '../src/renderer/src/lib/refs'

function branch(shortName: string, current = false, type: RefInfo['type'] = 'branch'): RefInfo {
  return {
    name: type === 'remote' ? `refs/remotes/${shortName}` : `refs/heads/${shortName}`,
    shortName,
    type,
    sha: shortName,
    isCurrent: current
  }
}

function worktree(path: string, branchName: string | null, current = false, main = false): WorktreeInfo {
  return {
    path,
    head: 'abc123',
    branch: branchName,
    bare: false,
    detached: branchName === null,
    locked: false,
    prunable: false,
    isMain: main,
    isCurrent: current
  }
}

describe('ref grouping', () => {
  it('groups local branches by folder with the current branch first', () => {
    const groups = groupLocalBranches([
      branch('main', true),
      branch('feature/b'),
      branch('feature/a'),
      branch('bug/fix')
    ])
    expect(groups.map((group) => group.folder)).toEqual(['', 'bug', 'feature'])
    expect(groups[0].branches.map((item) => item.shortName)).toEqual(['main'])
    expect(groups[2].branches.map((item) => item.shortName)).toEqual(['feature/a', 'feature/b'])
  })

  it('puts the current branch first inside its own folder', () => {
    const groups = groupLocalBranches([
      branch('feature/a'),
      branch('feature/current', true),
      branch('feature/z')
    ])
    expect(groups[0].branches.map((item) => item.shortName)).toEqual(['feature/current', 'feature/a', 'feature/z'])
  })

  it('groups remote branches by remote and tracking folder', () => {
    const groups = groupRemoteBranches([
      branch('origin/main', false, 'remote'),
      branch('origin/feature/a', false, 'remote'),
      branch('upstream/feature/b', false, 'remote')
    ])
    expect(groups.map((group) => group.remote)).toEqual(['origin', 'upstream'])
    expect(groups[0].groups.map((group) => group.folder)).toEqual(['', 'feature'])
    expect(groups[0].groups[1].branches.map((item) => item.shortName)).toEqual(['origin/feature/a'])
  })

  it('extracts folder, leaf and remote names', () => {
    expect(branchFolder('main')).toBe('')
    expect(branchFolder('feature/ui/tabs')).toBe('feature/ui')
    expect(branchLeaf('feature/ui/tabs')).toBe('tabs')
    expect(remoteNameOf('origin/feature/ui')).toBe('origin')
    expect(localNameForRemote('origin/feature/ui')).toBe('feature/ui')
    expect(localNameForRemote('main')).toBe('main')
  })

  it('matches a query across several fields', () => {
    expect(matchesQuery('  UI ', 'feature/ui', 'Alice')).toBe(true)
    expect(matchesQuery('alice', 'feature/ui', 'Alice')).toBe(true)
    expect(matchesQuery('missing', 'feature/ui', 'Alice')).toBe(false)
    expect(matchesQuery('', 'anything')).toBe(true)
  })
})

describe('worktree helpers', () => {
  it('finds the worktree that has a branch checked out', () => {
    const worktrees = [worktree('/src/app', 'main', true, true), worktree('/src/feature', 'feature/a')]
    expect(findWorktreeForBranch(worktrees, 'feature/a')?.path).toBe('/src/feature')
    expect(findWorktreeForBranch(worktrees, 'missing')).toBeUndefined()
    expect(findWorktreeForBranch(worktrees, null)).toBeUndefined()
  })

  it('keeps the main checkout out of the linked worktree list', () => {
    const worktrees = [
      worktree('/src/app', 'main', true, true),
      worktree('/src/feature', 'feature/a'),
      worktree('/src/bug', 'bug/b')
    ]
    expect(linkedWorktrees(worktrees).map((item) => item.branch)).toEqual(['feature/a', 'bug/b'])
    expect(linkedWorktrees([worktree('/src/app', 'main', true, true)])).toEqual([])
  })

  it('builds a safe sibling directory name', () => {
    expect(worktreeDirectoryName('app', 'feature/ui')).toBe('app-feature-ui')
    expect(worktreeDirectoryName('app', '  feature//ui  ')).toBe('app-feature-ui')
    expect(worktreeDirectoryName('', '')).toBe('repo-worktree')
  })

  it('derives the parent and base name on POSIX and Windows paths', () => {
    expect(pathBaseName('/home/me/app/')).toBe('app')
    expect(parentPath('/home/me/app')).toBe('/home/me')
    expect(parentPath('/app')).toBe('/')
    expect(pathBaseName('C:\\Work\\app')).toBe('app')
    expect(parentPath('C:\\Work\\app')).toBe('C:\\Work')
    expect(parentPath('C:\\app')).toBe('C:\\')
  })

  it('creates a sibling path by default', () => {
    expect(defaultWorktreePath('/home/me/app', 'feature/ui', undefined, 'linux')).toBe(
      '/home/me/app-feature-ui'
    )
    expect(defaultWorktreePath('C:\\Work\\app', 'feature/ui', undefined, 'win32')).toBe(
      'C:\\Work\\app-feature-ui'
    )
  })

  it('uses a configured parent and still supports a custom folder', () => {
    expect(defaultWorktreePath('/home/me/app', 'bug/fix', '/tmp/worktrees', 'linux')).toBe(
      '/tmp/worktrees/app-bug-fix'
    )
    expect(defaultWorktreePath('/home/me/app', 'bug/fix', '', 'linux')).toBe('/home/me/app-bug-fix')
  })
})

describe('refs panel sizing', () => {
  const sizing = {
    heights: {},
    open: BOTTOM_REF_SECTIONS,
    resized: 'remote' as const,
    budget: 518,
    minimum: 76,
    fallback: 168
  }
  const total = (heights: Partial<Record<string, number>>): number =>
    BOTTOM_REF_SECTIONS.reduce((sum, id) => sum + (heights[id] ?? 0), 0)

  it('clamps a pane to the minimum and to the room the other panes leave', () => {
    expect(sizeRefSections({ ...sizing, requested: 10 }).remote).toBe(76)
    // Four open panes at 76px leave 518 - 3 * 76 for the dragged one.
    expect(sizeRefSections({ ...sizing, requested: 1000 }).remote).toBe(290)
  })

  it('starts missing panes at the fallback and takes overflow from the others', () => {
    const next = sizeRefSections({ ...sizing, requested: 196 })
    expect(next.remote).toBe(196)
    expect(next.worktrees).toBe(107)
    expect(total(next)).toBeLessThanOrEqual(sizing.budget)
  })

  it('leaves the other panes alone when the dragged pane shrinks', () => {
    const heights = { remote: 175, worktrees: 114, stashes: 114, tags: 114 }
    const next = sizeRefSections({ ...sizing, heights, requested: 125 })
    expect(next.remote).toBe(125)
    expect(next.worktrees).toBe(114)
    expect(next.stashes).toBe(114)
    expect(next.tags).toBe(114)
  })

  it('never pushes another pane below its minimum while making room', () => {
    const heights = { remote: 125, worktrees: 125, stashes: 125, tags: 125 }
    const next = sizeRefSections({ ...sizing, heights, requested: 290 })
    expect(next.remote).toBe(290)
    for (const id of BOTTOM_REF_SECTIONS) expect(next[id] ?? 0).toBeGreaterThanOrEqual(sizing.minimum)
    expect(total(next)).toBeLessThanOrEqual(sizing.budget)
  })

  it('restores the starting layout when a drag returns to where it began', () => {
    const heights = { remote: 125, worktrees: 125, stashes: 125, tags: 125 }
    const grown = sizeRefSections({ ...sizing, heights, requested: 176 })
    expect(grown.worktrees).toBeLessThan(125)
    const back = sizeRefSections({ ...sizing, heights, requested: 125 })
    expect(back).toEqual(heights)
  })

  it('reserves collapsed headers and the local section in the budget', () => {
    expect(refSectionBudget(500, true, 1)).toBe(500 - 96 - 33)
    expect(refSectionBudget(500, false, 2)).toBe(500 - 33 - 66)
    expect(refSectionBudget(100, true, 4)).toBe(76)
  })

  it('fits stored heights into a smaller budget and fills missing ones', () => {
    const next = fitRefSections(
      { remote: 168 },
      BOTTOM_REF_SECTIONS,
      400,
      76,
      168
    )
    expect(next.remote).toBeLessThanOrEqual(168)
    for (const id of BOTTOM_REF_SECTIONS) expect(next[id] ?? 0).toBeGreaterThanOrEqual(76)
    expect(total(next)).toBeLessThanOrEqual(400)
  })
})