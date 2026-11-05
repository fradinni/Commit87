import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitIdentity, RebaseTodoItem } from '../src/shared/types'
import { runGit } from '../src/main/git/runner'
import {
  checkoutBranch,
  commitChanges,
  continueOperation,
  createBranch,
  getCommit,
  getLog,
  getOperationState,
  getStatus,
  mergeBranch,
  readFileContent,
  resolveConflict,
  resolveRepo,
  skipOperation
} from '../src/main/git/repo'
import {
  cleanupRebaseSessionIfIdle,
  getRebasePlan,
  rebaseEditorEnv,
  rebaseInteractive
} from '../src/main/git/rebase'

const identity: GitIdentity = {
  id: 'identity-1',
  label: 'Test',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  isDefault: true,
  createdAt: 0
}

let root = ''
let repoPath = ''

async function write(file: string, content: string): Promise<void> {
  await fs.writeFile(path.join(repoPath, file), content)
}

async function commit(message: string): Promise<string> {
  await runGit(['add', '.'], { cwd: repoPath })
  const result = await commitChanges({ repoPath, message }, { identity })
  return result.sha
}

function shaFor(commits: Array<{ sha: string; subject: string }>, subject: string): string {
  const found = commits.find((commitItem) => commitItem.subject === subject)
  if (!found) throw new Error(`Missing commit: ${subject}`)
  return found.sha
}

async function sessionDir(repoPathToUse: string): Promise<string> {
  const info = await resolveRepo(repoPathToUse)
  return path.join(info.gitDir, 'gitgrove', 'rebase')
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitgrove-rebase-test-'))
  repoPath = path.join(root, 'repo')
  await fs.mkdir(repoPath)
  await runGit(['init', '-b', 'main'], { cwd: repoPath })
  await runGit(['config', 'user.name', identity.name], { cwd: repoPath })
  await runGit(['config', 'user.email', identity.email], { cwd: repoPath })
  await write('README.md', '# GitGrove\n')
  await commit('Initial commit')

  await createBranch(repoPath, 'feature', 'main', true)
  await write('a.txt', 'a\n')
  await commit('Add a.txt')
  await write('b.txt', 'b\n')
  await commit('Add b.txt')
  await write('c.txt', 'c\n')
  await commit('Add c.txt')
  await write('d.txt', 'd\n')
  await commit('Add d.txt\n\nOriginal body')
  await write('e.txt', 'e\n')
  await commit('Add e.txt')
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('interactive rebase bridge', () => {
  it('lists the commits between the base and HEAD in replay order', async () => {
    const plan = await getRebasePlan(repoPath, 'main')
    expect(plan.onto).toBe('main')
    expect(plan.branch).toBe('feature')
    expect(plan.detached).toBe(false)
    expect(plan.upstreamSubject).toBe('Initial commit')
    expect(plan.upstreamSha).toMatch(/^[0-9a-f]{40}$/)
    expect(plan.commits.map((item) => item.subject)).toEqual([
      'Add a.txt',
      'Add b.txt',
      'Add c.txt',
      'Add d.txt',
      'Add e.txt'
    ])
    expect(plan.commits.find((item) => item.subject === 'Add d.txt')?.body).toBe('Original body')
  })

  it('reorders, squashes, drops and rewords commits', async () => {
    const plan = await getRebasePlan(repoPath, 'main')
    const items: RebaseTodoItem[] = [
      { sha: shaFor(plan.commits, 'Add e.txt'), action: 'pick' },
      { sha: shaFor(plan.commits, 'Add a.txt'), action: 'pick' },
      { sha: shaFor(plan.commits, 'Add b.txt'), action: 'squash' },
      { sha: shaFor(plan.commits, 'Add c.txt'), action: 'drop' },
      { sha: shaFor(plan.commits, 'Add d.txt'), action: 'reword', message: '#123 fix login\n\nWhy it matters' }
    ]

    const result = await rebaseInteractive({ repoPath, onto: 'main', items }, { identity })
    expect(result.exitCode).toBe(0)
    expect(result.inProgress).toBe(false)
    expect(await getOperationState(repoPath)).toBe('clean')

    const log = await getLog({ repoPath, limit: 10, branch: 'HEAD' })
    expect(log.slice(0, 3).map((item) => item.subject)).toEqual(['#123 fix login', 'Add a.txt', 'Add e.txt'])
    expect(log.some((item) => item.subject === 'Add d.txt')).toBe(false)

    const squashed = await getCommit(repoPath, log[1].sha)
    expect(squashed.subject).toBe('Add a.txt')
    expect(squashed.body).toContain('Add b.txt')

    const reworded = await getCommit(repoPath, log[0].sha)
    expect(reworded.body).toContain('Why it matters')
    expect(reworded.body).not.toContain('#123')

    expect((await getStatus(repoPath)).clean).toBe(true)
    for (const file of ['a.txt', 'b.txt', 'd.txt', 'e.txt']) {
      await expect(fs.access(path.join(repoPath, file))).resolves.toBeUndefined()
    }
    await expect(fs.access(path.join(repoPath, 'c.txt'))).rejects.toThrow()
    await expect(fs.access(await sessionDir(repoPath))).rejects.toThrow()
  })

  it('keeps rewords working across a conflict stop and continue', async () => {
    const baseFile = Array.from({ length: 12 }, (_, index) => `line-${String(index + 1).padStart(2, '0')}`).join('\n') + '\n'
    const changed = (from: string, to: string, file = baseFile): string => file.replace(from, to)

    await checkoutBranch({ repoPath, branch: 'main' })
    await write('shared.txt', baseFile)
    await commit('Add shared file')
    await createBranch(repoPath, 'conflict', 'main', true)

    await write('shared.txt', changed('line-02', 'feature-two'))
    await commit('Change shared line two')
    await write('shared.txt', changed('line-09', 'feature-nine', changed('line-02', 'feature-two')))
    await commit('Change shared line nine')
    await write('other.txt', 'three\n')
    await commit('Add other')

    // The base moves on after the branch was cut. Line 2 still applies cleanly
    // while line 9 now conflicts with the changed base.
    await checkoutBranch({ repoPath, branch: 'main' })
    await write('shared.txt', changed('line-09', 'main-nine'))
    await commit('Main changes line nine')
    await checkoutBranch({ repoPath, branch: 'conflict' })

    const plan = await getRebasePlan(repoPath, 'main')
    expect(plan.commits.map((item) => item.subject)).toEqual([
      'Change shared line two',
      'Change shared line nine',
      'Add other'
    ])
    const items: RebaseTodoItem[] = [
      { sha: shaFor(plan.commits, 'Change shared line two'), action: 'pick' },
      { sha: shaFor(plan.commits, 'Change shared line nine'), action: 'reword', message: 'Line nine reworded' },
      { sha: shaFor(plan.commits, 'Add other'), action: 'reword', message: 'Other reworded' }
    ]

    const started = await rebaseInteractive({ repoPath, onto: 'main', items }, { identity })
    expect(started.inProgress).toBe(true)
    expect(started.exitCode).not.toBe(0)
    expect(started.output).toMatch(/CONFLICT/i)
    expect(await getOperationState(repoPath)).toBe('rebasing')

    const editorEnv = await rebaseEditorEnv(repoPath)
    expect(editorEnv.GIT_EDITOR).toBeTruthy()

    // The Files view reads the unmerged working-tree file because `git diff`
    // returns a combined diff (diff --cc) for it.
    const conflicted = await readFileContent(repoPath, 'shared.txt', 'worktree')
    expect(conflicted.binary).toBe(false)
    expect(conflicted.content).toContain('<<<<<<<')
    expect(conflicted.content).toContain('=======')
    expect(conflicted.content).toContain('>>>>>>>')

    const resolved = changed('line-09', 'resolved-nine', changed('line-02', 'feature-two'))
    await expect(resolveConflict(repoPath, 'shared.txt', '<<<<<<< HEAD\nx\n')).rejects.toThrow(/markers/)
    await expect(resolveConflict(repoPath, 'shared.txt', 'a\0b')).rejects.toThrow(/NUL/)
    await expect(resolveConflict(repoPath, 'README.md', resolved)).rejects.toThrow(/not in conflict/)
    await resolveConflict(repoPath, 'shared.txt', resolved)
    const staged = await getStatus(repoPath)
    expect(staged.files.find((item) => item.path === 'shared.txt')?.stage).toBe('staged')

    const continued = await continueOperation(repoPath, { identity }, editorEnv)
    expect(continued.output).toBeTruthy()
    expect(await getOperationState(repoPath)).toBe('clean')

    await cleanupRebaseSessionIfIdle(repoPath)
    await expect(fs.access(await sessionDir(repoPath))).rejects.toThrow()

    const log = await getLog({ repoPath, limit: 10, branch: 'HEAD' })
    expect(log.slice(0, 4).map((item) => item.subject)).toEqual([
      'Other reworded',
      'Line nine reworded',
      'Change shared line two',
      'Main changes line nine'
    ])
    expect(await fs.readFile(path.join(repoPath, 'shared.txt'), 'utf8')).toBe(resolved)
    expect((await getStatus(repoPath)).clean).toBe(true)
  })

  it('refuses to start with tracked changes but allows untracked files', async () => {
    await write('README.md', '# dirty\n')
    const plan = await getRebasePlan(repoPath, 'main')
    await expect(
      rebaseInteractive(
        {
          repoPath,
          onto: 'main',
          items: plan.commits.map((item) => ({ sha: item.sha, action: 'pick' as const }))
        },
        { identity }
      )
    ).rejects.toThrow(/tracked changes/)
    await runGit(['restore', '--worktree', '--', 'README.md'], { cwd: repoPath })

    await createBranch(repoPath, 'untracked-ok', 'main', true)
    await write('u.txt', 'u\n')
    await commit('Untracked test')
    await write('scratch.txt', 'untracked\n')

    const nextPlan = await getRebasePlan(repoPath, 'main')
    const result = await rebaseInteractive(
      {
        repoPath,
        onto: 'main',
        items: nextPlan.commits.map((item) => ({ sha: item.sha, action: 'pick' as const }))
      },
      { identity }
    )
    expect(result.exitCode).toBe(0)
    expect(result.inProgress).toBe(false)
    expect((await getLog({ repoPath, limit: 1, branch: 'HEAD' }))[0].subject).toBe('Untracked test')
    await expect(fs.access(path.join(repoPath, 'scratch.txt'))).resolves.toBeUndefined()
    await fs.rm(path.join(repoPath, 'scratch.txt'))
  })

  it('reports a rebase refused by a hook instead of claiming success', async () => {
    await createBranch(repoPath, 'hook', 'main', true)
    await write('h.txt', 'h\n')
    await commit('Hook test')
    const info = await resolveRepo(repoPath)
    const hook = path.join(info.gitDir, 'hooks', 'pre-rebase')
    await fs.writeFile(hook, '#!/bin/sh\necho "refused by test hook" >&2\nexit 1\n', { mode: 0o755 })
    try {
      const plan = await getRebasePlan(repoPath, 'main')
      const result = await rebaseInteractive(
        {
          repoPath,
          onto: 'main',
          items: plan.commits.map((item) => ({ sha: item.sha, action: 'pick' as const }))
        },
        { identity }
      )
      expect(result.inProgress).toBe(false)
      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain('refused by test hook')
      expect(await getOperationState(repoPath)).toBe('clean')
    } finally {
      await fs.rm(hook, { force: true })
    }
  })

  it('skips an emptied reword without rewriting another commit', async () => {
    await checkoutBranch({ repoPath, branch: 'main' })
    await write('dupe.txt', 'same\n')
    const mainTip = await commit('Shared change')
    await createBranch(repoPath, 'dupe', `${mainTip}~1`, true)
    // Same patch, different committer date: patch-equivalent to main's tip, so
    // replaying it onto main must stop as an empty pick.
    await runGit(['cherry-pick', mainTip], {
      cwd: repoPath,
      env: { GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' }
    })

    const plan = await getRebasePlan(repoPath, 'main')
    expect(plan.commits).toHaveLength(1)
    const started = await rebaseInteractive(
      {
        repoPath,
        onto: 'main',
        items: [{ sha: plan.commits[0].sha, action: 'reword', message: 'Should not appear' }]
      },
      { identity }
    )
    expect(started.inProgress).toBe(true)

    const editorEnv = await rebaseEditorEnv(repoPath)
    await skipOperation(repoPath, editorEnv)
    expect(await getOperationState(repoPath)).toBe('clean')
    await cleanupRebaseSessionIfIdle(repoPath)
    await expect(fs.access(await sessionDir(repoPath))).rejects.toThrow()

    const mainSubject = await runGit(['log', '-1', '--format=%s', 'main'], { cwd: repoPath })
    expect(mainSubject.stdout.trim()).toBe('Shared change')
    const subjects = await runGit(['log', '--all', '--format=%s'], { cwd: repoPath })
    expect(subjects.stdout).not.toContain('Should not appear')
  })

  it('allows dropping every commit', async () => {
    await createBranch(repoPath, 'alldrop', 'main', true)
    await write('drop.txt', 'x\n')
    await commit('Drop me')
    const mainSha = (await runGit(['rev-parse', 'main'], { cwd: repoPath })).stdout.trim()

    const plan = await getRebasePlan(repoPath, 'main')
    expect(plan.commits).toHaveLength(1)
    const result = await rebaseInteractive(
      {
        repoPath,
        onto: 'main',
        items: plan.commits.map((item) => ({ sha: item.sha, action: 'drop' as const }))
      },
      { identity }
    )
    expect(result.exitCode).toBe(0)
    expect(result.inProgress).toBe(false)

    const head = (await runGit(['rev-parse', 'HEAD'], { cwd: repoPath })).stdout.trim()
    expect(head).toBe(mainSha)
    const subjects = await runGit(['log', '--all', '--format=%s'], { cwd: repoPath })
    expect(subjects.stdout).not.toContain('Drop me')
    expect((await getStatus(repoPath)).clean).toBe(true)
  })

  it('treats non-UTF-8 worktree content as binary', async () => {
    const file = path.join(repoPath, 'latin1.txt')
    await fs.writeFile(file, Buffer.from([0x6f, 0x75, 0x72, 0x73, 0xe9, 0x0a]))
    const content = await readFileContent(repoPath, 'latin1.txt', 'worktree')
    expect(content.binary).toBe(true)
    expect(content.content).toBe('')
    await fs.rm(file)
  })

  it('rejects ranges that contain merge commits', async () => {
    await createBranch(repoPath, 'merged', 'main', true)
    await write('m1.txt', 'one\n')
    await commit('Merged base')
    await createBranch(repoPath, 'merged-side', 'merged', true)
    await write('m2.txt', 'two\n')
    await commit('Side change')
    await checkoutBranch({ repoPath, branch: 'merged' })
    await mergeBranch({ repoPath, branch: 'merged-side', noFf: true }, { identity })

    await expect(getRebasePlan(repoPath, 'main')).rejects.toThrow(/merge commits/)
  })
})
