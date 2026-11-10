import { describe, expect, it } from 'vitest'
import type { StatusFile } from '../src/shared/types'
import { actionPaths, fileFacets, stagePaths } from '../src/renderer/src/lib/files'
import { createRequestGuard } from '../src/renderer/src/lib/request'

function statusFile(overrides: Partial<StatusFile>): StatusFile {
  return {
    path: 'file.txt',
    index: '.',
    worktree: '.',
    stage: 'unstaged',
    label: 'Modified',
    ...overrides
  }
}

describe('file facets', () => {
  it('exposes both sides of a file that is staged and modified again', () => {
    const facets = fileFacets(statusFile({ index: 'M', worktree: 'M', stage: 'staged', label: 'Staged + modified' }))
    expect(facets).toHaveLength(2)
    expect(facets.map((facet) => [facet.side, facet.stage, facet.code])).toEqual([
      ['index', 'staged', 'M'],
      ['worktree', 'unstaged', 'M']
    ])
    expect(new Set(facets.map((facet) => facet.key)).size).toBe(2)
    expect(facets.every((facet) => facet.path === 'file.txt')).toBe(true)
  })

  it('keeps the worktree half of an added-then-modified file', () => {
    const facets = fileFacets(statusFile({ index: 'A', worktree: 'M', stage: 'staged', label: 'Staged + modified' }))
    expect(facets.map((facet) => [facet.side, facet.code, facet.label])).toEqual([
      ['index', 'A', 'Added'],
      ['worktree', 'M', 'Modified']
    ])
  })

  it('keeps a modified staged rename as one pair with two review sides', () => {
    const file = statusFile({
      path: 'new.txt',
      origPath: 'old.txt',
      index: 'R',
      worktree: 'M',
      stage: 'staged',
      label: 'Staged + modified',
      rename: true
    })
    const facets = fileFacets(file)
    expect(facets.map((facet) => [facet.side, facet.code, facet.path])).toEqual([
      ['index', 'R', 'new.txt'],
      ['worktree', 'M', 'new.txt']
    ])
    // Unstage/discard still cover the rename pair, stage only the destination.
    expect(actionPaths(file)).toEqual(['old.txt', 'new.txt'])
    expect(actionPaths(facets[0].file)).toEqual(['old.txt', 'new.txt'])
    expect(stagePaths(file)).toEqual(['new.txt'])
    expect(stagePaths(facets[1].file)).toEqual(['new.txt'])
  })

  it('gives an untracked file one content facet', () => {
    const facets = fileFacets(statusFile({ index: '?', worktree: '?', stage: 'untracked', label: 'Untracked' }))
    expect(facets).toHaveLength(1)
    expect(facets[0]).toMatchObject({ side: 'worktree', code: 'U', stage: 'untracked', label: 'Untracked' })
  })

  it('gives a conflicted file one content facet with no review side', () => {
    const facets = fileFacets(statusFile({ index: 'U', worktree: 'U', stage: 'conflicted', label: 'Conflicted' }))
    expect(facets).toHaveLength(1)
    expect(facets[0]).toMatchObject({ side: 'worktree', code: '!', stage: 'conflicted', label: 'Conflicted' })
  })

  it('reports a only-staged change on the index side', () => {
    const facets = fileFacets(statusFile({ index: 'M', worktree: '.', stage: 'staged', label: 'Modified' }))
    expect(facets).toHaveLength(1)
    expect(facets[0]).toMatchObject({ side: 'index', stage: 'staged', code: 'M' })
  })

  it('never drops an entry with no marked column', () => {
    const facets = fileFacets(statusFile({ stage: 'staged', label: 'Staged' }))
    expect(facets).toHaveLength(1)
    expect(facets[0]).toMatchObject({ side: 'index', stage: 'staged' })
  })
})

describe('request identity guard', () => {
  it('rejects a response that finishes after a newer request began', async () => {
    const guard = createRequestGuard()
    const applied: string[] = []
    const pending: Array<() => void> = []
    const load = (key: string): Promise<void> => {
      const token = guard.begin(`repo|${key}`)
      return new Promise((resolve) => {
        pending.push(() => {
          if (guard.isCurrent(token)) applied.push(key)
          resolve()
        })
      })
    }

    const first = load('A')
    const second = load('B')
    pending[1]()
    pending[0]()
    await Promise.all([first, second])
    expect(applied).toEqual(['B'])
  })

  it('rejects everything after an explicit invalidation', () => {
    const guard = createRequestGuard()
    const token = guard.begin('repo|A')
    expect(guard.isCurrent(token)).toBe(true)
    guard.invalidate()
    expect(guard.isCurrent(token)).toBe(false)
    expect(guard.isCurrent(guard.begin('repo|B'))).toBe(true)
  })

  it('lets a stale finally run without touching the newer state', async () => {
    const guard = createRequestGuard()
    const finishing: Array<() => void> = []
    let state: string | null = null

    const load = (key: string): Promise<void> => {
      const token = guard.begin(`repo|${key}`)
      return new Promise((resolve) => {
        finishing.push(() => {
          if (guard.isCurrent(token)) state = `ready:${key}`
          resolve()
        })
      })
    }

    const first = load('A')
    const second = load('B')
    finishing[1]()
    expect(state).toBe('ready:B')
    state = null
    finishing[0]()
    await Promise.all([first, second])
    expect(state).toBeNull()
  })
})
