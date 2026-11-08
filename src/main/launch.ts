import { statSync } from 'node:fs'
import path from 'node:path'

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** An absolute, existing folder that is not the filesystem root. */
function isLaunchFolder(target: string): boolean {
  return path.isAbsolute(target) && target !== '/' && isDirectory(target)
}

/** URL paths are percent-encoded and may carry a leading slash before a drive letter. */
function urlPath(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return path.normalize(/^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded)
  } catch {
    return null
  }
}

/**
 * Accepts `commit87://open?path=…`, `commit87:///abs/path`, `file:///abs/path`
 * and plain folder argv. `appPath` keeps the app's own launch arguments from
 * being mistaken for a repository.
 */
export function parseLaunchTarget(argv: string[], appPath: string): string | null {
  for (const raw of argv) {
    if (!raw || raw.startsWith('-')) continue
    const scheme = raw.toLowerCase()
    if (scheme.startsWith('commit87://') || scheme.startsWith('file:')) {
      try {
        const url = new URL(raw)
        if (url.protocol === 'file:') {
          const host = url.hostname ? `//${url.hostname}` : ''
          const target = urlPath(`${host}${url.pathname}`)
          if (target && isLaunchFolder(target)) return target
          continue
        }
        const fromQuery = url.searchParams.get('path') || url.searchParams.get('repo')
        if (fromQuery) {
          // Already decoded by searchParams. Let repo.open report a missing
          // folder instead of ignoring a shared link without a word.
          if (path.isAbsolute(fromQuery) && fromQuery !== '/') return path.normalize(fromQuery)
          continue
        }
        const target = urlPath(url.pathname)
        if (target && isLaunchFolder(target)) return target
      } catch {
        // ignore malformed deep links
      }
      continue
    }
    if (!path.isAbsolute(raw)) continue
    if (path.resolve(raw) === path.resolve(appPath)) continue
    if (isLaunchFolder(raw)) return raw
  }
  return null
}
