import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { PullRequest } from '../src/shared/types'
import {
  assertVerifiedHead,
  parseFullName,
  planPullFetch,
  sourceRepoUrl,
  tempRefFor,
  verifyFetchedHead
} from '../src/main/providers/checkout'
import type { PullFetchPlan } from '../src/main/providers/checkout'

const run = promisify(execFile)
const dirs: string[] = []

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'commit87-checkout-'))
  dirs.push(dir)
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await fs.writeFile(path.join(dir, 'file.txt'), 'one\n')
  await run('git', ['add', 'file.txt'], { cwd: dir })
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: dir })
  return dir
}

async function commit(dir: string, content: string): Promise<string> {
  await fs.writeFile(path.join(dir, 'file.txt'), content)
  await run('git', ['commit', '-q', '-am', content.trim()], { cwd: dir })
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: dir })
  return stdout.trim()
}

function depsFor(repo: string) {
  return {
    resolve: async (ref: string): Promise<string | null> => {
      try {
        const result = await run('git', ['rev-parse', '--verify', ref], { cwd: repo })
        return result.stdout.trim()
      } catch {
        return null
      }
    },
    deleteRef: async (ref: string): Promise<void> => {
      await run('git', ['update-ref', '-d', ref], { cwd: repo })
    }
  }
}

function pull(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: '9',
    number: 5,
    title: 'Change',
    state: 'open',
    draft: false,
    author: 'ada',
    sourceBranch: 'main',
    sourceRepo: 'contributor/app',
    headSha: 'a'.repeat(40),
    targetBranch: 'main',
    webUrl: 'https://example.test/acme/app/pull/5',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('pull request fetch planning', () => {
  it('uses the dedicated refs GitHub and GitLab publish', () => {
    const github = planPullFetch('github', 5, pull(), 'origin', 'github.com')
    expect(github.source).toEqual({ kind: 'remote', name: 'origin' })
    expect(github.refspec).toBe('+refs/pull/5/head:refs/remotes/origin/pr/5')
    expect(github.verifyRef).toBe('refs/remotes/origin/pr/5')
    expect(github.expectedSha).toBe('a'.repeat(40))
    expect(github.cleanupOnSuccess).toBe(false)

    const gitlab = planPullFetch('gitlab', 6, pull({ number: 6 }), 'upstream', 'gitlab.com')
    expect(gitlab.refspec).toBe('+refs/merge-requests/6/head:refs/remotes/upstream/mr/6')
    expect(gitlab.verifyRef).toBe('refs/remotes/upstream/mr/6')
  })

  it('builds a contributor repository fetch for Bitbucket and Gitea forks', () => {
    // The fork branch is named like the destination branch; neither provider
    // may read refs/heads/main from the destination remote.
    const bitbucket = planPullFetch('bitbucket', 5, pull({ sourceBranch: 'main' }), 'origin', 'forge.example')
    expect(bitbucket.source).toEqual({ kind: 'url', url: 'https://forge.example/contributor/app.git' })
    expect(bitbucket.refspec).toBe('+refs/heads/main:refs/commit87/pull/5')
    expect(bitbucket.verifyRef).toBe('refs/commit87/pull/5')
    expect(bitbucket.tempRef).toBe(tempRefFor(5))
    expect(bitbucket.cleanupOnSuccess).toBe(true)
    expect(bitbucket.fallback).toBeUndefined()

    const gitea = planPullFetch('gitea', 5, pull({ sourceBranch: 'main' }), 'origin', 'forge.example')
    expect(gitea.source).toEqual({ kind: 'remote', name: 'origin' })
    expect(gitea.refspec).toBe('+refs/pull/5/head:refs/commit87/pull/5')
    expect(gitea.verifyRef).toBe('refs/commit87/pull/5')
    expect(gitea.fallback).toEqual({
      source: { kind: 'url', url: 'https://forge.example/contributor/app.git' },
      refspec: '+refs/heads/main:refs/commit87/pull/5'
    })
  })

  it('keeps the source repository path including GitLab-style group nesting', () => {
    expect(parseFullName('group/sub/app')).toEqual({ owner: 'group/sub', repo: 'app' })
    expect(sourceRepoUrl('gitlab.example', { owner: 'group/sub', repo: 'app' })).toBe(
      'https://gitlab.example/group/sub/app.git'
    )
    expect(sourceRepoUrl('https://forge.example:8443', { owner: 'contributor', repo: 'app' })).toBe(
      'https://forge.example:8443/contributor/app.git'
    )
  })

  it('refuses to plan when the forge did not report a verifiable head', () => {
    expect(() => planPullFetch('bitbucket', 5, pull({ headSha: '' }), 'origin', 'forge.example')).toThrow(
      /did not report a head commit/
    )
    expect(() => planPullFetch('gitea', 5, pull({ sourceRepo: undefined }), 'origin', 'forge.example')).toThrow(
      /did not report its source repository/
    )
    expect(() => planPullFetch('github', 5, pull({ headSha: ' ' }), 'origin', 'github.com')).toThrow(
      /did not report a head commit/
    )
    expect(() => planPullFetch('bitbucket', 5, pull({ sourceBranch: '--upload-pack=x' }), 'origin', 'forge.example')).toThrow(
      /cannot be fetched safely/
    )
    expect(() => planPullFetch('github', 5, pull({ number: 6 }), 'origin', 'github.com')).toThrow(
      /returned pull request #6 instead of #5/
    )
  })
})

describe('head verification', () => {
  it('accepts only the authoritative head', () => {
    const plan = planPullFetch('github', 5, pull(), 'origin', 'github.com')
    expect(() => assertVerifiedHead(plan, 'A'.repeat(40))).not.toThrow()
    expect(() => assertVerifiedHead(plan, 'b'.repeat(40))).toThrow(/Nothing was checked out/)
    expect(() => assertVerifiedHead(plan, '')).toThrow(/Nothing was checked out/)
  })

  it('fetches a fork branch named like the destination branch from the contributor repository', async () => {
    for (const provider of ['bitbucket', 'gitea'] as const) {
      const fork = await makeRepo()
      const forkHead = await commit(fork, `${provider} fork change\n`)
      const destination = await makeRepo()
      const destinationHead = await commit(destination, `${provider} destination change\n`)
      expect(forkHead).not.toBe(destinationHead)

      const plan = planPullFetch(provider, 5, pull({ headSha: forkHead }), 'origin', 'forge.example')
      // Gitea prefers the published pull ref; when it is missing the plan's
      // fallback reads refs/heads/main from the contributor, never from the
      // destination whose main is a different commit.
      const attempt = plan.fallback ?? plan
      await run('git', ['fetch', '--quiet', fork, attempt.refspec], { cwd: destination })
      const resolved = (await run('git', ['rev-parse', '--verify', plan.verifyRef], { cwd: destination })).stdout.trim()
      expect(resolved).toBe(forkHead)
      expect(resolved).not.toBe(destinationHead)
      assertVerifiedHead(plan, resolved)

      // A head reported for a different commit aborts and removes the ref.
      const stale = { ...plan, expectedSha: destinationHead }
      await expect(verifyFetchedHead(stale, depsFor(destination))).rejects.toThrow(/fetched head/)
      const branches = (
        await run('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: destination })
      ).stdout
      expect(branches.trim()).toBe('refs/heads/main')
    }
  })

  it('prefers the Gitea pull ref when the server publishes it', async () => {
    const contributor = await makeRepo()
    const head = await commit(contributor, 'gitea pull ref head\n')
    const destination = await makeRepo()
    await run('git', ['fetch', '--quiet', contributor, head], { cwd: destination })
    await run('git', ['update-ref', 'refs/pull/5/head', head], { cwd: destination })

    const plan = planPullFetch('gitea', 5, pull({ headSha: head }), 'origin', 'forge.example')
    await run('git', ['fetch', '--quiet', destination, plan.refspec], { cwd: destination })
    const resolved = (await run('git', ['rev-parse', '--verify', plan.verifyRef], { cwd: destination })).stdout.trim()
    expect(resolved).toBe(head)
  })

  it('fetches and verifies the dedicated GitHub and GitLab pull request refs', async () => {
    for (const [provider, sourceRef, localRef] of [
      ['github', 'refs/pull/5/head', 'refs/remotes/origin/pr/5'],
      ['gitlab', 'refs/merge-requests/5/head', 'refs/remotes/origin/mr/5']
    ] as const) {
      const contributor = await makeRepo()
      const head = await commit(contributor, `${provider} merge head\n`)
      const destination = await makeRepo()
      await run('git', ['fetch', '--quiet', contributor, head], { cwd: destination })
      await run('git', ['update-ref', sourceRef, head], { cwd: destination })

      const plan = planPullFetch(provider, 5, pull({ headSha: head }), 'origin', 'forge.example')
      expect(plan.verifyRef).toBe(localRef)
      await run('git', ['fetch', '--quiet', destination, plan.refspec], { cwd: destination })
      const resolved = (await run('git', ['rev-parse', '--verify', plan.verifyRef], { cwd: destination })).stdout.trim()
      expect(resolved).toBe(head)
      assertVerifiedHead(plan, resolved)
    }
  })

  it('deletes the temporary ref when the fetched commit differs', async () => {
    const deleted: string[] = []
    const plan = planPullFetch('bitbucket', 5, pull(), 'origin', 'bitbucket.org')
    await expect(
      verifyFetchedHead(plan, {
        resolve: async () => 'c'.repeat(40),
        deleteRef: async (ref) => {
          deleted.push(ref)
        }
      })
    ).rejects.toThrow(/does not match|fetched head/)
    expect(deleted).toEqual([tempRefFor(5)])
  })

  it('keeps the ref when the commit matches', async () => {
    const deleted: string[] = []
    const plan = planPullFetch('gitlab', 5, pull(), 'origin', 'gitlab.com')
    await verifyFetchedHead(plan, {
      resolve: async () => 'a'.repeat(40),
      deleteRef: async (ref) => {
        deleted.push(ref)
      }
    })
    expect(deleted).toEqual([])
  })

  it('aborts and deletes a real temporary ref on a mismatch, and accepts the right commit', async () => {
    const repo = await makeRepo()
    const first = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
    const second = await commit(repo, 'two\n')
    const plan: PullFetchPlan = {
      source: { kind: 'url', url: 'https://forge.example/contributor/app.git' },
      refspec: `+refs/heads/main:${tempRefFor(5)}`,
      verifyRef: tempRefFor(5),
      tempRef: tempRefFor(5),
      expectedSha: first,
      cleanupOnSuccess: true
    }
    await run('git', ['update-ref', plan.verifyRef, second], { cwd: repo })

    const deps = {
      resolve: async (ref: string) => {
        const result = await run('git', ['rev-parse', '--verify', ref], { cwd: repo })
        return result.stdout.trim()
      },
      deleteRef: async (ref: string) => {
        await run('git', ['update-ref', '-d', ref], { cwd: repo })
      }
    }

    await expect(verifyFetchedHead(plan, deps)).rejects.toThrow(/fetched head/)
    await expect(run('git', ['rev-parse', '--verify', plan.verifyRef], { cwd: repo })).rejects.toThrow()
    // Nothing checkout-visible was created by the failed verification.
    const branches = (await run('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: repo })).stdout
    expect(branches.trim()).toBe('refs/heads/main')

    await run('git', ['update-ref', plan.verifyRef, first], { cwd: repo })
    await verifyFetchedHead(plan, deps)
    const resolved = (await run('git', ['rev-parse', plan.verifyRef], { cwd: repo })).stdout.trim()
    expect(resolved).toBe(first)
  })
})
