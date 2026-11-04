import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationAccount } from '../src/shared/types'
import { BitbucketClient } from '../src/main/providers/bitbucket'
import { GiteaClient } from '../src/main/providers/gitea'
import { GithubClient } from '../src/main/providers/github'
import { GitlabClient } from '../src/main/providers/gitlab'

const base = (provider: IntegrationAccount['provider'], baseUrl: string): IntegrationAccount => ({
  id: 'acc',
  provider,
  label: provider,
  username: provider === 'bitbucket' ? 'me@example.com' : 'octocat',
  baseUrl,
  hasToken: true,
  createdAt: 0
})

interface Captured {
  url: string
  init: RequestInit
}

function mockFetch(responses: Array<{ status?: number; body: unknown }>): Captured[] {
  const captured: Captured[] = []
  const queue = [...responses]
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    captured.push({ url: String(url), init })
    const next = queue.shift() ?? { status: 200, body: {} }
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' }
    })
  })
  return captured
}

function headersOf(call: Captured): Record<string, string> {
  return call.init.headers as Record<string, string>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GitHub client', () => {
  it('maps repositories, pulls and workflow runs', async () => {
    const captured = mockFetch([
      {
        body: [
          {
            id: 1,
            full_name: 'acme/app',
            name: 'app',
            owner: { login: 'acme' },
            default_branch: 'main',
            private: true,
            html_url: 'https://github.com/acme/app',
            clone_url: 'https://github.com/acme/app.git',
            ssh_url: 'git@github.com:acme/app.git',
            updated_at: '2026-01-02T03:04:05Z'
          }
        ]
      },
      {
        body: [
          {
            id: 9,
            number: 42,
            title: 'Add worktrees',
            state: 'open',
            draft: false,
            user: { login: 'ada' },
            head: { ref: 'feature/worktrees' },
            base: { ref: 'main' },
            html_url: 'https://github.com/acme/app/pull/42',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-02T00:00:00Z',
            additions: 12,
            deletions: 3,
            mergeable: true
          }
        ]
      },
      {
        body: {
          workflows: [{ id: 5, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }]
        }
      },
      {
        body: {
          workflow_runs: [
            {
              id: 77,
              name: 'CI',
              workflow_id: 5,
              run_number: 12,
              status: 'completed',
              conclusion: 'success',
              head_branch: 'main',
              head_sha: 'abc',
              event: 'push',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:05:00Z',
              html_url: 'https://github.com/acme/app/actions/runs/77',
              actor: { login: 'ada' }
            }
          ]
        }
      }
    ])

    const client = new GithubClient(base('github', 'https://api.github.com'), 'token123')
    const repos = await client.listRepos('app')
    expect(repos[0]).toMatchObject({ fullName: 'acme/app', defaultBranch: 'main', private: true })
    expect(headersOf(captured[0]).Authorization).toBe('Bearer token123')

    const pulls = await client.listPullRequests('acme', 'app', 'open')
    expect(pulls[0]).toMatchObject({ number: 42, state: 'open', sourceBranch: 'feature/worktrees', targetBranch: 'main' })

    const workflows = await client.listWorkflows('acme', 'app')
    expect(workflows[0]).toMatchObject({ id: '5', name: 'CI' })

    const runs = await client.listRuns('acme', 'app', '5')
    expect(runs[0]).toMatchObject({ id: '77', conclusion: 'success', branch: 'main', workflowName: 'CI' })

    await client.triggerAction('acme', 'app', '5', 'main', { env: 'staging' })
    const last = captured[captured.length - 1]
    expect(last.url).toContain('/actions/workflows/5/dispatches')
    expect(JSON.parse(String(last.init.body))).toEqual({ ref: 'main', inputs: { env: 'staging' } })
  })

  it('uses GitHub Enterprise API paths', async () => {
    const captured = mockFetch([{ body: { login: 'ada' } }])
    const client = new GithubClient(base('github', 'https://ghe.example.com'), 't')
    await client.getCurrentUser()
    expect(captured[0].url).toBe('https://ghe.example.com/api/v3/user')
  })

  it('surfaces API errors with context', async () => {
    mockFetch([{ status: 401, body: { message: 'Bad credentials' } }])
    const client = new GithubClient(base('github', 'https://api.github.com'), 'nope')
    await expect(client.getCurrentUser()).rejects.toThrow(/Bad credentials \(HTTP 401\)/)
  })
})

describe('GitLab client', () => {
  it('maps projects, merge requests and pipelines', async () => {
    const captured = mockFetch([
      {
        body: [
          {
            id: 3,
            path_with_namespace: 'group/sub/app',
            path: 'app',
            name: 'App',
            namespace: { full_path: 'group/sub' },
            default_branch: 'main',
            visibility: 'private',
            web_url: 'https://gitlab.com/group/sub/app',
            http_url_to_repo: 'https://gitlab.com/group/sub/app.git',
            last_activity_at: '2026-01-01T00:00:00Z'
          }
        ]
      },
      {
        body: [
          {
            id: 1,
            iid: 7,
            title: 'Draft: Add releases',
            state: 'opened',
            work_in_progress: true,
            author: { username: 'ada' },
            source_branch: 'feature/releases',
            target_branch: 'main',
            web_url: 'https://gitlab.com/group/sub/app/-/merge_requests/7',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-02T00:00:00Z',
            detailed_merge_status: 'mergeable'
          }
        ]
      },
      {
        body: [
          {
            id: 55,
            status: 'failed',
            ref: 'main',
            sha: 'abc',
            source: 'push',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T01:00:00Z',
            web_url: 'https://gitlab.com/group/sub/app/-/pipelines/55'
          }
        ]
      }
    ])

    const client = new GitlabClient(base('gitlab', 'https://gitlab.com'), 'glpat')
    const repos = await client.listRepos()
    expect(repos[0]).toMatchObject({ owner: 'group/sub', name: 'app', private: true })
    expect(headersOf(captured[0])['PRIVATE-TOKEN']).toBe('glpat')

    const pulls = await client.listPullRequests('group/sub', 'app', 'open')
    expect(pulls[0]).toMatchObject({ number: 7, state: 'draft', draft: true, mergeable: true })
    expect(captured[1].url).toContain('/projects/group%2Fsub%2Fapp/merge_requests')

    const runs = await client.listRuns('group/sub', 'app')
    expect(runs[0]).toMatchObject({ id: '55', status: 'failed', conclusion: 'failure' })
  })
})

describe('Gitea client', () => {
  it('maps repositories and dispatches workflows', async () => {
    const captured = mockFetch([
      {
        body: [
          {
            id: 1,
            full_name: 'acme/app',
            name: 'app',
            owner: { login: 'acme' },
            default_branch: 'main',
            private: false,
            html_url: 'https://gitea.com/acme/app',
            clone_url: 'https://gitea.com/acme/app.git'
          }
        ]
      },
      { body: [] }
    ])
    const client = new GiteaClient(base('gitea', 'https://gitea.com'), 'gt')
    const repos = await client.listRepos()
    expect(repos[0]).toMatchObject({ owner: 'acme', name: 'app' })
    expect(captured[0].url).toBe('https://gitea.com/api/v1/user/repos?limit=50&page=1')
    expect(headersOf(captured[0]).Authorization).toBe('token gt')

    await client.triggerAction('acme', 'app', 'ci.yml', 'main')
    expect(captured[1].url).toContain('/repos/acme/app/actions/workflows/ci.yml/dispatches')
  })
})

describe('Bitbucket client', () => {
  it('maps repositories, PRs and pipeline states', async () => {
    const captured = mockFetch([
      {
        body: {
          values: [
            {
              uuid: '{1}',
              full_name: 'acme/app',
              name: 'app',
              slug: 'app',
              workspace: { slug: 'acme' },
              mainbranch: { name: 'main' },
              is_private: true,
              links: {
                html: { href: 'https://bitbucket.org/acme/app' },
                clone: [
                  { name: 'https', href: 'https://bitbucket.org/acme/app.git' },
                  { name: 'ssh', href: 'git@bitbucket.org:acme/app.git' }
                ]
              }
            }
          ]
        }
      },
      {
        body: {
          values: [
            {
              id: 5,
              title: 'Fix build',
              state: 'OPEN',
              draft: false,
              author: { display_name: 'Ada' },
              source: { branch: { name: 'fix' } },
              destination: { branch: { name: 'main' } },
              created_on: '2026-01-01T00:00:00Z',
              updated_on: '2026-01-02T00:00:00Z',
              links: { html: { href: 'https://bitbucket.org/acme/app/pull-requests/5' } }
            }
          ]
        }
      },
      {
        body: {
          values: [
            {
              uuid: '{p}',
              build_number: 10,
              state: { name: 'COMPLETED', result: { name: 'FAILED' } },
              target: { ref_name: 'main' },
              created_on: '2026-01-01T00:00:00Z',
              completed_on: '2026-01-01T00:10:00Z',
              links: { html: { href: 'https://bitbucket.org/acme/app/addon/pipelines/home#!/results/10' } }
            }
          ]
        }
      }
    ])

    const client = new BitbucketClient(base('bitbucket', 'https://api.bitbucket.org/2.0'), 'secret')
    const repos = await client.listRepos()
    expect(repos[0]).toMatchObject({ owner: 'acme', defaultBranch: 'main', sshUrl: 'git@bitbucket.org:acme/app.git' })
    expect(headersOf(captured[0]).Authorization).toMatch(/^Basic /)

    const pulls = await client.listPullRequests('acme', 'app', 'open')
    expect(pulls[0]).toMatchObject({ number: 5, state: 'open', sourceBranch: 'fix' })

    const runs = await client.listRuns('acme', 'app')
    expect(runs[0]).toMatchObject({ status: 'completed', conclusion: 'failure', branch: 'main' })
  })

  it('explains that releases are unsupported', async () => {
    mockFetch([{ body: {} }])
    const client = new BitbucketClient(base('bitbucket', 'https://api.bitbucket.org/2.0'), 'secret')
    await expect(client.createRelease('acme', 'app', { tagName: 'v1', name: 'v1' })).rejects.toThrow(/no releases API/)
  })
})