export type UpdateFormat = 'appimage' | 'nsis' | 'dmg'

export interface UpdateEnvironment {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** Set by the AppImage runtime to the path of the running image. */
  appImage?: string
  /** Set by electron-builder's portable Windows target. */
  portable?: string
  /** Set inside a Snap sandbox. */
  snap?: string
  /** Set inside a Flatpak sandbox. */
  flatpak?: string
  /**
   * NSIS writes `Uninstall Commit87.exe` next to the app, including custom
   * install directories. Portable and zip builds have no uninstaller, so this
   * separates a real install from an extracted archive.
   */
  windowsUninstaller?: boolean
}

export interface UpdateSupport {
  supported: boolean
  format: UpdateFormat | null
  reason: string | null
}

const WINDOWS_ARCHIVE_REASON =
  'Automatic updates are available for the installed build. Extract-free zip and portable copies are replaced by downloading the next release.'

/**
 * Auto-update is intentionally limited to the formats electron-updater can
 * replace in place: the AppImage, the NSIS installer and the macOS app bundle
 * (updated from the release zip). Package-manager builds must be upgraded by
 * the package manager, and portable or zip Windows builds have no install
 * location to patch.
 */
export function detectUpdateSupport(env: UpdateEnvironment): UpdateSupport {
  const unsupported = (reason: string): UpdateSupport => ({ supported: false, format: null, reason })
  if (!env.isPackaged) {
    return unsupported('Automatic updates are available in packaged builds only.')
  }
  if (env.platform === 'linux') {
    if (env.flatpak) {
      return unsupported('This Flatpak build is updated by your software center.')
    }
    if (env.snap) {
      return unsupported('This Snap build is updated automatically by snapd.')
    }
    if (env.appImage) {
      return { supported: true, format: 'appimage', reason: null }
    }
    return unsupported(
      'Automatic updates are available for the AppImage build. Use your package manager to update this installation.'
    )
  }
  if (env.platform === 'win32') {
    if (env.portable) {
      return unsupported('Portable builds are replaced by downloading the next release, not updated in place.')
    }
    if (env.windowsUninstaller !== true) {
      return unsupported(WINDOWS_ARCHIVE_REASON)
    }
    return { supported: true, format: 'nsis', reason: null }
  }
  if (env.platform === 'darwin') {
    return { supported: true, format: 'dmg', reason: null }
  }
  return unsupported(`Automatic updates are not available on ${env.platform}.`)
}