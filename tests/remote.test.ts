import { describe, expect, it } from 'vitest'
import { detectProviderFromUrl, parseRemoteUrl, providerFromHost, webUrlFor, normalizeBaseUrl } from '../src/main/providers/remote'
import type { IntegrationAccount } from '../src/shared/types'

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
    const accounts: IntegrationAccount[] = [
      {
        id: '1',
        provider: 'gitea',
        label: 'Self hosted',
        username: 'me',
        baseUrl: 'https://git.example.com',
        hasToken: true,
        createdAt: 0
      }
    ]
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
