import type { ProviderId, PullRequest } from '@shared/types'

export interface PullFetchSource {
  source: { kind: 'remote'; name: string } | { kind: 'url'; url: string }
  refspec: string
}

export interface PullFetchPlan extends PullFetchSource {
  /** Ref that must resolve to the authoritative head before a branch is made. */
  verifyRef: string
  /** Temporary ref removed when verification fails (and after success if requested). */
  tempRef: string
  expectedSha: string
  cleanupOnSuccess: boolean
  /** A second, authorized source tried when the forge ref is not published. */
  fallback?: PullFetchSource
}

export interface RepoFullName {
  owner: string
  repo: string
}

/** Parse a full `owner/repo` (GitLab groups may contain slashes). */
export function parseFullName(fullName: string | undefined): RepoFullName | undefined {
  if (!fullName) return undefined
  const segments = fullName
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  if (segments.length < 2) return undefined
  if (segments.some((part) => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..')) return undefined
  const repo = segments.pop()
  if (!repo) return undefined
  return { owner: segments.join('/'), repo }
}

function isSafeBranch(branch: string): boolean {
  if (!branch || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) return false
  if (branch.includes('..') || branch.includes('@{')) return false
  return !/[\s\u0000-\u001f\u007f~^:?*[\]\\]/.test(branch)
}

/**
 * Build the clone URL for a contributor repository on the authorized host.
 * Forks live on the same forge as their destination, so the destination
 * remote's origin (scheme, host and explicit port) keeps the token scoped to
 * the server that actually reports the pull request.
 */
export function sourceRepoUrl(hostBase: string, sourceRepo: RepoFullName): string {
  const root = /^[a-z][a-z0-9+.-]*:\/\//i.test(hostBase) ? hostBase.replace(/\/+$/, '') : `https://${hostBase}`
  return `${root}/${sourceRepo.owner}/${sourceRepo.repo}.git`
}

export function tempRefFor(number: number): string {
  return `refs/commit87/pull/${number}`
}

/**
 * Plan how to fetch and verify a pull request head.
 *
 * GitHub and GitLab publish dedicated refs on the destination repository.
 * Gitea also publishes `refs/pull/N/head`, but some installations disable the
 * mirror settings that create it, so the contributor repository is kept as a
 * fallback. Bitbucket Cloud has no pull request refs at all and reads the
 * contributor repository named by the API.
 *
 * Every plan names the exact commit the forge reported: the fetched ref is
 * resolved and compared before a local branch is created.
 */
export function planPullFetch(
  provider: ProviderId,
  number: number,
  pull: PullRequest,
  remoteName: string,
  hostBase: string
): PullFetchPlan {
  if (!Number.isInteger(number) || number < 1) throw new Error('Invalid pull request number')
  if (pull.number !== number) {
    throw new Error(`The forge returned pull request #${pull.number} instead of #${number}. Nothing was checked out.`)
  }
  if (!pull.headSha.trim()) {
    throw new Error(`Pull request #${number} did not report a head commit, so it cannot be verified.`)
  }
  const expectedSha = pull.headSha.trim()

  if (provider === 'github') {
    const ref = `refs/remotes/${remoteName}/pr/${number}`
    return {
      source: { kind: 'remote', name: remoteName },
      refspec: `+refs/pull/${number}/head:${ref}`,
      verifyRef: ref,
      tempRef: ref,
      expectedSha,
      cleanupOnSuccess: false
    }
  }
  if (provider === 'gitlab') {
    const ref = `refs/remotes/${remoteName}/mr/${number}`
    return {
      source: { kind: 'remote', name: remoteName },
      refspec: `+refs/merge-requests/${number}/head:${ref}`,
      verifyRef: ref,
      tempRef: ref,
      expectedSha,
      cleanupOnSuccess: false
    }
  }

  const sourceRepo = parseFullName(pull.sourceRepo)
  if (!sourceRepo) {
    throw new Error(
      `Pull request #${number} did not report its source repository. Fetch the contributor branch manually or use a provider that exposes the pull request ref.`
    )
  }
  if (!pull.sourceBranch.trim()) {
    throw new Error(`Pull request #${number} did not report a source branch.`)
  }
  if (!isSafeBranch(pull.sourceBranch)) {
    throw new Error(`Pull request #${number} reported a source branch that cannot be fetched safely.`)
  }
  const tempRef = tempRefFor(number)
  const fromContributor: PullFetchSource = {
    source: { kind: 'url', url: sourceRepoUrl(hostBase, sourceRepo) },
    refspec: `+refs/heads/${pull.sourceBranch}:${tempRef}`
  }
  if (provider === 'gitea') {
    return {
      source: { kind: 'remote', name: remoteName },
      refspec: `+refs/pull/${number}/head:${tempRef}`,
      verifyRef: tempRef,
      tempRef,
      expectedSha,
      cleanupOnSuccess: true,
      fallback: fromContributor
    }
  }
  return { ...fromContributor, verifyRef: tempRef, tempRef, expectedSha, cleanupOnSuccess: true }
}

/** Throws unless the fetched commit is exactly the head the forge reported. */
export function assertVerifiedHead(plan: PullFetchPlan, resolved: string): void {
  const actual = resolved.trim().toLowerCase()
  if (!actual) throw new Error(`The contributor's head was not found after fetching. Nothing was checked out.`)
  if (actual !== plan.expectedSha.toLowerCase()) {
    throw new Error(
      `The fetched head is ${short(actual)}, but the pull request head is ${short(plan.expectedSha)}. Nothing was checked out.`
    )
  }
}

function short(sha: string): string {
  return sha.slice(0, 12)
}

export interface HeadVerificationDeps {
  resolve(ref: string): Promise<string | null>
  deleteRef(ref: string): Promise<void>
}

/**
 * Verify the fetched ref against the forge's head. Any mismatch (or a ref Git
 * cannot resolve) removes the temporary ref before the error propagates, so a
 * failed checkout never leaves a ref that looks like the pull request.
 */
export async function verifyFetchedHead(plan: PullFetchPlan, deps: HeadVerificationDeps): Promise<void> {
  try {
    const resolved = await deps.resolve(plan.verifyRef)
    assertVerifiedHead(plan, resolved ?? '')
  } catch (error) {
    await deps.deleteRef(plan.tempRef)
    throw error
  }
}