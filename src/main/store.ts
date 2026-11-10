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
  IntegrationAuthority,
  IntegrationInput,
  ProviderId,
  RecentRepo,
  RepoDefaults
} from '@shared/types'
import {
  accountMatchesDestination,
  baseUrlAuthority,
  integrationAuthority,
  isLoopbackHost,
  normalizeBaseUrl,
  type GitDestination
} from './providers/remote'
import { PROVIDERS } from '@shared/types'
import { setGitBinary, tryRunGit } from './git/runner'

interface StoredSecret {
  /** Encrypted or plain token value, depending on `encrypted`. */
  value: string
  /** Authority fingerprint the token was issued for. */
  fingerprint: string
}

interface SecretsFile {
  version: 2
  encrypted: boolean
  tokens: Record<string, StoredSecret>
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
  autoFetchOnOpen: false,
  updateChannel: 'stable',
  autoUpdateCheck: true
}

/** A copy safe to mutate: the default arrays and objects must never be shared. */
function createDefaultConfig(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    identities: [],
    integrations: [],
    repoDefaults: {},
    recentRepos: []
  }
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
  private config: AppConfig = createDefaultConfig()
  private secrets: SecretsFile = { version: 2, encrypted: false, tokens: {} }
  private loaded = false
  private configPath = ''
  private secretsPath = ''
  private authorityBackfilled = false
  /** False when config.json could not be read, so secrets must not be pruned. */
  private configTrusted = true
  private writeQueues = new Map<string, Promise<void>>()

  async init(): Promise<void> {
    const dir = app.getPath('userData')
    await migrateLegacyProfile(dir)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    this.configPath = path.join(dir, 'config.json')
    this.secretsPath = path.join(dir, 'secrets.json')
    await this.loadConfig()
    await this.loadSecrets()
    if (this.authorityBackfilled) await this.saveConfig()
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

  /**
   * Release a token only when it is still bound to the account's current
   * authority. A token saved for one endpoint must never be sent to another
   * after the integration's base URL changed.
   */
  async getToken(accountId: string): Promise<string | null> {
    const stored = this.secrets.tokens[accountId]
    if (!stored) return null
    const account = this.integrationById(accountId)
    if (!account) return null
    if (!this.tokenMatchesAuthority(account, stored)) {
      throw new Error(
        `The saved token for ${account.label} was issued for a different server. Save the token again in Settings → Integrations.`
      )
    }
    if (!this.secrets.encrypted) return stored.value
    try {
      return safeStorage.decryptString(Buffer.from(stored.value, 'base64'))
    } catch {
      return null
    }
  }

  hasToken(accountId: string): boolean {
    const stored = this.secrets.tokens[accountId]
    if (!stored) return false
    const account = this.integrationById(accountId)
    if (!account) return false
    return this.tokenMatchesAuthority(account, stored)
  }

  private tokenMatchesAuthority(account: IntegrationAccount, stored: StoredSecret): boolean {
    const fingerprint = account.authority?.fingerprint
    return Boolean(fingerprint) && stored.fingerprint === fingerprint
  }

  get secretsEncrypted(): boolean {
    return this.secrets.encrypted && safeStorage.isEncryptionAvailable()
  }

  private async setToken(accountId: string, token: string, fingerprint: string): Promise<void> {
    if (!token) {
      delete this.secrets.tokens[accountId]
      await this.saveSecrets()
      return
    }
    if (safeStorage.isEncryptionAvailable()) {
      this.secrets.encrypted = true
      this.secrets.tokens[accountId] = {
        value: safeStorage.encryptString(token).toString('base64'),
        fingerprint
      }
    } else {
      this.secrets.encrypted = false
      this.secrets.tokens[accountId] = { value: token, fingerprint }
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
    const base = baseUrlAuthority(baseUrl)
    if (!base) throw new Error('Base URL is not a valid URL')
    if (base.protocol === 'http' && !isLoopbackHost(base.host)) {
      throw new Error('Integration base URLs must use https (plain http is only allowed for loopback addresses)')
    }
    const label = input.label.trim() || PROVIDERS[provider].name
    const existing = input.id ? this.config.integrations.find((item) => item.id === input.id) : undefined
    if (input.id && !existing) throw new Error('Integration not found')
    // An explicit empty value clears a previously configured clone host; an
    // omitted value keeps it.
    const cloneHost =
      input.cloneHost === undefined ? existing?.authority?.cloneHost : input.cloneHost.trim() || undefined
    const authority = integrationAuthority(provider, baseUrl, cloneHost)
    if (!authority) throw new Error('Base URL is not a valid URL')
    // Moving the endpoint to another provider/host/port invalidates the token
    // that was issued for the old authority. Label, username and identity-only
    // edits keep the same fingerprint and therefore keep the token.
    const authorityChanged = Boolean(existing) && existing?.authority?.fingerprint !== authority.fingerprint

    let account: IntegrationAccount
    if (existing) {
      account = {
        ...existing,
        provider,
        label,
        username: input.username.trim(),
        baseUrl,
        authority,
        identityId: input.identityId || undefined
      }
    } else {
      account = {
        id: randomUUID(),
        provider,
        label,
        username: input.username.trim(),
        baseUrl,
        authority,
        identityId: input.identityId || undefined,
        hasToken: false,
        createdAt: Date.now()
      }
    }

    if (input.token !== undefined && input.token !== '') {
      await this.setToken(account.id, input.token, authority.fingerprint)
    } else if (authorityChanged) {
      await this.deleteToken(account.id)
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

  async addRecentRepo(repoPath: string, name: string): Promise<RecentRepo[]> {
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
    await this.saveConfig()
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

  /**
   * The single authorization path for credentials.
   *
   * - An explicitly requested `accountId` is a user choice, so it must belong
   *   to the destination or the call fails with an actionable error.
   * - Automatic selection prefers the repository's pinned account for the
   *   suggested provider, but every candidate must still match the exact
   *   destination. There is no sole-account fallback and no pinned-account
   *   shortcut: a host that matches nothing stays anonymous.
   */
  authorizeAccount(
    repoPath: string | null | undefined,
    provider: ProviderId | undefined,
    destination: GitDestination | null,
    accountId?: string,
    mode: 'strict' | 'prefer' = 'strict'
  ): IntegrationAccount | undefined {
    if (accountId) {
      const explicit = this.integrationById(accountId)
      if (!explicit) throw new Error('Unknown integration account')
      if (!destination) {
        if (mode === 'strict') throw new Error('Credentials need a remote URL with a network host')
        return undefined
      }
      if (accountMatchesDestination(explicit, destination)) return explicit
      // Automatic flows pass the account detected for the repository, which
      // may belong to a different remote. That is a preference, not a grant:
      // fall through to destination matching instead of failing the command.
      if (mode === 'strict') {
        throw new Error(
          `Integration account "${explicit.label}" is not authorized for ${destination.host}. Choose an account for that host or add one in Settings → Integrations.`
        )
      }
    }
    if (!destination) return undefined

    const matching = this.config.integrations.filter((account) => accountMatchesDestination(account, destination))
    if (!matching.length) return undefined
    // The hostname's provider is a suggestion for choosing among accounts that
    // already match the destination; it can never add or remove authorization.
    const sameProvider = provider ? matching.filter((account) => account.provider === provider) : matching
    const candidates = sameProvider.length ? sameProvider : matching
    const pinned = repoPath ? this.getRepoDefaults(repoPath).integrationByProvider[provider ?? candidates[0].provider] : undefined
    return candidates.find((account) => account.id === pinned) ?? candidates[0]
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
        ...createDefaultConfig(),
        ...parsed,
        schemaVersion: 1,
        identities: Array.isArray(parsed.identities) ? parsed.identities : [],
        integrations: Array.isArray(parsed.integrations) ? parsed.integrations : [],
        repoDefaults: parsed.repoDefaults && typeof parsed.repoDefaults === 'object' ? parsed.repoDefaults : {},
        recentRepos: Array.isArray(parsed.recentRepos) ? parsed.recentRepos : []
      }
      this.authorityBackfilled = this.backfillAuthorities()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.config = createDefaultConfig()
        await this.saveConfig()
        return
      }
      // Keep a profile we could not read or parse for recovery instead of
      // silently overwriting it. Rename rather than copy: it needs no read
      // permission on the file itself, so even an unreadable profile is kept.
      const backup = `${this.configPath}.corrupt-${Date.now()}`
      const kept = await fs.rename(this.configPath, backup).then(
        () => true,
        () => false
      )
      this.configTrusted = false
      const note = kept ? ` (copy kept at ${backup})` : ' (left in place)'
      console.warn(`[commit87] could not read ${this.configPath}: ${detail}${note}`)
      this.config = createDefaultConfig()
      // Never replace a profile that could not be set aside.
      if (kept) await this.saveConfig()
    }
  }

  private async loadSecrets(): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.secretsPath, 'utf8'))
    } catch {
      this.secrets = { version: 2, encrypted: false, tokens: {} }
      return
    }
    const file = parsed as { version?: unknown; encrypted?: unknown; tokens?: unknown } | null
    if (!file || typeof file !== 'object' || !file.tokens || typeof file.tokens !== 'object') {
      this.secrets = { version: 2, encrypted: false, tokens: {} }
      return
    }
    const encrypted = Boolean(file.encrypted)
    if (!this.configTrusted) {
      // The account list could not be read. Keep secrets.json untouched rather
      // than pruning every token as unattributable.
      this.secrets = { version: 2, encrypted, tokens: {} }
      return
    }
    const tokens: Record<string, StoredSecret> = {}
    let changed = false
    for (const [id, value] of Object.entries(file.tokens as Record<string, unknown>)) {
      const account = this.integrationById(id)
      // A token with no account is not attributable to any authority: drop it.
      if (!account) {
        changed = true
        continue
      }
      const fingerprint = account.authority?.fingerprint
      if (!fingerprint) {
        changed = true
        continue
      }
      if (file.version === 2 && value && typeof value === 'object') {
        const stored = value as { value?: unknown; fingerprint?: unknown }
        if (typeof stored.value !== 'string' || typeof stored.fingerprint !== 'string') {
          changed = true
          continue
        }
        // Keep the recorded fingerprint: if it no longer matches the account,
        // getToken refuses it rather than silently re-binding the secret.
        tokens[id] = { value: stored.value, fingerprint: stored.fingerprint }
      } else if (typeof value === 'string') {
        // Version 1 stored `tokens: Record<id, string>` with no authority, and
        // it kept a token across base-URL edits. The server it was issued for
        // is unknowable, so the safe migration is to drop it and ask for it
        // again rather than re-binding it to today's endpoint.
        changed = true
      } else {
        changed = true
      }
    }
    this.secrets = { version: 2, encrypted, tokens }
    if (changed || file.version !== 2) await this.saveSecrets()
  }

  /** Attach the current authority to accounts stored by earlier releases. */
  private backfillAuthorities(): boolean {
    let changed = false
    const integrations = this.config.integrations.map((account) => {
      if (!account || !PROVIDERS[account.provider]) return account
      const authority: IntegrationAuthority | undefined = integrationAuthority(
        account.provider,
        account.baseUrl,
        account.authority?.cloneHost
      )
      if (!authority) return account
      const current = account.authority
      if (
        current?.fingerprint === authority.fingerprint &&
        current.provider === authority.provider &&
        current.host === authority.host &&
        current.port === authority.port &&
        current.cloneHost === authority.cloneHost
      ) {
        return account
      }
      changed = true
      return { ...account, authority }
    })
    this.config.integrations = integrations
    return changed
  }

  private saveConfig(): Promise<void> {
    const data = JSON.stringify(this.config, null, 2)
    return this.enqueueWrite(this.configPath, data, 0o600)
  }

  private saveSecrets(): Promise<void> {
    const data = JSON.stringify(this.secrets, null, 2)
    return this.enqueueWrite(this.secretsPath, data, 0o600)
  }

  /**
   * Serialise writes per file. Several callers can persist the same file at
   * once (opening tabs, task completion, integrations) and the atomic writer
   * reuses one temporary file per target, so overlapping writes would rename
   * each other's file away. A failed write still rejects for its caller
   * without blocking the next one.
   */
  private enqueueWrite(target: string, data: string, mode: number): Promise<void> {
    const previous = this.writeQueues.get(target) ?? Promise.resolve()
    const write = previous.then(() => atomicWrite(target, data, mode))
    this.writeQueues.set(target, write.catch(() => undefined))
    return write
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
