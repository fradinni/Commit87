import { useState } from 'react'
import { Archive, Download, History, Plus, RefreshCw, Trash2, Upload } from 'lucide-react'
import type { StashInfo } from '@shared/types'
import { activeIdentity, useStore } from '../store'
import { call } from '../lib/ipc'
import { formatRelativeTime } from '../lib/format'
import { Badge, Button, ConfirmDialog, EmptyState, Field, IconButton, Modal, TextArea, Toggle } from '../components/ui'

export function StashesView() {
  const repo = useStore((state) => state.currentRepo)
  const stashes = useStore((state) => state.stashes)
  const status = useStore((state) => state.status)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const refreshStashes = useStore((state) => state.refreshStashes)
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(true)
  const [drop, setDrop] = useState<StashInfo | null>(null)

  if (!repo) return null

  const run = async (task: () => Promise<void>, success?: string): Promise<void> => {
    setBusy(true)
    try {
      await task()
      await useStore.getState().refreshAll()
      await refreshStashes()
      if (success) notify(success, 'success')
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const create = (): void => {
    void run(async () => {
      await call('git.stashPush', {
        path: repo.path,
        message: message.trim() || undefined,
        includeUntracked,
        identityId: activeIdentity()?.id
      })
      setCreateOpen(false)
      setMessage('')
    }, 'Changes stashed')
  }

  return (
    <div className="view stashes-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <History size={17} />
          <h2>Stashes</h2>
          <Badge tone="neutral">{stashes.length}</Badge>
        </div>
        <div className="toolbar-actions">
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void refreshStashes()}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Plus size={14} />}
            disabled={!status || status.clean}
            onClick={() => setCreateOpen(true)}
          >
            Stash changes
          </Button>
        </div>
      </div>

      {stashes.length === 0 ? (
        <EmptyState
          icon={<Archive size={22} />}
          title="No stashes"
          description="Stash uncommitted changes to switch context without committing. Apply or pop them later."
          action={
            <Button size="sm" variant="primary" disabled={!status || status.clean} onClick={() => setCreateOpen(true)}>
              Stash current changes
            </Button>
          }
        />
      ) : (
        <div className="stash-list">
          {stashes.map((stash) => (
            <article className="stash-card" key={stash.index}>
              <div className="stash-main">
                <span className="stash-index">stash@{'{'}{stash.index}{'}'}</span>
                <div className="stash-text">
                  <strong>{stash.message || 'Stashed changes'}</strong>
                  <span>
                    {stash.branch ? `${stash.branch} · ` : ''}
                    {formatRelativeTime(stash.date)} · {stash.sha.slice(0, 8)}
                  </span>
                </div>
              </div>
              <div className="stash-actions">
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Download size={13} />}
                  loading={busy}
                  onClick={() => void run(async () => { await call('git.stashApply', { path: repo.path, index: stash.index }) }, 'Stash applied')}
                >
                  Apply
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Upload size={13} />}
                  loading={busy}
                  onClick={() => void run(async () => { await call('git.stashPop', { path: repo.path, index: stash.index }) }, 'Stash popped')}
                >
                  Pop
                </Button>
                <IconButton label="Drop stash" danger onClick={() => setDrop(stash)}>
                  <Trash2 size={14} />
                </IconButton>
              </div>
            </article>
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        title="Stash changes"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={create}>Stash</Button>
          </>
        }
      >
        <Field label="Message">
          <TextArea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} placeholder="Work in progress…" autoFocus />
        </Field>
        <Toggle checked={includeUntracked} onChange={setIncludeUntracked} label="Include untracked files" hint="Uses git stash push -u." />
      </Modal>

      <ConfirmDialog
        open={Boolean(drop)}
        title="Drop stash"
        message={`Drop stash@{${drop?.index ?? 0}}? The stashed changes will be lost permanently.`}
        confirmLabel="Drop"
        danger
        busy={busy}
        onCancel={() => setDrop(null)}
        onConfirm={() => {
          if (!drop) return
          void run(async () => {
            await call('git.stashDrop', { path: repo.path, index: drop.index })
            setDrop(null)
          }, 'Stash dropped')
        }}
      />
    </div>
  )
}
