import { describe, expect, it } from 'vitest'
import { quoteForGitShell } from '../src/main/git/rebase'
import {
  MAX_REBASE_COMMITS,
  REBASE_ACTIONS,
  assertRebasePlan,
  buildRebaseTodoLines,
  chooseCommentChar,
  normalizeRebaseTarget,
  parseRebaseTodoItems,
  rewordMessages,
  sanitizeTodoSubject
} from '../src/main/git/rebase-plan'
import type { RebaseTodoEntry } from '../src/main/git/rebase-plan'
import type { Commit } from '../src/shared/types'

const sha = (seed: string): string => seed.repeat(40).slice(0, 40)

const commit = (seed: string, parents: string[], subject = `subject ${seed}`, authorDate = 1_600_000_000_000): Commit => ({
  sha: sha(seed),
  shortSha: sha(seed).slice(0, 8),
  parents,
  author: { name: 'Ada', email: 'ada@example.com', date: authorDate },
  committer: { name: 'Ada', email: 'ada@example.com', date: authorDate + 1000 },
  subject,
  body: '',
  refs: []
})

describe('normalizeRebaseTarget', () => {
  it('accepts branches, remote refs, revspecs, tags and full shas', () => {
    const targets = ['main', 'origin/main', 'HEAD~2', 'v1.0.0', 'a'.repeat(40)]
    for (const target of targets) expect(normalizeRebaseTarget(target)).toBe(target)
  })

  it('accepts the punctuation git allows in branch names', () => {
    const targets = ['fix#1', 'c++', 'a+b', 'release%2', 'x&y', 'a;b', 'a!b', 'a(b)', 'a{b}', 'a,b', 'a=b', 'a|b']
    for (const target of targets) expect(normalizeRebaseTarget(target)).toBe(target)
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeRebaseTarget('  origin/main\n')).toBe('origin/main')
  })

  it('accepts a value of exactly the maximum length', () => {
    expect(normalizeRebaseTarget('a'.repeat(240))).toHaveLength(240)
  })

  it('rejects empty values with the planner message', () => {
    expect(() => normalizeRebaseTarget('')).toThrow('Choose a commit or branch to rebase onto')
    expect(() => normalizeRebaseTarget('   \n')).toThrow('Choose a commit or branch to rebase onto')
  })

  it('rejects option-like, ranged, spaced and path-like values', () => {
    const targets = ['--exec', 'main..other', 'a b', 'main:path', 'a@{1}']
    for (const target of targets) {
      expect(() => normalizeRebaseTarget(target)).toThrow('Invalid rebase base')
    }
  })

  it('rejects control characters and overlong values', () => {
    for (const target of ['main\x00', 'main\x1f', 'main\tother']) {
      expect(() => normalizeRebaseTarget(target)).toThrow('Invalid rebase base')
    }
    expect(() => normalizeRebaseTarget('a'.repeat(241))).toThrow('Invalid rebase base')
  })
})

describe('parseRebaseTodoItems', () => {
  const a = sha('a')
  const b = sha('b')

  it('accepts pick and reword items and normalises the sha', () => {
    const items = parseRebaseTodoItems([
      { sha: a, action: 'pick' },
      { sha: `  ${b}  `, action: 'reword', message: 'Better subject' }
    ])
    expect(items).toEqual([
      { sha: a, action: 'pick', message: undefined },
      { sha: b, action: 'reword', message: 'Better subject' }
    ])
  })

  it('accepts every supported action', () => {
    const seeds = ['a', 'b', 'c', 'd', 'e']
    const raw = REBASE_ACTIONS.map((action, index) => ({ sha: sha(seeds[index]), action }))
    expect(parseRebaseTodoItems(raw).map((item) => item.action)).toEqual(REBASE_ACTIONS)
  })

  it('accepts a message of exactly 20,000 characters', () => {
    const message = 'm'.repeat(20_000)
    expect(parseRebaseTodoItems([{ sha: a, action: 'pick', message }])[0].message).toHaveLength(20_000)
  })

  it('rejects values that are not a non-empty array', () => {
    for (const value of [null, undefined, 'pick', {}, 42]) {
      expect(() => parseRebaseTodoItems(value)).toThrow('The rebase plan is empty')
    }
    expect(() => parseRebaseTodoItems([])).toThrow('The rebase plan is empty')
  })

  it('rejects items that are not objects', () => {
    for (const value of [null, 'pick a', 1]) {
      expect(() => parseRebaseTodoItems([value])).toThrow('Invalid rebase plan item')
    }
  })

  it('rejects short, missing and non-hex shas', () => {
    const items = [
      { sha: 'abc123', action: 'pick' },
      { sha: 'abc1234', action: 'pick' },
      { action: 'pick' },
      { sha: 'zzzzzzz', action: 'pick' },
      { sha: 1234567, action: 'pick' }
    ]
    for (const item of items) {
      expect(() => parseRebaseTodoItems([item])).toThrow('Invalid commit in the rebase plan')
    }
  })

  it('rejects unknown and non-string actions', () => {
    for (const action of ['edit', 'Pick', '', 7, null]) {
      expect(() => parseRebaseTodoItems([{ sha: a, action }])).toThrow('Invalid rebase action')
    }
  })

  it('rejects non-string messages', () => {
    for (const message of [42, {}, ['reword']]) {
      expect(() => parseRebaseTodoItems([{ sha: a, action: 'pick', message }])).toThrow(
        'Rebase message must be text'
      )
    }
  })

  it('rejects messages longer than 20,000 characters', () => {
    const message = 'm'.repeat(20_001)
    expect(() => parseRebaseTodoItems([{ sha: a, action: 'pick', message }])).toThrow('Rebase message is too long')
  })

  it('rejects more than the maximum number of commits', () => {
    const items = Array.from({ length: MAX_REBASE_COMMITS + 1 }, () => ({ sha: a, action: 'pick' }))
    expect(() => parseRebaseTodoItems(items)).toThrow('The rebase plan has too many commits')
  })
})

describe('assertRebasePlan', () => {
  const a = sha('a')
  const b = sha('b')
  const c = sha('c')
  const commits = [
    commit('a', [], 'oldest change', 1_600_000_000_000),
    commit('b', [a], 'middle change', 1_600_000_100_000),
    commit('c', [b], 'newest change', 1_600_000_200_000)
  ]

  it('returns entries in plan order with commit metadata', () => {
    const entries = assertRebasePlan(commits, [
      { sha: c, action: 'pick' },
      { sha: a, action: 'reword', message: '  reworded  ' },
      { sha: b, action: 'drop' }
    ])
    expect(entries).toEqual([
      { action: 'pick', sha: c, subject: 'newest change' },
      { action: 'reword', sha: a, subject: 'oldest change', message: 'reworded' },
      { action: 'drop', sha: b, subject: 'middle change' }
    ])
  })

  it('rejects a plan whose item count does not match the commits', () => {
    expect(() => assertRebasePlan(commits, [{ sha: a, action: 'pick' }])).toThrow(
      'The commit list changed. Reload the rebase plan and try again.'
    )
  })

  it('rejects unknown shas with the reload message', () => {
    expect(() =>
      assertRebasePlan(commits, [
        { sha: a, action: 'pick' },
        { sha: b, action: 'pick' },
        { sha: sha('d'), action: 'pick' }
      ])
    ).toThrow('The commit list changed. Reload the rebase plan and try again.')
  })

  it('rejects duplicate shas', () => {
    expect(() =>
      assertRebasePlan(commits, [
        { sha: a, action: 'pick' },
        { sha: a, action: 'pick' },
        { sha: c, action: 'pick' }
      ])
    ).toThrow('A commit appears twice in the rebase plan')
  })

  it('rejects merge commits', () => {
    const merge = commit('d', [a, b], 'Merge feature')
    expect(() => assertRebasePlan([merge], [{ sha: merge.sha, action: 'pick' }])).toThrow(
      `Interactive rebase cannot replay merge commit ${merge.shortSha}`
    )
  })

  it('rejects squash or fixup as the first kept commit', () => {
    for (const action of ['squash', 'fixup'] as const) {
      expect(() =>
        assertRebasePlan(commits.slice(0, 2), [
          { sha: a, action },
          { sha: b, action: 'pick' }
        ])
      ).toThrow('The first kept commit must be picked or reworded')
    }
  })

  it('rejects squash or fixup after leading drops because no base was kept', () => {
    for (const action of ['squash', 'fixup'] as const) {
      expect(() =>
        assertRebasePlan(commits.slice(0, 2), [
          { sha: a, action: 'drop' },
          { sha: b, action }
        ])
      ).toThrow('The first kept commit must be picked or reworded')
    }
  })

  it('allows a drop followed by a pick', () => {
    const entries = assertRebasePlan(commits.slice(0, 2), [
      { sha: a, action: 'drop' },
      { sha: b, action: 'pick' }
    ])
    expect(entries.map((entry) => entry.action)).toEqual(['drop', 'pick'])
  })

  it('requires a non-blank message for a reword', () => {
    const shortSha = commits[0].shortSha
    expect(() => assertRebasePlan([commits[0]], [{ sha: a, action: 'reword' }])).toThrow(
      `Enter a new message for ${shortSha}`
    )
    expect(() => assertRebasePlan([commits[0]], [{ sha: a, action: 'reword', message: ' \n\t ' }])).toThrow(
      `Enter a new message for ${shortSha}`
    )
  })

  it('allows dropping every commit', () => {
    const entries = assertRebasePlan(commits, [
      { sha: a, action: 'drop' },
      { sha: b, action: 'drop' },
      { sha: c, action: 'drop' }
    ])
    expect(entries).toHaveLength(3)
    expect(entries.every((entry) => entry.action === 'drop')).toBe(true)
  })

  it('rejects an empty commit list', () => {
    expect(() => assertRebasePlan([], [])).toThrow('There are no commits to rebase')
  })
})

describe('buildRebaseTodoLines', () => {
  const ids = { reword: sha('b'), pick: sha('c'), squash: sha('d'), fixup: sha('e'), drop: sha('f') }
  const entries: RebaseTodoEntry[] = [
    { action: 'reword', sha: ids.reword, subject: 'Fix the thing', message: 'Fixed' },
    { action: 'pick', sha: ids.pick, subject: 'Add tests' },
    { action: 'squash', sha: ids.squash, subject: 'Refactor' },
    { action: 'fixup', sha: ids.fixup, subject: 'Tidy' },
    { action: 'drop', sha: ids.drop, subject: 'Work in progress' }
  ]

  it('maps every action one to one', () => {
    const lines = buildRebaseTodoLines(entries)
    expect(lines).toEqual([
      { action: 'reword', sha: ids.reword, subject: 'Fix the thing' },
      { action: 'pick', sha: ids.pick, subject: 'Add tests' },
      { action: 'squash', sha: ids.squash, subject: 'Refactor' },
      { action: 'fixup', sha: ids.fixup, subject: 'Tidy' },
      { action: 'drop', sha: ids.drop, subject: 'Work in progress' }
    ])
  })

  it('extracts reword messages keyed by full sha', () => {
    expect(rewordMessages(entries)).toEqual([{ sha: ids.reword, message: 'Fixed' }])
  })
})

describe('sanitizeTodoSubject', () => {
  it('replaces CR, LF and NUL with a single space', () => {
    expect(sanitizeTodoSubject('fix: a\r\nb\rc\0d')).toBe('fix: a b c d')
    expect(sanitizeTodoSubject('a\n\n\r\0b')).toBe('a b')
  })

  it('leaves ordinary subjects untouched', () => {
    expect(sanitizeTodoSubject('feat: add the planner')).toBe('feat: add the planner')
  })

  it('caps the subject at 400 characters', () => {
    const capped = sanitizeTodoSubject('x'.repeat(500))
    expect(capped).toHaveLength(400)
    expect(capped).toBe('x'.repeat(400))
  })
})

describe('chooseCommentChar', () => {
  it('defaults to a semicolon when no message starts with a candidate', () => {
    expect(chooseCommentChar(['fix login', '#123 not the default'])).toBe(';')
  })

  it('skips every candidate used at the start of a line', () => {
    const message = ['; first', '! second', '# kept', 'body'].join('\n')
    expect(chooseCommentChar([message])).toBe('%')
  })

  it('returns a candidate that no reword message starts with', () => {
    const used = [';', '!', '%', '@', '|', '+', '=', '>', '$', '&', '^']
    const messages = used.map((char) => `${char} line`)
    expect(chooseCommentChar(messages)).toBe('~')
    for (const message of messages) {
      for (const line of message.split('\n')) expect(line.startsWith('~')).toBe(false)
    }
  })

  it('refuses to guess when every candidate is used', () => {
    const messages = [';', '!', '%', '@', '|', '+', '=', '>', '$', '&', '^', '~'].map((char) => `${char} line`)
    expect(() => chooseCommentChar(messages)).toThrow(/comment character/)
  })
})

describe('quoteForGitShell', () => {  it('single-quotes a path', () => {
    expect(quoteForGitShell('/tmp/a')).toBe("'/tmp/a'")
  })

  it('escapes embedded single quotes', () => {
    expect(quoteForGitShell("/tmp/a'b")).toBe("'/tmp/a'\\''b'")
  })
})
