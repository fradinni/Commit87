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
  TagCreateInput,
  TagInfo,
  WorktreeAddInput,
  WorktreeInfo,
  CheckoutInput
} from '@shared/types'
import { buildAuthArgs, buildIdentityEnv, runGit, tryRunGit } from './runner'
import {
  parseBlame,
  parseBranches,
  parseConfig,
  parseLog,
  parseNumstat,
  parseRemotes,
  parseStashes,
  parseStatus,
  parseTags,
  parseWorktrees
} from './parsers'
import { detectProviderFromUrl } from '../providers/remote'

export interface GitAuthContext {
  identity?: GitIdentity | null
  account?: IntegrationAccount | null
  token?: string | null
}

function contextArgs(ctx: GitAuthContext): { args: string[]; env: NodeJS.ProcessEnv } {
  const ident = buildIdentityEnv(ctx.identity)
  const auth = buildAuthArgs(ctx.account ?? null, ctx.token ?? null)
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
  const commonRaw = await tryRunGit(['rev-parse', '--git-common-dir'], { cwd })
  const commonDir = commonRaw?.stdout.trim() ? path.resolve(root, commonRaw.stdout.trim()) : gitDir
  const linkedWorktree = path.resolve(commonDir) !== path.resolve(gitDir)

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

  const state = await detectRepoState(root)

  return {
    path: root,
    root,
    gitDir,
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

async function detectRepoState(repoPath: string): Promise<RepoInfo['state']> {
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
  const limit = Math.min(Math.max(input.limit ?? 300, 1), 5000)
  const skip = Math.max(input.skip ?? 0, 0)
  const args = [
    'log',
    '--date-order',
    `--max-count=${limit}`,
    `--skip=${skip}`,
    '--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%s%x1f%b%x1e'
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
  const format = [
    '%(refname:short)',
    '%(objectname)',
    '%(objecttype)',
    '%(*objectname)',
    '%(contents:subject)',
    '%(taggername)',
    '%(taggeremail)',
    '%(taggerdate:unix)',
    '%(committerdate:unix)',
    '%(contents)'
  ].join('%1f')
  const raw = await runGit(['for-each-ref', `--format=${format}`, 'refs/tags'], { cwd: repoPath })
  return parseTags(raw.stdout)
}

export async function getWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const raw = await runGit(['worktree', 'list', '--porcelain'], { cwd: repoPath })
  return parseWorktrees(raw.stdout, repoPath)
}

export async function getStashes(repoPath: string): Promise<StashInfo[]> {
  const raw = await runGit(['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%ct'], { cwd: repoPath })
  return parseStashes(raw.stdout)
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
    runGit(patchArgs, { cwd: input.repoPath, maxBuffer: 48 * 1024 * 1024 }),
    runGit(statArgs, { cwd: input.repoPath, maxBuffer: 16 * 1024 * 1024 })
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
  const sample = buffer.subarray(0, 8000)
  const binary = sample.includes(0)
  return {
    path: file,
    content: binary ? '' : buffer.toString('utf8'),
    binary,
    truncated: size > MAX_FILE_BYTES,
    size,
    from
  }
}

export async function getBlame(repoPath: string, file: string, commit?: string): Promise<BlameLine[]> {
  const args = ['blame', '--line-porcelain', '--', file]
  if (commit) args.splice(1, 0, commit)
  const raw = await runGit(args, { cwd: repoPath, maxBuffer: 32 * 1024 * 1024 })
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
  await runGit(['add', '--', ...safe], { cwd: repoPath })
}

export async function unstageFiles(repoPath: string, files: string[]): Promise<void> {
  const safe = validateFiles(files)
  const result = await tryRunGit(['restore', '--staged', '--', ...safe], { cwd: repoPath })
  if (!result || result.exitCode !== 0) {
    await runGit(['reset', '--', ...safe], { cwd: repoPath })
  }
}

export async function discardFiles(repoPath: string, files: string[], includeUntracked: boolean): Promise<void> {
  const safe = validateFiles(files)
  await runGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...safe], {
    cwd: repoPath,
    allowFailure: true
  })
  if (includeUntracked) {
    await runGit(['clean', '-f', '-d', '--', ...safe], { cwd: repoPath })
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
    const args = ['switch', '-c', input.branch]
    if (input.track && input.startPoint) args.push('--track')
    if (input.startPoint) args.push(input.startPoint)
    await runGit(args, { cwd: input.repoPath })
    return
  }
  const args = ['switch']
  if (input.force) args.push('--force')
  args.push(input.branch)
  const result = await tryRunGit(args, { cwd: input.repoPath, allowFailure: true })
  if (!result || result.exitCode !== 0) {
    await runGit(['checkout', input.branch], { cwd: input.repoPath })
  }
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

export async function cherryPick(repoPath: string, sha: string, ctx: GitAuthContext): Promise<{ output: string }> {
  const { args, env } = contextArgs(ctx)
  const result = await runGit([...args, 'cherry-pick', sha], { cwd: repoPath, env, allowFailure: true })
  return { output: result.stdout + result.stderr }
}

export async function revertCommit(repoPath: string, sha: string, ctx: GitAuthContext): Promise<{ output: string }> {
  const { args, env } = contextArgs(ctx)
  const result = await runGit([...args, 'revert', '--no-edit', sha], { cwd: repoPath, env, allowFailure: true })
  return { output: result.stdout + result.stderr }
}

export async function resetTo(repoPath: string, commit: string, mode: ResetInput['mode']): Promise<void> {
  await runGit(['reset', `--${mode}`, commit], { cwd: repoPath })
}

export async function abortOperation(repoPath: string): Promise<void> {
  const state = await detectRepoState(repoPath)
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

export async function continueOperation(repoPath: string, ctx: GitAuthContext): Promise<{ output: string }> {
  const state = await detectRepoState(repoPath)
  const { args, env } = contextArgs(ctx)
  // GIT_EDITOR is forced non-interactive by the runner.
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
    await runGit([...args, 'commit', '--no-edit'], { cwd: repoPath, env })
    return { output: 'Merge commit created' }
  }
  const result = await runGit([...args, command, '--continue'], { cwd: repoPath, env, allowFailure: true })
  return { output: result.stdout + result.stderr }
}

export async function skipOperation(repoPath: string): Promise<void> {
  const state = await detectRepoState(repoPath)
  if (state === 'rebasing') await runGit(['rebase', '--skip'], { cwd: repoPath })
  else if (state === 'cherry-picking') await runGit(['cherry-pick', '--skip'], { cwd: repoPath })
  else if (state === 'reverting') await runGit(['revert', '--skip'], { cwd: repoPath })
  else if (state === 'applying') await runGit(['am', '--skip'], { cwd: repoPath })
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
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
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
