import { ProviderError } from './types'
import type { RequestOptions } from './types'

const REQUEST_TIMEOUT = 30_000

export async function apiRequest<T>(url: string, options: RequestOptions): Promise<T> {
  const target = new URL(url)
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined) continue
      target.searchParams.set(key, String(value))
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'GitGrove/0.1 (+https://gitgrove.dev)',
    ...options.extraHeaders
  }
  applyAuth(headers, options)

  let response: Response
  try {
    response = await fetch(target.toString(), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
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

  return data as T
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
