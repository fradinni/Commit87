import { createHash } from 'node:crypto'
import type { UpdateChannel } from '@shared/types'
import { versionMatchesChannel } from './updates'

/**
 * Subset of the GitHub releases API payload the updater reads. Draft releases
 * are included in the JSON for authenticated requests but are always refused.
 */
export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

export interface ApiRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  published_at: string | null
  body: string | null
  assets: ReleaseAsset[]
}

/** A release that carries the zip for this architecture and channel. */
export interface ReleaseCandidate {
  /** Version without the leading `v` the tag carries. */
  version: string
  /** The release tag, kept verbatim for the download URL. */
  tag: string
  zipAsset: string
  zipUrl: string
  publishedAt: string | null
  notes: string | null
}

export function normalizeVersion(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag
}

/**
 * The asset electron-builder produces for every macOS release:
 * `${productName}-${version}-${os}-${arch}.zip` where version excludes any
 * leading `v`, so an exact name can be matched without a pattern.
 */
export function macZipAssetName(version: string, arch: 'arm64' | 'x64'): string {
  return `Commit87-${version}-mac-${arch}.zip`
}

/**
 * Highest release that is not a draft, belongs to the requested channel and
 * carries the zip for this architecture. The API sorts by creation time, which
 * is not semantic-version order: a backport published after a newer release
 * can appear first, so every matching release is compared instead of taking
 * the first one.
 */
export function pickRelease(
  releases: readonly ApiRelease[],
  arch: 'arm64' | 'x64',
  channel: UpdateChannel
): ReleaseCandidate | null {
  let best: ReleaseCandidate | null = null
  for (const release of releases) {
    if (release.draft) continue
    const version = normalizeVersion(release.tag_name)
    if (!versionMatchesChannel(version, channel)) continue
    try {
      parseVersion(version)
    } catch {
      // Ignore tags this project never publishes rather than failing the check.
      continue
    }
    if (best && !isVersionNewer(version, best.version)) continue
    const name = macZipAssetName(version, arch)
    const asset = release.assets.find((entry) => entry.name === name)
    if (!asset) continue
    best = {
      version: version,
      tag: release.tag_name,
      zipAsset: name,
      zipUrl: asset.browser_download_url,
      publishedAt: release.published_at,
      notes: release.body
    }
  }
  return best
}

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Null for a stable release; the beta counter for `x.y.z-beta.N`. */
  beta: number | null
}

/**
 * Strict parse of the only version shapes this project publishes
 * (`x.y.z` and `x.y.z-beta.N`). Releases are created from `package.json`, so a
 * malformed version is a build error, not a runtime condition to paper over.
 */
export function parseVersion(version: string): ParsedVersion {
  const [core, prerelease] = version.split('-', 2)
  const [major, minor, patch] = core.split('.').map((part) => Number.parseInt(part, 10))
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    throw new Error(`Invalid version "${version}"`)
  }
  if (prerelease !== undefined) {
    if (!prerelease.startsWith('beta.')) throw new Error(`Invalid prerelease "${version}"`)
    const beta = Number.parseInt(prerelease.slice('beta.'.length), 10)
    if (!Number.isInteger(beta)) throw new Error(`Invalid prerelease "${version}"`)
    return { major, minor, patch, beta }
  }
  return { major, minor, patch, beta: null }
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  // A stable release is newer than any prerelease of the same version; between
  // prereleases only the counter decides. This mirrors how the feed treats a
  // beta-promoted tag: 0.2.0 > 0.2.0-beta.9 > 0.2.0-beta.8.
  if (a.beta === null && b.beta !== null) return 1
  if (a.beta !== null && b.beta === null) return -1
  if (a.beta !== null && b.beta !== null && a.beta !== b.beta) return a.beta < b.beta ? -1 : 1
  return 0
}

/** Whether `a` sorts strictly after `b`. */
export function isVersionNewer(a: string, b: string): boolean {
  return compareParsed(parseVersion(a), parseVersion(b)) > 0
}

/** SHA-256 hex digest, kept next to the parse helpers for the checksum gate. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Parse the `SHA256SUMS.txt` the release workflow publishes. Each line is
 * `<hex sha256>  <file name>`; shasum may prefix binary-mode names with `*`,
 * which is stripped so lookups match the plain asset name.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i)
    if (match) sums.set(match[2], match[1].toLowerCase())
  }
  return sums
}