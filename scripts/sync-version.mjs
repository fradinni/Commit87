#!/usr/bin/env node
/**
 * Keeps the app version in one place: package.json.
 * Rewrites package-lock.json, src/main/version.ts, snapcraft.yaml and the Flatpak
 * metainfo release.
 *
 *   node scripts/sync-version.mjs [version]
 *
 * Resolves the single release version, channel and draft/prerelease flags that a
 * tag push or a manual release run must use, without rewriting anything:
 *
 *   node scripts/sync-version.mjs --resolve --tag v0.2.0-beta.6 --github-output
 *
 * With `--github-output` the values are appended to `$GITHUB_OUTPUT` (step
 * outputs); otherwise the resolution is printed as JSON.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Only two channels exist: stable tags feed `latest*` metadata, and `-beta.N`
// tags feed `beta*`. Any other prerelease identifier would publish a channel no
// client asks for, so it is rejected before a release is prepared.
const SUPPORTED_PRERELEASE = /^\d+\.\d+\.\d+-beta\.\d+$/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @param {string} version
 * @returns {{ version: string, baseVersion: string, prerelease: string | null, channel: 'latest' | 'beta' }}
 */
export function parseReleaseVersion(version) {
  const base = /^(\d+\.\d+\.\d+)(?:-(.+))?$/.exec(version)
  if (base === null) {
    throw new Error(`Invalid semver: ${version}`)
  }
  const prerelease = base[2] ?? null
  if (prerelease !== null && !SUPPORTED_PRERELEASE.test(version)) {
    throw new Error(
      `Unsupported prerelease: ${version}. Only "-beta.N" prereleases are published, ` +
        'because stable clients only follow latest* and prereleases only follow beta*.'
    )
  }
  return {
    version,
    baseVersion: base[1],
    prerelease,
    channel: prerelease === null ? 'latest' : 'beta'
  }
}

/**
 * Resolves the version, tag, channel, prerelease and draft flags for one release
 * run. A tag push takes its version from the tag; a manual run takes the
 * checked-out package version.
 *
 * @param {{ tag?: string | null, version?: string | null, draft?: string | boolean | null }} input
 * @returns {{
 *   version: string,
 *   tag: string,
 *   channel: 'latest' | 'beta',
 *   prerelease: boolean,
 *   draft: boolean,
 * }}
 */
export function resolveRelease(input = {}) {
  const rawTag = typeof input.tag === 'string' && input.tag.trim() !== '' ? input.tag.trim() : null
  const rawVersion = typeof input.version === 'string' && input.version.trim() !== '' ? input.version.trim() : null

  let version
  if (rawTag !== null) {
    const tagVersion = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(rawTag)
    if (tagVersion === null) {
      throw new Error(`Unsupported release tag: ${rawTag}. Expected "v<major>.<minor>.<patch>" or "v<...>-beta.<n>".`)
    }
    version = tagVersion[1]
    if (rawVersion !== null && rawVersion !== version) {
      throw new Error(`Tag ${rawTag} does not match version ${rawVersion}; they must agree.`)
    }
  } else if (rawVersion !== null) {
    version = rawVersion
  } else {
    version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
  }

  const parsed = parseReleaseVersion(version)
  const prerelease = parsed.channel === 'beta'

  // A tag push mirrors the existing tag rules: stable tags stay drafts until a
  // maintainer publishes them, prereleases publish directly as pre-releases.
  // A manual run honours its `draft` input, defaulting to a draft.
  let draft = !prerelease
  if (input.draft !== undefined && input.draft !== null && input.draft !== '') {
    const raw = typeof input.draft === 'boolean' ? String(input.draft) : input.draft.trim().toLowerCase()
    if (raw !== 'true' && raw !== 'false') {
      throw new Error(`Invalid draft input: ${String(input.draft)}. Expected true or false.`)
    }
    draft = raw === 'true'
  }

  return { version, tag: `v${version}`, channel: parsed.channel, prerelease, draft }
}

/**
 * Rewrites every version file from one version. Returns the rewritten paths.
 *
 * @param {string} [requestedVersion]
 * @returns {string[]}
 */
export function syncVersion(requestedVersion) {
  const pkgPath = path.join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const version = requestedVersion ?? pkg.version

  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid semver: ${version}`)
  }

  const written = []
  // Read every file before writing any, so a missing lockfile cannot leave
  // package.json bumped while the rest of the tree is untouched.
  const lockPath = path.join(root, 'package-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))

  if (version !== pkg.version) {
    pkg.version = version
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    written.push(pkgPath)
  }

  // The lockfile carries the root version twice; leaving it behind used to need
  // a manual `npm install --package-lock-only` on every release.
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    lock.version = version
    if (lock.packages?.[''] !== undefined) {
      lock.packages[''].version = version
    }
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
    written.push(lockPath)
  }

  const versionFile = path.join(root, 'src/main/version.ts')
  writeFileSync(
    versionFile,
    `// Generated by scripts/sync-version.mjs — do not edit by hand.\nexport const APP_VERSION = '${version}'\nexport const APP_NAME = 'Commit87'\n`
  )
  written.push(versionFile)

  const snapPath = path.join(root, 'snap/snapcraft.yaml')
  const snap = readFileSync(snapPath, 'utf8').replace(/^version: .*$/m, `version: '${version}'`)
  writeFileSync(snapPath, snap)
  written.push(snapPath)

  const metaPath = path.join(root, 'flatpak/fr.fradinni.Commit87.metainfo.xml')
  const originalMeta = readFileSync(metaPath, 'utf8')
  let meta = originalMeta
  // AppStream orders releases by version and ranks a prerelease above its own
  // stable release (`0.2.0-beta.10` > `0.2.0`), so keeping the betas a stable
  // release followed fails `appstreamcli validate` with "releases-not-in-order".
  // Prereleases are not distributed through AppStream metadata, so a stable
  // release drops them; re-running this script heals an already-dirty file.
  if (!version.includes('-')) {
    meta = meta.replace(/\s*<release version="[^"]*-[^"]*"[\s\S]*?<\/release>/g, '')
  }
  if (!meta.includes(`version="${version}"`)) {
    const today = new Date().toISOString().slice(0, 10)
    meta = meta.replace(
      /<releases>/,
      `<releases>\n    <release version="${version}" date="${today}">\n      <description>\n        <p>See the changelog for details.</p>\n      </description>\n    </release>`
    )
  }
  if (meta !== originalMeta) {
    writeFileSync(metaPath, meta)
    written.push(metaPath)
  }

  return written
}

function parseFlags(args) {
  const flags = { resolve: false, githubOutput: false, tag: null, version: null, draft: null }
  const positional = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    switch (arg) {
      case '--resolve':
        flags.resolve = true
        break
      case '--github-output':
        flags.githubOutput = true
        flags.resolve = true
        break
      case '--tag':
        flags.tag = args[index + 1] ?? ''
        index += 1
        break
      case '--version':
        flags.version = args[index + 1] ?? ''
        index += 1
        break
      case '--draft':
        flags.draft = args[index + 1] ?? ''
        index += 1
        break
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option: ${arg}`)
        }
        positional.push(arg)
    }
  }
  if (positional.length > 1) {
    throw new Error(`Expected at most one version argument, got: ${positional.join(' ')}`)
  }
  flags.version = positional[0] ?? flags.version
  return flags
}

function writeGithubOutput(release) {
  const outputFile = process.env.GITHUB_OUTPUT
  if (outputFile === undefined || outputFile === '') {
    throw new Error('--github-output requires the GITHUB_OUTPUT environment variable')
  }
  const lines = Object.entries(release).map(([key, value]) => `${key}=${String(value)}`)
  appendFileSync(outputFile, `${lines.join('\n')}\n`)
  console.log(lines.join('\n'))
}

function isEntryPoint() {
  const entry = process.argv[1]
  if (entry === undefined) {
    return false
  }
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  try {
    const flags = parseFlags(process.argv.slice(2))
    if (flags.resolve) {
      const release = resolveRelease({ tag: flags.tag, version: flags.version, draft: flags.draft })
      if (flags.githubOutput) {
        writeGithubOutput(release)
      } else {
        console.log(JSON.stringify(release, null, 2))
      }
    } else {
      const written = syncVersion(flags.version ?? undefined)
      const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
      console.log(`version synced: ${pkgVersion}`)
      console.log(`rewritten: ${written.map((file) => path.relative(root, file)).join(', ')}`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
