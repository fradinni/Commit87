import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants, createWriteStream } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { UpdateChannel, UpdateFailure, UpdateProgress } from '@shared/types'
import { safeLog } from './logging'
import type { UpdateAdapter, UpdateDownloadTask, UpdateInfoSummary } from './updates'
import { isVersionNewer, parseSha256Sums, pickRelease, sha256Hex } from './update-feed'
import type { ApiRelease, ReleaseCandidate } from './update-feed'

const PROGRESS_THROTTLE_MS = 250
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000
const MAX_RELEASES = 100
/** Give up watching a helper after its own 60-second shutdown deadline. */
const HANDOFF_WATCH_MS = 90_000
const execFileAsync = promisify(execFile)

async function removeWorkspace(directory: string): Promise<void> {
  // Electron's patched fs treats app.asar as a virtual directory. Recursive
  // cleanup must operate on the physical archive, not its virtual contents.
  const { rm } = process.versions.electron
    ? (await import('original-fs')).promises
    : await import('node:fs/promises')
  await rm(directory, { recursive: true, force: true, maxRetries: 3 })
}

export interface MacScriptUpdaterOptions {
  owner: string
  repo: string
  arch: 'arm64' | 'x64'
  currentVersion: string
  /** The channel is read live so a Settings change applies to the next check. */
  channel: () => UpdateChannel
  /** Absolute path to the running Commit87.app bundle. */
  bundlePath: string
  /** Private, app-owned cache. One download is retained across sessions at most. */
  cachePath: string
  /** Ends the session after the swap helper has been detached. */
  quit: () => void
  /**
   * Executable runner for extraction and signature checks. Only tests inject
   * this; the adapter otherwise uses `execFile` with absolute tool paths.
   */
  exec?: (file: string, args: string[]) => Promise<void>
  /** How often the helper status file is polled. Only tests override this. */
  handoffPollMs?: number
  /** How long to wait for the helper status before abandoning it. Tests override this. */
  handoffWatchMs?: number
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
  /** Where the helper records its current step so the app can detect a stall. */
  statusPath: string
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
STATUS=$5
log() { echo "[commit87-swap] $(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
status() { printf '%s' "$1" > "$STATUS" 2>/dev/null || true; }
notify_failure() {
  osascript -e 'display alert "Commit87 update failed" message "The update could not be installed. Your previous installation has been kept. Quit Commit87 and try again, or use a writable Applications folder." as warning' >/dev/null 2>&1 || true
}
BACKUP="$STAGED_ROOT/previous.app"
INSTALL_PENDING=0
fail() {
  status failed
  log "$*"
  if [ -d "$BACKUP" ]; then
    if ! rm -rf "$TARGET" || ! mv "$BACKUP" "$TARGET"; then
      log "could not restore the previous app; backup preserved at $BACKUP"
      notify_failure
      exit 1
    fi
  fi
  rm -rf "$STAGED_ROOT"
  [ -d "$TARGET" ] && open "$TARGET"
  notify_failure
  exit 1
}
restore_on_signal() {
  status interrupted
  log "interrupted during installation"
  if [ "$INSTALL_PENDING" = 1 ] && [ -d "$BACKUP" ]; then
    rm -rf "$TARGET" 2>/dev/null
    if ! mv "$BACKUP" "$TARGET" 2>/dev/null; then
      log "could not restore the previous app; backup preserved at $BACKUP"
      notify_failure &
      exit 1
    fi
  fi
  rm -rf "$STAGED_ROOT" 2>/dev/null
  # Only an interrupted swap deserves a dialog, and it must not block the
  # helper: the app may be waiting for this process to exit.
  if [ "$INSTALL_PENDING" = 1 ]; then notify_failure & fi
  exit 1
}
trap restore_on_signal INT TERM HUP
status waiting
log "waiting for pid $APP_PID to exit"
for i in $(seq 1 120); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
if kill -0 "$APP_PID" 2>/dev/null; then
  status timeout
  log "pid still alive; installation aborted without changing the app"
  rm -rf "$STAGED_ROOT"
  notify_failure
  exit 1
fi
status installing
log "installing into $TARGET"
[ -d "$TARGET" ] || fail "current bundle is missing"
INSTALL_PENDING=1
mv "$TARGET" "$BACKUP" || fail "could not move current bundle aside"
if ! mv "$STAGED" "$TARGET"; then
  fail "install failed; restoring backup"
fi
xattr -dr com.apple.quarantine "$TARGET" >/dev/null 2>&1 || true
if ! codesign --verify --deep --strict "$TARGET" 2>>"$LOG"; then
  fail "signature check failed; restoring backup"
fi
INSTALL_PENDING=0
status installed
log "relaunching"
rm -rf "$STAGED_ROOT"
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
  let allowDowngrade = false
  let installPromise: Promise<void> | null = null
  let installCandidate: ReleaseCandidate | null = null
  let installChannel: UpdateChannel | null = null
  let handedOff = false

  const checking: Array<() => void> = []
  const available: Array<(info: UpdateInfoSummary) => void> = []
  const notAvailable: Array<() => void> = []
  const progress: Array<(value: UpdateProgress) => void> = []
  const downloaded: Array<(info: UpdateInfoSummary) => void> = []
  const errors: Array<(error: Error, context?: UpdateFailure) => void> = []
  let handoffTimer: ReturnType<typeof setTimeout> | null = null

  function stopHandoffWatch(): void {
    if (handoffTimer) {
      clearTimeout(handoffTimer)
      handoffTimer = null
    }
  }

  /**
   * After the helper is detached the app normally exits, so this watcher only
   * matters when quitting is delayed or refused. The helper records each step
   * in a status file; a timeout or failure there releases the one-install guard
   * and surfaces an error instead of leaving the session stuck.
   */
  function watchHandoff(statusPath: string, installRoot: string): void {
    const startedAt = Date.now()
    const finish = (status: string, abandonedRoot?: string): void => {
      stopHandoffWatch()
      if (status === 'installed') return
      if (abandonedRoot) {
        void removeWorkspace(abandonedRoot).catch((error: unknown) => {
          safeLog(console, '[commit87:update]', 'warn', `could not remove abandoned update workspace: ${String(error)}`)
        })
      }
      handedOff = false
      installPromise = null
      installCandidate = null
      installChannel = null
      const message =
        status === 'timeout'
          ? 'Commit87 did not quit within the update deadline, so the update was not installed. Quit Commit87 and try again.'
          : status === 'expired'
            ? 'The update helper stopped responding before it could install the update. Try again.'
            : status === 'interrupted'
              ? 'The update helper was interrupted before it could install the update. Try again.'
              : 'The update could not be installed. Your previous installation has been kept.'
      safeLog(console, '[commit87:update]', 'warn', message)
      errors.forEach((listener) => listener(new Error(message), 'install'))
    }
    const poll = async (): Promise<void> => {
      handoffTimer = null
      if (!handedOff) return
      let status: string | null = null
      try {
        status = (await readFile(statusPath, 'utf8')).trim()
      } catch {
        // The helper has not written its first status yet.
      }
      if (status === 'installed' || status === 'failed' || status === 'timeout' || status === 'interrupted') {
        finish(status)
        return
      }
      if (Date.now() - startedAt >= (options.handoffWatchMs ?? HANDOFF_WATCH_MS)) {
        finish('expired', installRoot)
        return
      }
      handoffTimer = setTimeout(() => void poll(), options.handoffPollMs ?? 500)
      handoffTimer.unref?.()
    }
    handoffTimer = setTimeout(() => void poll(), options.handoffPollMs ?? 500)
    handoffTimer.unref?.()
  }

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
      await removeWorkspace(stagingRoot)
      stagingRoot = null
      stagedApp = null
    }
  }

  return {
    setChannel: () => undefined,
    setAutoDownload: () => undefined,
    setAutoInstallOnAppQuit: () => undefined,
    setAllowDowngrade: (value) => { allowDowngrade = value },

    async check(): Promise<UpdateInfoSummary | null> {
      candidate = null
      checking.forEach((listener) => listener())
      const channel = options.channel()
      try {
        const releases = await listReleases()
        const found = pickRelease(releases, options.arch, channel)
        if (
          !found || found.version === options.currentVersion ||
          (!allowDowngrade && !isVersionNewer(found.version, options.currentVersion))
        ) {
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
          // Installation and downloads share one bounded cache. A new channel
          // must wait for stale preparation (including cleanup) to fully settle
          // before reusing that physical directory.
          await installPromise?.catch(() => undefined)
          if (handedOff) throw new Error('An update installation has already started')
          await cleanStaging()
          // This private, fixed workspace bounds deferred downloads across app
          // restarts. Never scan or delete other sessions' OS temp directories.
          await mkdir(options.cachePath, { recursive: true, mode: 0o700 })
          stagingRoot = join(options.cachePath, 'download')
          await removeWorkspace(stagingRoot)
          await mkdir(stagingRoot, { mode: 0o700 })
          controller.signal.throwIfAborted()
          const zipPath = join(stagingRoot, selected.zipAsset)
          const zipResponse = await fetch(selected.zipUrl, { redirect: 'follow', signal: controller.signal })
          if (!zipResponse.ok || !zipResponse.body) {
            throw new Error(`Download failed (HTTP ${zipResponse.status})`)
          }
          const total = Number(zipResponse.headers.get('content-length')) || 0

          safeLog(console, '[commit87:update]', 'info', `downloading ${selected.zipAsset} (${total} bytes)`)
          const writer = createWriteStream(zipPath)
          // Also interrupt a stalled HTTP body when the destination fails.
          // pipeline continuously handles stream errors, including async open.
          writer.once('error', () => controller.abort())
          let transferred = 0
          let lastEmitAt = 0
          let lastBytes = 0
          let lastTickAt = Date.now()
          await pipeline(
            zipResponse.body,
            async function* (source: AsyncIterable<Uint8Array>) {
              for await (const chunk of source) {
                const buffer = Buffer.from(chunk)
                transferred += buffer.length
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
                yield buffer
              }
            },
            writer,
            { signal: controller.signal }
          )
          progress.forEach((listener) => listener({ percent: 100, transferred, total, bytesPerSecond: 0 }))

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
          controller.signal.throwIfAborted()
          const staged = join(appDir, 'Commit87.app')
          await stat(staged).catch(() => {
            throw new Error('The downloaded archive does not contain Commit87.app')
          })
          await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=1', staged]).catch(() => {
            throw new Error(`The downloaded ${selected.version} bundle failed its code-signature check`)
          })
          const plist = await readFile(join(staged, 'Contents', 'Info.plist'), 'utf8')
          controller.signal.throwIfAborted()
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

    quitAndInstall(): Promise<void> {
      if (installPromise) {
        return candidate === installCandidate && options.channel() === installChannel
          ? installPromise
          : Promise.reject(new Error('The previous update preparation is still stopping. Try again.'))
      }
      if (!candidate || !stagedApp || !stagingRoot) {
        return Promise.reject(new Error('No verified update package is staged'))
      }
      const source = stagedApp
      const selected = candidate
      const selectedChannel = options.channel()
      installCandidate = selected
      installChannel = selectedChannel
      installPromise = (async () => {
        let installRoot: string | null = null
        try {
          // Prepare a complete replacement on the destination filesystem while
          // the app is still alive. A read-only DMG, translocation or permission
          // failure is returned through IPC instead of quitting the session.
          const target = await lstat(options.bundlePath)
          if (!target.isDirectory() || target.isSymbolicLink()) throw new Error('Not an installed app bundle')
          await access(dirname(options.bundlePath), constants.W_OK | constants.X_OK)
          installRoot = await mkdtemp(join(dirname(options.bundlePath), '.commit87-update-'))
          const incoming = join(installRoot, 'incoming.app')
          await run('/usr/bin/ditto', [source, incoming])
          await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', incoming])
          const logPath = join(options.cachePath, 'swap.log')
          const statusPath = join(options.cachePath, 'swap.status')
          const scriptPath = join(installRoot, 'swap.sh')
          await writeFile(scriptPath, buildSwapHelperScript({
            appPid: process.pid,
            targetBundle: options.bundlePath,
            stagedApp: incoming,
            stagedRoot: installRoot,
            logPath,
            statusPath
          }), { mode: 0o700 })
          // Clear any status from an earlier attempt so the watcher cannot read
          // a stale terminal state before this helper writes its own.
          await writeFile(statusPath, '')
          if (candidate !== selected || stagedApp !== source || options.channel() !== selectedChannel) {
            throw new Error('The selected update changed while preparing installation')
          }
          await cleanStaging()
          if (candidate !== selected || options.channel() !== selectedChannel) {
            throw new Error('The selected update changed while preparing installation')
          }
          const child = spawn('/bin/bash', [scriptPath, options.bundlePath, incoming, installRoot, logPath, statusPath], {
            detached: true,
            stdio: 'ignore'
          })
          child.on('error', (error) => {
            safeLog(console, '[commit87:update]', 'warn', `update helper: ${error.message}`)
          })
          await once(child, 'spawn')
          if (candidate !== selected || options.channel() !== selectedChannel) {
            child.kill()
            // A helper that exited before the kill has already emitted 'exit';
            // waiting for another event would hang the install call forever.
            if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
            throw new Error('The selected update changed while preparing installation')
          }
          child.unref()
          handedOff = true
          watchHandoff(statusPath, installRoot)
          options.quit()
        } catch (error) {
          if (installRoot && !handedOff) await removeWorkspace(installRoot)
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(
            `The update could not be prepared. Move Commit87.app to a writable Applications folder and try again. ${detail}`
          )
        }
      })().catch((error: unknown) => {
        installPromise = null
        throw error
      })
      return installPromise
    },

    onChecking: (listener) => checking.push(listener),
    onAvailable: (listener) => available.push(listener),
    onNotAvailable: (listener) => notAvailable.push(listener),
    onProgress: (listener) => progress.push(listener),
    onDownloaded: (listener) => downloaded.push(listener),
    onError: (listener) => errors.push(listener)
  }
}
