import { spawn } from 'node:child_process'
import { constants, existsSync, statSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import type { GitIdentity, IntegrationAccount, ProviderId } from '@shared/types'

export class GitError extends Error {
  readonly stderr: string
  readonly stdout: string
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly args: string[]

  constructor(
    message: string,
    args: string[],
    stderr: string,
    code: number | null,
    stdout = '',
    signal: NodeJS.Signals | null = null
  ) {
    super(message)
    this.name = 'GitError'
    this.args = args
    this.stderr = stderr
    this.stdout = stdout
    this.code = code
    this.signal = signal
  }
}

export interface RunGitOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  input?: string
  timeoutMs?: number
  maxBuffer?: number
  allowFailure?: boolean
  /**
   * Treat paths after `--` as exact filenames instead of pathspec patterns.
   * Only enable this for commands that receive user-selected file names: a
   * pattern such as `notes[1].txt` must not also match `notes1.txt`.
   */
  literalPathspecs?: boolean
}

export interface GitResult {
  stdout: string
  stderr: string
  /** Exit code, or null when the child was terminated by a signal (including a timeout). */
  exitCode: number | null
  signal: NodeJS.Signals | null
}

const DEFAULT_TIMEOUT = 120_000
const MAX_BUFFER = 64 * 1024 * 1024

let gitBinaryOverride: string | null = null
let cachedGitDetection: { path: string; version: string; available: boolean; error?: string } | null = null

export function setGitBinary(binary: string | null): void {
  gitBinaryOverride = binary && binary.trim() ? binary.trim() : null
  cachedGitDetection = null
}

export function getGitBinary(): string {
  if (gitBinaryOverride) return gitBinaryOverride
  // Deliberate local override for tests and automation; it is an operator
  // setting, never something the renderer can set.
  return process.env.COMMIT87_GIT || 'git'
}

/**
 * Cheap use-time check for an explicitly configured executable. A path that
 * existed when it was chosen must still be a regular, executable file when it
 * is actually run; a bare name (`git`) keeps resolving through PATH.
 */
export function assertGitBinaryUsable(binary: string): void {
  if (!binary.includes('/') && !binary.includes('\\')) return
  try {
    const stat = statSync(binary)
    if (!stat.isFile()) throw new Error(`Git executable is not a file: ${binary}`)
    if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
      throw new Error(`Git executable is not executable: ${binary}`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Git executable')) throw error
    throw new Error(`Git executable is no longer available: ${binary}`)
  }
}

export function gitBaseArgs(): string[] {
  return [
    '--no-pager',
    '-c',
    'core.quotepath=false',
    '-c',
    'color.ui=false',
    '-c',
    'advice.detachedHead=false',
    '-c',
    'core.fsmonitor=false'
  ]
}

export async function runGit(args: string[], options: RunGitOptions): Promise<GitResult> {
  const binary = getGitBinary()
  assertGitBinaryUsable(binary)
  const fullArgs = [...gitBaseArgs(), ...args]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    ...(options.literalPathspecs ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
    // Callers may install a controlled editor (the interactive rebase bridge);
    // otherwise git must never wait for an editor.
    GIT_EDITOR: options.env?.GIT_EDITOR || 'true',
    GIT_SEQUENCE_EDITOR: options.env?.GIT_SEQUENCE_EDITOR || 'true',
    LC_ALL: 'C'
  }

  return new Promise<GitResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let terminatedBy: NodeJS.Signals | null = null
    const child = spawn(binary, fullArgs, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      shell: false
    })

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        terminatedBy = 'SIGKILL'
        child.kill('SIGKILL')
        reject(
          new GitError(
            `Git command timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT}ms`,
            fullArgs,
            stderr,
            null,
            stdout,
            terminatedBy
          )
        )
      }
    }, options.timeoutMs ?? DEFAULT_TIMEOUT)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > (options.maxBuffer ?? MAX_BUFFER)) {
        terminatedBy = 'SIGKILL'
        child.kill('SIGKILL')
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new GitError(
            `Git executable not found ("${binary}"). Install Git or set the path in Settings.`,
            fullArgs,
            stderr,
            null,
            stdout
          )
        )
        return
      }
      reject(new GitError(err.message, fullArgs, stderr, null, stdout))
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      const termination = signal ?? terminatedBy
      if (code !== 0 && !options.allowFailure) {
        reject(gitError(fullArgs, { stdout, stderr, exitCode: code, signal: termination }))
        return
      }
      resolve({ stdout, stderr, exitCode: code, signal: termination })
    })

    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    } else {
      child.stdin?.end()
    }
  })
}

export async function tryRunGit(args: string[], options: RunGitOptions): Promise<GitResult | null> {
  try {
    return await runGit(args, { ...options, allowFailure: true })
  } catch {
    return null
  }
}

/** Build the error a failed command would have thrown, for `allowFailure` results. */
export function gitError(args: string[], result: GitResult): GitError {
  return new GitError(
    cleanGitMessage(result.stderr || result.stdout, args),
    args,
    result.stderr,
    result.exitCode,
    result.stdout,
    result.signal
  )
}

function cleanGitMessage(raw: string, args: string[]): string {
  const text = raw.trim()
  if (!text) {
    return `git ${args.join(' ')} failed`
  }
  // Keep the useful git guidance, drop duplicated command echo.
  const lines = text.split(/\r?\n/).filter((line) => !line.startsWith('hint:') || /error|fatal/i.test(line))
  return lines.join('\n').slice(0, 8000)
}

export function redact(text: string, secrets: Array<string | undefined | null>): string {
  let result = text
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      result = result.split(secret).join('********')
    }
  }
  return result
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface IdentityEnvResult {
  env: NodeJS.ProcessEnv
  args: string[]
}

/**
 * The identity fields Git operations may receive. A selected application
 * identity satisfies this shape; for a repository-authored identity the
 * resolver supplies that name/email, keeps the SSH key and omits the signing
 * fields so Git decides whether the work is signed.
 */
export type IdentityEnvInput = Pick<GitIdentity, 'name' | 'email'> &
  Partial<Pick<GitIdentity, 'sshKeyPath' | 'gpgKeyId' | 'gpgSign'>>

export function buildIdentityEnv(identity?: IdentityEnvInput | null): IdentityEnvResult {
  const env: NodeJS.ProcessEnv = {}
  const args: string[] = []
  if (!identity) return { env, args }
  const name = identity.name.trim()
  const email = identity.email.trim()
  if (name) {
    env.GIT_AUTHOR_NAME = name
    env.GIT_COMMITTER_NAME = name
    args.push('-c', `user.name=${name}`)
  }
  if (email) {
    env.GIT_AUTHOR_EMAIL = email
    env.GIT_COMMITTER_EMAIL = email
    args.push('-c', `user.email=${email}`)
  }
  if (identity.gpgSign && identity.gpgKeyId) {
    args.push('-c', `user.signingkey=${identity.gpgKeyId}`, '-c', 'commit.gpgsign=true')
  }
  if (identity.sshKeyPath) {
    const quoted = shellQuote(identity.sshKeyPath)
    env.GIT_SSH_COMMAND = `ssh -i ${quoted} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`
  }
  return { env, args }
}

const PROVIDER_USERNAME: Record<ProviderId, string> = {
  github: 'x-access-token',
  gitlab: 'oauth2',
  bitbucket: 'x-token-auth',
  gitea: 'commit87'
}

/**
 * Build the ephemeral credential helper for an authorized HTTPS destination.
 * The helper is always scoped to one exact URL origin: a redirect or a
 * mistaken host selection cannot offer the token to a different server, and
 * there is deliberately no unscoped form.
 */
export function buildAuthArgs(
  account: IntegrationAccount | null,
  token: string | null,
  origin: string | undefined,
  envPrefix = 'COMMIT87'
): { args: string[]; env: NodeJS.ProcessEnv } {
  if (!account || !token) return { args: [], env: {} }
  if (!origin) {
    throw new Error('Refusing to install a credential helper without an exact origin')
  }
  const username = account.username?.trim() || PROVIDER_USERNAME[account.provider]
  // Each helper reads its own variables, so a command that authorizes fetch and
  // push separately (the console) can never let one scoped helper print the
  // other destination's token.
  const userVar = `${envPrefix}_USERNAME`
  const tokenVar = `${envPrefix}_TOKEN`
  const helper =
    '!f() { if test "$1" = get; then ' +
    `printf "username=%s\\npassword=%s\\n" "$${userVar}" "$${tokenVar}"; ` +
    'fi; }; f'
  const env: NodeJS.ProcessEnv = {
    [userVar]: username,
    [tokenVar]: token
  }
  // Clear ambient helpers, then scope the app helper to the exact URL origin
  // so a redirect or a mistaken host selection cannot offer this token to a
  // different server.
  return {
    args: ['-c', 'credential.helper=', '-c', `credential.${origin}.helper=${helper}`],
    env
  }
}

export async function detectGit(path?: string): Promise<{ path: string; version: string; available: boolean; error?: string }> {
  if (!path && cachedGitDetection) return cachedGitDetection
  const previous = getGitBinary()
  if (path) setGitBinary(path)
  try {
    const result = await runGit(['--version'], { cwd: process.cwd(), timeoutMs: 8000 })
    const info = { path: getGitBinary(), version: result.stdout.trim(), available: true }
    if (!path) cachedGitDetection = info
    return info
  } catch (error) {
    const info = {
      path: getGitBinary(),
      version: '',
      available: false,
      error: error instanceof Error ? error.message : String(error)
    }
    if (!path) cachedGitDetection = info
    return info
  } finally {
    if (path && previous !== path) setGitBinary(previous)
  }
}

export interface GitExecutableCheck {
  ok: boolean
  path?: string
  error?: string
}

/**
 * A custom Git binary must be an absolute path to a regular executable file.
 * The caller additionally grants the canonical path and checks `--version`.
 */
export async function validateGitExecutable(candidate: string): Promise<GitExecutableCheck> {
  const target = candidate.trim()
  if (!target) return { ok: false, error: 'Choose a Git executable' }
  if (!path.isAbsolute(target)) return { ok: false, error: 'The Git executable must be an absolute path' }
  let info
  try {
    info = await stat(target)
  } catch {
    return { ok: false, error: 'The Git executable does not exist' }
  }
  if (!info.isFile()) return { ok: false, error: 'The Git executable must be a regular file' }
  try {
    await access(target, constants.X_OK)
  } catch {
    return { ok: false, error: 'The selected file is not executable' }
  }
  return { ok: true, path: target }
}

export function assertGitAvailableSync(): boolean {
  if (gitBinaryOverride && (gitBinaryOverride.includes('/') || gitBinaryOverride.includes('\\'))) {
    return existsSync(gitBinaryOverride)
  }
  return true
}
