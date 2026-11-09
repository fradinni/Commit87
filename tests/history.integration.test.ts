import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitIdentity } from '../src/shared/types'
import { runGit } from '../src/main/git/runner'
import {
  abortOperation,
  cherryPick,
  checkoutBranch,
  commitChanges,
  createBranch,
  getLog,
  getStatus,
  resolveRepo,
  revertCommit
} from '../src/main/git/repo'
import { orderSelectedCommits } from '../src/renderer/src/lib/commit-selection'

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
  await fs.mkdir(path.dirname(path.join(repoPath, file)), { recursive: true })
  await fs.writeFile(path.join(repoPath, file), content)
}

async function commit(message: string): Promise<string> {
  await runGit(['add', '.'], { cwd: repoPath })
  const result = await commitChanges({ repoPath, message }, { identity })
  return result.sha
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'commit87-history-'))
  repoPath = path.join(root, 'repo')
  await fs.mkdir(repoPath)
  await runGit(['init', '-b', 'main'], { cwd: repoPath })
  await runGit(['config', 'user.name', identity.name], { cwd: repoPath })
  await runGit(['config', 'user.email', identity.email], { cwd: repoPath })
  await write('base.txt', 'base\n')
  await commit('Base commit')
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('multi-commit history actions', () => {
  it('cherry-picks several commits in the given order and reverts them newest first', async () => {
    await createBranch(repoPath, 'side', 'main', true)
    await write('side-a.txt', 'a\n')
    const shaA = await commit('Side change A')
    await write('side-b.txt', 'b\n')
    const shaB = await commit('Side change B')

    await checkoutBranch({ repoPath, branch: 'main' })
    // Give main its own commit so the cherry-pick cannot fast-forward.
    await write('main-only.txt', 'main\n')
    const mainSha = await commit('Main only')

    const beforePick = await getLog({ repoPath, limit: 20 })
    const pickOrder = orderSelectedCommits(beforePick.map((item) => item.sha), [shaB, shaA], 'cherry-pick')
    expect(pickOrder).toEqual([shaA, shaB])

    const picked = await cherryPick(repoPath, pickOrder, { identity })
    expect(picked.exitCode).toBe(0)
    expect(picked.output).toContain('Side change A')
    expect(picked.output).toContain('Side change B')
    const afterPick = await getLog({ repoPath, limit: 10, branch: 'main' })
    expect(afterPick.slice(0, 2).map((item) => item.subject)).toEqual(['Side change B', 'Side change A'])
    expect(afterPick[2]?.sha).toBe(mainSha)
    await expect(fs.readFile(path.join(repoPath, 'side-a.txt'), 'utf8')).resolves.toBe('a\n')
    await expect(fs.readFile(path.join(repoPath, 'side-b.txt'), 'utf8')).resolves.toBe('b\n')

    // The renderer passes newest first for revert so each child is undone first.
    const pickedShas = afterPick.slice(0, 2).map((item) => item.sha)
    const revertOrder = orderSelectedCommits(afterPick.map((item) => item.sha), pickedShas, 'revert')
    expect(revertOrder).toEqual([pickedShas[0], pickedShas[1]])
    const reverted = await revertCommit(repoPath, revertOrder, { identity })
    expect(reverted.exitCode).toBe(0)
    expect(reverted.output).toContain('Revert')
    const afterRevert = await getStatus(repoPath)
    expect(afterRevert.clean).toBe(true)
    await expect(fs.access(path.join(repoPath, 'side-a.txt'))).rejects.toThrow()
    await expect(fs.access(path.join(repoPath, 'side-b.txt'))).rejects.toThrow()
    await expect(fs.readFile(path.join(repoPath, 'main-only.txt'), 'utf8')).resolves.toBe('main\n')
    const finalLog = await getLog({ repoPath, limit: 10, branch: 'main' })
    expect(finalLog.filter((item) => item.subject.startsWith('Revert'))).toHaveLength(2)
  })

  it('reports a conflicting cherry-pick without throwing and leaves an abortable state', async () => {
    const conflictRepo = path.join(root, 'conflict')
    await fs.mkdir(conflictRepo)
    await runGit(['init', '-b', 'main'], { cwd: conflictRepo })
    await runGit(['config', 'user.name', identity.name], { cwd: conflictRepo })
    await runGit(['config', 'user.email', identity.email], { cwd: conflictRepo })

    const writeFile = async (content: string): Promise<void> => {
      await fs.writeFile(path.join(conflictRepo, 'shared.txt'), content)
      await runGit(['add', '.'], { cwd: conflictRepo })
    }
    await writeFile('base\n')
    await commitChanges({ repoPath: conflictRepo, message: 'Base commit' }, { identity })

    await createBranch(conflictRepo, 'side', 'main', true)
    await writeFile('side\n')
    await commitChanges({ repoPath: conflictRepo, message: 'Side edit' }, { identity })
    const sideSha = (await getLog({ repoPath: conflictRepo, limit: 1, branch: 'side' }))[0]?.sha
    expect(sideSha).toBeTruthy()

    await checkoutBranch({ repoPath: conflictRepo, branch: 'main' })
    await writeFile('main\n')
    await commitChanges({ repoPath: conflictRepo, message: 'Main edit' }, { identity })

    const result = await cherryPick(conflictRepo, [sideSha], { identity })
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('CONFLICT')
    expect((await resolveRepo(conflictRepo)).state).toBe('cherry-picking')

    await abortOperation(conflictRepo)
    expect((await resolveRepo(conflictRepo)).state).toBe('clean')
    expect((await getStatus(conflictRepo)).clean).toBe(true)
  })
})