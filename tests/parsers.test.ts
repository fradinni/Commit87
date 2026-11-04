import { describe, expect, it } from 'vitest'
import {
  parseBranches,
  parseBlame,
  parseConfig,
  parseDecoration,
  parseLog,
  parseNumstat,
  parseRemotes,
  parseStashes,
  parseStatus,
  parseTags,
  parseWorktrees
} from '../src/main/git/parsers'

const F = '\x1f'
const R = '\x1e'

describe('porcelain status parser', () => {
  it('parses branch headers and every file kind', () => {
    const output = [
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -3',
      '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/app.ts',
      '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 src/new.ts',
      'src/old.ts',
      '? notes.txt',
      'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc src/conflict.ts'
    ].join('\0') + '\0'

    const status = parseStatus(output)
    expect(status.branch).toBe('main')
    expect(status.upstream).toBe('origin/main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(3)
    expect(status.headSha).toBe('abc123')
    expect(status.files).toHaveLength(4)
    expect(status.files[0]).toMatchObject({ path: 'src/app.ts', stage: 'unstaged', label: 'Modified' })
    expect(status.files[1]).toMatchObject({ path: 'src/new.ts', origPath: 'src/old.ts', stage: 'staged', label: 'Renamed' })
    expect(status.files[2]).toMatchObject({ path: 'notes.txt', stage: 'untracked' })
    expect(status.files[3]).toMatchObject({ path: 'src/conflict.ts', stage: 'conflicted' })
    expect(status.stagedCount).toBe(1)
    expect(status.unstagedCount).toBe(1)
    expect(status.untrackedCount).toBe(1)
    expect(status.conflictedCount).toBe(1)
    expect(status.clean).toBe(false)
  })

  it('handles empty repositories and detached HEAD', () => {
    const output = ['# branch.oid (initial)', '# branch.head (detached)'].join('\0') + '\0'
    const status = parseStatus(output)
    expect(status.headSha).toBeNull()
    expect(status.branch).toBeNull()
    expect(status.detached).toBe(true)
    expect(status.clean).toBe(true)
  })
})

describe('log parser', () => {
  it('parses commits, parents, bodies and decorations', () => {
    const output =
      `abc${F}p1 p2${F}Alice${F}a@example.com${F}1700000000${F}Bob${F}b@example.com${F}1700000100${F}HEAD -> main, tag: v1.0.0, origin/main${F}Subject line${F}Body line 1\nBody line 2${R}` +
      `def${F}${F}Carol${F}c@example.com${F}1600000000${F}Carol${F}c@example.com${F}1600000000${F}${F}Root${F}${R}`
    const commits = parseLog(output)
    expect(commits).toHaveLength(2)
    expect(commits[0].parents).toEqual(['p1', 'p2'])
    expect(commits[0].refs).toEqual(['main', 'v1.0.0', 'origin/main'])
    expect(commits[0].body).toBe('Body line 1\nBody line 2')
    expect(commits[0].author.date).toBe(1700000000000)
    expect(commits[1].parents).toEqual([])
    expect(commits[1].shortSha).toBe('def')
  })

  it('normalises decorations', () => {
    expect(parseDecoration('HEAD -> feature/x, tag: v2, upstream/main')).toEqual(['feature/x', 'v2', 'upstream/main'])
    expect(parseDecoration('')).toEqual([])
  })
})

describe('refs and tags', () => {
  it('parses local and remote branches with tracking counts', () => {
    const output = [
      ['refs/heads/main', 'sha1', 'origin/main', 'ahead 2, behind 1', 'Fix tests', '1700000000', 'Alice'].join(F),
      ['refs/remotes/origin/main', 'sha1', '', '', 'Fix tests', '1700000000', 'Alice'].join(F),
      ['refs/remotes/origin/HEAD', 'sha1', '', '', '', '0', ''].join(F)
    ].join('\n')
    const branches = parseBranches(output, 'main')
    expect(branches).toHaveLength(2)
    expect(branches[0]).toMatchObject({ shortName: 'main', type: 'branch', isCurrent: true, ahead: 2, behind: 1 })
    expect(branches[1]).toMatchObject({ shortName: 'origin/main', type: 'remote', isCurrent: false })
  })

  it('parses annotated and lightweight tags', () => {
    const output = [
      ['v1.0.0', 'tagsha', 'tag', 'commitsha', 'Release 1.0', 'Alice', '<a@example.com>', '1700000000', '1700000001', 'Full message'].join(F),
      ['v0.9.0', 'commitsha2', 'commit', '', 'Old release', '', '', '0', '1600000000', ''].join(F)
    ].join('\n')
    const tags = parseTags(output)
    expect(tags).toHaveLength(2)
    expect(tags[0]).toMatchObject({ name: 'v1.0.0', annotated: true, targetSha: 'commitsha', tagger: { name: 'Alice', email: 'a@example.com' } })
    expect(tags[1]).toMatchObject({ name: 'v0.9.0', annotated: false, targetSha: 'commitsha2' })
  })
})

describe('remotes, worktrees, stashes, numstat, blame, config', () => {
  it('parses remotes', () => {
    const output = 'origin\tgit@github.com:acme/app.git (fetch)\norigin\tgit@github.com:acme/app.git (push)\nupstream\thttps://gitlab.com/acme/app.git (fetch)\n'
    const remotes = parseRemotes(output)
    expect(remotes).toHaveLength(2)
    expect(remotes[0]).toEqual({ name: 'origin', fetchUrl: 'git@github.com:acme/app.git', pushUrl: 'git@github.com:acme/app.git' })
    expect(remotes[1].pushUrl).toBe('https://gitlab.com/acme/app.git')
  })

  it('parses worktree porcelain output', () => {
    const output = [
      'worktree /home/me/app',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /home/me/worktrees/feature',
      'HEAD def456',
      'branch refs/heads/feature',
      'locked in use',
      ''
    ].join('\n')
    const worktrees = parseWorktrees(output, '/home/me/worktrees/feature')
    expect(worktrees).toHaveLength(2)
    expect(worktrees[0]).toMatchObject({ path: '/home/me/app', branch: 'main', isMain: true, isCurrent: false })
    expect(worktrees[1]).toMatchObject({ branch: 'feature', locked: true, lockReason: 'in use', isCurrent: true })
  })

  it('parses stashes and derives the branch', () => {
    const output = `stash@{0}${F}abc${F}WIP on main: 1234 Fix build${F}1700000000\nstash@{1}${F}def${F}On feature/x: custom message${F}1600000000`
    const stashes = parseStashes(output)
    expect(stashes).toHaveLength(2)
    expect(stashes[0]).toMatchObject({ index: 0, branch: 'main', sha: 'abc' })
    expect(stashes[1]).toMatchObject({ index: 1, branch: 'feature/x' })
  })

  it('parses numstat including binaries', () => {
    const files = parseNumstat('12\t3\tsrc/a.ts\n-\t-\tassets/logo.png\n')
    expect(files[0]).toMatchObject({ path: 'src/a.ts', additions: 12, deletions: 3, binary: false })
    expect(files[1]).toMatchObject({ path: 'assets/logo.png', binary: true })
  })

  it('parses blame porcelain', () => {
    const output = [
      'abc123 1 1 1',
      'author Alice',
      'author-time 1700000000',
      'filename src/a.ts',
      '\tconst a = 1',
      'def4567 2 2 1',
      'author Bob',
      'author-time 1700000100',
      'filename src/a.ts',
      '\tconst b = 2'
    ].join('\n')
    const lines = parseBlame(output)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ sha: 'abc123', author: 'Alice', line: 1, content: 'const a = 1' })
    expect(lines[1]).toMatchObject({ line: 2, author: 'Bob' })
  })

  it('parses scoped config', () => {
    const entries = parseConfig('local\tuser.name\tAlice\nglobal\tuser.email\ta@example.com\nsystem\tcore.autocrlf\tfalse\n')
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual({ scope: 'local', key: 'user.name', value: 'Alice' })
  })
})
