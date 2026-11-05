import type { IntegrationAccount, ProviderDetection, ProviderId } from '@shared/types'

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
 * Strict host match for credentials. Unlike `providerFromHost`, a provider
 * heuristic is not enough: a token must never be offered to `gitlab.evil.example`
 * just because it contains "gitlab".
 */
export function accountMatchesHost(account: IntegrationAccount, host: string): boolean {
  const target = host.toLowerCase()
  const accountHost = baseUrlHost(account.baseUrl)?.toLowerCase()
  if (!accountHost) return false
  if (accountHost === target) return true
  if (account.provider === 'github' && accountHost === 'api.github.com' && target === 'github.com') return true
  if (account.provider === 'bitbucket' && accountHost === 'api.bitbucket.org' && target === 'bitbucket.org') return true
  return false
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
