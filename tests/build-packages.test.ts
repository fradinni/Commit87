import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { isTransientFailure, retryDelayMs } from '../scripts/build-packages.mts'

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/build-packages.mts')

// Stands in for electron-builder: the first two runs of "flaky" fail with a 504,
// the third succeeds. Other modes fail immediately so the retry rules can be
// checked without touching the network or a real packaging run.
const FIXTURE = `import { readFileSync, writeFileSync } from 'node:fs'

const counter = process.env.FIXTURE_COUNTER
let runs = 0
try {
  runs = Number(readFileSync(counter, 'utf8'))
} catch {}
runs += 1
writeFileSync(counter, String(runs))

const mode = process.argv[2]
if (mode === 'flaky' && runs < 3) {
  console.error('⨯ Response code 504 (Gateway Time-out)')
  process.exit(1)
}
if (mode === 'always-transient') {
  console.error('⨯ Response code 503 (Service Unavailable)')
  process.exit(1)
}
if (mode === 'fatal') {
  console.error('Error: Missing out/main/index.js. Run "npm run build" first.')
  process.exit(1)
}
if (mode === 'exit-two') {
  console.error('Error: configuration is invalid')
  process.exit(2)
}
console.log('packaged ok args=' + process.argv.slice(3).join(' '))
`

interface WrapperResult {
  code: number | null
  output: string
  runs: number
}

let workDir: string
let fixture: string
let counter: string

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'commit87-build-packages-'))
  fixture = path.join(workDir, 'fake-electron-builder.mjs')
  counter = path.join(workDir, 'runs.txt')
  await writeFile(fixture, FIXTURE)
})

beforeEach(async () => {
  await writeFile(counter, '0')
})

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function runWrapper(
  mode: string,
  overrides: Record<string, string> = {},
  extraArgs: string[] = []
): Promise<WrapperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, mode, ...extraArgs], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        BUILD_PACKAGES_CLI: fixture,
        BUILD_PACKAGES_ATTEMPTS: '3',
        BUILD_PACKAGES_RETRY_DELAY_MS: '10',
        BUILD_PACKAGES_RETRY_MAX_DELAY_MS: '20',
        FIXTURE_COUNTER: counter,
        ...overrides
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', async (code) => {
      const runs = await readFile(counter, 'utf8')
        .then(Number)
        .catch(() => -1)
      resolve({ code, output, runs })
    })
  })
}

describe('build-packages retry wrapper', () => {
  it('retries a transient network failure until packaging succeeds', async () => {
    const result = await runWrapper('flaky')

    expect(result.code).toBe(0)
    expect(result.runs).toBe(3)
    expect(result.output).toContain('[build-packages] attempt 1/3')
    expect(result.output).toContain('retrying in 10ms')
    expect(result.output).toContain('succeeded on attempt 3/3')
  })

  it('does not retry a failure that is not a network error', async () => {
    const result = await runWrapper('fatal')

    expect(result.code).toBe(1)
    expect(result.runs).toBe(1)
    expect(result.output).toContain('not retrying')
    expect(result.output).not.toContain('retrying in')
  })

  it('gives up after the configured number of transient attempts', async () => {
    const result = await runWrapper('always-transient')

    expect(result.code).toBe(1)
    expect(result.runs).toBe(3)
    expect(result.output).toContain('persisted after 3 attempts')
  })

  it('honours a single-attempt configuration', async () => {
    const result = await runWrapper('always-transient', { BUILD_PACKAGES_ATTEMPTS: '1' })

    expect(result.code).toBe(1)
    expect(result.runs).toBe(1)
    expect(result.output).toContain('persisted after 1 attempt')
  })

  it('forwards its arguments to electron-builder unchanged', async () => {
    const result = await runWrapper('ok', {}, ['--config', 'electron-builder.config.cjs', '--linux'])

    expect(result.code).toBe(0)
    expect(result.output).toContain('packaged ok args=--config electron-builder.config.cjs --linux')
  })

  it('returns the exit code of a failed build', async () => {
    const result = await runWrapper('exit-two')

    expect(result.code).toBe(2)
    expect(result.runs).toBe(1)
  })

  it('rejects an invalid attempts override before running anything', async () => {
    const result = await runWrapper('ok', { BUILD_PACKAGES_ATTEMPTS: '0' })

    expect(result.code).toBe(1)
    expect(result.runs).toBe(0)
    expect(result.output).toContain('BUILD_PACKAGES_ATTEMPTS must be an integer between 1 and 20')
  })
})

describe('transient failure detection', () => {
  it.each([
    'HTTPError: Response code 504 (Gateway Time-out)',
    '⨯ Response code 502 (Bad Gateway)',
    'Error: read ECONNRESET',
    'Error: getaddrinfo EAI_AGAIN github.com',
    'request to https://github.com failed, reason: socket hang up',
    'checksum mismatch for electron-v45.2.3-linux-x64.zip',
    'Error: Client network socket disconnected before secure TLS connection was established'
  ])('treats a transport failure as transient: %s', (message) => {
    expect(isTransientFailure(message)).toBe(true)
  })

  it.each([
    'Error: Missing out/main/index.js. Run "npm run build" first.',
    'Unrecognized checksum format for "app.zip"',
    'Exit code: 127. Please install bsdtar',
    'error TS2322: Type "string" is not assignable to type "number"'
  ])('does not treat a build error as transient: %s', (message) => {
    expect(isTransientFailure(message)).toBe(false)
  })
})

describe('retry backoff', () => {
  it('doubles the delay per attempt and caps it', () => {
    expect(retryDelayMs(1, 20_000, 120_000)).toBe(20_000)
    expect(retryDelayMs(2, 20_000, 120_000)).toBe(40_000)
    expect(retryDelayMs(3, 20_000, 120_000)).toBe(80_000)
    expect(retryDelayMs(4, 20_000, 120_000)).toBe(120_000)
    expect(retryDelayMs(9, 20_000, 120_000)).toBe(120_000)
    expect(retryDelayMs(9, 1_000_000_000, 10_000_000_000)).toBe(2_147_483_647)
  })
})
