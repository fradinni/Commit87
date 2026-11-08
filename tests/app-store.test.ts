import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => ''
  }
}))

// Never shell out to the system Git while exercising the profile store.
vi.mock('../src/main/git/runner', () => ({
  setGitBinary: () => undefined,
  tryRunGit: async () => null
}))

const { AppStore } = await import('../src/main/store')

interface PersistedConfig {
  recentRepos: Array<{ path: string; name: string; pinned?: boolean }>
}

let userData = ''
const createdDirs: string[] = []

async function readConfig(): Promise<PersistedConfig> {
  return JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8')) as PersistedConfig
}

async function makeProfileDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'commit87-store-'))
  createdDirs.push(dir)
  return dir
}

beforeEach(async () => {
  createdDirs.length = 0
  userData = await makeProfileDir()
  state.userData = userData
})

afterEach(async () => {
  await Promise.all(createdDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('AppStore recent repositories', () => {
  it('writes a newly opened repository to the profile on disk', async () => {
    const store = new AppStore()
    await store.init()

    await store.addRecentRepo('/work/alpha', 'alpha')

    expect((await readConfig()).recentRepos).toMatchObject([{ path: '/work/alpha', name: 'alpha' }])
    expect((await fs.readdir(userData)).some((name) => name.startsWith('config.json.corrupt-'))).toBe(false)
  })

  it('keeps recent repositories after the app restarts', async () => {
    const first = new AppStore()
    await first.init()
    await first.addRecentRepo('/work/alpha', 'alpha')
    await first.addRecentRepo('/work/beta', 'beta')

    const restarted = new AppStore()
    await restarted.init()

    expect(restarted.getConfig().recentRepos.map((repo) => repo.path)).toEqual(['/work/beta', '/work/alpha'])
  })

  it('updates an existing entry instead of adding a duplicate', async () => {
    const store = new AppStore()
    await store.init()

    await store.addRecentRepo('/work/alpha', 'alpha')
    await store.addRecentRepo('/work/alpha/', 'alpha renamed')

    expect((await readConfig()).recentRepos).toMatchObject([{ path: '/work/alpha', name: 'alpha renamed' }])
  })

  it('serialises concurrent opens and pinning so no update is lost', async () => {
    const store = new AppStore()
    await store.init()

    await Promise.all([
      store.addRecentRepo('/work/alpha', 'alpha'),
      store.addRecentRepo('/work/beta', 'beta'),
      store.pinRecentRepo('/work/alpha', true)
    ])

    const persisted = await readConfig()
    expect(persisted.recentRepos.map((repo) => repo.path).sort()).toEqual(['/work/alpha', '/work/beta'])
    expect(persisted.recentRepos.find((repo) => repo.path === '/work/alpha')?.pinned).toBe(true)
  })

  it('reports a failed write without poisoning the writes after it', async () => {
    const store = new AppStore()
    await store.init()
    // Renaming the temporary file over a directory fails, like a full or
    // read-only profile would, without needing permission tricks.
    const configPath = path.join(userData, 'config.json')
    await fs.rm(configPath)
    await fs.mkdir(configPath)

    await expect(store.addRecentRepo('/work/alpha', 'alpha')).rejects.toThrow()

    // The failed entry stays in memory and must be persisted with the next write.
    await fs.rm(configPath, { recursive: true, force: true })
    await store.addRecentRepo('/work/beta', 'beta')

    const persisted = await readConfig()
    expect(persisted.recentRepos.map((repo) => repo.path).sort()).toEqual(['/work/alpha', '/work/beta'])
  })

  it('does not share the recent list between store instances', async () => {
    const first = new AppStore()
    await first.init()
    await first.addRecentRepo('/work/alpha', 'alpha')

    userData = await makeProfileDir()
    state.userData = userData
    const second = new AppStore()
    await second.init()

    expect(second.getConfig().recentRepos).toEqual([])
  })

  it('keeps a copy of a profile it cannot parse instead of overwriting it', async () => {
    const contents = '{ this is not json'
    await fs.writeFile(path.join(userData, 'config.json'), contents, 'utf8')
    const store = new AppStore()
    await store.init()

    expect(store.getConfig().recentRepos).toEqual([])
    const backup = (await fs.readdir(userData)).find((name) => name.startsWith('config.json.corrupt-'))
    if (!backup) throw new Error('expected the unreadable profile to be kept')
    expect(await fs.readFile(path.join(userData, backup), 'utf8')).toBe(contents)
  })

  it('moves a profile it cannot read aside instead of overwriting it', async () => {
    // A directory cannot be read as a file (so it is not ENOENT) and cannot be
    // copied, but it can be renamed, which is all keeping it requires.
    const configPath = path.join(userData, 'config.json')
    await fs.mkdir(configPath)

    const store = new AppStore()
    await store.init()

    expect(store.getConfig().recentRepos).toEqual([])
    const backup = (await fs.readdir(userData)).find((name) => name.startsWith('config.json.corrupt-'))
    if (!backup) throw new Error('expected the unreadable profile to be kept')
    expect((await fs.stat(path.join(userData, backup))).isDirectory()).toBe(true)
    expect(await readConfig()).toMatchObject({ recentRepos: [] })
  })
})
