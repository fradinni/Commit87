import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { destinationFromUrl, integrationAuthority } from '../src/main/providers/remote'

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
  integrations?: Array<{ id: string; authority?: { host: string; fingerprint: string } }>
}

interface PersistedSecrets {
  version: number
  encrypted: boolean
  tokens: Record<string, { value: string; fingerprint: string } | string>
}

let userData = ''
const createdDirs: string[] = []

async function readConfig(): Promise<PersistedConfig> {
  return JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8')) as PersistedConfig
}

async function readSecrets(): Promise<PersistedSecrets> {
  return JSON.parse(await fs.readFile(path.join(userData, 'secrets.json'), 'utf8')) as PersistedSecrets
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

describe('AppStore integration authorities', () => {
  async function addGitlab(store: InstanceType<typeof AppStore>, host = 'https://gitlab.company.com') {
    return store.saveIntegration({
      provider: 'gitlab',
      label: 'GitLab',
      username: 'me',
      baseUrl: host,
      token: 'dummy-token'
    })
  }

  it('binds the stored token to the account authority', async () => {
    const store = new AppStore()
    await store.init()
    const account = await addGitlab(store)

    const persisted = await readSecrets()
    expect(persisted.version).toBe(2)
    expect(persisted.tokens[account.id]).toMatchObject({
      value: 'dummy-token',
      fingerprint: integrationAuthority('gitlab', 'https://gitlab.company.com')?.fingerprint
    })
    expect(await store.getToken(account.id)).toBe('dummy-token')
    expect((await readConfig()).integrations?.[0].authority).toMatchObject({ host: 'gitlab.company.com' })
  })

  it('keeps the token for label and username edits', async () => {
    const store = new AppStore()
    await store.init()
    const account = await addGitlab(store)

    const renamed = await store.saveIntegration({
      id: account.id,
      provider: 'gitlab',
      label: 'Work GitLab',
      username: 'ada',
      baseUrl: 'https://gitlab.company.com'
    })

    expect(renamed.hasToken).toBe(true)
    expect(await store.getToken(account.id)).toBe('dummy-token')
  })

  it('clears the token when the endpoint changes without a replacement', async () => {
    const store = new AppStore()
    await store.init()
    const account = await addGitlab(store)

    const moved = await store.saveIntegration({
      id: account.id,
      provider: 'gitlab',
      label: 'GitLab',
      username: 'me',
      baseUrl: 'https://gitlab.other.example'
    })

    expect(moved.hasToken).toBe(false)
    expect(await store.getToken(account.id)).toBeNull()
    expect(Object.keys((await readSecrets()).tokens)).not.toContain(account.id)
  })

  it('binds a replacement token to the new endpoint', async () => {
    const store = new AppStore()
    await store.init()
    const account = await addGitlab(store)

    const moved = await store.saveIntegration({
      id: account.id,
      provider: 'gitlab',
      label: 'GitLab',
      username: 'me',
      baseUrl: 'https://gitlab.other.example',
      token: 'replacement-token'
    })

    expect(moved.hasToken).toBe(true)
    expect(await store.getToken(account.id)).toBe('replacement-token')
    expect((await readSecrets()).tokens[account.id]).toMatchObject({
      fingerprint: integrationAuthority('gitlab', 'https://gitlab.other.example')?.fingerprint
    })
  })

  it('clears the token when the base URL path changes', async () => {
    const store = new AppStore()
    await store.init()
    const account = await store.saveIntegration({
      provider: 'gitlab',
      label: 'GitLab',
      username: 'me',
      baseUrl: 'https://gitlab.company.com/api/v4',
      token: 'dummy-token'
    })

    const moved = await store.saveIntegration({
      id: account.id,
      provider: 'gitlab',
      label: 'GitLab',
      username: 'me',
      baseUrl: 'https://gitlab.company.com/api/v5'
    })

    expect(moved.hasToken).toBe(false)
  })

  it('lets a host match authorize even when the provider heuristic differs', async () => {
    const store = new AppStore()
    await store.init()
    const account = await store.saveIntegration({
      provider: 'gitea',
      label: 'Gitea',
      username: 'me',
      baseUrl: 'https://gitlab.company.com',
      token: 'dummy-token'
    })
    const destination = destinationFromUrl('https://gitlab.company.com/acme/app.git')
    // The hostname suggests "gitlab", but the configured account for that
    // exact host is still the authorized one.
    expect(store.authorizeAccount('/work/alpha', 'gitlab', destination)?.id).toBe(account.id)
  })

  it('rejects plain http endpoints except on loopback', async () => {
    const store = new AppStore()
    await store.init()
    await expect(
      store.saveIntegration({
        provider: 'gitea',
        label: 'Gitea',
        username: 'me',
        baseUrl: 'http://git.internal:3000',
        token: 'dummy-token'
      })
    ).rejects.toThrow(/https/)

    const local = await store.saveIntegration({
      provider: 'gitea',
      label: 'Local',
      username: 'me',
      baseUrl: 'http://127.0.0.1:3000',
      token: 'dummy-token'
    })
    expect(local.hasToken).toBe(true)
  })

  it('drops unbound version 1 tokens, backfills authorities and removes orphans', async () => {
    await fs.writeFile(
      path.join(userData, 'config.json'),
      JSON.stringify({
        schemaVersion: 1,
        integrations: [
          {
            id: 'acc-legacy',
            provider: 'gitlab',
            label: 'GitLab',
            username: 'me',
            baseUrl: 'https://gitlab.company.com',
            hasToken: true,
            createdAt: 0
          }
        ]
      }),
      'utf8'
    )
    await fs.writeFile(
      path.join(userData, 'secrets.json'),
      JSON.stringify({ version: 1, encrypted: false, tokens: { 'acc-legacy': 'legacy-token', orphan: 'orphan-token' } }),
      'utf8'
    )

    const store = new AppStore()
    await store.init()

    // Version 1 kept a token across endpoint edits and recorded no authority,
    // so the server it belongs to is unknowable: require it again.
    expect(await store.getToken('acc-legacy')).toBeNull()
    expect(store.getConfig().integrations[0]?.hasToken).toBe(false)
    const secrets = await readSecrets()
    expect(secrets.version).toBe(2)
    expect(secrets.tokens['acc-legacy']).toBeUndefined()
    expect(secrets.tokens.orphan).toBeUndefined()
    expect((await readConfig()).integrations?.[0].authority).toMatchObject({ host: 'gitlab.company.com' })

    // The migrated profile loads without another rewrite.
    const restarted = new AppStore()
    await restarted.init()
    expect(await restarted.getToken('acc-legacy')).toBeNull()
  })

  it('refuses a stored token whose recorded authority no longer matches', async () => {
    await fs.writeFile(
      path.join(userData, 'config.json'),
      JSON.stringify({
        schemaVersion: 1,
        integrations: [
          {
            id: 'acc',
            provider: 'gitlab',
            label: 'GitLab',
            username: 'me',
            baseUrl: 'https://gitlab.company.com',
            hasToken: true,
            createdAt: 0
          }
        ]
      }),
      'utf8'
    )
    await fs.writeFile(
      path.join(userData, 'secrets.json'),
      JSON.stringify({
        version: 2,
        encrypted: false,
        tokens: { acc: { value: 'stale-token', fingerprint: 'gitlab|gitlab.previous.example||' } }
      }),
      'utf8'
    )

    const store = new AppStore()
    await store.init()
    expect(store.hasToken('acc')).toBe(false)
    await expect(store.getToken('acc')).rejects.toThrow(/different server/)
  })

  it('authorizes only an exact destination, never a pinned or sole account', async () => {
    const store = new AppStore()
    await store.init()
    const account = await addGitlab(store)
    const githubDestination = destinationFromUrl('https://github.com/acme/app.git')
    if (!githubDestination) throw new Error('expected a destination')

    await store.setRepoDefaults('/work/alpha', {
      identityId: undefined,
      defaultRemote: 'origin',
      integrationByProvider: { gitlab: account.id }
    })

    // Pinned and sole account, but the host does not match: anonymous.
    expect(store.authorizeAccount('/work/alpha', 'gitlab', githubDestination)).toBeUndefined()
    expect(store.authorizeAccount('/work/alpha', undefined, githubDestination)).toBeUndefined()

    // An explicit id must match too.
    expect(() => store.authorizeAccount('/work/alpha', 'gitlab', githubDestination, account.id)).toThrow(/not authorized/)
    expect(
      store.authorizeAccount('/work/alpha', undefined, destinationFromUrl('https://gitlab.company.com/a/b.git'), account.id)?.id
    ).toBe(account.id)
  })

  it('prefers a matching pinned account over other matching accounts', async () => {
    const store = new AppStore()
    await store.init()
    await addGitlab(store)
    const second = await store.saveIntegration({
      provider: 'gitlab',
      label: 'Other GitLab',
      username: 'me',
      baseUrl: 'https://gitlab.company.com',
      token: 'other-token'
    })
    await store.setRepoDefaults('/work/alpha', {
      identityId: undefined,
      defaultRemote: 'origin',
      integrationByProvider: { gitlab: second.id }
    })
    const destination = destinationFromUrl('https://gitlab.company.com/a/b.git')
    expect(store.authorizeAccount('/work/alpha', 'gitlab', destination)?.id).toBe(second.id)
  })
})
