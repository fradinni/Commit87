/**
 * Types for scripts/ensure-electron.mjs. The provisioning script stays plain
 * JavaScript so it runs before any TypeScript build exists; this declaration
 * lets the regression test import and check it under strict TypeScript.
 */
export interface ElectronRuntimeState {
  ok: boolean
  reason: string
  electronDir: string
  version: string | null
  expectedPath: string | null
  executablePath: string | null
}

export interface ElectronRuntimeOptions {
  rootDir?: string
  platform?: string
  env?: NodeJS.ProcessEnv
}

export interface ProvisionOptions extends ElectronRuntimeOptions {
  runInstaller?: (options: { electronDir: string; env?: NodeJS.ProcessEnv }) => void
  log?: { log: (message: string) => void }
}

export interface ProvisionResult extends ElectronRuntimeState {
  provisioned: boolean
}

export function platformExecutablePath(platform?: string): string | null
export function inspectElectronRuntime(options?: ElectronRuntimeOptions): ElectronRuntimeState
export function runElectronInstaller(options?: { electronDir: string; env?: NodeJS.ProcessEnv }): void
export function provisionElectronRuntime(options?: ProvisionOptions): ProvisionResult
