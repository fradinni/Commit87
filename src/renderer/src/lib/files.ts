import type { StatusFile } from '@shared/types'

/**
 * Paths a stage, unstage or discard action must cover for one status entry.
 *
 * Porcelain v2 reports a staged rename as its destination plus the staged
 * source deletion, so acting on the destination alone leaves the deletion
 * behind. Copies also carry `origPath`, but their source stays in place, so
 * they are never expanded.
 */
export function actionPaths(file: StatusFile): string[] {
  if (file.rename && file.origPath && file.origPath !== file.path) return [file.origPath, file.path]
  return [file.path]
}

/** Deduplicated action scope for a selection of status entries. */
export function actionPathsFor(files: StatusFile[]): string[] {
  const paths = new Set<string>()
  for (const file of files) {
    for (const path of actionPaths(file)) paths.add(path)
  }
  return [...paths]
}

/**
 * Staging scope for one status entry. Staging a rename only needs its
 * destination: the source no longer exists in the worktree, so passing it to
 * `git add` makes the whole command fail with an unmatched pathspec.
 */
export function stagePaths(file: StatusFile): string[] {
  return [file.path]
}

/** Deduplicated staging scope for a selection of status entries. */
export function stagePathsFor(files: StatusFile[]): string[] {
  return [...new Set(files.map((file) => file.path))]
}
