import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationAccount } from '../src/shared/types'
import { providerCapabilities } from '../src/shared/types'
import { BitbucketClient } from '../src/main/providers/bitbucket'
import { GiteaClient } from '../src/main/providers/gitea'
import { GithubClient } from '../src/main/providers/github'
import { GitlabClient } from '../src/main/providers/gitlab'
import { assertReleaseIntent } from '../src/main/providers/release'
import { nextPageFromLink } from '../src/main/providers/http'

const base = (provider: IntegrationAccount['provider'], baseUrl: string): IntegrationAccount => ({
  id: 'acc',
  provider,
  label: provider,
  username: provider === 'bitbucket' ? 'me@example.com' : 'octocat',
  baseUrl,
  hasToken: true,
  createdAt: 0
})

interface Expectation {
  method?: string
  origin?: string
  path: string | RegExp
  query?: Record<string, string | string[]>
  headers?: Record<string, string | RegExp>
  /** Expected parsed JSON body. Also asserts `Content-Type: application/json`. */
  body?: unknown
  rawBody?: string
  bodyAbsent?: boolean
  status?: number
  response?: unknown
  responseText?: string | null
  responseHeaders?: Record<string, string>
}

/**
 * Every request must match the next queued expectation. An unexpected request,
 * an unmatched query/header/body, or a queued expectation that was never used
 * fails the test, so a permissive default success can no longer hide a missing
 * or wrongly shaped request.
 */
let pending: Expectation[] = []

function mockFetch(expectations: Expectation[]): string[] {
  pending = [...expectations]
  const urls: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    urls.push(url.toString())
    const expected = pending.shift()
    if (!expected) throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${url}`)
    expect(init.method ?? 'GET').toBe(expected.method ?? 'GET')
    if (expected.origin) expect(url.origin).toBe(expected.origin)
    if (typeof expected.path === 'string') expect(url.pathname).toBe(expected.path)
    else expect(url.pathname).toMatch(expected.path)
    for (const [key, value] of Object.entries(expected.query ?? {})) {
      expect(url.searchParams.getAll(key)).toEqual(Array.isArray(value) ? value : [value])
    }
    const headers = init.headers as Record<string, string>
    for (const [key, value] of Object.entries(expected.headers ?? {})) {
      if (typeof value === 'string') expect(headers[key]).toBe(value)
      else expect(headers[key]).toMatch(value)
    }
    if (expected.body !== undefined) {
      expect(headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(String(init.body))).toEqual(expected.body)
    } else if (expected.rawBody !== undefined) {
      expect(String(init.body)).toBe(expected.rawBody)
    } else if (expected.bodyAbsent) {
      expect(init.body).toBeUndefined()
    }
    const status = expected.status ?? 200
    const body =
      expected.responseText === null
        ? null
        : expected.responseText ?? (expected.response === undefined ? '' : JSON.stringify(expected.response))
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...(expected.responseHeaders ?? {}) }
    })
  })
  return urls
}

afterEach(() => {
  expect(pending, 'queued requests were not made').toHaveLength(0)
  vi.unstubAllGlobals()
})

const githubPull = {
  id: 9,
  number: 42,
  title: 'Add worktrees',
  state: 'open',
  draft: false,
  user: { login: 'ada' },
  head: { ref: 'feature/worktrees', sha: 'head111', repo: { full_name: 'contributor/app' } },
  base: { ref: 'main' },
  html_url: 'https://github.com/acme/app/pull/42',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  additions: 12,
  deletions: 3,
  mergeable: true
}

describe('GitHub client', () => {
  it('maps repositories and applies the search filter locally', async () => {
    mockFetch([
      {
        origin: 'https://api.github.com',
        path: '/user/repos',
        query: { per_page: '100', sort: 'updated', affiliation: 'owner,collaborator,organization_member' },
        headers: { Authorization: 'Bearer token123' },
        response: [
          {
            id: 1,
            full_name: 'acme/app',
            name: 'app',
            owner: { login: 'acme' },
            default_branch: 'main',
            private: true,
            html_url: 'https://github.com/acme/app',
            clone_url: 'https://github.com/acme/app.git',
            updated_at: '2026-01-02T03:04:05Z'
          },
          {
            id: 2,
            full_name: 'other/lib',
            name: 'lib',
            owner: { login: 'other' },
            default_branch: 'main',
            private: false,
            html_url: 'https://github.com/other/lib',
            clone_url: 'https://github.com/other/lib.git'
          }
        ]
      }
    ])
    const client = new GithubClient(base('github', 'https://api.github.com'), 'token123')
    const repos = await client.listRepos('acme')
    expect(repos).toHaveLength(1)
    expect(repos[0]).toMatchObject({ fullName: 'acme/app', owner: 'acme', private: true })
  })

  it('reads one pull request and pages the list through Link', async () => {
    mockFetch([
      {
        origin: 'https://api.github.com',
        path: '/repos/acme/app/pulls/42',
        headers: {
          Authorization: 'Bearer token123',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        response: githubPull
      },
      {
        origin: 'https://api.github.com',
        path: '/repos/acme/app/pulls',
        query: { state: 'open', per_page: '50', sort: 'updated', direction: 'desc' },
        headers: { Authorization: 'Bearer token123' },
        response: [githubPull],
        responseHeaders: {
          link: '<https://api.github.com/repos/acme/app/pulls?page=2&per_page=50>; rel="next", <https://api.github.com/repos/acme/app/pulls?page=4>; rel="last"'
        }
      }
    ])

    const client = new GithubClient(base('github', 'https://api.github.com'), 'token123')
    const pull = await client.getPullRequest('acme', 'app', 42)
    expect(pull).toMatchObject({
      number: 42,
      headSha: 'head111',
      sourceRepo: 'contributor/app',
      sourceBranch: 'feature/worktrees',
      targetBranch: 'main',
      state: 'open'
    })

    const page = await client.listPullRequests('acme', 'app', 'open')
    expect(page.items[0]).toMatchObject({ number: 42, headSha: 'head111' })
    expect(page.hasMore).toBe(true)
    expect(page.nextPage).toBe('2')
  })

  it('writes JSON bodies with the right headers and accepts a bodyless success', async () => {
    mockFetch([
      {
        method: 'POST',
        origin: 'https://api.github.com',
        path: '/repos/acme/app/pulls',
        headers: { Authorization: 'Bearer token123' },
        body: { title: 'Add worktrees', head: 'feature', base: 'main', body: '', draft: false },
        response: { ...githubPull, head: { ref: 'feature', sha: 'abc' } }
      },
      {
        method: 'POST',
        origin: 'https://api.github.com',
        path: '/repos/acme/app/releases',
        headers: { Authorization: 'Bearer token123' },
        body: {
          tag_name: 'v1.0.0',
          name: '1.0.0',
          body: 'notes',
          target_commitish: 'main',
          draft: true,
          prerelease: true
        },
        response: {
          id: 7,
          tag_name: 'v1.0.0',
          name: '1.0.0',
          draft: true,
          prerelease: true,
          created_at: '2026-01-01T00:00:00Z',
          html_url: 'https://github.com/acme/app/releases/v1.0.0'
        }
      },
      {
        method: 'POST',
        origin: 'https://api.github.com',
        path: '/repos/acme/app/actions/workflows/5/dispatches',
        headers: { Authorization: 'Bearer token123' },
        body: { ref: 'main', inputs: { env: 'staging' } },
        status: 204,
        responseText: null
      },
      {
        method: 'DELETE',
        origin: 'https://api.github.com',
        path: '/repos/acme/app/releases/7',
        headers: { Authorization: 'Bearer token123' },
        status: 204,
        responseText: null,
        bodyAbsent: true
      }
    ])

    const client = new GithubClient(base('github', 'https://api.github.com'), 'token123')
    const created = await client.createPullRequest('acme', 'app', {
      title: 'Add worktrees',
      sourceBranch: 'feature',
      targetBranch: 'main'
    })
    expect(created.number).toBe(42)

    const release = await client.createRelease('acme', 'app', {
      tagName: 'v1.0.0',
      name: '1.0.0',
      body: 'notes',
      target: 'main',
      draft: true,
      prerelease: true
    })
    expect(release).toMatchObject({ id: '7', draft: true, prerelease: true })

    await client.triggerAction('acme', 'app', '5', 'main', { env: 'staging' })
    await client.deleteRelease('acme', 'app', '7')
  })

  it('returns completeness metadata for releases, workflows and runs', async () => {
    mockFetch([
      {
        origin: 'https://api.github.com',
        path: '/repos/acme/app/releases',
        query: { per_page: '50' },
        response: [],
        responseHeaders: { link: '<https://api.github.com/repos/acme/app/releases?page=2>; rel="next"' }
      },
      {
        origin: 'https://api.github.com',
        path: '/repos/acme/app/actions/workflows',
        query: { per_page: '100' },
        response: { total_count: 200, workflows: [{ id: 5, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] }
      },
      {
        origin: 'https://api.github.com',
        path: '/repos/acme/app/actions/workflows/2/runs',
        query: { per_page: '40', page: '2' },
        response: {
          total_count: 41,
          workflow_runs: [
            {
              id: 77,
              name: 'CI',
              workflow_id: 2,
              run_number: 12,
              status: 'completed',
              conclusion: 'success',
              head_branch: 'main',
              head_sha: 'abc',
              event: 'push',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:05:00Z',
              html_url: 'https://github.com/acme/app/actions/runs/77'
            }
          ]
        }
      }
    ])

    const client = new GithubClient(base('github', 'https://api.github.com'), 'token123')
    const releases = await client.listReleases('acme', 'app')
    expect(releases.hasMore).toBe(true)
    expect(releases.nextPage).toBe('2')

    const workflows = await client.listWorkflows('acme', 'app')
    expect(workflows.items[0]).toMatchObject({ id: '5', name: 'CI' })
    expect(workflows.nextPage).toBe('2')

    const runs = await client.listRuns('acme', 'app', '2', '2')
    expect(runs.items[0]).toMatchObject({ id: '77', conclusion: 'success', branch: 'main' })
    expect(runs.hasMore).toBe(false)
  })

  it('uses GitHub Enterprise API paths', async () => {
    const urls = mockFetch([{ origin: 'https://ghe.example.com', path: '/api/v3/user', response: { login: 'ada' } }])
    const client = new GithubClient(base('github', 'https://ghe.example.com'), 't')
    await client.getCurrentUser()
    expect(urls[0]).toBe('https://ghe.example.com/api/v3/user')
  })

  it('surfaces API errors with context', async () => {
    mockFetch([{ status: 401, path: '/user', response: { message: 'Bad credentials' } }])
    const client = new GithubClient(base('github', 'https://api.github.com'), 'nope')
    await expect(client.getCurrentUser()).rejects.toThrow(/Bad credentials \(HTTP 401\)/)
  })
})

describe('GitLab client', () => {
  it('maps projects', async () => {
    mockFetch([
      {
        origin: 'https://gitlab.com',
        path: '/api/v4/projects',
        query: { membership: 'true', per_page: '100', order_by: 'last_activity_at', simple: 'true' },
        headers: { 'PRIVATE-TOKEN': 'glpat' },
        response: [
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
      }
    ])
    const client = new GitlabClient(base('gitlab', 'https://gitlab.com'), 'glpat')
    const repos = await client.listRepos()
    expect(repos[0]).toMatchObject({ owner: 'group/sub', name: 'app', private: true })
  })

  it('reads a merge request by iid and pages the list through X-Next-Page', async () => {
    mockFetch([
      {
        origin: 'https://gitlab.com',
        path: '/api/v4/projects/group%2Fsub%2Fapp/merge_requests/7',
        headers: { 'PRIVATE-TOKEN': 'glpat' },
        response: {
          id: 1,
          iid: 7,
          title: 'Draft: Add releases',
          state: 'opened',
          work_in_progress: true,
          author: { username: 'ada' },
          source_branch: 'feature/releases',
          target_branch: 'main',
          sha: 'mrhead7',
          web_url: 'https://gitlab.com/group/sub/app/-/merge_requests/7',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          detailed_merge_status: 'mergeable'
        }
      },
      {
        origin: 'https://gitlab.com',
        path: '/api/v4/projects/group%2Fsub%2Fapp/merge_requests',
        query: { state: 'opened', per_page: '50', order_by: 'updated_at', sort: 'desc' },
        headers: { 'PRIVATE-TOKEN': 'glpat' },
        response: [],
        responseHeaders: { 'x-next-page': '2' }
      }
    ])

    const client = new GitlabClient(base('gitlab', 'https://gitlab.com'), 'glpat')
    const pull = await client.getPullRequest('group/sub', 'app', 7)
    expect(pull).toMatchObject({ number: 7, state: 'draft', headSha: 'mrhead7', draft: true })

    const page = await client.listPullRequests('group/sub', 'app', 'open')
    expect(page.hasMore).toBe(true)
    expect(page.nextPage).toBe('2')
  })

  it('creates a draft merge request with the title prefix and dispatches a pipeline', async () => {
    mockFetch([
      {
        method: 'POST',
        origin: 'https://gitlab.com',
        path: '/api/v4/projects/group%2Fsub%2Fapp/merge_requests',
        headers: { 'PRIVATE-TOKEN': 'glpat' },
        body: {
          source_branch: 'feature',
          target_branch: 'main',
          title: 'Draft: Add releases',
          description: ''
        },
        response: {
          id: 1,
          iid: 8,
          title: 'Draft: Add releases',
          state: 'opened',
          draft: true,
          source_branch: 'feature',
          target_branch: 'main',
          sha: 'mrhead8',
          web_url: 'https://gitlab.com/group/sub/app/-/merge_requests/8',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z'
        }
      },
      {
        method: 'POST',
        origin: 'https://gitlab.com',
        path: '/api/v4/projects/group%2Fsub%2Fapp/pipeline',
        headers: { 'PRIVATE-TOKEN': 'glpat' },
        body: { ref: 'main', variables: { env: 'staging' } },
        status: 201,
        response: { id: 1, status: 'created', ref: 'main', sha: 'x' }
      }
    ])
    const client = new GitlabClient(base('gitlab', 'https://gitlab.com'), 'glpat')
    const pull = await client.createPullRequest('group/sub', 'app', {
      title: 'Add releases',
      sourceBranch: 'feature',
      targetBranch: 'main',
      draft: true
    })
    expect(pull).toMatchObject({ number: 8, state: 'draft', headSha: 'mrhead8' })
    await client.triggerAction('group/sub', 'app', 'pipeline', 'main', { env: 'staging' })
  })

  it('rejects unsupported draft and prerelease intent without a request', async () => {
    mockFetch([])
    const client = new GitlabClient(base('gitlab', 'https://gitlab.com'), 'glpat')
    await expect(client.createRelease('group/sub', 'app', { tagName: 'v1', name: 'v1', draft: true })).rejects.toThrow(
      /no draft state/
    )
    await expect(
      client.createRelease('group/sub', 'app', { tagName: 'v1', name: 'v1', prerelease: true })
    ).rejects.toThrow(/no prerelease flag/)
  })

  it('creates a release with the documented body and deletes it bodylessly', async () => {
    mockFetch([
      {
        method: 'POST',
        origin: 'https://gitlab.com',
        path: '/api/v4/projects/group%2Fsub%2Fapp/releases',
        headers: { 'PRIVATE-TOKEN': 'glpat' },
        body: { tag_name: 'v1.0.0', name: '1.0.0', description: 'notes', ref: 'main' },
        response: {
          tag_name: 'v1.0.0',
          name: '1.0.0',
          description: 'notes',
          created_at: '2026-01-01T00:00:00Z',
          released_at: '2026-01-01T00:00:00Z'
        }
      },
      {
        method: 'DELETE',
        origin: 'https://gitlab.com',
        path: '/api/v4/projects/group%2Fsub%2Fapp/releases/v1.0.0',
        headers: { 'PRIVATE-TOKEN': 'glpat' },
        status: 204,
        responseText: null,
        bodyAbsent: true
      }
    ])

    const client = new GitlabClient(base('gitlab', 'https://gitlab.com'), 'glpat')
    const release = await client.createRelease('group/sub', 'app', {
      tagName: 'v1.0.0',
      name: '1.0.0',
      body: 'notes',
      target: 'main'
    })
    expect(release).toMatchObject({ id: 'v1.0.0', draft: false, prerelease: false })
    await client.deleteRelease('group/sub', 'app', 'v1.0.0')
  })
})

describe('Gitea client', () => {
  it('maps repositories with the documented page parameters', async () => {
    mockFetch([
      {
        origin: 'https://gitea.com',
        path: '/api/v1/user/repos',
        query: { limit: '50', page: '1' },
        headers: { Authorization: 'token gt' },
        response: [
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
      }
    ])
    const client = new GiteaClient(base('gitea', 'https://gitea.com'), 'gt')
    const repos = await client.listRepos()
    expect(repos[0]).toMatchObject({ owner: 'acme', name: 'app' })
  })

  it('maps merged and closed pull requests distinctly and reports the head', async () => {
    const closed = {
      id: 2,
      number: 2,
      title: 'Closed',
      state: 'closed',
      merged: false,
      head: { ref: 'topic', sha: 'closedsha', repo: { full_name: 'acme/app' } },
      base: { ref: 'main' },
      html_url: 'https://gitea.com/acme/app/pulls/2',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z'
    }
    mockFetch([
      {
        origin: 'https://gitea.com',
        path: '/api/v1/repos/acme/app/pulls/1',
        headers: { Authorization: 'token gt' },
        response: {
          ...closed,
          id: 1,
          number: 1,
          state: 'closed',
          merged: true,
          head: { ref: 'topic', sha: 'mergedsha', repo: { full_name: 'someone/app' } }
        }
      },
      {
        origin: 'https://gitea.com',
        path: '/api/v1/repos/acme/app/pulls/2',
        headers: { Authorization: 'token gt' },
        response: closed
      }
    ])

    const client = new GiteaClient(base('gitea', 'https://gitea.com'), 'gt')
    const merged = await client.getPullRequest('acme', 'app', 1)
    expect(merged).toMatchObject({ state: 'merged', headSha: 'mergedsha', sourceRepo: 'someone/app' })
    const plain = await client.getPullRequest('acme', 'app', 2)
    expect(plain.state).toBe('closed')
  })

  it('decodes the workflow_runs envelope, a bare array, extra fields, and a missing Actions API', async () => {
    const task = {
      id: 10,
      name: 'CI',
      head_branch: 'main',
      head_sha: 'abc',
      run_number: 3,
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:05:00Z',
      html_url: 'https://gitea.com/acme/app/actions/runs/10',
      workflow_id: 'ci.yml'
    }
    mockFetch([
      {
        origin: 'https://gitea.com',
        path: '/api/v1/repos/acme/app/actions/tasks',
        query: { limit: '40', page: '1' },
        response: { total_count: 1, workflow_runs: [task], extra: 'ignored' },
        responseHeaders: { 'x-total-count': '41' }
      },
      {
        origin: 'https://gitea.com',
        path: '/api/v1/repos/acme/app/actions/tasks',
        query: { limit: '40', page: '1' },
        response: [task]
      },
      {
        origin: 'https://gitea.com',
        path: '/api/v1/repos/acme/app/actions/tasks',
        query: { limit: '40', page: '1' },
        response: { workflow_runs: [] }
      },
      {
        origin: 'https://gitea.com',
        path: '/api/v1/repos/acme/app/actions/tasks',
        query: { limit: '40', page: '1' },
        status: 404,
        response: { message: 'Not Found' }
      }
    ])

    const client = new GiteaClient(base('gitea', 'https://gitea.com'), 'gt')
    const envelope = await client.listRuns('acme', 'app')
    expect(envelope.items[0]).toMatchObject({ id: '10', workflowName: 'CI', sha: 'abc' })
    expect(envelope.nextPage).toBe('2')
    const bare = await client.listRuns('acme', 'app')
    expect(bare.items).toHaveLength(1)
    const empty = await client.listRuns('acme', 'app')
    expect(empty.items).toHaveLength(0)
    expect(empty.unsupported).toBeUndefined()
    const missing = await client.listRuns('acme', 'app')
    expect(missing.items).toHaveLength(0)
    expect(missing.unsupported).toBe(true)
  })

  it('dispatches a workflow with a JSON body', async () => {
    mockFetch([
      {
        method: 'POST',
        origin: 'https://gitea.com',
        path: '/api/v1/repos/acme/app/actions/workflows/ci.yml/dispatches',
        headers: { Authorization: 'token gt' },
        body: { ref: 'main', inputs: { env: 'staging' } },
        status: 204,
        responseText: null
      }
    ])
    const client = new GiteaClient(base('gitea', 'https://gitea.com'), 'gt')
    await client.triggerAction('acme', 'app', 'ci.yml', 'main', { env: 'staging' })
  })

  it('creates a pull request and a release, then deletes it bodylessly', async () => {
    mockFetch([
      {
        method: 'POST',
        origin: 'https://gitea.com',
        path: '/api/v1/repos/acme/app/pulls',
        headers: { Authorization: 'token gt' },
        body: { title: 'Fix', head: 'fix', base: 'main', body: '', draft: true },
        response: {
          id: 4,
          number: 4,
          title: 'Fix',
          state: 'open',
          draft: true,
          head: { ref: 'fix', sha: 'newhead4', repo: { full_name: 'acme/app' } },
          base: { ref: 'main' },
          html_url: 'https://gitea.com/acme/app/pulls/4',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z'
        }
      },
      {
        method: 'POST',
        origin: 'https://gitea.com',
        path: '/api/v1/repos/acme/app/releases',
        headers: { Authorization: 'token gt' },
        body: {
          tag_name: 'v2.0.0',
          name: '2.0.0',
          body: '',
          draft: true,
          prerelease: true
        },
        response: {
          id: 12,
          tag_name: 'v2.0.0',
          name: '2.0.0',
          draft: true,
          prerelease: true,
          created_at: '2026-01-01T00:00:00Z',
          html_url: 'https://gitea.com/acme/app/releases/tag/v2.0.0'
        }
      },
      {
        method: 'DELETE',
        origin: 'https://gitea.com',
        path: '/api/v1/repos/acme/app/releases/12',
        headers: { Authorization: 'token gt' },
        status: 204,
        responseText: null,
        bodyAbsent: true
      }
    ])

    const client = new GiteaClient(base('gitea', 'https://gitea.com'), 'gt')
    const pull = await client.createPullRequest('acme', 'app', {
      title: 'Fix',
      sourceBranch: 'fix',
      targetBranch: 'main',
      draft: true
    })
    expect(pull).toMatchObject({ number: 4, state: 'draft', headSha: 'newhead4' })
    const release = await client.createRelease('acme', 'app', {
      tagName: 'v2.0.0',
      name: '2.0.0',
      draft: true,
      prerelease: true
    })
    expect(release).toMatchObject({ id: '12', draft: true, prerelease: true })
    await client.deleteRelease('acme', 'app', '12')
  })
})

describe('Bitbucket client', () => {
  it('follows repository continuation pages', async () => {
    const next = 'https://api.bitbucket.org/2.0/repositories?page=2&pagelen=100'
    mockFetch([
      {
        origin: 'https://api.bitbucket.org',
        path: '/2.0/repositories',
        query: { role: 'member', pagelen: '100', sort: '-updated_on' },
        headers: { Authorization: /^Basic / },
        response: {
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
          ],
          next
        }
      },
      {
        origin: 'https://api.bitbucket.org',
        path: '/2.0/repositories',
        query: { page: '2', pagelen: '100' },
        response: {
          values: [
            {
              uuid: '{2}',
              full_name: 'acme/lib',
              name: 'lib',
              slug: 'lib',
              is_private: false,
              links: { html: { href: 'https://bitbucket.org/acme/lib' }, clone: [] }
            }
          ]
        }
      }
    ])
    const client = new BitbucketClient(base('bitbucket', 'https://api.bitbucket.org/2.0'), 'secret')
    const repos = await client.listRepos()
    expect(repos.map((repo) => repo.fullName)).toEqual(['acme/app', 'acme/lib'])
    expect(repos[0].sshUrl).toBe('git@bitbucket.org:acme/app.git')
  })

  it('asks for explicit pull request states and follows next continuation', async () => {
    const pull = {
      id: 5,
      title: 'Fix build',
      state: 'OPEN',
      draft: false,
      author: { display_name: 'Ada' },
      source: { branch: { name: 'main' }, commit: { hash: 'bbhead5' }, repository: { full_name: 'contributor/app' } },
      destination: { branch: { name: 'main' } },
      created_on: '2026-01-01T00:00:00Z',
      updated_on: '2026-01-02T00:00:00Z',
      links: { html: { href: 'https://bitbucket.org/acme/app/pull-requests/5' } }
    }
    const next = 'https://api.bitbucket.org/2.0/repositories/acme/app/pullrequests?page=2&pagelen=50'
    mockFetch([
      {
        origin: 'https://api.bitbucket.org',
        path: '/2.0/repositories/acme/app/pullrequests',
        query: { pagelen: '50', sort: '-updated_on', state: ['OPEN'] },
        response: { values: [pull], next }
      },
      {
        origin: 'https://api.bitbucket.org',
        path: '/2.0/repositories/acme/app/pullrequests',
        query: { page: '2', pagelen: '50', sort: '-updated_on', state: ['OPEN'] },
        response: { values: [] }
      },
      {
        origin: 'https://api.bitbucket.org',
        path: '/2.0/repositories/acme/app/pullrequests',
        query: { pagelen: '50', sort: '-updated_on', state: ['MERGED', 'DECLINED', 'SUPERSEDED'] },
        response: { values: [] }
      },
      {
        origin: 'https://api.bitbucket.org',
        path: '/2.0/repositories/acme/app/pullrequests',
        query: { pagelen: '50', sort: '-updated_on', state: ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'] },
        response: { values: [] }
      }
    ])

    const client = new BitbucketClient(base('bitbucket', 'https://api.bitbucket.org/2.0'), 'secret')
    const open = await client.listPullRequests('acme', 'app', 'open')
    expect(open.items[0]).toMatchObject({ number: 5, state: 'open', headSha: 'bbhead5', sourceRepo: 'contributor/app' })
    expect(open.hasMore).toBe(true)
    expect(open.nextPage).toBe(next)

    const second = await client.listPullRequests('acme', 'app', 'open', next)
    expect(second.items).toHaveLength(0)
    expect(second.hasMore).toBe(false)

    await client.listPullRequests('acme', 'app', 'closed')
    await client.listPullRequests('acme', 'app', 'all')
  })

  it('reads a pull request head, creates one, and populates pipeline commit hashes', async () => {
    mockFetch([
      {
        origin: 'https://api.bitbucket.org',
        path: '/2.0/repositories/acme/app/pullrequests/5',
        headers: { Authorization: /^Basic / },
        response: {
          id: 5,
          title: 'Fix build',
          state: 'MERGED',
          source: { branch: { name: 'fix' }, commit: { hash: 'merged5' }, repository: { full_name: 'contributor/app' } },
          destination: { branch: { name: 'main' } },
          created_on: '2026-01-01T00:00:00Z',
          updated_on: '2026-01-02T00:00:00Z'
        }
      },
      {
        method: 'POST',
        origin: 'https://api.bitbucket.org',
        path: '/2.0/repositories/acme/app/pullrequests',
        headers: { Authorization: /^Basic / },
        body: {
          title: 'Fix build',
          description: '',
          draft: false,
          source: { branch: { name: 'fix' } },
          destination: { branch: { name: 'main' } }
        },
        response: {
          id: 6,
          title: 'Fix build',
          source: { branch: { name: 'fix' }, commit: { hash: 'newhead' }, repository: { full_name: 'acme/app' } },
          created_on: '2026-01-01T00:00:00Z',
          updated_on: '2026-01-02T00:00:00Z'
        }
      },
      {
        origin: 'https://api.bitbucket.org',
        path: '/2.0/repositories/acme/app/pipelines/',
        query: { pagelen: '40', sort: '-created_on' },
        response: {
          values: [
            {
              uuid: '{p}',
              build_number: 10,
              state: { name: 'COMPLETED', result: { name: 'FAILED' } },
              target: { ref_name: 'main', commit: { hash: 'pipesha10' } },
              created_on: '2026-01-01T00:00:00Z',
              completed_on: '2026-01-01T00:10:00Z',
              links: { html: { href: 'https://bitbucket.org/acme/app/addon/pipelines/home#!/results/10' } }
            }
          ]
        }
      }
    ])

    const client = new BitbucketClient(base('bitbucket', 'https://api.bitbucket.org/2.0'), 'secret')
    const merged = await client.getPullRequest('acme', 'app', 5)
    expect(merged).toMatchObject({ state: 'merged', headSha: 'merged5' })
    const created = await client.createPullRequest('acme', 'app', {
      title: 'Fix build',
      sourceBranch: 'fix',
      targetBranch: 'main'
    })
    expect(created.headSha).toBe('newhead')
    const runs = await client.listRuns('acme', 'app')
    expect(runs.items[0]).toMatchObject({ status: 'completed', conclusion: 'failure', sha: 'pipesha10' })
  })

  it('refuses a continuation link on another host before sending the token', async () => {
    mockFetch([])
    const client = new BitbucketClient(base('bitbucket', 'https://api.bitbucket.org/2.0'), 'secret')
    await expect(
      client.listPullRequests('acme', 'app', 'open', 'https://evil.example/2.0/repositories/acme/app/pullrequests')
    ).rejects.toThrow(/another host/)
    await expect(client.listPullRequests('acme', 'app', 'open', '/user')).rejects.toThrow(/Invalid pagination/)
    await expect(
      client.listPullRequests('acme', 'app', 'open', '/repositories/acme/app/pipelines/')
    ).rejects.toThrow(/Invalid pagination/)
  })

  it('rejects workflow inputs instead of silently dropping them', async () => {
    mockFetch([])
    const client = new BitbucketClient(base('bitbucket', 'https://api.bitbucket.org/2.0'), 'secret')
    await expect(client.triggerAction('acme', 'app', undefined, 'main', { env: 'prod' })).rejects.toThrow(
      /does not accept workflow inputs/
    )
  })

  it('starts a pipeline for a branch with a JSON body and no inputs', async () => {
    mockFetch([
      {
        method: 'POST',
        origin: 'https://api.bitbucket.org',
        path: '/2.0/repositories/acme/app/pipelines/',
        headers: { Authorization: /^Basic / },
        body: { target: { type: 'pipeline', ref_type: 'branch', ref_name: 'main' } },
        status: 201,
        response: { uuid: '{new}' }
      }
    ])
    const client = new BitbucketClient(base('bitbucket', 'https://api.bitbucket.org/2.0'), 'secret')
    await client.triggerAction('acme', 'app', 'pipeline', 'main')
  })

  it('reports releases as unsupported', async () => {
    mockFetch([])
    const client = new BitbucketClient(base('bitbucket', 'https://api.bitbucket.org/2.0'), 'secret')
    await expect(client.createRelease('acme', 'app', { tagName: 'v1', name: 'v1' })).rejects.toThrow(/no releases API/)
    await expect(client.deleteRelease('acme', 'app', '1')).rejects.toThrow(/does not support releases/)
    const releases = await client.listReleases('acme', 'app')
    expect(releases.unsupported).toBe(true)
    expect(releases.items).toHaveLength(0)
  })
})

describe('Link header continuation', () => {
  it('selects only the next relation', () => {
    expect(nextPageFromLink(null)).toBeUndefined()
    expect(nextPageFromLink('<https://api.github.com/x?page=4>; rel="last"')).toBeUndefined()
    expect(nextPageFromLink('<https://api.github.com/x?page=2>; rel="nextlast"')).toBeUndefined()
    expect(
      nextPageFromLink('<https://api.github.com/x?page=4>; rel="last", <https://api.github.com/x?page=2>; rel="next"')
    ).toBe('2')
    expect(nextPageFromLink('<https://api.github.com/x?page=2>; rel=next')).toBe('2')
  })
})

describe('release capability gate', () => {
  it('rejects unsupported draft and prerelease intent before any request', () => {
    const gitlab = providerCapabilities('gitlab').releases
    expect(() => assertReleaseIntent('gitlab', gitlab, { tagName: 'v1', name: 'v1', draft: true })).toThrow(
      /no draft state/
    )
    expect(() => assertReleaseIntent('gitlab', gitlab, { tagName: 'v1', name: 'v1', prerelease: true })).toThrow(
      /no prerelease flag/
    )
    expect(() => assertReleaseIntent('gitlab', gitlab, { tagName: 'v1', name: 'v1' })).not.toThrow()
    expect(() =>
      assertReleaseIntent('bitbucket', providerCapabilities('bitbucket').releases, { tagName: 'v1', name: 'v1' })
    ).toThrow(/does not support creating releases/)
    expect(() =>
      assertReleaseIntent('github', providerCapabilities('github').releases, {
        tagName: 'v1',
        name: 'v1',
        draft: true,
        prerelease: true
      })
    ).not.toThrow()
  })
})
