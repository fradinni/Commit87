import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitIdentity } from '../src/shared/types'
import { normalizePath } from '../src/main/git/parsers'
import { runGit } from '../src/main/git/runner'
import {
  addSubmodule,
  getStatus,
  getSubmodules,
  removeSubmodule,
  resolveRepo,
  syncSubmodules,
  updateSubmodules
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
let remotePath = ''
let repoPath = ''
let submodulePath = ''
let firstSha = ''
let secondSha = ''
const savedEnv = {
  count: process.env.GIT_CONFIG_COUNT,
  key: process.env.GIT_CONFIG_KEY_0,
  value: process.env.GIT_CONFIG_VALUE_0
}

async function commit(file: string, content: string, message: string): Promise<string> {
  await fs.writeFile(path.join(remotePath, file), content)
  await runGit(['add', '.'], { cwd: remotePath })
  await runGit(['commit', '-m', message], { cwd: remotePath })
  const head = await runGit(['rev-parse', 'HEAD'], { cwd: remotePath })
  return head.stdout.trim()
}

/** A superproject with one committed `lib` submodule cloned from a local repository. */
async function createFixture(label: string): Promise<{ remote: string; superRepo: string }> {
  const base = path.join(root, label)
  const remote = path.join(base, 'remote')
  const superRepo = path.join(base, 'super')
  await fs.mkdir(remote, { recursive: true })
  await runGit(['init', '-b', 'main'], { cwd: remote })
  await runGit(['config', 'user.name', identity.name], { cwd: remote })
  await runGit(['config', 'user.email', identity.email], { cwd: remote })
  await fs.writeFile(path.join(remote, 'lib.txt'), 'one\n')
  await runGit(['add', '.'], { cwd: remote })
  await runGit(['commit', '-m', 'lib'], { cwd: remote })

  await fs.mkdir(superRepo)
  await runGit(['init', '-b', 'main'], { cwd: superRepo })
  await runGit(['config', 'user.name', identity.name], { cwd: superRepo })
  await runGit(['config', 'user.email', identity.email], { cwd: superRepo })
  await fs.writeFile(path.join(superRepo, 'README.md'), '# Super\n')
  await runGit(['add', '.'], { cwd: superRepo })
  await runGit(['commit', '-m', 'super'], { cwd: superRepo })
  await addSubmodule({ repoPath: superRepo, url: remote, path: 'lib' }, { identity })
  await runGit(['add', '.'], { cwd: superRepo })
  await runGit(['commit', '-m', 'submodule'], { cwd: superRepo })
  return { remote, superRepo }
}

/** Make a commit that never reaches the submodule's remote and record it in the superproject. */
async function recordUnpublishedCommit(superRepo: string): Promise<string> {
  const checkout = path.join(superRepo, 'lib')
  await fs.writeFile(path.join(checkout, 'unpublished.txt'), 'local only\n')
  await runGit(['add', '.'], { cwd: checkout })
  await runGit(['commit', '-m', 'Unpublished local commit'], { cwd: checkout })
  const sha = (await runGit(['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim()
  await runGit(['add', 'lib'], { cwd: superRepo })
  await runGit(['commit', '-m', 'Record local submodule commit'], { cwd: superRepo })
  return sha
}

beforeAll(async () => {
  // The integration fixture uses a local repository as the submodule remote.
  // Git blocks the file protocol for submodules unless it is explicitly allowed.
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow'
  process.env.GIT_CONFIG_VALUE_0 = 'always'

  root = await fs.mkdtemp(path.join(os.tmpdir(), 'commit87-submodule-'))
  remotePath = path.join(root, 'remote-lib')
  repoPath = path.join(root, 'app')
  submodulePath = path.join(repoPath, 'vendor', 'lib')

  await fs.mkdir(remotePath)
  await runGit(['init', '-b', 'main'], { cwd: remotePath })
  await runGit(['config', 'user.name', identity.name], { cwd: remotePath })
  await runGit(['config', 'user.email', identity.email], { cwd: remotePath })
  firstSha = await commit('lib.txt', 'one\n', 'First library commit')
  secondSha = await commit('lib.txt', 'two\n', 'Second library commit')

  await fs.mkdir(repoPath)
  await runGit(['init', '-b', 'main'], { cwd: repoPath })
  await runGit(['config', 'user.name', identity.name], { cwd: repoPath })
  await runGit(['config', 'user.email', identity.email], { cwd: repoPath })
  await fs.writeFile(path.join(repoPath, 'README.md'), '# App\n')
  await runGit(['add', '.'], { cwd: repoPath })
  await runGit(['commit', '-m', 'Initial app commit'], { cwd: repoPath })
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  if (savedEnv.count === undefined) delete process.env.GIT_CONFIG_COUNT
  else process.env.GIT_CONFIG_COUNT = savedEnv.count
  if (savedEnv.key === undefined) delete process.env.GIT_CONFIG_KEY_0
  else process.env.GIT_CONFIG_KEY_0 = savedEnv.key
  if (savedEnv.value === undefined) delete process.env.GIT_CONFIG_VALUE_0
  else process.env.GIT_CONFIG_VALUE_0 = savedEnv.value
})

describe('submodule service', () => {
  it('adds a submodule and joins status with the .gitmodules configuration', async () => {
    await addSubmodule(
      { repoPath, url: remotePath, path: 'vendor/lib', branch: 'main' },
      { identity }
    )

    const submodules = await getSubmodules(repoPath)
    expect(submodules).toHaveLength(1)
    expect(submodules[0]).toMatchObject({
      path: 'vendor/lib',
      name: 'vendor/lib',
      url: remotePath,
      branch: 'main',
      sha: secondSha,
      state: 'initialized',
      initialized: true,
      modified: false,
      conflicted: false,
      dirty: false
    })
    expect(await fs.stat(submodulePath)).toBeTruthy()
    expect((await getStatus(repoPath)).files.some((file) => file.path === '.gitmodules')).toBe(true)

    await runGit(['add', '.'], { cwd: repoPath })
    await runGit(['commit', '-m', 'Add library submodule'], { cwd: repoPath })
  })

  it('reports local changes inside an initialized checkout', async () => {
    await fs.writeFile(path.join(submodulePath, 'scratch.txt'), 'temporary\n')
    const dirty = await getSubmodules(repoPath)
    expect(dirty[0].dirty).toBe(true)
    await fs.rm(path.join(submodulePath, 'scratch.txt'))
    expect((await getSubmodules(repoPath))[0].dirty).toBe(false)
  })

  it('removes untracked files when a forced reset asks for a clean checkout', async () => {
    await fs.writeFile(path.join(submodulePath, 'build-artifact.tmp'), 'temporary\n')
    expect((await getSubmodules(repoPath))[0].dirty).toBe(true)

    await updateSubmodules({
      repoPath,
      submodulePath: 'vendor/lib',
      init: true,
      force: true,
      clean: true
    })
    await expect(fs.stat(path.join(submodulePath, 'build-artifact.tmp'))).rejects.toThrow()
    expect((await getSubmodules(repoPath))[0].dirty).toBe(false)
  })

  it('detects an out-of-sync checkout and updates it to the recorded commit', async () => {
    await runGit(['checkout', firstSha], { cwd: submodulePath })
    const modified = await getSubmodules(repoPath)
    expect(modified[0].state).toBe('modified')
    expect(modified[0].modified).toBe(true)
    expect(modified[0].sha).toBe(firstSha)

    const result = await updateSubmodules(
      { repoPath, submodulePath: 'vendor/lib', init: true }
    )
    expect(result.output).toBeDefined()
    const updated = await getSubmodules(repoPath)
    expect(updated[0].state).toBe('initialized')
    expect(updated[0].sha).toBe(secondSha)
  })

  it('reports and reinitializes a deinitialized submodule', async () => {
    await runGit(['submodule', 'deinit', '--', 'vendor/lib'], { cwd: repoPath })
    const uninitialized = await getSubmodules(repoPath)
    expect(uninitialized[0]).toMatchObject({
      state: 'uninitialized',
      initialized: false,
      sha: secondSha,
      dirty: false
    })

    await updateSubmodules({ repoPath, submodulePath: 'vendor/lib', init: true })
    const initialized = await getSubmodules(repoPath)
    expect(initialized[0]).toMatchObject({ state: 'initialized', initialized: true, sha: secondSha })
  })

  it('updates a branch-tracking submodule to the remote tip', async () => {
    const thirdSha = await commit('lib.txt', 'three\n', 'Third library commit')
    await updateSubmodules(
      { repoPath, submodulePath: 'vendor/lib', init: true, remote: true }
    )
    const submodules = await getSubmodules(repoPath)
    expect(submodules[0].sha).toBe(thirdSha)
    expect(submodules[0].state).toBe('modified')
  })

  it('syncs a changed submodule URL into the module configuration', async () => {
    const syncedUrl = `${remotePath}-synced`
    await runGit(['config', '-f', '.gitmodules', 'submodule.vendor/lib.url', syncedUrl], { cwd: repoPath })
    await syncSubmodules(repoPath, 'vendor/lib')
    const configured = await runGit(['config', '--get', 'remote.origin.url'], { cwd: submodulePath })
    expect(configured.stdout.trim()).toBe(syncedUrl)

    await runGit(['config', '-f', '.gitmodules', 'submodule.vendor/lib.url', remotePath], { cwd: repoPath })
    await syncSubmodules(repoPath)
  })

  it('retains the module clone aside when ordinary removal drops the checkout', async () => {
    const { superRepo } = await createFixture('removal-case')
    const unpublished = await recordUnpublishedCommit(superRepo)

    const { retainedPath } = await removeSubmodule(superRepo, 'lib')
    expect(retainedPath).toBeTruthy()
    if (!retainedPath) throw new Error('Ordinary removal reported no retained module clone')

    await expect(fs.stat(path.join(superRepo, 'lib'))).rejects.toThrow()
    await expect(fs.stat(path.join(superRepo, '.gitmodules'))).rejects.toThrow()
    await expect(fs.stat(path.join(superRepo, '.git', 'modules', 'lib'))).rejects.toThrow()

    const status = await getStatus(superRepo)
    expect(status.files.some((file) => file.path === '.gitmodules' && file.stage === 'staged')).toBe(true)
    expect(status.files.some((file) => file.path === 'lib' && file.stage === 'staged')).toBe(true)

    expect((await fs.stat(retainedPath)).isDirectory()).toBe(true)
    const objectCheck = await runGit(['cat-file', '-e', unpublished], { cwd: retainedPath, allowFailure: true })
    expect(objectCheck.exitCode).toBe(0)
    const moduleLog = await runGit(['log', '--all', '--format=%H'], { cwd: retainedPath })
    expect(moduleLog.stdout).toContain(unpublished)
  })

  it('re-adds the same submodule URL at the same path after removal', async () => {
    const { remote, superRepo } = await createFixture('readd-case')
    await recordUnpublishedCommit(superRepo)
    const { retainedPath } = await removeSubmodule(superRepo, 'lib')
    expect(retainedPath).toBeTruthy()

    // Re-adding the old URL at the old path only works because the module
    // clone was moved aside instead of left at <git-dir>/modules/lib.
    await addSubmodule({ repoPath: superRepo, url: remote, path: 'lib' }, { identity })

    const readded = await getSubmodules(superRepo)
    expect(readded).toHaveLength(1)
    expect(readded[0]).toMatchObject({ path: 'lib', url: remote, state: 'initialized', initialized: true })
    expect(await fs.readFile(path.join(superRepo, 'lib', 'lib.txt'), 'utf8')).toBe('one\n')
    expect((await runGit(['status', '--porcelain'], { cwd: path.join(superRepo, 'lib') })).stdout.trim()).toBe('')
    // The recovery copy and the fresh clone coexist.
    if (retainedPath) expect((await fs.stat(retainedPath)).isDirectory()).toBe(true)
  })

  it('keeps the object database when a forced removal discards local changes', async () => {
    const { superRepo } = await createFixture('forced-case')
    const unpublished = await recordUnpublishedCommit(superRepo)
    await fs.writeFile(path.join(superRepo, 'lib', 'scratch.txt'), 'temporary\n')
    await fs.writeFile(path.join(superRepo, 'lib', 'lib.txt'), 'changed\n')
    expect((await getSubmodules(superRepo))[0].dirty).toBe(true)

    const { retainedPath } = await removeSubmodule(superRepo, 'lib', true)
    expect(retainedPath).toBeTruthy()
    if (!retainedPath) throw new Error('Forced removal reported no retained module clone')

    await expect(fs.stat(path.join(superRepo, 'lib'))).rejects.toThrow()
    const objectCheck = await runGit(['cat-file', '-e', unpublished], { cwd: retainedPath, allowFailure: true })
    expect(objectCheck.exitCode).toBe(0)
    // The discarded working-tree edits are not and never were commits.
    const retainedLog = await runGit(['log', '--all', '--format=%H'], { cwd: retainedPath })
    expect(retainedLog.stdout).toContain(unpublished)
  })

  it('keeps the main checkout intact when removing from a linked worktree', async () => {
    const { superRepo } = await createFixture('linked-case')
    const base = path.dirname(superRepo)

    const linked = path.join(base, 'linked')
    await runGit(['worktree', 'add', '-b', 'linked', linked], { cwd: superRepo })
    await runGit(['submodule', 'update', '--init'], { cwd: linked })

    const mainModule = path.join(superRepo, '.git', 'modules', 'lib')
    const linkedModule = path.join(superRepo, '.git', 'worktrees', 'linked', 'modules', 'lib')
    expect((await fs.stat(mainModule)).isDirectory()).toBe(true)
    expect((await fs.stat(linkedModule)).isDirectory()).toBe(true)

    // A commit that only exists in the linked checkout's module clone.
    const linkedCheckout = path.join(linked, 'lib')
    await fs.writeFile(path.join(linkedCheckout, 'local-only.txt'), 'local\n')
    await runGit(['add', '.'], { cwd: linkedCheckout })
    await runGit(['commit', '-m', 'Local only commit'], { cwd: linkedCheckout })
    const unpublished = (await runGit(['rev-parse', 'HEAD'], { cwd: linkedCheckout })).stdout.trim()

    const { retainedPath } = await removeSubmodule(linked, 'lib', true)
    expect(retainedPath).toBeTruthy()
    if (!retainedPath) throw new Error('Linked-worktree removal reported no retained module clone')
    expect(normalizePath(retainedPath).startsWith(`${normalizePath(linkedModule)}.removed-`)).toBe(true)

    // Git reports canonical paths with its own separators and casing.
    expect(normalizePath((await resolveRepo(superRepo)).path)).toBe(normalizePath(await fs.realpath(superRepo)))
    expect((await fs.stat(path.join(superRepo, 'lib'))).isDirectory()).toBe(true)
    expect((await fs.stat(mainModule)).isDirectory()).toBe(true)
    expect((await getSubmodules(superRepo)).map((submodule) => submodule.path)).toEqual(['lib'])
    // The linked worktree's own clone moved aside; the main worktree's clone is untouched.
    await expect(fs.stat(linkedModule)).rejects.toThrow()
    expect((await fs.stat(path.join(superRepo, '.git', 'modules', 'lib'))).isDirectory()).toBe(true)
    const objectCheck = await runGit(['cat-file', '-e', unpublished], { cwd: retainedPath, allowFailure: true })
    expect(objectCheck.exitCode).toBe(0)
    await expect(fs.stat(path.join(linked, 'lib'))).rejects.toThrow()
  })

  it('reports a retained path inside the Git directory that is not the live module path', async () => {
    const { superRepo } = await createFixture('retained-path-case')
    const liveModule = path.join(superRepo, '.git', 'modules', 'lib')
    const gitDirOutput = (await runGit(['rev-parse', '--git-dir'], { cwd: superRepo })).stdout.trim()
    const gitDir = path.resolve(superRepo, gitDirOutput)

    const { retainedPath } = await removeSubmodule(superRepo, 'lib')
    if (!retainedPath) throw new Error('Removal reported no retained module clone')

    const insideGitDir = path.relative(gitDir, retainedPath)
    expect(insideGitDir.startsWith('..')).toBe(false)
    expect(path.isAbsolute(insideGitDir)).toBe(false)
    expect(path.dirname(retainedPath)).toBe(path.dirname(liveModule))
    expect(normalizePath(retainedPath)).not.toBe(normalizePath(liveModule))
    expect(retainedPath.startsWith(`${liveModule}.removed-`)).toBe(true)
    expect((await fs.stat(retainedPath)).isDirectory()).toBe(true)
    await expect(fs.stat(liveModule)).rejects.toThrow()
  })

  it('reuses the retained clone when the old module layout is restored', async () => {
    const { superRepo } = await createFixture('restore-case')
    const unpublished = await recordUnpublishedCommit(superRepo)
    const { retainedPath } = await removeSubmodule(superRepo, 'lib')
    if (!retainedPath) throw new Error('Removal reported no retained module clone')

    // Go back to the state that still records the gitlink, put the retained
    // clone back where Git looks for it, and let Git check it out again.
    await runGit(['reset', '--hard', 'HEAD'], { cwd: superRepo })
    await fs.rename(retainedPath, path.join(superRepo, '.git', 'modules', 'lib'))
    await updateSubmodules({ repoPath: superRepo, submodulePath: 'lib', init: true })

    expect((await getSubmodules(superRepo))[0]).toMatchObject({ path: 'lib', state: 'initialized' })
    const restored = path.join(superRepo, 'lib')
    const objectCheck = await runGit(['cat-file', '-e', unpublished], { cwd: restored, allowFailure: true })
    expect(objectCheck.exitCode).toBe(0)
    expect((await runGit(['log', '--all', '--format=%H'], { cwd: restored })).stdout).toContain(unpublished)
  })

  it('does not fail listing when a gitlink has no .gitmodules mapping', async () => {
    const orphan = path.join(root, 'orphan')
    await fs.mkdir(orphan)
    await runGit(['init', '-b', 'main'], { cwd: orphan })
    await runGit(['config', 'user.name', identity.name], { cwd: orphan })
    await runGit(['config', 'user.email', identity.email], { cwd: orphan })
    await fs.writeFile(path.join(orphan, 'README.md'), '# Orphan\n')
    await runGit(['add', '.'], { cwd: orphan })
    await runGit(['commit', '-m', 'orphan'], { cwd: orphan })
    const head = await runGit(['rev-parse', 'HEAD'], { cwd: orphan })
    await runGit(['update-index', '--add', '--cacheinfo', `160000,${head.stdout.trim()},vendor/orphan`], {
      cwd: orphan
    })

    await expect(getSubmodules(orphan)).resolves.toEqual([])
    expect(normalizePath((await resolveRepo(orphan)).path)).toBe(normalizePath(await fs.realpath(orphan)))
  })

  it('refuses removal before deinit when .gitmodules has unstaged changes', async () => {
    const base = path.join(root, 'dirty-case')
    const remote = path.join(base, 'remote')
    const superRepo = path.join(base, 'super')
    await fs.mkdir(remote, { recursive: true })
    await runGit(['init', '-b', 'main'], { cwd: remote })
    await runGit(['config', 'user.name', identity.name], { cwd: remote })
    await runGit(['config', 'user.email', identity.email], { cwd: remote })
    await fs.writeFile(path.join(remote, 'f.txt'), 'one\n')
    await runGit(['add', '.'], { cwd: remote })
    await runGit(['commit', '-m', 'lib'], { cwd: remote })

    await fs.mkdir(superRepo)
    await runGit(['init', '-b', 'main'], { cwd: superRepo })
    await runGit(['config', 'user.name', identity.name], { cwd: superRepo })
    await runGit(['config', 'user.email', identity.email], { cwd: superRepo })
    await fs.writeFile(path.join(superRepo, 'README.md'), '# Super\n')
    await runGit(['add', '.'], { cwd: superRepo })
    await runGit(['commit', '-m', 'super'], { cwd: superRepo })
    await addSubmodule({ repoPath: superRepo, url: remote, path: 'lib' }, { identity })
    await runGit(['add', '.'], { cwd: superRepo })
    await runGit(['commit', '-m', 'submodule'], { cwd: superRepo })

    await fs.appendFile(path.join(superRepo, '.gitmodules'), '\n# local edit\n')
    await fs.writeFile(path.join(superRepo, 'lib', 'f.txt'), 'changed\n')
    await expect(removeSubmodule(superRepo, 'lib', true)).rejects.toThrow(/\.gitmodules/)
    expect((await fs.stat(path.join(superRepo, 'lib'))).isDirectory()).toBe(true)
    expect((await getSubmodules(superRepo))[0].initialized).toBe(true)
    expect(await fs.readFile(path.join(superRepo, '.gitmodules'), 'utf8')).toContain('# local edit')
  })

  it('cleans untracked files recursively in nested submodules on reset', async () => {
    const base = path.join(root, 'nested-case')
    const leaf = path.join(base, 'leaf')
    const middle = path.join(base, 'middle')
    const superRepo = path.join(base, 'super')
    const initRepo = async (dir: string): Promise<void> => {
      await fs.mkdir(dir, { recursive: true })
      await runGit(['init', '-b', 'main'], { cwd: dir })
      await runGit(['config', 'user.name', identity.name], { cwd: dir })
      await runGit(['config', 'user.email', identity.email], { cwd: dir })
    }

    await initRepo(leaf)
    await fs.writeFile(path.join(leaf, 'leaf.txt'), 'leaf\n')
    await runGit(['add', '.'], { cwd: leaf })
    await runGit(['commit', '-m', 'leaf'], { cwd: leaf })

    await initRepo(middle)
    await fs.writeFile(path.join(middle, 'middle.txt'), 'middle\n')
    await runGit(['add', '.'], { cwd: middle })
    await runGit(['commit', '-m', 'middle'], { cwd: middle })
    await addSubmodule({ repoPath: middle, url: leaf, path: 'leaf' }, { identity })
    await runGit(['add', '.'], { cwd: middle })
    await runGit(['commit', '-m', 'nested leaf'], { cwd: middle })

    await initRepo(superRepo)
    await fs.writeFile(path.join(superRepo, 'README.md'), '# Super\n')
    await runGit(['add', '.'], { cwd: superRepo })
    await runGit(['commit', '-m', 'super'], { cwd: superRepo })
    await addSubmodule({ repoPath: superRepo, url: middle, path: 'middle' }, { identity })
    await runGit(['add', '.'], { cwd: superRepo })
    await runGit(['commit', '-m', 'middle submodule'], { cwd: superRepo })
    await runGit(['submodule', 'update', '--init', '--recursive'], { cwd: superRepo })

    const untracked = path.join(superRepo, 'middle', 'leaf', 'scratch.tmp')
    await fs.writeFile(untracked, 'temporary\n')
    expect((await getSubmodules(superRepo))[0].dirty).toBe(true)

    await updateSubmodules({
      repoPath: superRepo,
      submodulePath: 'middle',
      init: true,
      recursive: true,
      force: true,
      clean: true
    })
    await expect(fs.stat(untracked)).rejects.toThrow()
    expect((await getSubmodules(superRepo))[0].dirty).toBe(false)
  })

  it('removes a submodule that was added but not committed without force', async () => {
    const base = path.join(root, 'fresh-case')
    const remote = path.join(base, 'remote')
    const superRepo = path.join(base, 'super')
    await fs.mkdir(remote, { recursive: true })
    await runGit(['init', '-b', 'main'], { cwd: remote })
    await runGit(['config', 'user.name', identity.name], { cwd: remote })
    await runGit(['config', 'user.email', identity.email], { cwd: remote })
    await fs.writeFile(path.join(remote, 'f.txt'), 'one\n')
    await runGit(['add', '.'], { cwd: remote })
    await runGit(['commit', '-m', 'lib'], { cwd: remote })

    await fs.mkdir(superRepo)
    await runGit(['init', '-b', 'main'], { cwd: superRepo })
    await runGit(['config', 'user.name', identity.name], { cwd: superRepo })
    await runGit(['config', 'user.email', identity.email], { cwd: superRepo })
    await fs.writeFile(path.join(superRepo, 'README.md'), '# Super\n')
    await runGit(['add', '.'], { cwd: superRepo })
    await runGit(['commit', '-m', 'super'], { cwd: superRepo })
    await addSubmodule({ repoPath: superRepo, url: remote, path: 'lib' }, { identity })

    await fs.writeFile(path.join(superRepo, 'lib', 'untracked.tmp'), 'temporary\n')
    await expect(removeSubmodule(superRepo, 'lib')).rejects.toThrow(/local changes or unpushed commits/)
    expect((await fs.stat(path.join(superRepo, 'lib'))).isDirectory()).toBe(true)

    await fs.rm(path.join(superRepo, 'lib', 'untracked.tmp'))
    await removeSubmodule(superRepo, 'lib')
    await expect(fs.stat(path.join(superRepo, 'lib'))).rejects.toThrow()
    await expect(fs.stat(path.join(superRepo, '.gitmodules'))).rejects.toThrow()
    expect(await getSubmodules(superRepo)).toHaveLength(0)
    expect((await getStatus(superRepo)).clean).toBe(true)
    const staleConfig = await runGit(['config', '--get', 'submodule.lib.url'], {
      cwd: superRepo,
      allowFailure: true
    })
    expect(staleConfig.exitCode).not.toBe(0)
  })

  it('rejects paths that escape the repository or hit Git metadata', async () => {
    await expect(
      addSubmodule({ repoPath, url: remotePath, path: '../escape' }, { identity })
    ).rejects.toThrow(/escapes the repository/)
    for (const badPath of ['.git/hooks', './.git/hooks', 'foo/../.git/x', '.gitmodules', '.gitmodules/', '.GITMODULES']) {
      await expect(
        addSubmodule({ repoPath, url: remotePath, path: badPath }, { identity })
      ).rejects.toThrow(/Git metadata/)
    }
    await expect(removeSubmodule(repoPath, 'vendor/missing')).rejects.toThrow(/Not a tracked submodule/)
  })
})