import { autoUpdater, CancellationToken } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import type { UpdateChannel, UpdateProgress } from '@shared/types'
import type { VerifiedAppImage } from './appimage-binding'
import { safeLog } from './logging'
import type { UpdateAdapter, UpdateDownloadTask, UpdateInfoSummary } from './updates'

const MAX_NOTES_LENGTH = 6000

function releaseNotesText(info: UpdateInfo): string | null {
  const notes = info.releaseNotes
  if (!notes) return null
  const text = Array.isArray(notes)
    ? notes
        .map((entry) => (entry.note ? `## ${entry.version}\n${entry.note}` : ''))
        .filter(Boolean)
        .join('\n\n')
    : notes
  const trimmed = text.replace(/\r\n/g, '\n').trim()
  return trimmed ? trimmed.slice(0, MAX_NOTES_LENGTH) : null
}

function summarize(info: UpdateInfo): UpdateInfoSummary {
  return {
    version: info.version,
    releaseDate: info.releaseDate || null,
    releaseNotes: releaseNotesText(info)
  }
}

function toProgress(info: ProgressInfo): UpdateProgress {
  return {
    percent: info.percent,
    transferred: info.transferred,
    total: info.total,
    bytesPerSecond: info.bytesPerSecond
  }
}

/**
 * A do-nothing adapter used when electron-updater cannot be constructed. That
 * happens when the main bundle is launched directly (for example
 * `electron out/main/index.js`), where Electron reports a placeholder app
 * version that is not valid semver. Updates are never offered in that case;
 * the rest of the app must still start.
 */
export function createInertUpdater(): UpdateAdapter {
  return {
    setChannel: () => undefined,
    setAutoDownload: () => undefined,
    setAutoInstallOnAppQuit: () => undefined,
    setAllowDowngrade: () => undefined,
    check: async () => null,
    download: () => {
      const error = new Error('Automatic updates are unavailable in this launch mode')
      return { promise: Promise.reject(error), cancel: () => undefined }
    },
    quitAndInstall: () => undefined,
    onChecking: () => undefined,
    onAvailable: () => undefined,
    onNotAvailable: () => undefined,
    onProgress: () => undefined,
    onDownloaded: () => undefined,
    onError: () => undefined
  }
}

/**
 * Bind the updater state machine to electron-updater. This module is the only
 * place that touches the library; all policy (channels, phases, gating on the
 * installed format) lives in `updates.ts`.
 */
export function createElectronUpdater(): UpdateAdapter {
  // The library logs every check and download step through this sink. A broken
  // stdio pipe must not turn a log line into a failed update check.
  autoUpdater.logger = {
    info: (message?: unknown) => safeLog(console, '[commit87:update]', 'info', message),
    warn: (message?: unknown) => safeLog(console, '[commit87:update]', 'warn', message),
    error: (message?: unknown) => safeLog(console, '[commit87:update]', 'error', message),
    debug: (message?: unknown) => safeLog(console, '[commit87:update]', 'debug', message)
  }

  return {
    setChannel(channel: UpdateChannel): void {
      autoUpdater.channel = channel === 'beta' ? 'beta' : 'latest'
      autoUpdater.allowPrerelease = channel === 'beta'
    },
    setAutoDownload(value: boolean): void {
      autoUpdater.autoDownload = value
    },
    setAutoInstallOnAppQuit(value: boolean): void {
      autoUpdater.autoInstallOnAppQuit = value
    },
    setAllowDowngrade(value: boolean): void {
      autoUpdater.allowDowngrade = value
    },
    async check(): Promise<UpdateInfoSummary | null> {
      const result = await autoUpdater.checkForUpdates()
      return result?.updateInfo ? summarize(result.updateInfo) : null
    },
    download(target: VerifiedAppImage | null): UpdateDownloadTask {
      const cancellationToken = new CancellationToken()
      // electron-updater's AppImage updater reads `APPIMAGE`. Set it from the
      // verified target immediately before delegating so a mutated environment
      // cannot redirect the download or the replacement.
      if (target) process.env.APPIMAGE = target.imagePath
      return {
        promise: autoUpdater.downloadUpdate(cancellationToken).then(() => undefined),
        cancel: () => cancellationToken.cancel()
      }
    },
    quitAndInstall(target: VerifiedAppImage | null): void {
      if (target) process.env.APPIMAGE = target.imagePath
      // Silent on Windows so the NSIS wizard does not interrupt the restart;
      // relaunch the app afterwards.
      autoUpdater.quitAndInstall(true, true)
    },
    onChecking(listener: () => void): void {
      autoUpdater.on('checking-for-update', listener)
    },
    onAvailable(listener: (info: UpdateInfoSummary) => void): void {
      autoUpdater.on('update-available', (info) => listener(summarize(info)))
    },
    onNotAvailable(listener: () => void): void {
      autoUpdater.on('update-not-available', () => listener())
    },
    onProgress(listener: (progress: UpdateProgress) => void): void {
      autoUpdater.on('download-progress', (info) => listener(toProgress(info)))
    },
    onDownloaded(listener: (info: UpdateInfoSummary) => void): void {
      autoUpdater.on('update-downloaded', (info) => listener(summarize(info)))
    },
    onError(listener: (error: Error) => void): void {
      autoUpdater.on('error', (error) => listener(error instanceof Error ? error : new Error(String(error))))
    }
  }
}
