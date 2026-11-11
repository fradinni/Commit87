import { describe, expect, it, vi } from 'vitest'
import type { UpdateChannel, UpdateFailure, UpdateProgress, UpdateStatus } from '../src/shared/types'
import type { AppImageProbe, VerifiedAppImage } from '../src/main/appimage-binding'
import { revalidateAppImage, verifyAppImage } from '../src/main/appimage-binding'
import type { UpdateAdapter, UpdateDownloadTask, UpdateInfoSummary, UpdatePreferences } from '../src/main/updates'
import { UpdateService, normalizeProgress, versionMatchesChannel } from '../src/main/updates'
import { detectUpdateSupport } from '../src/main/update-support'
import type { UpdateEnvironment } from '../src/main/update-support'
import { isDeveloperIdSignature } from '../src/main/mac-signing'

const info: UpdateInfoSummary = {
  version: '0.2.0',
  releaseDate: '2026-11-05T10:00:00.000Z',
  releaseNotes: '## 0.2.0\n\n- Updates land in place'
}

class FakeAdapter implements UpdateAdapter {
  channel: UpdateChannel = 'stable'
  autoDownload = true
  autoInstallOnAppQuit = false
  allowDowngrade = false
  checks = 0
  downloads = 0
  installs = 0
  downloadTargets: Array<VerifiedAppImage | null> = []
  installTargets: Array<VerifiedAppImage | null> = []
  checkResult: UpdateInfoSummary | null = info
  downloadError: Error | null = null
  private emitEvents = true
  private checkGate: Promise<void> | null = null
  private readonly checking: Array<() => void> = []
  private readonly available: Array<(value: UpdateInfoSummary) => void> = []
  private readonly notAvailable: Array<() => void> = []
  private readonly progress: Array<(value: UpdateProgress) => void> = []
  private readonly downloaded: Array<(value: UpdateInfoSummary) => void> = []
  private readonly errors: Array<(error: Error, context?: UpdateFailure) => void> = []

  setChannel(channel: UpdateChannel): void {
    this.channel = channel
    // Real electron-updater forces allowDowngrade on every channel change; the
    // service must correct it afterwards.
    this.allowDowngrade = true
  }

  setAutoDownload(value: boolean): void {
    this.autoDownload = value
  }

  setAutoInstallOnAppQuit(value: boolean): void {
    this.autoInstallOnAppQuit = value
  }

  setAllowDowngrade(value: boolean): void {
    this.allowDowngrade = value
  }

  setSilent(value: boolean): void {
    this.emitEvents = value
  }

  holdCheck(): () => void {
    let release = (): void => undefined
    this.checkGate = new Promise((resolve) => {
      release = resolve
    })
    return release
  }

  async check(): Promise<UpdateInfoSummary | null> {
    this.checks += 1
    if (this.checkGate) await this.checkGate
    if (this.emitEvents) this.checking.forEach((listener) => listener())
    if (this.emitEvents) {
      if (this.checkResult) this.available.forEach((listener) => listener(this.checkResult as UpdateInfoSummary))
      else this.notAvailable.forEach((listener) => listener())
    }
    return this.checkResult
  }

  download(target: VerifiedAppImage | null): UpdateDownloadTask {
    this.downloadTargets.push(target)
    return { promise: this.runDownload(), cancel: () => undefined }
  }

  private async runDownload(): Promise<void> {
    this.downloads += 1
    if (this.downloadError) {
      this.errors.forEach((listener) => listener(this.downloadError as Error))
      throw this.downloadError
    }
    if (this.emitEvents) {
      this.progress.forEach((listener) =>
        listener({ percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: 2048 })
      )
      this.downloaded.forEach((listener) => listener(info))
    }
  }

  emittingTask(): UpdateDownloadTask {
    return { promise: this.runDownload(), cancel: () => undefined }
  }

  startDownload(): { task: UpdateDownloadTask; release: () => void } {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let cancelled = false
    const task: UpdateDownloadTask = {
      promise: (async () => {
        await gate
        if (cancelled) throw new Error('cancelled')
        await this.runDownload()
      })(),
      cancel: () => {
        cancelled = true
        release()
      }
    }
    return { task, release }
  }

  quitAndInstall(target: VerifiedAppImage | null): void {
    this.installTargets.push(target)
    this.installs += 1
  }

  onChecking(listener: () => void): void {
    this.checking.push(listener)
  }

  onAvailable(listener: (value: UpdateInfoSummary) => void): void {
    this.available.push(listener)
  }

  onNotAvailable(listener: () => void): void {
    this.notAvailable.push(listener)
  }

  onProgress(listener: (value: UpdateProgress) => void): void {
    this.progress.push(listener)
  }

  onDownloaded(listener: (value: UpdateInfoSummary) => void): void {
    this.downloaded.push(listener)
  }

  onError(listener: (error: Error, context?: UpdateFailure) => void): void {
    this.errors.push(listener)
  }

  triggerError(error: Error, context?: UpdateFailure): void {
    this.errors.forEach((listener) => listener(error, context))
  }

  triggerProgress(progress: UpdateProgress): void {
    this.progress.forEach((listener) => listener(progress))
  }

  triggerDownloaded(value: UpdateInfoSummary): void {
    this.downloaded.forEach((listener) => listener(value))
  }

  triggerAvailable(value: UpdateInfoSummary): void {
    this.available.forEach((listener) => listener(value))
  }
}

interface FakeStat {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  mode: number
  isFile(): boolean
}

const IMAGE_PATH = '/home/user/Commit 87.AppImage'
const MOUNT_POINT = '/tmp/.mount_Commit87'
const EXEC_PATH = `${MOUNT_POINT}/commit87`
const IMAGE_DEV = 1
const IMAGE_INO = 42
const IMAGE_SIZE = 1024
const IMAGE_MTIME = 1_700_000_000_000
const IMAGE_MODE = 0o100755

function makeStat(
  overrides: { dev?: number; ino?: number; size?: number; mtimeMs?: number; mode?: number } = {}
): FakeStat {
  return {
    dev: overrides.dev ?? IMAGE_DEV,
    ino: overrides.ino ?? IMAGE_INO,
    size: overrides.size ?? IMAGE_SIZE,
    mtimeMs: overrides.mtimeMs ?? IMAGE_MTIME,
    mode: overrides.mode ?? IMAGE_MODE,
    isFile: () => true
  }
}

function buildMountInfo(source = IMAGE_PATH, mountPoint = MOUNT_POINT, filesystem = 'squashfs'): string {
  const escape = (value: string): string => value.replace(/ /g, '\\040')
  return `100 90 0:42 / ${escape(mountPoint)} rw,nosuid,nodev - ${escape(filesystem)} ${escape(source)} ro\n`
}

/**
 * Fake kernel view of a mounted AppImage. `realpath` is the identity so the
 * tests can reason about the canonical paths they declare; it throws for a
 * relative path — stricter than the real call, so a bare mount name can never
 * be made to resolve by the working directory.
 */
class FakeProbe implements AppImageProbe {
  platform: NodeJS.Platform = 'linux'
  execPath: string = EXEC_PATH
  hint: string | undefined = IMAGE_PATH
  mountInfo: string = buildMountInfo()
  private readonly files = new Map<string, FakeStat>()
  private readonly readable = new Map<string, string>()

  constructor() {
    this.files.set(IMAGE_PATH, makeStat())
  }

  env(name: string): string | undefined {
    return name === 'APPIMAGE' ? this.hint : undefined
  }

  realpath(path: string): string {
    if (!path.startsWith('/')) throw new Error(`ENOENT: ${path}`)
    return path
  }

  readFile(path: string): string {
    if (path === '/proc/self/mountinfo') return this.mountInfo
    const value = this.readable.get(path)
    if (value === undefined) throw new Error(`ENOENT: ${path}`)
    return value
  }

  stat(path: string): FakeStat {
    const value = this.files.get(path)
    if (!value) throw new Error(`ENOENT: ${path}`)
    return value
  }

  setFile(path: string, stat: FakeStat = makeStat()): void {
    this.files.set(path, stat)
  }

  removeFile(path: string): void {
    this.files.delete(path)
  }

  setReadable(path: string, contents: string): void {
    this.readable.set(path, contents)
  }
}

const verifiedImage: VerifiedAppImage = {
  imagePath: IMAGE_PATH,
  dev: IMAGE_DEV,
  ino: IMAGE_INO,
  size: IMAGE_SIZE,
  mtimeMs: IMAGE_MTIME,
  mode: IMAGE_MODE,
  mountPoint: MOUNT_POINT,
  mountSource: IMAGE_PATH,
  filesystem: 'squashfs'
}

const packaged: UpdateEnvironment = { platform: 'linux', isPackaged: true, appImage: verifiedImage }

function setup(
  options: {
    preferences?: Partial<UpdatePreferences>
    environment?: UpdateEnvironment
    version?: string
    probe?: AppImageProbe
  } = {}
) {
  const adapter = new FakeAdapter()
  const preferences: UpdatePreferences = {
    channel: options.preferences?.channel ?? 'stable',
    autoCheck: options.preferences?.autoCheck ?? false
  }
  const seen: UpdateStatus[] = []
  const service = new UpdateService({
    adapter,
    environment: options.environment ?? packaged,
    version: options.version ?? '0.1.0',
    preferences: () => preferences,
    onChange: (status) => seen.push(status),
    autoCheckDelayMs: 1000,
    appImageProbe: options.probe ?? new FakeProbe()
  })
  return { adapter, preferences, seen, service }
}

describe('update support detection', () => {
  it('allows packaged AppImage, NSIS and macOS bundles only', () => {
    expect(detectUpdateSupport(packaged)).toEqual({ supported: true, format: 'appimage', reason: null })
    expect(detectUpdateSupport({ platform: 'win32', isPackaged: true, windowsUninstaller: true })).toEqual({
      supported: true,
      format: 'nsis',
      reason: null
    })
    expect(detectUpdateSupport({ platform: 'darwin', isPackaged: true, macDeveloperId: true })).toEqual({
      supported: true,
      format: 'dmg',
      reason: null
    })
  })

  it('supports ad-hoc macOS builds through the release-zip updater', () => {
    // Squirrel.Mac cannot validate an ad-hoc build's update (the signature is
    // pinned to the current cdhash), so ad-hoc macOS bundles are updated by
    // downloading the release zip and swapping it in place instead.
    const adHoc = detectUpdateSupport({ platform: 'darwin', isPackaged: true, macDeveloperId: false })
    expect(adHoc).toEqual({ supported: true, format: 'maczip', reason: null })
  })

  it('recognises a Developer ID signature from codesign output', () => {
    const signed = [
      'Executable=/Applications/Commit87.app/Contents/MacOS/Commit87',
      'Identifier=fr.fradinni.Commit87',
      'CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=6+3 location=embedded',
      'Authority=Developer ID Application: Commit87 Team (ABCDE12345)',
      'Authority=Developer ID Certification Authority',
      'Authority=Apple Root CA',
      'TeamIdentifier=ABCDE12345'
    ].join('\n')
    expect(isDeveloperIdSignature(signed)).toBe(true)
    // Ad-hoc builds print no Authority at all.
    expect(isDeveloperIdSignature('Identifier=fr.fradinni.Commit87\nSignature=adhoc\nTeamIdentifier=not set')).toBe(false)
    expect(isDeveloperIdSignature('')).toBe(false)
  })

  it('explains why other builds are not updated in place', () => {
    expect(detectUpdateSupport({ platform: 'linux', isPackaged: false }).supported).toBe(false)
    expect(detectUpdateSupport({ platform: 'linux', isPackaged: true, flatpak: 'fr.fradinni.Commit87' }).reason).toContain(
      'Flatpak'
    )
    expect(detectUpdateSupport({ platform: 'linux', isPackaged: true, snap: '/snap/commit87' }).reason).toContain('snapd')
    expect(detectUpdateSupport({ platform: 'linux', isPackaged: true }).reason).toContain('AppImage')
    expect(detectUpdateSupport({ platform: 'win32', isPackaged: true, portable: 'C:\\Commit87.exe' }).reason).toContain(
      'Portable'
    )
    // A zip build has no installer and no uninstaller, so it must not be offered
    // an NSIS update that would install a second copy.
    expect(detectUpdateSupport({ platform: 'win32', isPackaged: true }).reason).toContain('zip')
    expect(detectUpdateSupport({ platform: 'freebsd', isPackaged: true }).supported).toBe(false)
  })
})

describe('AppImage binding', () => {
  it('accepts an image whose mount source contains the running executable', () => {
    const probe = new FakeProbe()
    const result = verifyAppImage(probe)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.target).toEqual(verifiedImage)
    expect(detectUpdateSupport({ platform: 'linux', isPackaged: true, appImage: result.target })).toEqual({
      supported: true,
      format: 'appimage',
      reason: null
    })
  })

  it('accepts a FUSE mount that records the image name instead of its path', () => {
    // The bundled AppImage runtime mounts with the file name as its fsname, so
    // the kernel never records the absolute path. Resolving that name against
    // the process working directory made verification depend on the launch cwd.
    const probe = new FakeProbe()
    probe.mountInfo = buildMountInfo('Commit 87.AppImage', MOUNT_POINT, 'fuse.Commit 87.AppImage')
    const result = verifyAppImage(probe)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.target.imagePath).toBe(IMAGE_PATH)
    expect(result.target.mountSource).toBe('Commit 87.AppImage')
    expect(result.target.mountPoint).toBe(MOUNT_POINT)
    expect(revalidateAppImage(probe, result.target)).toEqual({ ok: true })
  })

  it('accepts a runtime that names a renamed image', () => {
    // The mount is only identifiable by the fsname when the image has no
    // `.AppImage` suffix to give it away.
    const probe = new FakeProbe()
    const renamed = '/home/user/commit87-nightly'
    probe.hint = renamed
    probe.setFile(renamed, makeStat())
    probe.mountInfo = buildMountInfo('commit87-nightly', MOUNT_POINT, 'fuse.commit87-nightly')
    const result = verifyAppImage(probe)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.target.imagePath).toBe(renamed)
    expect(result.target.mountSource).toBe('commit87-nightly')
    expect(revalidateAppImage(probe, result.target)).toEqual({ ok: true })
  })

  it('binds a same-named file when the mount records only the image name', () => {
    // The FUSE runtime records no directory, so the kernel cannot distinguish
    // two files with the same name. Accepted trade-off: the mount is proven to
    // be the AppImage this process runs from, but the replaced file is the one
    // APPIMAGE names, which may live in another directory.
    const probe = new FakeProbe()
    const sameName = '/tmp/elsewhere/Commit 87.AppImage'
    probe.hint = sameName
    probe.setFile(sameName, makeStat({ ino: 7 }))
    probe.mountInfo = buildMountInfo('Commit 87.AppImage', MOUNT_POINT, 'fuse.Commit 87.AppImage')
    const result = verifyAppImage(probe)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.target.imagePath).toBe(sameName)
    expect(result.target.mountSource).toBe('Commit 87.AppImage')
    expect(revalidateAppImage(probe, result.target)).toEqual({ ok: true })
  })

  it('refuses a mount source that is a relative path', () => {
    const probe = new FakeProbe()
    probe.mountInfo = buildMountInfo('dist/Commit 87.AppImage', MOUNT_POINT, 'fuse.squashfuse')
    const result = verifyAppImage(probe)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the relative mount source to be rejected')
    expect(result.reason).toContain('does not identify the image mounted')
  })

  it('rejects a FUSE mount name that does not match the hinted image', () => {
    const probe = new FakeProbe()
    probe.mountInfo = buildMountInfo('Other.AppImage', MOUNT_POINT, 'fuse.Other.AppImage')
    const result = verifyAppImage(probe)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the mismatched mount name to be rejected')
    expect(result.reason).toContain('does not identify the image mounted')
  })

  it('resolves a kernel loop mount through the loop device backing file', () => {
    const probe = new FakeProbe()
    probe.mountInfo = buildMountInfo('/dev/loop7', MOUNT_POINT, 'squashfs')
    probe.setReadable('/sys/block/loop7/loop/backing_file', `${IMAGE_PATH}\n`)
    const result = verifyAppImage(probe)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.target.mountSource).toBe(IMAGE_PATH)
    expect(revalidateAppImage(probe, result.target)).toEqual({ ok: true })

    // A loop device that backs another file must not bind this installation.
    probe.setReadable('/sys/block/loop7/loop/backing_file', '/home/user/Other.AppImage\n')
    const other = verifyAppImage(probe)
    expect(other.ok).toBe(false)
    if (other.ok) throw new Error('expected the other loop backing file to be rejected')
    expect(other.reason).toContain('does not identify the image mounted')
  })

  it('refuses a loop mount whose backing file cannot be identified', () => {
    const probe = new FakeProbe()
    probe.mountInfo = buildMountInfo('/dev/loop9', MOUNT_POINT, 'squashfs')

    // No sysfs entry: the loop device cannot be traced back to a file.
    const missing = verifyAppImage(probe)
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('expected the untraceable loop device to be rejected')
    expect(missing.reason).toContain('does not identify the image mounted')

    // A backing file that was deleted after mounting must not resolve either.
    probe.setReadable('/sys/block/loop9/loop/backing_file', `${IMAGE_PATH} (deleted)\n`)
    const deleted = verifyAppImage(probe)
    expect(deleted.ok).toBe(false)
  })

  it('refuses to revalidate when the FUSE mount name changes', () => {
    const probe = new FakeProbe()
    probe.mountInfo = buildMountInfo('Commit 87.AppImage', MOUNT_POINT, 'fuse.Commit 87.AppImage')
    const result = verifyAppImage(probe)
    if (!result.ok) throw new Error(result.reason)
    probe.mountInfo = buildMountInfo('Other.AppImage', MOUNT_POINT, 'fuse.Other.AppImage')
    expect(revalidateAppImage(probe, result.target)).toEqual({
      ok: false,
      reason: 'The AppImage mount source no longer matches the verified update target.'
    })
  })

  it('rejects a non-empty APPIMAGE for an unpacked or extracted run', async () => {
    const probe = new FakeProbe()
    probe.mountInfo = ''
    const result = verifyAppImage(probe)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the unpacked run to be rejected')
    expect(result.reason).toMatch(/unpacked or extracted/i)

    const environment: UpdateEnvironment = {
      platform: 'linux',
      isPackaged: true,
      appImage: null,
      appImageReason: result.reason
    }
    expect(detectUpdateSupport(environment)).toMatchObject({ supported: false, format: null })
    const { adapter, service } = setup({ environment })
    await service.check()
    const status = await service.download()
    expect(status.phase).toBe('unsupported')
    expect(() => service.install()).toThrow(/unpacked or extracted/i)
    expect(adapter.checks).toBe(0)
    expect(adapter.downloads).toBe(0)
    expect(adapter.installs).toBe(0)
  })

  it('rejects an APPIMAGE that names a different file than the mount source', () => {
    const probe = new FakeProbe()
    const other = '/home/user/Other.AppImage'
    probe.hint = other
    probe.setFile(other, makeStat({ ino: 7 }))
    const result = verifyAppImage(probe)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the mismatched hint to be rejected')
    expect(result.reason).toContain('does not identify the image mounted')
  })

  it('rejects an executable outside the AppImage mount point', () => {
    const probe = new FakeProbe()
    probe.execPath = '/opt/commit87/commit87'
    const result = verifyAppImage(probe)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the outside executable to be rejected')
    expect(result.reason).toContain('outside every AppImage mount point')
  })

  it('rejects an image that is not a regular executable file', () => {
    const probe = new FakeProbe()
    probe.setFile(IMAGE_PATH, makeStat({ mode: 0o100644 }))
    const result = verifyAppImage(probe)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a non-executable image to be rejected')
    expect(result.reason).toContain('not executable')
  })
})

describe('channel matching', () => {
  it('keeps prerelease builds off the stable channel', () => {
    expect(versionMatchesChannel('0.2.0', 'stable')).toBe(true)
    expect(versionMatchesChannel('0.2.0-beta.1', 'stable')).toBe(false)
    expect(versionMatchesChannel('0.2.0-beta.1', 'beta')).toBe(true)
    expect(versionMatchesChannel('0.2.0', 'beta')).toBe(true)
  })

  it('treats build metadata with a hyphen as stable', () => {
    expect(versionMatchesChannel('1.0.0+build-1', 'stable')).toBe(true)
  })
})

describe('update progress normalization', () => {
  it('clamps percentages, byte counts and speeds', () => {
    expect(normalizeProgress({ percent: 142.345, transferred: 2000, total: 1000, bytesPerSecond: -5 })).toEqual({
      percent: 100,
      transferred: 1000,
      total: 1000,
      bytesPerSecond: 0
    })
    expect(normalizeProgress({ percent: Number.NaN, transferred: Number.NaN, total: 0, bytesPerSecond: 12.6 })).toEqual({
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 13
    })
  })
})

describe('UpdateService', () => {
  it('reports an unsupported build without touching the adapter', async () => {
    const { adapter, service } = setup({
      environment: { platform: 'linux', isPackaged: false }
    })
    expect(service.getStatus()).toMatchObject({ supported: false, phase: 'unsupported' })
    await service.check()
    expect(adapter.checks).toBe(0)
    expect(service.getStatus().phase).toBe('unsupported')
  })

  it('applies the channel and automatic download preference to the adapter', () => {
    const { adapter } = setup({ preferences: { channel: 'beta', autoCheck: true } })
    expect(adapter.channel).toBe('beta')
    // The service owns downloads so they can be cancelled; the library must not
    // start one during a check.
    expect(adapter.autoDownload).toBe(false)
    // Installing always needs the explicit "Restart & install" action.
    expect(adapter.autoInstallOnAppQuit).toBe(false)
    expect(adapter.allowDowngrade).toBe(false)
  })

  it('allows downgrading when a prerelease build switches back to stable', () => {
    const { adapter, service, preferences } = setup({ version: '0.2.0-beta.1' })
    // A beta build on the stable channel may move to the newest stable release,
    // even when that stable version sorts lower than the installed prerelease.
    expect(adapter.allowDowngrade).toBe(true)
    preferences.channel = 'beta'
    service.refreshPreferences()
    expect(adapter.allowDowngrade).toBe(false)
    preferences.channel = 'stable'
    service.refreshPreferences()
    expect(adapter.allowDowngrade).toBe(true)
  })

  it('surfaces an available update with notes and check timestamp', async () => {
    const { adapter, service } = setup()
    expect(adapter.autoDownload).toBe(false)
    const status = await service.check()
    expect(adapter.checks).toBe(1)
    expect(status).toMatchObject({
      phase: 'available',
      currentVersion: '0.1.0',
      version: '0.2.0',
      releaseDate: '2026-11-05T10:00:00.000Z',
      releaseNotes: '## 0.2.0\n\n- Updates land in place',
      error: null
    })
    expect(status.checkedAt).not.toBeNull()
  })

  it('falls back to the returned update info when no event is emitted', async () => {
    const { adapter, service } = setup()
    adapter.setSilent(true)
    const status = await service.check()
    expect(status.phase).toBe('available')
    expect(status.version).toBe('0.2.0')

    adapter.checkResult = null
    const second = await service.check()
    expect(second.phase).toBe('up-to-date')
    expect(second.version).toBeNull()
  })

  it('downloads an available update and reaches the ready phase', async () => {
    const { adapter, service } = setup()
    await service.check()
    const status = await service.download()
    expect(adapter.downloads).toBe(1)
    expect(status.phase).toBe('ready')
    expect(status.progress).toEqual({ percent: 100, transferred: 1000, total: 1000, bytesPerSecond: 0 })
  })

  it('awaits asynchronous install preparation and reports a refusal without quitting', async () => {
    const { adapter, service } = setup()
    await service.check()
    await service.download()
    vi.spyOn(adapter, 'quitAndInstall').mockImplementation(() =>
      Promise.reject(new Error('The application folder is read-only'))
    )

    await expect(service.install()).rejects.toThrow('read-only')
    expect(service.getStatus()).toMatchObject({
      phase: 'error',
      error: 'The application folder is read-only',
      failedAt: 'install'
    })
    expect(adapter.installs).toBe(0)
  })

  it('shows an installing phase while the adapter prepares the package', async () => {
    const { adapter, service } = setup()
    await service.check()
    await service.download()
    let finish = (): void => undefined
    vi.spyOn(adapter, 'quitAndInstall').mockImplementation(() => new Promise<void>((resolve) => {
      finish = resolve
    }))

    const installing = service.install()
    expect(service.getStatus()).toMatchObject({ phase: 'installing', failedAt: null })
    finish()
    await installing
  })

  it('does not let a check disturb an installation in progress', async () => {
    const { adapter, service } = setup()
    await service.check()
    await service.download()
    let finish = (): void => undefined
    vi.spyOn(adapter, 'quitAndInstall').mockImplementation(() => new Promise<void>((resolve) => {
      finish = resolve
    }))
    const before = adapter.checks
    const installing = service.install()

    const status = await service.check()

    expect(status.phase).toBe('installing')
    expect(adapter.checks).toBe(before)
    finish()
    await installing
  })

  it('does not let a stale install failure demote a new channel package', async () => {
    const { adapter, service, preferences } = setup()
    await service.check()
    await service.download()
    let rejectInstall = (_error: Error): void => undefined
    vi.spyOn(adapter, 'quitAndInstall').mockImplementation(() => new Promise<void>((_resolve, reject) => {
      rejectInstall = reject
    }))
    const installing = service.install()
    preferences.channel = 'beta'
    service.refreshPreferences()
    await service.check()
    await service.download()
    expect(service.getStatus().phase).toBe('ready')

    rejectInstall(new Error('The old update preparation was cancelled'))
    await expect(installing).rejects.toThrow('old update preparation')
    expect(service.getStatus()).toMatchObject({ phase: 'ready', channel: 'beta', error: null })
  })

  it('refuses to download without an available update and to install before ready', async () => {
    const { adapter, service } = setup()
    await expect(service.download()).rejects.toThrow('No update is available')
    expect(() => service.install()).toThrow('No downloaded update')
    expect(adapter.installs).toBe(0)
  })

  it('does not demote a downloaded update when checking again', async () => {
    const { adapter, service } = setup()
    await service.check()
    await service.download()
    const status = await service.check()
    expect(adapter.checks).toBe(1)
    expect(status).toMatchObject({ phase: 'ready', version: '0.2.0' })
    expect(adapter.downloads).toBe(1)
  })

  it('installs only once the package is ready', async () => {
    const { adapter, service } = setup()
    await service.check()
    await service.download()
    expect(service.getStatus().phase).toBe('ready')
    service.install()
    expect(adapter.installs).toBe(1)
    expect(adapter.installTargets[0]).toEqual(verifiedImage)
  })

  it('passes the verified target even after the environment hint is mutated', async () => {
    const probe = new FakeProbe()
    const { adapter, service } = setup({ probe })
    await service.check()
    probe.hint = '/tmp/replaced.AppImage'
    process.env.APPIMAGE = '/tmp/replaced.AppImage'
    try {
      await service.download()
      expect(service.getStatus().phase).toBe('ready')
      service.install()
    } finally {
      delete process.env.APPIMAGE
    }
    expect(adapter.downloadTargets).toEqual([verifiedImage])
    expect(adapter.installTargets).toEqual([verifiedImage])
  })

  it('downloads and installs a FUSE-bound AppImage target', async () => {
    const probe = new FakeProbe()
    probe.mountInfo = buildMountInfo('Commit 87.AppImage', MOUNT_POINT, 'fuse.Commit 87.AppImage')
    const verified = verifyAppImage(probe)
    if (!verified.ok) throw new Error(verified.reason)
    const { adapter, service } = setup({
      probe,
      environment: { platform: 'linux', isPackaged: true, appImage: verified.target }
    })
    await service.check()
    await service.download()
    expect(service.getStatus().phase).toBe('ready')
    service.install()
    expect(adapter.downloadTargets).toEqual([verified.target])
    expect(adapter.installTargets).toEqual([verified.target])
  })

  it('refuses to download when the verified image disappears after the check', async () => {
    const probe = new FakeProbe()
    const { adapter, service } = setup({ probe })
    await service.check()
    expect(service.getStatus().phase).toBe('available')
    probe.removeFile(IMAGE_PATH)
    const status = await service.download()
    expect(status.phase).toBe('error')
    expect(status.error).toContain('no longer available')
    expect(adapter.downloads).toBe(0)
  })

  it('refuses to install when the verified image changes after download', async () => {
    const probe = new FakeProbe()
    const { adapter, service } = setup({ probe })
    await service.check()
    await service.download()
    expect(service.getStatus().phase).toBe('ready')
    probe.setFile(IMAGE_PATH, makeStat({ ino: 99 }))
    expect(() => service.install()).toThrow(/replaced or modified/)
    expect(adapter.installs).toBe(0)
    expect(service.getStatus().phase).toBe('error')
  })

  it('sanitizes updater errors and keeps the channel selection', async () => {
    const { adapter, service, preferences } = setup({ preferences: { channel: 'beta' } })
    adapter.setSilent(true)
    adapter.checkResult = null
    const error = new Error(`network down\n\n${'x'.repeat(700)}`)
    adapter.check = async (): Promise<UpdateInfoSummary | null> => {
      throw error
    }
    const status = await service.check()
    expect(status.phase).toBe('error')
    expect(status.error).not.toContain('\n')
    expect(status.error?.length).toBe(500)
    expect(status.failedAt).toBe('check')
    expect(status.channel).toBe('beta')
    expect(preferences.channel).toBe('beta')
  })

  it('reacts to adapter error events without throwing', async () => {
    const { adapter, service } = setup()
    adapter.triggerError(new Error('signature mismatch'))
    expect(service.getStatus()).toMatchObject({
      phase: 'error',
      error: 'signature mismatch',
      failedAt: 'check'
    })
  })

  it('uses an adapter-provided install context for a helper failure', async () => {
    const { adapter, service } = setup()
    adapter.triggerError(new Error('The update helper timed out'), 'install')
    expect(service.getStatus()).toMatchObject({
      phase: 'error',
      error: 'The update helper timed out',
      failedAt: 'install'
    })
  })

  it('downloads automatically after a check when automatic updates are enabled', async () => {
    const { adapter, service } = setup({ preferences: { autoCheck: true } })
    await service.check()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(adapter.downloads).toBe(1)
    expect(service.getStatus().phase).toBe('ready')
  })

  it('re-checks on the new channel when it changes mid-check', async () => {
    const { adapter, service, preferences } = setup()
    const release = adapter.holdCheck()
    const first = service.check()
    preferences.channel = 'beta'
    service.refreshPreferences()
    // The stale check resolves against the old feed; the service must not adopt
    // its result and a second request must run a real check.
    adapter.checkResult = { ...info, version: '0.3.0-beta.1' }
    release()
    const [stale, fresh] = await Promise.all([first, service.check()])
    expect(adapter.checks).toBe(2)
    expect(stale.channel).toBe('beta')
    expect(fresh).toMatchObject({ phase: 'available', channel: 'beta', version: '0.3.0-beta.1' })
  })

  it('re-checks after a channel round-trip instead of reusing the stale check', async () => {
    const { adapter, service, preferences } = setup()
    const release = adapter.holdCheck()
    const first = service.check()
    preferences.channel = 'beta'
    service.refreshPreferences()
    preferences.channel = 'stable'
    service.refreshPreferences()
    adapter.checkResult = { ...info, version: '0.2.1' }
    release()
    const [stale, fresh] = await Promise.all([first, service.check()])
    expect(adapter.checks).toBe(2)
    expect(stale).toMatchObject({ phase: 'idle' })
    expect(fresh).toMatchObject({ phase: 'available', channel: 'stable', version: '0.2.1' })
  })

  it('ignores a stale check error after a channel change', async () => {
    const { adapter, service, preferences } = setup()
    const release = adapter.holdCheck()
    const check = service.check()
    preferences.channel = 'beta'
    service.refreshPreferences()
    adapter.triggerError(new Error('old channel failed'))
    expect(service.getStatus()).toMatchObject({ phase: 'idle', error: null })
    release()
    await check
    expect(service.getStatus()).toMatchObject({ phase: 'idle', error: null })
  })

  it('does not interrupt an active download when a check is requested', async () => {
    const { adapter, service } = setup()
    await service.check()
    const { task } = adapter.startDownload()
    adapter.download = () => task
    void service.download()
    await Promise.resolve()
    const status = await service.check()
    expect(adapter.checks).toBe(1)
    expect(status.phase).toBe('downloading')
    // A repeated update-available event must not demote the download.
    adapter.triggerAvailable(info)
    expect(service.getStatus()).toMatchObject({ phase: 'downloading', version: '0.2.0' })
  })

  it('reports a failed download as an error', async () => {
    const { adapter, service } = setup()
    await service.check()
    adapter.downloadError = new Error('disk full')
    const status = await service.download()
    expect(status.phase).toBe('error')
    expect(status.error).toContain('disk full')
  })

  it('keeps the automatic check timer off once the option is disabled', async () => {
    vi.useFakeTimers()
    try {
      const { adapter, service, preferences } = setup({ preferences: { autoCheck: true } })
      service.start()
      preferences.autoCheck = false
      service.refreshPreferences()
      await vi.advanceTimersByTimeAsync(5000)
      expect(adapter.checks).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores late events from a cancelled download', async () => {
    const { adapter, service, preferences } = setup()
    await service.check()
    const { task } = adapter.startDownload()
    adapter.download = () => task
    const downloading = service.download()
    await Promise.resolve()

    preferences.channel = 'beta'
    service.refreshPreferences()
    expect(service.getStatus().phase).toBe('idle')

    adapter.triggerProgress({ percent: 90, transferred: 900, total: 1000, bytesPerSecond: 10 })
    adapter.triggerDownloaded(info)
    adapter.triggerError(new Error('cancelled download failed'))
    const status = service.getStatus()
    expect(status).toMatchObject({ phase: 'idle', channel: 'beta', version: null, error: null, progress: null })
    await downloading
  })

  it('leaves the checking phase when the channel changes mid-check', async () => {
    const { adapter, service, preferences } = setup()
    const release = adapter.holdCheck()
    const check = service.check()
    expect(service.getStatus().phase).toBe('checking')
    preferences.channel = 'beta'
    service.refreshPreferences()
    expect(service.getStatus().phase).toBe('idle')
    release()
    const settled = await check
    expect(settled.phase).toBe('idle')
  })

  it('stops at available when automatic updates are disabled', async () => {
    const { adapter, service } = setup({ preferences: { autoCheck: false } })
    await service.check()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(adapter.downloads).toBe(0)
    expect(service.getStatus().phase).toBe('available')
  })

  it('can start a fresh download after a cancelled one is detached', async () => {
    const { adapter, service, preferences } = setup()
    await service.check()
    const first = adapter.startDownload()
    adapter.download = () => first.task
    void service.download()
    await Promise.resolve()
    preferences.channel = 'beta'
    service.refreshPreferences()
    expect(service.getStatus().phase).toBe('idle')

    adapter.download = () => adapter.emittingTask()
    preferences.channel = 'stable'
    service.refreshPreferences()
    await service.check()
    const status = await service.download()
    expect(status.phase).toBe('ready')
  })

  it('resets a stale offer when the channel changes', async () => {
    const { service, preferences } = setup()
    await service.check()
    expect(service.getStatus().phase).toBe('available')
    preferences.channel = 'beta'
    service.refreshPreferences()
    expect(service.getStatus()).toMatchObject({ phase: 'idle', channel: 'beta', version: null })
  })

  it('ignores a prerelease offer on the stable channel', async () => {
    const { adapter, service } = setup()
    adapter.checkResult = { ...info, version: '0.2.0-beta.1' }
    const status = await service.check()
    expect(status.phase).toBe('idle')
    expect(status.version).toBeNull()
  })

  it('cancels an in-flight download when the channel changes', async () => {
    const { adapter, service, preferences } = setup()
    await service.check()
    const { task } = adapter.startDownload()
    adapter.download = () => task
    const downloading = service.download()
    await Promise.resolve()
    expect(service.getStatus().phase).toBe('downloading')

    preferences.channel = 'beta'
    service.refreshPreferences()
    expect(service.getStatus()).toMatchObject({ phase: 'idle', channel: 'beta' })

    const settled = await downloading
    expect(settled.phase).toBe('idle')
    expect(settled.error).toBeNull()
  })

  it('coalesces concurrent checks into one request', async () => {
    const { adapter, service } = setup()
    const release = adapter.holdCheck()
    const first = service.check()
    const second = service.check()
    release()
    const [a, b] = await Promise.all([first, second])
    expect(adapter.checks).toBe(1)
    expect(a.phase).toBe('available')
    expect(b.phase).toBe('available')
  })

  it('schedules one automatic check after launch and can be stopped', async () => {
    vi.useFakeTimers()
    try {
      const { adapter, service } = setup({ preferences: { autoCheck: true } })
      service.start()
      service.start()
      await vi.advanceTimersByTimeAsync(999)
      expect(adapter.checks).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(adapter.checks).toBe(1)
      service.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(adapter.checks).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not schedule checks when automatic checks are off or unsupported', async () => {
    vi.useFakeTimers()
    try {
      const off = setup({ preferences: { autoCheck: false } })
      off.service.start()
      const unsupported = setup({
        preferences: { autoCheck: true },
        environment: { platform: 'linux', isPackaged: true }
      })
      unsupported.service.start()
      await vi.advanceTimersByTimeAsync(5000)
      expect(off.adapter.checks).toBe(0)
      expect(unsupported.adapter.checks).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits a snapshot on each transition without sharing mutable progress', async () => {
    const { service, seen } = setup()
    await service.check()
    const available = seen.find((status) => status.phase === 'available')
    expect(available).toBeDefined()
    await service.download()
    const phases = seen.map((status) => status.phase)
    expect(phases).toContain('checking')
    expect(phases).toContain('available')
    expect(phases).toContain('downloading')
    expect(phases).toContain('ready')
    expect(available?.version).toBe('0.2.0')
    expect(available?.progress).toBeNull()
  })
})
