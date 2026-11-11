import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateChannel } from '../src/shared/types'
import { buildSwapHelperScript, createMacScriptUpdater } from '../src/main/mac-script-updater'
import type { MacScriptUpdaterOptions } from '../src/main/mac-script-updater'
import type { ApiRelease } from '../src/main/update-feed'
import { sha256Hex } from '../src/main/update-feed'

function makeOptions(overrides: Partial<MacScriptUpdaterOptions> = {}) {
  const state = { channel: 'beta' as UpdateChannel, quit: vi.fn() }
  const options: MacScriptUpdaterOptions = {
    owner: 'fradinni',
    repo: 'Commit87',
    arch: 'arm64',
    currentVersion: '0.2.0-beta.8',
    channel: () => state.channel,
    bundlePath: '/Users/n/Applications/Commit87.app',
    quit: state.quit,
    ...overrides
  }
  return { options, state }
}

function apiRelease(overrides: Partial<ApiRelease> = {}): ApiRelease {
  return {
    tag_name: 'v0.2.0-beta.9',
    draft: false,
    prerelease: true,
    published_at: '2026-11-11T10:00:00Z',
    body: 'Fixes and art',
    assets: [
      {
        name: 'Commit87-0.2.0-beta.9-mac-arm64.zip',
        browser_download_url: 'https://github.com/fradinni/Commit87/releases/download/v0.2.0-beta.9/a.zip'
      }
    ],
    ...overrides
  }
}

/** A response whose body stays open, so a cancel can interrupt the pump. */
function openStream(chunk: Uint8Array, signal: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk)
      signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
    }
  })
  return new Response(stream, { headers: { 'content-type': 'application/octet-stream' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Staging directories the adapter leaves under the OS temp dir. */
async function leftoverStagingDirs(): Promise<string[]> {
  const base = tmpdir()
  const names = await readdir(base).catch(() => [] as string[])
  return names
    .filter((name) => name.startsWith('commit87-update-'))
    .map((name) => join(base, name))
}

async function removeLeftoverStagingDirs(): Promise<void> {
  for (const dir of await leftoverStagingDirs()) await rm(dir, { recursive: true, force: true })
}

describe('swap helper script', () => {
  it('waits for the app to exit, swaps the bundle, verifies and relaunches', () => {
    const script = buildSwapHelperScript({
      appPid: 4242,
      targetBundle: '/Users/n/Applications/Commit87.app',
      stagedApp: '/tmp/commit87-update-abcd/app/Commit87.app',
      stagedRoot: '/tmp/commit87-update-abcd',
      logPath: '/tmp/commit87-swap-4242.log'
    })
    expect(script).toContain('APP_PID=4242')
    expect(script).toContain('TARGET=$1')
    expect(script).toContain('STAGED=$2')
    expect(script).toContain('STAGED_ROOT=$3')
    expect(script).toContain('LOG=$4')
    expect(script).toContain('kill -0 "$APP_PID"')
    expect(script).toContain('for i in $(seq 1 120)')
    expect(script).toContain('mv "$TARGET" "$BACKUP"')
    expect(script).toContain('mv "$STAGED" "$TARGET"')
    expect(script).toContain('ditto "$STAGED" "$TARGET"')
    expect(script).toContain('codesign --verify --deep --strict "$TARGET"')
    expect(script).toContain('xattr -dr com.apple.quarantine "$TARGET"')
    expect(script).toContain('open "$TARGET"')
    expect(script).toContain('mv "$BACKUP" "$TARGET"')
  })

  it('restores the backup and removes staging when the post-swap check fails', () => {
    const script = buildSwapHelperScript({
      appPid: 1,
      targetBundle: '/Applications/Commit87.app',
      stagedApp: '/tmp/staged/Commit87.app',
      stagedRoot: '/tmp/staged',
      logPath: '/tmp/swap.log'
    })
    // The failed-signature branch must put the old bundle back and clean the
    // staged files, never leave the machine with an unverified app.
    const restore = script.match(/codesign[\s\S]*?exit 1/)?.[0] ?? ''
    expect(restore).toContain('mv "$BACKUP" "$TARGET"')
    expect(restore).toContain('rm -rf "$STAGED_ROOT"')
  })

  it('does not embed paths in the script text; they travel as argv', () => {
    const script = buildSwapHelperScript({
      appPid: 1,
      targetBundle: '/Users/n/Applications/My "Apps"/Commit87.app',
      stagedApp: '/tmp/staged dir/Commit87.app',
      stagedRoot: '/tmp/staged dir',
      logPath: '/tmp/swap.log'
    })
    expect(script).not.toContain('/Users/n/Applications/My "Apps"/Commit87.app')
    expect(script).not.toContain('/tmp/staged dir/Commit87.app')
    expect(script).toContain('TARGET=$1')
  })
})

describe('createMacScriptUpdater', () => {
  it('offers a newer beta release on the beta channel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        expect(String(input)).toContain('releases?per_page=100')
        return new Response(JSON.stringify([apiRelease()]), { status: 200 })
      })
    )
    const { options } = makeOptions()
    const adapter = createMacScriptUpdater(options)
    const seen: string[] = []
    adapter.onChecking(() => seen.push('checking'))
    adapter.onAvailable((info) => seen.push(`available:${info.version}`))

    const result = await adapter.check()

    expect(result).toMatchObject({ version: '0.2.0-beta.9', releaseNotes: 'Fixes and art' })
    expect(seen).toEqual(['checking', 'available:0.2.0-beta.9'])
  })

  it('reports up to date when the newest release is not newer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([apiRelease()]), { status: 200 }))
    )
    const { options } = makeOptions({ currentVersion: '0.2.0-beta.9' })
    const adapter = createMacScriptUpdater(options)
    const notAvailable = vi.fn()
    adapter.onNotAvailable(notAvailable)

    const result = await adapter.check()

    expect(result).toBeNull()
    expect(notAvailable).toHaveBeenCalledTimes(1)
  })

  it('keeps prereleases off the stable channel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([apiRelease()]), { status: 200 }))
    )
    const { options, state } = makeOptions({ currentVersion: '0.1.0' })
    state.channel = 'stable'
    const adapter = createMacScriptUpdater(options)
    const notAvailable = vi.fn()
    adapter.onNotAvailable(notAvailable)

    expect(await adapter.check()).toBeNull()
    expect(notAvailable).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failed check without leaving the checking phase unhinged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 403 })))
    const { options } = makeOptions()
    const adapter = createMacScriptUpdater(options)

    await expect(adapter.check()).rejects.toThrow(/HTTP 403/)
  })

  it('refuses to download before a check or after an unavailable check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })))
    const { options } = makeOptions()
    const adapter = createMacScriptUpdater(options)
    await adapter.check()

    await expect(adapter.download(null).promise).rejects.toThrow('No update is available')
  })

  it('rejects a download whose checksum does not match the release sums', async () => {
    const zip = Buffer.from('not really a zip, but the checksum must refuse it first')
    const fakeZipUrl = 'https://github.com/fradinni/Commit87/releases/download/v0.2.0-beta.9/a.zip'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input)
        if (url.includes('/releases?per_page=')) {
          return new Response(JSON.stringify([apiRelease()]), { status: 200 })
        }
        if (url === fakeZipUrl) {
          return new Response(zip, { status: 200, headers: { 'content-length': String(zip.length) } })
        }
        // SHA256SUMS.txt at the download root: a deliberately wrong digest.
        expect(url).toContain('/releases/download/v0.2.0-beta.9/SHA256SUMS.txt')
        return new Response(`${'00'.repeat(32)}  Commit87-0.2.0-beta.9-mac-arm64.zip\n`, { status: 200 })
      })
    )
    const { options } = makeOptions()
    const adapter = createMacScriptUpdater(options)
    await adapter.check()

    await expect(adapter.download(null).promise).rejects.toThrow(/Checksum mismatch/)

    // The failed download must not leave a staging directory behind.
    expect(await leftoverStagingDirs()).toEqual([])
  })

  it('downloads, verifies, extracts and stages a bundle end to end', async () => {
    const zipBytes = Buffer.from('fake zip payload, verified only by checksum')
    const fakeZipUrl = 'https://github.com/fradinni/Commit87/releases/download/v0.2.0-beta.9/a.zip'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input)
        if (url.includes('/releases?per_page=')) {
          return new Response(JSON.stringify([apiRelease()]), { status: 200 })
        }
        if (url === fakeZipUrl) {
          return new Response(zipBytes, { status: 200, headers: { 'content-length': String(zipBytes.length) } })
        }
        expect(url).toContain('/releases/download/v0.2.0-beta.9/SHA256SUMS.txt')
        return new Response(`${sha256Hex(zipBytes)}  Commit87-0.2.0-beta.9-mac-arm64.zip\n`, { status: 200 })
      })
    )
    const { options } = makeOptions({
      // Fake the extractor so the test needs no real zip or Xcode tools; the
      // fake materializes the staged bundle the plist check reads back.
      exec: async (file: string, args: string[]): Promise<void> => {
        if (file === '/usr/bin/ditto') {
          const appDir = args[3]
          await mkdir(join(appDir, 'Commit87.app', 'Contents'), { recursive: true })
          await writeFile(
            join(appDir, 'Commit87.app', 'Contents', 'Info.plist'),
            '<dict><key>CFBundleShortVersionString</key><string>0.2.0-beta.9</string></dict>'
          )
        }
      }
    })
    const adapter = createMacScriptUpdater(options)
    await adapter.check()

    const received: string[] = []
    adapter.onDownloaded((info) => received.push(info.version))
    await adapter.download(null).promise

    expect(received).toEqual(['0.2.0-beta.9'])
    const staged = await leftoverStagingDirs()
    expect(staged.length).toBeGreaterThanOrEqual(1)

    // The adapter keeps the verified bundle for the swap; the test cleans up.
    await removeLeftoverStagingDirs()
  })

  it('cancels an in-flight download', async () => {
    const fakeZipUrl = 'https://github.com/fradinni/Commit87/releases/download/v0.2.0-beta.9/a.zip'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string, init?: RequestInit) => {
        const url = String(_input)
        if (url.includes('/releases?per_page=')) {
          return new Response(JSON.stringify([apiRelease()]), { status: 200 })
        }
        if (url === fakeZipUrl) {
          return openStream(new Uint8Array([1, 2, 3]), init?.signal as AbortSignal)
        }
        throw new Error(`Unexpected URL ${url}`)
      })
    )
    const { options } = makeOptions()
    const adapter = createMacScriptUpdater(options)
    await adapter.check()

    const task = adapter.download(null)
    const progress = new Promise<void>((resolve) => adapter.onProgress(() => resolve()))
    await progress
    task.cancel()

    await expect(task.promise).rejects.toThrow(/abort/i)
  })

  it('refuses to install without a staged package', () => {
    const { options } = makeOptions()
    const adapter = createMacScriptUpdater(options)
    expect(() => adapter.quitAndInstall(null)).toThrow('No verified update package')
  })

  it('respects preference setters without error', () => {
    const { options, state } = makeOptions()
    const adapter = createMacScriptUpdater(options)
    adapter.setChannel('stable')
    adapter.setAutoDownload(true)
    adapter.setAutoInstallOnAppQuit(true)
    adapter.setAllowDowngrade(true)
    expect(state.quit).not.toHaveBeenCalled()
  })
})