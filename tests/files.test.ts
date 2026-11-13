import { describe, expect, it } from 'vitest'
import type { RepoStatus, StatusFile } from '../src/shared/types'
import { actionPaths, fileFacets, previewKeyFor, stagePaths, statusesEqual } from '../src/renderer/src/lib/files'
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

function repoStatus(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    branch: 'main',
    headSha: 'abc123',
    detached: false,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    clean: true,
    ...overrides
  }
}

describe('status snapshots', () => {
  it('treats a rebuilt snapshot with the same content as unchanged', () => {
    const file = statusFile({ path: 'src/app.ts', index: 'M', worktree: '.', stage: 'staged', label: 'Modified' })
    const before = repoStatus({ files: [file], stagedCount: 1, clean: false })
    const after = repoStatus({ files: [{ ...file }], stagedCount: 1, clean: false })
    expect(statusesEqual(before, after)).toBe(true)
  })

  it('detects a change in every field of the snapshot', () => {
    const file = statusFile({ path: 'src/app.ts', index: 'M', worktree: 'M', stage: 'staged', label: 'Staged + modified' })
    const base = repoStatus({ files: [file], stagedCount: 1, unstagedCount: 1, clean: false })
    const changes: Array<[string, RepoStatus]> = [
      ['branch', { ...base, branch: 'feature' }],
      ['headSha', { ...base, headSha: 'def456' }],
      ['detached', { ...base, detached: true }],
      ['upstream', { ...base, upstream: null }],
      ['ahead', { ...base, ahead: 1 }],
      ['behind', { ...base, behind: 1 }],
      ['stagedCount', { ...base, stagedCount: 2 }],
      ['unstagedCount', { ...base, unstagedCount: 2 }],
      ['untrackedCount', { ...base, untrackedCount: 1 }],
      ['conflictedCount', { ...base, conflictedCount: 1 }],
      ['clean', { ...base, clean: true }],
      ['files.length', { ...base, files: [] }],
      ['file.path', { ...base, files: [{ ...file, path: 'src/other.ts' }] }],
      ['file.origPath', { ...base, files: [{ ...file, origPath: 'src/old.ts' }] }],
      ['file.index', { ...base, files: [{ ...file, index: 'A' }] }],
      ['file.worktree', { ...base, files: [{ ...file, worktree: '.' }] }],
      ['file.stage', { ...base, files: [{ ...file, stage: 'unstaged' }] }],
      ['file.label', { ...base, files: [{ ...file, label: 'Modified' }] }],
      ['file.rename', { ...base, files: [{ ...file, rename: true }] }]
    ]
    for (const [field, changed] of changes) {
      expect(statusesEqual(base, changed), field).toBe(false)
    }
  })

  it('detects a file that only moved position in the list', () => {
    const first = statusFile({ path: 'a.txt' })
    const second = statusFile({ path: 'b.txt' })
    const before = repoStatus({ files: [first, second], clean: false })
    const after = repoStatus({ files: [{ ...second }, { ...first }], clean: false })
    expect(statusesEqual(before, after)).toBe(false)
  })
})

describe('preview target identity', () => {
  const facet = { key: 'worktree::src/app.ts', stage: 'unstaged' as const }

  it('keeps the key for a repeat load of the same target', () => {
    expect(previewKeyFor('/repo', facet)).toBe(previewKeyFor('/repo', { ...facet }))
  })

  it('changes the key for another side, stage or repository', () => {
    expect(previewKeyFor('/repo', facet)).not.toBe(previewKeyFor('/repo', { ...facet, key: 'index::src/app.ts' }))
    expect(previewKeyFor('/repo', facet)).not.toBe(previewKeyFor('/repo', { ...facet, stage: 'conflicted' }))
    expect(previewKeyFor('/repo', facet)).not.toBe(previewKeyFor('/other', facet))
  })
})
