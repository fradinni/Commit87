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
}

export interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

const DEFAULT_TIMEOUT = 120_000
const MAX_BUFFER = 64 * 1024 * 1024

let gitBinaryOverride: string | null = null

export function setGitBinary(binary: string | null): void {
  gitBinaryOverride = binary && binary.trim() ? binary.trim() : null
}

export function getGitBinary(): string {
  if (gitBinaryOverride) return gitBinaryOverride
  return process.env.GITGROVE_GIT || 'git'
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
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
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
        reject(new GitError(cleanGitMessage(stderr || stdout, fullArgs), fullArgs, stderr, code))
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
  gitea: 'gitgrove'
}

export function buildAuthArgs(account: IntegrationAccount | null, token: string | null): { args: string[]; env: NodeJS.ProcessEnv } {
  if (!account || !token) return { args: [], env: {} }
  const username = account.username?.trim() || PROVIDER_USERNAME[account.provider]
  const helper =
    '!f() { if test "$1" = get; then ' +
    'printf "username=%s\\npassword=%s\\n" "$GITGROVE_USERNAME" "$GITGROVE_TOKEN"; ' +
    'fi; }; f'
  return {
    args: ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`],
    env: {
      GITGROVE_USERNAME: username,
      GITGROVE_TOKEN: token
    }
  }
}

export async function detectGit(path?: string): Promise<{ path: string; version: string; available: boolean; error?: string }> {
  const previous = getGitBinary()
  if (path) setGitBinary(path)
  try {
    const result = await runGit(['--version'], { cwd: process.cwd(), timeoutMs: 8000 })
    return { path: getGitBinary(), version: result.stdout.trim(), available: true }
  } catch (error) {
    return {
      path: getGitBinary(),
      version: '',
      available: false,
      error: error instanceof Error ? error.message : String(error)
    }
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
