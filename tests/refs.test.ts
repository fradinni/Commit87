import { describe, expect, it } from 'vitest'
import type { RefInfo, WorktreeInfo } from '../src/shared/types'
import {
  branchFolder,
  branchLeaf,
  defaultWorktreePath,
  findWorktreeForBranch,
  groupLocalBranches,
  groupRemoteBranches,
  localNameForRemote,
  matchesQuery,
  parentPath,
  pathBaseName,
  remoteNameOf,
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