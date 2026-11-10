import { describe, expect, it } from 'vitest'
import {
  accountMatchesDestination,
  cloneBaseForAccount,
  accountMatchesHost,
  destinationFromUrl,
  detectProviderFromUrl,
  integrationAuthority,
  normalizeBaseUrl,
  parseRemoteUrl,
  providerFromHost,
  webUrlFor
} from '../src/main/providers/remote'
import type { IntegrationAccount, ProviderId } from '../src/shared/types'

function account(id: string, provider: ProviderId, baseUrl: string, cloneHost?: string): IntegrationAccount {
  return {
    id,
    provider,
    label: id,
    username: 'me',
    baseUrl,
    authority: integrationAuthority(provider, baseUrl, cloneHost),
    hasToken: true,
    createdAt: 0
  }
}

describe('remote URL parsing', () => {
  it('parses scp-like SSH URLs', () => {
    expect(parseRemoteUrl('git@github.com:acme/app.git')).toMatchObject({
      host: 'github.com',
      owner: 'acme',
      repo: 'app',
      protocol: 'ssh'
    })
  })

  it('parses HTTPS, ssh:// and nested GitLab groups', () => {
    expect(parseRemoteUrl('https://github.com/acme/app.git')).toMatchObject({ host: 'github.com', owner: 'acme', repo: 'app' })
    expect(parseRemoteUrl('ssh://git@gitlab.com:2222/group/sub/app.git')).toMatchObject({
      host: 'gitlab.com',
      owner: 'group/sub',
      repo: 'app',
      port: 2222
    })
    expect(parseRemoteUrl('https://gitlab.example.com/group/sub/app')).toMatchObject({ owner: 'group/sub', repo: 'app' })
  })

  it('handles Bitbucket Server scm paths and rejects files', () => {
    expect(parseRemoteUrl('https://bitbucket.example.com/scm/PROJ/repo.git')).toMatchObject({
      owner: 'PROJ',
      repo: 'repo',
      isBitbucketServer: true
    })
    expect(parseRemoteUrl('file:///tmp/repo')).toBeNull()
    expect(parseRemoteUrl('not a url')).toBeNull()
  })

  it('detects providers by host', () => {
    expect(detectProviderFromUrl('git@github.com:a/b.git')?.provider).toBe('github')
    expect(detectProviderFromUrl('https://gitlab.com/a/b.git')?.provider).toBe('gitlab')
    expect(detectProviderFromUrl('https://bitbucket.org/a/b.git')?.provider).toBe('bitbucket')
    expect(detectProviderFromUrl('https://codeberg.org/a/b.git')?.provider).toBe('gitea')
    expect(detectProviderFromUrl('https://example.com/a/b.git')?.provider).toBeUndefined()
  })

  it('maps known hosts from configured accounts', () => {
    const accounts: IntegrationAccount[] = [account('1', 'gitea', 'https://git.example.com')]
    expect(providerFromHost('git.example.com', accounts)).toBe('gitea')
    expect(providerFromHost('github.com', accounts)).toBe('github')
    expect(providerFromHost('unknown.tld', accounts)).toBeUndefined()
  })

  it('builds web URLs and base URLs', () => {
    expect(webUrlFor('github', 'github.com', 'acme', 'app')).toBe('https://github.com/acme/app')
    expect(webUrlFor('gitlab', 'gitlab.example.com', 'group/app', 'repo')).toBe('https://gitlab.example.com/group/app/repo')
    expect(normalizeBaseUrl('github', '')).toBe('https://api.github.com')
    expect(normalizeBaseUrl('gitea', 'https://git.example.com/')).toBe('https://git.example.com')
  })
})

describe('clone base URLs', () => {
  it('keeps a self-hosted port and sub-path instead of the ssh host', () => {
    expect(cloneBaseForAccount(account('a', 'gitea', 'https://git.example:8443/gitea'))).toBe(
      'https://git.example:8443/gitea'
    )
  })

  it('maps API hosts back to their clone host', () => {
    expect(cloneBaseForAccount(account('g', 'github', 'https://api.github.com'))).toBe('https://github.com')
    expect(cloneBaseForAccount(account('b', 'bitbucket', 'https://api.bitbucket.org/2.0'))).toBe(
      'https://bitbucket.org'
    )
  })

  it('strips an API suffix from an enterprise base URL', () => {
    expect(cloneBaseForAccount(account('e', 'github', 'https://ghe.example.com/api/v3'))).toBe(
      'https://ghe.example.com'
    )
  })

  it('uses an explicit clone host', () => {
    expect(cloneBaseForAccount(account('x', 'gitlab', 'https://api.gitlab.example.com', 'gitlab.example.com'))).toBe(
      'https://gitlab.example.com'
    )
  })
})

describe('credential destinations', () => {
  it('extracts an https origin and the explicit port', () => {
    expect(destinationFromUrl('https://GitLab.Company.com/group/app.git')).toMatchObject({
      protocol: 'https',
      host: 'gitlab.company.com',
      origin: 'https://gitlab.company.com'
    })
    expect(destinationFromUrl('https://gitlab.company.com:8443/group/app.git')).toMatchObject({
      port: 8443,
      origin: 'https://gitlab.company.com:8443'
    })
    // The scheme default is not an "explicit" port.
    expect(destinationFromUrl('https://gitlab.company.com:443/group/app.git')?.port).toBeUndefined()
  })

  it('treats ssh and local destinations as having no credential origin', () => {
    expect(destinationFromUrl('git@github.com:acme/app.git')).toMatchObject({ protocol: 'ssh', host: 'github.com' })
    expect(destinationFromUrl('git@github.com:acme/app.git')?.origin).toBeUndefined()
    expect(destinationFromUrl('file:///tmp/repo')).toBeNull()
    expect(destinationFromUrl('/tmp/repo')).toBeNull()
  })

  it('matches credentials only to the configured host', () => {
    const gitlab = account('gitlab', 'gitlab', 'https://gitlab.company.com')
    const github = account('github', 'github', 'https://api.github.com')
    const bitbucket = account('bitbucket', 'bitbucket', 'https://api.bitbucket.org/2.0')

    expect(accountMatchesHost(gitlab, 'gitlab.company.com')).toBe(true)
    expect(accountMatchesHost(gitlab, 'gitlab.evil.example')).toBe(false)
    expect(accountMatchesHost(github, 'github.com')).toBe(true)
    expect(accountMatchesHost(github, 'github.evil.example')).toBe(false)
    expect(accountMatchesHost(bitbucket, 'bitbucket.org')).toBe(true)
    expect(accountMatchesHost(bitbucket, 'bitbucket.evil.example')).toBe(false)
  })

  it('does not release a token for a lookalike hostname', () => {
    const gitlab = account('gitlab', 'gitlab', 'https://gitlab.company.com')
    expect(accountMatchesDestination(gitlab, destinationFromUrl('https://gitlab.company.com.evil.example/o/r.git')!)).toBe(false)
    expect(accountMatchesDestination(gitlab, destinationFromUrl('https://gitlab.company.com/o/r.git')!)).toBe(true)
  })

  it('respects explicit ports and normalizes the scheme default', () => {
    const pinned = account('pinned', 'gitlab', 'https://gitlab.company.com:8443')
    expect(accountMatchesDestination(pinned, destinationFromUrl('https://gitlab.company.com:8443/o/r.git')!)).toBe(true)
    expect(accountMatchesDestination(pinned, destinationFromUrl('https://gitlab.company.com/o/r.git')!)).toBe(false)
    expect(accountMatchesDestination(pinned, destinationFromUrl('https://gitlab.company.com:9999/o/r.git')!)).toBe(false)

    const plain = account('plain', 'gitlab', 'https://gitlab.company.com')
    expect(accountMatchesDestination(plain, destinationFromUrl('https://gitlab.company.com:443/o/r.git')!)).toBe(true)
    expect(accountMatchesDestination(plain, destinationFromUrl('ssh://git@gitlab.company.com:8443/o/r.git')!)).toBe(false)
  })

  it('keeps documented API-host mappings and ignores enterprise API paths', () => {
    const github = account('github', 'github', 'https://api.github.com')
    const enterprise = account('enterprise', 'github', 'https://github.company.com/api/v3')
    const bitbucket = account('bitbucket', 'bitbucket', 'https://api.bitbucket.org/2.0')
    const gitlab = account('gitlab', 'gitlab', 'https://gitlab.company.com/api/v4')

    expect(accountMatchesDestination(github, destinationFromUrl('git@github.com:acme/app.git')!)).toBe(true)
    expect(accountMatchesDestination(bitbucket, destinationFromUrl('https://bitbucket.org/acme/app.git')!)).toBe(true)
    expect(accountMatchesDestination(enterprise, destinationFromUrl('https://github.company.com/acme/app.git')!)).toBe(true)
    expect(accountMatchesDestination(gitlab, destinationFromUrl('https://gitlab.company.com/acme/app.git')!)).toBe(true)
    expect(accountMatchesDestination(gitlab, destinationFromUrl('https://api.gitlab.company.com/acme/app.git')!)).toBe(false)
  })

  it('accepts an explicit clone host for a matching account', () => {
    const github = account('github', 'github', 'https://api.github.com', 'git.acme.dev')
    expect(accountMatchesDestination(github, destinationFromUrl('https://git.acme.dev/acme/app.git')!)).toBe(true)
    expect(accountMatchesDestination(github, destinationFromUrl('https://other.acme.dev/acme/app.git')!)).toBe(false)
  })

  it('rejects plain http except for loopback addresses', () => {
    const remote = account('remote', 'gitea', 'http://git.internal:3000')
    expect(accountMatchesDestination(remote, destinationFromUrl('http://git.internal:3000/o/r.git')!)).toBe(false)

    const local = account('local', 'gitea', 'http://127.0.0.1:3000')
    expect(accountMatchesDestination(local, destinationFromUrl('http://127.0.0.1:3000/o/r.git')!)).toBe(true)
    expect(accountMatchesDestination(local, destinationFromUrl('http://localhost:3000/o/r.git')!)).toBe(false)
  })

  it('records provider, host and port in the authority fingerprint', () => {
    const base = integrationAuthority('gitlab', 'https://gitlab.company.com/api/v4')
    const port = integrationAuthority('gitlab', 'https://gitlab.company.com:8443/api/v4')
    expect(base).toMatchObject({ provider: 'gitlab', host: 'gitlab.company.com' })
    expect(base?.fingerprint).not.toBe(port?.fingerprint)
    expect(integrationAuthority('github', 'https://github.com', 'git.acme.dev')?.fingerprint).not.toBe(base?.fingerprint)
  })
})
