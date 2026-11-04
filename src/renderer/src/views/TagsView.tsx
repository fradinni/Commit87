import { useMemo, useState } from 'react'
import { CloudUpload, GitCommitHorizontal, Plus, RefreshCw, Rocket, Search, Tag, Trash2 } from 'lucide-react'
import type { TagInfo } from '@shared/types'
import { activeIdentity, useStore } from '../store'
import { call } from '../lib/ipc'
import { formatDate, formatRelativeTime } from '../lib/format'
import { Badge, Button, ConfirmDialog, Field, IconButton, Modal, Select, TextInput, TextArea, EmptyState } from '../components/ui'

export function TagsView() {
  const repo = useStore((state) => state.currentRepo)
  const tags = useStore((state) => state.tags)
  const commits = useStore((state) => state.commits)
  const detection = useStore((state) => state.detection)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const refreshTags = useStore((state) => state.refreshTags)
  const setView = useStore((state) => state.setView)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [target, setTarget] = useState('')
  const [push, setPush] = useState(false)
  const [remote, setRemote] = useState('origin')
  const [del, setDel] = useState<TagInfo | null>(null)
  const [deleteRemote, setDeleteRemote] = useState('')
  const [pushTag, setPushTag] = useState<TagInfo | null>(null)
  const [pushRemote, setPushRemote] = useState('origin')

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return tags
    return tags.filter((tag) => `${tag.name} ${tag.subject} ${tag.message ?? ''}`.toLowerCase().includes(term))
  }, [query, tags])

  if (!repo) return null

  const run = async (task: () => Promise<void>, message?: string): Promise<void> => {
    setBusy(true)
    try {
      await task()
      await refreshTags()
      if (message) notify(message, 'success')
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const create = (): void => {
    if (!name.trim()) return
    void run(async () => {
      await call('git.tagCreate', {
        repoPath: repo.path,
        name: name.trim(),
        message: message.trim() || undefined,
        commit: target || undefined,
        push,
        remote: push ? remote : undefined,
        identityId: activeIdentity()?.id
      })
      setCreateOpen(false)
      setName('')
      setMessage('')
      setTarget('')
      setPush(false)
    }, `Tag ${name.trim()} created`)
  }

  const doDelete = (): void => {
    if (!del) return
    void run(async () => {
      await call('git.tagDelete', {
        path: repo.path,
        name: del.name,
        remote: deleteRemote || undefined
      })
      setDel(null)
    }, 'Tag deleted')
  }

  const doPush = (): void => {
    if (!pushTag) return
    void run(async () => {
      await call('git.tagPush', {
        path: repo.path,
        name: pushTag.name,
        remote: pushRemote,
        identityId: activeIdentity()?.id,
        accountId: detection.accountId
      })
      setPushTag(null)
    }, 'Tag pushed')
  }

  return (
    <div className="view tags-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <Tag size={17} />
          <h2>Tags</h2>
          <Badge tone="neutral">{tags.length}</Badge>
          {detection.provider && detection.provider !== 'bitbucket' ? (
            <Button size="sm" variant="ghost" icon={<Rocket size={13} />} onClick={() => setView('releases')}>
              Releases
            </Button>
          ) : null}
        </div>
        <div className="toolbar-actions">
          <div className="search-box">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter tags…" spellCheck={false} />
          </div>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void refreshTags()}>
            Refresh
          </Button>
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => { setTarget(''); setCreateOpen(true) }}>
            New tag
          </Button>
        </div>
      </div>

      {tags.length === 0 ? (
        <EmptyState
          icon={<Tag size={22} />}
          title="No tags yet"
          description="Tags mark release points. Create an annotated tag and optionally push it to a remote."
          action={<Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>Create a tag</Button>}
        />
      ) : (
        <div className="table-wrap">
          <div className="data-table tag-table">
            <div className="data-head">
              <span>Tag</span>
              <span>Type</span>
              <span>Target</span>
              <span>Message</span>
              <span>Created</span>
              <span />
            </div>
            {visible.map((tag) => (
              <div className="data-row" key={tag.name} onDoubleClick={() => setPushTag(tag)}>
                <span className="cell-main">
                  <Tag size={13} />
                  <span className="mono">{tag.name}</span>
                </span>
                <span>
                  <Badge tone={tag.annotated ? 'purple' : 'outline'}>{tag.annotated ? 'annotated' : 'lightweight'}</Badge>
                </span>
                <span className="mono cell-muted">{tag.targetSha.slice(0, 8)}</span>
                <span className="cell-subject ellipsis" title={tag.message}>{tag.subject || tag.message || '—'}</span>
                <span className="cell-muted" title={formatDate(tag.date)}>{formatRelativeTime(tag.date)}</span>
                <span className="cell-actions">
                  <IconButton label="Push tag" onClick={() => { setPushTag(tag); setPushRemote('origin') }}>
                    <CloudUpload size={14} />
                  </IconButton>
                  <IconButton label="Delete tag" danger onClick={() => { setDel(tag); setDeleteRemote('') }}>
                    <Trash2 size={14} />
                  </IconButton>
                </span>
              </div>
            ))}
            {visible.length === 0 ? <div className="table-empty">No tags match this filter.</div> : null}
          </div>
        </div>
      )}

      <Modal
        open={createOpen}
        title="Create tag"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={create}>Create tag</Button>
          </>
        }
      >
        <Field label="Tag name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="v1.0.0" autoFocus />
        </Field>
        <Field label="Commit" hint="Defaults to HEAD.">
          <Select value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">HEAD ({repo.currentBranch ?? 'detached'})</option>
            {commits.slice(0, 60).map((commit) => (
              <option key={commit.sha} value={commit.sha}>
                {commit.shortSha} — {commit.subject.slice(0, 70)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Message" hint="Leaving this empty creates a lightweight tag.">
          <TextArea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} placeholder="Release notes for this tag…" />
        </Field>
        <label className="checkbox-row">
          <input type="checkbox" checked={push} onChange={(event) => setPush(event.target.checked)} />
          Push tag to a remote
        </label>
        {push ? (
          <Field label="Remote">
            <Select value={remote} onChange={(event) => setRemote(event.target.value)}>
              {repo.remotes.map((item) => (
                <option key={item.name} value={item.name}>{item.name}</option>
              ))}
            </Select>
          </Field>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(del)}
        title={`Delete tag ${del?.name ?? ''}`}
        message={
          <div>
            <p>This deletes the local tag{deleteRemote ? ' and the remote tag' : ''}. This cannot be undone.</p>
            <Field label="Also delete on remote">
              <Select value={deleteRemote} onChange={(event) => setDeleteRemote(event.target.value)}>
                <option value="">Local only</option>
                {repo.remotes.map((item) => (
                  <option key={item.name} value={item.name}>{item.name}</option>
                ))}
              </Select>
            </Field>
          </div>
        }
        confirmLabel="Delete tag"
        danger
        busy={busy}
        onCancel={() => setDel(null)}
        onConfirm={doDelete}
      />

      <Modal
        open={Boolean(pushTag)}
        title={`Push ${pushTag?.name ?? ''}`}
        onClose={() => setPushTag(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPushTag(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} icon={<CloudUpload size={14} />} onClick={doPush}>Push tag</Button>
          </>
        }
      >
        <Field label="Remote">
          <Select value={pushRemote} onChange={(event) => setPushRemote(event.target.value)}>
            {repo.remotes.map((item) => (
              <option key={item.name} value={item.name}>{item.name}</option>
            ))}
          </Select>
        </Field>
        <div className="inline-info">
          <GitCommitHorizontal size={14} /> {pushTag?.targetSha.slice(0, 12)} · {pushTag?.subject || 'tag'}
        </div>
      </Modal>
    </div>
  )
}
