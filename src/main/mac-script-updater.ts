import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWriteStream, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateChannel, UpdateProgress } from '@shared/types'
import { safeLog } from './logging'
import type { UpdateAdapter, UpdateDownloadTask, UpdateInfoSummary } from './updates'
import { isVersionNewer, parseSha256Sums, pickRelease, sha256Hex } from './update-feed'
import type { ApiRelease, ReleaseCandidate } from './update-feed'

const PROGRESS_THROTTLE_MS = 250
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000
const MAX_RELEASES = 100
const execFileAsync = promisify(execFile)

export interface MacScriptUpdaterOptions {
  owner: string
  repo: string
  arch: 'arm64' | 'x64'
  currentVersion: string
  /** The channel is read live so a Settings change applies to the next check. */
  channel: () => UpdateChannel
  /** Absolute path to the running Commit87.app bundle. */
  bundlePath: string
  /** Ends the session after the swap helper has been detached. */
  quit: () => void
  /**
   * Executable runner for extraction and signature checks. Only tests inject
   * this; the adapter otherwise uses `execFile` with absolute tool paths.
   */
  exec?: (file: string, args: string[]) => Promise<void>
}

/**
 * The values handed to the detached swap helper as positional arguments. They
 * travel as argv, not embedded in the generated script, so a path containing
 * quotes, spaces or non-ASCII bytes can never corrupt the script text.
 */
export interface SwapSpec {
  /** PID of the running app; the helper waits for it to exit before swapping. */
  appPid: number
  /** Where the current bundle lives (/Applications or ~/Applications). */
  targetBundle: string
  /** Verified bundle downloaded to a staging directory. */
  stagedApp: string
  /** The whole staging directory, removed after a successful swap. */
  stagedRoot: string
  /** Where the helper appends its progress lines. */
  logPath: string
}

/**
 * The detached helper that performs the in-place swap after the app quits.
 * electron-updater's Squirrel.Mac cannot do this for ad-hoc builds (the
 * designated requirement is pinned to the current cdhash), so the verified
 * bundle downloaded by the adapter is swapped in by this script instead. It is
 * generated as text so its behaviour is unit-testable and audit-proof.
 */
export function buildSwapHelperScript(spec: SwapSpec): string {
  return `#!/bin/bash
set -u
APP_PID=${spec.appPid}
TARGET=$1
STAGED=$2
STAGED_ROOT=$3
LOG=$4
log() { echo "[commit87-swap] $(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
log "waiting for pid $APP_PID to exit"
for i in $(seq 1 120); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
if kill -0 "$APP_PID" 2>/dev/null; then
  log "pid still alive; proceeding anyway"
fi
log "installing into $TARGET"
mkdir -p "$(dirname "$TARGET")"
BACKUP="$TARGET.old-$(date +%s)"
if [ -d "$TARGET" ]; then
  mv "$TARGET" "$BACKUP" || { log "could not move current bundle aside"; exit 1; }
fi
if ! mv "$STAGED" "$TARGET"; then
  log "rename failed; falling back to ditto"
  if ! ditto "$STAGED" "$TARGET"; then
    log "install failed; restoring backup"
    [ -d "$BACKUP" ] && mv "$BACKUP" "$TARGET"
    rm -rf "$STAGED_ROOT"
    exit 1
  fi
fi
xattr -dr com.apple.quarantine "$TARGET" >/dev/null 2>&1 || true
if ! codesign --verify --deep --strict "$TARGET" 2>>"$LOG"; then
  log "signature check failed; restoring backup"
  [ -d "$BACKUP" ] && mv "$BACKUP" "$TARGET"
  rm -rf "$STAGED_ROOT"
  exit 1
fi
rm -rf "$BACKUP" "$STAGED_ROOT"
log "relaunching"
open "$TARGET"
exit 0
`
}

/**
 * Update adapter for ad-hoc signed macOS builds. Because Squirrel.Mac only
 * accepts a bundle that satisfies the running app's designated requirement —
 * impossible for ad-hoc signatures — updates are delivered by downloading the
 * release zip with curl semantics (no quarantine attribute), verifying its
 * checksum and code signature, and swapping the bundle in a detached helper
 * once the app has quit. This is the in-app twin of `scripts/install-macos.sh`.
 */
export function createMacScriptUpdater(options: MacScriptUpdaterOptions): UpdateAdapter {
  const releaseUrl = `https://api.github.com/repos/${options.owner}/${options.repo}/releases?per_page=${MAX_RELEASES}`
  const downloadRoot = (tag: string): string =>
    `https://github.com/${options.owner}/${options.repo}/releases/download/${tag}`
  const run = options.exec ?? execFileAsync

  let candidate: ReleaseCandidate | null = null
  let stagingRoot: string | null = null
  let stagedApp: string | null = null

  const checking: Array<() => void> = []
  const available: Array<(info: UpdateInfoSummary) => void> = []
  const notAvailable: Array<() => void> = []
  const progress: Array<(value: UpdateProgress) => void> = []
  const downloaded: Array<(info: UpdateInfoSummary) => void> = []

  async function listReleases(): Promise<ApiRelease[]> {
    const response = await fetch(releaseUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'commit87-updater' }
    })
    if (!response.ok) {
      throw new Error(`Update check failed (HTTP ${response.status})`)
    }
    const payload = (await response.json()) as unknown
    if (!Array.isArray(payload)) throw new Error('Update check returned an unexpected response')
    return payload as ApiRelease[]
  }

  async function cleanStaging(): Promise<void> {
    if (stagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      stagingRoot = null
      stagedApp = null
    }
  }

  return {
    setChannel: () => undefined,
    setAutoDownload: () => undefined,
    setAutoInstallOnAppQuit: () => undefined,
    setAllowDowngrade: () => undefined,

    async check(): Promise<UpdateInfoSummary | null> {
      candidate = null
      checking.forEach((listener) => listener())
      const channel = options.channel()
      try {
        const releases = await listReleases()
        const found = pickRelease(releases, options.arch, channel)
        if (!found || !isVersionNewer(found.version, options.currentVersion)) {
          notAvailable.forEach((listener) => listener())
          return null
        }
        candidate = found
        const info: UpdateInfoSummary = {
          version: found.version,
          releaseDate: found.publishedAt,
          releaseNotes: found.notes
        }
        available.forEach((listener) => listener(info))
        return info
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(message)
      }
    },

    download(): UpdateDownloadTask {
      const selected = candidate
      if (!selected) {
        return {
          promise: Promise.reject(new Error('No update is available to download.')),
          cancel: () => undefined
        }
      }
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
      timeout.unref?.()

      const promise = (async (): Promise<void> => {
        try {
          await cleanStaging()
          stagingRoot = await mkdtemp(join(tmpdir(), 'commit87-update-'))
          const zipPath = join(stagingRoot, selected.zipAsset)
          const zipResponse = await fetch(selected.zipUrl, { redirect: 'follow', signal: controller.signal })
          if (!zipResponse.ok || !zipResponse.body) {
            throw new Error(`Download failed (HTTP ${zipResponse.status})`)
          }
          const total = Number(zipResponse.headers.get('content-length')) || 0

          safeLog(console, '[commit87:update]', 'info', `downloading ${selected.zipAsset} (${total} bytes)`)
          const writer = createWriteStream(zipPath)
          let transferred = 0
          let lastEmitAt = 0
          let lastBytes = 0
          let lastTickAt = Date.now()
          try {
            for await (const chunk of zipResponse.body) {
              const buffer = Buffer.from(chunk)
              transferred += buffer.length
              if (!writer.write(buffer)) await once(writer, 'drain')
              const now = Date.now()
              if (now - lastEmitAt >= PROGRESS_THROTTLE_MS) {
                const seconds = (now - lastTickAt) / 1000
                const bytesPerSecond = seconds > 0 ? Math.round((transferred - lastBytes) / seconds) : 0
                progress.forEach((listener) =>
                  listener({
                    percent: total ? Math.round((transferred / total) * 1000) / 10 : 0,
                    transferred,
                    total,
                    bytesPerSecond
                  })
                )
                lastEmitAt = now
                lastTickAt = now
                lastBytes = transferred
              }
            }
            writer.end()
            await once(writer, 'finish')
            progress.forEach((listener) => listener({ percent: 100, transferred, total, bytesPerSecond: 0 }))
          } catch (error) {
            writer.destroy()
            throw error
          }

          // Checksum gate: the release publishes SHA256SUMS.txt next to the
          // archive. A mismatch means a tampered or truncated download.
          const sumsResponse = await fetch(`${downloadRoot(selected.tag)}/SHA256SUMS.txt`, {
            redirect: 'follow',
            signal: controller.signal
          })
          if (!sumsResponse.ok) {
            throw new Error(`Checksum list download failed (HTTP ${sumsResponse.status})`)
          }
          const sums = parseSha256Sums(await sumsResponse.text())
          const expected = sums.get(selected.zipAsset)
          if (!expected) throw new Error(`SHA256SUMS.txt has no entry for ${selected.zipAsset}`)
          const actual = sha256Hex(await readFile(zipPath))
          if (actual !== expected) {
            throw new Error(`Checksum mismatch for ${selected.zipAsset}; refusing to install`)
          }
          safeLog(console, '[commit87:update]', 'info', `checksum verified for ${selected.zipAsset}`)

          // Extract with Apple's tool so bundle metadata survives, then verify
          // the bundle before it is ever staged for the swap.
          const appDir = join(stagingRoot, 'app')
          await run('/usr/bin/ditto', ['-x', '-k', zipPath, appDir])
          const staged = join(appDir, 'Commit87.app')
          await stat(staged).catch(() => {
            throw new Error('The downloaded archive does not contain Commit87.app')
          })
          await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=1', staged]).catch(() => {
            throw new Error(`The downloaded ${selected.version} bundle failed its code-signature check`)
          })
          const plist = await readFile(join(staged, 'Contents', 'Info.plist'), 'utf8')
          const declared = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
          if (declared !== selected.version) {
            throw new Error(
              `The downloaded archive declares version ${declared ?? 'unknown'} but release ${selected.version} was expected`
            )
          }

          stagedApp = staged
          safeLog(console, '[commit87:update]', 'info', `${selected.version} verified and staged`)
          downloaded.forEach((listener) =>
            listener({
              version: selected.version,
              releaseDate: selected.publishedAt,
              releaseNotes: selected.notes
            })
          )
        } catch (error) {
          await cleanStaging()
          throw error
        } finally {
          clearTimeout(timeout)
        }
      })()

      return {
        promise,
        cancel: () => controller.abort()
      }
    },

    quitAndInstall(): void {
      if (!candidate || !stagedApp || !stagingRoot) {
        throw new Error('No verified update package is staged')
      }
      const script = buildSwapHelperScript({
        appPid: process.pid,
        targetBundle: options.bundlePath,
        stagedApp: stagedApp,
        stagedRoot: stagingRoot,
        logPath: join(tmpdir(), `commit87-swap-${process.pid}.log`)
      })
      const scriptPath = join(tmpdir(), `commit87-swap-${process.pid}.sh`)
      writeFileSync(scriptPath, script, { mode: 0o755 })
      // Detached so it outlives the app; the helper waits for this PID to exit
      // before renaming the bundle into place. Paths travel as argv (not script
      // text), so quoting cannot corrupt them.
      spawn('/bin/bash', [scriptPath, options.bundlePath, stagedApp, stagingRoot, scriptPath.replace(/\.sh$/, '.log')], {
        detached: true,
        stdio: 'ignore'
      }).unref()
      options.quit()
    },

    onChecking: (listener) => checking.push(listener),
    onAvailable: (listener) => available.push(listener),
    onNotAvailable: (listener) => notAvailable.push(listener),
    onProgress: (listener) => progress.push(listener),
    onDownloaded: (listener) => downloaded.push(listener),
    onError: () => undefined
  }
}