import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * A controlled Git environment for a single test file.
 *
 * Integration fixtures must not depend on the developer machine: an ambient
 * `user.name`, `includeIf`, `core.hooksPath`, signing key or `init.defaultBranch`
 * can change results. Each test file gets its own HOME and global/system config
 * files, plus a deterministic identity and default branch for fixtures that do
 * not configure their own.
 */
export interface IsolatedGitEnvironment {
  readonly home: string
  readonly globalConfig: string
  readonly systemConfig: string
}

const MANAGED_VARIABLES = [
  'HOME',
  'USERPROFILE',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_TERMINAL_PROMPT',
  'GIT_ASKPASS',
  'SSH_ASKPASS'
] as const

const INJECTED_CONFIG = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/

const GLOBAL_CONFIG = [
  '[init]',
  '\tdefaultBranch = main',
  '[commit]',
  '\tgpgsign = false',
  '[tag]',
  '\tgpgsign = false',
  '[user]',
  '\tname = Commit87 Test',
  '\temail = test@commit87.invalid',
  ''
].join('\n')

let active: { environment: IsolatedGitEnvironment; saved: Map<string, string | undefined> } | null = null

function saveVariable(saved: Map<string, string | undefined>, name: string): void {
  saved.set(name, process.env[name])
}

/**
 * Install the controlled environment once per test file. Returns the same
 * object on repeated calls so callers can read the paths.
 */
export function installIsolatedGitEnvironment(): IsolatedGitEnvironment {
  if (active) return active.environment

  const home = mkdtempSync(path.join(os.tmpdir(), 'commit87-git-home-'))
  const configDir = path.join(home, 'config')
  mkdirSync(configDir, { recursive: true })
  const globalConfig = path.join(configDir, 'global.gitconfig')
  const systemConfig = path.join(configDir, 'system.gitconfig')
  writeFileSync(globalConfig, GLOBAL_CONFIG, 'utf8')
  writeFileSync(systemConfig, '', 'utf8')

  const saved = new Map<string, string | undefined>()
  for (const name of MANAGED_VARIABLES) saveVariable(saved, name)
  for (const name of Object.keys(process.env)) {
    if (!INJECTED_CONFIG.test(name)) continue
    saveVariable(saved, name)
    delete process.env[name]
  }

  // HOME keeps stray files (credential stores, hooks, config includes) out of
  // the developer's profile; the explicit config files replace both levels.
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_SYSTEM = systemConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_TERMINAL_PROMPT = '0'
  delete process.env.GIT_CONFIG_COUNT
  delete process.env.GIT_ASKPASS
  delete process.env.SSH_ASKPASS

  const environment = { home, globalConfig, systemConfig }
  active = { environment, saved }
  return environment
}

/** Restore every managed variable and remove the temporary HOME. */
export function restoreGitEnvironment(): void {
  if (!active) return
  // A test may have installed `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` itself;
  // remove those before restoring the variables that existed at install time.
  for (const name of Object.keys(process.env)) {
    if (INJECTED_CONFIG.test(name)) delete process.env[name]
  }
  for (const [name, value] of active.saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(active.environment.home, { recursive: true, force: true })
  active = null
}
