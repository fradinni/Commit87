import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitIdentity } from '../src/shared/types'
import { runGit } from '../src/main/git/runner'
import { resolveRepoIdentity } from '../src/main/git/identity'
import {
  abortOperation,
  cherryPick,
  checkoutBranch,
  commitChanges,
  continueOperation,
  createBranch,
  getLog,
  getStatus,
  mergeBranch,
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

async function initRepo(name: string): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await runGit(['init', '-b', 'main'], { cwd: dir })
  await runGit(['config', 'user.name', identity.name], { cwd: dir })
  await runGit(['config', 'user.email', identity.email], { cwd: dir })
  return dir
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'commit87-history-'))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('multi-commit history actions', () => {
  it('cherry-picks several commits in the given order and reverts them newest first', async () => {
    const repoPath = await initRepo('cherry-pick-lifecycle')
    const write = async (file: string, content: string): Promise<void> => {
      await fs.mkdir(path.dirname(path.join(repoPath, file)), { recursive: true })
      await fs.writeFile(path.join(repoPath, file), content)
    }
    const commit = async (message: string): Promise<string> => {
      await runGit(['add', '.'], { cwd: repoPath })
      return (await commitChanges({ repoPath, message }, { identity })).sha
    }
    await write('base.txt', 'base\n')
    await commit('Base commit')

    await createBranch(repoPath, 'side', 'main', true)
    await write('side-a.txt', 'a')
    const shaA = await commit('Side change A')
    await write('side-b.txt', 'b')
    const shaB = await commit('Side change B')

    await checkoutBranch({ repoPath, branch: 'main' })
    // Give main its own commit so the cherry-pick cannot fast-forward.
    await write('main-only.txt', 'main')
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
    await expect(fs.readFile(path.join(repoPath, 'side-a.txt'), 'utf8')).resolves.toBe('a')
    await expect(fs.readFile(path.join(repoPath, 'side-b.txt'), 'utf8')).resolves.toBe('b')

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
    await expect(fs.readFile(path.join(repoPath, 'main-only.txt'), 'utf8')).resolves.toBe('main')
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

describe('identity precedence in main', () => {
  // The identity policy reads Git's effective configuration, so the suite must
  // not inherit the developer's machine-wide user.name/user.email.
  let previousGlobal: string | undefined
  beforeAll(async () => {
    previousGlobal = process.env.GIT_CONFIG_GLOBAL
    const isolated = path.join(root, 'identity', 'empty.gitconfig')
    await fs.mkdir(path.dirname(isolated), { recursive: true })
    await fs.writeFile(isolated, '', 'utf8')
    process.env.GIT_CONFIG_GLOBAL = isolated
  })
  afterAll(() => {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal
  })

  const appDefault: GitIdentity = {
    id: 'app-default',
    label: 'Application',
    name: 'App Default',
    email: 'app@example.com',
    isDefault: true,
    createdAt: 0
  }
  const repoDefault: GitIdentity = {
    id: 'repo-default',
    label: 'Repository default',
    name: 'Repo Default B',
    email: 'repo-b@example.com',
    isDefault: false,
    createdAt: 0
  }
  const explicit: GitIdentity = {
    id: 'explicit',
    label: 'Explicit',
    name: 'Explicit Person',
    email: 'explicit@example.com',
    isDefault: false,
    createdAt: 0
  }
  const identities = [appDefault, repoDefault, explicit]
  const identityById = (id?: string): GitIdentity | undefined => identities.find((item) => item.id === id)

  async function identityRepo(name: string, local?: { name: string; email: string }): Promise<string> {
    const dir = path.join(root, 'identity', name)
    await fs.mkdir(dir, { recursive: true })
    await runGit(['init', '-b', 'main'], { cwd: dir })
    if (local) {
      await runGit(['config', '--local', 'user.name', local.name], { cwd: dir })
      await runGit(['config', '--local', 'user.email', local.email], { cwd: dir })
    }
    await fs.writeFile(path.join(dir, 'file.txt'), 'base\n')
    await runGit(['add', '.'], { cwd: dir })
    await commitChanges({ repoPath: dir, message: 'Base commit' }, { identity: appDefault })
    return dir
  }

  async function commitWith(
    dir: string,
    message: string,
    selection: Awaited<ReturnType<typeof resolveRepoIdentity>>
  ): Promise<string> {
    await runGit(['add', '.'], { cwd: dir })
    return (await commitChanges({ repoPath: dir, message }, { identity: selection.identity })).sha
  }

  it('prefers an explicit request over repository defaults and local config', async () => {
    const dir = await identityRepo('explicit', { name: 'Local B', email: 'local-b@example.com' })
    const selection = await resolveRepoIdentity(dir, {
      explicitId: 'explicit',
      repoDefaultId: 'repo-default',
      applicationIdentity: appDefault,
      identityById
    })
    expect(selection.source).toBe('explicit')
    await fs.writeFile(path.join(dir, 'file.txt'), 'explicit\n')
    await commitWith(dir, 'Explicit commit', selection)
    const log = await getLog({ repoPath: dir, limit: 1 })
    expect(log[0].author).toMatchObject({ name: 'Explicit Person', email: 'explicit@example.com' })
  })

  it('prefers the repository default over repository-local config', async () => {
    const dir = await identityRepo('repo-default', { name: 'Local B', email: 'local-b@example.com' })
    const selection = await resolveRepoIdentity(dir, {
      repoDefaultId: 'repo-default',
      applicationIdentity: appDefault,
      identityById
    })
    expect(selection.source).toBe('repository-default')
    await fs.writeFile(path.join(dir, 'file.txt'), 'repo default\n')
    await commitWith(dir, 'Repository default commit', selection)
    const log = await getLog({ repoPath: dir, limit: 1 })
    expect(log[0].author).toMatchObject({ name: 'Repo Default B', email: 'repo-b@example.com' })
  })

  it('lets repository-local config win over the application default', async () => {
    const dir = await identityRepo('local', { name: 'Local B', email: 'local-b@example.com' })
    const selection = await resolveRepoIdentity(dir, {
      applicationIdentity: appDefault,
      identityById
    })
    expect(selection.source).toBe('repository')
    expect(selection.local).toEqual({ name: 'Local B', email: 'local-b@example.com' })
    await fs.writeFile(path.join(dir, 'file.txt'), 'local\n')
    await commitWith(dir, 'Local commit', selection)
    const log = await getLog({ repoPath: dir, limit: 1 })
    expect(log[0].author).toMatchObject({ name: 'Local B', email: 'local-b@example.com' })
  })

  it('falls back to the application default when no repository identity exists', async () => {
    const dir = await identityRepo('application')
    const selection = await resolveRepoIdentity(dir, {
      applicationIdentity: appDefault,
      identityById
    })
    expect(selection.source).toBe('application')
    await fs.writeFile(path.join(dir, 'file.txt'), 'app\n')
    await commitWith(dir, 'Application default commit', selection)
    const log = await getLog({ repoPath: dir, limit: 1 })
    expect(log[0].author).toMatchObject({ name: 'App Default', email: 'app@example.com' })
  })

  it('continues a conflict in repository B with repository B identity, not the app default', async () => {
    const dir = await identityRepo('continue-identity', { name: 'Local B', email: 'local-b@example.com' })
    await runGit(['switch', '-c', 'side'], { cwd: dir })
    await fs.writeFile(path.join(dir, 'shared.txt'), 'side\n')
    await runGit(['add', '.'], { cwd: dir })
    await commitChanges({ repoPath: dir, message: 'Side edit' }, { identity: appDefault })
    await runGit(['switch', 'main'], { cwd: dir })
    await fs.writeFile(path.join(dir, 'shared.txt'), 'main\n')
    await runGit(['add', '.'], { cwd: dir })
    await commitChanges({ repoPath: dir, message: 'Main edit' }, { identity: appDefault })

    const selection = await resolveRepoIdentity(dir, {
      applicationIdentity: appDefault,
      identityById
    })
    expect(selection.source).toBe('repository')

    const merged = await mergeBranch({ repoPath: dir, branch: 'side' }, { identity: selection.identity })
    expect(merged.status).toBe('conflict')
    expect(merged.conflictFiles).toEqual(['shared.txt'])

    await fs.writeFile(path.join(dir, 'shared.txt'), 'resolved\n')
    await runGit(['add', 'shared.txt'], { cwd: dir })
    const continued = await continueOperation(dir, { identity: selection.identity })
    expect(continued.status).toBe('ok')

    const log = await getLog({ repoPath: dir, limit: 1 })
    expect(log[0].author).toMatchObject({ name: 'Local B', email: 'local-b@example.com' })
    expect(log[0].author.name).not.toBe(appDefault.name)
  })

  it('uses the identity Git resolves globally instead of the application default', async () => {
    const dir = await identityRepo('global-config')
    const globalConfig = path.join(root, 'identity', `global-${Date.now()}.gitconfig`)
    await fs.writeFile(globalConfig, '[user]\n\tname = Global Person\n\temail = global@example.com\n', 'utf8')
    const previous = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    try {
      const selection = await resolveRepoIdentity(dir, { applicationIdentity: appDefault, identityById })
      expect(selection.source).toBe('repository')
      expect(selection.identity).toMatchObject({ name: 'Global Person', email: 'global@example.com' })
      await fs.writeFile(path.join(dir, 'file.txt'), 'global\n')
      await commitWith(dir, 'Global commit', selection)
      const log = await getLog({ repoPath: dir, limit: 1 })
      expect(log[0].author).toMatchObject({ name: 'Global Person', email: 'global@example.com' })
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previous
    }
  })

  it('does not force the application signing settings onto a repository identity', async () => {
    const dir = await identityRepo('unsigned-local', { name: 'Local B', email: 'local-b@example.com' })
    const signing: GitIdentity = { ...appDefault, gpgSign: true, gpgKeyId: '0123456789ABCDEF' }
    const selection = await resolveRepoIdentity(dir, { applicationIdentity: signing, identityById })
    expect(selection.source).toBe('repository')
    expect(selection.identity?.gpgSign).toBeUndefined()
    expect(selection.identity?.gpgKeyId).toBeUndefined()
    // The commit must succeed: a signing key that is not installed locally
    // would otherwise fail every commit authored under the repository identity.
    await fs.writeFile(path.join(dir, 'file.txt'), 'unsigned\n')
    await commitWith(dir, 'Unsigned commit', selection)
    const log = await getLog({ repoPath: dir, limit: 1 })
    expect(log[0].author).toMatchObject({ name: 'Local B', email: 'local-b@example.com' })
  })
})
