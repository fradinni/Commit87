import { ProviderError } from './types'
import type { RequestOptions } from './types'

const REQUEST_TIMEOUT = 30_000

export interface ApiResponse<T> {
  data: T
  headers: Headers
}

/** Absolute `next` links are used verbatim; relative paths are joined to the API base. */
export function joinUrl(base: string, path: string): string {
  return /^https?:\/\//i.test(path) ? path : `${base}${path}`
}

export async function apiRequest<T>(url: string, options: RequestOptions): Promise<T> {
  return (await apiRequestWithHeaders<T>(url, options)).data
}

/**
 * Same transport as `apiRequest`, with the response headers exposed so a
 * caller can honour `Link` / `X-Next-Page` continuation. Headers are never
 * returned to the renderer.
 */
export async function apiRequestWithHeaders<T>(url: string, options: RequestOptions): Promise<ApiResponse<T>> {
  const target = new URL(url)
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (const item of value) target.searchParams.append(key, String(item))
      } else {
        target.searchParams.set(key, String(value))
      }
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'Commit87/0.1 (+https://commit87.fradinni.fr)',
    ...options.extraHeaders
  }
  applyAuth(headers, options)

  let body: string | undefined
  if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    // A serialised JSON body must say so; string bodies never remain
    // text/plain, and provider Accept headers set by applyAuth are kept.
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
  }

  let response: Response
  try {
    response = await fetch(target.toString(), {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ProviderError(`Cannot reach ${target.host}: ${message}`, 0, options.provider, message)
  }

  const text = await response.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!response.ok) {
    throw new ProviderError(
      describeError(response.status, data, target.pathname),
      response.status,
      options.provider,
      typeof data === 'string' ? data.slice(0, 500) : undefined
    )
  }

  return { data: data as T, headers: response.headers }
}

/** The `page` number of the `rel="next"` entry in a GitHub-style Link header. */
export function nextPageFromLink(link: string | null): string | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    const section = part.trim()
    const rel = /;\s*rel\s*=\s*"?([^";]+)"?/i.exec(section)
    if (!rel) continue
    if (!rel[1].trim().toLowerCase().split(/\s+/).includes('next')) continue
    const match = /<([^>]+)>/.exec(section)
    if (!match) continue
    try {
      const page = new URL(match[1]).searchParams.get('page')
      if (page) return page
    } catch {
      const page = /[?&]page=(\d+)/.exec(match[1])?.[1]
      if (page) return page
    }
  }
  return undefined
}

export function positiveInt(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function applyAuth(headers: Record<string, string>, options: RequestOptions): void {
  const token = options.token
  switch (options.provider) {
    case 'github':
      headers.Authorization = `Bearer ${token}`
      headers.Accept = 'application/vnd.github+json'
      headers['X-GitHub-Api-Version'] = '2022-11-28'
      break
    case 'gitlab':
      headers['PRIVATE-TOKEN'] = token
      break
    case 'gitea':
      headers.Authorization = `token ${token}`
      break
    case 'bitbucket': {
      const username = options.username ?? ''
      const basic = username && (username.includes('@') || token.includes(':'))
      headers.Authorization = basic
        ? `Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}`
        : `Bearer ${token}`
      break
    }
    default:
      headers.Authorization = `Bearer ${token}`
  }
}

function describeError(status: number, data: unknown, path: string): string {
  let message = `Request failed (HTTP ${status}) for ${path}`
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const candidate = record.message ?? record.error_description ?? record.error ?? record.detail
    if (typeof candidate === 'string') message = `${candidate} (HTTP ${status})`
    const errors = record.errors
    if (Array.isArray(errors) && errors.length) {
      const first = errors[0] as Record<string, unknown>
      if (typeof first?.message === 'string') message += `: ${first.message}`
    }
  } else if (typeof data === 'string' && data.trim()) {
    message = `${data.slice(0, 300)} (HTTP ${status})`
  }
  if (status === 401) message += ' — check that your token is valid and has the required scopes.'
  if (status === 403) message += ' — the token may be missing scopes or you hit a rate limit.'
  if (status === 404) message += ' — repository not found, or the token cannot see it.'
  return message
}

export function encodeProjectPath(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`)
}

export function ensureSuffix(base: string, suffix: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`
}
