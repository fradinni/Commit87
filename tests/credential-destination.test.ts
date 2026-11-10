import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import type { TaskSpec } from '../src/main/tasks'
import type { UpdateAdapter, UpdateDownloadTask, UpdateInfoSummary } from '../src/main/updates'
import type { UpdateProgress } from '../src/shared/types'
import type { VerifiedAppImage } from '../src/main/appimage-binding'

const run = promisify(execFile)
const profile = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => profile.dir, isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => ''
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => undefined, openPath: async () => '', showItemInFolder: () => undefined }
}))

// Keep the profile store offline, but exercise the real credential helper.

const { AppStore } = await import('../src/main/store')
const { Router } = await import('../src/main/ipc/router')
const { TaskManager } = await import('../src/main/tasks')
const { ProviderService } = await import('../src/main/providers/service')
const { UpdateService } = await import('../src/main/updates')
const { destinationFromUrl } = await import('../src/main/providers/remote')
const { GrantStore } = await import('../src/main/ipc/grants')

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

const dirs: string[] = []
let store: InstanceType<typeof AppStore>
let router: InstanceType<typeof Router>
let providers: InstanceType<typeof ProviderService>
let grants: InstanceType<typeof GrantStore>
let started: TaskSpec[] = []

async function makeDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function makeRepo(remotes: Record<string, string>): Promise<string> {
  const dir = await makeDir('commit87-dest-')
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  for (const [name, url] of Object.entries(remotes)) {
    await run('git', ['remote', 'add', name, url], { cwd: dir })
  }
  // The tests play the main process: a repository they created stands for one
  // the user opened through a native picker.
  await grants.grantPath(dir)
  return dir
}

async function addAccount(
  options: { provider: 'gitlab' | 'github' | 'gitea'; baseUrl: string; label?: string } = {
    provider: 'gitlab',
    baseUrl: 'https://gitlab.company.com'
  }
) {
  return store.saveIntegration({
    provider: options.provider,
    label: options.label ?? options.provider,
    username: 'me',
    baseUrl: options.baseUrl,
    token: 'dummy-token'
  })
}

beforeAll(async () => {
  profile.dir = await makeDir('commit87-dest-profile-')
})

beforeEach(async () => {
  profile.dir = await makeDir('commit87-dest-profile-')
  store = new AppStore()
  await store.init()
  providers = new ProviderService(store)
  grants = new GrantStore(path.join(profile.dir, 'grants.json'))
  await grants.load()
  const tasks = new TaskManager(() => undefined)
  const updates = new UpdateService({
    adapter: new InertAdapter(),
    environment: { platform: process.platform, isPackaged: false },
    version: '0.0.0-test',
    preferences: () => ({ channel: 'stable', autoCheck: false })
  })
  router = new Router(store, tasks, providers, updates, grants, () => null, () => null)
  started = []
  vi.spyOn(TaskManager.prototype, 'start').mockImplementation((spec: TaskSpec) => {
    started.push(spec)
    return { taskId: `task-${started.length}` }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('clone authorization', () => {
  it('rejects an explicit account that does not match the clone destination', async () => {
    const account = await addAccount()
    const directory = await makeDir('commit87-clone-')
    await grants.grantPath(directory)
    await expect(
      router.handle('repo.clone', {
        url: 'https://github.com/acme/app.git',
        directory,
        accountId: account.id
      })
    ).rejects.toThrow(/not authorized/)
    expect(started).toHaveLength(0)
  })

  it('starts an automatic clone anonymous when the only account is for another host', async () => {
    await addAccount()
    const directory = await makeDir('commit87-clone-')
    await grants.grantPath(directory)
    await router.handle('repo.clone', { url: 'https://github.com/acme/app.git', directory })
    const spec = started.at(-1)
    if (!spec) throw new Error('expected a clone task')
    expect(spec.args.join(' ')).not.toContain('credential.')
    expect(spec.env?.COMMIT87_TOKEN).toBeUndefined()
    expect(spec.secrets?.filter(Boolean)).toEqual([])
  })

  it('scopes the helper to the matching clone origin only', async () => {
    await addAccount()
    const directory = await makeDir('commit87-clone-')
    await grants.grantPath(directory)
    await router.handle('repo.clone', { url: 'https://gitlab.company.com/acme/app.git', directory })
    const spec = started.at(-1)
    if (!spec) throw new Error('expected a clone task')
    expect(spec.args.join(' ')).toContain('credential.https://gitlab.company.com.helper=')
    expect(spec.args.join(' ')).not.toMatch(/credential\.helper=!f/)
    expect(spec.args.join(' ')).not.toContain('dummy-token')
    expect(spec.env?.COMMIT87_TOKEN).toBe('dummy-token')
  })
})

describe('fetch and push destinations', () => {
  it('checks fetch and push URLs separately', async () => {
    await addAccount()
    const repo = await makeRepo({ origin: 'https://gitlab.company.com/acme/app.git' })
    await run('git', ['remote', 'set-url', '--push', 'origin', 'https://gitlab.other.example/acme/app.git'], { cwd: repo })

    await router.handle('git.fetch', { repoPath: repo })
    const fetch = started.at(-1)
    if (!fetch) throw new Error('expected a fetch task')
    expect(fetch.args.join(' ')).toContain('credential.https://gitlab.company.com.helper=')
    expect(fetch.args.join(' ')).not.toContain('dummy-token')
    expect(fetch.env?.COMMIT87_TOKEN).toBe('dummy-token')

    await router.handle('git.push', { repoPath: repo, branch: 'main' })
    const push = started.at(-1)
    if (!push) throw new Error('expected a push task')
    expect(push.args.join(' ')).not.toContain('credential.')
    expect(push.env?.COMMIT87_TOKEN).toBeUndefined()
  })
})

describe('automatic account selection', () => {
  it('treats a detected account from another remote as a preference', async () => {
    const account = await addAccount()
    const repo = await makeRepo({ origin: 'ssh://git@code.internal.example/team/app.git' })
    const destination = destinationFromUrl('https://gitlab.other.example/acme/app.git')
    if (!destination) throw new Error('expected a destination')
    // Automatic flows must not fail because the renderer's detected account
    // belongs to a different remote.
    expect(store.authorizeAccount(repo, 'gitlab', destination, account.id, 'prefer')).toBeUndefined()
    // An explicit choice is still strict.
    expect(() => store.authorizeAccount(repo, 'gitlab', destination, account.id)).toThrow(/not authorized/)
  })

  it('prefers the destination-matching account in a non-strict flow', async () => {
    const wrong = await addAccount()
    const right = await addAccount({ provider: 'gitlab', baseUrl: 'https://gitlab.other.example' })
    const destination = destinationFromUrl('https://gitlab.other.example/acme/app.git')
    if (!destination) throw new Error('expected a destination')
    expect(store.authorizeAccount(undefined, 'gitlab', destination, wrong.id, 'prefer')?.id).toBe(right.id)
  })
})

describe('repository defaults bound to remote destinations', () => {
  it('clears a pinned account when the effective remote host changes', async () => {
    const account = await addAccount()
    const repo = await makeRepo({})
    await router.handle('git.remoteAdd', { path: repo, name: 'origin', url: 'https://gitlab.company.com/acme/app.git' })
    await store.setRepoDefaults(repo, {
      identityId: undefined,
      defaultRemote: 'origin',
      integrationByProvider: { gitlab: account.id }
    })

    await router.handle('git.remoteSetUrl', {
      path: repo,
      name: 'origin',
      url: 'https://gitlab.other.example/acme/app.git'
    })

    expect(store.getRepoDefaults(repo).integrationByProvider.gitlab).toBeUndefined()
  })

  it('keeps a pinned account when only the path changes', async () => {
    const account = await addAccount()
    const repo = await makeRepo({ origin: 'https://gitlab.company.com/acme/app.git' })
    await store.setRepoDefaults(repo, {
      identityId: undefined,
      defaultRemote: 'origin',
      integrationByProvider: { gitlab: account.id }
    })

    await router.handle('git.remoteSetUrl', {
      path: repo,
      name: 'origin',
      url: 'https://gitlab.company.com/other/app.git'
    })

    expect(store.getRepoDefaults(repo).integrationByProvider.gitlab).toBe(account.id)
  })

  it('rejects a pinned account that belongs to another provider', async () => {
    const account = await addAccount()
    const repo = await makeRepo({})
    await expect(
      router.handle('repo.setDefaults', {
        path: repo,
        defaults: { integrationByProvider: { github: account.id } }
      })
    ).rejects.toThrow(/is not a GitHub account/)
  })

  it('rejects option-shaped and unsupported remote URLs', async () => {
    const repo = await makeRepo({})
    await expect(router.handle('git.remoteAdd', { path: repo, name: 'bad', url: '--upload-pack=x' })).rejects.toThrow()
    await expect(
      router.handle('git.remoteAdd', { path: repo, name: 'bad', url: 'ext::sh -c whoami' })
    ).rejects.toThrow(/whitespace/)
    await expect(
      router.handle('git.remoteAdd', { path: repo, name: 'bad', url: 'ext://example.com/repo' })
    ).rejects.toThrow(/Unsupported remote scheme/)
  })
})

describe('provider detection and checkout destinations', () => {
  it('returns no account for a hostile lookalike host', async () => {
    await addAccount()
    const repo = await makeRepo({ origin: 'https://gitlab.evil.example/acme/app.git' })
    const detection = await providers.detect(repo)
    expect(detection.host).toBe('gitlab.evil.example')
    expect(detection.provider).toBe('gitlab')
    expect(detection.accountId).toBeUndefined()
  })

  it('returns the account for the configured host', async () => {
    const account = await addAccount()
    const repo = await makeRepo({ origin: 'https://gitlab.company.com/acme/app.git' })
    const detection = await providers.detect(repo)
    expect(detection.accountId).toBe(account.id)
  })

  it('refuses PR checkout when the only matching remote is on another host', async () => {
    const account = await addAccount({ provider: 'github', baseUrl: 'https://api.github.com' })
    const repo = await makeRepo({ origin: 'https://gitlab.evil.example/acme/app.git' })
    await expect(providers.checkoutPullRequest(repo, account.id, 'acme', 'app', 1)).rejects.toThrow(/not authorized/)
  })

  it('never falls back to an unrelated remote for PR checkout', async () => {
    const account = await addAccount({ provider: 'github', baseUrl: 'https://api.github.com' })
    const repo = await makeRepo({ origin: 'https://gitlab.evil.example/other/repo.git' })
    await expect(providers.checkoutPullRequest(repo, account.id, 'acme', 'app', 1)).rejects.toThrow(/No remote points at/)
  })
})
