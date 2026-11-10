import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  BlameLine,
  Commit,
  CommitInput,
  DiffInput,
  DiffResult,
  DirEntry,
  FileContent,
  GitIdentity,
  IntegrationAccount,
  LogInput,
  MergeInput,
  RefInfo,
  RepoConfigEntry,
  RepoInfo,
  RepoStatus,
  ResetInput,
  StashInfo,
  SubmoduleAddInput,
  SubmoduleInfo,
  SubmoduleRemoveResult,
  SubmoduleUpdateInput,
  TagCreateInput,
  TagInfo,
  WorktreeAddInput,
  WorktreeInfo,
  WorktreeStatus,
  CheckoutInput
} from '@shared/types'
import { buildAuthArgs, buildIdentityEnv, gitError, runGit, tryRunGit } from './runner'
import {
  parseBlame,
  parseBranches,
  parseConfig,
  parseLog,
  parseNumstat,
  parseRemotes,
  parseStashes,
  parseStatus,
  normalizeSubmodulePath,
  parseSubmoduleConfig,
  parseSubmodules,
  parseTags,
  parseWorktrees
} from './parsers'
import { detectProviderFromUrl } from '../providers/remote'

export interface GitAuthContext {
  identity?: GitIdentity | null
  account?: IntegrationAccount | null
  token?: string | null
  /** Scope the credential helper to this URL origin (used for submodule add). */
  authOrigin?: string
}

function contextArgs(ctx: GitAuthContext): { args: string[]; env: NodeJS.ProcessEnv } {
  const ident = buildIdentityEnv(ctx.identity)
  const auth = buildAuthArgs(ctx.account ?? null, ctx.token ?? null, ctx.authOrigin)
  return { args: [...ident.args, ...auth.args], env: { ...ident.env, ...auth.env } }
}

export async function resolveRepo(inputPath: string): Promise<RepoInfo> {
  const candidate = path.resolve(inputPath)
  let stat
  try {
    stat = await fs.stat(candidate)
  } catch {
    throw new Error(`Path does not exist: ${candidate}`)
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${candidate}`)

  const cwd = candidate
  const bareResult = await tryRunGit(['rev-parse', '--is-bare-repository'], { cwd })
  if (!bareResult || bareResult.exitCode !== 0) {
    throw new Error(`${cwd} is not a Git repository`)
  }
  const bare = bareResult.stdout.trim() === 'true'
  const gitDirResult = await runGit(['rev-parse', '--absolute-git-dir'], { cwd })
  const gitDir = gitDirResult.stdout.trim()
  let root = candidate
  if (!bare) {
    const top = await runGit(['rev-parse', '--show-toplevel'], { cwd })
    root = top.stdout.trim() || candidate
  }
  const canonicalRoot = await fs.realpath(root).catch(() => path.resolve(root))
  const commonRaw = await tryRunGit(['rev-parse', '--git-common-dir'], { cwd })
  const commonDirRaw = commonRaw?.stdout.trim() ? path.resolve(root, commonRaw.stdout.trim()) : gitDir
  // Symlinked checkouts can reach the same shared Git directory through
  // different paths; resolve it once so linked worktrees group consistently.
  const commonDir = await fs.realpath(commonDirRaw).catch(() => commonDirRaw)
  const linkedWorktree = path.resolve(commonDirRaw) !== path.resolve(gitDir)

  const branchRaw = await tryRunGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })
  const rawBranch = branchRaw?.stdout.trim() ?? 'HEAD'
  const detached = rawBranch === 'HEAD'
  const currentBranch = detached ? null : rawBranch || null
  const headRaw = await tryRunGit(['rev-parse', 'HEAD'], { cwd: root })
  const headSha = headRaw?.stdout.trim() || null

  const statusRaw = await runGit(['status', '--porcelain=v2', '--branch', '-z'], { cwd: root })
  const status = parseStatus(statusRaw.stdout)

  const remotesRaw = await runGit(['remote', '-v'], { cwd: root })
  const remotes = parseRemotes(remotesRaw.stdout).map((remote) => {
    const detected = detectProviderFromUrl(remote.fetchUrl) ?? detectProviderFromUrl(remote.pushUrl)
    return {
      name: remote.name,
      fetchUrl: remote.fetchUrl,
      pushUrl: remote.pushUrl,
      provider: detected?.provider,
      host: detected?.host,
      owner: detected?.owner,
      repo: detected?.repo
    }
  })

  const state = await getOperationState(root)

  return {
    path: root,
    canonicalPath: canonicalRoot,
    root,
    gitDir,
    commonDir,
    name: path.basename(root) || path.basename(candidate),
    isBare: bare,
    currentBranch,
    headSha,
    detached,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    remotes,
    provider: remotes.find((remote) => remote.provider)?.provider,
    state,
    worktree: linkedWorktree
  }
}

export async function getOperationState(repoPath: string): Promise<RepoInfo['state']> {
  const paths = [
    ['MERGE_HEAD', 'merging'],
    ['rebase-merge', 'rebasing'],
    ['rebase-apply', 'rebasing'],
    ['CHERRY_PICK_HEAD', 'cherry-picking'],
    ['REVERT_HEAD', 'reverting'],
    ['BISECT_LOG', 'bisecting']
  ] as const
  for (const [gitPath, state] of paths) {
    const result = await tryRunGit(['rev-parse', '--git-path', gitPath], { cwd: repoPath })
    if (!result) continue
    const resolved = path.resolve(repoPath, result.stdout.trim())
    try {
      await fs.access(resolved)
      if (gitPath === 'rebase-apply') {
        try {
          await fs.access(path.join(resolved, 'applying'))
          return 'applying'
        } catch {
          // rebase
        }
      }
      return state
    } catch {
      // not present
    }
  }
  return 'clean'
}

export async function getStatus(repoPath: string): Promise<RepoStatus> {
  const raw = await runGit(['status', '--porcelain=v2', '--branch', '-z'], { cwd: repoPath })
  return parseStatus(raw.stdout)
}

export async function getLog(input: LogInput): Promise<Commit[]> {
  const head = await tryRunGit(['rev-parse', '--verify', 'HEAD'], { cwd: input.repoPath })
  if (!head || head.exitCode !== 0) return []
  const limit = Math.min(Math.max(input.limit ?? 300, 1), 5000)
  const skip = Math.max(input.skip ?? 0, 0)
  const args = [
    'log',
    '--date-order',
    `--max-count=${limit}`,
    `--skip=${skip}`,
    // Bodies are intentionally omitted: the graph only needs the subject and
    // the full body is loaded on demand through git.commitDetail. This keeps
    // the initial log payload small on repositories with long messages.
    '--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%s%x1e'
  ]
  if (input.search) {
    args.push('--regexp-ignore-case', `--grep=${input.search}`)
  }
  if (input.branch) args.push(input.branch)
  else if (input.all !== false) args.push('--branches', '--tags', '--remotes', 'HEAD')
  args.push('--')
  const raw = await runGit(args, { cwd: input.repoPath, maxBuffer: 32 * 1024 * 1024 })
  return parseLog(raw.stdout)
}

export async function getCommit(repoPath: string, sha: string): Promise<Commit> {
  const raw = await runGit(
    ['show', '-s', '--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%s%x1f%b', sha],
    { cwd: repoPath }
  )
  const commits = parseLog(raw.stdout + '\x1e')
  if (!commits.length) throw new Error(`Commit not found: ${sha}`)
  return commits[0]
}

export async function getBranches(repoPath: string): Promise<RefInfo[]> {
  const repo = await resolveRepo(repoPath)
  const format = [
    '%(refname)',
    '%(objectname)',
    '%(upstream:short)',
    '%(upstream:track)',
    '%(contents:subject)',
    '%(committerdate:unix)',
    '%(authorname)'
  ].join('%1f')
  const raw = await runGit(['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes'], { cwd: repoPath })
  return parseBranches(raw.stdout, repo.currentBranch)
}

export async function getTags(repoPath: string): Promise<TagInfo[]> {
  // `%(contents)` goes last: it may contain newlines and must not be split as
  // a record delimiter. `%00` terminates each record so a message line can
  // never be read as another tag.
  const fields = [
    // `strip=2` removes `refs/tags/` deterministically. `:short` returns
    // `tags/v2` when a branch shares the name, which breaks the UI label.
    '%(refname:strip=2)',
    '%(objectname)',
    '%(objecttype)',
    '%(*objectname)',
    '%(contents:subject)',
    '%(taggername)',
    '%(taggeremail)',
    '%(taggerdate:unix)',
    '%(committerdate:unix)',
    // Fully qualified: `%(refname:short)` returns `tags/v2` when a branch and
    // a tag share a name, and re-prefixing that yields `refs/tags/tags/v2`.
    '%(refname)',
    '%(contents)'
  ]
  const format = `${fields.join('%1f')}%00`
  const raw = await runGit(['for-each-ref', `--format=${format}`, 'refs/tags'], { cwd: repoPath })
  return parseTags(raw.stdout)
}

export async function getWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const raw = await runGit(['worktree', 'list', '--porcelain'], { cwd: repoPath })
  return parseWorktrees(raw.stdout, repoPath)
}

/**
 * Reads a compact status for every worktree in one round trip. Bare, prunable
 * and unreadable checkouts are reported as unavailable instead of failing the
 * whole panel, so one broken worktree cannot hide the rest.
 */
export async function getWorktreeStatuses(repoPath: string): Promise<WorktreeStatus[]> {
  const worktrees = await getWorktrees(repoPath)
  return Promise.all(
    worktrees.map(async (worktree): Promise<WorktreeStatus> => {
      const base = {
        path: worktree.path,
        branch: worktree.branch,
        head: worktree.head
      }
      if (worktree.bare || worktree.prunable) {
        return { ...base, clean: false, fileCount: 0, available: false }
      }
      const raw = await tryRunGit(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], {
        cwd: worktree.path
      })
      if (!raw || raw.exitCode !== 0) {
        return { ...base, clean: false, fileCount: 0, available: false }
      }
      const status = parseStatus(raw.stdout)
      return {
        path: worktree.path,
        branch: status.branch ?? worktree.branch,
        head: status.headSha ?? worktree.head,
        clean: status.clean,
        fileCount: status.files.length,
        available: true
      }
    })
  )
}

export async function getStashes(repoPath: string): Promise<StashInfo[]> {
  const raw = await runGit(['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%ct'], { cwd: repoPath })
  return parseStashes(raw.stdout)
}

export async function getSubmodules(repoPath: string): Promise<SubmoduleInfo[]> {
  const repo = await resolveRepo(repoPath)
  if (repo.isBare) return []

  const [status, config] = await Promise.all([
    // Only top-level entries: nested submodules are owned by their parent
    // checkout, so the superproject cannot update, sync or remove them by path.
    // "Update all" passes --recursive and still advances nested checkouts.
    tryRunGit(['submodule', 'status'], { cwd: repo.path }),
    readSubmoduleConfig(repo.path)
  ])
  // A broken or unmapped .gitmodules must not make the repository impossible
  // to open; the submodule view simply has nothing to show.
  if (!status || status.exitCode !== 0) return []
  const submodules = parseSubmodules(status.stdout, config)

  // The status flag only compares the submodule HEAD with the recorded
  // gitlink. Report uncommitted work inside each initialized checkout too.
  await Promise.all(
    submodules.map(async (submodule) => {
      if (!submodule.initialized) return
      try {
        const worktree = safeJoin(repo.path, submodule.path)
        const dirty = await tryRunGit(['status', '--porcelain', '--untracked-files=normal'], { cwd: worktree })
        if (dirty && dirty.exitCode === 0 && dirty.stdout.trim()) submodule.dirty = true
      } catch {
        // A missing or inaccessible checkout leaves dirty false; the state
        // flag still tells the user the submodule needs attention.
      }
    })
  )
  return submodules
}

export async function addSubmodule(input: SubmoduleAddInput, ctx: GitAuthContext): Promise<void> {
  const repo = await resolveRepo(input.repoPath)
  if (repo.isBare) throw new Error('Submodules need a working tree')
  const url = input.url.trim()
  if (!url) throw new Error('Submodule URL is required')
  if (url.length > 2048 || /[\0\r\n]/.test(url)) throw new Error('Invalid submodule URL')
  const submodulePath = input.path !== undefined ? validateSubmodulePath(repo.path, input.path) : undefined
  if (input.branch) validateRefName(repo.path, input.branch)

  const { args, env } = contextArgs(ctx)
  const addArgs = [...args, 'submodule', 'add']
  if (input.branch) addArgs.push('-b', input.branch)
  if (input.force) addArgs.push('--force')
  addArgs.push('--', url)
  if (submodulePath) addArgs.push(submodulePath)

  // Removing the last submodule drops `.gitmodules` from the working tree but
  // leaves it in HEAD, and `git submodule add` then refuses because the file is
  // "not in the working tree". That is exactly the state a just-removed
  // submodule leaves behind, so recreate the empty file and retry once; Git
  // fills it with the new section and stages it.
  const options = { cwd: repo.path, env, timeoutMs: 600_000 }
  let result = await runGit(addArgs, { ...options, allowFailure: true })
  const gitmodulesPath = path.join(repo.path, '.gitmodules')
  if (
    result.exitCode !== 0 &&
    /\.gitmodules file is in the working tree/i.test(result.stderr) &&
    !(await pathExists(gitmodulesPath))
  ) {
    await fs.writeFile(gitmodulesPath, '')
    result = await runGit(addArgs, { ...options, allowFailure: true })
  }
  if (result.exitCode !== 0) throw gitError(addArgs, result)
}

export async function updateSubmodules(
  input: SubmoduleUpdateInput,
  identity?: GitIdentity | null
): Promise<{ output: string }> {
  const repo = await resolveRepo(input.repoPath)
  if (repo.isBare) throw new Error('Submodules need a working tree')
  const submodulePath = input.submodulePath ? validateSubmodulePath(repo.path, input.submodulePath) : undefined
  if (input.clean && !input.force) throw new Error('Cleaning a submodule requires a forced update')

  const listed = await getSubmodules(repo.path)
  if (submodulePath && !listed.some((submodule) => submodule.path === submodulePath)) {
    throw new Error(`Not a tracked submodule: ${submodulePath}`)
  }

  const ident = buildIdentityEnv(identity)
  const updateArgs = [...ident.args, 'submodule', 'update']
  if (input.init) updateArgs.push('--init')
  if (input.recursive) updateArgs.push('--recursive')
  if (input.remote) updateArgs.push('--remote')
  if (input.force) updateArgs.push('--force')
  if (submodulePath) updateArgs.push('--', submodulePath)
  // No credential helper is installed for updates: `.gitmodules` can point at
  // any host, and the superproject's token must never be offered to it.
  const result = await runGit(updateArgs, { cwd: repo.path, env: ident.env, timeoutMs: 600_000 })

  if (input.clean) {
    const targets = submodulePath
      ? [submodulePath]
      : (await getSubmodules(repo.path))
          .filter((submodule) => submodule.initialized)
          .map((submodule) => submodule.path)
    for (const target of targets) await cleanSubmoduleCheckout(repo.path, target)
  }
  return { output: result.stdout + result.stderr }
}

export async function syncSubmodules(repoPath: string, submodulePath?: string, recursive = false): Promise<void> {
  const repo = await resolveRepo(repoPath)
  if (repo.isBare) throw new Error('Submodules need a working tree')
  const relative = submodulePath ? validateSubmodulePath(repo.path, submodulePath) : undefined
  if (relative) {
    const listed = await getSubmodules(repo.path)
    if (!listed.some((submodule) => submodule.path === relative)) {
      throw new Error(`Not a tracked submodule: ${relative}`)
    }
  }
  const args = ['submodule', 'sync']
  if (recursive) args.push('--recursive')
  if (relative) args.push('--', relative)
  await runGit(args, { cwd: repo.path })
}

/**
 * Remove a tracked submodule: unregister it, remove the working tree and the
 * gitlink, then drop the submodule configuration. Only paths that appear in
 * `git submodule status` are accepted, so this can never delete an arbitrary
 * folder. The module clone under the Git directory is moved aside instead of
 * deleted, so commits that were never pushed stay recoverable and the same URL
 * can be added again at the same path.
 */
export async function removeSubmodule(
  repoPath: string,
  submodulePath: string,
  force = false
): Promise<SubmoduleRemoveResult> {
  const repo = await resolveRepo(repoPath)
  if (repo.isBare) throw new Error('Submodules need a working tree')
  const relative = validateSubmodulePath(repo.path, submodulePath)

  const submodules = await getSubmodules(repo.path)
  const entry = submodules.find((submodule) => submodule.path === relative)
  if (!entry) throw new Error(`Not a tracked submodule: ${relative}`)
  if (!force && (entry.dirty || entry.modified || entry.conflicted)) {
    throw new Error(
      'The submodule has local changes or unpushed commits; force removal discards its working-tree checkout but keeps the local module clone and its objects for recovery'
    )
  }

  const configs = parseSubmoduleConfig(await readSubmoduleConfig(repo.path))
  const configured = [...configs.entries()].find(([, config]) => normalizeSubmodulePath(config.path) === relative)
  const name = configured?.[0] ?? entry.name

  // Resolve the clone the way Git does for *this* worktree: a linked worktree
  // keeps its own copy under <git-dir>/worktrees/<id>/modules. Resolve it
  // before anything is removed so a hostile name in .gitmodules can never make
  // the move touch a directory outside the modules root.
  const modulesRoot = await gitPath(repo.path, 'modules')
  const moduleDir = await gitPath(repo.path, `modules/${name}`)
  const fromModulesRoot = path.relative(modulesRoot, moduleDir)
  const escapesModulesRoot =
    !fromModulesRoot || fromModulesRoot === '..' || fromModulesRoot.startsWith(`..${path.sep}`)
  if (escapesModulesRoot || path.isAbsolute(fromModulesRoot)) {
    throw new Error(`Refusing to move a module clone outside the Git modules directory: ${moduleDir}`)
  }

  // `git submodule deinit` unregisters the checkout before `git rm` runs, so
  // reject an unstaged .gitmodules first: otherwise a failed rm would leave a
  // deinitialized submodule behind. Staged changes (for example a submodule
  // added but not committed yet) are safe to remove.
  const status = await getStatus(repo.path)
  const gitmodules = status.files.find((file) => file.path.toLowerCase() === '.gitmodules')
  if (gitmodules?.stage === 'conflicted' || (gitmodules && gitmodules.worktree !== '.' && gitmodules.worktree !== '?')) {
    throw new Error('Commit or stash changes to .gitmodules before removing a submodule')
  }

  // A submodule that only exists as a staged addition has no HEAD gitlink;
  // deinit would refuse it, so `git rm -f` removes the addition directly.
  const headTree = await tryRunGit(['ls-tree', 'HEAD', '--', relative], { cwd: repo.path })
  const committedInHead = headTree?.stdout.split('\t')[0]?.trim().startsWith('160000') ?? false

  if (committedInHead) {
    await runGit(['submodule', 'deinit', ...(force ? ['-f'] : []), '--', relative], { cwd: repo.path })
  }
  try {
    await runGit(['rm', ...(force || !committedInHead ? ['-f'] : []), '--', relative], { cwd: repo.path })
  } catch (error) {
    // Restore the checkout we just unregistered so a refused removal does not
    // leave the submodule half-removed.
    if (committedInHead && entry.initialized) {
      const restore = await tryRunGit(['submodule', 'update', '--init', '--recursive', '--', relative], {
        cwd: repo.path
      })
      if (!restore || restore.exitCode !== 0) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message}\nThe submodule checkout could not be restored automatically.`)
      }
    }
    throw error
  }

  // A staged-only addition may not be covered by `submodule deinit`; leave no
  // stale submodule.<name> section behind either way.
  if (configured) {
    await runGit(['config', '--remove-section', `submodule.${name}`], {
      cwd: repo.path,
      allowFailure: true
    })
  }

  // `git rm` leaves an empty .gitmodules behind when the last submodule is
  // removed. Drop the file too so the change set is a single clean deletion.
  const remaining = parseSubmoduleConfig(await readSubmoduleConfig(repo.path))
  if (remaining.size === 0) {
    const gitmodulesPath = path.join(repo.path, '.gitmodules')
    const content = await fs.readFile(gitmodulesPath, 'utf8').catch(() => null)
    if (content !== null && content.trim() === '') {
      await runGit(['rm', '-f', '--', '.gitmodules'], { cwd: repo.path, allowFailure: true })
    }
  }

  return { retainedPath: await retainModuleClone(moduleDir) }
}

/** Resolve a path inside this worktree's Git directory the way Git reports it. */
async function gitPath(repoPath: string, target: string): Promise<string> {
  const result = await runGit(['rev-parse', '--git-path', target], { cwd: repoPath })
  const reported = result.stdout.trim()
  if (!reported) throw new Error(`Git did not report the path of ${target}`)
  return path.resolve(repoPath, reported)
}

const MODULE_RETENTION_INFIX = '.removed-'

/**
 * Move the module clone aside so the recovery copy survives while the original
 * name becomes free again: `git submodule add` refuses a name whose directory
 * already exists, and `git submodule update --init` still finds the clone when
 * the user moves `<dir>.removed-<stamp>` back to `<dir>`. The move is a rename
 * inside the same Git directory, so the objects are never copied or deleted.
 */
async function retainModuleClone(moduleDir: string): Promise<string | null> {
  if (!(await pathExists(moduleDir))) return null

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  let failure: unknown = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const target = `${moduleDir}${MODULE_RETENTION_INFIX}${stamp}${attempt === 0 ? '' : `-${attempt}`}`
    try {
      await fs.rename(moduleDir, target)
      return target
    } catch (error) {
      failure = error
      // The clone vanished underneath us: nothing is left to keep.
      if (isErrorCode(error, 'ENOENT')) return null
      // The target name is already taken; try the next counter.
      if (isErrorCode(error, 'EEXIST', 'ENOTEMPTY', 'ENOTDIR')) continue
      break
    }
  }

  const reason = failure instanceof Error ? failure.message : String(failure)
  throw new Error(
    `The submodule was removed, but its module clone could not be moved aside: ${reason}\n` +
      `The clone is still at ${moduleDir}; move or delete that directory before adding a submodule with the same name.`
  )
}

/** Whether anything (directory, file or link) occupies the path. */
async function pathExists(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => true,
    (error: unknown) => {
      if (isErrorCode(error, 'ENOENT')) return false
      throw error
    }
  )
}

function isErrorCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  )
}

async function readSubmoduleConfig(repoPath: string): Promise<string> {
  const result = await tryRunGit(
    ['config', '-f', '.gitmodules', '-z', '--get-regexp', '^submodule\\..*\\.(path|url|branch)$'],
    { cwd: repoPath }
  )
  return result?.stdout ?? ''
}

function validateSubmodulePath(repoPath: string, submodulePath: string): string {
  if (!submodulePath.trim() || /[\0\r\n]/.test(submodulePath)) throw new Error('Invalid submodule path')
  if (path.isAbsolute(submodulePath)) throw new Error('Submodule path must be relative to the repository')
  const posix = submodulePath.replace(/\\/g, '/')
  if (path.posix.isAbsolute(posix)) throw new Error('Submodule path must be relative to the repository')
  const normalized = path.posix.normalize(posix).replace(/\/+$/, '')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Submodule path escapes the repository')
  }
  const segments = normalized.split('/')
  // Trailing dots and spaces alias `.git`/`.gitmodules` on some filesystems.
  const metadata = segments.map((segment) => segment.replace(/[. ]+$/, '').toLowerCase())
  if (metadata.includes('.git') || metadata.join('/') === '.gitmodules') {
    throw new Error('Submodule path cannot point inside Git metadata')
  }
  const absolute = safeJoin(repoPath, normalized)
  if (path.resolve(absolute) === path.resolve(repoPath)) {
    throw new Error('Submodule path must be a subfolder of the repository')
  }
  return normalized
}

/** Remove untracked files from a checkout and every nested submodule inside it. */
async function cleanSubmoduleCheckout(repoPath: string, relative: string): Promise<void> {
  const root = safeJoin(repoPath, relative)
  const nested = await tryRunGit(['submodule', 'status', '--recursive'], { cwd: root })
  const nestedPaths = nested && nested.exitCode === 0 ? parseSubmodules(nested.stdout, '').map((item) => item.path) : []
  for (const target of ['', ...nestedPaths]) {
    const dir = target ? safeJoin(root, target) : root
    const dirty = await tryRunGit(['status', '--porcelain', '--untracked-files=normal'], { cwd: dir })
    if (dirty && dirty.exitCode === 0 && dirty.stdout.trim()) await runGit(['clean', '-ffd'], { cwd: dir })
  }
}

export async function getDiff(input: DiffInput): Promise<DiffResult> {
  const patchArgs = ['diff', '--no-color', '--no-ext-diff', '--find-renames', '--patch']
  const statArgs = ['diff', '--no-color', '--no-ext-diff', '--find-renames', '--numstat']
  const extra: string[] = []
  if (input.staged) extra.push('--cached')
  if (input.compare) extra.push(input.compare)
  if (input.commit) {
    patchArgs.length = 0
    patchArgs.push('show', '--no-color', '--no-ext-diff', '--format=', '--patch', input.commit)
    statArgs.length = 0
    statArgs.push('show', '--no-color', '--no-ext-diff', '--format=', '--numstat', input.commit)
  } else {
    patchArgs.push(...extra)
    statArgs.push(...extra)
  }
  if (input.path) {
    patchArgs.push('--', input.path)
    statArgs.push('--', input.path)
  }
  const [patch, stats] = await Promise.all([
    runGit(patchArgs, { cwd: input.repoPath, maxBuffer: 48 * 1024 * 1024, literalPathspecs: Boolean(input.path) }),
    runGit(statArgs, { cwd: input.repoPath, maxBuffer: 16 * 1024 * 1024, literalPathspecs: Boolean(input.path) })
  ])
  return { patch: patch.stdout, files: parseNumstat(stats.stdout) }
}

export async function listTree(repoPath: string, dir = ''): Promise<DirEntry[]> {
  const root = path.resolve(repoPath)
  const target = safeJoin(root, dir)
  const entries = await fs.readdir(target, { withFileTypes: true })
  const result: DirEntry[] = []
  for (const entry of entries) {
    if (entry.name === '.git') continue
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    const abs = path.join(target, entry.name)
    if (entry.isDirectory()) {
      result.push({ name: entry.name, path: rel, type: 'directory' })
    } else if (entry.isSymbolicLink()) {
      result.push({ name: entry.name, path: rel, type: 'file' })
    } else if (entry.isFile()) {
      let size: number | undefined
      try {
        size = (await fs.stat(abs)).size
      } catch {
        size = undefined
      }
      result.push({ name: entry.name, path: rel, type: 'file', size })
    }
  }
  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

const MAX_FILE_BYTES = 3 * 1024 * 1024
const MAX_RESOLVED_BYTES = 5 * 1024 * 1024

/**
 * Write the resolved content of a currently unmerged path and stage it.
 *
 * The path is accepted only while it is reported as conflicted, never follows a
 * symlink, and must stay inside the repository (including via real paths in the
 * parent chain). This keeps the staging action narrow; ordinary file edits
 * remain in the user's external editor.
 */
export async function resolveConflict(
  repoPath: string,
  file: string,
  content: string,
  expectedSha256?: string
): Promise<void> {
  if (content.includes('\0')) throw new Error('Resolved content contains a NUL byte')
  if (Buffer.byteLength(content, 'utf8') > MAX_RESOLVED_BYTES) {
    throw new Error('Resolved file is too large to save from the app')
  }
  if (/^(?:<<<<<<<|>>>>>>>)/m.test(content)) {
    throw new Error('Remove the conflict markers before staging the file')
  }

  const repo = await resolveRepo(repoPath)
  if (repo.isBare) throw new Error('Conflicted files need a working tree')
  const status = await getStatus(repo.path)
  const entry = status.files.find((item) => item.path === file)
  if (!entry || entry.stage !== 'conflicted') throw new Error('This file is not in conflict')

  const target = safeJoin(repo.path, file)
  const rootReal = await fs.realpath(repo.path)
  let parentReal: string
  try {
    parentReal = await fs.realpath(path.dirname(target))
  } catch {
    throw new Error('The file folder no longer exists; resolve this conflict outside the app')
  }
  if (!isInside(rootReal, parentReal)) throw new Error('Path escapes the repository')

  const existing = await fs.lstat(target).catch(() => null)
  if (existing?.isSymbolicLink()) throw new Error('Symlink conflicts must be resolved outside the app')
  if (existing?.isDirectory()) throw new Error('A directory occupies this path; resolve the conflict outside the app')
  if (existing && !existing.isFile()) throw new Error('Unsupported conflicted path; resolve it outside the app')
  if (existing) {
    if (existing.size > MAX_RESOLVED_BYTES) {
      throw new Error('This file is too large to rewrite from the app')
    }
    const current = await fs.readFile(target)
    if (decodeText(current).binary) {
      throw new Error('This file is not UTF-8 text; resolve it outside the app')
    }
    if (expectedSha256 && sha256(current) !== expectedSha256) {
      throw new Error('The file changed on disk since it was loaded; reload it before saving')
    }
  } else if (expectedSha256) {
    throw new Error('The file changed or was removed on disk since it was loaded; reload it before saving')
  }

  await fs.writeFile(target, content, 'utf8')
  await runGit(['add', '--', file], { cwd: repo.path, literalPathspecs: true })
}

export async function readFileContent(
  repoPath: string,
  file: string,
  from: 'worktree' | 'head' = 'worktree',
  commit?: string
): Promise<FileContent> {
  const root = path.resolve(repoPath)
  let buffer: Buffer
  let size = 0
  if (from === 'worktree') {
    const abs = safeJoin(root, file)
    const stat = await fs.stat(abs)
    if (!stat.isFile()) throw new Error(`Not a file: ${file}`)
    size = stat.size
    const handle = await fs.open(abs, 'r')
    try {
      const length = Math.min(stat.size, MAX_FILE_BYTES)
      const chunk = Buffer.alloc(length)
      await handle.read(chunk, 0, length, 0)
      buffer = chunk
    } finally {
      await handle.close()
    }
  } else {
    const spec = `${commit ?? 'HEAD'}:${file.replace(/\\/g, '/')}`
    const result = await runGit(['show', spec], { cwd: root, maxBuffer: MAX_FILE_BYTES + 1024 })
    buffer = Buffer.from(result.stdout, 'utf8')
    size = buffer.length
  }
  const decoded = decodeText(buffer)
  const truncated = size > MAX_FILE_BYTES
  return {
    path: file,
    content: decoded.content,
    binary: decoded.binary,
    truncated,
    size,
    from,
    // Identity of the exact bytes the editor received, so a later save can
    // reject a file that changed underneath it. Omitted when the read was
    // truncated or the content is not text.
    sha256: truncated || decoded.binary ? undefined : sha256(buffer)
  }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Decode worktree bytes only when they round-trip as UTF-8. A legacy-encoded
 * file has no NUL bytes, so a NUL sample alone is not enough: replacing its
 * bytes with U+FFFD and writing them back would silently corrupt the file.
 */
function decodeText(buffer: Buffer): { content: string; binary: boolean } {
  if (buffer.includes(0)) return { content: '', binary: true }
  const content = buffer.toString('utf8')
  if (!Buffer.from(content, 'utf8').equals(buffer)) return { content: '', binary: true }
  return { content, binary: false }
}

export async function getBlame(repoPath: string, file: string, commit?: string): Promise<BlameLine[]> {
  const args = ['blame', '--line-porcelain', '--', file]
  if (commit) args.splice(1, 0, commit)
  const raw = await runGit(args, { cwd: repoPath, maxBuffer: 32 * 1024 * 1024, literalPathspecs: true })
  return parseBlame(raw.stdout)
}

export async function getRepoConfig(repoPath: string): Promise<RepoConfigEntry[]> {
  const raw = await runGit(['config', '--list', '--show-scope'], { cwd: repoPath, allowFailure: true })
  return parseConfig(raw.stdout)
}

export async function setRepoConfig(repoPath: string, key: string, value: string): Promise<void> {
  if (!/^[a-zA-Z0-9.-]+$/.test(key)) throw new Error('Invalid configuration key')
  await runGit(['config', '--local', key, value], { cwd: repoPath })
}

export async function stageFiles(repoPath: string, files: string[]): Promise<void> {
  const safe = validateFiles(files)
  await runGit(['add', '--', ...safe], { cwd: repoPath, literalPathspecs: true })
}

/** Older Git releases predate `restore`; only that failure may fall back to `reset`. */
function lacksRestoreCommand(stderr: string): boolean {
  return /'restore' is not a git command/i.test(stderr)
}

export async function unstageFiles(repoPath: string, files: string[]): Promise<void> {
  const safe = validateFiles(files)
  const args = ['restore', '--staged', '--', ...safe]
  const result = await runGit(args, { cwd: repoPath, allowFailure: true, literalPathspecs: true })
  if (result.exitCode === 0) return
  if (!lacksRestoreCommand(result.stderr)) throw gitError(args, result)
  await runGit(['reset', '--', ...safe], { cwd: repoPath, literalPathspecs: true })
}

export async function discardFiles(repoPath: string, files: string[], includeUntracked: boolean): Promise<void> {
  const safe = validateFiles(files)
  await runGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...safe], {
    cwd: repoPath,
    allowFailure: true,
    literalPathspecs: true
  })
  if (includeUntracked) {
    await runGit(['clean', '-f', '-d', '--', ...safe], { cwd: repoPath, literalPathspecs: true })
  }
}

export async function commitChanges(input: CommitInput, ctx: GitAuthContext): Promise<{ sha: string }> {
  if (!input.message.trim()) throw new Error('Commit message cannot be empty')
  const { args, env } = contextArgs(ctx)
  const commitArgs = [...args, 'commit', '-m', input.message]
  if (input.amend) commitArgs.push('--amend')
  if (input.signoff) commitArgs.push('--signoff')
  if (input.allowEmpty) commitArgs.push('--allow-empty')
  await runGit(commitArgs, { cwd: input.repoPath, env })
  const head = await runGit(['rev-parse', 'HEAD'], { cwd: input.repoPath })
  return { sha: head.stdout.trim() }
}

export async function checkoutBranch(input: CheckoutInput): Promise<void> {
  if (input.create) {
    validateRefName(input.repoPath, input.branch)
    if (input.startPoint) validateCheckoutTarget(input.repoPath, input.startPoint, true)
    const args = ['switch', '-c', input.branch]
    if (input.track && input.startPoint) args.push('--track')
    if (input.startPoint) args.push(input.startPoint)
    await runGit(args, { cwd: input.repoPath })
    return
  }
  // A checkout target may be a commit (detached) but must never be read as a
  // path: the old `git checkout <name>` fallback restored a tracked file when
  // the ref did not exist.
  validateCheckoutTarget(input.repoPath, input.branch, Boolean(input.detach))
  const args = ['switch']
  if (input.force) args.push('--force')
  if (input.detach) args.push('--detach')
  args.push(input.branch)
  await runGit(args, { cwd: input.repoPath })
}

function validateCheckoutTarget(repoPath: string, target: string, allowCommit: boolean): void {
  if (allowCommit && /^[0-9a-f]{4,64}$/i.test(target)) {
    validateCommitShas([target])
    return
  }
  validateRefName(repoPath, target)
}

export async function createBranch(
  repoPath: string,
  name: string,
  startPoint?: string,
  checkout = false,
  track = false
): Promise<void> {
  validateRefName(repoPath, name)
  if (checkout) {
    const args = ['switch', '-c', name]
    if (track && startPoint) args.push('--track')
    if (startPoint) args.push(startPoint)
    await runGit(args, { cwd: repoPath })
    return
  }
  const args = ['branch', name]
  if (startPoint) args.push(startPoint)
  await runGit(args, { cwd: repoPath })
}

export async function renameBranch(repoPath: string, from: string, to: string): Promise<void> {
  validateRefName(repoPath, to)
  await runGit(['branch', '-m', from, to], { cwd: repoPath })
}

export async function deleteBranch(repoPath: string, name: string, force = false): Promise<void> {
  await runGit(['branch', force ? '-D' : '-d', name], { cwd: repoPath })
}

export async function deleteRemoteBranch(
  repoPath: string,
  branch: string,
  remote: string,
  ctx: GitAuthContext
): Promise<void> {
  const { args, env } = contextArgs(ctx)
  await runGit([...args, 'push', remote, '--delete', branch], { cwd: repoPath, env })
}

export async function setUpstream(repoPath: string, branch: string, upstream: string): Promise<void> {
  await runGit(['branch', `--set-upstream-to=${upstream}`, branch], { cwd: repoPath })
}

export async function mergeBranch(input: MergeInput, ctx: GitAuthContext): Promise<{ output: string }> {
  const { args, env } = contextArgs(ctx)
  const mergeArgs = [...args, 'merge']
  if (input.ffOnly) mergeArgs.push('--ff-only')
  else if (input.noFf) mergeArgs.push('--no-ff')
  if (input.squash) mergeArgs.push('--squash')
  if (input.message) mergeArgs.push('-m', input.message)
  mergeArgs.push(input.branch)
  const result = await runGit(mergeArgs, { cwd: input.repoPath, env, allowFailure: true })
  return { output: result.stdout + result.stderr }
}

export async function rebaseBranch(repoPath: string, onto: string, ctx: GitAuthContext): Promise<{ output: string }> {
  const { args, env } = contextArgs(ctx)
  const result = await runGit([...args, 'rebase', onto], { cwd: repoPath, env, allowFailure: true })
  return { output: result.stdout + result.stderr }
}

/**
 * Validate the commit list crossing the IPC boundary. Only abbreviated or full
 * hexadecimal object names are accepted, so a value can never be read as a git
 * option, and duplicates are collapsed before the sequencer runs.
 */
export function validateCommitShas(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error('Select at least one commit')
  if (value.length > 5000) throw new Error('Too many commits selected')
  const shas = value.map((item) => {
    if (typeof item !== 'string' || !/^[0-9a-f]{4,64}$/i.test(item)) {
      throw new Error(`Invalid commit: ${typeof item === 'string' ? item : 'value'}`)
    }
    return item
  })
  return [...new Set(shas)]
}

export async function cherryPick(repoPath: string, shas: string[], ctx: GitAuthContext): Promise<{ output: string; exitCode: number }> {
  const { args, env } = contextArgs(ctx)
  const commits = validateCommitShas(shas)
  const result = await runGit([...args, 'cherry-pick', ...commits], { cwd: repoPath, env, allowFailure: true })
  return { output: result.stdout + result.stderr, exitCode: result.exitCode }
}

export async function revertCommit(repoPath: string, shas: string[], ctx: GitAuthContext): Promise<{ output: string; exitCode: number }> {
  const { args, env } = contextArgs(ctx)
  const commits = validateCommitShas(shas)
  const result = await runGit([...args, 'revert', '--no-edit', ...commits], { cwd: repoPath, env, allowFailure: true })
  return { output: result.stdout + result.stderr, exitCode: result.exitCode }
}

export async function resetTo(repoPath: string, commit: string, mode: ResetInput['mode']): Promise<void> {
  await runGit(['reset', `--${mode}`, commit], { cwd: repoPath })
}

export async function abortOperation(repoPath: string): Promise<void> {
  const state = await getOperationState(repoPath)
  switch (state) {
    case 'merging':
      await runGit(['merge', '--abort'], { cwd: repoPath })
      break
    case 'rebasing':
      await runGit(['rebase', '--abort'], { cwd: repoPath })
      break
    case 'cherry-picking':
      await runGit(['cherry-pick', '--abort'], { cwd: repoPath })
      break
    case 'reverting':
      await runGit(['revert', '--abort'], { cwd: repoPath })
      break
    case 'applying':
      await runGit(['am', '--abort'], { cwd: repoPath })
      break
    case 'bisecting':
      await runGit(['bisect', 'reset'], { cwd: repoPath })
      break
    default:
      throw new Error('No operation in progress')
  }
}

export async function continueOperation(
  repoPath: string,
  ctx: GitAuthContext,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ output: string }> {
  const state = await getOperationState(repoPath)
  const { args, env } = contextArgs(ctx)
  const runEnv = { ...env, ...extraEnv }
  // GIT_EDITOR is forced non-interactive by the runner unless the rebase bridge
  // installs its message editor for a still-running interactive rebase.
  const command =
    state === 'rebasing'
      ? 'rebase'
      : state === 'cherry-picking'
        ? 'cherry-pick'
        : state === 'reverting'
          ? 'revert'
          : state === 'applying'
            ? 'am'
            : 'merge'
  if (state === 'merging') {
    await runGit([...args, 'commit', '--no-edit'], { cwd: repoPath, env: runEnv })
    return { output: 'Merge commit created' }
  }
  const result = await runGit([...args, command, '--continue'], {
    cwd: repoPath,
    env: runEnv,
    allowFailure: true
  })
  return { output: result.stdout + result.stderr }
}

export async function skipOperation(repoPath: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  const state = await getOperationState(repoPath)
  if (state === 'rebasing') await runGit(['rebase', '--skip'], { cwd: repoPath, env: extraEnv })
  else if (state === 'cherry-picking') await runGit(['cherry-pick', '--skip'], { cwd: repoPath, env: extraEnv })
  else if (state === 'reverting') await runGit(['revert', '--skip'], { cwd: repoPath, env: extraEnv })
  else if (state === 'applying') await runGit(['am', '--skip'], { cwd: repoPath, env: extraEnv })
  else throw new Error('Nothing to skip')
}

export async function createTag(input: TagCreateInput, ctx: GitAuthContext): Promise<void> {
  validateRefName(input.repoPath, input.name)
  const args = input.message ? ['tag', '-a', input.name, '-m', input.message] : ['tag', input.name]
  if (input.commit) args.push(input.commit)
  const { args: identArgs, env } = contextArgs(ctx)
  await runGit([...identArgs, ...args], { cwd: input.repoPath, env })
  if (input.push) {
    await runGit([...identArgs, 'push', input.remote || 'origin', input.name], { cwd: input.repoPath, env })
  }
}

export async function deleteTag(repoPath: string, name: string, remote?: string, ctx?: GitAuthContext): Promise<void> {
  await runGit(['tag', '-d', name], { cwd: repoPath })
  if (remote) {
    const { args, env } = contextArgs(ctx ?? {})
    await runGit([...args, 'push', remote, `:refs/tags/${name}`], { cwd: repoPath, env })
  }
}

export async function addWorktree(input: WorktreeAddInput): Promise<{ path: string }> {
  const target = path.resolve(input.path)
  if (!path.isAbsolute(input.path)) throw new Error('Worktree path must be absolute')
  const repo = await resolveRepo(input.repoPath)
  if (isInside(repo.root, target)) throw new Error('Worktree must be outside the main repository folder')
  await fs.mkdir(path.dirname(target), { recursive: true })
  validateRefName(input.repoPath, input.branch)
  const args = ['worktree', 'add']
  if (input.detach) {
    args.push('--detach', target, input.startPoint || input.branch)
  } else if (input.createBranch) {
    args.push('-b', input.branch, target)
    if (input.startPoint) args.push(input.startPoint)
  } else {
    args.push(target, input.branch)
  }
  await runGit(args, { cwd: repo.root })
  return { path: target }
}

export async function removeWorktree(repoPath: string, worktreePath: string, force = false): Promise<void> {
  const repo = await resolveRepo(repoPath)
  const target = path.resolve(worktreePath)
  if (path.resolve(repo.path) === target) throw new Error('Cannot remove the current worktree')
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(target)
  await runGit(args, { cwd: repo.path })
}

export async function pruneWorktrees(repoPath: string): Promise<void> {
  await runGit(['worktree', 'prune'], { cwd: repoPath })
}

export async function lockWorktree(repoPath: string, worktreePath: string, reason?: string): Promise<void> {
  const args = ['worktree', 'lock']
  if (reason) args.push('--reason', reason)
  args.push(path.resolve(worktreePath))
  await runGit(args, { cwd: repoPath })
}

export async function unlockWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await runGit(['worktree', 'unlock', path.resolve(worktreePath)], { cwd: repoPath })
}

export async function stashPush(
  repoPath: string,
  message: string | undefined,
  includeUntracked: boolean,
  ctx: GitAuthContext
): Promise<void> {
  const { args, env } = contextArgs(ctx)
  const stashArgs = [...args, 'stash', 'push']
  if (includeUntracked) stashArgs.push('-u')
  if (message) stashArgs.push('-m', message)
  await runGit(stashArgs, { cwd: repoPath, env })
}

export async function stashApply(repoPath: string, index: number, pop: boolean): Promise<void> {
  await runGit(['stash', pop ? 'pop' : 'apply', `stash@{${index}}`], { cwd: repoPath })
}

export async function stashDrop(repoPath: string, index: number): Promise<void> {
  await runGit(['stash', 'drop', `stash@{${index}}`], { cwd: repoPath })
}

export async function addRemote(repoPath: string, name: string, url: string): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid remote name')
  await runGit(['remote', 'add', name, url], { cwd: repoPath })
}

export async function removeRemote(repoPath: string, name: string): Promise<void> {
  await runGit(['remote', 'remove', name], { cwd: repoPath })
}

export async function setRemoteUrl(repoPath: string, name: string, url: string, push = false): Promise<void> {
  const args = ['remote', 'set-url']
  if (push) args.push('--push')
  args.push(name, url)
  await runGit(args, { cwd: repoPath })
}

export function validateRefName(repoPath: string, name: string): void {
  if (!name || name.length > 240 || name.includes('..') || name.startsWith('-') || /[\s~^:?*\[\]\\]/.test(name)) {
    throw new Error(`Invalid branch or tag name: ${name}`)
  }
  // git check-ref-format is synchronous-free but we validate conservatively here.
  void repoPath
}

function validateFiles(files: string[]): string[] {
  if (!files.length) throw new Error('No files selected')
  return files.map((file) => {
    if (!file || file.includes('\0') || path.isAbsolute(file)) {
      throw new Error(`Invalid repository path: ${file}`)
    }
    const segments = file.split(/[\\/]/)
    if (segments.includes('..') || segments.includes('.')) {
      throw new Error(`Invalid repository path: ${file}`)
    }
    return file
  })
}

export function safeJoin(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error('Expected a repository-relative path')
  const normalized = path.normalize(relative)
  if (normalized.startsWith('..')) throw new Error('Path escapes the repository')
  const abs = path.resolve(root, normalized)
  if (!isInside(root, abs)) throw new Error('Path escapes the repository')
  return abs
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
