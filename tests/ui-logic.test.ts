import { describe, expect, it } from 'vitest'
import { parsePatch } from '../src/renderer/src/lib/diff'
import { buildGraph } from '../src/renderer/src/lib/graph'
import { tokenizeCommand, validateConsoleCommand } from '../src/main/tasks'
import type { Commit } from '../src/shared/types'

const commit = (sha: string, parents: string[], subject = sha): Commit => ({
  sha,
  shortSha: sha.slice(0, 8),
  parents,
  author: { name: 'A', email: 'a@x', date: 0 },
  committer: { name: 'A', email: 'a@x', date: 0 },
  subject,
  body: '',
  refs: []
})

describe('unified diff parser', () => {
  it('parses files, hunks, line numbers and stats', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 3',
      '+const c = 4',
      ' ',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ'
    ].join('\n')
    const files = parsePatch(patch)
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ oldPath: 'src/a.ts', newPath: 'src/a.ts', additions: 2, deletions: 1 })
    expect(files[0].hunks[0].lines).toHaveLength(5)
    expect(files[0].hunks[0].lines[1]).toMatchObject({ type: 'del', oldNumber: 2, newNumber: null })
    expect(files[1].binary).toBe(true)
  })

  it('handles added, deleted and renamed files', () => {
    const patch = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/a.txt b/b.txt',
      'similarity index 90%',
      'rename from a.txt',
      'rename to b.txt'
    ].join('\n')
    const files = parsePatch(patch)
    expect(files[0].status).toBe('added')
    expect(files[1].status).toBe('deleted')
    expect(files[2].status).toBe('renamed')
    expect(files[2].oldPath).toBe('a.txt')
    expect(files[2].newPath).toBe('b.txt')
  })
})

describe('commit graph layout', () => {
  it('keeps parallel branches in separate lanes and joins merges', () => {
    const commits = [
      commit('m', ['a', 'b']),
      commit('a', ['root']),
      commit('b', ['root']),
      commit('root', [])
    ]
    const layout = buildGraph(commits, 10)
    expect(layout.rows).toHaveLength(4)
    expect(layout.rows[0].lane).toBe(0)
    expect(layout.rows[1].lane).toBe(0)
    expect(layout.rows[2].lane).toBe(1)
    expect(layout.rows[3].lane).toBe(0)
    expect(layout.laneCount).toBeGreaterThanOrEqual(2)
    expect(layout.edges.length).toBeGreaterThanOrEqual(4)
  })

  it('does not crash on linear history', () => {
    const commits = [commit('c', ['b']), commit('b', ['a']), commit('a', [])]
    const layout = buildGraph(commits)
    expect(layout.rows.every((row) => row.lane === 0)).toBe(true)
    expect(layout.nodes).toHaveLength(3)
  })
})

describe('git console safety', () => {
  it('tokenizes quoted commands', () => {
    expect(tokenizeCommand('git log --grep "fix bug" -n 5')).toEqual(['git', 'log', '--grep', 'fix bug', '-n', '5'])
    expect(tokenizeCommand("git commit -m 'hello world'")).toEqual(['git', 'commit', '-m', 'hello world'])
  })

  it('allows normal git commands', () => {
    expect(validateConsoleCommand('git status')).toEqual(['status'])
    expect(validateConsoleCommand('git log --oneline -n 10')).toEqual(['log', '--oneline', '-n', '10'])
    expect(validateConsoleCommand('git config --get user.email')).toEqual(['config', '--get', 'user.email'])
  })

  it('rejects shell escape hatches and global overrides', () => {
    expect(() => validateConsoleCommand('rm -rf /')).toThrow()
    expect(() => validateConsoleCommand('git -c core.pager=cat status')).toThrow()
    expect(() => validateConsoleCommand('git config alias.x "!rm -rf /"')).toThrow()
    expect(() => validateConsoleCommand('git config --local user.name x')).toThrow()
    expect(() => validateConsoleCommand('git submodule foreach rm -rf')).toThrow()
    expect(() => validateConsoleCommand('git rebase --exec "rm -rf /" main')).toThrow()
  })
})
