import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitIdentity } from '../src/shared/types'
import { normalizePath } from '../src/main/git/parsers'
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
  getWorktreeStatuses,
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
let realRepoPath = ''
let worktreePath = ''

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(repoPath, file)), { recursive: true })
  await fs.writeFile(path.join(repoPath, file), content)
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'commit87-test-'))
  repoPath = path.join(root, 'repo')
  worktreePath = path.join(root, 'worktrees', 'feature-wt')
  await fs.mkdir(repoPath)
  realRepoPath = normalizePath(await fs.realpath(repoPath))
  await runGit(['init', '-b', 'main'], { cwd: repoPath })
  await runGit(['config', 'user.name', identity.name], { cwd: repoPath })
  await runGit(['config', 'user.email', identity.email], { cwd: repoPath })
  await write('README.md', '# Commit87\n')
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
  it.skipIf(process.platform === 'win32')('canonicalises a symlinked repository path', async () => {
    const link = path.join(root, 'repo-link')
    await fs.symlink(repoPath, link, 'dir')
    const direct = await resolveRepo(repoPath)
    const fromLink = await resolveRepo(link)
    expect(fromLink.canonicalPath).toBe(direct.canonicalPath)
    expect(direct.canonicalPath).toBe(await fs.realpath(repoPath))
  })

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
    // Git reports canonical paths: macOS resolves /var to /private/var and
    // Windows expands 8.3 names and uses backslashes.
    const realWorktreePath = normalizePath(await fs.realpath(worktreePath))
    const worktrees = await getWorktrees(repoPath)
    const added = worktrees.find((item) => normalizePath(item.path) === realWorktreePath)
    expect(added?.branch).toBe('feature-wt')
    expect(added?.isMain).toBe(false)
    expect(added?.isCurrent).toBe(false)

    const status = await getStatus(worktreePath)
    expect(status.branch).toBe('feature-wt')

    const statuses = await getWorktreeStatuses(repoPath)
    const mainStatus = statuses.find((item) => normalizePath(item.path) === realRepoPath)
    const linkedStatus = statuses.find((item) => normalizePath(item.path) === realWorktreePath)
    expect(mainStatus).toMatchObject({ available: true, clean: true, fileCount: 0 })
    expect(linkedStatus).toMatchObject({ available: true, clean: true, branch: 'feature-wt' })

    const main = await resolveRepo(repoPath)
    const linked = await resolveRepo(worktreePath)
    expect(linked.worktree).toBe(true)
    expect(linked.commonDir).toBe(main.commonDir)

    await removeWorktree(repoPath, worktreePath, false)
    expect((await getWorktrees(repoPath)).some((item) => normalizePath(item.path) === realWorktreePath)).toBe(false)
  })

  it('reports a deleted worktree folder as unavailable instead of failing', async () => {
    const gonePath = path.join(root, 'worktrees', 'gone-wt')
    await addWorktree({
      repoPath,
      path: gonePath,
      branch: 'gone-wt',
      createBranch: true,
      startPoint: 'main'
    })
    const realGonePath = normalizePath(await fs.realpath(gonePath))
    await fs.rm(gonePath, { recursive: true, force: true })

    const statuses = await getWorktreeStatuses(repoPath)
    const gone = statuses.find((item) => normalizePath(item.path) === realGonePath)
    const mainStatus = statuses.find((item) => normalizePath(item.path) === realRepoPath)
    expect(gone).toMatchObject({ available: false, fileCount: 0 })
    expect(mainStatus).toMatchObject({ available: true, clean: true })

    await runGit(['worktree', 'prune'], { cwd: repoPath })
  })

  it('stashes and restores changes', async () => {
    await write('README.md', '# Commit87 changed\n')
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
