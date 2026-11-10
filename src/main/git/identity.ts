import type { GitIdentity } from '@shared/types'
import type { IdentityEnvInput } from './runner'
import { tryRunGit } from './runner'

/**
 * One identity policy for every Git operation that can create a commit, sign
 * one, or contact a remote. The renderer never has to compensate for a missing
 * repository-default lookup: resolution happens here, in main, in this order:
 *
 * 1. the explicit `identityId` sent with the request (a deliberate pick)
 * 2. the repository default stored by the app for this repository
 * 3. the identity Git resolves for this repository (`--local` first, then the
 *    effective value, so `includeIf` and global configuration still apply)
 * 4. the application default identity
 *
 * A repository identity wins over the application default because Git itself
 * already resolves it. The selected identity's SSH key is preserved for
 * authentication, but its signing settings are not forced onto work authored
 * under a repository identity: Git decides whether that work is signed.
 */

export type IdentitySource = 'explicit' | 'repository-default' | 'repository' | 'application' | 'none'

export interface IdentitySelection {
  source: IdentitySource
  /** Values to inject; null when Git's own configuration should decide. */
  identity: IdentityEnvInput | null
  /** Repository-local values that were found, for diagnostics and tests. */
  local: { name: string; email: string } | null
}

export interface IdentityCandidates {
  explicitId?: string
  repoDefaultId?: string
  applicationIdentity?: GitIdentity
  identityById: (id: string | undefined) => GitIdentity | undefined
}

export async function resolveRepoIdentity(
  repoPath: string,
  candidates: IdentityCandidates
): Promise<IdentitySelection> {
  const explicit = candidates.identityById(candidates.explicitId)
  if (explicit) return { source: 'explicit', identity: explicit, local: null }

  const repoDefault = candidates.identityById(candidates.repoDefaultId)
  if (repoDefault) return { source: 'repository-default', identity: repoDefault, local: null }

  const local = await readLocalIdentity(repoPath)
  if (local.name || local.email) {
    const application = candidates.applicationIdentity
    if (!application) {
      // No application identity to borrow SSH/GPG settings from: let Git read
      // the local (and then global) configuration on its own.
      return { source: 'repository', identity: null, local }
    }
    return {
      source: 'repository',
      identity: {
        ...application,
        name: local.name || application.name,
        email: local.email || application.email,
        gpgKeyId: undefined,
        gpgSign: undefined
      },
      local
    }
  }

  if (candidates.applicationIdentity) {
    return { source: 'application', identity: candidates.applicationIdentity, local: null }
  }
  return { source: 'none', identity: null, local: null }
}

/**
 * Read the identity Git itself resolves here. `--local` is asked first so the
 * app can tell whether the repository set it explicitly; when it did not, the
 * effective value is used so `includeIf` and global `user.*` are preserved
 * instead of being silently replaced by the application default.
 */
export async function readLocalIdentity(repoPath: string): Promise<{ name: string; email: string }> {
  const read = async (scope: 'local' | 'effective', key: string): Promise<string> => {
    const args = scope === 'local' ? ['config', '--local', '--get', key] : ['config', '--get', key]
    const result = await tryRunGit(args, { cwd: repoPath })
    return result && result.exitCode === 0 ? result.stdout.trim() : ''
  }
  const [localName, localEmail] = await Promise.all([read('local', 'user.name'), read('local', 'user.email')])
  if (localName && localEmail) return { name: localName, email: localEmail }
  const [effectiveName, effectiveEmail] = await Promise.all([
    read('effective', 'user.name'),
    read('effective', 'user.email')
  ])
  return { name: localName || effectiveName, email: localEmail || effectiveEmail }
}
