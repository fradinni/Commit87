import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectElectronRuntime, provisionElectronRuntime } from '../scripts/ensure-electron.mjs'
import type { ProvisionOptions } from '../scripts/ensure-electron.mjs'

const VERSION = '45.2.3'
const PLATFORM = 'linux'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'commit87-electron-'))
  roots.push(root)
  return root
}

interface RuntimeParts {
  packageJson?: boolean
  pathFile?: boolean
  distVersion?: boolean | string
  executable?: boolean
}

/**
 * Writes a `node_modules/electron` tree shaped like the real package, optionally
 * leaving one part out so the check has to notice it.
 */
function writeRuntime(root: string, parts: RuntimeParts = {}): string {
  const electronDir = path.join(root, 'node_modules', 'electron')
  mkdirSync(path.join(electronDir, 'dist'), { recursive: true })
  if (parts.packageJson !== false) {
    writeFileSync(
      path.join(electronDir, 'package.json'),
      `${JSON.stringify({ name: 'electron', version: VERSION }, null, 2)}\n`
    )
  }
  if (parts.pathFile !== false) {
    writeFileSync(path.join(electronDir, 'path.txt'), 'electron')
  }
  if (parts.distVersion !== false) {
    const distVersion = typeof parts.distVersion === 'string' ? parts.distVersion : VERSION
    writeFileSync(path.join(electronDir, 'dist', 'version'), distVersion)
  }
  if (parts.executable !== false) {
    writeFileSync(path.join(electronDir, 'dist', 'electron'), '#!/bin/sh\nexit 0\n')
  }
  // Stands in for the package installer; the test never executes it.
  writeFileSync(path.join(electronDir, 'install.js'), 'process.exit(0)\n')
  return electronDir
}

interface InstalledRuntime {
  electronDir: string
}

function installerThatCompletes(installed: InstalledRuntime): {
  runInstaller: (options: { electronDir: string; env?: NodeJS.ProcessEnv }) => void
  calls: () => number
} {
  let calls = 0
  return {
    runInstaller: ({ electronDir }) => {
      calls += 1
      expect(electronDir).toBe(installed.electronDir)
      // The real installer downloads the runtime and writes these files.
      mkdirSync(path.join(electronDir, 'dist'), { recursive: true })
      writeFileSync(path.join(electronDir, 'package.json'), `${JSON.stringify({ name: 'electron', version: VERSION })}\n`)
      writeFileSync(path.join(electronDir, 'path.txt'), 'electron')
      writeFileSync(path.join(electronDir, 'dist', 'version'), VERSION)
      writeFileSync(path.join(electronDir, 'dist', 'electron'), '#!/bin/sh\nexit 0\n')
    },
    calls: () => calls
  }
}

function quiet(): ProvisionOptions['log'] {
  return { log: () => {} }
}

describe('ensure-electron sizing up the runtime', () => {
  it('accepts a complete runtime without running the installer', () => {
    const root = createRoot()
    writeRuntime(root)
    const electronDir = path.join(root, 'node_modules', 'electron')
    const installer = installerThatCompletes({ electronDir })

    const result = provisionElectronRuntime({
      rootDir: root,
      platform: PLATFORM,
      env: {},
      runInstaller: installer.runInstaller,
      log: quiet()
    })

    expect(result.ok).toBe(true)
    expect(result.provisioned).toBe(false)
    expect(result.version).toBe(VERSION)
    expect(result.executablePath).toBe(path.join(electronDir, 'dist', 'electron'))
    expect(installer.calls()).toBe(0)
  })

  it('provisions exactly once when path.txt is missing, as after a fresh install', () => {
    const root = createRoot()
    const electronDir = writeRuntime(root, { pathFile: false })
    const installer = installerThatCompletes({ electronDir })

    expect(inspectElectronRuntime({ rootDir: root, platform: PLATFORM, env: {} }).ok).toBe(false)

    const first = provisionElectronRuntime({
      rootDir: root,
      platform: PLATFORM,
      env: {},
      runInstaller: installer.runInstaller,
      log: quiet()
    })
    expect(first.ok).toBe(true)
    expect(first.provisioned).toBe(true)
    expect(installer.calls()).toBe(1)

    const second = provisionElectronRuntime({
      rootDir: root,
      platform: PLATFORM,
      env: {},
      runInstaller: installer.runInstaller,
      log: quiet()
    })
    expect(second.provisioned).toBe(false)
    expect(installer.calls()).toBe(1)
  })

  it('repairs a partial runtime whose executable is missing', () => {
    const root = createRoot()
    const electronDir = writeRuntime(root, { executable: false })
    const installer = installerThatCompletes({ electronDir })

    const result = provisionElectronRuntime({
      rootDir: root,
      platform: PLATFORM,
      env: {},
      runInstaller: installer.runInstaller,
      log: quiet()
    })

    expect(result.provisioned).toBe(true)
    expect(installer.calls()).toBe(1)
    expect(existsSync(path.join(electronDir, 'dist', 'electron'))).toBe(true)
  })

  it('replaces a runtime left over from another Electron version', () => {
    const root = createRoot()
    const electronDir = writeRuntime(root, { distVersion: '44.0.0' })
    const installer = installerThatCompletes({ electronDir })

    const state = inspectElectronRuntime({ rootDir: root, platform: PLATFORM, env: {} })
    expect(state.ok).toBe(false)
    expect(state.reason).toContain('44.0.0')

    const result = provisionElectronRuntime({
      rootDir: root,
      platform: PLATFORM,
      env: {},
      runInstaller: installer.runInstaller,
      log: quiet()
    })
    expect(result.provisioned).toBe(true)
    expect(result.version).toBe(VERSION)
    expect(installer.calls()).toBe(1)
  })

  it('fails with an actionable message when the installer does not fix the runtime', () => {
    const root = createRoot()
    writeRuntime(root, { executable: false })

    expect(() =>
      provisionElectronRuntime({
        rootDir: root,
        platform: PLATFORM,
        env: {},
        runInstaller: () => {},
        log: quiet()
      })
    ).toThrow(/still unusable after running its installer.*npm ci/s)
  })

  it('explains that npm ci has to run when the electron package is absent', () => {
    const root = createRoot()
    const state = inspectElectronRuntime({ rootDir: root, platform: PLATFORM, env: {} })
    expect(state.ok).toBe(false)
    expect(state.reason).toContain('npm ci')

    let installerCalls = 0
    expect(() =>
      provisionElectronRuntime({
        rootDir: root,
        platform: PLATFORM,
        env: {},
        runInstaller: () => {
          installerCalls += 1
        },
        log: quiet()
      })
    ).toThrow(/npm ci/)
    expect(installerCalls).toBe(0)
  })

  it('honours ELECTRON_EXEC_PATH without touching node_modules', () => {
    const root = createRoot()
    const electronDir = path.join(root, 'node_modules', 'electron')
    mkdirSync(electronDir, { recursive: true })
    const overrideBinary = path.join(root, 'custom-electron')
    writeFileSync(overrideBinary, '#!/bin/sh\nexit 0\n')

    const state = inspectElectronRuntime({
      rootDir: root,
      platform: PLATFORM,
      env: { ELECTRON_EXEC_PATH: overrideBinary }
    })
    expect(state.ok).toBe(true)
    expect(state.executablePath).toBe(overrideBinary)
  })

  it('does not download when ELECTRON_EXEC_PATH is broken', () => {
    const root = createRoot()
    writeRuntime(root)
    const missing = path.join(root, 'no-such-electron')
    let installerCalls = 0

    expect(() =>
      provisionElectronRuntime({
        rootDir: root,
        platform: PLATFORM,
        env: { ELECTRON_EXEC_PATH: missing },
        runInstaller: () => {
          installerCalls += 1
        },
        log: quiet()
      })
    ).toThrow(/ELECTRON_EXEC_PATH/)
    expect(installerCalls).toBe(0)
  })
})
