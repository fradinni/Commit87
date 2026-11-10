#!/usr/bin/env node
/**
 * Provides the Electron runtime that `npm run dev` and `npm run start` need.
 *
 * Electron 45 provisions its runtime lazily, the first time the `electron`
 * module is imported. electron-vite does not import it: it resolves the module
 * directory and reads `node_modules/electron/path.txt` directly, then aborts
 * with "Electron uninstall" when that file is absent. A fresh `npm ci` leaves
 * exactly that state, because the Electron package no longer downloads its
 * runtime in a dependency install script.
 *
 * This script checks the same facts Electron's own installer checks (runtime
 * version, path file, executable) and runs that installer only when the runtime
 * is missing or stale, so it is safe to run before every launch.
 *
 *   node scripts/ensure-electron.mjs           # provision when missing
 *   node scripts/ensure-electron.mjs --check   # diagnose only, never download
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PLATFORM_PATHS = {
  mas: 'Electron.app/Contents/MacOS/Electron',
  darwin: 'Electron.app/Contents/MacOS/Electron',
  freebsd: 'electron',
  openbsd: 'electron',
  linux: 'electron',
  win32: 'electron.exe'
}

/**
 * Relative path of the runtime executable inside `node_modules/electron/dist`,
 * mirroring `getPlatformPath()` in the `electron` package.
 *
 * @param {string} platform
 * @returns {string | null} null on a platform Electron has no build for
 */
export function platformExecutablePath(platform = process.platform) {
  return PLATFORM_PATHS[platform] ?? null
}

function readTrimmed(file) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
}

function describeExecutableProblem(executable) {
  if (!existsSync(executable)) {
    return `the runtime executable is missing at ${executable}`
  }
  try {
    if (!statSync(executable).isFile() || statSync(executable).size === 0) {
      return `the runtime executable at ${executable} is not a usable file`
    }
  } catch {
    return `the runtime executable at ${executable} cannot be read`
  }
  return null
}

/**
 * Reports whether the installed Electron runtime matches the `electron`
 * dependency and where it lives. Never downloads anything.
 *
 * @param {{ rootDir?: string, platform?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{
 *   ok: boolean,
 *   reason: string,
 *   electronDir: string,
 *   version: string | null,
 *   expectedPath: string | null,
 *   executablePath: string | null,
 * }}
 */
export function inspectElectronRuntime(options = {}) {
  const rootDir = options.rootDir ?? REPO_ROOT
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const electronDir = path.join(rootDir, 'node_modules', 'electron')
  const state = {
    ok: false,
    reason: '',
    electronDir,
    version: null,
    expectedPath: platformExecutablePath(platform),
    executablePath: null
  }

  // electron-vite prefers ELECTRON_EXEC_PATH over path.txt, so an existing
  // override is enough to launch even when the packaged runtime is absent.
  const override = env.ELECTRON_EXEC_PATH?.trim()
  if (override) {
    const problem = describeExecutableProblem(override)
    if (problem === null) {
      state.ok = true
      state.reason = 'ELECTRON_EXEC_PATH is set'
      state.executablePath = override
    } else {
      state.reason = `ELECTRON_EXEC_PATH is set but ${problem}`
    }
    return state
  }

  const packageJson = path.join(electronDir, 'package.json')
  if (!existsSync(packageJson)) {
    state.reason = `the electron package is not installed at ${electronDir} (run "npm ci" first)`
    return state
  }
  let expectedVersion
  try {
    expectedVersion = JSON.parse(readFileSync(packageJson, 'utf8')).version
  } catch {
    state.reason = `cannot read ${packageJson}`
    return state
  }
  if (typeof expectedVersion !== 'string' || expectedVersion === '') {
    state.reason = `${packageJson} has no version`
    return state
  }

  if (state.expectedPath === null) {
    state.reason = `Electron has no runtime build for platform "${platform}"`
    return state
  }

  const pathFile = path.join(electronDir, 'path.txt')
  const recordedPath = readTrimmed(pathFile)
  if (recordedPath === null) {
    state.reason = `${pathFile} is missing, so electron-vite cannot find the runtime`
    return state
  }
  if (recordedPath !== state.expectedPath) {
    state.reason = `${pathFile} points at "${recordedPath}" instead of "${state.expectedPath}"`
    return state
  }

  const distDir = env.ELECTRON_OVERRIDE_DIST_PATH?.trim() || path.join(electronDir, 'dist')
  const installedVersion = readTrimmed(path.join(distDir, 'version'))
  state.version = installedVersion
  if (installedVersion === null) {
    state.reason = `the runtime version file is missing from ${distDir}`
    return state
  }
  // A runtime left over from a previous Electron version cannot be used: the
  // app's bundles and the native binary have to agree.
  if (installedVersion !== expectedVersion) {
    state.reason = `the runtime is ${installedVersion} but the electron package is ${expectedVersion}`
    return state
  }

  const executablePath = path.join(distDir, recordedPath)
  const problem = describeExecutableProblem(executablePath)
  if (problem !== null) {
    state.reason = problem
    return state
  }

  state.ok = true
  state.reason = 'the runtime is present'
  state.executablePath = executablePath
  return state
}

/**
 * Runs the `electron` package's own installer, which downloads the checksummed
 * runtime for this platform and writes `path.txt` next to it.
 */
export function runElectronInstaller({ electronDir, env = process.env } = {}) {
  const installer = path.join(electronDir, 'install.js')
  if (!existsSync(installer)) {
    throw new Error(
      `Cannot provision Electron: ${installer} is missing. Delete "node_modules/electron" and run "npm ci" again.`
    )
  }
  const result = spawnSync(process.execPath, [installer], { shell: false, stdio: 'inherit', env })
  if (result.error) {
    throw new Error(`Cannot provision Electron: ${result.error.message}`)
  }
  if (result.signal !== null) {
    throw new Error(`Electron provisioning was terminated by ${result.signal}`)
  }
  if (result.status !== 0) {
    throw new Error(
      `Electron provisioning failed with exit code ${result.status}. ` +
        'Delete "node_modules/electron" and run "npm ci" again, then retry.'
    )
  }
}

/**
 * Ensures a usable Electron runtime exists, installing it once when it does
 * not. Safe to call repeatedly: a provisioned runtime is not downloaded again.
 *
 * @param {{
 *   rootDir?: string,
 *   platform?: string,
 *   env?: NodeJS.ProcessEnv,
 *   runInstaller?: typeof runElectronInstaller,
 *   log?: { log: (message: string) => void },
 * }} [options]
 * @returns {ReturnType<typeof inspectElectronRuntime> & { provisioned: boolean }}
 */
export function provisionElectronRuntime(options = {}) {
  const rootDir = options.rootDir ?? REPO_ROOT
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const runInstaller = options.runInstaller ?? runElectronInstaller
  const log = options.log ?? console

  const before = inspectElectronRuntime({ rootDir, platform, env })
  if (before.ok) {
    log.log(`[ensure-electron] runtime ${before.version ?? ''} present`.trim())
    return { ...before, provisioned: false }
  }

  log.log(`[ensure-electron] ${before.reason}`)
  if (env.ELECTRON_EXEC_PATH?.trim()) {
    // electron-vite would keep using the broken override, so downloading into
    // node_modules could not fix the launch.
    throw new Error(
      `Cannot provision Electron: ${before.reason}. Unset ELECTRON_EXEC_PATH or point it at a usable binary.`
    )
  }
  if (!existsSync(path.join(before.electronDir, 'package.json'))) {
    throw new Error(`Cannot provision Electron: ${before.reason}`)
  }
  log.log('[ensure-electron] downloading the Electron runtime (once per dependency install)...')
  runInstaller({ electronDir: before.electronDir, env })

  const after = inspectElectronRuntime({ rootDir, platform, env })
  if (!after.ok) {
    throw new Error(
      `Electron runtime is still unusable after running its installer: ${after.reason}. ` +
        'Delete "node_modules/electron" and run "npm ci" again.'
    )
  }
  log.log(`[ensure-electron] runtime ${after.version ?? ''} provisioned`.trim())
  return { ...after, provisioned: true }
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
  const checkOnly = process.argv.includes('--check')
  try {
    if (checkOnly) {
      const state = inspectElectronRuntime()
      if (!state.ok) {
        console.error(
          `[ensure-electron] ${state.reason}\n` +
            '[ensure-electron] Run "node scripts/ensure-electron.mjs" to provision it.'
        )
        process.exitCode = 1
      } else {
        console.log(`[ensure-electron] usable runtime: ${state.executablePath}`)
      }
    } else {
      provisionElectronRuntime()
    }
  } catch (error) {
    console.error(`[ensure-electron] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
