import type { FileStage, StatusFile } from '@shared/types'

/** Which recorded version of a path a row reviews. */
export type FacetSide = 'index' | 'worktree'

/**
 * One reviewable side of a status entry. A file that is both staged and
 * modified (`MM`, `AM`, a modified rename) has an index facet and a worktree
 * facet, so the worktree half can never hide behind the staged one.
 */
export interface FileFacet {
  /** Selection and DOM identity: the side plus the path. */
  key: string
  path: string
  side: FacetSide
  /** Porcelain-style letter for this side, or `U`/`!` for special stages. */
  code: string
  stage: FileStage
  label: string
  /** The status entry the actions are scoped from. */
  file: StatusFile
}

const CODE_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Unmerged'
}

function makeFacet(file: StatusFile, side: FacetSide, code: string, stage: FileStage, label: string): FileFacet {
  return { key: `${side}::${file.path}`, path: file.path, side, code, stage, label, file }
}

/**
 * Splits one status entry into the sides that actually changed. Renames keep
 * pointing at the status entry, so unstage/discard still cover the pair through
 * `actionPaths` while staging uses `stagePaths`.
 */
export function fileFacets(file: StatusFile): FileFacet[] {
  if (file.stage === 'untracked') {
    return [makeFacet(file, 'worktree', 'U', 'untracked', 'Untracked')]
  }
  if (file.stage === 'conflicted') {
    return [makeFacet(file, 'worktree', '!', 'conflicted', 'Conflicted')]
  }
  const facets: FileFacet[] = []
  if (file.index !== '.' && file.index !== '?') {
    facets.push(makeFacet(file, 'index', file.index, 'staged', CODE_LABELS[file.index] ?? file.label))
  }
  if (file.worktree !== '.') {
    facets.push(makeFacet(file, 'worktree', file.worktree, 'unstaged', CODE_LABELS[file.worktree] ?? file.label))
  }
  if (!facets.length) {
    // Defensive: a caller-supplied entry with neither column marked (for
    // example a synthetic staged test fixture) must still stay selectable.
    const side: FacetSide = file.stage === 'staged' ? 'index' : 'worktree'
    facets.push(makeFacet(file, side, '•', file.stage, file.label))
  }
  return facets
}

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
