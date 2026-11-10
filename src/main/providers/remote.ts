import { createHash } from 'node:crypto'
import type { IntegrationAccount, IntegrationAuthority, ProviderDetection, ProviderId } from '@shared/types'

export interface ParsedRemote {
  host: string
  owner: string
  repo: string
  protocol: 'https' | 'ssh' | 'git' | 'file' | 'other'
  port?: number
  webBase: string
  isBitbucketServer: boolean
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//

/**
 * A concrete server a Git operation will contact. `origin` exists only for
 * http(s) destinations, where an ephemeral credential helper can be scoped to
 * it; ssh/git URLs authenticate with keys and never receive a forge token.
 */
export interface GitDestination {
  url: string
  protocol: 'https' | 'http' | 'ssh' | 'git'
  /** Normalized host: lowercase, no trailing dot. */
  host: string
  /** Explicit non-default port, if the URL names one. */
  port?: number
  /** `scheme://host[:port]` for http(s) only. */
  origin?: string
  /** Provider suggested by the hostname; never sufficient to release a token. */
  provider?: ProviderId
}

const DEFAULT_PORTS: Record<string, number> = { https: 443, http: 80, ssh: 22, git: 9418 }

/** Lowercase a host and drop a trailing root dot. IPv6 brackets are kept. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '')
}

export function isLoopbackHost(host: string): boolean {
  const value = normalizeHost(host).replace(/^\[|\]$/g, '')
  if (value === 'localhost' || value.endsWith('.localhost')) return true
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true
  if (value.startsWith('::ffff:127.')) return true
  return false
}

function effectivePort(protocol: string, explicit?: number): number | undefined {
  if (explicit === undefined) return undefined
  return DEFAULT_PORTS[protocol] === explicit ? undefined : explicit
}

function portsCompatible(a: number | undefined, b: number | undefined): boolean {
  return a === b
}

/**
 * Parse the server a Git URL will contact. Local paths and `file://` URLs
 * return null: they reach no network destination.
 */
export function destinationFromUrl(rawUrl: string): GitDestination | null {
  const url = rawUrl.trim()
  if (!url || url.startsWith('-')) return null

  if (!SCHEME_RE.test(url) && !url.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(url)) {
    const scp = /^(?:([^@/]+)@)?([^:/]+):(.+)$/.exec(url)
    if (!scp) return null
    const host = normalizeHost(scp[2])
    if (!host) return null
    return { url, protocol: 'ssh', host, ...providerSuggestion(url) }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const scheme = parsed.protocol.replace(':', '').toLowerCase()
  if (scheme === 'file') return null
  const protocol: GitDestination['protocol'] | null =
    scheme === 'ssh' || scheme === 'git+ssh'
      ? 'ssh'
      : scheme === 'https' || scheme === 'http' || scheme === 'git'
        ? scheme
        : null
  if (!protocol) return null
  const host = normalizeHost(parsed.hostname)
  if (!host) return null
  const port = effectivePort(protocol, parsed.port ? Number(parsed.port) : undefined)
  const origin =
    protocol === 'https' || protocol === 'http' ? `${protocol}://${host}${port !== undefined ? `:${port}` : ''}` : undefined
  return { url, protocol, host, port, origin, ...providerSuggestion(url) }
}

function providerSuggestion(url: string): { provider?: ProviderId } {
  const provider = detectProviderFromUrl(url)?.provider
  return provider ? { provider } : {}
}

interface BaseUrlAuthority {
  host: string
  port?: number
  protocol: string
  path: string
}

export function baseUrlAuthority(baseUrl: string): BaseUrlAuthority | undefined {
  const raw = baseUrl.trim()
  if (!raw) return undefined
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const host = normalizeHost(parsed.hostname)
    if (!host) return undefined
    const protocol = parsed.protocol.replace(':', '').toLowerCase()
    return {
      host,
      port: effectivePort(protocol, parsed.port ? Number(parsed.port) : undefined),
      protocol,
      path: parsed.pathname.replace(/\/+$/, '')
    }
  } catch {
    return undefined
  }
}

export function parseRemoteUrl(rawUrl: string): ParsedRemote | null {
  const url = rawUrl.trim()
  if (!url) return null

  // scp-like: git@host:owner/repo.git
  const scp = /^(?:([^@/]+)@)?([^:/]+):(.+)$/.exec(url)
  if (!SCHEME_RE.test(url) && scp && !url.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(url)) {
    const host = scp[2]
    const pathPart = scp[3].replace(/^\/+/, '')
    return buildParsed(host, pathPart, 'ssh', undefined)
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const protocol = parsed.protocol.replace(':', '')
  if (protocol === 'file') return null
  const host = parsed.hostname
  let pathPart = decodeURIComponent(parsed.pathname).replace(/^\/+/, '').replace(/\.git$/, '')
  let bitbucketServer = false
  if (pathPart.toLowerCase().startsWith('scm/')) {
    pathPart = pathPart.slice(4)
    bitbucketServer = true
  }
  return buildParsed(
    host,
    pathPart,
    protocol === 'ssh' || protocol === 'git+ssh' ? 'ssh' : protocol === 'https' || protocol === 'http' ? 'https' : 'other',
    parsed.port ? Number(parsed.port) : undefined,
    bitbucketServer
  )
}

function buildParsed(
  host: string,
  pathPart: string,
  protocol: ParsedRemote['protocol'],
  port?: number,
  isBitbucketServer = false
): ParsedRemote {
  const clean = pathPart.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
  const segments = clean.split('/').filter(Boolean)
  const repo = segments.pop() ?? ''
  const owner = segments.join('/')
  return {
    host,
    owner,
    repo,
    protocol,
    port,
    webBase: `https://${host}`,
    isBitbucketServer
  }
}

export function detectProviderFromUrl(rawUrl: string): ProviderDetection | null {
  const parsed = parseRemoteUrl(rawUrl)
  if (!parsed) return null
  const host = parsed.host.toLowerCase()
  let provider: ProviderId | undefined
  if (host === 'github.com' || host.endsWith('.github.com')) provider = 'github'
  else if (host === 'gitlab.com' || host.includes('gitlab')) provider = 'gitlab'
  else if (host === 'bitbucket.org' || host.includes('bitbucket')) provider = 'bitbucket'
  else if (host === 'codeberg.org' || host.includes('gitea') || host.includes('forgejo')) provider = 'gitea'
  return {
    provider,
    host: parsed.host,
    owner: parsed.owner,
    repo: parsed.repo,
    webUrlBase: provider === 'github' ? 'https://github.com' : parsed.webBase
  }
}

export function providerFromHost(host: string | undefined, accounts: IntegrationAccount[]): ProviderId | undefined {
  if (!host) return undefined
  const lower = host.toLowerCase()
  for (const account of accounts) {
    try {
      const accountHost = new URL(account.baseUrl.includes('://') ? account.baseUrl : `https://${account.baseUrl}`).hostname
      if (accountHost.toLowerCase() === lower) return account.provider
    } catch {
      // ignore malformed base URL
    }
  }
  if (lower === 'github.com') return 'github'
  if (lower === 'gitlab.com' || lower.includes('gitlab')) return 'gitlab'
  if (lower === 'bitbucket.org' || lower.includes('bitbucket')) return 'bitbucket'
  if (lower === 'codeberg.org' || lower.includes('gitea') || lower.includes('forgejo')) return 'gitea'
  return undefined
}

/**
 * Build the authority an integration's token is bound to. The host comes from
 * the configured base URL, so API paths (`/api/v3`, `/api/v4`, `/2.0`) never
 * take part in matching.
 */
export function integrationAuthority(
  provider: ProviderId,
  baseUrl: string,
  cloneHost?: string
): IntegrationAuthority | undefined {
  const base = baseUrlAuthority(baseUrl)
  if (!base) return undefined
  const clone = cloneHost?.trim() ? normalizeHost(cloneHost) : undefined
  // Hash the components so a host or path containing the separator cannot
  // collide with a different authority.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([provider, base.host, base.port ?? null, clone ?? null, base.path]))
    .digest('hex')
  return {
    provider,
    host: base.host,
    ...(base.port !== undefined ? { port: base.port } : {}),
    ...(clone ? { cloneHost: clone } : {}),
    fingerprint
  }
}

/**
 * Strict destination match for credentials. Provider-name heuristics are not
 * enough: a token must never be offered to `gitlab.evil.example` just because
 * the hostname contains "gitlab". Matching requires:
 *
 * 1. a secure destination (plain http only for loopback),
 * 2. exact normalized host equality with the account base URL (or its
 *    documented API mapping / explicit clone host), and
 * 3. the same explicit non-default port.
 *
 * Paths such as `/api/v3` on a self-hosted base URL do not affect the host.
 */
export function accountMatchesDestination(account: IntegrationAccount, destination: GitDestination): boolean {
  const base = baseUrlAuthority(account.baseUrl)
  if (!base) return false
  if (destination.protocol === 'http' && !isLoopbackHost(destination.host)) return false
  if (base.protocol === 'http' && !isLoopbackHost(base.host)) return false

  const hosts = new Set<string>([base.host])
  if (account.authority?.cloneHost) hosts.add(normalizeHost(account.authority.cloneHost))
  if (account.provider === 'github' && base.host === 'api.github.com') hosts.add('github.com')
  if (account.provider === 'bitbucket' && base.host === 'api.bitbucket.org') hosts.add('bitbucket.org')
  if (!hosts.has(destination.host)) return false

  const accountPort = base.port
  return portsCompatible(accountPort, destination.port)
}

export function accountMatchesHost(account: IntegrationAccount, host: string): boolean {
  const destination = destinationFromUrl(`https://${host}`)
  return destination ? accountMatchesDestination(account, destination) : false
}

export function webUrlFor(provider: ProviderId | undefined, host: string, owner: string, repo: string): string {
  switch (provider) {
    case 'github':
      return host === 'github.com' ? `https://github.com/${owner}/${repo}` : `https://${host}/${owner}/${repo}`
    case 'gitlab':
      return `https://${host}/${owner}/${repo}`
    case 'bitbucket':
      return host === 'bitbucket.org' ? `https://bitbucket.org/${owner}/${repo}` : `https://${host}/${owner}/${repo}`
    case 'gitea':
      return `https://${host}/${owner}/${repo}`
    default:
      return `https://${host}/${owner}/${repo}`
  }
}

export function baseUrlHost(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).hostname
  } catch {
    return undefined
  }
}

export function normalizeBaseUrl(provider: ProviderId, baseUrl: string): string {
  const raw = baseUrl.trim() || defaultBaseUrl(provider)
  const withScheme = raw.includes('://') ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
}

function defaultBaseUrl(provider: ProviderId): string {
  switch (provider) {
    case 'github':
      return 'https://api.github.com'
    case 'gitlab':
      return 'https://gitlab.com'
    case 'bitbucket':
      return 'https://api.bitbucket.org/2.0'
    case 'gitea':
      return 'https://gitea.com'
  }
}
