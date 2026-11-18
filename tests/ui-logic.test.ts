import { describe, expect, it } from 'vitest'
import { parsePatch } from '../src/renderer/src/lib/diff'
import {
  applyConflictChoice,
  detectLineEnding,
  hasUnresolvedConflicts,
  parseConflicts,
  withLineEndings
} from '../src/renderer/src/lib/conflict'
import { buildGraph, classifyRefs } from '../src/renderer/src/lib/graph'
import {
  clampPaneSize,
  dragOutcome,
  dragPaneSize,
  effectiveMinimum,
  nextDragPending,
  PANE_BOUNDS,
  parsePaneSize,
  REFS_SIDEBAR_WIDTH,
  visiblePaneSize
} from '../src/renderer/src/lib/panes'
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

describe('draggable pane sizes', () => {
  const bounds = PANE_BOUNDS.sidebar

  it('clamps a requested width to the pane bounds', () => {
    expect(clampPaneSize(300, bounds)).toBe(300)
    expect(clampPaneSize(10, bounds)).toBe(bounds.min)
    expect(clampPaneSize(9999, bounds)).toBe(bounds.max)
    expect(clampPaneSize(240.6, bounds)).toBe(241)
  })

  it('falls back to the default for unusable values', () => {
    expect(clampPaneSize(Number.NaN, bounds)).toBe(bounds.defaultSize)
    expect(clampPaneSize(Number.POSITIVE_INFINITY, bounds)).toBe(bounds.defaultSize)
  })

  it('parses a stored width and rejects malformed entries', () => {
    expect(parsePaneSize('320', bounds)).toBe(320)
    expect(parsePaneSize(' 320 ', bounds)).toBe(320)
    expect(parsePaneSize('12', bounds)).toBe(bounds.min)
    expect(parsePaneSize('wide', bounds)).toBeNull()
    expect(parsePaneSize('', bounds)).toBeNull()
    expect(parsePaneSize(null, bounds)).toBeNull()
    expect(parsePaneSize(undefined, bounds)).toBeNull()
  })

  it('keeps every pane minimum smaller than its default', () => {
    for (const pane of Object.values(PANE_BOUNDS)) {
      expect(pane.min).toBeLessThan(pane.defaultSize)
      expect(pane.defaultSize).toBeLessThan(pane.max)
    }
  })

  it('opens the refs sidebar wider but inside the sidebar bounds', () => {
    expect(REFS_SIDEBAR_WIDTH).toBeGreaterThan(PANE_BOUNDS.sidebar.defaultSize)
    expect(REFS_SIDEBAR_WIDTH).toBeLessThanOrEqual(PANE_BOUNDS.sidebar.max)
  })

  it('turns a pointer delta into a width, honouring the inverted pane', () => {
    const base = { startValue: 300, bounds }
    expect(dragPaneSize({ ...base, deltaX: 40 })).toBe(340)
    expect(dragPaneSize({ ...base, deltaX: -40 })).toBe(260)
    // A pane on the right of the splitter grows when the pointer moves left.
    expect(dragPaneSize({ ...base, deltaX: -40, invert: true })).toBe(340)
    expect(dragPaneSize({ ...base, deltaX: 40, invert: true })).toBe(260)
  })

  it('clamps a drag to the pane bounds', () => {
    const base = { startValue: 300, bounds }
    expect(dragPaneSize({ ...base, deltaX: 400 })).toBe(bounds.max)
    expect(dragPaneSize({ ...base, deltaX: -400 })).toBe(bounds.min)
    // The remembered width never leaves the pane's own bounds, whatever the window does.
    expect(dragPaneSize({ startValue: bounds.max, deltaX: 400, bounds })).toBe(bounds.max)
  })

  it('limits the rendered width without losing the chosen one', () => {
    const room = { min: bounds.min, max: bounds.max }
    expect(visiblePaneSize(400, bounds.defaultSize, { min: bounds.min, max: 350 })).toBe(350)
    // Widening the window again brings the width the user picked back.
    expect(visiblePaneSize(400, bounds.defaultSize, room)).toBe(400)
    expect(visiblePaneSize(300, bounds.defaultSize, room)).toBe(300)
    // Nothing chosen: the mode default, limited by the room.
    expect(visiblePaneSize(null, REFS_SIDEBAR_WIDTH, { min: bounds.min, max: 200 })).toBe(200)
    // A reset in a narrow window renders the default clamped, never wider.
    expect(visiblePaneSize(null, bounds.defaultSize, { min: bounds.min, max: 200 })).toBe(200)
    expect(visiblePaneSize(null, bounds.defaultSize, room)).toBe(bounds.defaultSize)
  })

  it('keeps the announced range valid when the window is smaller than the minimum', () => {
    const squeezed = { min: bounds.min, max: 40 }
    const rendered = visiblePaneSize(null, bounds.defaultSize, squeezed)
    const floor = effectiveMinimum(squeezed)
    // The floor lowers to the room that exists, so the pane shrinks instead of
    // overflowing the window, and now stays inside [min, max].
    expect(floor).toBe(40)
    expect(rendered).toBe(40)
    expect(floor).toBeLessThanOrEqual(rendered)
    expect(rendered).toBeLessThanOrEqual(squeezed.max)
    // A container with no room at all must not produce a negative width.
    expect(effectiveMinimum({ min: bounds.min, max: 0 })).toBe(0)
    expect(visiblePaneSize(null, bounds.defaultSize, { min: bounds.min, max: -20 })).toBe(0)
  })

  it('does not rewrite the remembered width when the window pins the pane', () => {
    // Details chosen at 760, window narrow enough to render 324.
    const room = { min: bounds.min, max: 324 }
    const nudged = dragOutcome({ startVisible: 324, wanted: 325, room })
    expect(nudged.visible).toBe(324)
    expect(nudged.remember).toBeNull()

    // Shrinking the visible pane is a real gesture and is remembered.
    const shrunk = dragOutcome({ startVisible: 324, wanted: 294, room })
    expect(shrunk.visible).toBe(294)
    expect(shrunk.remember).toBe(294)

    // What is remembered is what was on screen, not the width the pointer asked
    // for beyond the window: widening the window must not jump past it.
    const overshoot = dragOutcome({ startVisible: 300, wanted: 500, room })
    expect(overshoot.visible).toBe(324)
    expect(overshoot.remember).toBe(324)

    // A drag that returns to where it started commits nothing.
    const returned = dragOutcome({ startVisible: 300, wanted: 300, room: { min: bounds.min, max: bounds.max } })
    expect(returned.visible).toBe(300)
    expect(returned.remember).toBeNull()
  })

  it('carries a drag back to its start as nothing pending', () => {
    const room = { min: bounds.min, max: bounds.max }
    const at = (from: number, to: number) => dragOutcome({ startVisible: from, wanted: to, room })

    // Onward movement becomes the pending width, exactly once.
    expect(nextDragPending(null, at(300, 340))).toBe(340)
    expect(nextDragPending(340, at(300, 360))).toBe(360)
    // Coming back to the start clears it, so release commits nothing.
    expect(nextDragPending(340, at(300, 300))).toBeNull()
    expect(nextDragPending(360, at(300, 300))).toBeNull()

    // The pinned case: a nudge that cannot move the pane is never pending, and a
    // press with no movement stays pending-free.
    const pinned = { min: bounds.min, max: 324 }
    expect(nextDragPending(null, dragOutcome({ startVisible: 324, wanted: 330, room: pinned }))).toBeNull()
    expect(nextDragPending(null, dragOutcome({ startVisible: 324, wanted: 324, room: pinned }))).toBeNull()
    // A real move at the ceiling is remembered at the width that was visible.
    expect(nextDragPending(null, dragOutcome({ startVisible: 300, wanted: 500, room: pinned }))).toBe(324)
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

  it('closes a lane that merges into an already open lane', () => {
    const commits = [commit('m', ['a', 'b']), commit('a', ['root']), commit('b', ['root']), commit('root', [])]
    const layout = buildGraph(commits, 10)
    expect(layout.laneCount).toBe(2)
    expect(layout.rows[3].lane).toBe(0)
    expect(layout.edges.some((edge) => edge.fromRow === 2 && edge.toLane === 1)).toBe(false)
    expect(layout.rows.every((row) => row.lane < layout.laneCount)).toBe(true)
  })

  it('never draws below the final commit row', () => {
    const commits = [commit('m', ['a', 'b']), commit('a', ['root']), commit('b', ['root']), commit('root', [])]
    const layout = buildGraph(commits, 10)
    expect(layout.edges.every((edge) => edge.toRow < commits.length)).toBe(true)
    expect(layout.edges.every((edge) => edge.fromLane < layout.laneCount && edge.toLane < layout.laneCount)).toBe(true)
  })
})

describe('commit ref classification', () => {
  it('separates current branch, tags and remotes', () => {
    const refs = classifyRefs(['origin/main', 'main', 'v1.0.0', 'release/v1', 'HEAD'], {
      tags: new Set(['v1.0.0', 'release/v1']),
      currentBranch: 'main'
    })
    expect(refs).toEqual([
      { name: 'main', kind: 'branch', current: true },
      { name: 'HEAD', kind: 'head', current: false },
      { name: 'release/v1', kind: 'tag', current: false },
      { name: 'v1.0.0', kind: 'tag', current: false },
      { name: 'origin/main', kind: 'remote', current: false }
    ])
  })

  it('uses known refs to disambiguate slashed branch names and skips remote HEAD', () => {
    const refs = classifyRefs(['origin/main', 'origin/main', 'feature/x', 'origin/HEAD'], {
      branches: new Set(['feature/x'])
    })
    expect(refs).toEqual([
      { name: 'feature/x', kind: 'branch', current: false },
      { name: 'origin/main', kind: 'remote', current: false }
    ])
  })
})

describe('git console safety', () => {
  it('tokenizes quoted commands', () => {
    expect(tokenizeCommand('git log --grep "fix bug" -n 5')).toEqual(['git', 'log', '--grep', 'fix bug', '-n', '5'])
    expect(tokenizeCommand("git commit -m 'hello world'")).toEqual(['git', 'commit', '-m', 'hello world'])
  })

  it('allows normal git commands', () => {
    expect(validateConsoleCommand('git status')).toEqual(['status'])
    expect(validateConsoleCommand('git status --short --branch')).toEqual(['status', '--short', '--branch'])
    expect(validateConsoleCommand('git log --oneline -n 10')).toEqual(['log', '--oneline', '-n', '10'])
    expect(validateConsoleCommand('git remote -v')).toEqual(['remote', '-v'])
    expect(validateConsoleCommand('git worktree list')).toEqual(['worktree', 'list'])
    expect(validateConsoleCommand('git stash list')).toEqual(['stash', 'list'])
    expect(validateConsoleCommand('git config --get user.email')).toEqual(['config', '--get', 'user.email'])
    expect(validateConsoleCommand('git config --local --get user.email')).toEqual([
      'config',
      '--local',
      '--get',
      'user.email'
    ])
    expect(validateConsoleCommand('git log -5 --oneline')).toEqual(['log', '-5', '--oneline'])
    expect(validateConsoleCommand('git log --pretty=%s -n 3')).toEqual(['log', '--pretty=%s', '-n', '3'])
    expect(validateConsoleCommand('git rm src/old.ts')).toEqual(['rm', 'src/old.ts'])
    expect(validateConsoleCommand('git rm --cached src/old.ts')).toEqual(['rm', '--cached', 'src/old.ts'])
    expect(validateConsoleCommand('git worktree remove wt-copy')).toEqual(['worktree', 'remove', 'wt-copy'])
  })

  it('rejects shell escape hatches and global overrides', () => {
    expect(() => validateConsoleCommand('rm -rf /')).toThrow()
    expect(() => validateConsoleCommand('git -c core.pager=cat status')).toThrow()
    expect(() => validateConsoleCommand('git -C /tmp status')).toThrow()
    expect(() => validateConsoleCommand('git config alias.x "!rm -rf /"')).toThrow()
    expect(() => validateConsoleCommand('git config --local user.name x')).toThrow()
    expect(() => validateConsoleCommand('git config --file /tmp/config --get user.name')).toThrow()
    expect(() => validateConsoleCommand('git submodule foreach rm -rf')).toThrow()
    expect(() => validateConsoleCommand('git rebase --exec "rm -rf /" main')).toThrow()
    expect(() => validateConsoleCommand('git rebase -x "rm -rf /" main')).toThrow()
    expect(() => validateConsoleCommand('git fetch --upload-pack=/tmp/x')).toThrow()
    expect(() => validateConsoleCommand('git worktree add /tmp/x main')).toThrow()
    // A value-taking option must not swallow an option-shaped token.
    expect(() => validateConsoleCommand('git log --pretty --output=/tmp/x')).toThrow()
    expect(() => validateConsoleCommand('git show --pretty --output=/tmp/x')).toThrow()
    expect(() => validateConsoleCommand('git diff --unified --output=/tmp/x')).toThrow()
    expect(() => validateConsoleCommand('git config --get --file=/etc/passwd root')).toThrow()
    // Push may not be redirected away from the configured remote.
    expect(() => validateConsoleCommand('git push --repo=/tmp/other.git --mirror')).toThrow()
    expect(() => validateConsoleCommand('git push --mirror')).toThrow()
  })
})

describe('conflict resolution model', () => {
  const content = [
    'export const app = {',
    '<<<<<<< HEAD',
    "  shell: 'shell-v2',",
    '=======',
    "  shell: 'sidebar',",
    '>>>>>>> feature (feat: update app shell)',
    '}'
  ].join('\n')

  it('parses regions, labels and both sides', () => {
    const parsed = parseConflicts(content)
    expect(parsed.malformed).toBe(false)
    expect(parsed.regions).toHaveLength(1)
    expect(parsed.regions[0]).toMatchObject({
      oursLabel: 'HEAD',
      theirsLabel: 'feature (feat: update app shell)',
      baseLabel: null,
      ours: ["  shell: 'shell-v2',"],
      theirs: ["  shell: 'sidebar',"],
      base: null
    })
    expect(hasUnresolvedConflicts(content)).toBe(true)
  })

  it('resolves a region with every choice', () => {
    expect(applyConflictChoice(content, 0, 'ours')).toBe(
      ['export const app = {', "  shell: 'shell-v2',", '}'].join('\n')
    )
    expect(applyConflictChoice(content, 0, 'theirs')).toBe(
      ['export const app = {', "  shell: 'sidebar',", '}'].join('\n')
    )
    expect(applyConflictChoice(content, 0, 'both')).toBe(
      ['export const app = {', "  shell: 'shell-v2',", "  shell: 'sidebar',", '}'].join('\n')
    )
    expect(applyConflictChoice(content, 0, 'none')).toBe(['export const app = {', '}'].join('\n'))
    const resolved = applyConflictChoice(content, 0, 'ours')
    expect(parseConflicts(resolved).regions).toHaveLength(0)
    expect(hasUnresolvedConflicts(resolved)).toBe(false)
  })

  it('uses the base section of a diff3 conflict', () => {
    const diff3 = ['<<<<<<< HEAD', 'ours', '||||||| base', 'base', '=======', 'theirs', '>>>>>>> branch'].join('\n')
    const parsed = parseConflicts(diff3)
    expect(parsed.regions[0].base).toEqual(['base'])
    expect(parsed.regions[0].baseLabel).toBe('base')
    expect(applyConflictChoice(diff3, 0, 'base')).toBe('base')
  })

  it('resolves one of several regions without touching the others', () => {
    const two = [
      '<<<<<<< HEAD',
      'first ours',
      '=======',
      'first theirs',
      '>>>>>>> branch',
      'middle',
      '<<<<<<< HEAD',
      'second ours',
      '=======',
      'second theirs',
      '>>>>>>> branch'
    ].join('\n')
    expect(parseConflicts(two).regions).toHaveLength(2)
    const after = applyConflictChoice(two, 1, 'ours')
    expect(after).toContain('first ours')
    expect(after).toContain('first theirs')
    expect(after).toContain('second ours')
    expect(after).not.toContain('second theirs')
    expect(parseConflicts(after).regions).toHaveLength(1)

    const all = applyConflictChoice(after, 0, 'none')
    expect(hasUnresolvedConflicts(all)).toBe(false)
    expect(all).toBe('middle\nsecond ours')
  })

  it('flags incomplete or unbalanced markers', () => {
    expect(parseConflicts('a\n<<<<<<< HEAD\nb\n').malformed).toBe(true)
    expect(parseConflicts('a\n>>>>>>> branch\n').malformed).toBe(true)
    expect(hasUnresolvedConflicts('a\n<<<<<<< HEAD\nb\n')).toBe(true)
    expect(parseConflicts('a\n=======\nb').malformed).toBe(false)
    expect(hasUnresolvedConflicts('a\n=======\nb')).toBe(false)
  })

  it('normalises CRLF working-tree files to LF output', () => {
    const crlf = content.replace(/\n/g, '\r\n')
    const resolved = applyConflictChoice(crlf, 0, 'theirs')
    expect(resolved).not.toContain('\r')
    expect(resolved).toBe(['export const app = {', "  shell: 'sidebar',", '}'].join('\n'))
  })

  it('preserves empty sides and trailing newlines', () => {
    const empty = 'a\n<<<<<<< HEAD\n=======\ntheirs\n>>>>>>> x\n'
    const parsed = parseConflicts(empty)
    expect(parsed.regions[0].ours).toEqual([])
    expect(parsed.regions[0].theirs).toEqual(['theirs'])
    expect(applyConflictChoice(empty, 0, 'theirs')).toBe('a\ntheirs\n')
    expect(applyConflictChoice(empty, 99, 'ours')).toBe(empty)
  })

  it('resolves adjacent regions', () => {
    const adjacent = [
      '<<<<<<< a',
      'one',
      '=======',
      'two',
      '>>>>>>> b',
      '<<<<<<< c',
      'three',
      '=======',
      'four',
      '>>>>>>> d'
    ].join('\n')
    expect(parseConflicts(adjacent).regions).toHaveLength(2)
    const resolved = applyConflictChoice(applyConflictChoice(adjacent, 0, 'ours'), 0, 'theirs')
    expect(resolved).toBe('one\nfour')
  })

  it('detects and restores file line endings', () => {
    expect(detectLineEnding('a\r\nb')).toBe('\r\n')
    expect(detectLineEnding('a\nb')).toBe('\n')
    expect(detectLineEnding('a\r\nb\nc')).toBe('\r\n')
    expect(withLineEndings('a\nb\n', '\r\n')).toBe('a\r\nb\r\n')
    expect(withLineEndings('a\r\nb', '\n')).toBe('a\nb')
  })
})
