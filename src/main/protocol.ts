import { net, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promises as fs } from 'node:fs'

export const APP_SCHEME = 'gitgrove'
export const APP_ORIGIN = `${APP_SCHEME}://app`
export const APP_ENTRY = `${APP_ORIGIN}/index.html`

/**
 * The renderer is served from a privileged custom scheme instead of file://.
 * This keeps `grantFileProtocolExtraPrivileges` off (file:// pages lose extra
 * privileges), while still allowing module scripts, fetch() for bundled assets
 * and a strict CSP.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        bypassCSP: false
      }
    }
  ])
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon'
}

export function registerAppProtocol(rendererRoot: string): void {
  const root = path.resolve(rendererRoot)

  protocol.handle(APP_SCHEME, async (request) => {
    let pathname: string
    try {
      const url = new URL(request.url)
      if (url.host !== 'app') {
        return new Response('Not found', { status: 404 })
      }
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    const relative = pathname === '/' || pathname === '' ? '/index.html' : pathname
    const target = path.resolve(root, `.${relative}`)
    const rel = path.relative(root, target)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return new Response('Forbidden', { status: 403 })
    }

    try {
      const stat = await fs.stat(target)
      if (!stat.isFile()) return new Response('Not found', { status: 404 })
    } catch {
      // SPA fallback: unknown extension-less paths resolve to index.html.
      if (!path.extname(target)) {
        return serveFile(path.join(root, 'index.html'), request.method)
      }
      return new Response('Not found', { status: 404 })
    }

    return serveFile(target, request.method)
  })
}

function serveFile(target: string, method: string): Response | Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }
  if (method === 'HEAD') return new Response(null, { status: 200, headers })
  return net.fetch(pathToFileURL(target).toString()).then(
    (response) =>
      new Response(response.body, {
        status: 200,
        headers
      })
  )
}