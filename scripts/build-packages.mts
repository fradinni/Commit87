#!/usr/bin/env node
/**
 * Runs electron-builder, retrying the whole packaging step when it fails on a
 * transient network error.
 *
 * electron-builder downloads the Electron runtime and its build toolsets from
 * GitHub releases. Those requests occasionally answer 5xx (notably 504) or drop
 * the connection; electron-builder retries a download three times in-process,
 * but an outage that outlasts those retries kills a build whose configuration
 * and code are fine. This wrapper adds a second layer: attempts separated by an
 * exponential backoff, so a runner rides out a short GitHub incident.
 *
 * Only failures that look like transport problems are retried. A missing build
 * output or a bad target fails on the first attempt, so real errors stay fast.
 *
 *   node scripts/build-packages.mts --config electron-builder.config.cjs --linux --x64 --arm64
 *
 * Environment:
 *   BUILD_PACKAGES_ATTEMPTS             total attempts, including the first (default 4)
 *   BUILD_PACKAGES_RETRY_DELAY_MS       first backoff delay in ms (default 20000)
 *   BUILD_PACKAGES_RETRY_MAX_DELAY_MS   backoff cap in ms (default 120000)
 *   BUILD_PACKAGES_CLI                  electron-builder CLI path (tests only)
 */
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import { fileURLToPath } from 'node:url'

const DEFAULT_ATTEMPTS = 4
const DEFAULT_RETRY_DELAY_MS = 20_000
const DEFAULT_RETRY_MAX_DELAY_MS = 120_000
const MAX_ATTEMPTS = 20
// setTimeout stores its delay in a signed 32-bit integer and fires immediately
// when the value overflows, so a bad override must not reach it unclamped.
const MAX_TIMER_MS = 2_147_483_647
const TAIL_LIMIT = 64 * 1024
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

const TRANSIENT_PATTERNS = [
  /response code 5\d\d/i,
  /http(?: error)? 5\d\d/i,
  /gateway time-?out/i,
  /bad gateway/i,
  /service unavailable/i,
  /socket hang up/i,
  /(?:econnreset|econnrefused|econnaborted|etimedout|eai_again|enotfound|epipe|err_socket|enetunreach|ehostunreach)/i,
  /network (?:error|timeout|is unreachable)/i,
  /tls handshake|client network socket disconnected|secure tls connection/i,
  /checksum mismatch/i
]

interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  output: string
}

export function isTransientFailure(output: string): boolean {
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(output))
}

export function retryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const delay = baseDelayMs * 2 ** Math.max(0, attempt - 1)
  return Math.min(delay, maxDelayMs, MAX_TIMER_MS)
}

function readInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}, got "${raw}"`)
  }
  return value
}

function resolveElectronBuilderCli(): string {
  const override = process.env.BUILD_PACKAGES_CLI?.trim()
  if (override) {
    return override
  }
  return createRequire(import.meta.url).resolve('electron-builder/cli.js')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatDelay(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`
}

function runOnce(cli: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      // Arguments stay in an array and no shell is involved, so paths with spaces
      // work the same on every runner.
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe']
    })
    let output = ''
    const forward = (chunk: Buffer, target: NodeJS.WriteStream): void => {
      target.write(chunk)
      output = (output + chunk.toString('utf8')).slice(-TAIL_LIMIT)
    }
    // A signal aimed at this process must not leave electron-builder running on
    // its own. Forward it, then let main() report the termination instead of
    // retrying.
    const forwardSignal = (signal: NodeJS.Signals): void => {
      child.kill(signal)
    }
    for (const signal of FORWARDED_SIGNALS) {
      process.once(signal, forwardSignal)
    }
    const cleanup = (): void => {
      for (const signal of FORWARDED_SIGNALS) {
        process.off(signal, forwardSignal)
      }
    }
    child.stdout.on('data', (chunk: Buffer) => forward(chunk, process.stdout))
    child.stderr.on('data', (chunk: Buffer) => forward(chunk, process.stderr))
    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code, signal) => {
      cleanup()
      resolve({ code, signal, output })
    })
  })
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const attempts = readInteger('BUILD_PACKAGES_ATTEMPTS', DEFAULT_ATTEMPTS, 1, MAX_ATTEMPTS)
  const baseDelay = readInteger('BUILD_PACKAGES_RETRY_DELAY_MS', DEFAULT_RETRY_DELAY_MS, 0, MAX_TIMER_MS)
  const maxDelay = readInteger('BUILD_PACKAGES_RETRY_MAX_DELAY_MS', DEFAULT_RETRY_MAX_DELAY_MS, 0, MAX_TIMER_MS)
  const cli = resolveElectronBuilderCli()

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempts > 1) {
      console.log(`[build-packages] attempt ${attempt}/${attempts}: electron-builder ${args.join(' ')}`)
    }
    const { code, signal, output } = await runOnce(cli, args)
    if (signal !== null) {
      console.error(`[build-packages] electron-builder was terminated by ${signal}; not retrying`)
      return 128 + (osConstants.signals[signal] ?? 0)
    }
    if (code === 0) {
      if (attempts > 1 && attempt > 1) {
        console.log(`[build-packages] succeeded on attempt ${attempt}/${attempts}`)
      }
      return 0
    }
    const transient = isTransientFailure(output)
    if (!transient) {
      console.error('[build-packages] packaging failed with a non-network error; not retrying')
      return code ?? 1
    }
    if (attempt === attempts) {
      const label = attempts === 1 ? 'attempt' : 'attempts'
      console.error(`[build-packages] transient network error persisted after ${attempts} ${label}; giving up`)
      return code ?? 1
    }
    const delay = retryDelayMs(attempt, baseDelay, maxDelay)
    console.error(
      `[build-packages] attempt ${attempt}/${attempts} failed on a transient network error; ` +
        `retrying in ${formatDelay(delay)}`
    )
    await sleep(delay)
  }

  return 1
}

function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) {
    return false
  }
  try {
    // Compare real paths: Node keeps argv[1] as typed but resolves import.meta.url
    // through symlinks, so a symlinked checkout would otherwise never run main().
    const script = realpathSync(fileURLToPath(import.meta.url))
    const invoked = realpathSync(entry)
    return process.platform === 'win32' ? script.toLowerCase() === invoked.toLowerCase() : script === invoked
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  process.exitCode = await main()
}
