import { execFile } from 'node:child_process'

/** How long `codesign` may take before the probe is treated as inconclusive. */
const CODESIGN_TIMEOUT_MS = 10_000

/**
 * Whether `codesign --display` output reports a Developer ID Application
 * authority. Ad-hoc builds have no `Authority=` line at all, so only a real
 * certificate satisfies the check.
 */
export function isDeveloperIdSignature(output: string): boolean {
  return /^Authority=Developer ID Application:/m.test(output)
}

/**
 * Probe the running macOS bundle. Squirrel.Mac only installs an update whose
 * signature satisfies the designated requirement of the running app; ad-hoc
 * signatures embed the current cdhash, which can never match the next release.
 * A failed probe is treated as "not capable" so the UI offers the manual
 * download instead of a broken Restart & install.
 */
export function hasDeveloperIdSignature(bundlePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/codesign',
      ['--display', '--verbose=4', bundlePath],
      { encoding: 'utf8', timeout: CODESIGN_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        resolve(!error && isDeveloperIdSignature(stderr))
      }
    )
  })
}
