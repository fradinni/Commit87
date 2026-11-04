import { useMemo } from 'react'
import { FileDiff, FileWarning } from 'lucide-react'
import { parsePatch } from '../lib/diff'
import { formatBytes } from '../lib/format'
import { EmptyState, LoadingBlock } from './ui'

export function DiffView({
  patch,
  loading,
  emptyLabel = 'No changes',
  fileFilter
}: {
  patch: string
  loading?: boolean
  emptyLabel?: string
  fileFilter?: string
}) {
  const files = useMemo(() => parsePatch(patch), [patch])
  const filtered = fileFilter
    ? files.filter((file) => file.newPath === fileFilter || file.oldPath === fileFilter)
    : files

  if (loading) return <LoadingBlock label="Loading diff…" />
  if (!patch.trim() || filtered.length === 0) {
    return <EmptyState icon={<FileDiff size={20} />} title={emptyLabel} description="Select a file or make a change to see a diff." />
  }

  let renderedLines = 0
  const maxLines = 6000

  return (
    <div className="diff-view">
      {filtered.map((file, fileIndex) => (
        <section className="diff-file" key={`${file.oldPath}-${file.newPath}-${fileIndex}`}>
          <header className="diff-file-header">
            <span className={`diff-status diff-status-${file.status}`}>{file.status}</span>
            <span className="diff-path">
              {file.oldPath && file.oldPath !== file.newPath ? `${file.oldPath} → ` : ''}
              {file.newPath || file.oldPath}
            </span>
            <span className="diff-stats">
              <span className="add">+{file.additions}</span>
              <span className="del">−{file.deletions}</span>
            </span>
          </header>
          {file.binary ? (
            <div className="diff-binary">
              <FileWarning size={14} /> Binary file — preview unavailable
            </div>
          ) : (
            <div className="diff-table">
              {file.hunks.map((hunk, hunkIndex) => (
                <div className="diff-hunk" key={hunkIndex}>
                  <div className="diff-hunk-header">
                    <span>{hunk.header}</span>
                    <span>old {hunk.oldStart} · new {hunk.newStart}</span>
                  </div>
                  {hunk.lines.map((line, lineIndex) => {
                    renderedLines += 1
                    if (renderedLines > maxLines) return null
                    return (
                      <div
                        key={lineIndex}
                        className={`diff-line ${line.type === 'add' ? 'is-add' : line.type === 'del' ? 'is-del' : line.type === 'meta' ? 'is-meta' : ''}`}
                      >
                        <span className="diff-number">{line.oldNumber ?? ''}</span>
                        <span className="diff-number">{line.newNumber ?? ''}</span>
                        <span className="diff-sign">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
                        <span className="diff-text">{line.text || ' '}</span>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
      {renderedLines > maxLines ? (
        <div className="diff-truncated">
          Diff is very large ({formatBytes(patch.length)}). Showing the first {maxLines.toLocaleString()} lines.
        </div>
      ) : null}
    </div>
  )
}
