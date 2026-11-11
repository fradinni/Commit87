import type { UpdateChannel, UpdateFailure, UpdateProgress, UpdateStatus } from '@shared/types'
import { createAppImageProbe, revalidateAppImage } from './appimage-binding'
import type { AppImageProbe, VerifiedAppImage } from './appimage-binding'
import { detectUpdateSupport } from './update-support'
import type { UpdateEnvironment, UpdateSupport } from './update-support'

export interface UpdateInfoSummary {
  version: string
  releaseDate: string | null
  releaseNotes: string | null
}

/**
 * The slice of electron-updater the service needs. Keeping it behind this
 * interface means the state machine can be exercised without Electron or the
 * network, and the real adapter stays a thin, auditable binding.
 */
export interface UpdateAdapter {
  setChannel(channel: UpdateChannel): void
  setAutoDownload(value: boolean): void
  setAutoInstallOnAppQuit(value: boolean): void
  setAllowDowngrade(value: boolean): void
  check(): Promise<UpdateInfoSummary | null>
  /**
   * Starts a download; the returned task can cancel it (used on a channel
   * switch). The verified AppImage target is passed explicitly so the adapter
   * never reads a possibly-mutated `APPIMAGE` environment variable.
   */
  download(target: VerifiedAppImage | null): UpdateDownloadTask
  quitAndInstall(target: VerifiedAppImage | null): void | Promise<void>
  onChecking(listener: () => void): void
  onAvailable(listener: (info: UpdateInfoSummary) => void): void
  onNotAvailable(listener: () => void): void
  onProgress(listener: (progress: UpdateProgress) => void): void
  onDownloaded(listener: (info: UpdateInfoSummary) => void): void
  /** `context` lets an adapter name the failed operation; defaults to the live phase. */
  onError(listener: (error: Error, context?: UpdateFailure) => void): void
}

export interface UpdateDownloadTask {
  promise: Promise<void>
  cancel: () => void
}

export interface UpdatePreferences {
  channel: UpdateChannel
  autoCheck: boolean
}

export interface UpdateServiceOptions {
  adapter: UpdateAdapter
  environment: UpdateEnvironment
  version: string
  preferences: () => UpdatePreferences
  onChange?: (status: UpdateStatus) => void
  /** Delay before the automatic check after launch. */
  autoCheckDelayMs?: number
  /** Injectable probe so AppImage revalidation can be tested without FUSE. */
  appImageProbe?: AppImageProbe
}

const MAX_ERROR_LENGTH = 500
const MAX_NOTES_LENGTH = 6000

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_LENGTH)
}

function sanitizeNotes(notes: string | null): string | null {
  if (!notes) return null
  const cleaned = notes.replace(/\r\n/g, '\n').trim()
  return cleaned ? cleaned.slice(0, MAX_NOTES_LENGTH) : null
}

/** A stable channel only ever offers versions without a prerelease suffix. */
export function versionMatchesChannel(version: string, channel: UpdateChannel): boolean {
  if (channel === 'beta') return true
  const core = version.split('+')[0]
  return !core.includes('-')
}

/** Clamp values from electron-updater so the renderer can render them blindly. */
export function normalizeProgress(progress: UpdateProgress): UpdateProgress {
  const percent = Number.isFinite(progress.percent) ? Math.min(100, Math.max(0, progress.percent)) : 0
  const total = Number.isFinite(progress.total) ? Math.max(0, Math.round(progress.total)) : 0
  const transferred = Number.isFinite(progress.transferred)
    ? Math.min(total || Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(progress.transferred)))
    : 0
  const bytesPerSecond = Number.isFinite(progress.bytesPerSecond)
    ? Math.max(0, Math.round(progress.bytesPerSecond))
    : 0
  return { percent: Math.round(percent * 10) / 10, transferred, total, bytesPerSecond }
}

export class UpdateService {
  private readonly adapter: UpdateAdapter
  private readonly support: UpdateSupport
  private readonly options: UpdateServiceOptions
  private readonly appImageProbe: AppImageProbe
  private readonly appImageTarget: VerifiedAppImage | null
  private status: UpdateStatus
  private appliedChannel: UpdateChannel
  private appliedAutoCheck: boolean
  private checkPromise: Promise<UpdateStatus> | null = null
  private checkPromiseGeneration: number | null = null
  private checkToken: object | null = null
  private checkGeneration = 0
  private downloadPromise: Promise<UpdateStatus> | null = null
  private downloadTask: UpdateDownloadTask | null = null
  private downloadActive = false
  private downloadChannel: UpdateChannel | null = null
  private downloadCancelled = false
  private downloadGeneration = 0
  private autoCheckTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: UpdateServiceOptions) {
    this.options = options
    this.adapter = options.adapter
    this.support = detectUpdateSupport(options.environment)
    this.appImageProbe = options.appImageProbe ?? createAppImageProbe()
    this.appImageTarget = options.environment.appImage ?? null
    const preferences = options.preferences()
    this.appliedChannel = preferences.channel
    this.appliedAutoCheck = preferences.autoCheck
    this.status = {
      supported: this.support.supported,
      reason: this.support.reason,
      phase: this.support.supported ? 'idle' : 'unsupported',
      currentVersion: options.version,
      channel: preferences.channel,
      version: null,
      releaseDate: null,
      releaseNotes: null,
      progress: null,
      error: null,
      failedAt: null,
      checkedAt: null,
      autoCheck: preferences.autoCheck
    }
    this.registerListeners()
    this.applyAdapterPreferences(preferences)
  }

  getStatus(): UpdateStatus {
    return this.snapshot()
  }

  /** Re-read persisted preferences after the settings screen changes them. */
  refreshPreferences(): UpdateStatus {
    const preferences = this.options.preferences()
    const channelChanged = preferences.channel !== this.appliedChannel
    this.status.channel = preferences.channel
    this.status.autoCheck = preferences.autoCheck
    this.appliedChannel = preferences.channel
    this.appliedAutoCheck = preferences.autoCheck
    if (this.support.supported) {
      this.applyAdapterPreferences(preferences)
    }
    if (!preferences.autoCheck) this.stop()
    if (channelChanged) {
      this.checkGeneration += 1
      // A download or check for the previous channel is useless now: cancel or
      // ignore it instead of letting it finish and offer the wrong build.
      if (this.status.phase === 'downloading') this.cancelDownload()
      if (this.status.phase === 'checking' || this.status.phase === 'downloading') {
        this.status.phase = 'idle'
        this.status.version = null
        this.status.releaseDate = null
        this.status.releaseNotes = null
        this.status.progress = null
        this.status.error = null
        this.status.failedAt = null
        this.status.checkedAt = null
      } else {
        this.clearAvailable()
      }
    }
    this.emit()
    return this.snapshot()
  }

  /** Schedule the once-per-session automatic check. */
  start(): void {
    if (this.autoCheckTimer || !this.support.supported || !this.appliedAutoCheck) return
    const delay = Math.max(0, this.options.autoCheckDelayMs ?? 12_000)
    this.autoCheckTimer = setTimeout(() => {
      this.autoCheckTimer = null
      void this.check()
    }, delay)
    this.autoCheckTimer.unref?.()
  }

  stop(): void {
    if (!this.autoCheckTimer) return
    clearTimeout(this.autoCheckTimer)
    this.autoCheckTimer = null
  }

  async check(): Promise<UpdateStatus> {
    if (!this.support.supported) {
      this.emit()
      return this.snapshot()
    }
    if (this.status.phase === 'ready') {
      // A downloaded package is already the newest build for this channel; a
      // new check would only demote the ready offer.
      return this.snapshot()
    }
    if (this.status.phase === 'downloading') {
      // A check must never interrupt an active download. The channel-change
      // path cancels explicitly when the target feed changes.
      return this.snapshot()
    }
    if (this.status.phase === 'installing') {
      // Preparing and handing off an installation must not be disturbed by an
      // automatic or manual check; a channel change clears the phase first.
      return this.snapshot()
    }
    if (this.checkPromise) {
      if (this.checkPromiseGeneration === this.checkGeneration) return this.checkPromise
      // A channel change invalidated the in-flight check. electron-updater
      // coalesces checks, so wait for that one to settle and then ask again.
      await this.checkPromise.catch(() => undefined)
      return this.check()
    }

    this.refreshPreferences()
    this.status.phase = 'checking'
    this.status.error = null
    this.status.failedAt = null
    this.status.progress = null
    this.emit()

    const generation = ++this.checkGeneration
    this.checkPromiseGeneration = generation
    const token = {}
    this.checkToken = token
    const promise = (async (): Promise<UpdateStatus> => {
      try {
        const info = await this.adapter.check()
        if (generation !== this.checkGeneration) return this.snapshot()
        // Real electron-updater emits the result event before resolving; only
        // fill in the terminal phase when no event has done it already.
        if (this.status.phase === 'checking') {
          if (info) this.markAvailable(info)
          else this.markUpToDate()
        }
        // The library's own auto-download cannot be cancelled from here, so the
        // automatic path uses our download() with its cancellation token.
        if (this.status.phase === 'available' && this.appliedAutoCheck) {
          void this.download().catch(() => undefined)
        }
      } catch (error) {
        if (generation === this.checkGeneration) this.fail(error, 'check')
      } finally {
        if (this.checkToken === token) {
          this.checkPromise = null
          this.checkPromiseGeneration = null
          this.checkToken = null
        }
        this.emit()
      }
      return this.snapshot()
    })()
    this.checkPromise = promise
    return promise
  }

  async download(): Promise<UpdateStatus> {
    if (!this.support.supported) return this.snapshot()
    const phaseNow = (): UpdateStatus['phase'] => this.status.phase
    if (phaseNow() === 'downloading' || phaseNow() === 'ready') return this.snapshot()
    if (this.downloadPromise) {
      // A cancelled task may still be settling. Wait for it before deciding,
      // because electron-updater only tracks one download at a time.
      await this.downloadPromise.catch(() => undefined)
      if (phaseNow() === 'ready') return this.snapshot()
    }
    if (phaseNow() !== 'available') {
      throw new Error('No update is available to download.')
    }

    // Revalidate immediately before the adapter is allowed to act. The target,
    // not the environment, is what the adapter will replace.
    const binding = this.boundAppImageTarget()
    if (!binding.ok) {
      this.fail(new Error(`The update download was refused: ${binding.reason}`), 'download')
      this.emit()
      return this.snapshot()
    }

    const generation = ++this.downloadGeneration
    this.downloadChannel = this.status.channel
    this.status.phase = 'downloading'
    this.status.error = null
    this.status.failedAt = null
    this.status.progress = { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }
    this.downloadCancelled = false
    this.downloadActive = true
    this.emit()

    const task = ((): UpdateDownloadTask => {
      try {
        return this.adapter.download(binding.target)
      } catch (error) {
        // A synchronous adapter failure must not leave the UI stuck in
        // `downloading` with no task to settle.
        this.downloadActive = false
        this.fail(error, 'download')
        this.emit()
        throw error
      }
    })()
    this.downloadTask = task
    this.downloadPromise = (async () => {
      try {
        await task.promise
        if (generation !== this.downloadGeneration) return this.snapshot()
        if (this.downloadCancelled) this.clearAvailable()
        else if (this.status.phase === 'downloading') {
          this.fail(new Error('The download finished without a prepared update package.'), 'download')
        }
      } catch (error) {
        if (generation !== this.downloadGeneration) return this.snapshot()
        if (this.downloadCancelled) this.clearAvailable()
        else this.fail(error, 'download')
      } finally {
        // The new download (if any) owns the fields now; never clear them from
        // a task that has already been superseded.
        if (this.downloadTask === task) {
          this.downloadTask = null
          this.downloadActive = false
          this.downloadPromise = null
        }
        this.emit()
      }
      return this.snapshot()
    })()
    return this.downloadPromise
  }

  install(): void | Promise<void> {
    if (!this.support.supported) {
      throw new Error(this.support.reason || 'Automatic updates are not supported on this build.')
    }
    if (this.status.phase !== 'ready') {
      throw new Error('No downloaded update is ready to install.')
    }
    // Recompute the binding again: the package was downloaded minutes ago and
    // the target may have been replaced, renamed or unmounted since.
    const binding = this.boundAppImageTarget()
    if (!binding.ok) {
      const error = new Error(`The update cannot be installed: ${binding.reason}`)
      this.fail(error, 'install')
      this.emit()
      throw error
    }
    const generation = this.checkGeneration
    const version = this.status.version
    // Show an explicit in-progress state while the adapter prepares the
    // replacement on disk; that can take several seconds for a full bundle.
    this.status.phase = 'installing'
    this.status.error = null
    this.status.failedAt = null
    this.emit()
    const failIfFresh = (error: unknown): void => {
      if (generation !== this.checkGeneration || this.status.version !== version) return
      if (this.status.phase !== 'installing' && this.status.phase !== 'ready') return
      this.fail(error, 'install')
      this.emit()
    }
    try {
      const result = this.adapter.quitAndInstall(binding.target)
      return result?.catch((error: unknown) => {
        failIfFresh(error)
        throw error
      })
    } catch (error) {
      failIfFresh(error)
      throw error
    }
  }

  /**
   * Return the verified AppImage target for an adapter call, or explain why the
   * call must not happen. Non-AppImage formats have no such target and are
   * unaffected by this check.
   */
  private boundAppImageTarget(): { ok: true; target: VerifiedAppImage | null } | { ok: false; reason: string } {
    if (this.support.format !== 'appimage') return { ok: true, target: null }
    if (!this.appImageTarget) {
      return { ok: false, reason: 'no update target is bound to the running installation.' }
    }
    const check = revalidateAppImage(this.appImageProbe, this.appImageTarget)
    if (!check.ok) return { ok: false, reason: check.reason }
    return { ok: true, target: this.appImageTarget }
  }

  private applyAdapterPreferences(preferences: UpdatePreferences): void {
    this.adapter.setChannel(preferences.channel)
    // Downloads always go through download() so they can be cancelled with the
    // channel they belong to; the library must not start one on its own.
    this.adapter.setAutoDownload(false)
    // Installing is always an explicit action ("Restart & install"); a normal
    // quit must never swap the binary behind the user's back.
    this.adapter.setAutoInstallOnAppQuit(false)
    this.adapter.setAllowDowngrade(
      preferences.channel === 'stable' && this.status.currentVersion.includes('-')
    )
  }

  private checkEventIsFresh(): boolean {
    return this.checkPromiseGeneration === null || this.checkPromiseGeneration === this.checkGeneration
  }

  private registerListeners(): void {
    if (!this.support.supported) return
    this.adapter.onChecking(() => {
      if (!this.checkEventIsFresh()) return
      this.status.phase = 'checking'
      this.status.error = null
      this.status.failedAt = null
      this.emit()
    })
    this.adapter.onAvailable((info) => {
      if (!this.checkEventIsFresh()) return
      if (this.status.phase === 'downloading' || this.status.phase === 'ready') return
      if (!versionMatchesChannel(info.version, this.status.channel)) return
      this.markAvailable(info)
      this.emit()
    })
    this.adapter.onNotAvailable(() => {
      if (!this.checkEventIsFresh()) return
      this.markUpToDate()
      this.emit()
    })
    this.adapter.onProgress((progress) => {
      if (this.downloadCancelled || !this.downloadActive) return
      if (this.downloadChannel && this.downloadChannel !== this.status.channel) return
      this.status.phase = 'downloading'
      this.status.progress = normalizeProgress(progress)
      this.emit()
    })
    this.adapter.onDownloaded((info) => {
      if (this.downloadCancelled || !this.downloadActive) return
      if (this.downloadChannel && this.downloadChannel !== this.status.channel) return
      if (!versionMatchesChannel(info.version, this.status.channel)) {
        this.clearAvailable()
        this.emit()
        return
      }
      this.status.phase = 'ready'
      this.status.version = info.version
      this.status.releaseDate = info.releaseDate
      this.status.releaseNotes = sanitizeNotes(info.releaseNotes)
      this.status.error = null
      this.status.failedAt = null
      this.status.checkedAt = Date.now()
      this.status.progress = {
        percent: 100,
        transferred: this.status.progress?.total ?? 0,
        total: this.status.progress?.total ?? 0,
        bytesPerSecond: 0
      }
      this.emit()
    })
    this.adapter.onError((error, context) => {
      if (this.downloadCancelled) return
      if (!this.checkEventIsFresh()) return
      this.fail(
        error,
        context ?? (this.downloadActive ? 'download' : this.status.phase === 'installing' ? 'install' : 'check')
      )
      this.emit()
    })
  }

  private cancelDownload(): void {
    this.downloadCancelled = true
    this.downloadGeneration += 1
    // Keep the task referenced until its promise settles; download() waits for
    // it, because electron-updater tracks a single download at a time.
    this.downloadTask?.cancel()
  }

  private markAvailable(info: UpdateInfoSummary): void {
    if (!versionMatchesChannel(info.version, this.status.channel)) {
      this.clearAvailable()
      return
    }
    this.status.phase = 'available'
    this.status.version = info.version
    this.status.releaseDate = info.releaseDate
    this.status.releaseNotes = sanitizeNotes(info.releaseNotes)
    this.status.progress = null
    this.status.error = null
    this.status.failedAt = null
    this.status.checkedAt = Date.now()
  }

  private markUpToDate(): void {
    this.status.phase = 'up-to-date'
    this.status.version = null
    this.status.releaseDate = null
    this.status.releaseNotes = null
    this.status.progress = null
    this.status.error = null
    this.status.failedAt = null
    this.status.checkedAt = Date.now()
  }

  private fail(error: unknown, failedAt: UpdateFailure = 'check'): void {
    this.status.phase = 'error'
    this.status.progress = null
    this.status.error = sanitizeError(error)
    this.status.failedAt = failedAt
    this.status.checkedAt = Date.now()
  }

  private clearAvailable(): void {
    this.status.phase = this.support.supported ? 'idle' : 'unsupported'
    this.status.version = null
    this.status.releaseDate = null
    this.status.releaseNotes = null
    this.status.progress = null
    this.status.error = null
    this.status.failedAt = null
    this.status.checkedAt = null
  }

  private snapshot(): UpdateStatus {
    return {
      ...this.status,
      progress: this.status.progress ? { ...this.status.progress } : null
    }
  }

  private emit(): void {
    this.options.onChange?.(this.snapshot())
  }
}
