import { describe, expect, it } from 'vitest'
import {
  applyRepoTabPatch,
  closeTabRecord,
  cycleTabId,
  findTabIndex,
  groupTabs,
  insertTabInGroup,
  moveTabInGroups,
  moveTabToIndex,
  pickRepoTabPatch,
  repoGroupKey,
  repoGroupLabel,
  repoPathKey
} from '../src/renderer/src/lib/tabs'

const tab = (id: string) => ({ id })

interface FakeTab {
  id: string
  status?: string
  view?: string
  toasts?: string[]
}

describe('repository tab helpers', () => {
  it('keys POSIX paths case-sensitively and ignores trailing separators', () => {
    expect(repoPathKey('/home/me/repo/', 'linux')).toBe('/home/me/repo')
    expect(repoPathKey('/home/me/Repo', 'linux')).not.toBe(repoPathKey('/home/me/repo', 'linux'))
  })

  it('keys Windows paths case-insensitively with either separator', () => {
    expect(repoPathKey('C:\\Work\\Repo\\', 'win32')).toBe('c:/work/repo')
    expect(repoPathKey('C:\\WORK\\REPO', 'win32')).toBe(repoPathKey('c:/Work/Repo', 'win32'))
  })

  it('finds tabs by id and rejects missing ids', () => {
    const tabs = [tab('a'), tab('b')]
    expect(findTabIndex(tabs, 'b')).toBe(1)
    expect(findTabIndex(tabs, null)).toBe(-1)
    expect(findTabIndex(tabs, 'missing')).toBe(-1)
  })

  it('closes the active tab and activates its right neighbour', () => {
    const result = closeTabRecord([tab('a'), tab('b'), tab('c')], 'b', 'b')
    expect(result.tabs.map((item) => item.id)).toEqual(['a', 'c'])
    expect(result.activeId).toBe('c')
  })

  it('falls back to the left neighbour when closing the last tab', () => {
    const result = closeTabRecord([tab('a'), tab('b'), tab('c')], 'c', 'c')
    expect(result.activeId).toBe('b')
  })

  it('keeps the active tab when closing an inactive one', () => {
    const result = closeTabRecord([tab('a'), tab('b'), tab('c')], 'a', 'b')
    expect(result.tabs.map((item) => item.id)).toEqual(['a', 'c'])
    expect(result.activeId).toBe('a')
  })

  it('returns to the launchpad after closing the last tab', () => {
    const result = closeTabRecord([tab('a')], 'a', 'a')
    expect(result.tabs).toEqual([])
    expect(result.activeId).toBeNull()
  })

  it('ignores unknown close targets', () => {
    const tabs = [tab('a')]
    expect(closeTabRecord(tabs, 'a', 'missing')).toEqual({ tabs, activeId: 'a' })
  })

  it('cycles tabs in both directions with wrap-around', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    expect(cycleTabId(tabs, 'a', 1)).toBe('b')
    expect(cycleTabId(tabs, 'c', 1)).toBe('a')
    expect(cycleTabId(tabs, 'a', -1)).toBe('c')
    expect(cycleTabId(tabs, 'b', 4)).toBe('c')
  })

  it('falls back to the first tab when the active id is stale', () => {
    expect(cycleTabId([tab('a'), tab('b')], 'gone', 1)).toBe('a')
    expect(cycleTabId([], null, 1)).toBeNull()
  })

  it('moves a tab and clamps the destination index', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    expect(moveTabToIndex(tabs, 'c', 0).map((item) => item.id)).toEqual(['c', 'a', 'b'])
    expect(moveTabToIndex(tabs, 'a', 99).map((item) => item.id)).toEqual(['b', 'c', 'a'])
    expect(moveTabToIndex(tabs, 'a', 0)).toBe(tabs)
    expect(moveTabToIndex(tabs, 'missing', 1)).toBe(tabs)
  })
})

describe('repository tab grouping', () => {
  const main = {
    path: '/src/app',
    gitDir: '/src/app/.git',
    commonDir: '/src/app/.git',
    name: 'app'
  }
  const worktree = {
    path: '/src/worktrees/feature',
    gitDir: '/src/app/.git/worktrees/feature',
    commonDir: '/src/app/.git',
    name: 'feature'
  }

  it('keys a repository and its linked worktrees together', () => {
    expect(repoGroupKey(main, 'linux')).toBe(repoGroupKey(worktree, 'linux'))
    expect(repoGroupKey(main, 'win32')).toBe(repoGroupKey(worktree, 'win32'))
    expect(repoGroupKey(main, 'linux')).not.toBe(repoGroupKey({ ...worktree, commonDir: '/other/.git' }, 'linux'))
  })

  it('labels a group from the shared git directory', () => {
    expect(repoGroupLabel(main)).toBe('app')
    expect(repoGroupLabel(worktree)).toBe('app')
    expect(repoGroupLabel({ path: '/srv/repo.git', gitDir: '/srv/repo.git', commonDir: '/srv/repo.git', name: 'repo' })).toBe('repo')
  })

  it('groups non-adjacent tabs in first-appearance order', () => {
    const tabs = [
      { id: 'a1', group: 'a' },
      { id: 'b1', group: 'b' },
      { id: 'a2', group: 'a' }
    ]
    const groups = groupTabs(tabs, (item) => item.group)
    expect(groups.map((group) => group.key)).toEqual(['a', 'b'])
    expect(groups[0].tabs.map((item) => item.id)).toEqual(['a1', 'a2'])
    expect(groups[0].start).toBe(0)
    expect(groups[1].start).toBe(2)
  })

  it('inserts a new tab next to its existing group', () => {
    const tabs = [
      { id: 'a1', group: 'a' },
      { id: 'b1', group: 'b' }
    ]
    expect(insertTabInGroup(tabs, { id: 'a2', group: 'a' }, (item) => item.group).map((item) => item.id)).toEqual([
      'a1',
      'a2',
      'b1'
    ])
    expect(insertTabInGroup(tabs, { id: 'c1', group: 'c' }, (item) => item.group).map((item) => item.id)).toEqual([
      'a1',
      'b1',
      'c1'
    ])
  })

  it('reorders inside a group without splitting it', () => {
    const tabs = [
      { id: 'a1', group: 'a' },
      { id: 'a2', group: 'a' },
      { id: 'b1', group: 'b' }
    ]
    expect(moveTabInGroups(tabs, 'a2', 0, (item) => item.group).map((item) => item.id)).toEqual(['a2', 'a1', 'b1'])
  })

  it('moves a whole group past another group', () => {
    const tabs = [
      { id: 'a1', group: 'a' },
      { id: 'a2', group: 'a' },
      { id: 'b1', group: 'b' }
    ]
    expect(moveTabInGroups(tabs, 'a1', 2, (item) => item.group).map((item) => item.id)).toEqual(['b1', 'a1', 'a2'])
    expect(moveTabInGroups(tabs, 'b1', 0, (item) => item.group).map((item) => item.id)).toEqual(['b1', 'a1', 'a2'])
  })
})

describe('active tab patch mirroring', () => {
  const tabs: FakeTab[] = [{ id: 'a', status: 'clean', view: 'graph' }, { id: 'b', status: 'dirty', view: 'files' }]

  it('picks only repository-owned fields', () => {
    expect(pickRepoTabPatch({ status: 'dirty', view: 'tags', toasts: ['x'], ready: true })).toEqual({
      status: 'dirty',
      view: 'tags'
    })
    expect(pickRepoTabPatch({ toasts: ['x'], ready: true })).toBeNull()
  })

  it('writes a patch into the active tab only', () => {
    const next = applyRepoTabPatch(tabs, 'a', { status: 'dirty', view: 'tags', toasts: ['x'] })
    expect(next).not.toBeNull()
    expect(next).toEqual([
      { id: 'a', status: 'dirty', view: 'tags' },
      { id: 'b', status: 'dirty', view: 'files' }
    ])
    // The input array is never mutated.
    expect(tabs[0]).toEqual({ id: 'a', status: 'clean', view: 'graph' })
  })

  it('returns null when there is no active tab or nothing to mirror', () => {
    expect(applyRepoTabPatch(tabs, null, { status: 'dirty' })).toBeNull()
    expect(applyRepoTabPatch(tabs, 'missing', { status: 'dirty' })).toBeNull()
    expect(applyRepoTabPatch(tabs, 'a', { toasts: ['x'] })).toBeNull()
  })

  it('allows clearing a repository field to null or undefined', () => {
    const next = applyRepoTabPatch(tabs, 'b', { status: null })
    expect(next?.[1].status).toBeNull()
  })

  it('mirrors commit and conflict drafts with the repository tab', () => {
    const conflictDrafts = {
      '/repo\u0000src/app.ts\u0000abc': { output: 'ours\n', eol: '\n' as const, updatedAt: 1 }
    }
    const patch = { commitMessage: 'wip: draft', commitAmend: true, commitSignoff: true, conflictDrafts }
    expect(pickRepoTabPatch(patch)).toEqual(patch)

    const next = applyRepoTabPatch(tabs, 'a', patch)
    expect(next?.[0]).toMatchObject(patch)
    expect(next?.[1]).toEqual(tabs[1])
    expect(tabs[0]).not.toMatchObject(patch)
  })
})
