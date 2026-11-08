import type { AppStore } from './store'
import type { RepoInfo } from '@shared/types'

type RecentRepoStore = Pick<AppStore, 'addRecentRepo'>

/**
 * A regular checkout always belongs in the recents. A linked worktree is only
 * a standalone repository when the system opened it (file browser, deep link),
 * so navigating to one from its parent must not add it to the list.
 */
export function shouldRememberRecent(repo: Pick<RepoInfo, 'worktree'>, standalone: boolean): boolean {
  return !repo.worktree || standalone
}

/**
 * Recents are a convenience list: a read-only or full profile directory must
 * not stop a repository from opening, so a failed write is logged, not thrown.
 */
export async function rememberRecentRepo(
  store: RecentRepoStore,
  repo: Pick<RepoInfo, 'path' | 'name' | 'worktree'>,
  options: { standalone?: boolean } = {}
): Promise<void> {
  if (!shouldRememberRecent(repo, options.standalone === true)) return
  try {
    await store.addRecentRepo(repo.path, repo.name)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.warn(`[commit87] could not update the recent repositories: ${detail}`)
  }
}
