import { useMemo } from 'react'
import { AlertTriangle, FileWarning, FolderOpen, Plus, RefreshCw } from 'lucide-react'
import type { FileContent, StatusFile } from '@shared/types'
import { formatBytes } from '../lib/format'
import { hasConflictMarkers, parseConflictContent, type ConflictLine } from '../lib/conflict'
import { Button, EmptyState, LoadingBlock } from './ui'

const MAX_CONFLICT_LINES = 6000

export function ConflictView({
  file,
  content,
  loading,
  error,
  onReload,
  onStage,
  onOpen
}: {
  file: StatusFile
  content: FileContent | null
  loading?: boolean
  error?: string | null
  onReload: () => void
  onStage: () => void
  onOpen: () => void
}) {
  const lines = useMemo(() => parseConflictContent(content?.content ?? ''), [content])
  const regions = useMemo(
    () => lines.filter((line) => line.marker && line.text.startsWith('<<<<<<<')).length,
    [lines]
  )
  const truncated = lines.length > MAX_CONFLICT_LINES

  return (
    <div className="conflict-view">
      <div className="conflict-banner">
        <AlertTriangle size={14} />
        <span className="conflict-banner-text">
          {hasConflictMarkers(lines)
            ? `${regions} conflicting region${regions === 1 ? '' : 's'} in the working tree. Edit the file, remove the markers, save, then stage it.`
            : 'No conflict markers found. Review the working-tree content and stage the file when it is ready.'}
        </span>
        <div className="conflict-banner-actions">
          <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={onReload}>
            Reload
          </Button>
          <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={onOpen}>
            Open externally
          </Button>
          <Button size="sm" variant="outline" icon={<Plus size={12} />} onClick={onStage}>
            Stage file
          </Button>
        </div>
      </div>

      {loading ? (
        <LoadingBlock label="Reading conflicted file…" />
      ) : error ? (
        <EmptyState
          icon={<FileWarning size={20} />}
          title="Could not read the conflicted file"
          description={
            <>
              {error}
              <br />
              The path may be deleted on one side of the conflict.
            </>
          }
          action={<Button onClick={onReload}>Retry</Button>}
        />
      ) : !content ? (
        <EmptyState icon={<FileWarning size={20} />} title="No file content" description="Select the file again to reload it." />
      ) : content.binary ? (
        <EmptyState
          icon={<FileWarning size={20} />}
          title="Binary conflict"
          description={`${file.path} cannot be displayed as text. Open it externally to resolve the conflict.`}
        />
      ) : (
        <>
          <div className="code-toolbar">
            <span className="code-path">{file.path}</span>
            <span className="code-meta">
              working tree · {formatBytes(content.size)}
              {content.truncated ? ' · truncated' : ''}
            </span>
          </div>
          <div className="conflict-body">
            {lines.slice(0, MAX_CONFLICT_LINES).map((line, index) => (
              <div
                key={index}
                className={`conflict-line${line.marker ? ' is-marker' : ''}${
                  line.side !== 'normal' ? ` is-${line.side}` : ''
                }`}
              >
                <span className="conflict-number">{index + 1}</span>
                <span className="conflict-sign">{line.marker ? '!' : ' '}</span>
                <span className="conflict-text">{line.text || ' '}</span>
                {line.marker ? <span className="conflict-label">{markerLabel(line)}</span> : null}
              </div>
            ))}
            {truncated ? (
              <div className="diff-truncated">
                Showing the first {MAX_CONFLICT_LINES.toLocaleString()} lines. Open the file externally to see the rest.
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}

function markerLabel(line: ConflictLine): string {
  if (line.text.startsWith('<<<<<<<')) return 'ours'
  if (line.text.startsWith('|||||||')) return 'base'
  if (line.text.startsWith('=======')) return 'split'
  return 'theirs end'
}
