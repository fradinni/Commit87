import { describe, expect, it } from 'vitest'
import {
  isVersionNewer,
  macZipAssetName,
  normalizeVersion,
  parseSha256Sums,
  parseVersion,
  pickRelease,
  sha256Hex
} from '../src/main/update-feed'
import type { ApiRelease } from '../src/main/update-feed'

const ZIP = 'https://github.com/fradinni/Commit87/releases/download'

function assetsFor(version: string): ApiRelease['assets'] {
  return [
    { name: `Commit87-${version}-mac-arm64.zip`, browser_download_url: `${ZIP}/v${version}/a.zip` },
    { name: `Commit87-${version}-mac-x64.zip`, browser_download_url: `${ZIP}/v${version}/x.zip` },
    { name: `Commit87-${version}-mac-arm64.zip.blockmap`, browser_download_url: `${ZIP}/v${version}/a.bm` }
  ]
}

function release(overrides: Partial<ApiRelease> = {}): ApiRelease {
  return {
    tag_name: 'v0.2.0-beta.9',
    draft: false,
    prerelease: true,
    published_at: '2026-11-11T10:00:00Z',
    body: 'Release notes',
    assets: assetsFor('0.2.0-beta.9'),
    ...overrides
  }
}

describe('release feed helpers', () => {
  it('normalizes a leading v from tag names', () => {
    expect(normalizeVersion('v0.2.0-beta.9')).toBe('0.2.0-beta.9')
    expect(normalizeVersion('0.2.0')).toBe('0.2.0')
  })

  it('builds the exact artifact name electron-builder publishes', () => {
    expect(macZipAssetName('0.2.0-beta.9', 'arm64')).toBe('Commit87-0.2.0-beta.9-mac-arm64.zip')
    expect(macZipAssetName('0.2.1', 'x64')).toBe('Commit87-0.2.1-mac-x64.zip')
  })

  it('picks the newest release that matches the channel and architecture', () => {
    const candidate = pickRelease([release()], 'arm64', 'beta')
    expect(candidate).toEqual({
      version: '0.2.0-beta.9',
      tag: 'v0.2.0-beta.9',
      zipAsset: 'Commit87-0.2.0-beta.9-mac-arm64.zip',
      zipUrl: `${ZIP}/v0.2.0-beta.9/a.zip`,
      publishedAt: '2026-11-11T10:00:00Z',
      notes: 'Release notes'
    })
  })

  it('keeps prereleases off the stable channel', () => {
    expect(pickRelease([release()], 'arm64', 'stable')).toBeNull()
  })

  it('picks the x64 build when only that architecture is requested', () => {
    const candidate = pickRelease([release()], 'x64', 'beta')
    expect(candidate?.zipAsset).toBe('Commit87-0.2.0-beta.9-mac-x64.zip')
    expect(pickRelease([release({ assets: [] })], 'arm64', 'beta')).toBeNull()
  })

  it('skips drafts and takes the newest non-draft release', () => {
    const first = release({ tag_name: 'v0.2.0-beta.10', assets: assetsFor('0.2.0-beta.10') })
    const second = release({ tag_name: 'v0.2.0-beta.9' })
    expect(pickRelease([first, second], 'arm64', 'beta')?.version).toBe('0.2.0-beta.10')

    const draft = release({ tag_name: 'v0.2.0-beta.10', draft: true, assets: assetsFor('0.2.0-beta.10') })
    expect(pickRelease([draft, second], 'arm64', 'beta')?.version).toBe('0.2.0-beta.9')
  })

  it('chooses the highest matching version regardless of API order', () => {
    // The API sorts by creation time, so a backport created after a newer
    // release appears first; taking the first match would hide the newer one.
    const backport = release({ tag_name: 'v0.2.1', prerelease: false, assets: assetsFor('0.2.1') })
    const newer = release({ tag_name: 'v0.3.0', prerelease: false, assets: assetsFor('0.3.0') })
    expect(pickRelease([backport, newer], 'arm64', 'stable')?.version).toBe('0.3.0')
  })

  it('ignores tags this project never publishes', () => {
    const odd = release({ tag_name: 'nightly', assets: assetsFor('nightly') })
    const stable = release({ tag_name: 'v0.3.0', prerelease: false, assets: assetsFor('0.3.0') })
    expect(pickRelease([odd, stable], 'arm64', 'stable')?.version).toBe('0.3.0')
  })

  it('returns null when no release matches', () => {
    expect(pickRelease([], 'arm64', 'beta')).toBeNull()
    expect(
      pickRelease(
        [release({ tag_name: 'v0.2.1', assets: [{ name: 'Commit87-0.2.1-linux-x86_64.AppImage', browser_download_url: 'u' }] })],
        'arm64',
        'beta'
      )
    ).toBeNull()
  })
})

describe('version comparison', () => {
  it('parses stable and beta versions', () => {
    expect(parseVersion('0.2.0')).toEqual({ major: 0, minor: 2, patch: 0, beta: null })
    expect(parseVersion('0.2.0-beta.9')).toEqual({ major: 0, minor: 2, patch: 0, beta: 9 })
  })

  it('rejects versions this project never publishes', () => {
    expect(() => parseVersion('0.2')).toThrow()
    expect(() => parseVersion('0.2.0-alpha.1')).toThrow()
    expect(() => parseVersion('beta')).toThrow()
  })

  it('orders stable above any beta of the same version', () => {
    expect(isVersionNewer('0.2.0', '0.2.0-beta.9')).toBe(true)
    expect(isVersionNewer('0.2.0-beta.9', '0.2.0')).toBe(false)
  })

  it('orders beta counters and components', () => {
    expect(isVersionNewer('0.2.0-beta.10', '0.2.0-beta.9')).toBe(true)
    expect(isVersionNewer('0.2.1', '0.2.0-beta.99')).toBe(true)
    expect(isVersionNewer('0.3.0', '0.2.99')).toBe(true)
    expect(isVersionNewer('0.2.0-beta.9', '0.2.0-beta.9')).toBe(false)
    expect(isVersionNewer('0.2.0', '0.2.0')).toBe(false)
  })
})

describe('checksum helpers', () => {
  it('hashes a known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('parses shasum output with text and binary markers', () => {
    const sums = parseSha256Sums(
      `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  Commit87-0.2.0-mac-arm64.zip
f0000000000000000000000000000000000000000000000000000000000000f0  Commit87-0.2.0-mac-x64.zip
ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad *Commit87-0.2.1-mac-arm64.zip
abc123  Commit87-too-short.zip
not a sum
`
    )
    expect(sums.get('Commit87-0.2.0-mac-arm64.zip')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sums.get('Commit87-0.2.0-mac-x64.zip')).toBe('f0000000000000000000000000000000000000000000000000000000000000f0')
    expect(sums.get('Commit87-0.2.1-mac-arm64.zip')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sums.get('Commit87-too-short.zip')).toBeUndefined()
    expect(sums.get('not a sum')).toBeUndefined()
  })

  it('matches case-insensitively on the hex side', () => {
    const sums = parseSha256Sums('BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD  a.zip\n')
    expect(sums.get('a.zip')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})