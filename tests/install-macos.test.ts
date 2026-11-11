import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/install-macos.sh')
const roots: string[] = []

// Every side-effecting macOS command is replaced. PATH contains only these
// stubs and an explicit allowlist of filesystem tools: no real process lookup,
// app termination, network access, signature mutation or launch can occur.
const COMMAND_STUB = String.raw`const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const env = process.env
const command = path.basename(process.argv[2])
const args = process.argv.slice(3)
const marker = (app) => {
  try { return fs.readFileSync(path.join(app, 'Contents', 'marker.txt'), 'utf8') } catch { return '' }
}
fs.appendFileSync(env.TEST_LOG, [command, marker(env.TEST_TARGET), ...args].join('\t') + '\n')
const real = (file) => {
  const result = spawnSync(file, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
switch (command) {
  case 'uname':
    console.log('arm64')
    break
  case 'date':
    console.log('1700000000')
    break
  case 'curl': {
    if (env.TEST_OFFLINE === '1') process.exit(22)
    const url = args.at(-1)
    if (url.includes('api.github.com')) {
      if (env.TEST_RELEASES) {
        console.log(fs.readFileSync(env.TEST_RELEASES, 'utf8'))
      } else {
        console.log(JSON.stringify([{ tag_name: 'v' + env.TEST_VERSION, assets: [] }]))
      }
      break
    }
    const output = args[args.indexOf('-o') + 1]
    fs.copyFileSync(url.endsWith('SHA256SUMS.txt') ? env.TEST_SUMS : env.TEST_ARCHIVE, output)
    break
  }
  case 'python3':
    // Release JSON filtering is not under test; return the fixture's release.
    console.log(env.TEST_VERSION + '\nCommit87-' + env.TEST_VERSION + '-mac-arm64.zip\n')
    break
  case 'codesign': {
    const postSwap = args.at(-1) === env.TEST_TARGET
    if (env.TEST_SIGNATURE_FAILURE === (postSwap ? 'post' : 'stage')) process.exit(1)
    break
  }
  case 'pgrep':
    process.exit(fs.existsSync(env.TEST_RUNNING) ? 0 : 1)
    break
  case 'pkill':
    if (env.TEST_STUBBORN !== '1') fs.rmSync(env.TEST_RUNNING, { force: true })
    break
  case 'mv': {
    const [source, destination] = args
    if (source === env.TEST_TARGET && marker(source) === 'original' && env.TEST_BACKUP_FAILURE === '1') {
      process.exit(1)
    }
    if (source === env.TEST_TARGET && marker(source) === 'replacement' && env.TEST_QUARANTINE_FAILURE === '1') {
      process.exit(1)
    }
    if (destination === env.TEST_TARGET && marker(source) === 'replacement' && env.TEST_SWAP_FAILURE) {
      if (env.TEST_SWAP_FAILURE === 'partial') {
        fs.mkdirSync(path.join(destination, 'Contents'), { recursive: true })
        fs.writeFileSync(path.join(destination, 'Contents', 'marker.txt'), 'broken')
      }
      process.exit(1)
    }
    if (destination === env.TEST_TARGET && marker(source) === 'original' && env.TEST_RESTORE_FAILURE === '1') {
      process.exit(1)
    }
    real('/bin/mv')
    break
  }
  case 'ditto':
    // A fallback copy after a failed swap must not hide the injected failure.
    if (env.TEST_SWAP_FAILURE) process.exit(1)
    throw new Error('Unexpected ditto fallback: the fixture is a valid zip')
  case 'open':
  case 'osascript':
  case 'killall':
  case 'xattr':
  case 'sleep':
    break
  default:
    throw new Error('Unexpected stub command: ' + command)
}
`

interface CommandEvent {
  command: string
  targetMarker: string
  args: string[]
}

function writeBundle(app: string, version: string, marker: string): void {
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`)
  writeFileSync(path.join(app, 'Contents', 'marker.txt'), marker)
  writeFileSync(path.join(app, 'Contents', 'MacOS', 'Commit87'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
}

function releaseInfo(
  version: string,
  options: { draft?: boolean; prerelease?: boolean; arches?: string[] } = {},
): Record<string, unknown> {
  const prerelease = options.prerelease ?? version.includes('-')
  const arches = options.arches ?? ['arm64', 'x64']
  return {
    tag_name: `v${version}`,
    draft: options.draft ?? false,
    prerelease,
    published_at: '2026-11-11T10:00:00Z',
    assets: arches.map((arch) => ({
      name: `Commit87-${version}-mac-${arch}.zip`,
      browser_download_url: `https://example.invalid/Commit87-${version}-mac-${arch}.zip`,
    })),
  }
}

function createFixture(
  installedVersion: string | null = '0.1.0',
  version = '0.2.0',
  options: { realPython?: boolean; releases?: unknown[] } = {},
) {
  const approvedTemp = path.join(tmpdir(), 'opencode')
  const root = mkdtempSync(path.join(existsSync(approvedTemp) ? approvedTemp : tmpdir(), 'commit87 installer-'))
  roots.push(root)
  const bin = path.join(root, 'bin')
  const destination = path.join(root, 'Applications with spaces')
  const target = path.join(destination, 'Commit87.app')
  const temp = path.join(root, 'tmp')
  const home = path.join(root, 'home')
  const payload = path.join(root, 'payload')
  const archive = path.join(root, 'release.zip')
  const sums = path.join(root, 'SHA256SUMS.txt')
  const releases = path.join(root, 'releases.json')
  const log = path.join(root, 'commands.log')
  const running = path.join(root, 'running')
  const stub = path.join(root, 'command.cjs')
  for (const directory of [bin, destination, temp, home, payload]) mkdirSync(directory)
  writeFileSync(log, '')
  writeFileSync(stub, COMMAND_STUB)
  writeFileSync(releases, JSON.stringify(options.releases ?? []))
  for (const command of [
    'uname', 'date', 'curl', 'python3', 'codesign', 'pgrep', 'pkill', 'mv', 'ditto',
    'open', 'osascript', 'killall', 'xattr', 'sleep',
  ]) {
    if (command === 'python3' && options.realPython) continue
    const file = path.join(bin, command)
    writeFileSync(file, '#!/bin/bash\nexec "$TEST_NODE" "$TEST_STUB" "$0" "$@"\n')
    chmodSync(file, 0o755)
  }
  if (options.realPython) symlinkSync('/usr/bin/python3', path.join(bin, 'python3'))
  for (const [command, file] of Object.entries({
    awk: '/usr/bin/awk',
    dirname: '/usr/bin/dirname',
    mkdir: '/bin/mkdir',
    mktemp: '/usr/bin/mktemp',
    rm: '/bin/rm',
    rmdir: '/bin/rmdir',
    sed: '/usr/bin/sed',
    shasum: '/usr/bin/shasum',
    unzip: '/usr/bin/unzip',
  })) symlinkSync(file, path.join(bin, command))

  if (installedVersion !== null) writeBundle(target, installedVersion, 'original')
  writeBundle(path.join(payload, 'Commit87.app'), version, 'replacement')
  const zipped = spawnSync('/usr/bin/zip', ['-qr', archive, 'Commit87.app'], { cwd: payload })
  expect(zipped.error).toBeUndefined()
  expect(zipped.status).toBe(0)
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
  writeFileSync(sums, `${digest}  Commit87-${version}-mac-arm64.zip\n`)

  function events(): CommandEvent[] {
    return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const [command, targetMarker, ...args] = line.split('\t')
      return { command, targetMarker, args }
    })
  }

  function run(args: string[], overrides: Record<string, string> = {}) {
    const result = spawnSync('/bin/bash', [SCRIPT, '--to', destination, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: bin,
        HOME: home,
        TMPDIR: temp,
        LC_ALL: 'C',
        NO_COLOR: '1',
        TEST_NODE: process.execPath,
        TEST_STUB: stub,
        TEST_TARGET: target,
        TEST_LOG: log,
        TEST_RUNNING: running,
        TEST_ARCHIVE: archive,
        TEST_SUMS: sums,
        TEST_RELEASES: releases,
        TEST_VERSION: version,
        ...overrides,
      },
    })
    expect(result.error).toBeUndefined()
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  }

  function marker(app = target): string {
    return readFileSync(path.join(app, 'Contents', 'marker.txt'), 'utf8')
  }

  function expectClean(): void {
    expect(readdirSync(temp)).toEqual([])
    expect(readdirSync(destination).filter((name) => name.startsWith('.commit87-'))).toEqual([])
  }

  return { root, destination, target, temp, sums, releases, running, run, marker, events, expectClean }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The script intentionally reads plists through macOS's absolute PlistBuddy
// path. Run the real shell/filesystem suite on macOS, not a rewritten script.
describe.skipIf(process.platform !== 'darwin')('macOS installer shell regression tests', () => {
  it('verifies a complete destination-volume stage before swapping, then verifies and launches the installed app', () => {
    const fixture = createFixture()
    writeFileSync(fixture.running, '')

    const result = fixture.run(['--version', 'v0.2.0'])

    expect(result.status, result.output).toBe(0)
    expect(fixture.marker()).toBe('replacement')
    const events = fixture.events()
    const checks = events.filter((event) => event.command === 'codesign')
    expect(checks).toHaveLength(2)
    expect(path.relative(fixture.destination, checks[0].args.at(-1) ?? '')).toMatch(
      /^\.commit87-install\.[^/]+\/app\/Commit87\.app$/,
    )
    expect(checks[0].targetMarker).toBe('original')
    expect(checks[1].args.at(-1)).toBe(fixture.target)
    expect(checks[1].targetMarker).toBe('replacement')
    expect(events.findIndex((event) => event.command === 'mv')).toBeGreaterThan(events.indexOf(checks[0]))
    expect(events.findIndex((event) => event.command === 'open')).toBeGreaterThan(events.indexOf(checks[1]))
    expect(events.filter((event) => event.command === 'pkill')).toHaveLength(1)
    expect(existsSync(fixture.running)).toBe(false)
    fixture.expectClean()
  })

  it.each(['0.2.0', '0.1.0'])('explicitly installs %s even when 0.2.0 is already installed', (version) => {
    const fixture = createFixture('0.2.0', version)

    const result = fixture.run(['--version', `v${version}`])

    expect(result.status, result.output).toBe(0)
    expect(fixture.marker()).toBe('replacement')
    expect(result.output).toContain(`Installing requested Commit87 ${version}`)
    expect(fixture.events().some((event) => event.command === 'open')).toBe(true)
    fixture.expectClean()
  })

  it.each(['0.2.0', '0.3.0'])('does not implicitly replace installed %s with an equal or older release', (installed) => {
    const fixture = createFixture(installed)

    const result = fixture.run([])

    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('already the newest release')
    expect(fixture.marker()).toBe('original')
    expect(fixture.events().some((event) => ['mv', 'pkill', 'open', 'codesign'].includes(event.command))).toBe(false)
    fixture.expectClean()
  })

  it('does not disturb the current app when staged signature verification fails', () => {
    const fixture = createFixture()

    const result = fixture.run(['--version', 'v0.2.0'], { TEST_SIGNATURE_FAILURE: 'stage' })

    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('code-signature check')
    expect(fixture.marker()).toBe('original')
    expect(fixture.events().some((event) => ['mv', 'pkill', 'open'].includes(event.command))).toBe(false)
    fixture.expectClean()
  })

  it('refuses a checksum mismatch before extracting or touching the installed app', () => {
    const fixture = createFixture()
    writeFileSync(fixture.sums, `${'0'.repeat(64)}  Commit87-0.2.0-mac-arm64.zip\n`)

    const result = fixture.run(['--version', 'v0.2.0'])

    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('checksum mismatch')
    expect(fixture.marker()).toBe('original')
    expect(fixture.events().some((event) => ['mv', 'codesign', 'open'].includes(event.command))).toBe(false)
    fixture.expectClean()
  })

  it.each(['empty', 'partial'])('restores the old app after a failed swap with a(n) %s target', (failure) => {
    const fixture = createFixture()

    const result = fixture.run(['--version', 'v0.2.0'], { TEST_SWAP_FAILURE: failure })

    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('Restored the previous Commit87')
    expect(fixture.marker()).toBe('original')
    expect(existsSync(path.join(fixture.target, 'Commit87.app'))).toBe(false)
    expect(fixture.events().some((event) => event.command === 'open')).toBe(false)
    fixture.expectClean()
  })

  it('leaves the original app in place if moving it to the backup fails', () => {
    const fixture = createFixture()

    const result = fixture.run(['--version', 'v0.2.0'], { TEST_BACKUP_FAILURE: '1' })

    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('could not move aside the current Commit87')
    expect(fixture.marker()).toBe('original')
    expect(fixture.events().filter((event) => event.command === 'mv')).toHaveLength(1)
    expect(fixture.events().some((event) => event.command === 'open')).toBe(false)
    fixture.expectClean()
  })

  it('restores the old app instead of nesting it inside a replacement that fails its post-swap signature check', () => {
    const fixture = createFixture()

    const result = fixture.run(['--version', 'v0.2.0'], { TEST_SIGNATURE_FAILURE: 'post' })

    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('installed Commit87 failed its code-signature check')
    expect(fixture.marker()).toBe('original')
    expect(existsSync(path.join(fixture.target, 'Commit87.app'))).toBe(false)
    expect(fixture.events().some((event) => event.command === 'open')).toBe(false)
    fixture.expectClean()
  })

  it('removes only the failed new installation when no previous app existed', () => {
    const fixture = createFixture(null)

    const result = fixture.run(['--version', 'v0.2.0'], { TEST_SIGNATURE_FAILURE: 'post' })

    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('installed Commit87 failed its code-signature check')
    expect(existsSync(fixture.target)).toBe(false)
    expect(fixture.events().some((event) => event.command === 'open')).toBe(false)
    fixture.expectClean()
  })

  it('preserves the recovery backup and reports its path if restoration itself fails', () => {
    const fixture = createFixture()

    const result = fixture.run(['--version', 'v0.2.0'], {
      TEST_SIGNATURE_FAILURE: 'post',
      TEST_RESTORE_FAILURE: '1',
    })

    expect(result.status, result.output).toBe(1)
    const backups = readdirSync(fixture.destination).filter((name) => name.startsWith('.commit87-backup.'))
    expect(backups).toHaveLength(1)
    const backup = path.join(fixture.destination, backups[0], 'Commit87.app')
    expect(fixture.marker(backup)).toBe('original')
    expect(result.output).toContain(`could not restore the previous copy; it is kept at ${backup}`)
    expect(existsSync(fixture.target)).toBe(false)
    expect(readdirSync(fixture.temp)).toEqual([])
  })

  it('keeps the backup separate if the failed replacement cannot be moved out of the way', () => {
    const fixture = createFixture()

    const result = fixture.run(['--version', 'v0.2.0'], {
      TEST_SIGNATURE_FAILURE: 'post',
      TEST_QUARANTINE_FAILURE: '1',
    })

    expect(result.status, result.output).toBe(1)
    const backups = readdirSync(fixture.destination).filter((name) => name.startsWith('.commit87-backup.'))
    expect(backups).toHaveLength(1)
    const backup = path.join(fixture.destination, backups[0], 'Commit87.app')
    expect(fixture.marker(backup)).toBe('original')
    expect(fixture.marker()).toBe('replacement')
    expect(existsSync(path.join(fixture.target, 'Commit87.app'))).toBe(false)
    expect(result.output).toContain(`previous copy kept at ${backup}`)
    expect(fixture.events().some((event) => event.command === 'open')).toBe(false)
    expect(readdirSync(fixture.temp)).toEqual([])
  })

  it('never overwrites a pre-existing backup or cleans unrelated temporary-looking directories', () => {
    const fixture = createFixture()
    const oldBackup = path.join(fixture.destination, 'Commit87.old-1700000000')
    const otherStage = path.join(fixture.destination, '.commit87-install.someone-else')
    const otherBackup = path.join(fixture.destination, '.commit87-backup.someone-else')
    const otherWork = path.join(fixture.temp, 'commit87-install.someone-else')
    for (const directory of [oldBackup, otherStage, otherBackup, otherWork]) {
      mkdirSync(directory)
      writeFileSync(path.join(directory, 'keep'), 'unrelated')
    }

    const result = fixture.run(['--version', 'v0.2.0'])

    expect(result.status, result.output).toBe(0)
    for (const directory of [oldBackup, otherStage, otherBackup, otherWork]) {
      expect(readdirSync(directory)).toEqual(['keep'])
      expect(readFileSync(path.join(directory, 'keep'), 'utf8')).toBe('unrelated')
    }
    expect(fixture.marker()).toBe('replacement')
  })

  it.each([false, true])('uninstall works completely offline (installed: %s)', (installed) => {
    const fixture = createFixture(installed ? '0.1.0' : null)

    const result = fixture.run(['--uninstall'], { TEST_OFFLINE: '1' })

    expect(result.status, result.output).toBe(0)
    expect(existsSync(fixture.target)).toBe(false)
    expect(fixture.events().some((event) => ['curl', 'python3', 'codesign', 'open'].includes(event.command))).toBe(false)
    fixture.expectClean()
  })

  it.each(['install', 'uninstall'])('aborts %s without changing the app if it survives the quit timeout', (mode) => {
    const fixture = createFixture()
    writeFileSync(fixture.running, '')
    const args = mode === 'install' ? ['--version', 'v0.2.0'] : ['--uninstall']

    const result = fixture.run(args, { TEST_STUBBORN: '1' })

    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('still running; quit it manually')
    expect(fixture.marker()).toBe('original')
    const events = fixture.events()
    expect(events.filter((event) => event.command === 'sleep')).toHaveLength(6)
    expect(events.filter((event) => event.command === 'pkill')).toHaveLength(1)
    expect(events.some((event) => ['mv', 'open'].includes(event.command))).toBe(false)
    fixture.expectClean()
  })

  it('resolves the highest version even when the API lists a backport first', () => {
    const fixture = createFixture('0.1.0', '0.2.0', {
      realPython: true,
      releases: [releaseInfo('0.2.1'), releaseInfo('0.3.0'), releaseInfo('0.2.2')],
    })

    const result = fixture.run(['--check'])

    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('newest 0.3.0')
  })

  it('filters the channel with the real resolver', () => {
    const releases = [releaseInfo('0.3.0-beta.2'), releaseInfo('0.2.5')]
    const stable = createFixture('0.1.0', '0.2.0', { realPython: true, releases })
    const beta = createFixture('0.1.0', '0.2.0', { realPython: true, releases })

    const stableResult = stable.run(['--check', '--channel', 'stable'])
    const betaResult = beta.run(['--check', '--channel', 'beta'])

    expect(stableResult.status, stableResult.output).toBe(0)
    expect(stableResult.output).toContain('newest 0.2.5')
    expect(betaResult.status, betaResult.output).toBe(0)
    expect(betaResult.output).toContain('newest 0.3.0-beta.2')
  })

  it('ignores drafts and releases without a build for the running architecture', () => {
    const fixture = createFixture('0.1.0', '0.2.0', {
      realPython: true,
      releases: [releaseInfo('0.4.0', { draft: true }), releaseInfo('0.3.1', { arches: ['x64'] })],
    })

    const result = fixture.run(['--check'])

    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('no arm64 Commit87 build found')
  })

  it('rejects a missing value and documents every option in --help', () => {
    const fixture = createFixture()
    const missing = fixture.run(['--version'])
    const help = fixture.run(['--help'])

    expect(missing.status, missing.output).toBe(1)
    expect(missing.output).toContain('--version requires a value')
    expect(help.status, help.output).toBe(0)
    expect(help.output).toContain('--system')
    expect(help.output).toContain('--keep-work')
  })
})
