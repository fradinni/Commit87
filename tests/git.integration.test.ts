import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitIdentity } from '../src/shared/types'
import { normalizePath } from '../src/main/git/parsers'
import { runGit } from '../src/main/git/runner'
import { actionPaths, stagePaths } from '../src/renderer/src/lib/files'
import {
  addWorktree,
  checkoutBranch,
  commitChanges,
  createBranch,
  createTag,
  deleteTag,
  discardFiles,
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
  stageFiles,
  stashApply,
  stashPush,
  unstageFiles
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

/** Write inside an isolated repository created by `initRepo`. */
async function writeIn(base: string, file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(base, file)), { recursive: true })
  await fs.writeFile(path.join(base, file), content)
}

async function initRepo(name: string): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await runGit(['init', '-b', 'main'], { cwd: dir })
  await runGit(['config', 'user.name', identity.name], { cwd: dir })
  await runGit(['config', 'user.email', identity.email], { cwd: dir })
  return dir
}

async function commitAll(dir: string, message: string): Promise<string> {
  await runGit(['add', '.'], { cwd: dir })
  await runGit(['commit', '-m', message], { cwd: dir })
  const head = await runGit(['rev-parse', 'HEAD'], { cwd: dir })
  return head.stdout.trim()
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

    // A multiline message must stay one record instead of becoming extra tags.
    await createTag(
      { repoPath, name: 'v1.1.0', message: 'Second release\n\nNotes:\n  src/app.ts\nv9.9.9' },
      { identity }
    )
    const multiline = await getTags(repoPath)
    expect(multiline).toHaveLength(1)
    expect(multiline[0]).toMatchObject({ name: 'v1.1.0', annotated: true })
    expect(multiline[0].message).toContain('src/app.ts')
    await deleteTag(repoPath, 'v1.1.0')
    expect(await getTags(repoPath)).toHaveLength(0)
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

describe('exact Git targets', () => {
  it('acts only on the literal path when a pattern-like name is selected', async () => {
    const dir = await initRepo('literal-case')
    await writeIn(dir, 'notes[1].txt', 'bracket\n')
    await writeIn(dir, 'notes1.txt', 'plain\n')
    await commitAll(dir, 'Add notes')

    await writeIn(dir, 'notes[1].txt', 'bracket changed\n')
    await writeIn(dir, 'notes1.txt', 'plain changed\n')

    await stageFiles(dir, ['notes[1].txt'])
    let status = await getStatus(dir)
    expect(status.files.find((file) => file.path === 'notes[1].txt')).toMatchObject({ stage: 'staged' })
    expect(status.files.find((file) => file.path === 'notes1.txt')).toMatchObject({ stage: 'unstaged' })

    await unstageFiles(dir, ['notes[1].txt'])
    status = await getStatus(dir)
    expect(status.stagedCount).toBe(0)
    expect(status.files.filter((file) => file.stage === 'unstaged')).toHaveLength(2)

    await stageFiles(dir, ['notes[1].txt'])
    await discardFiles(dir, ['notes[1].txt'], false)
    status = await getStatus(dir)
    expect(status.files.find((file) => file.path === 'notes[1].txt')).toBeUndefined()
    expect(status.files.find((file) => file.path === 'notes1.txt')?.stage).toBe('unstaged')
    expect(await fs.readFile(path.join(dir, 'notes[1].txt'), 'utf8')).toBe('bracket\n')
    expect(await fs.readFile(path.join(dir, 'notes1.txt'), 'utf8')).toBe('plain changed\n')
  })

  it('unstages both sides of a staged rename through the shared action scope', async () => {
    const dir = await initRepo('rename-case')
    await writeIn(dir, 'old.txt', 'content\n')
    await commitAll(dir, 'Add old')
    await runGit(['mv', 'old.txt', 'new.txt'], { cwd: dir })

    const status = await getStatus(dir)
    const renamed = status.files.find((file) => file.path === 'new.txt')
    expect(renamed).toMatchObject({ origPath: 'old.txt', rename: true, stage: 'staged' })
    expect(status.stagedCount).toBe(1)
    if (!renamed) throw new Error('Expected a staged rename')
    expect(actionPaths(renamed)).toEqual(['old.txt', 'new.txt'])
    expect(stagePaths(renamed)).toEqual(['new.txt'])

    // Staging a rename must use its destination only: the source is gone from
    // the worktree and `git add old.txt` would fail the whole command.
    await stageFiles(dir, stagePaths(renamed))
    expect((await getStatus(dir)).stagedCount).toBe(1)

    await unstageFiles(dir, actionPaths(renamed))
    const after = await getStatus(dir)
    expect(after.stagedCount).toBe(0)
    expect(after.files.some((file) => file.path === 'new.txt' && file.stage === 'untracked')).toBe(true)
    expect(after.files.some((file) => file.path === 'old.txt' && file.stage === 'unstaged')).toBe(true)

    // Discarding the same pair restores the source and drops the destination.
    await stageFiles(dir, stagePaths(renamed))
    expect((await getStatus(dir)).stagedCount).toBe(1)
    await discardFiles(dir, actionPaths(renamed), false)
    expect((await getStatus(dir)).clean).toBe(true)
    expect(await fs.readFile(path.join(dir, 'old.txt'), 'utf8')).toBe('content\n')
    await expect(fs.stat(path.join(dir, 'new.txt'))).rejects.toThrow()
  })

  it('fails a checkout of a missing ref without restoring a same-named file', async () => {
    const dir = await initRepo('missing-ref-case')
    await writeIn(dir, 'release', 'committed\n')
    await commitAll(dir, 'Add release file')
    await writeIn(dir, 'release', 'dirty edit\n')

    await expect(checkoutBranch({ repoPath: dir, branch: 'release' })).rejects.toThrow()
    expect(await fs.readFile(path.join(dir, 'release'), 'utf8')).toBe('dirty edit\n')
    expect((await resolveRepo(dir)).currentBranch).toBe('main')
  })

  it('checks out a tag detached even when a branch shares its name', async () => {
    const dir = await initRepo('detached-tag-case')
    await writeIn(dir, 'file.txt', 'one\n')
    const first = await commitAll(dir, 'First')
    await runGit(['branch', 'v2'], { cwd: dir })
    await writeIn(dir, 'file.txt', 'two\n')
    const second = await commitAll(dir, 'Second')
    await createTag({ repoPath: dir, name: 'v2', message: 'Version two' }, { identity })

    // The refs panel must use the fully qualified ref: a short name resolves to
    // `tags/v2` while the branch exists, which used to become `refs/tags/tags/v2`.
    const tag = (await getTags(dir)).find((info) => info.name === 'v2')
    if (!tag) throw new Error('Expected the tag to be listed')
    expect(tag.ref).toBe('refs/tags/v2')
    await checkoutBranch({ repoPath: dir, branch: tag.ref, detach: true })
    const info = await resolveRepo(dir)
    expect(info.detached).toBe(true)
    expect(info.currentBranch).toBeNull()
    expect(info.headSha).toBe(second)

    const branches = await getBranches(dir)
    const sameNamed = branches.find((branch) => branch.type === 'branch' && branch.shortName === 'v2')
    expect(sameNamed?.sha).toBe(first)

    await checkoutBranch({ repoPath: dir, branch: first, detach: true })
    expect((await resolveRepo(dir)).headSha).toBe(first)
  })

  it('force-checks out a branch over conflicting local changes', async () => {
    const dir = await initRepo('force-checkout-case')
    await writeIn(dir, 'file.txt', 'main\n')
    await commitAll(dir, 'Main')
    await runGit(['switch', '-c', 'other'], { cwd: dir })
    await writeIn(dir, 'file.txt', 'other\n')
    await commitAll(dir, 'Other')
    await runGit(['switch', 'main'], { cwd: dir })
    await writeIn(dir, 'file.txt', 'dirty main\n')

    await expect(checkoutBranch({ repoPath: dir, branch: 'other' })).rejects.toThrow()
    expect(await fs.readFile(path.join(dir, 'file.txt'), 'utf8')).toBe('dirty main\n')

    await checkoutBranch({ repoPath: dir, branch: 'other', force: true })
    expect((await resolveRepo(dir)).currentBranch).toBe('other')
    expect(await fs.readFile(path.join(dir, 'file.txt'), 'utf8')).toBe('other\n')
  })
})
