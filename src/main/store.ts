import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type {
  AppConfig,
  GitIdentity,
  IdentityInput,
  IntegrationAccount,
  IntegrationInput,
  ProviderId,
  RecentRepo,
  RepoDefaults
} from '@shared/types'
import { normalizeBaseUrl } from './providers/remote'
import { PROVIDERS } from '@shared/types'
import { setGitBinary, tryRunGit } from './git/runner'

interface SecretsFile {
  version: 1
  encrypted: boolean
  tokens: Record<string, string>
}

const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: 1,
  gitBinary: '',
  theme: 'dark',
  identities: [],
  integrations: [],
  repoDefaults: {},
  recentRepos: [],
  maxCommits: 500,
  confirmDestructive: true,
  autoFetchOnOpen: false
}

/** App name used before the Commit87 rename; profiles were stored under it. */
const LEGACY_APP_NAME = 'GitGrove'
const PROFILE_FILES = ['config.json', 'secrets.json'] as const

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Electron keys `userData` by app name, so a rename starts from an empty profile.
 * Copy the previous profile once, file by file, to keep repositories, identities
 * and integrations. The legacy directory is left in place so a rollback works.
 */
async function migrateLegacyProfile(dir: string): Promise<void> {
  if (await fileExists(path.join(dir, 'config.json'))) return
  const legacy = path.join(path.dirname(dir), LEGACY_APP_NAME)
  if (path.resolve(legacy) === path.resolve(dir)) return
  if (!(await fileExists(path.join(legacy, 'config.json')))) return
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    for (const name of PROFILE_FILES) {
      const source = path.join(legacy, name)
      if (!(await fileExists(source))) continue
      const target = path.join(dir, name)
      await fs.copyFile(source, target)
      await fs.chmod(target, 0o600)
    }
  } catch (error) {
    // A failed migration must not block startup: the user can sign in again.
    const detail = error instanceof Error ? error.message : String(error)
    console.warn(`[commit87] could not migrate the previous profile from ${legacy}: ${detail}`)
  }
}

export class AppStore {
  private config: AppConfig = { ...DEFAULT_CONFIG }
  private secrets: SecretsFile = { version: 1, encrypted: false, tokens: {} }
  private loaded = false
  private configPath = ''
  private secretsPath = ''

  async init(): Promise<void> {
    const dir = app.getPath('userData')
    await migrateLegacyProfile(dir)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    this.configPath = path.join(dir, 'config.json')
    this.secretsPath = path.join(dir, 'secrets.json')
    await this.loadConfig()
    await this.loadSecrets()
    setGitBinary(this.config.gitBinary || null)
    this.loaded = true
    // Discovering the global Git identity shells out to git. Do not block the
    // first window on it: the launchpad can render immediately and the
    // identity is only a convenience default.
    void this.ensureDefaultIdentity()
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  getConfigPath(): string {
    return this.configPath
  }

  getSecretsPath(): string {
    return this.secretsPath
  }

  getConfig(): AppConfig {
    return {
      ...this.config,
      integrations: this.config.integrations.map((account) => ({ ...account, hasToken: this.hasToken(account.id) })),
      identities: this.config.identities.map((identity) => ({ ...identity })),
      recentRepos: this.config.recentRepos.map((repo) => ({ ...repo })),
      repoDefaults: Object.fromEntries(
        Object.entries(this.config.repoDefaults).map(([key, value]) => [
          key,
          { ...value, integrationByProvider: { ...value.integrationByProvider } }
        ])
      )
    }
  }

  async updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    const next: AppConfig = {
      ...this.config,
      ...patch,
      schemaVersion: 1
    }
    if (patch.identities) {
      next.identities = patch.identities.map((identity) => ({ ...identity }))
    }
    if (patch.integrations) {
      next.integrations = patch.integrations.map((account) => ({ ...account }))
    }
    if (!next.identities.some((identity) => identity.isDefault) && next.identities.length) {
      next.identities[0].isDefault = true
    }
    this.config = next
    await this.saveConfig()
    setGitBinary(this.config.gitBinary || null)
    return this.getConfig()
  }

  async getToken(accountId: string): Promise<string | null> {
    const stored = this.secrets.tokens[accountId]
    if (!stored) return null
    if (!this.secrets.encrypted) return stored
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return null
    }
  }

  hasToken(accountId: string): boolean {
    return Boolean(this.secrets.tokens[accountId])
  }

  get secretsEncrypted(): boolean {
    return this.secrets.encrypted && safeStorage.isEncryptionAvailable()
  }

  private async setToken(accountId: string, token: string): Promise<void> {
    if (!token) {
      delete this.secrets.tokens[accountId]
      await this.saveSecrets()
      return
    }
    if (safeStorage.isEncryptionAvailable()) {
      this.secrets.encrypted = true
      this.secrets.tokens[accountId] = safeStorage.encryptString(token).toString('base64')
    } else {
      this.secrets.encrypted = false
      this.secrets.tokens[accountId] = token
    }
    await this.saveSecrets()
  }

  private async deleteToken(accountId: string): Promise<void> {
    if (this.secrets.tokens[accountId]) {
      delete this.secrets.tokens[accountId]
      await this.saveSecrets()
    }
  }

  // -------------------------------------------------------------------------
  // Identities

  listIdentities(): GitIdentity[] {
    return this.getConfig().identities
  }

  async saveIdentity(input: IdentityInput): Promise<GitIdentity> {
    const name = input.name.trim()
    const email = input.email.trim()
    if (!name) throw new Error('A name is required')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email is required')
    let identity: GitIdentity
    if (input.id) {
      const existing = this.config.identities.find((item) => item.id === input.id)
      if (!existing) throw new Error('Identity not found')
      identity = {
        ...existing,
        label: input.label.trim() || name,
        name,
        email,
        sshKeyPath: input.sshKeyPath?.trim() || undefined,
        gpgKeyId: input.gpgKeyId?.trim() || undefined,
        gpgSign: Boolean(input.gpgSign),
        isDefault: input.isDefault ?? existing.isDefault
      }
    } else {
      identity = {
        id: randomUUID(),
        label: input.label.trim() || name,
        name,
        email,
        sshKeyPath: input.sshKeyPath?.trim() || undefined,
        gpgKeyId: input.gpgKeyId?.trim() || undefined,
        gpgSign: Boolean(input.gpgSign),
        isDefault: this.config.identities.length === 0 || Boolean(input.isDefault),
        createdAt: Date.now()
      }
    }
    if (identity.isDefault) {
      this.config.identities = this.config.identities.map((item) => ({ ...item, isDefault: item.id === identity.id }))
    }
    const index = this.config.identities.findIndex((item) => item.id === identity.id)
    if (index >= 0) this.config.identities[index] = identity
    else this.config.identities.push(identity)
    if (!this.config.identities.some((item) => item.isDefault)) {
      this.config.identities[0].isDefault = true
    }
    await this.saveConfig()
    return identity
  }

  async deleteIdentity(id: string): Promise<void> {
    this.config.identities = this.config.identities.filter((item) => item.id !== id)
    if (this.config.identities.length && !this.config.identities.some((item) => item.isDefault)) {
      this.config.identities[0].isDefault = true
    }
    this.config.integrations = this.config.integrations.map((account) =>
      account.identityId === id ? { ...account, identityId: undefined } : account
    )
    for (const repoDefaults of Object.values(this.config.repoDefaults)) {
      if (repoDefaults.identityId === id) repoDefaults.identityId = undefined
    }
    await this.saveConfig()
  }

  async setDefaultIdentity(id: string): Promise<AppConfig> {
    if (!this.config.identities.some((identity) => identity.id === id)) throw new Error('Identity not found')
    this.config.identities = this.config.identities.map((identity) => ({ ...identity, isDefault: identity.id === id }))
    await this.saveConfig()
    return this.getConfig()
  }

  defaultIdentity(): GitIdentity | undefined {
    return this.config.identities.find((identity) => identity.isDefault) ?? this.config.identities[0]
  }

  identityById(id: string | undefined | null): GitIdentity | undefined {
    if (!id) return undefined
    return this.config.identities.find((identity) => identity.id === id)
  }

  // -------------------------------------------------------------------------
  // Integrations

  listIntegrations(): IntegrationAccount[] {
    return this.getConfig().integrations
  }

  async saveIntegration(input: IntegrationInput): Promise<IntegrationAccount> {
    const provider = input.provider
    if (!PROVIDERS[provider]) throw new Error('Unknown provider')
    const baseUrl = normalizeBaseUrl(provider, input.baseUrl)
    const label = input.label.trim() || PROVIDERS[provider].name
    let account: IntegrationAccount
    if (input.id) {
      const existing = this.config.integrations.find((item) => item.id === input.id)
      if (!existing) throw new Error('Integration not found')
      account = {
        ...existing,
        provider,
        label,
        username: input.username.trim(),
        baseUrl,
        identityId: input.identityId || undefined
      }
      if (input.token !== undefined && input.token !== '') {
        await this.setToken(account.id, input.token)
      }
    } else {
      account = {
        id: randomUUID(),
        provider,
        label,
        username: input.username.trim(),
        baseUrl,
        identityId: input.identityId || undefined,
        hasToken: false,
        createdAt: Date.now()
      }
      if (input.token) await this.setToken(account.id, input.token)
    }
    const index = this.config.integrations.findIndex((item) => item.id === account.id)
    if (index >= 0) this.config.integrations[index] = account
    else this.config.integrations.push(account)
    await this.saveConfig()
    return { ...account, hasToken: this.hasToken(account.id) }
  }

  async deleteIntegration(id: string): Promise<void> {
    this.config.integrations = this.config.integrations.filter((item) => item.id !== id)
    for (const repoDefaults of Object.values(this.config.repoDefaults)) {
      for (const provider of Object.keys(repoDefaults.integrationByProvider) as ProviderId[]) {
        if (repoDefaults.integrationByProvider[provider] === id) {
          delete repoDefaults.integrationByProvider[provider]
        }
      }
    }
    await this.deleteToken(id)
    await this.saveConfig()
  }

  integrationById(id: string | undefined | null): IntegrationAccount | undefined {
    if (!id) return undefined
    return this.config.integrations.find((account) => account.id === id)
  }

  // -------------------------------------------------------------------------
  // Repositories

  addRecentRepo(repoPath: string, name: string): RecentRepo[] {
    const now = Date.now()
    const existing = this.config.recentRepos.find((repo) => repoKey(repo.path) === repoKey(repoPath))
    if (existing) {
      existing.lastOpenedAt = now
      existing.name = name
    } else {
      this.config.recentRepos.unshift({ path: repoPath, name, addedAt: now, lastOpenedAt: now })
    }
    this.config.recentRepos = this.config.recentRepos
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.lastOpenedAt - a.lastOpenedAt)
      .slice(0, 40)
    return this.getConfig().recentRepos
  }

  async removeRecentRepo(repoPath: string): Promise<RecentRepo[]> {
    this.config.recentRepos = this.config.recentRepos.filter((repo) => repoKey(repo.path) !== repoKey(repoPath))
    await this.saveConfig()
    return this.getConfig().recentRepos
  }

  async pinRecentRepo(repoPath: string, pinned: boolean): Promise<RecentRepo[]> {
    const repo = this.config.recentRepos.find((item) => repoKey(item.path) === repoKey(repoPath))
    if (repo) repo.pinned = pinned
    this.config.recentRepos = [...this.config.recentRepos].sort(
      (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.lastOpenedAt - a.lastOpenedAt
    )
    await this.saveConfig()
    return this.getConfig().recentRepos
  }

  getRepoDefaults(repoPath: string): RepoDefaults {
    return (
      this.config.repoDefaults[repoKey(repoPath)] ?? {
        identityId: undefined,
        integrationByProvider: {}
      }
    )
  }

  async setRepoDefaults(repoPath: string, defaults: RepoDefaults): Promise<RepoDefaults> {
    this.config.repoDefaults[repoKey(repoPath)] = {
      identityId: defaults.identityId || undefined,
      integrationByProvider: { ...defaults.integrationByProvider },
      defaultRemote: defaults.defaultRemote || undefined
    }
    await this.saveConfig()
    return this.config.repoDefaults[repoKey(repoPath)]
  }

  resolveIdentity(identityId?: string): GitIdentity | undefined {
    return this.identityById(identityId) ?? this.defaultIdentity()
  }

  resolveAccount(repoPath: string, provider?: ProviderId, host?: string): IntegrationAccount | undefined {
    const defaults = this.getRepoDefaults(repoPath)
    if (provider && defaults.integrationByProvider[provider]) {
      const account = this.integrationById(defaults.integrationByProvider[provider])
      if (account) return account
    }
    const hostLower = host?.toLowerCase()
    if (hostLower) {
      for (const account of this.config.integrations) {
        if (provider && account.provider !== provider) continue
        try {
          const accountHost = new URL(account.baseUrl.includes('://') ? account.baseUrl : `https://${account.baseUrl}`).hostname.toLowerCase()
          if (accountHost === hostLower) return account
          if (account.provider === 'github' && accountHost === 'api.github.com' && hostLower === 'github.com') return account
          if (account.provider === 'bitbucket' && accountHost === 'api.bitbucket.org' && hostLower === 'bitbucket.org') return account
        } catch {
          // ignore
        }
      }
    }
    if (provider) {
      const accounts = this.config.integrations.filter((account) => account.provider === provider)
      if (accounts.length === 1) return accounts[0]
      const byDefault = accounts.find((account) => account.id === this.config.repoDefaults[repoKey(repoPath)]?.integrationByProvider[provider])
      if (byDefault) return byDefault
    }
    return undefined
  }

  async setGitBinary(binary: string): Promise<AppConfig> {
    this.config.gitBinary = binary.trim()
    setGitBinary(this.config.gitBinary || null)
    await this.saveConfig()
    return this.getConfig()
  }

  // -------------------------------------------------------------------------
  // Persistence

  private async ensureDefaultIdentity(): Promise<void> {
    if (this.config.identities.length) return
    try {
      const home = os.homedir()
      const [name, email] = await Promise.all([
        tryRunGit(['config', '--global', '--get', 'user.name'], { cwd: home, timeoutMs: 3000 }),
        tryRunGit(['config', '--global', '--get', 'user.email'], { cwd: home, timeoutMs: 3000 })
      ])
      const userName = name?.stdout.trim()
      const userEmail = email?.stdout.trim()
      if (userName && userEmail) {
        this.config.identities.push({
          id: randomUUID(),
          label: 'Personal',
          name: userName,
          email: userEmail,
          isDefault: true,
          createdAt: Date.now()
        })
        await this.saveConfig()
      }
    } catch {
      // No global identity; the UI will prompt for one.
    }
  }

  private async loadConfig(): Promise<void> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppConfig>
      this.config = {
        ...DEFAULT_CONFIG,
        ...parsed,
        schemaVersion: 1,
        identities: Array.isArray(parsed.identities) ? parsed.identities : [],
        integrations: Array.isArray(parsed.integrations) ? parsed.integrations : [],
        repoDefaults: parsed.repoDefaults && typeof parsed.repoDefaults === 'object' ? parsed.repoDefaults : {},
        recentRepos: Array.isArray(parsed.recentRepos) ? parsed.recentRepos : []
      }
    } catch {
      this.config = { ...DEFAULT_CONFIG }
      await this.saveConfig()
    }
  }

  private async loadSecrets(): Promise<void> {
    try {
      const raw = await fs.readFile(this.secretsPath, 'utf8')
      const parsed = JSON.parse(raw) as SecretsFile
      if (parsed && parsed.version === 1 && parsed.tokens && typeof parsed.tokens === 'object') {
        this.secrets = { version: 1, encrypted: Boolean(parsed.encrypted), tokens: parsed.tokens }
      }
    } catch {
      this.secrets = { version: 1, encrypted: false, tokens: {} }
    }
  }

  private async saveConfig(): Promise<void> {
    const data = JSON.stringify(this.config, null, 2)
    await atomicWrite(this.configPath, data, 0o600)
  }

  private async saveSecrets(): Promise<void> {
    const data = JSON.stringify(this.secrets, null, 2)
    await atomicWrite(this.secretsPath, data, 0o600)
  }
}

async function atomicWrite(target: string, data: string, mode: number): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`
  await fs.writeFile(tmp, data, { mode })
  await fs.chmod(tmp, mode).catch(() => undefined)
  await fs.rename(tmp, target)
}

export function repoKey(repoPath: string): string {
  const resolved = path.resolve(repoPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export { DEFAULT_CONFIG }
