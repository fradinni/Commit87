import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Main-owned authorization grants.
 *
 * The renderer is untrusted, so a path it sends is never authority by itself.
 * A grant is issued only by the main process in response to a user gesture it
 * saw directly: a native picker, an OS launch argument/deep link, a clone or
 * init destination derived from a granted parent, or a worktree created inside
 * an approved folder. Repositories are matched by their canonical real path or,
 * for linked worktrees, by the shared common Git directory.
 */

interface GrantFile {
  version: 1
  roots: string[]
  aliases: string[]
  executables: string[]
}

export interface RepoIdentity {
  canonicalPath: string
  commonDir: string
}

const MAX_ENTRIES = 500

function key(target: string): string {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function isErrorCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && codes.includes(error.code)
}

/**
 * `realpath` for a path that may not exist yet: the deepest existing ancestor is
 * canonicalized and the missing tail is re-appended. This makes a clone target
 * comparable to a granted parent before anything is created.
 */
async function canonicalTarget(target: string): Promise<string> {
  const absolute = path.resolve(target)
  let current = absolute
  const tail: string[] = []
  for (;;) {
    try {
      const real = await fs.realpath(current)
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT', 'ENOTDIR')) throw error
      const parent = path.dirname(current)
      if (parent === current) return absolute
      tail.push(path.basename(current))
      current = parent
    }
  }
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(path.resolve(target))
  } catch {
    return null
  }
}

/**
 * Derive the common Git directory of a checkout without spawning Git, so a
 * linked worktree can be authorized before any process runs in it.
 */
export async function commonGitDir(checkout: string): Promise<string | null> {
  const dotGit = path.join(checkout, '.git')
  let stat
  try {
    stat = await fs.lstat(dotGit)
  } catch {
    return null
  }
  if (stat.isDirectory()) return realpathOrNull(dotGit)
  if (!stat.isFile()) return null
  let content: string
  try {
    content = await fs.readFile(dotGit, 'utf8')
  } catch {
    return null
  }
  const match = /^gitdir:\s*(.+)$/m.exec(content)
  if (!match) return null
  const gitDir = path.resolve(checkout, match[1].trim())
  try {
    const common = await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')
    return realpathOrNull(path.resolve(gitDir, common.trim()))
  } catch {
    return realpathOrNull(gitDir)
  }
}

export class GrantStore {
  private readonly filePath: string
  private roots = new Set<string>()
  private aliases = new Set<string>()
  private executables = new Set<string>()
  private loadPromise: Promise<void> | null = null
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /** Load once; safe to call from several startup paths. */
  load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.read()
    return this.loadPromise
  }

  listRoots(): string[] {
    return [...this.roots]
  }

  listExecutables(): string[] {
    return [...this.executables]
  }

  /** Grant a path returned by a native picker, launch argument or app policy. */
  async grantPath(candidate: string): Promise<string> {
    await this.load()
    const canonical = await canonicalTarget(candidate)
    this.roots.add(key(canonical))
    this.trim()
    await this.save()
    return canonical
  }

  /** Grant a resolved repository and the common Git directory it shares. */
  async grantRepo(repo: RepoIdentity): Promise<void> {
    await this.load()
    this.roots.add(key(repo.canonicalPath))
    if (repo.commonDir) this.aliases.add(key(repo.commonDir))
    this.trim()
    await this.save()
  }

  /** Recents are paths the user already opened through the app: valid grants. */
  async seedRecent(paths: string[]): Promise<void> {
    await this.load()
    let changed = false
    for (const candidate of paths) {
      const canonical = await realpathOrNull(candidate)
      if (!canonical) continue
      if (!this.roots.has(key(canonical))) {
        this.roots.add(key(canonical))
        changed = true
      }
    }
    if (changed) {
      this.trim()
      await this.save()
    }
  }

  async grantExecutable(candidate: string): Promise<string> {
    await this.load()
    const canonical = await realpathOrNull(candidate)
    if (!canonical) throw new Error('The Git executable does not exist')
    this.executables.add(key(canonical))
    this.trim()
    await this.save()
    return canonical
  }

  async allowsRepoPath(candidate: string): Promise<boolean> {
    await this.load()
    const declared = path.resolve(candidate)
    if (this.roots.has(key(declared))) return true
    const real = await realpathOrNull(declared)
    if (!real) return false
    if (this.roots.has(key(real))) return true
    const common = await commonGitDir(real)
    return common ? this.aliases.has(key(common)) : false
  }

  async isGrantedRepo(repo: RepoIdentity): Promise<boolean> {
    await this.load()
    if (this.roots.has(key(repo.canonicalPath))) return true
    return Boolean(repo.commonDir) ? this.aliases.has(key(repo.commonDir)) : false
  }

  async isGrantedExecutable(candidate: string): Promise<boolean> {
    await this.load()
    const canonical = await realpathOrNull(candidate)
    return canonical ? this.executables.has(key(canonical)) : false
  }

  async grantedExecutablePath(candidate: string): Promise<string | null> {
    await this.load()
    const canonical = await realpathOrNull(candidate)
    if (!canonical) return null
    return this.executables.has(key(canonical)) ? canonical : null
  }

  /** Canonical path for a file the user picked earlier through a native dialog. */
  async canonicalForOpen(candidate: string): Promise<string | null> {
    await this.load()
    const real = await realpathOrNull(candidate)
    if (!real) return null
    return this.isContained(real) ? real : null
  }

  /** A target that may not exist yet, canonicalized against its nearest ancestor. */
  async canonicalForWrite(candidate: string): Promise<string> {
    await this.load()
    return canonicalTarget(candidate)
  }

  async allowsWrite(candidate: string): Promise<boolean> {
    await this.load()
    const canonical = await canonicalTarget(candidate)
    return this.isContained(canonical)
  }

  /** The app profile/config folder can always be opened by the user. */
  async allowsOpenPath(candidate: string, configDir: string): Promise<boolean> {
    await this.load()
    const real = await realpathOrNull(candidate)
    if (!real) return false
    const config = await realpathOrNull(configDir)
    if (config && isInside(config, real)) return true
    return this.isContained(real)
  }

  private isContained(candidate: string): boolean {
    const realKey = key(candidate)
    for (const root of this.roots) {
      if (root === realKey) return true
      if (isInside(root, candidate)) return true
    }
    return false
  }

  private trim(): void {
    while (this.roots.size > MAX_ENTRIES) {
      const oldest = this.roots.values().next().value
      if (oldest === undefined) break
      this.roots.delete(oldest)
    }
    while (this.aliases.size > MAX_ENTRIES) {
      const oldest = this.aliases.values().next().value
      if (oldest === undefined) break
      this.aliases.delete(oldest)
    }
    while (this.executables.size > 50) {
      const oldest = this.executables.values().next().value
      if (oldest === undefined) break
      this.executables.delete(oldest)
    }
  }

  private async read(): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) {
        const detail = error instanceof Error ? error.message : String(error)
        console.warn(`[commit87] could not read the grant store: ${detail}`)
      }
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const file = parsed as Partial<GrantFile>
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && path.isAbsolute(item)) : []
    this.roots = new Set(strings(file.roots).map(key))
    this.aliases = new Set(strings(file.aliases).map(key))
    this.executables = new Set(strings(file.executables).map(key))
  }

  /**
   * Persistence is best effort. A read-only or full profile must not make
   * opening a repository fail: the in-memory grant still authorizes this
   * session, and the next successful write records it.
   */
  private async save(): Promise<void> {
    const data: GrantFile = {
      version: 1,
      roots: [...this.roots],
      aliases: [...this.aliases],
      executables: [...this.executables]
    }
    const payload = JSON.stringify(data, null, 2)
    const write = this.writeQueue.then(() => atomicWrite(this.filePath, payload))
    this.writeQueue = write.catch(() => undefined)
    try {
      await write
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(`[commit87] could not save the grant store: ${detail}`)
    }
  }

  /** Drop the grant for a repository the user removed from the recent list. */
  async revokePath(candidate: string): Promise<void> {
    await this.load()
    const real = (await realpathOrNull(candidate)) ?? path.resolve(candidate)
    if (this.roots.delete(key(real))) await this.save()
  }
}

async function atomicWrite(target: string, data: string): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`
  await fs.writeFile(tmp, data, { mode: 0o600 })
  await fs.chmod(tmp, 0o600).catch(() => undefined)
  await fs.rename(tmp, target)
}
