import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import {
  bool,
  enumOf,
  headPath,
  hexDigest,
  num,
  optStr,
  recordOf,
  refName,
  relPath,
  remoteName,
  repoPath,
  revision,
  revisionRange,
  str,
  strArray,
  submoduleUrl
} from '../src/main/ipc/validate'
import { validateConsoleCommand } from '../src/main/tasks'
import { GrantStore } from '../src/main/ipc/grants'
import { validateGitExecutable } from '../src/main/git/runner'
import { getBlame, listTree, readFileContent, setRepoConfig } from '../src/main/git/repo'
import type { UpdateAdapter, UpdateDownloadTask, UpdateInfoSummary } from '../src/main/updates'
import type { UpdateProgress } from '../src/shared/types'
import type { VerifiedAppImage } from '../src/main/appimage-binding'

const run = promisify(execFile)
const profile = vi.hoisted(() => ({ dir: '', pick: '' }))
const shellCalls = vi.hoisted(() => ({ opened: [] as string[], shown: [] as string[] }))

vi.mock('electron', () => ({
  app: { getPath: () => profile.dir, isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => ''
  },
  dialog: {
    showOpenDialog: async () =>
      profile.pick ? { canceled: false, filePaths: [profile.pick] } : { canceled: true, filePaths: [] }
  },
  shell: {
    openExternal: async () => undefined,
    openPath: async (target: string) => {
      shellCalls.opened.push(target)
      return ''
    },
    showItemInFolder: (target: string) => {
      shellCalls.shown.push(target)
    }
  }
}))

const { AppStore } = await import('../src/main/store')
const { Router } = await import('../src/main/ipc/router')
const { TaskManager } = await import('../src/main/tasks')
const { ProviderService } = await import('../src/main/providers/service')
const { UpdateService } = await import('../src/main/updates')

class InertAdapter implements UpdateAdapter {
  setChannel(): void {}
  setAutoDownload(): void {}
  setAutoInstallOnAppQuit(): void {}
  setAllowDowngrade(): void {}
  async check(): Promise<UpdateInfoSummary | null> {
    return null
  }
  download(): UpdateDownloadTask {
    return { promise: Promise.resolve(), cancel: () => undefined }
  }
  quitAndInstall(_target: VerifiedAppImage | null): void {}
  onChecking(): void {}
  onAvailable(): void {}
  onNotAvailable(): void {}
  onProgress(_listener: (progress: UpdateProgress) => void): void {}
  onDownloaded(): void {}
  onError(): void {}
}

const canSymlink = process.platform !== 'win32'
const dirs: string[] = []
let store: InstanceType<typeof AppStore>
let router: InstanceType<typeof Router>
let grants: InstanceType<typeof GrantStore>

async function makeDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function git(cwd: string, args: string[]): Promise<void> {
  await run('git', args, { cwd })
}

async function makeRepo(): Promise<string> {
  const dir = await makeDir('commit87-ipc-repo-')
  await git(dir, ['init', '-q', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'Test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await fs.mkdir(path.join(dir, 'nested'))
  await fs.writeFile(path.join(dir, 'nested', 'file.txt'), 'hello\n')
  await fs.writeFile(path.join(dir, 'root.txt'), 'root\n')
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-qm', 'initial'])
  return dir
}

beforeAll(async () => {
  profile.dir = await makeDir('commit87-ipc-profile-')
})

beforeEach(async () => {
  profile.dir = await makeDir('commit87-ipc-profile-')
  profile.pick = ''
  shellCalls.opened = []
  shellCalls.shown = []
  store = new AppStore()
  await store.init()
  grants = new GrantStore(path.join(profile.dir, 'grants.json'))
  await grants.load()
  const tasks = new TaskManager(() => undefined)
  const updates = new UpdateService({
    adapter: new InertAdapter(),
    environment: { platform: process.platform, isPackaged: false },
    version: '0.0.0-test',
    preferences: () => ({ channel: 'stable', autoCheck: false })
  })
  router = new Router(store, tasks, new ProviderService(store), updates, grants, () => null, () => null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('strict IPC decoding', () => {
  it('accepts only real booleans', () => {
    expect(bool(true, 'Flag')).toBe(true)
    expect(bool(false, 'Flag')).toBe(false)
    expect(() => bool('false', 'Flag')).toThrow('must be true or false')
    expect(() => bool('0', 'Flag')).toThrow()
    expect(() => bool(0, 'Flag')).toThrow()
  })

  it('rejects empty or mistyped strings and numbers', () => {
    expect(str('ok', 'Name')).toBe('ok')
    expect(() => str('', 'Name')).toThrow('required')
    expect(() => str('   ', 'Name')).toThrow('required')
    expect(() => str(42, 'Name')).toThrow('must be text')
    expect(optStr('', 'Name')).toBeUndefined()
    expect(num(3, 'Count', { min: 1, max: 5 })).toBe(3)
    expect(() => num(1.5, 'Count')).toThrow('whole number')
    expect(() => num(9, 'Count', { max: 5 })).toThrow('at most')
    expect(() => num('3', 'Count')).toThrow('must be a number')
  })

  it('rejects unknown enum members instead of defaulting', () => {
    expect(enumOf('hard', ['soft', 'mixed', 'hard'] as const, 'Mode')).toBe('hard')
    expect(() => enumOf('--hard', ['soft', 'mixed', 'hard'] as const, 'Mode')).toThrow('must be one of')
    expect(() => enumOf('open', ['closed', 'all'] as const, 'State')).toThrow()
  })

  it('rejects option-shaped and range-shaped revisions', () => {
    expect(revision('HEAD~2', 'Revision')).toBe('HEAD~2')
    expect(revision('origin/main', 'Revision')).toBe('origin/main')
    expect(revision('deadbeef', 'Revision')).toBe('deadbeef')
    for (const value of ['--force', '-n', 'a b', 'a\tb', 'a..b', 'main@{1}', '', 'a:b', 'a?b', 'a*b']) {
      expect(() => revision(value, 'Revision')).toThrow()
    }
    expect(revisionRange('main..feature', 'Range')).toBe('main..feature')
    expect(revisionRange('main...feature', 'Range')).toBe('main...feature')
    expect(() => revisionRange('--exec..main', 'Range')).toThrow()
  })

  it('separates branch names from revisions', () => {
    expect(refName('feature/x', 'Branch')).toBe('feature/x')
    expect(refName('v1.0.0', 'Branch')).toBe('v1.0.0')
    for (const value of ['-x', 'a b', 'a..b', 'a@{1}', 'a~1', '.hidden/x', 'x.lock']) {
      expect(() => refName(value, 'Branch')).toThrow()
    }
  })

  it('requires absolute repository paths and relative file paths', () => {
    expect(repoPath(path.join(os.tmpdir(), 'repo'), 'Repository path')).toContain('repo')
    expect(() => repoPath('repo', 'Repository path')).toThrow('absolute')
    expect(relPath('nested/file.txt', 'File')).toBe('nested/file.txt')
    for (const value of ['../x', 'a/../../x', '/etc/passwd', 'C:\\x', '-n', 'a\u0000b']) {
      expect(() => relPath(value, 'File')).toThrow()
    }
    expect(() => headPath('a:b', 'File')).toThrow(':')
    expect(hexDigest('a'.repeat(64), 'Hash')).toHaveLength(64)
    expect(() => hexDigest('a'.repeat(63), 'Hash')).toThrow('SHA-256')
    expect(remoteName('origin')).toBe('origin')
    expect(() => remoteName('--upload-pack')).toThrow()
    expect(strArray(['a', 'b'], 'Files')).toEqual(['a', 'b'])
    expect(() => strArray([], 'Files')).toThrow()
    expect(() => strArray([1], 'Files')).toThrow()
    expect(recordOf({ key: 'value' }, 'Inputs')).toEqual({ key: 'value' })
    expect(() => recordOf({ key: 1 }, 'Inputs')).toThrow()
    expect(submoduleUrl('../libs/app')).toBe('../libs/app')
    expect(() => submoduleUrl('ext::sh -c whoami')).toThrow()
  })
})

describe('console grammar', () => {
  it('accepts the documented command forms', () => {
    for (const command of [
      'git status',
      'git status --short --branch',
      'git status -sb',
      'git log --oneline -n 20',
      'git log --oneline -n20',
      'git log --grep "fix bug" -n 5',
      'git remote -v',
      'git worktree list',
      'git worktree list --porcelain',
      'git config --get user.email',
      'git config --local --get user.email',
      'git config --get-all user.email',
      'git fetch',
      'git fetch -p origin',
      'git pull --rebase',
      'git push',
      'git push --set-upstream origin main',
      'git push -u origin main',
      'git branch',
      'git branch -a',
      'git branch -u origin/main main',
      'git diff',
      'git diff --stat HEAD~1 -- src',
      'git show HEAD',
      'git show --stat HEAD~1',
      'git stash list',
      'git stash pop stash@{0}',
      'git commit -m "message"',
      'git commit -am "message"',
      'git add -A',
      'git rebase main',
      'git merge --no-ff feature',
      'git tag',
      'git tag -l "v*"',
      'git tag v1.0.0',
      'git version'
    ]) {
      expect(() => validateConsoleCommand(command), command).not.toThrow()
    }
  })

  it('rejects execution-related and overridden command forms', () => {
    for (const command of [
      'rm -rf /',
      'git -c core.pager=cat status',
      'git -C /tmp status',
      'git -C/tmp status',
      'git --git-dir=/tmp/repo log',
      'git --config-env=core.pager=cat status',
      'git --exec-path=/tmp status',
      'git -p status',
      'git status --upload-pack=/tmp/x',
      'git fetch --exec=/tmp/x',
      'git fetch --upload-pack=/tmp/x',
      'git push --receive-pack=/tmp/x',
      'git rebase --exec "rm -rf /" main',
      'git rebase -x rm main',
      'git log --output=/tmp/out HEAD',
      'git config --file /tmp/config --get user.name',
      'git config --blob HEAD:config --get user.name',
      'git config -e',
      'git config --add user.name x',
      'git config --unset user.name',
      'git config --global user.name x',
      'git config --local user.name x',
      'git config alias.x "!rm -rf /"',
      'git submodule foreach rm -rf',
      'git submodule add https://example.com/x.git',
      'git worktree add /tmp/wt main',
      'git tag -F /etc/passwd',
      'git notes list',
      'git help log',
      'git status -- --upload-pack=x',
      'git status -sx'
    ]) {
      expect(() => validateConsoleCommand(command), command).toThrow()
    }
  })

  it('classifies attached and clustered short options', () => {
    expect(validateConsoleCommand('git log -n5 --oneline')).toEqual(['log', '-n5', '--oneline'])
    expect(validateConsoleCommand('git status -sb')).toEqual(['status', '-sb'])
    expect(validateConsoleCommand('git remote -v')).toEqual(['remote', '-v'])
    expect(() => validateConsoleCommand('git log -nx --exec=y HEAD')).toThrow()
  })
})

describe.skipIf(process.platform === 'win32')('executable policy', () => {
  it('accepts only an absolute, regular, executable file', async () => {
    const dir = await makeDir('commit87-ipc-exec-')
    const executable = path.join(dir, 'git')
    await fs.writeFile(executable, '#!/bin/sh\nprintf "git version 2.40.0\\n"\n', { mode: 0o755 })
    await fs.chmod(executable, 0o755)
    const plain = path.join(dir, 'plain')
    await fs.writeFile(plain, 'x')
    await fs.chmod(plain, 0o644)

    expect(await validateGitExecutable(executable)).toMatchObject({ ok: true })
    expect((await validateGitExecutable('git')).ok).toBe(false)
    expect((await validateGitExecutable(plain)).ok).toBe(false)
    expect((await validateGitExecutable(dir)).ok).toBe(false)
    expect((await validateGitExecutable(path.join(dir, 'missing'))).ok).toBe(false)
  })

  it('rejects an ungranted executable and config-installed paths', async () => {
    const dir = await makeDir('commit87-ipc-exec-')
    const executable = path.join(dir, 'git')
    await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await fs.chmod(executable, 0o755)

    await expect(router.handle('app.checkGit', { path: executable })).rejects.toThrow(/not chosen/)
    await expect(router.handle('config.update', { patch: { gitBinary: executable } })).rejects.toThrow(/Choose the Git executable/)

    const canonical = await grants.grantExecutable(executable)
    const info = await router.handle('app.checkGit', { path: executable })
    expect(info.available).toBe(true)
    expect(store.getConfig().gitBinary).toBe(canonical)
    expect(await grants.isGrantedExecutable(executable)).toBe(true)

    await router.handle('app.useSystemGit', undefined)
    expect(store.getConfig().gitBinary).toBe('')
  })

  it('only grants an executable chosen through the native picker', async () => {
    const dir = await makeDir('commit87-ipc-exec-')
    const executable = path.join(dir, 'git')
    await fs.writeFile(executable, '#!/bin/sh\nprintf "git version 2.40.0\\n"\n', { mode: 0o755 })
    await fs.chmod(executable, 0o755)

    profile.pick = executable
    const info = await router.handle('app.pickGitBinary', undefined)
    expect(info?.available).toBe(true)
    expect(await grants.isGrantedExecutable(executable)).toBe(true)
  })
})

describe('grant issuance and repository authorization', () => {
  it('rejects an arbitrary repository and accepts a granted one', async () => {
    const repo = await makeRepo()
    await expect(router.handle('repo.open', { path: repo })).rejects.toThrow(/not opened through the app/)
    await expect(router.handle('git.status', { path: repo })).rejects.toThrow(/not opened through the app/)

    await grants.grantPath(repo)
    const info = await router.handle('repo.open', { path: repo })
    expect(info.name).toBe(path.basename(repo))
    const status = await router.handle('git.status', { path: repo })
    expect(status.clean).toBe(true)
  })

  it('treats a remembered recent repository as a grant', async () => {
    const repo = await makeRepo()
    await store.addRecentRepo(repo, path.basename(repo))
    const info = await router.handle('repo.open', { path: repo })
    expect(info.path).toBe(repo)
    expect(await grants.allowsRepoPath(repo)).toBe(true)
  })

  it('authorizes a linked worktree through its common Git directory', async () => {
    const repo = await makeRepo()
    const linked = path.join(await makeDir('commit87-ipc-worktrees-'), 'linked')
    await git(repo, ['worktree', 'add', '-q', '-b', 'feature', linked])
    // The picker grants the folder; opening it records the common Git dir.
    await grants.grantPath(repo)
    await router.handle('repo.open', { path: repo })

    expect(await grants.allowsRepoPath(linked)).toBe(true)
    const info = await router.handle('repo.info', { path: linked })
    expect(info.worktree).toBe(true)
    await router.handle('git.status', { path: linked })
  })

  it('grants an init destination inside a picked folder', async () => {
    const parent = await makeDir('commit87-ipc-init-')
    await grants.grantPath(parent)
    const info = await router.handle('repo.init', { directory: parent, name: 'fresh' })
    expect(info.path).toBe(path.join(parent, 'fresh'))
    expect(await grants.allowsRepoPath(info.path)).toBe(true)
    await router.handle('repo.open', { path: info.path })
  })

  it('opens a repository nested inside a granted root', async () => {
    const outer = await makeRepo()
    const inner = path.join(outer, 'nested-repo')
    await fs.mkdir(inner)
    await git(inner, ['init', '-q', '-b', 'main'])
    await grants.grantPath(outer)

    const info = await router.handle('repo.open', { path: inner })
    expect(info.path).toBe(inner)
    await router.handle('git.status', { path: inner })
  })

  it('creates a worktree next to the repository and grants it', async () => {
    const repo = await makeRepo()
    await grants.grantPath(repo)
    await router.handle('repo.open', { path: repo })
    const target = `${repo}-wt`
    dirs.push(target)

    const result = await router.handle('git.worktreeAdd', {
      repoPath: repo,
      path: target,
      branch: 'feature',
      createBranch: true,
      startPoint: 'main'
    })
    expect(result.path).toBe(await fs.realpath(target))
    await router.handle('git.status', { path: result.path })
  })

  it('does not treat a renderer-supplied worktree parent as authority', async () => {
    const repo = await makeRepo()
    await grants.grantPath(repo)
    await router.handle('repo.open', { path: repo })
    const parent = await makeDir('commit87-ipc-wtparent-')
    await router.handle('config.update', { patch: { worktreeParent: parent } })

    await expect(
      router.handle('git.worktreeAdd', {
        repoPath: repo,
        path: path.join(parent, 'wt'),
        branch: 'feature',
        createBranch: true,
        startPoint: 'main'
      })
    ).rejects.toThrow(/folder picker/)
  })

  it('refuses a clone destination that was not picked', async () => {
    const directory = await makeDir('commit87-ipc-clone-')
    await expect(
      router.handle('repo.clone', { url: 'https://example.com/acme/app.git', directory })
    ).rejects.toThrow(/folder picker/)
  })

  it('restricts app.openPath and showItemInFolder to granted paths', async () => {
    const repo = await makeRepo()
    const outside = await makeDir('commit87-ipc-outside-')
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
    await grants.grantPath(repo)

    await expect(router.handle('app.openPath', { path: path.join(outside, 'secret.txt') })).rejects.toThrow(
      /outside the repositories/
    )
    await router.handle('app.openPath', { path: path.join(repo, 'root.txt') })
    expect(shellCalls.opened).toHaveLength(1)
    await router.handle('app.showItemInFolder', { path: path.join(repo, 'root.txt') })
    expect(shellCalls.shown).toHaveLength(1)
  })

  it.skipIf(!canSymlink)('rejects a symlinked escape from a granted folder', async () => {
    const repo = await makeRepo()
    const outside = await makeDir('commit87-ipc-outside-')
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(repo, 'escape.txt'))
    await fs.symlink(outside, path.join(repo, 'escape-dir'))
    await grants.grantPath(repo)

    expect(await grants.allowsOpenPath(path.join(repo, 'escape.txt'), profile.dir)).toBe(false)
    await expect(router.handle('git.fileContent', { path: repo, file: 'escape.txt' })).rejects.toThrow()
    await expect(router.handle('git.fileTree', { path: repo, dir: 'escape-dir' })).rejects.toThrow()
    await expect(router.handle('app.openPath', { path: path.join(repo, 'escape.txt') })).rejects.toThrow()
  })

  it('persists grants and keeps them usable across a restart', async () => {
    const repo = await makeRepo()
    const executable = path.join(await makeDir('commit87-ipc-exec-'), 'git')
    await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await grants.grantPath(repo)
    await grants.grantExecutable(executable)

    const reloaded = new GrantStore(path.join(profile.dir, 'grants.json'))
    await reloaded.load()
    expect(await reloaded.allowsRepoPath(repo)).toBe(true)
    expect(await reloaded.isGrantedExecutable(executable)).toBe(true)
    const mode = (await fs.stat(path.join(profile.dir, 'grants.json'))).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('file reads', () => {
  it('lists normal nested files and reads them from the worktree and HEAD', async () => {
    const repo = await makeRepo()
    const rootEntries = await listTree(repo)
    expect(rootEntries.map((entry) => entry.name)).toEqual(['nested', 'root.txt'])
    expect((await listTree(repo, 'nested'))[0]).toMatchObject({ name: 'file.txt', type: 'file' })
    expect((await readFileContent(repo, 'nested/file.txt', 'worktree')).content).toBe('hello\n')
    expect((await readFileContent(repo, 'nested/file.txt', 'head')).content).toBe('hello\n')
    expect((await readFileContent(repo, 'nested/file.txt', 'head', 'HEAD')).content).toBe('hello\n')
    expect(await getBlame(repo, 'nested/file.txt', 'HEAD')).toHaveLength(1)
  })

  it('rejects traversal, absolute paths and object-spec paths', async () => {
    const repo = await makeRepo()
    const outside = await makeDir('commit87-ipc-outside-')
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
    const relativeEscape = path.relative(repo, path.join(outside, 'secret.txt'))

    await expect(readFileContent(repo, relativeEscape)).rejects.toThrow(/escapes the repository/)
    await expect(readFileContent(repo, path.join(outside, 'secret.txt'))).rejects.toThrow()
    await expect(readFileContent(repo, '--help')).rejects.toThrow()
    await expect(readFileContent(repo, 'nested/file.txt', 'head', '--help')).rejects.toThrow()
    await expect(readFileContent(repo, 'a:b', 'head')).rejects.toThrow(':')
    await expect(listTree(repo, '..')).rejects.toThrow()
  })

  it.skipIf(!canSymlink)('does not follow symlinked files or directories', async () => {
    const repo = await makeRepo()
    const outside = await makeDir('commit87-ipc-outside-')
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(repo, 'escape.txt'))
    await fs.symlink(outside, path.join(repo, 'escape-dir'))

    const entries = await listTree(repo)
    expect(entries.find((entry) => entry.name === 'escape.txt')?.type).toBe('symlink')
    expect(entries.find((entry) => entry.name === 'escape-dir')?.type).toBe('symlink')
    await expect(readFileContent(repo, 'escape.txt')).rejects.toThrow(/symbolic link|regular file/)
    await expect(readFileContent(repo, 'escape-dir/secret.txt')).rejects.toThrow(/symbolic link/)
    await expect(listTree(repo, 'escape-dir')).rejects.toThrow(/symbolic link/)
  })
})

describe('repository config policy', () => {
  it('rejects keys that would execute a program', async () => {
    const repo = await makeRepo()
    for (const key of [
      'core.hooksPath',
      'core.fsmonitor',
      'core.sshCommand',
      'core.pager',
      'core.editor',
      'filter.lfs.clean',
      'diff.images.textconv',
      'credential.helper',
      'alias.sync',
      'include.path',
      'protocol.file.allow',
      'submodule.libs.update',
      'url.evil.insteadOf'
    ]) {
      await expect(setRepoConfig(repo, key, 'x'), key).rejects.toThrow(/program|outside the app/)
    }
  })

  it('keeps ordinary keys working', async () => {
    const repo = await makeRepo()
    await setRepoConfig(repo, 'user.name', 'Test User')
    await setRepoConfig(repo, 'branch.main.description', 'main branch')
    const { stdout } = await run('git', ['config', '--local', '--get', 'user.name'], { cwd: repo })
    expect(stdout.trim()).toBe('Test User')
  })
})

describe('typed destructive flags', () => {
  it('rejects string booleans before any Git operation', async () => {
    const repo = await makeRepo()
    await grants.grantPath(repo)
    await expect(
      router.handle('git.discard', { path: repo, files: ['root.txt'], includeUntracked: 'false' as unknown as boolean })
    ).rejects.toThrow('must be true or false')
    await expect(
      router.handle('git.commit', { repoPath: repo, message: 'x', amend: 'false' as unknown as boolean })
    ).rejects.toThrow('must be true or false')
    await expect(
      router.handle('git.reset', { repoPath: repo, commit: 'HEAD', mode: '--hard' as unknown as 'hard' })
    ).rejects.toThrow('must be one of')
  })

  it('rejects option-shaped revisions and unknown enums', async () => {
    const repo = await makeRepo()
    await grants.grantPath(repo)
    await expect(router.handle('git.checkout', { repoPath: repo, branch: '--orphan' })).rejects.toThrow()
    await expect(router.handle('git.reset', { repoPath: repo, commit: '--hard' })).rejects.toThrow()
    await expect(
      router.handle('provider.pullRequests', {
        accountId: 'missing',
        owner: 'acme',
        repo: 'app',
        state: 'merged' as unknown as 'open'
      })
    ).rejects.toThrow('must be one of')
  })
})
