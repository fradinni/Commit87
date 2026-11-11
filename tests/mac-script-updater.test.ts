import { ChildProcess, execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateChannel } from '../src/shared/types'
import { buildSwapHelperScript, createMacScriptUpdater } from '../src/main/mac-script-updater'
import type { MacScriptUpdaterOptions } from '../src/main/mac-script-updater'
import type { ApiRelease } from '../src/main/update-feed'
import { sha256Hex } from '../src/main/update-feed'
import { UpdateService } from '../src/main/updates'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

const VERSION = '0.2.0-beta.9'
const ZIP_ASSET = `Commit87-${VERSION}-mac-arm64.zip`
const ZIP_URL = `https://github.com/fradinni/Commit87/releases/download/v${VERSION}/a.zip`
const ZIP_BYTES = Buffer.from('fake zip payload, verified only by checksum')
const SUMS = `${sha256Hex(ZIP_BYTES)}  ${ZIP_ASSET}\n`
const ALERT = [
  'display alert "Commit87 update failed"',
  'message "The update could not be installed. Your previous installation has been kept.',
  'Quit Commit87 and try again, or use a writable Applications folder." as warning'
].join(' ')
const execFileAsync = promisify(execFile)

let root: string
let cachePath: string
let bundlePath: string
let unrelatedStaging: string

function gate() {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function writeBundle(path: string, marker: string, version = VERSION): Promise<void> {
  await mkdir(join(path, 'Contents'), { recursive: true })
  await writeFile(join(path, 'marker'), marker)
  await writeFile(
    join(path, 'Contents', 'Info.plist'),
    `<dict><key>CFBundleShortVersionString</key><string>${version}</string></dict>`
  )
}

async function bundleTools(file: string, args: string[]): Promise<void> {
  if (file === '/usr/bin/ditto') {
    if (args[0] === '-x') await writeBundle(join(args[3], 'Commit87.app'), 'new')
    else await cp(args[0], args[1], { recursive: true })
  } else if (file !== '/usr/bin/codesign') {
    throw new Error(`Unexpected executable ${file}`)
  }
}

function makeOptions(overrides: Partial<MacScriptUpdaterOptions> = {}) {
  const state = { channel: 'beta' as UpdateChannel, quit: vi.fn() }
  const options: MacScriptUpdaterOptions = {
    owner: 'fradinni',
    repo: 'Commit87',
    arch: 'arm64',
    currentVersion: '0.2.0-beta.8',
    channel: () => state.channel,
    bundlePath,
    cachePath,
    quit: state.quit,
    ...overrides
  }
  return { options, state }
}

function apiRelease(overrides: Partial<ApiRelease> = {}): ApiRelease {
  return {
    tag_name: `v${VERSION}`,
    draft: false,
    prerelease: true,
    published_at: '2026-11-11T10:00:00Z',
    body: 'Fixes and art',
    assets: [{ name: ZIP_ASSET, browser_download_url: ZIP_URL }],
    ...overrides
  }
}

function stubReleases(releases = [apiRelease()]) {
  const fetchMock = vi.fn(async (input: string) => {
    expect(String(input)).toContain('releases?per_page=100')
    return new Response(JSON.stringify(releases), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function stubDownloads(
  sums = SUMS,
  zipResponse?: (init?: RequestInit) => Response | Promise<Response>
) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/releases?per_page=')) {
      return new Response(JSON.stringify([apiRelease()]), { status: 200 })
    }
    if (url === ZIP_URL) {
      return zipResponse ? zipResponse(init) : new Response(ZIP_BYTES, {
        status: 200,
        headers: { 'content-length': String(ZIP_BYTES.length) }
      })
    }
    expect(url).toBe(`https://github.com/fradinni/Commit87/releases/download/v${VERSION}/SHA256SUMS.txt`)
    return new Response(sums, { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function stalledResponse(signal: AbortSignal, chunk?: Uint8Array): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (chunk) controller.enqueue(chunk)
      signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true })
    }
  }))
}

async function readyAdapter(overrides: Partial<MacScriptUpdaterOptions> = {}) {
  stubDownloads()
  const exec = vi.fn(bundleTools)
  const { options, state } = makeOptions({ exec, ...overrides })
  const adapter = createMacScriptUpdater(options)
  await adapter.check()
  await adapter.download(null).promise
  return { adapter, options, state, exec }
}

async function expectAbsent(path: string): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

async function expectOriginalBundle(): Promise<void> {
  expect(await readFile(join(bundlePath, 'marker'), 'utf8')).toBe('old')
  await expectAbsent(join(bundlePath, 'previous.app'))
}

async function installWorkspaces(): Promise<string[]> {
  return (await readdir(dirname(bundlePath))).filter((name) => name.startsWith('.commit87-update-'))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'commit87-mac-updater-test-'))
  cachePath = join(root, 'private cache')
  const folder = process.platform === 'win32' ? 'Applications café' : 'Applications "quoted" café'
  bundlePath = join(root, folder, 'Commit87.app')
  unrelatedStaging = join(root, 'os-temp', 'commit87-update-another-session')
  await writeBundle(bundlePath, 'old', '0.2.0-beta.8')
  await mkdir(unrelatedStaging, { recursive: true })
  await writeFile(join(unrelatedStaging, 'untouched'), 'another session')
  vi.stubEnv('TMPDIR', join(root, 'os-temp'))
  vi.mocked(spawn).mockReset()
  vi.mocked(spawn).mockImplementation(() => { throw new Error('Unexpected real installer helper handoff') })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

interface HelperFixture {
  stagedRoot: string
  incoming: string
  backup: string
  scriptPath: string
  logPath: string
  writeScript: (appPid: number) => Promise<void>
  run: (appPid: number, scenario?: string) => Promise<number>
}

async function helperFixture(): Promise<HelperFixture> {
  const bin = join(root, 'fake bin')
  const stagedRoot = join(dirname(bundlePath), '.commit87-update-fixture with spaces')
  const incoming = join(stagedRoot, 'incoming.app')
  const backup = join(stagedRoot, 'previous.app')
  await mkdir(bin)
  await writeBundle(incoming, 'new')
  const commands: Record<string, string> = {
    codesign: `printf '%s\\n' "$@" > "$FIXTURE_ROOT/codesign-args"
case "$SCENARIO" in signature|restore) exit 1 ;; esac`,
    open: `printf '%s\\n' "$@" > "$FIXTURE_ROOT/open-args"
cat "$1/marker" > "$FIXTURE_ROOT/opened-marker"`,
    osascript: `printf '%s\\n' "$@" > "$FIXTURE_ROOT/alert-args"`,
    seq: `printf '1\\n2\\n'`,
    sleep: `echo waited >> "$FIXTURE_ROOT/waits"`,
    xattr: 'exit 0',
    mv: `printf '%s\\n' "$@" >> "$FIXTURE_ROOT/moves"
case "$1" in "$FIXTURE_ROOT"/*) ;; *) exit 90 ;; esac
case "$2" in "$FIXTURE_ROOT"/*) ;; *) exit 90 ;; esac
if [ "$SCENARIO" = rename ] && [ "$1" = "$TEST_INCOMING" ]; then
  mkdir -p "$2"
  echo partial > "$2/marker"
  exit 1
fi
if [ "$SCENARIO" = restore ] && [ "$1" = "$TEST_BACKUP" ]; then exit 1; fi
if [ "$SCENARIO" = backup ] && [ "$1" = "$TEST_TARGET" ]; then exit 1; fi
exec /bin/mv "$@"`
  }
  await Promise.all(Object.entries(commands).map(([name, body]) =>
    writeFile(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o700 })
  ))
  const logPath = join(root, 'swap.log')
  // The production adapter writes the helper inside the staging directory, so
  // the helper deletes its own script during cleanup. Mirror that layout.
  const scriptPath = join(stagedRoot, 'swap.sh')
  const writeScript = async (appPid: number): Promise<void> => {
    await writeFile(scriptPath, buildSwapHelperScript({
      appPid,
      targetBundle: bundlePath,
      stagedApp: incoming,
      stagedRoot,
      logPath
    }))
  }
  return {
    stagedRoot,
    incoming,
    backup,
    scriptPath,
    logPath,
    writeScript,
    async run(appPid, scenario = 'success') {
      await writeScript(appPid)
      try {
        await execFileAsync('/bin/bash', [scriptPath, bundlePath, incoming, stagedRoot, logPath], {
          env: {
            ...process.env,
            PATH: `${bin}:/usr/bin:/bin`,
            FIXTURE_ROOT: root,
            SCENARIO: scenario,
            TEST_TARGET: bundlePath,
            TEST_INCOMING: incoming,
            TEST_BACKUP: backup
          },
          timeout: 5000
        })
        return 0
      } catch (error) {
        if (error instanceof Error && 'code' in error && typeof error.code === 'number') return error.code
        throw error
      }
    }
  }
}

async function exitedFixturePid(): Promise<number> {
  const { stdout } = await execFileAsync('/bin/bash', ['-c', 'echo $$'])
  return Number(stdout.trim())
}

async function expectRelaunched(marker: 'old' | 'new'): Promise<void> {
  expect(await readFile(join(root, 'open-args'), 'utf8')).toBe(`${bundlePath}\n`)
  expect(await readFile(join(root, 'opened-marker'), 'utf8')).toBe(marker)
}

async function expectFailureAlert(): Promise<void> {
  expect(await readFile(join(root, 'alert-args'), 'utf8')).toBe(`-e\n${ALERT}\n`)
}

describe.skipIf(process.platform === 'win32')('swap helper script executed in an isolated filesystem', () => {
  it('swaps the prepared incoming bundle, verifies it and relaunches without an alert', async () => {
    const helper = await helperFixture()
    expect(await helper.run(await exitedFixturePid())).toBe(0)

    expect(await readFile(join(bundlePath, 'marker'), 'utf8')).toBe('new')
    expect(await readFile(join(root, 'codesign-args'), 'utf8')).toBe(
      `--verify\n--deep\n--strict\n${bundlePath}\n`
    )
    await expectRelaunched('new')
    await expectAbsent(helper.stagedRoot)
    await expectAbsent(join(root, 'alert-args'))
  })

  it('removes a failed post-swap signature and restores and relaunches the old app', async () => {
    const helper = await helperFixture()
    expect(await helper.run(await exitedFixturePid(), 'signature')).toBe(1)

    await expectOriginalBundle()
    await expectRelaunched('old')
    await expectFailureAlert()
    await expectAbsent(helper.stagedRoot)
    expect(await readFile(join(root, 'swap.log'), 'utf8')).toContain('signature check failed')
  })

  it('deletes a partially created target before renaming the backup back into place', async () => {
    const helper = await helperFixture()
    expect(await helper.run(await exitedFixturePid(), 'rename')).toBe(1)

    await expectOriginalBundle()
    await expectRelaunched('old')
    await expectFailureAlert()
    await expectAbsent(helper.stagedRoot)
    await expectAbsent(join(root, 'codesign-args'))
  })

  it('preserves the backup and its workspace when restoring the old app fails', async () => {
    const helper = await helperFixture()
    expect(await helper.run(await exitedFixturePid(), 'restore')).toBe(1)

    expect(await readFile(join(helper.backup, 'marker'), 'utf8')).toBe('old')
    await expectAbsent(bundlePath)
    await expectAbsent(join(root, 'open-args'))
    await expectFailureAlert()
    expect(await readFile(join(root, 'swap.log'), 'utf8')).toContain(`backup preserved at ${helper.backup}`)
  })

  it('keeps and relaunches the original bundle when moving it aside fails', async () => {
    const helper = await helperFixture()
    expect(await helper.run(await exitedFixturePid(), 'backup')).toBe(1)

    await expectOriginalBundle()
    await expectRelaunched('old')
    await expectFailureAlert()
    await expectAbsent(helper.stagedRoot)
  })

  it('times out on its own live parent fixture without modifying or opening the installed app', async () => {
    const helper = await helperFixture()
    const parent = execFile('/bin/sleep', ['30'])
    const exited = once(parent, 'exit')
    try {
      await once(parent, 'spawn')
      if (!parent.pid) throw new Error('Fixture parent did not get a PID')
      const before = await stat(bundlePath)
      expect(await helper.run(parent.pid)).toBe(1)

      const after = await stat(bundlePath)
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino })
      await expectOriginalBundle()
      await expectAbsent(join(root, 'moves'))
      await expectAbsent(join(root, 'codesign-args'))
      await expectAbsent(join(root, 'open-args'))
      await expectAbsent(helper.stagedRoot)
      await expectFailureAlert()
      expect((await readFile(join(root, 'waits'), 'utf8')).trim().split('\n')).toHaveLength(2)
      expect(await readFile(join(root, 'swap.log'), 'utf8')).toContain('installation aborted without changing the app')
      expect(parent.exitCode).toBeNull()
      expect(parent.killed).toBe(false)
    } finally {
      parent.kill()
      await exited
    }
  })

  it('removes the staged workspace when terminated before the swap starts', async () => {
    const helper = await helperFixture()
    const parent = execFile('/bin/sleep', ['30'])
    await once(parent, 'spawn')
    if (!parent.pid) throw new Error('Fixture parent did not get a PID')
    try {
      await helper.writeScript(parent.pid)
      const child = execFile(
        '/bin/bash',
        [helper.scriptPath, bundlePath, helper.incoming, helper.stagedRoot, helper.logPath],
        { env: { ...process.env, PATH: '/usr/bin:/bin' } }
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      child.kill('SIGTERM')
      const [code] = await once(child, 'exit')

      expect(code).toBe(1)
      await expectOriginalBundle()
      await expectAbsent(helper.stagedRoot)
      expect(await readFile(helper.logPath, 'utf8')).toContain('interrupted during installation')
      await expectAbsent(join(root, 'open-args'))
    } finally {
      parent.kill()
      await once(parent, 'exit')
    }
  })
})

describe('createMacScriptUpdater', () => {
  it('offers a newer beta release on the beta channel', async () => {
    stubReleases()
    const { options } = makeOptions()
    const adapter = createMacScriptUpdater(options)
    const seen: string[] = []
    adapter.onChecking(() => seen.push('checking'))
    adapter.onAvailable((info) => seen.push(`available:${info.version}`))

    expect(await adapter.check()).toMatchObject({ version: VERSION, releaseNotes: 'Fixes and art' })
    expect(seen).toEqual(['checking', `available:${VERSION}`])
  })

  it('rejects an equal version even when downgrades are enabled', async () => {
    stubReleases()
    const { options } = makeOptions({ currentVersion: VERSION })
    const adapter = createMacScriptUpdater(options)
    const notAvailable = vi.fn()
    adapter.onNotAvailable(notAvailable)
    adapter.setAllowDowngrade(true)

    expect(await adapter.check()).toBeNull()
    expect(notAvailable).toHaveBeenCalledTimes(1)
  })

  it('honors the service downgrade setter when switching a beta installation back to stable', async () => {
    const stableVersion = '0.1.9'
    stubReleases([apiRelease({
      tag_name: `v${stableVersion}`,
      prerelease: false,
      assets: [{ name: `Commit87-${stableVersion}-mac-arm64.zip`, browser_download_url: ZIP_URL }]
    })])
    const { options, state } = makeOptions()
    const adapter = createMacScriptUpdater(options)
    expect(await adapter.check()).toBeNull()
    state.channel = 'stable'
    const service = new UpdateService({
      adapter,
      environment: { platform: 'darwin', isPackaged: true, macDeveloperId: false },
      version: options.currentVersion,
      preferences: () => ({ channel: state.channel, autoCheck: false })
    })

    expect(await service.check()).toMatchObject({ phase: 'available', version: stableVersion })
    state.channel = 'beta'
    service.refreshPreferences()
    expect(await service.check()).toMatchObject({ phase: 'up-to-date', version: null })
  })

  it('keeps prereleases off the stable channel', async () => {
    stubReleases()
    const { options, state } = makeOptions({ currentVersion: '0.1.0' })
    state.channel = 'stable'
    const adapter = createMacScriptUpdater(options)
    const notAvailable = vi.fn()
    adapter.onNotAvailable(notAvailable)

    expect(await adapter.check()).toBeNull()
    expect(notAvailable).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failed check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 403 })))
    const { options } = makeOptions()
    await expect(createMacScriptUpdater(options).check()).rejects.toThrow(/HTTP 403/)
  })

  it('refuses to download before a check or after an unavailable check', async () => {
    stubReleases([])
    const { options } = makeOptions()
    const adapter = createMacScriptUpdater(options)
    await expect(adapter.download(null).promise).rejects.toThrow('No update is available')
    await adapter.check()
    await expect(adapter.download(null).promise).rejects.toThrow('No update is available')
    await expectAbsent(cachePath)
  })

  it.each([
    { sums: `${'00'.repeat(32)}  ${ZIP_ASSET}\n`, error: /Checksum mismatch/ },
    { sums: `${sha256Hex(ZIP_BYTES)}  different.zip\n`, error: /has no entry/ }
  ])('refuses invalid release sums before extracting ($error)', async ({ sums, error }) => {
    stubDownloads(sums)
    const exec = vi.fn(bundleTools)
    const { options } = makeOptions({ exec })
    const adapter = createMacScriptUpdater(options)
    const downloaded = vi.fn()
    adapter.onDownloaded(downloaded)
    await adapter.check()

    await expect(adapter.download(null).promise).rejects.toThrow(error)
    expect(exec).not.toHaveBeenCalled()
    expect(downloaded).not.toHaveBeenCalled()
    await expectAbsent(join(cachePath, 'download'))
    expect(await readFile(join(unrelatedStaging, 'untouched'), 'utf8')).toBe('another session')
  })

  it('downloads, verifies, extracts and retains exactly one private staged bundle', async () => {
    stubDownloads()
    const exec = vi.fn(bundleTools)
    const { options } = makeOptions({ exec })
    const adapter = createMacScriptUpdater(options)
    const downloaded = vi.fn()
    const progress = vi.fn()
    adapter.onDownloaded(downloaded)
    adapter.onProgress(progress)
    await adapter.check()
    await adapter.download(null).promise

    const download = join(cachePath, 'download')
    const staged = join(download, 'app', 'Commit87.app')
    expect(exec.mock.calls).toEqual([
      ['/usr/bin/ditto', ['-x', '-k', join(download, ZIP_ASSET), join(download, 'app')]],
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=1', staged]]
    ])
    expect(await readFile(join(staged, 'marker'), 'utf8')).toBe('new')
    expect(await readdir(cachePath)).toEqual(['download'])
    if (process.platform !== 'win32') {
      // Windows does not model POSIX permission bits; the 0o700 modes are
      // enforced by mkdir on POSIX platforms only.
      expect((await stat(cachePath)).mode & 0o777).toBe(0o700)
      expect((await stat(download)).mode & 0o777).toBe(0o700)
    }
    expect(downloaded).toHaveBeenCalledWith(expect.objectContaining({ version: VERSION }))
    expect(progress).toHaveBeenLastCalledWith({
      percent: 100, transferred: ZIP_BYTES.length, total: ZIP_BYTES.length, bytesPerSecond: 0
    })
  })

  it.each(['missing bundle', 'signature', 'version'] as const)(
    'cleans the private download when bundle verification fails: %s',
    async (failure) => {
      stubDownloads()
      const exec = vi.fn(async (file: string, args: string[]) => {
        if (failure === 'missing bundle' && file === '/usr/bin/ditto') return
        if (failure === 'signature' && file === '/usr/bin/codesign') throw new Error('invalid signature')
        await bundleTools(file, args)
        if (failure === 'version' && file === '/usr/bin/ditto') {
          await writeBundle(join(args[3], 'Commit87.app'), 'new', '0.1.0')
        }
      })
      const { options, state } = makeOptions({ exec })
      const adapter = createMacScriptUpdater(options)
      const downloaded = vi.fn()
      adapter.onDownloaded(downloaded)
      await adapter.check()

      const errors = {
        'missing bundle': /does not contain Commit87.app/,
        signature: /failed its code-signature check/,
        version: /declares version 0.1.0 but release 0.2.0-beta.9 was expected/
      }
      await expect(adapter.download(null).promise).rejects.toThrow(errors[failure])
      expect(downloaded).not.toHaveBeenCalled()
      await expectAbsent(join(cachePath, 'download'))
      await expect(adapter.quitAndInstall(null)).rejects.toThrow('No verified update package')
      expect(state.quit).not.toHaveBeenCalled()
    }
  )

  it('bounds deferred downloads across adapter instances without scanning the OS temp directory', async () => {
    await readyAdapter()
    const download = join(cachePath, 'download')
    await writeFile(join(download, 'stale-from-first-instance'), 'old download')
    await writeFile(join(cachePath, 'swap.log'), 'keep diagnostic log')

    await readyAdapter()

    expect((await readdir(cachePath)).sort()).toEqual(['download', 'swap.log'])
    expect((await readdir(download)).sort()).toEqual([ZIP_ASSET, 'app'].sort())
    await expectAbsent(join(download, 'stale-from-first-instance'))
    expect(await readFile(join(cachePath, 'swap.log'), 'utf8')).toBe('keep diagnostic log')
    expect(await readFile(join(unrelatedStaging, 'untouched'), 'utf8')).toBe('another session')
    expect(await readdir(join(root, 'os-temp'))).toEqual(['commit87-update-another-session'])
  })

  it('rejects an asynchronous destination-open error even when the HTTP body is stalled', async () => {
    const request: { signal: AbortSignal | null } = { signal: null }
    stubDownloads(SUMS, async (init) => {
      if (!init?.signal) throw new Error('Expected a cancellable download')
      request.signal = init.signal
      // Opening a directory as a file fails asynchronously, before the body produces any bytes.
      await mkdir(join(cachePath, 'download', ZIP_ASSET))
      return stalledResponse(init.signal)
    })
    const exec = vi.fn(bundleTools)
    const { options } = makeOptions({ exec })
    const adapter = createMacScriptUpdater(options)
    const downloaded = vi.fn()
    adapter.onDownloaded(downloaded)
    await adapter.check()

    await expect(adapter.download(null).promise).rejects.toThrow(/EISDIR|EPERM|EACCES|abort/i)
    expect(request.signal).not.toBeNull()
    expect(request.signal?.aborted).toBe(true)
    expect(exec).not.toHaveBeenCalled()
    expect(downloaded).not.toHaveBeenCalled()
    await expectAbsent(join(cachePath, 'download'))
  })

  it('cancels an in-flight download and removes only its private workspace', async () => {
    stubDownloads(SUMS, (init) => {
      if (!init?.signal) throw new Error('Expected a cancellable download')
      return stalledResponse(init.signal, new Uint8Array([1, 2, 3]))
    })
    const { options } = makeOptions()
    const adapter = createMacScriptUpdater(options)
    const progressed = gate()
    const downloaded = vi.fn()
    adapter.onProgress(progressed.resolve)
    adapter.onDownloaded(downloaded)
    await adapter.check()
    const task = adapter.download(null)
    await progressed.promise
    task.cancel()

    await expect(task.promise).rejects.toThrow(/abort/i)
    expect(downloaded).not.toHaveBeenCalled()
    await expectAbsent(join(cachePath, 'download'))
    expect(await readFile(join(unrelatedStaging, 'untouched'), 'utf8')).toBe('another session')
  })

  it('rejects installation asynchronously without a verified staged package', async () => {
    const { options, state } = makeOptions()
    const adapter = createMacScriptUpdater(options)
    await expect(adapter.quitAndInstall(null)).rejects.toThrow('No verified update package')
    expect(state.quit).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('prepares and signs incoming.app beside the target and quits only after the helper spawns', async () => {
    const { adapter, state, exec } = await readyAdapter()
    const child = new ChildProcess()
    const unref = vi.spyOn(child, 'unref').mockImplementation(() => undefined)
    const spawned = gate()
    vi.mocked(spawn).mockImplementation(() => {
      spawned.resolve()
      return child
    })
    const install = adapter.quitAndInstall(null)
    expect(install).toBeInstanceOf(Promise)
    expect(adapter.quitAndInstall(null)).toBe(install)
    await spawned.promise

    expect(state.quit).not.toHaveBeenCalled()
    expect(unref).not.toHaveBeenCalled()
    const workspaces = await installWorkspaces()
    expect(workspaces).toHaveLength(1)
    const installRoot = join(dirname(bundlePath), workspaces[0])
    const incoming = join(installRoot, 'incoming.app')
    const scriptPath = join(installRoot, 'swap.sh')
    const logPath = join(cachePath, 'swap.log')
    expect((await stat(incoming)).dev).toBe((await stat(bundlePath)).dev)
    expect(await readFile(join(incoming, 'marker'), 'utf8')).toBe('new')
    await expectOriginalBundle()
    expect(exec.mock.calls.slice(-2)).toEqual([
      ['/usr/bin/ditto', [join(cachePath, 'download', 'app', 'Commit87.app'), incoming]],
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', incoming]]
    ])
    expect(await readFile(scriptPath, 'utf8')).toBe(buildSwapHelperScript({
      appPid: process.pid, targetBundle: bundlePath, stagedApp: incoming, stagedRoot: installRoot, logPath
    }))
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      '/bin/bash', [scriptPath, bundlePath, incoming, installRoot, logPath], { detached: true, stdio: 'ignore' }
    )
    await expectAbsent(join(cachePath, 'download'))

    child.emit('spawn')
    await install

    expect(unref).toHaveBeenCalledTimes(1)
    expect(state.quit).toHaveBeenCalledTimes(1)
    await expectAbsent(join(cachePath, 'download'))
    expect((await stat(incoming)).isDirectory()).toBe(true)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rejects an unwritable target parent without quitting',
    async () => {
      const { adapter, state, exec } = await readyAdapter()
      exec.mockClear()
      await chmod(dirname(bundlePath), 0o500)
      try {
        await expect(adapter.quitAndInstall(null)).rejects.toThrow(/writable Applications folder/)
        expect(exec).not.toHaveBeenCalled()
        expect(spawn).not.toHaveBeenCalled()
        expect(state.quit).not.toHaveBeenCalled()
        await expectOriginalBundle()
        expect(await installWorkspaces()).toEqual([])
      } finally {
        await chmod(dirname(bundlePath), 0o700)
      }
    }
  )

  it('rejects a symlink target before copying or quitting', async () => {
    const linkedBundle = join(root, 'linked.app')
    await symlink(bundlePath, linkedBundle, process.platform === 'win32' ? 'junction' : 'dir')
    const { adapter, state, exec } = await readyAdapter({ bundlePath: linkedBundle })
    exec.mockClear()

    await expect(adapter.quitAndInstall(null)).rejects.toThrow('Not an installed app bundle')
    expect(exec).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(state.quit).not.toHaveBeenCalled()
    await expectOriginalBundle()
  })

  it.each(['copy', 'signature'] as const)('does not quit when same-filesystem preparation fails: %s', async (failure) => {
    const exec = vi.fn(async (file: string, args: string[]) => {
      if (args.at(-1)?.endsWith('incoming.app')) {
        if (failure === 'copy' && file === '/usr/bin/ditto') {
          await mkdir(args[1])
          await writeFile(join(args[1], 'partial'), 'incomplete copy')
          throw new Error('copy refused')
        }
        if (failure === 'signature' && file === '/usr/bin/codesign') throw new Error('prepared signature invalid')
      }
      await bundleTools(file, args)
    })
    const { adapter, state } = await readyAdapter({ exec })

    await expect(adapter.quitAndInstall(null)).rejects.toThrow(
      failure === 'copy' ? /copy refused/ : /prepared signature invalid/
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(state.quit).not.toHaveBeenCalled()
    expect(await installWorkspaces()).toEqual([])
    await expectOriginalBundle()
    expect((await stat(join(cachePath, 'download', 'app', 'Commit87.app'))).isDirectory()).toBe(true)
  })

  it('cleans prepared files and keeps the app running when helper spawning fails', async () => {
    const { adapter, state } = await readyAdapter()
    const child = new ChildProcess()
    const unref = vi.spyOn(child, 'unref').mockImplementation(() => undefined)
    const spawned = gate()
    vi.mocked(spawn).mockImplementation(() => {
      spawned.resolve()
      return child
    })
    const install = adapter.quitAndInstall(null)
    await spawned.promise
    child.emit('error', new Error('helper spawn refused'))

    await expect(install).rejects.toThrow('helper spawn refused')
    expect(unref).not.toHaveBeenCalled()
    expect(state.quit).not.toHaveBeenCalled()
    expect(await installWorkspaces()).toEqual([])
    await expectOriginalBundle()
    await expectAbsent(join(cachePath, 'download'))
  })

  it('aborts preparation when the channel changes without another check', async () => {
    const copying = gate()
    const release = gate()
    const { adapter, state } = await readyAdapter({
      exec: async (file, args) => {
        await bundleTools(file, args)
        if (file === '/usr/bin/ditto' && args.at(-1)?.endsWith('incoming.app')) {
          copying.resolve()
          await release.promise
        }
      }
    })
    const install = adapter.quitAndInstall(null)
    await copying.promise
    state.channel = 'stable'
    release.resolve()

    await expect(install).rejects.toThrow('selected update changed')
    expect(spawn).not.toHaveBeenCalled()
    expect(state.quit).not.toHaveBeenCalled()
    expect(await installWorkspaces()).toEqual([])
    await expectOriginalBundle()
  })

  it('settles stale preparation before reusing the cache for a new download', async () => {
    const copying = gate()
    const release = gate()
    const { adapter, state } = await readyAdapter({
      exec: async (file, args) => {
        await bundleTools(file, args)
        if (file === '/usr/bin/ditto' && args.at(-1)?.endsWith('incoming.app')) {
          copying.resolve()
          await release.promise
        }
      }
    })
    const install = adapter.quitAndInstall(null)
    const refused = expect(install).rejects.toThrow('selected update changed')
    await copying.promise
    // A new check invalidates the old candidate, just as the service does when
    // changing channel. Keep one archive fixture to isolate workspace ownership.
    await adapter.check()
    const nextDownload = adapter.download(null)
    const downloaded = vi.fn()
    adapter.onDownloaded(downloaded)
    await Promise.resolve()
    expect(downloaded).not.toHaveBeenCalled()
    await expect(adapter.quitAndInstall(null)).rejects.toThrow('previous update preparation')
    release.resolve()

    await refused
    await nextDownload.promise
    expect(downloaded).toHaveBeenCalledTimes(1)
    expect((await stat(join(cachePath, 'download', 'app', 'Commit87.app'))).isDirectory()).toBe(true)
    expect(state.quit).not.toHaveBeenCalled()
    await expectOriginalBundle()
  })

  it('stops the helper without quitting if the channel changes while it starts', async () => {
    const { adapter, state } = await readyAdapter()
    const child = new ChildProcess()
    const spawned = gate()
    const kill = vi.spyOn(child, 'kill').mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', null, 'SIGTERM'))
      return true
    })
    vi.mocked(spawn).mockImplementation(() => {
      spawned.resolve()
      return child
    })
    const install = adapter.quitAndInstall(null)
    await spawned.promise
    state.channel = 'stable'
    child.emit('spawn')

    await expect(install).rejects.toThrow('selected update changed')
    expect(kill).toHaveBeenCalledTimes(1)
    expect(state.quit).not.toHaveBeenCalled()
    expect(await installWorkspaces()).toEqual([])
    await expectOriginalBundle()
  })

  it('accepts preference setters without quitting', () => {
    const { options, state } = makeOptions()
    const adapter = createMacScriptUpdater(options)
    adapter.setChannel('stable')
    adapter.setAutoDownload(true)
    adapter.setAutoInstallOnAppQuit(true)
    adapter.setAllowDowngrade(true)
    expect(state.quit).not.toHaveBeenCalled()
  })
})
