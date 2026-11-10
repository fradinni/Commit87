import { readFileSync, realpathSync, statSync } from 'node:fs'
import process from 'node:process'

/**
 * Facts that establish which AppImage is the running installation.
 *
 * `APPIMAGE` (and `APPDIR`) are environment hints that an inherited launcher
 * can set to anything. Ownership is established instead from the kernel mount
 * table: the running executable must live inside an AppImage/squashfs mount
 * whose source is the image named by `APPIMAGE`. A path, filename, owner or
 * magic header on its own proves nothing.
 */
export interface AppImageProbe {
  env(name: string): string | undefined
  realpath(path: string): string
  readFile(path: string): string
  stat(path: string): {
    dev: number
    ino: number
    size: number
    mtimeMs: number
    mode: number
    isFile(): boolean
  }
  execPath: string
  platform: NodeJS.Platform
}

/**
 * The bound replacement target. The file identity (dev/ino/size/mtimeMs/mode)
 * and the mount facts are retained so they can be recomputed immediately before
 * downloading and again immediately before installing.
 */
export interface VerifiedAppImage {
  /** Canonical path of the running image; the file that may be replaced. */
  imagePath: string
  dev: number
  ino: number
  size: number
  mtimeMs: number
  mode: number
  /** Canonical mount point that contains the running executable. */
  mountPoint: string
  /** Canonical source recorded by the kernel for that mount. */
  mountSource: string
  /** Kernel filesystem type of the mount, for example `squashfs`. */
  filesystem: string
}

export type VerifyAppImageResult = { ok: true; target: VerifiedAppImage } | { ok: false; reason: string }
export type RevalidateAppImageResult = { ok: true } | { ok: false; reason: string }

interface MountInfoEntry {
  mountPoint: string
  filesystem: string
  source: string
}

const MOUNTINFO_PATH = '/proc/self/mountinfo'
const MOUNTINFO_ESCAPE = /\\([0-7]{3})/g

const NOT_MOUNTED_REASON =
  'This build is not running from a mounted AppImage, so it cannot replace itself in place. Unpacked or extracted copies must be updated by downloading the next release.'

/** mountinfo escapes spaces, tabs, newlines and backslashes as three octal digits. */
export function decodeMountInfoPath(value: string): string {
  return value.replace(MOUNTINFO_ESCAPE, (_match: string, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  )
}

function parseMountInfo(contents: string): MountInfoEntry[] {
  const entries: MountInfoEntry[] = []
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue
    const fields = line.split(' ')
    if (fields.length < 9) continue
    // Optional fields end at the first '-' separator; the filesystem type and
    // mount source follow it.
    const separator = fields.indexOf('-', 6)
    if (separator < 0 || separator + 2 >= fields.length) continue
    entries.push({
      mountPoint: decodeMountInfoPath(fields[4]),
      filesystem: fields[separator + 1],
      source: decodeMountInfoPath(fields[separator + 2])
    })
  }
  return entries
}

/**
 * AppImage type 2 images are squashfs mounts, either through the kernel driver
 * (`squashfs`) or a FUSE helper (`fuse.squashfuse`, `fuse.appimage`, …).
 */
function isAppImageFilesystem(filesystem: string): boolean {
  const type = filesystem.toLowerCase()
  if (type === 'squashfs') return true
  if (!type.startsWith('fuse.')) return false
  return type.includes('squash') || type.includes('appimage')
}

function containsPath(parent: string, child: string): boolean {
  if (parent === child) return true
  const prefix = parent.endsWith('/') ? parent : `${parent}/`
  return child.startsWith(prefix)
}

function canonical(probe: AppImageProbe, value: string): string | null {
  try {
    return probe.realpath(value)
  } catch {
    return null
  }
}

function statFile(probe: AppImageProbe, value: string): ReturnType<AppImageProbe['stat']> | null {
  try {
    return probe.stat(value)
  } catch {
    return null
  }
}

function executableFileReason(stat: ReturnType<AppImageProbe['stat']>, label: string): string | null {
  if (!stat.isFile()) return `${label} is not a regular file.`
  if ((stat.mode & 0o111) === 0) return `${label} is not executable.`
  return null
}

/**
 * Verify that the indicated AppImage is the installation this process runs
 * from. Fails closed for unpacked/extracted launches, Snap/Flatpak sandboxes,
 * loop-mounted ISOs and any hint that does not match the kernel mount source.
 */
export function verifyAppImage(probe: AppImageProbe): VerifyAppImageResult {
  if (probe.platform !== 'linux') {
    return { ok: false, reason: 'AppImage updates are only supported on Linux.' }
  }
  const hinted = probe.env('APPIMAGE')
  if (!hinted) {
    return { ok: false, reason: NOT_MOUNTED_REASON }
  }
  if (hinted.includes('\u0000')) {
    return { ok: false, reason: 'The AppImage path contains a NUL byte.' }
  }
  if (!hinted.startsWith('/')) {
    return { ok: false, reason: 'The AppImage path is not absolute.' }
  }
  const imagePath = canonical(probe, hinted)
  if (!imagePath) {
    return { ok: false, reason: 'The AppImage path does not resolve to a file.' }
  }
  const imageStat = statFile(probe, imagePath)
  if (!imageStat) {
    return { ok: false, reason: 'The AppImage file is not available.' }
  }
  const imageProblem = executableFileReason(imageStat, 'The AppImage')
  if (imageProblem) return { ok: false, reason: imageProblem }

  const execPath = canonical(probe, probe.execPath)
  if (!execPath) {
    return { ok: false, reason: 'The running executable path does not resolve.' }
  }

  let mountInfoContents: string
  try {
    mountInfoContents = probe.readFile(MOUNTINFO_PATH)
  } catch {
    return { ok: false, reason: 'The process mount table is not readable, so the AppImage cannot be verified.' }
  }
  const mounts = parseMountInfo(mountInfoContents).filter((entry) => isAppImageFilesystem(entry.filesystem))
  if (mounts.length === 0) {
    return { ok: false, reason: NOT_MOUNTED_REASON }
  }

  let sawContainingMount = false
  for (const entry of mounts) {
    const mountPoint = canonical(probe, entry.mountPoint)
    if (!mountPoint) continue
    if (!containsPath(mountPoint, execPath)) continue
    sawContainingMount = true
    const source = canonical(probe, entry.source)
    if (!source) continue
    if (source !== imagePath) continue
    return {
      ok: true,
      target: {
        imagePath,
        dev: imageStat.dev,
        ino: imageStat.ino,
        size: imageStat.size,
        mtimeMs: imageStat.mtimeMs,
        mode: imageStat.mode,
        mountPoint,
        mountSource: source,
        filesystem: entry.filesystem
      }
    }
  }
  if (!sawContainingMount) {
    return {
      ok: false,
      reason: 'The running executable is outside every AppImage mount point, so the update target cannot be trusted.'
    }
  }
  return {
    ok: false,
    reason: 'The APPIMAGE hint does not identify the image mounted for this process.'
  }
}

/**
 * Recompute the verified facts. Any change to the file identity, to the mount
 * point containing the executable, or to the mount source is a hard failure.
 */
export function revalidateAppImage(probe: AppImageProbe, target: VerifiedAppImage): RevalidateAppImageResult {
  if (probe.platform !== 'linux') {
    return { ok: false, reason: 'AppImage updates are only supported on Linux.' }
  }
  const imageStat = statFile(probe, target.imagePath)
  if (!imageStat) {
    return { ok: false, reason: 'The AppImage update target is no longer available.' }
  }
  const imageProblem = executableFileReason(imageStat, 'The AppImage update target')
  if (imageProblem) return { ok: false, reason: imageProblem }
  if (
    imageStat.dev !== target.dev ||
    imageStat.ino !== target.ino ||
    imageStat.size !== target.size ||
    imageStat.mtimeMs !== target.mtimeMs
  ) {
    return { ok: false, reason: 'The AppImage update target has been replaced or modified since it was verified.' }
  }

  const execPath = canonical(probe, probe.execPath)
  if (!execPath) {
    return { ok: false, reason: 'The running executable path does not resolve.' }
  }
  let mountInfoContents: string
  try {
    mountInfoContents = probe.readFile(MOUNTINFO_PATH)
  } catch {
    return { ok: false, reason: 'The process mount table is not readable, so the AppImage cannot be revalidated.' }
  }
  const mounts = parseMountInfo(mountInfoContents).filter((entry) => isAppImageFilesystem(entry.filesystem))
  for (const entry of mounts) {
    const mountPoint = canonical(probe, entry.mountPoint)
    if (!mountPoint || mountPoint !== target.mountPoint) continue
    if (!containsPath(mountPoint, execPath)) {
      return {
        ok: false,
        reason: 'The running executable is no longer inside the verified AppImage mount point.'
      }
    }
    const source = canonical(probe, entry.source)
    if (!source || source !== target.mountSource || source !== target.imagePath) {
      return { ok: false, reason: 'The AppImage mount source no longer matches the verified update target.' }
    }
    return { ok: true }
  }
  return { ok: false, reason: 'The AppImage mount for this process is no longer present.' }
}

/** Production probe: reads the real environment, filesystem and mount table. */
export function createAppImageProbe(): AppImageProbe {
  return {
    env: (name) => process.env[name],
    realpath: (path) => realpathSync(path),
    readFile: (path) => readFileSync(path, 'utf8'),
    stat: (path) => statSync(path),
    execPath: process.execPath,
    platform: process.platform
  }
}
