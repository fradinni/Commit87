import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitIdentity } from '../src/shared/types'
import { runGit } from '../src/main/git/runner'
import {
  addWorktree,
  checkoutBranch,
  commitChanges,
  createBranch,
  createTag,
  deleteTag,
  getBranches,
  getDiff,
  getLog,
  getStashes,
  getStatus,
  getTags,
  getWorktrees,
  mergeBranch,
  removeWorktree,
  resolveRepo,
  stashApply,
  stashPush
} from '../src/main/git/repo'

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
let worktreePath = ''

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(repoPath, file)), { recursive: true })
  await fs.writeFile(path.join(repoPath, file), content)
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitgrove-test-'))
  repoPath = path.join(root, 'repo')
  worktreePath = path.join(root, 'worktrees', 'feature-wt')
  await fs.mkdir(repoPath)
  await runGit(['init', '-b', 'main'], { cwd: repoPath })
  await runGit(['config', 'user.name', identity.name], { cwd: repoPath })
  await runGit(['config', 'user.email', identity.email], { cwd: repoPath })
  await write('README.md', '# GitGrove\n')
  await write('src/app.ts', 'export const value = 1\n')
  await runGit(['add', '.'], { cwd: repoPath })
  await commitChanges(
    { repoPath, message: 'Initial commit' },
    { identity }
  )
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('git repository service', () => {
  it('resolves a repository and a clean status', async () => {
    const info = await resolveRepo(repoPath)
    expect(info.name).toBe('repo')
    expect(info.currentBranch).toBe('main')
    expect(info.detached).toBe(false)
    expect(info.state).toBe('clean')
    const status = await getStatus(repoPath)
    expect(status.clean).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.ahead).toBe(0)
  })

  it('commits staged changes with the selected identity', async () => {
    await write('src/app.ts', 'export const value = 2\n')
    let status = await getStatus(repoPath)
    expect(status.files).toHaveLength(1)
    expect(status.files[0].stage).toBe('unstaged')

    await runGit(['add', 'src/app.ts'], { cwd: repoPath })
    status = await getStatus(repoPath)
    expect(status.stagedCount).toBe(1)

    const diff = await getDiff({ repoPath, staged: true, path: 'src/app.ts' })
    expect(diff.patch).toContain('-export const value = 1')
    expect(diff.patch).toContain('+export const value = 2')

    const result = await commitChanges(
      { repoPath, message: 'Update value' },
      { identity }
    )
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/)

    const log = await getLog({ repoPath, limit: 10 })
    expect(log[0].subject).toBe('Update value')
    expect(log[0].author.name).toBe('Ada Lovelace')
    expect(log[0].author.email).toBe('ada@example.com')
    expect(log[0].parents).toHaveLength(1)
  })

  it('creates, lists and merges branches', async () => {
    await createBranch(repoPath, 'feature', 'main', true)
    const info = await resolveRepo(repoPath)
    expect(info.currentBranch).toBe('feature')
    await write('feature.txt', 'feature\n')
    await runGit(['add', '.'], { cwd: repoPath })
    await commitChanges({ repoPath, message: 'Add feature' }, { identity })

    await checkoutBranch({ repoPath, branch: 'main' })
    const merged = await mergeBranch(
      { repoPath, branch: 'feature', noFf: true },
      { identity }
    )
    expect(merged.output.toLowerCase()).toContain('merge')

    const branches = await getBranches(repoPath)
    expect(branches.some((branch) => branch.shortName === 'feature' && branch.type === 'branch')).toBe(true)
    expect(branches.find((branch) => branch.isCurrent)?.shortName).toBe('main')
  })

  it('creates annotated tags and deletes them', async () => {
    await createTag(
      { repoPath, name: 'v1.0.0', message: 'First release' },
      { identity }
    )
    const tags = await getTags(repoPath)
    const tag = tags.find((item) => item.name === 'v1.0.0')
    expect(tag?.annotated).toBe(true)
    expect(tag?.message).toContain('First release')

    await deleteTag(repoPath, 'v1.0.0')
    expect((await getTags(repoPath)).some((item) => item.name === 'v1.0.0')).toBe(false)
  })

  it('creates and removes worktrees', async () => {
    await addWorktree({
      repoPath,
      path: worktreePath,
      branch: 'feature-wt',
      createBranch: true,
      startPoint: 'main'
    })
    const worktrees = await getWorktrees(repoPath)
    const added = worktrees.find((item) => item.path === worktreePath)
    expect(added?.branch).toBe('feature-wt')
    expect(added?.isMain).toBe(false)
    expect(added?.isCurrent).toBe(false)

    const status = await getStatus(worktreePath)
    expect(status.branch).toBe('feature-wt')

    await removeWorktree(repoPath, worktreePath, false)
    expect((await getWorktrees(repoPath)).some((item) => item.path === worktreePath)).toBe(false)
  })

  it('stashes and restores changes', async () => {
    await write('README.md', '# GitGrove changed\n')
    await stashPush(repoPath, 'Work in progress', true, { identity })
    const stashes = await getStashes(repoPath)
    expect(stashes).toHaveLength(1)
    expect(stashes[0].message).toContain('Work in progress')

    const status = await getStatus(repoPath)
    expect(status.clean).toBe(true)

    await stashApply(repoPath, 0, true)
    const restored = await getStatus(repoPath)
    expect(restored.files).toHaveLength(1)
    expect((await getStashes(repoPath))).toHaveLength(0)

    // Leave the tree clean for other tests.
    await runGit(['restore', '--worktree', '--', 'README.md'], { cwd: repoPath })
    expect(await getStashes(repoPath)).toHaveLength(0)
  })
})
