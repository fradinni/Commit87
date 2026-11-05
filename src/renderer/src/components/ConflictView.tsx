import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileWarning, FolderOpen, RefreshCw } from 'lucide-react'
import type { FileContent, StatusFile } from '@shared/types'
import {
  applyConflictChoice,
  detectLineEnding,
  parseConflicts,
  withLineEndings,
  type ConflictChoice,
  type ConflictParseResult
} from '../lib/conflict'
import { call } from '../lib/ipc'
import { useStore } from '../store'
import { Button, ConfirmDialog, EmptyState, LoadingBlock } from './ui'

const MAX_EDIT_BYTES = 512 * 1024
const EMPTY_PARSE: ConflictParseResult = { lines: [], regions: [], malformed: false }

export function ConflictView({
  repoPath,
  file,
  content,
  loading,
  error,
  onReload,
  onOpen
}: {
  repoPath: string
  file: StatusFile
  content: FileContent | null
  loading?: boolean
  error?: string | null
  onReload: () => void
  onOpen: () => void
}) {
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const raw = content?.content ?? ''
  const original = useMemo(() => raw.replace(/\r\n/g, '\n'), [raw])
  const eol = useMemo(() => detectLineEnding(raw), [raw])
  const [output, setOutput] = useState(original)
  const [saving, setSaving] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [reloadOpen, setReloadOpen] = useState(false)

  useEffect(() => {
    setOutput(original)
  }, [original])

  const tooLarge = content !== null && (content.truncated || content.size > MAX_EDIT_BYTES)
  const parsed = useMemo(
    () => (tooLarge || !content || content.binary ? EMPTY_PARSE : parseConflicts(output)),
    [content, output, tooLarge]
  )
  const ready = parsed.regions.length === 0 && !parsed.malformed
  const editable = content !== null && !content.binary && !tooLarge
  const dirty = output !== original

  const apply = (index: number, choice: ConflictChoice): void => {
    if (saving) return
    setOutput((current) => applyConflictChoice(current, index, choice))
  }

  const save = async (): Promise<void> => {
    if (!ready || !editable || saving) return
    setSaving(true)
    try {
      if (!dirty) {
        // Nothing to rewrite: the file was resolved elsewhere (or already had
        // no markers). Stage the current bytes without touching them.
        await call('git.stage', { path: repoPath, files: [file.path] })
      } else {
        await call('git.resolveConflict', {
          repoPath,
          file: file.path,
          content: withLineEndings(output, eol)
        })
      }
      await useStore.getState().refreshStatus()
      notify(dirty ? 'Conflict resolved and staged' : 'File staged', 'success')
    } catch (nextError) {
      notifyError(nextError)
    } finally {
      setSaving(false)
    }
  }

  const status = tooLarge
    ? 'This file is too large to edit here. Use Open externally.'
    : parsed.malformed
      ? 'Conflict markers are incomplete. Fix them in the resolved output below.'
      : parsed.regions.length > 0
        ? `${parsed.regions.length} conflicting region${parsed.regions.length === 1 ? '' : 's'} remaining`
        : 'No conflict markers left. Review the resolved output and stage the file.'

  return (
    <div className="conflict-view">
      <div className="conflict-banner">
        <AlertTriangle size={14} />
        <span className="conflict-banner-text">
          Resolve {file.path}: pick a side for each block, or edit the resolved output directly.
        </span>
        <div className="conflict-banner-actions">
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={12} />}
            onClick={() => (dirty ? setReloadOpen(true) : onReload())}
            disabled={saving}
          >
            Reload
          </Button>
          <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={onOpen} disabled={saving}>
            Open externally
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
              The path may be a symlink or submodule, or deleted on one side of the conflict.
            </>
          }
          action={<Button onClick={onReload}>Retry</Button>}
        />
      ) : !content ? (
        <EmptyState icon={<FileWarning size={20} />} title="No file content" description="Select the file again to reload it." />
      ) : tooLarge ? (
        <EmptyState
          icon={<FileWarning size={20} />}
          title="File is too large to edit here"
          description={`${file.path} is larger than 512 KB. Resolve it in an external editor, then stage it from the file list.`}
          action={<Button onClick={onOpen}>Open externally</Button>}
        />
      ) : content.binary ? (
        <EmptyState
          icon={<FileWarning size={20} />}
          title="Binary or non-UTF-8 conflict"
          description={`${file.path} is not UTF-8 text. Open it externally to resolve the conflict.`}
        />
      ) : (
        <>
          {parsed.regions.length > 0 ? (
            <div className="conflict-regions">
              {parsed.regions.map((region, index) => (
                <section
                  className="conflict-card"
                  key={`${region.start}-${region.oursLabel}-${region.theirsLabel}`}
                >
                  <header className="conflict-card-head">
                    <span className="conflict-card-title">
                      Conflict {index + 1} of {parsed.regions.length}
                    </span>
                    <span className="conflict-card-labels">
                      {region.oursLabel || 'ours'} → {region.theirsLabel || 'theirs'}
                    </span>
                  </header>
                  <div className="conflict-sides">
                    <div className={`conflict-side is-ours${region.ours.length ? '' : ' is-empty'}`}>
                      <div className="conflict-side-head">
                        <span>Ours</span>
                        <code title={region.oursLabel}>{region.oursLabel || 'HEAD'}</code>
                      </div>
                      <pre>{region.ours.join('\n') || '(empty)'}</pre>
                    </div>
                    <div className={`conflict-side is-theirs${region.theirs.length ? '' : ' is-empty'}`}>
                      <div className="conflict-side-head">
                        <span>Theirs</span>
                        <code title={region.theirsLabel}>{region.theirsLabel || 'incoming'}</code>
                      </div>
                      <pre>{region.theirs.join('\n') || '(empty)'}</pre>
                    </div>
                    {region.base !== null ? (
                      <div className={`conflict-side is-base${region.base.length ? '' : ' is-empty'}`}>
                        <div className="conflict-side-head">
                          <span>Base</span>
                          <code title={region.baseLabel ?? undefined}>{region.baseLabel || 'common ancestor'}</code>
                        </div>
                        <pre>{region.base.join('\n') || '(empty)'}</pre>
                      </div>
                    ) : null}
                  </div>
                  <footer className="conflict-card-actions">
                    <Button size="sm" variant="outline" disabled={saving} onClick={() => apply(index, 'ours')}>
                      Keep ours
                    </Button>
                    <Button size="sm" variant="outline" disabled={saving} onClick={() => apply(index, 'theirs')}>
                      Keep theirs
                    </Button>
                    <Button size="sm" variant="outline" disabled={saving} onClick={() => apply(index, 'both')}>
                      Keep both
                    </Button>
                    {region.base !== null ? (
                      <Button size="sm" variant="ghost" disabled={saving} onClick={() => apply(index, 'base')}>
                        Use base
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" disabled={saving} onClick={() => apply(index, 'none')}>
                      Remove both
                    </Button>
                  </footer>
                </section>
              ))}
            </div>
          ) : null}

          <section className="conflict-output">
            <header className="conflict-output-head">
              <div className="conflict-output-title-group">
                <span className="conflict-output-title">Resolved output</span>
                <code className="conflict-output-path" title={file.path}>
                  {file.path}
                </code>
                {dirty ? <span className="conflict-modified">edited</span> : null}
              </div>
              <div className="conflict-output-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setResetOpen(true)}
                  disabled={!dirty || saving}
                >
                  Reset
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  loading={saving}
                  disabled={!ready || !editable || saving}
                  onClick={() => void save()}
                >
                  Resolve &amp; stage
                </Button>
              </div>
            </header>
            <div className={`conflict-output-status${ready && editable ? ' is-ready' : ''}`}>{status}</div>
            <textarea
              className="conflict-output-editor"
              aria-label="Resolved file content"
              value={output}
              onChange={(event) => setOutput(event.target.value)}
              spellCheck={false}
              wrap="off"
              readOnly={!editable || saving}
            />
          </section>
        </>
      )}

      <ConfirmDialog
        open={resetOpen}
        title="Reset resolution?"
        message="Discard your edits and restore the original conflict markers."
        confirmLabel="Reset"
        danger
        busy={saving}
        onCancel={() => setResetOpen(false)}
        onConfirm={() => {
          setOutput(original)
          setResetOpen(false)
        }}
      />
      <ConfirmDialog
        open={reloadOpen}
        title="Reload the file?"
        message="Discard your edits and reload the working-tree file?"
        confirmLabel="Reload"
        danger
        busy={saving}
        onCancel={() => setReloadOpen(false)}
        onConfirm={() => {
          setReloadOpen(false)
          onReload()
        }}
      />
    </div>
  )
}
