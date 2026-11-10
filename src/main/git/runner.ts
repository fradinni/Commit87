import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { GitIdentity, IntegrationAccount, ProviderId } from '@shared/types'

export class GitError extends Error {
  readonly stderr: string
  readonly code: number | null
  readonly args: string[]

  constructor(message: string, args: string[], stderr: string, code: number | null) {
    super(message)
    this.name = 'GitError'
    this.args = args
    this.stderr = stderr
    this.code = code
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
  exitCode: number
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
  return process.env.COMMIT87_GIT || 'git'
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
    const child = spawn(binary, fullArgs, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      shell: false
    })

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        reject(new GitError(`Git command timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT}ms`, fullArgs, stderr, null))
      }
    }, options.timeoutMs ?? DEFAULT_TIMEOUT)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > (options.maxBuffer ?? MAX_BUFFER)) {
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
            null
          )
        )
        return
      }
      reject(new GitError(err.message, fullArgs, stderr, null))
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code !== 0 && !options.allowFailure) {
        reject(gitError(fullArgs, { stdout, stderr, exitCode: code ?? 0 }))
        return
      }
      resolve({ stdout, stderr, exitCode: code ?? 0 })
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
  return new GitError(cleanGitMessage(result.stderr || result.stdout, args), args, result.stderr, result.exitCode)
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

export function buildIdentityEnv(identity?: GitIdentity | null): IdentityEnvResult {
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

export function buildAuthArgs(
  account: IntegrationAccount | null,
  token: string | null,
  origin?: string
): { args: string[]; env: NodeJS.ProcessEnv } {
  if (!account || !token) return { args: [], env: {} }
  const username = account.username?.trim() || PROVIDER_USERNAME[account.provider]
  const helper =
    '!f() { if test "$1" = get; then ' +
    'printf "username=%s\\npassword=%s\\n" "$COMMIT87_USERNAME" "$COMMIT87_TOKEN"; ' +
    'fi; }; f'
  const env = {
    COMMIT87_USERNAME: username,
    COMMIT87_TOKEN: token
  }
  if (origin) {
    // Clear ambient helpers, then scope the app helper to the exact URL origin
    // so a redirect or a mistaken host selection cannot offer this token to a
    // different server.
    return {
      args: ['-c', 'credential.helper=', '-c', `credential.${origin}.helper=${helper}`],
      env
    }
  }
  return {
    args: ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`],
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

export function assertGitAvailableSync(): boolean {
  if (gitBinaryOverride && (gitBinaryOverride.includes('/') || gitBinaryOverride.includes('\\'))) {
    return existsSync(gitBinaryOverride)
  }
  return true
}
